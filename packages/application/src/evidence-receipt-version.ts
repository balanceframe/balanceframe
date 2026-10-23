import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  TransactionEvidenceResultSchema,
  ReceiptEvidenceSchema,
  EvidenceObservationSchema,
} from '@balanceframe/protocol-generated/validators';
import type { TransactionEvidenceRequest, ReceiptEvidence } from '@balanceframe/protocol-generated';
import {
  canonicalProposalJson,
  receiptVersionKey,
  receiptVersionFacts,
  receiptVersionFamily,
  receiptVersionLinkSchema,
  validateReceiptVersionGraph,
  type ReceiptVersionLink,
  type ReceiptVersionSource,
  type ReceiptVersionBlockedChild,
  type EvidenceDocument,
  type LiquidityActor,
  type WorkflowStore,
  type EvidenceScope,
  type EvidenceAccess,
} from '@balanceframe/workflow-store';
import type { MerchantActor } from './merchant-service.js';
import { receiptHistoryDocuments } from './evidence-receipt-history.js';
const id = z.string().min(1).max(256),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const selector = z.object({ documentId: id, receiptId: id }).strict();
const selection = z.object({ child: selector, predecessor: selector }).strict();
export const receiptVersionPreviewInputSchema = selection.extend({ resolutionHash: hash }).strict();
export const receiptVersionSaveInputSchema = receiptVersionPreviewInputSchema
  .extend({ previewHash: hash, expectedFoldHash: hash, sameReceiptAcknowledged: z.literal(true) })
  .strict();
export const receiptVersionRevokeInputSchema = z
  .object({ childDocumentId: id, childReceiptId: id, expectedFoldHash: hash })
  .strict();
type ReviewActor = Pick<LiquidityActor, 'actorId' | 'membershipId' | 'governancePolicyVersion'>;
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalProposalJson(value)).digest('hex');
const rawReceipts = (d: EvidenceDocument): ReceiptEvidence[] =>
  d.parseStatus === 'parsed'
    ? ReceiptEvidenceSchema.array().parse(d.extraction.receipts ?? [])
    : [];
const reference = (d: EvidenceDocument, receiptId: string): ReceiptVersionSource => ({
  documentId: d.id,
  contentHash: d.contentHash,
  parserVersion: d.parserVersion,
  receiptId,
});
function scoped(links: ReceiptVersionLink[], actor: ReviewActor) {
  if (!actor.membershipId || !actor.governancePolicyVersion)
    throw new Error('Current receipt version review scope required');
  return links.filter(
    (l) =>
      l.actorId === actor.actorId &&
      l.membershipId === actor.membershipId &&
      l.policyVersion === actor.governancePolicyVersion,
  );
}
interface Node {
  source: ReceiptVersionSource;
  receipt: ReceiptEvidence;
  lineageHash: string;
  parent: Node | null;
  link: ReceiptVersionLink | null;
}
function resolver(
  readable: EvidenceDocument[],
  links: ReceiptVersionLink[],
  blocked: ReceiptVersionBlockedChild[],
) {
  const documents = new Map(readable.map((d) => [d.id, d])),
    reviews = new Map(links.map((l) => [receiptVersionKey(l.child), l])),
    unavailable = new Set(blocked.map((e) => receiptVersionKey(e.child))),
    cache = new Map<string, Node>(),
    visiting = new Set<string>();
  function resolve(source: ReceiptVersionSource): Node {
    const key = receiptVersionKey(source);
    if (visiting.has(key)) throw new Error('Receipt version cycle');
    if (visiting.size >= 1000 || cache.size >= 1000)
      throw new Error('Receipt version closure limit exceeded');
    const cached = cache.get(key);
    if (cached) {
      if (canonicalProposalJson(cached.source) !== canonicalProposalJson(source))
        throw new Error('Receipt version source identity conflict');
      return cached;
    }
    if (unavailable.has(key)) throw new Error('Reviewed receipt history unavailable');
    const document = documents.get(source.documentId);
    if (!document) throw new Error('Authorized receipt version history unavailable');
    const facts = receiptVersionFacts(document, source);
    visiting.add(key);
    try {
      const link = reviews.get(key);
      let parent: Node | null = null;
      let version = facts.receipt.version;
      let supersedesId = facts.receipt.supersedesId;
      if (link) {
        if (canonicalProposalJson(source) !== canonicalProposalJson(link.child))
          throw new Error('Receipt version child source changed');
        const parentDocument = documents.get(link.predecessor.documentId);
        if (
          !parentDocument ||
          receiptVersionFamily(document, parentDocument, source, link.predecessor) !==
            link.identityBasis
        )
          throw new Error('Receipt version source family changed');
        parent = resolve(link.predecessor);
        if (
          link.predecessorVersion !== parent.receipt.version ||
          link.predecessorLineageHash !== parent.lineageHash ||
          parent.receipt.version >= 4294967295 ||
          link.version !== parent.receipt.version + 1
        )
          throw new Error('Reviewed receipt predecessor lineage changed');
        if (supersedesId !== null && supersedesId !== parent.receipt.id)
          throw new Error('Immutable receipt has conflicting source lineage');
        version = link.version;
        supersedesId = parent.receipt.id;
      } else if (supersedesId !== null) {
        if (rawReceipts(document).some((r) => r.id === supersedesId)) {
          parent = resolve(reference(document, supersedesId));
        } else {
          const ancestors = receiptHistoryDocuments([document], readable);
          const candidates = ancestors.filter((d) =>
            rawReceipts(d).some((r) => r.id === supersedesId),
          );
          if (candidates.length !== 1)
            throw new Error('Authorized original receipt lineage unavailable');
          parent = resolve(reference(documents.get(candidates[0]!.id)!, supersedesId));
        }
        if (parent.receipt.version >= version)
          throw new Error('Invalid original receipt source version');
      }
      const node: Node = {
        source,
        receipt: { ...facts.receipt, version, supersedesId },
        lineageHash: digest({
          source,
          version,
          rawSupersedesId: facts.receipt.supersedesId,
          parentLineageHash: parent?.lineageHash ?? null,
          review: link ?? null,
        }),
        parent,
        link: link ?? null,
      };
      cache.set(key, node);
      return node;
    } finally {
      visiting.delete(key);
    }
  }
  return { resolve };
}
export interface ReceiptVersionDocumentPlan {
  documents: EvidenceDocument[];
  requiredSources: ReceiptVersionSource[];
  appliedLinks: ReceiptVersionLink[];
  blockedChildren: ReceiptVersionBlockedChild[];
}
/** Load only explicit reviewed predecessor closure; unavailable reviews suppress affected receipt sources, never raw fallback. */
export function receiptVersionDocuments(
  current: EvidenceDocument[],
  readable: EvidenceDocument[],
  unfiltered: ReceiptVersionLink[],
  blocked: ReceiptVersionBlockedChild[],
  actor: ReviewActor,
): ReceiptVersionDocumentPlan {
  const links = scoped(unfiltered, actor);
  validateReceiptVersionGraph(links);
  const baseline = [...current, ...receiptHistoryDocuments(current, readable)];
  const relevant = new Set([
    ...links.map((l) => receiptVersionKey(l.child)),
    ...blocked.map((e) => receiptVersionKey(e.child)),
  ]);
  const roots = current.flatMap((document) =>
    rawReceipts(document)
      .filter((receipt) => relevant.has(receiptVersionKey(reference(document, receipt.id))))
      .map((receipt) => ({ document, receipt })),
  );
  const unchanged = () => ({
    documents: baseline,
    requiredSources: baseline.flatMap((d) => rawReceipts(d).map((r) => reference(d, r.id))),
    appliedLinks: [],
    blockedChildren: [],
  });
  if (!roots.length) return unchanged();
  const sourceDocuments = new Map([...readable, ...current].map((d) => [d.id, d]));
  const engine = resolver([...sourceDocuments.values()], links, blocked);
  const nodes = new Map<string, Node>(),
    failures: ReceiptVersionBlockedChild[] = [];
  const blockedObservations = new Set<string>();
  function collect(node: Node) {
    const key = receiptVersionKey(node.source);
    if (nodes.has(key)) return;
    nodes.set(key, node);
    if (nodes.size > 1000) throw new Error('Receipt version closure limit exceeded');
    if (node.parent) collect(node.parent);
  }
  for (const { document, receipt } of roots) {
    const source = reference(document, receipt.id);
    try {
      collect(engine.resolve(source));
    } catch {
      failures.push({ child: source, reasonCode: 'reviewed_receipt_history_unavailable' });
      blockedObservations.add(receipt.observationId);
      for (const tender of receipt.tenders)
        if (tender.observationId) blockedObservations.add(tender.observationId);
    }
  }
  const failedKeys = new Set(failures.map((e) => receiptVersionKey(e.child)));
  const predecessorObservations = new Set(
    [...nodes.values()].flatMap((n) => (n.parent ? [n.parent.receipt.observationId] : [])),
  );
  const baselineById = new Map(baseline.map((d) => [d.id, d]));
  const requiredIds = new Set([
    ...baselineById.keys(),
    ...[...nodes.values()].map((n) => n.source.documentId),
  ]);
  const requiredSources: ReceiptVersionSource[] = [];
  const documents = [...requiredIds].sort().map((identity) => {
    const original = sourceDocuments.get(identity)!;
    const document = baselineById.get(identity) ?? original;
    const selectedById = new Map(
      (baselineById.has(identity) ? rawReceipts(document) : []).map((r) => [r.id, r]),
    );
    for (const node of nodes.values())
      if (node.source.documentId === identity) selectedById.set(node.receipt.id, node.receipt);
    const selected = [...selectedById.values()].filter(
      (r) => !failedKeys.has(receiptVersionKey(reference(document, r.id))),
    );
    requiredSources.push(...selected.map((r) => reference(original, r.id)));
    const needed = new Set(
      selected.flatMap((r) => [
        r.observationId,
        ...r.tenders.flatMap((t) => (t.observationId ? [t.observationId] : [])),
      ]),
    );
    const observations = EvidenceObservationSchema.omit({ provenance: true })
      .array()
      .parse(document.extraction.observations ?? [])
      .filter(
        (o) => !blockedObservations.has(o.id) && (baselineById.has(identity) || needed.has(o.id)),
      )
      .map((o) =>
        predecessorObservations.has(o.id) ? { ...o, status: 'superseded' as const } : o,
      );
    return {
      ...document,
      extraction: {
        ...document.extraction,
        receipts: selected,
        observations,
        ...(!baselineById.has(identity) ? { relationships: [], wallets: [] } : {}),
      },
    };
  });
  return {
    documents,
    requiredSources: requiredSources.sort((a, b) =>
      receiptVersionKey(a).localeCompare(receiptVersionKey(b)),
    ),
    appliedLinks: [...nodes.values()].flatMap((n) => (n.link ? [n.link] : [])),
    blockedChildren: failures,
  };
}
/** Bind an explicit current child to an exact readable predecessor and its admitted ancestor meaning. */
export function prepareReceiptVersionLink(
  value: z.infer<typeof selection>,
  current: EvidenceDocument[],
  readable: EvidenceDocument[],
  unfiltered: ReceiptVersionLink[],
  actor: ReviewActor,
  now: string,
  blocked: ReceiptVersionBlockedChild[] = [],
): ReceiptVersionLink {
  const input = selection.parse(value),
    links = scoped(unfiltered, actor);
  const child = current.find((d) => d.id === input.child.documentId),
    parent = readable.find((d) => d.id === input.predecessor.documentId);
  if (!child || !parent) throw new Error('Current child and readable receipt predecessor required');
  const childSource = reference(child, input.child.receiptId),
    parentSource = reference(parent, input.predecessor.receiptId);
  const identityBasis = receiptVersionFamily(child, parent, childSource, parentSource);
  const parentNode = resolver(readable, links, blocked).resolve(parentSource);
  if (parentNode.receipt.version >= 4294967295) throw new Error('Receipt version overflow');
  const link = receiptVersionLinkSchema.parse({
    child: childSource,
    predecessor: parentSource,
    predecessorVersion: parentNode.receipt.version,
    version: parentNode.receipt.version + 1,
    predecessorLineageHash: parentNode.lineageHash,
    identityBasis,
    actorId: actor.actorId,
    membershipId: actor.membershipId,
    policyVersion: actor.governancePolicyVersion,
    reviewedAt: now,
  });
  validateReceiptVersionGraph([
    ...links.filter((l) => receiptVersionKey(l.child) !== receiptVersionKey(link.child)),
    link,
  ]);
  return link;
}

/** Selected current sources and independently authorized retained evidence; no raw access is implied. */
export interface ReceiptVersionCapture {
  scope: EvidenceScope;
  currentDocuments: EvidenceDocument[];
  readableDocuments: EvidenceDocument[];
  request: TransactionEvidenceRequest;
  authorize: (additional?: unknown) => boolean;
}
/** Only the existing evidence service may supply current authorization, native normalization and fresh control. */
export interface ReceiptVersionHost {
  store: Pick<WorkflowStore, 'evidence'>;
  native: { resolveTransactionEvidence(input: string): string };
  now: () => string;
  fresh: (actor: MerchantActor) => void;
  capture: (actor: MerchantActor) => Promise<ReceiptVersionCapture>;
  normalize: (
    actor: MerchantActor,
    capture: ReceiptVersionCapture,
    plan: ReceiptVersionDocumentPlan,
  ) => TransactionEvidenceRequest;
  access: (
    actor: MerchantActor,
    scope: EvidenceScope,
    documents?: EvidenceDocument[],
    additional?: unknown,
    phase?: 'approve',
  ) => EvidenceAccess;
}
/** Explicit source-bound review changes evidence meaning only; it never authorizes or dispatches ledger mutations. */
export class ReceiptVersionService {
  constructor(private readonly host: ReceiptVersionHost) {}
  private scope(actor: MerchantActor) {
    if (!actor.membershipId || !actor.governancePolicyVersion)
      throw new Error('Current receipt version review scope required');
    return { membershipId: actor.membershipId, policyVersion: actor.governancePolicyVersion };
  }
  private state(actor: MerchantActor, capture: ReceiptVersionCapture) {
    return this.host.store.evidence.receiptVersions.state(
      this.host.access(actor, capture.scope),
      this.scope(actor),
    );
  }
  private fence(
    actor: MerchantActor,
    capture: ReceiptVersionCapture,
    expected: string,
    sources: ReceiptVersionSource[] = [],
    additional?: unknown,
  ) {
    const access = this.host.access(actor, capture.scope);
    if (
      capture.request.policyVersion !== actor.governancePolicyVersion ||
      !capture.authorize(additional) ||
      this.state(actor, capture).foldHash !== expected ||
      capture.currentDocuments.some((d) => !this.host.store.evidence.isCurrent(access, d.id)) ||
      sources.some((source) => {
        const document = this.host.store.evidence.get(access, source.documentId);
        return (
          !document ||
          document.contentHash !== source.contentHash ||
          document.parserVersion !== source.parserVersion
        );
      })
    )
      throw new Error('Receipt version source, review or authorization changed');
  }
  private result(request: TransactionEvidenceRequest) {
    return TransactionEvidenceResultSchema.parse(
      JSON.parse(this.host.native.resolveTransactionEvidence(JSON.stringify(request))),
    );
  }
  /** Offer only separately readable receipt metadata; no inferred predecessor is selected automatically. */
  async context(actor: MerchantActor) {
    const capture = await this.host.capture(actor),
      state = this.state(actor, capture);
    this.fence(actor, capture, state.foldHash);
    const result = this.result(capture.request);
    const choices = (documents: EvidenceDocument[]) =>
      documents.flatMap((document) =>
        rawReceipts(document).flatMap((receipt) => {
          try {
            const source = reference(document, receipt.id),
              facts = receiptVersionFacts(document, source);
            if (!facts.observation.counterparty?.trim()) return [];
            return [
              {
                ...source,
                label: document.sourceId,
                date: facts.observation.date,
                merchant: facts.observation.counterparty,
                total: receipt.total,
                direction: facts.observation.direction,
                version: receipt.version,
                familyKey: digest([
                  document.scope,
                  document.connectorId,
                  document.privateActorId,
                  document.extraction.templateVersion,
                  facts.observation.counterparty,
                  receipt.total.currency,
                  facts.observation.direction,
                  facts.observation.externalEventId,
                ]),
              },
            ];
          } catch {
            return [];
          }
        }),
      );
    const children = choices(capture.currentDocuments),
      predecessors = choices(capture.readableDocuments);
    if (children.length > 1000 || predecessors.length > 1000)
      throw new Error('Receipt version choice limit exceeded');
    const plan = receiptVersionDocuments(
      capture.currentDocuments,
      capture.readableDocuments,
      state.links,
      state.blockedChildren,
      actor,
    );
    const output = {
      resolutionHash: result.resolutionHash,
      foldHash: state.foldHash,
      children,
      predecessors,
      links: state.links,
      blockedChildren: plan.blockedChildren,
    };
    this.fence(actor, capture, state.foldHash, [], output);
    return output;
  }
  private async prepare(actor: MerchantActor, value: unknown) {
    const input = receiptVersionPreviewInputSchema.parse(value),
      capture = await this.host.capture(actor),
      state = this.state(actor, capture);
    this.fence(actor, capture, state.foldHash);
    const base = this.result(capture.request);
    if (base.resolutionHash !== input.resolutionHash)
      throw new Error('Receipt version resolution changed');
    const link = prepareReceiptVersionLink(
      { child: input.child, predecessor: input.predecessor },
      capture.currentDocuments,
      capture.readableDocuments,
      state.links,
      actor,
      this.host.now(),
      state.blockedChildren,
    );
    const proposed = [
      ...state.links.filter((l) => receiptVersionKey(l.child) !== receiptVersionKey(link.child)),
      link,
    ];
    const blocked = state.blockedChildren.filter(
      (e) => receiptVersionKey(e.child) !== receiptVersionKey(link.child),
    );
    const plan = receiptVersionDocuments(
      capture.currentDocuments,
      capture.readableDocuments,
      proposed,
      blocked,
      actor,
    );
    if (
      plan.blockedChildren.some((e) => receiptVersionKey(e.child) === receiptVersionKey(link.child))
    )
      throw new Error('Reviewed receipt predecessor closure unavailable');
    const request = this.host.normalize(actor, capture, plan);
    this.fence(actor, capture, state.foldHash, plan.requiredSources, {
      link,
      sourceClosure: plan.requiredSources,
    });
    const result = this.result(request);
    if (!result.receipts.some((r) => r.receiptId === link.child.receiptId && r.valid))
      throw new Error('Native conserved current receipt required');
    const { reviewedAt: _time, ...claims } = link;
    const output = {
      previewHash: digest({
        input,
        claims,
        foldHash: state.foldHash,
        sourceClosure: plan.requiredSources,
        nativeResolutionHash: result.resolutionHash,
      }),
      foldHash: state.foldHash,
      resolutionHash: base.resolutionHash,
      child: link.child,
      predecessor: link.predecessor,
      predecessorVersion: link.predecessorVersion,
      version: link.version,
      identityBasis: link.identityBasis,
      sourceClosure: plan.requiredSources,
      nativeResolutionHash: result.resolutionHash,
    };
    this.fence(actor, capture, state.foldHash, plan.requiredSources, output);
    return { capture, state, link, plan, output };
  }
  /** Resolve the exact selected replacement and current ancestor chain through Rust conservation before human approval. */
  async preview(actor: MerchantActor, value: unknown) {
    return (await this.prepare(actor, value)).output;
  }
  /** Recompute exact displayed claims after fresh human control and atomically append one source-bound relationship. */
  async save(actor: MerchantActor, value: unknown) {
    const all = receiptVersionSaveInputSchema.parse(value);
    this.host.fresh(actor);
    const { previewHash, expectedFoldHash, sameReceiptAcknowledged: _ack, ...input } = all;
    const prepared = await this.prepare(actor, input);
    if (prepared.output.previewHash !== previewHash || prepared.state.foldHash !== expectedFoldHash)
      throw new Error('Receipt version preview or review changed');
    this.host.fresh(actor);
    this.fence(
      actor,
      prepared.capture,
      expectedFoldHash,
      prepared.plan.requiredSources,
      prepared.output,
    );
    this.host.store.evidence.receiptVersions.link(
      this.host.access(
        actor,
        prepared.capture.scope,
        prepared.plan.documents,
        prepared.output,
        'approve',
      ),
      { link: prepared.link, expectedFoldHash },
    );
    return { saved: true as const, child: prepared.link.child, version: prepared.link.version };
  }
  /** A tombstone removes a reviewed link without recovering old bytes or granting predecessor access. */
  async revoke(actor: MerchantActor, value: unknown) {
    const input = receiptVersionRevokeInputSchema.parse(value);
    this.host.fresh(actor);
    const capture = await this.host.capture(actor);
    this.host.fresh(actor);
    if (!capture.authorize()) throw new Error('Receipt version revocation is not authorized');
    this.host.store.evidence.receiptVersions.revoke(
      this.host.access(actor, capture.scope, undefined, input, 'approve'),
      { ...input, ...this.scope(actor) },
    );
    return {
      revoked: true as const,
      childDocumentId: input.childDocumentId,
      childReceiptId: input.childReceiptId,
    };
  }
}
