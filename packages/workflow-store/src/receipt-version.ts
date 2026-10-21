import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import {
  EvidenceObservationSchema,
  ReceiptEvidenceSchema,
} from '@balanceframe/protocol-generated/validators';
import type { EvidenceAccess, EvidenceDocument } from './transaction-evidence.js';
import { canonicalProposalJson } from './proposal.js';
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !/\p{Cc}/u.test(s));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(1).max(4294967295);
const review = z.object({ membershipId: id, policyVersion: id }).strict();
/** Exact immutable receipt identity; it confers no document or ledger authority. */
export const receiptVersionSourceSchema = z
  .object({ documentId: id, contentHash: hash, parserVersion: id, receiptId: id })
  .strict();
export type ReceiptVersionSource = z.infer<typeof receiptVersionSourceSchema>;
/** A local human's source-bound version relationship, separate from provider lineage. */
export const receiptVersionLinkSchema = z
  .object({
    child: receiptVersionSourceSchema,
    predecessor: receiptVersionSourceSchema,
    predecessorVersion: version,
    version,
    predecessorLineageHash: hash,
    identityBasis: z.enum(['matching_external_id', 'human_attested_same_receipt']),
    actorId: id,
    membershipId: id,
    policyVersion: id,
    reviewedAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (value) =>
      value.predecessorVersion < 4294967295 && value.version === value.predecessorVersion + 1,
  );
export type ReceiptVersionLink = z.infer<typeof receiptVersionLinkSchema>;
export interface ReceiptVersionBlockedChild {
  child: ReceiptVersionSource;
  reasonCode: 'reviewed_receipt_history_unavailable';
}
const tombstone = z
  .object({
    kind: z.literal('receipt_version_revoke'),
    childDocumentId: id,
    childReceiptId: id,
    actorId: id,
    membershipId: id,
    policyVersion: id,
    reviewedAt: z.string().datetime(),
  })
  .strict();
const eventSchema = z.union([
  z.object({ kind: z.literal('receipt_version_link'), link: receiptVersionLinkSchema }).strict(),
  tombstone,
]);
type Event = z.infer<typeof eventSchema>;
const namespace = (a: EvidenceAccess) =>
  JSON.stringify([a.scope.spaceId, a.scope.budgetId, a.scope.connectionId]);
const digest = (v: unknown) => createHash('sha256').update(canonicalProposalJson(v)).digest('hex');
/** Identify one independently revocable child relationship. */
export const receiptVersionKey = (ref: Pick<ReceiptVersionSource, 'documentId' | 'receiptId'>) =>
  JSON.stringify([ref.documentId, ref.receiptId]);
/** Inspect exact normalized source claims without interpreting amounts or modifying the original. */
export function receiptVersionFacts(document: EvidenceDocument, reference: ReceiptVersionSource) {
  if (
    document.id !== reference.documentId ||
    document.contentHash !== reference.contentHash ||
    document.parserVersion !== reference.parserVersion ||
    document.parseStatus !== 'parsed'
  )
    throw new Error('Receipt version source changed');
  const receipt = ReceiptEvidenceSchema.array()
    .parse(document.extraction.receipts ?? [])
    .find((r) => r.id === reference.receiptId);
  const observation = EvidenceObservationSchema.omit({ provenance: true })
    .array()
    .parse(document.extraction.observations ?? [])
    .find((o) => o.id === receipt?.observationId);
  if (
    !receipt ||
    !observation ||
    observation.kind !== 'receipt' ||
    observation.status !== 'completed' ||
    observation.amount.currency !== receipt.total.currency
  )
    throw new Error('Current receipt version source required');
  return { receipt, observation };
}
/** A reviewed version may join only the same source owner and explicit logical retailer identity. */
export function receiptVersionFamily(
  child: EvidenceDocument,
  parent: EvidenceDocument,
  childRef: ReceiptVersionSource,
  parentRef: ReceiptVersionSource,
): ReceiptVersionLink['identityBasis'] {
  const c = receiptVersionFacts(child, childRef),
    p = receiptVersionFacts(parent, parentRef);
  if (
    child.id === parent.id ||
    child.connectorId !== parent.connectorId ||
    child.privateActorId !== parent.privateActorId ||
    canonicalProposalJson(child.scope) !== canonicalProposalJson(parent.scope) ||
    child.extraction.templateVersion !== parent.extraction.templateVersion ||
    !c.observation.counterparty?.trim() ||
    c.observation.counterparty !== p.observation.counterparty ||
    c.observation.direction !== p.observation.direction ||
    c.receipt.total.currency !== p.receipt.total.currency
  )
    throw new Error('Receipt version source family mismatch');
  if (c.observation.externalEventId !== null || p.observation.externalEventId !== null) {
    if (
      c.observation.externalEventId === null ||
      c.observation.externalEventId !== p.observation.externalEventId
    )
      throw new Error('Receipt version logical identity mismatch');
    return 'matching_external_id';
  }
  return 'human_attested_same_receipt';
}
/** Reject forks and cycles even when they would otherwise appear as separate roots. */
export function validateReceiptVersionGraph(links: ReceiptVersionLink[]): void {
  if (links.length > 1000) throw new Error('Receipt version history limit exceeded');
  const parents = new Map<string, string>(),
    children = new Set<string>();
  for (const link of links) {
    const child = receiptVersionKey(link.child),
      parent = receiptVersionKey(link.predecessor);
    if (parents.has(child)) throw new Error('Duplicate receipt version child');
    if (children.has(parent)) throw new Error('Receipt version fork');
    parents.set(child, parent);
    children.add(parent);
  }
  const done = new Set<string>();
  for (const start of parents.keys()) {
    const path = new Set<string>();
    let at: string | undefined = start;
    while (at !== undefined && !done.has(at)) {
      if (path.has(at)) throw new Error('Receipt version cycle');
      path.add(at);
      at = parents.get(at);
    }
    for (const key of path) done.add(key);
  }
}
/** Append-only reviewed lineage reuses the evidence decisions table, without creating financial decisions. */
export class ReceiptVersionWorkflow {
  constructor(
    private readonly db: Database,
    private readonly get: (access: EvidenceAccess, id: string) => EvidenceDocument | null,
    private readonly current: (access: EvidenceAccess, id: string) => boolean,
  ) {}
  private events(access: EvidenceAccess): Event[] {
    z.object({ spaceId: id, budgetId: id, connectionId: id }).strict().parse(access.scope);
    id.parse(access.actorId);
    z.string().datetime().parse(access.now);
    const rows = this.db
      .prepare(
        "SELECT value FROM transaction_evidence_decisions WHERE scope_key=? AND actor_id=? AND source_hash='receipt-version:1' ORDER BY sequence DESC LIMIT 10001",
      )
      .all(namespace(access), access.actorId) as { value: string }[];
    if (rows.length > 10000) throw new Error('Receipt version event limit exceeded');
    return rows.map((row) => eventSchema.parse(JSON.parse(row.value)));
  }
  private folded(access: EvidenceAccess): Event[] {
    const latest = new Map<string, Event>();
    for (const event of this.events(access)) {
      const key =
        event.kind === 'receipt_version_link'
          ? receiptVersionKey(event.link.child)
          : receiptVersionKey({
              documentId: event.childDocumentId,
              receiptId: event.childReceiptId,
            });
      if (!latest.has(key)) latest.set(key, event);
    }
    return [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  }
  private permitted(access: EvidenceAccess, document: EvidenceDocument | null): boolean {
    return access.authorize({ capability: 'resolve', scope: access.scope, document }) === true;
  }
  /** Fold tombstones before policy and source eligibility so revoked historical approvals never revive. */
  state(
    access: EvidenceAccess,
    value: z.infer<typeof review>,
  ): {
    foldHash: string;
    links: ReceiptVersionLink[];
    blockedChildren: ReceiptVersionBlockedChild[];
  } {
    const scope = review.parse(value),
      events = this.folded(access),
      links: ReceiptVersionLink[] = [],
      blockedChildren: ReceiptVersionBlockedChild[] = [];
    if (this.permitted(access, null))
      for (const event of events) {
        if (event.kind !== 'receipt_version_link') continue;
        const link = event.link;
        if (
          link.actorId !== access.actorId ||
          link.membershipId !== scope.membershipId ||
          link.policyVersion !== scope.policyVersion
        )
          continue;
        const child = this.get(access, link.child.documentId);
        if (!child) continue;
        try {
          receiptVersionFacts(child, link.child);
        } catch {
          continue;
        }
        if (!this.permitted(access, child)) continue;
        const parent = this.get(access, link.predecessor.documentId);
        try {
          if (
            !parent ||
            !this.permitted(access, parent) ||
            receiptVersionFamily(child, parent, link.child, link.predecessor) !== link.identityBasis
          )
            throw new Error('Source unavailable');
          links.push(link);
        } catch {
          blockedChildren.push({
            child: link.child,
            reasonCode: 'reviewed_receipt_history_unavailable',
          });
        }
      }
    return { foldHash: digest(events), links, blockedChildren };
  }
  private fence(access: EvidenceAccess, expected: string): void {
    hash.parse(expected);
    if (!this.permitted(access, null)) throw new Error('Receipt version review is not authorized');
    if (digest(this.folded(access)) !== expected)
      throw new Error('Receipt version reviews changed');
  }
  private append(access: EvidenceAccess, event: Event): void {
    this.db
      .prepare(
        'INSERT INTO transaction_evidence_decisions(scope_key,actor_id,source_hash,value) VALUES(?,?,?,?)',
      )
      .run(namespace(access), access.actorId, 'receipt-version:1', JSON.stringify(event));
  }
  /** Admit one exact current child after fresh human review and an atomic source/fold fence. */
  link(
    access: EvidenceAccess,
    value: { link: ReceiptVersionLink; expectedFoldHash: string },
  ): void {
    const input = z
      .object({ link: receiptVersionLinkSchema, expectedFoldHash: hash })
      .strict()
      .parse(value);
    this.db
      .transaction(() => {
        this.fence(access, input.expectedFoldHash);
        const link = input.link;
        if (
          link.actorId !== access.actorId ||
          Date.parse(link.reviewedAt) > Date.parse(access.now) ||
          Date.parse(access.now) - Date.parse(link.reviewedAt) > 300000
        )
          throw new Error('Fresh receipt version human provenance required');
        const child = this.get(access, link.child.documentId),
          parent = this.get(access, link.predecessor.documentId);
        if (
          !child ||
          !parent ||
          !this.current(access, child.id) ||
          !this.permitted(access, child) ||
          !this.permitted(access, parent)
        )
          throw new Error('Current authorized receipt version source required');
        if (
          receiptVersionFamily(child, parent, link.child, link.predecessor) !== link.identityBasis
        )
          throw new Error('Receipt version identity changed');
        const key = receiptVersionKey(link.child);
        const others = this.folded(access).flatMap((event) =>
          event.kind === 'receipt_version_link' &&
          event.link.actorId === access.actorId &&
          event.link.membershipId === link.membershipId &&
          event.link.policyVersion === link.policyVersion &&
          receiptVersionKey(event.link.child) !== key
            ? [event.link]
            : [],
        );
        validateReceiptVersionGraph([...others, link]);
        this.append(access, { kind: 'receipt_version_link', link });
      })
      .immediate();
  }
  /** Revoke an owned relationship even after predecessor retention, grants or source currentness change. */
  revoke(
    access: EvidenceAccess,
    value: {
      childDocumentId: string;
      childReceiptId: string;
      expectedFoldHash: string;
      membershipId: string;
      policyVersion: string;
    },
  ): void {
    const input = review
      .extend({ childDocumentId: id, childReceiptId: id, expectedFoldHash: hash })
      .strict()
      .parse(value);
    this.db
      .transaction(() => {
        this.fence(access, input.expectedFoldHash);
        const key = receiptVersionKey({
          documentId: input.childDocumentId,
          receiptId: input.childReceiptId,
        });
        if (
          !this.events(access).some(
            (event) =>
              event.kind === 'receipt_version_link' &&
              receiptVersionKey(event.link.child) === key &&
              event.link.actorId === access.actorId,
          )
        )
          throw new Error('Known receipt version review required');
        this.append(access, {
          kind: 'receipt_version_revoke',
          childDocumentId: input.childDocumentId,
          childReceiptId: input.childReceiptId,
          actorId: access.actorId,
          membershipId: input.membershipId,
          policyVersion: input.policyVersion,
          reviewedAt: access.now,
        });
      })
      .immediate();
  }
}
