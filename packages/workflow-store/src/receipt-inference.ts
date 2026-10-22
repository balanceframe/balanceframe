import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import type { EvidenceAccess, EvidenceDocument } from './transaction-evidence.js';
import { canonicalProposalJson } from './proposal.js';
import { receiptVersionFacts } from './receipt-version.js';
const id = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !/\p{C}/u.test(v));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime();
const channel = z
  .object({
    enabled: z.boolean(),
    providerIds: z
      .array(id)
      .max(100)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
/** Separate local and external opt-ins and bounded shared budgets, disabled when absent. */
export const receiptInferencePolicySchema = z
  .object({
    local: channel,
    external: channel,
    maxCallsPerDay: z.number().int().min(0).max(100000),
    cacheTtlSeconds: z.number().int().min(0).max(86400),
  })
  .strict();
export type ReceiptInferencePolicy = z.infer<typeof receiptInferencePolicySchema>;
/** Trusted server installation policy; never load this from actor journal data. */
export interface ReceiptInferenceInstallation {
  installationId: string;
  revision: string;
  policy: ReceiptInferencePolicy;
}
const installationSchema = z
  .object({ installationId: id, revision: id, policy: receiptInferencePolicySchema })
  .strict();
const providerSchema = z
  .object({
    id,
    version: id,
    model: id,
    locality: z.enum(['local', 'external']),
    configRevision: id,
  })
  .strict();
/** Immutable receipt identity, independent of Actual transaction identities. */
export const receiptInferenceSubjectSchema = z
  .object({
    kind: z.literal('receipt-item'),
    accountId: id,
    documentId: id,
    contentHash: hash,
    parserVersion: id,
    receiptId: id,
    lineId: id,
  })
  .strict();
export type ReceiptInferenceSubject = z.infer<typeof receiptInferenceSubjectSchema>;
const alias = z.string().regex(/^c[a-f0-9]{16}$/);
const resultSchema = z
  .object({
    categoryAlias: alias.nullable(),
    confidence: z.number().finite().min(0).max(1).optional(),
  })
  .strict();
const bindingSchema = z
  .object({
    subject: receiptInferenceSubjectSchema,
    subjectHash: hash,
    bindingHash: hash,
    payloadHash: hash,
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    aliasMapping: z
      .record(alias, id)
      .refine(
        (v) =>
          Object.keys(v).length > 0 &&
          Object.keys(v).length <= 100 &&
          new Set(Object.values(v)).size === Object.values(v).length,
      ),
    provider: providerSchema,
  })
  .strict();
export type ReceiptInferenceBinding = z.infer<typeof bindingSchema>;
const previewSchema = bindingSchema
  .extend({
    purpose: z.literal('receipt-item-inference'),
    schemaVersion: z.literal(1),
    id,
    actorId: id,
    scope: z.object({ spaceId: id, budgetId: id, connectionId: id }).strict(),
    status: z.enum(['preview', 'dispatched', 'completed', 'failed', 'rejected', 'revoked']),
    createdAt: timestamp,
    expiresAt: timestamp,
    at: timestamp,
    policyRevisions: z.object({ space: id, budget: id, installation: hash }).strict(),
    installationId: id,
    result: resultSchema.nullable(),
    cacheUntil: timestamp.nullable(),
    failureCode: z
      .enum([
        'failed',
        'timeout',
        'invalid_response',
        'dispatch_guard_missing',
        'invalid_request',
        'unavailable',
      ])
      .nullable(),
  })
  .strict();
export type ReceiptInferencePreview = z.infer<typeof previewSchema>;
/** Content-free attribution suitable for an actor's scoped evidence export. */
export type ReceiptInferenceAudit = Pick<
  ReceiptInferencePreview,
  'at' | 'status' | 'subjectHash' | 'bindingHash' | 'payloadHash' | 'provider' | 'failureCode'
> & { previewId: string };
export interface ReceiptInferencePolicyState {
  revision: string;
  policy: ReceiptInferencePolicy | null;
}
const policyEvent = z
  .object({
    purpose: z.literal('receipt-item-inference-policy'),
    schemaVersion: z.literal(1),
    layer: z.enum(['space', 'budget']),
    policy: receiptInferencePolicySchema.nullable(),
    actorId: id,
    membershipId: id,
    policyVersion: id,
    at: timestamp,
  })
  .strict();
const refSchema = z
  .object({
    previewId: id,
    payloadHash: hash,
    bindingHash: hash,
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
type Ref = z.infer<typeof refSchema>;
const shortRef = z.object({ previewId: id, payloadHash: hash }).strict();
const journal = 'receipt-item-inference:1';
const policyJournal = 'receipt-item-inference-policy:1';
const quotaJournal = 'receipt-item-inference-quota:1';
const system = 'system:receipt-inference';
const digest = (v: unknown) => createHash('sha256').update(canonicalProposalJson(v)).digest('hex');
const ns = (a: EvidenceAccess) =>
  JSON.stringify([a.scope.spaceId, a.scope.budgetId, a.scope.connectionId]);
const policyNs = (a: EvidenceAccess, layer: 'space' | 'budget') =>
  JSON.stringify([
    a.scope.spaceId,
    layer === 'space' ? 'receipt-inference:space' : a.scope.budgetId,
    `receipt-inference:${layer}`,
  ]);
/** Purpose-specific append-only inference lifecycle; it cannot create categorization or financial decisions. */
export class ReceiptInferenceWorkflow {
  constructor(
    private readonly db: Database,
    private readonly get: (a: EvidenceAccess, id: string) => EvidenceDocument | null,
    private readonly current: (a: EvidenceAccess, id: string) => boolean,
  ) {}
  private validate(a: EvidenceAccess) {
    z.object({ spaceId: id, budgetId: id, connectionId: id }).strict().parse(a.scope);
    id.parse(a.actorId);
    timestamp.parse(a.now);
    if (typeof a.authorize !== 'function') throw Error('Receipt inference authority unavailable');
  }
  private authorize(
    a: EvidenceAccess,
    locality: 'local' | 'external' | 'policy:manage',
    document: EvidenceDocument | null = null,
  ) {
    this.validate(a);
    if (!a.authorize({ scope: a.scope, document, capability: `receipt-inference:${locality}` }))
      throw Error('Receipt inference is not authorized');
  }
  /** Read the latest independent system policy; malformed or revoked latest records disable the layer. */
  policyState(a: EvidenceAccess, layer: 'space' | 'budget'): ReceiptInferencePolicyState {
    this.validate(a);
    z.enum(['space', 'budget']).parse(layer);
    const row = this.db
      .prepare(
        'SELECT sequence,value FROM transaction_evidence_decisions WHERE scope_key=? AND actor_id=? AND source_hash=? ORDER BY sequence DESC LIMIT 1',
      )
      .get(policyNs(a, layer), system, policyJournal) as
      { sequence: number; value: string } | undefined;
    if (!row) return { revision: '0', policy: null };
    try {
      const parsed = policyEvent.parse(JSON.parse(row.value));
      return {
        revision: String(row.sequence),
        policy: parsed.layer === layer ? parsed.policy : null,
      };
    } catch {
      return { revision: String(row.sequence), policy: null };
    }
  }
  /** CAS update of one policy layer under explicit management authority. */
  updatePolicy(
    a: EvidenceAccess,
    value: {
      layer: 'space' | 'budget';
      expectedRevision: string;
      policy: ReceiptInferencePolicy | null;
      review: { membershipId: string; policyVersion: string };
    },
  ): ReceiptInferencePolicyState {
    const input = z
      .object({
        layer: z.enum(['space', 'budget']),
        expectedRevision: id,
        policy: receiptInferencePolicySchema.nullable(),
        review: z.object({ membershipId: id, policyVersion: id }).strict(),
      })
      .strict()
      .parse(value);
    this.authorize(a, 'policy:manage');
    return this.db
      .transaction(() => {
        if (this.policyState(a, input.layer).revision !== input.expectedRevision)
          throw Error('Receipt inference policy changed');
        this.db
          .prepare(
            'INSERT INTO transaction_evidence_decisions(scope_key,actor_id,source_hash,value) VALUES(?,?,?,?)',
          )
          .run(
            policyNs(a, input.layer),
            system,
            policyJournal,
            JSON.stringify({
              purpose: 'receipt-item-inference-policy',
              schemaVersion: 1,
              layer: input.layer,
              policy: input.policy,
              actorId: a.actorId,
              ...input.review,
              at: a.now,
            }),
          );
        return this.policyState(a, input.layer);
      })
      .immediate();
  }
  private policies(
    a: EvidenceAccess,
    provider: ReceiptInferenceBinding['provider'],
    installation: ReceiptInferenceInstallation | null,
  ) {
    const installed = installationSchema.parse(installation);
    const space = this.policyState(a, 'space'),
      budget = this.policyState(a, 'budget');
    const layers = [installed.policy, space.policy, budget.policy];
    if (
      layers.some(
        (p) =>
          !p ||
          !p[provider.locality].enabled ||
          !p[provider.locality].providerIds.includes(provider.id),
      )
    )
      throw Error('Receipt inference policy disabled');
    return {
      installation: installed,
      revisions: {
        space: space.revision,
        budget: budget.revision,
        installation: digest(installed),
      },
      limits: layers.map((p) => p!.maxCallsPerDay),
      ttl: Math.min(...layers.map((p) => p!.cacheTtlSeconds)),
    };
  }
  private source(a: EvidenceAccess, p: ReceiptInferenceBinding) {
    const document = this.get(a, p.subject.documentId);
    if (
      !document ||
      !this.current(a, document.id) ||
      (document.privateActorId && document.privateActorId !== a.actorId) ||
      Date.parse(document.retentionUntil) <= Date.parse(a.now)
    )
      throw Error('Receipt inference source unavailable');
    const row = this.db
      .prepare('SELECT ciphertext FROM transaction_evidence_documents WHERE scope_key=? AND id=?')
      .get(ns(a), document.id) as { ciphertext: Buffer | null } | undefined;
    if (!row?.ciphertext) throw Error('Receipt inference source deleted');
    const { receipt } = receiptVersionFacts(document, p.subject);
    if (!receipt.lines.some((line) => line.id === p.subject.lineId))
      throw Error('Receipt inference line unavailable');
    this.authorize(a, p.provider.locality, document);
  }
  private *events(a: EvidenceAccess): Generator<ReceiptInferencePreview> {
    this.validate(a);
    let before: number | undefined;
    for (;;) {
      const rows = this.db
        .prepare(
          `SELECT sequence,value FROM transaction_evidence_decisions WHERE scope_key=? AND actor_id=? AND source_hash=? ${before === undefined ? '' : 'AND sequence<?'} ORDER BY sequence DESC LIMIT 1000`,
        )
        .all(ns(a), a.actorId, journal, ...(before === undefined ? [] : [before])) as {
        sequence: number;
        value: string;
      }[];
      for (const row of rows) yield previewSchema.parse(JSON.parse(row.value));
      if (rows.length < 1000) return;
      before = rows[rows.length - 1].sequence;
    }
  }
  private findEvent(
    a: EvidenceAccess,
    filter: {
      previewId?: string;
      status?: ReceiptInferencePreview['status'];
      bindingHash?: string;
      payloadHash?: string;
      subjectHash?: string;
      locality?: 'local' | 'external';
    },
    folded = false,
  ): ReceiptInferencePreview | null {
    this.validate(a);
    const paths = {
      previewId: '$.id',
      status: '$.status',
      bindingHash: '$.bindingHash',
      payloadHash: '$.payloadHash',
      subjectHash: '$.subjectHash',
      locality: '$.provider.locality',
    };
    const fields = (Object.keys(filter) as (keyof typeof filter)[]).filter(
      (key) => filter[key] !== undefined,
    );
    // Fold before filtering so a later withdrawal can never expose an older matching result.
    const row = this.db
      .prepare(
        `SELECT value FROM transaction_evidence_decisions WHERE scope_key=? AND actor_id=? AND source_hash=? ${folded ? `AND sequence IN (SELECT MAX(sequence) FROM transaction_evidence_decisions WHERE scope_key=? AND actor_id=? AND source_hash=? GROUP BY json_extract(value,'$.id'))` : ''} ${fields.map((key) => `AND json_extract(value,'${paths[key]}')=?`).join(' ')} ORDER BY sequence DESC LIMIT 1`,
      )
      .get(
        ns(a),
        a.actorId,
        journal,
        ...(folded ? [ns(a), a.actorId, journal] : []),
        ...fields.map((key) => filter[key]!),
      ) as { value: string } | undefined;
    return row ? previewSchema.parse(JSON.parse(row.value)) : null;
  }
  private append(a: EvidenceAccess, p: ReceiptInferencePreview): ReceiptInferencePreview {
    const parsed = previewSchema.parse(p);
    if (
      parsed.actorId !== a.actorId ||
      canonicalProposalJson(parsed.scope) !== canonicalProposalJson(a.scope)
    )
      throw Error('Receipt inference scope mismatch');
    this.db
      .prepare(
        'INSERT INTO transaction_evidence_decisions(scope_key,actor_id,source_hash,value) VALUES(?,?,?,?)',
      )
      .run(ns(a), a.actorId, journal, JSON.stringify(parsed));
    return structuredClone(parsed);
  }
  private latest(a: EvidenceAccess, previewId: string) {
    return this.findEvent(a, { previewId });
  }
  private live(
    a: EvidenceAccess,
    p: ReceiptInferencePreview,
    installation: ReceiptInferenceInstallation | null,
  ) {
    this.source(a, p);
    const policy = this.policies(a, p.provider, installation);
    if (
      canonicalProposalJson(policy.revisions) !== canonicalProposalJson(p.policyRevisions) ||
      policy.installation.installationId !== p.installationId
    )
      throw Error('Receipt inference policy changed');
    if (Date.parse(p.createdAt) > Date.parse(a.now))
      throw Error('Receipt inference timestamp invalid');
    return policy;
  }
  /** Persist a five-minute preview without its labels or raw payload. */
  createPreview(
    a: EvidenceAccess,
    value: ReceiptInferenceBinding,
    installation: ReceiptInferenceInstallation | null,
  ): ReceiptInferencePreview {
    const input = bindingSchema.parse(value);
    return this.db
      .transaction(() => {
        this.source(a, input);
        const policy = this.policies(a, input.provider, installation);
        return this.append(a, {
          ...input,
          purpose: 'receipt-item-inference',
          schemaVersion: 1,
          id: randomUUID(),
          actorId: a.actorId,
          scope: a.scope,
          status: 'preview',
          createdAt: a.now,
          expiresAt: new Date(Date.parse(a.now) + 300000).toISOString(),
          at: a.now,
          policyRevisions: policy.revisions,
          installationId: policy.installation.installationId,
          result: null,
          cacheUntil: null,
          failureCode: null,
        });
      })
      .immediate();
  }
  /** Read one actor-scoped journal record for server recapture; this alone grants no dispatch or cache authority. */
  getPreview(
    a: EvidenceAccess,
    value: { previewId: string; payloadHash: string },
  ): ReceiptInferencePreview | null {
    const input = shortRef.parse(value);
    const p = this.latest(a, input.previewId);
    return p && p.payloadHash === input.payloadHash ? p : null;
  }
  /** Revalidate exact current binding and policy before showing a still-live preview. */
  readLivePreview(
    a: EvidenceAccess,
    value: { previewId: string; payloadHash: string; bindingHash: string },
    installation: ReceiptInferenceInstallation | null,
  ): ReceiptInferencePreview | null {
    const input = z
      .object({ previewId: id, payloadHash: hash, bindingHash: hash })
      .strict()
      .parse(value);
    const p = this.getPreview(a, { previewId: input.previewId, payloadHash: input.payloadHash });
    if (
      !p ||
      p.bindingHash !== input.bindingHash ||
      p.status !== 'preview' ||
      Date.parse(a.now) >= Date.parse(p.expiresAt)
    )
      return null;
    try {
      this.live(a, p, installation);
      return p;
    } catch {
      return null;
    }
  }
  /** Revalidate a consumed live dispatch immediately before provider I/O. */
  readLiveDispatch(
    a: EvidenceAccess,
    value: { previewId: string; payloadHash: string; bindingHash: string },
    installation: ReceiptInferenceInstallation | null,
  ): ReceiptInferencePreview | null {
    const input = z
      .object({ previewId: id, payloadHash: hash, bindingHash: hash })
      .strict()
      .parse(value);
    const p = this.getPreview(a, { previewId: input.previewId, payloadHash: input.payloadHash });
    if (
      !p ||
      p.bindingHash !== input.bindingHash ||
      p.status !== 'dispatched' ||
      Date.parse(a.now) >= Date.parse(p.expiresAt)
    )
      return null;
    const original = this.findEvent(a, { previewId: p.id, status: 'preview' });
    if (!original || digest({ ...original, status: 'dispatched', at: p.at }) !== digest(p))
      return null;
    try {
      this.live(a, p, installation);
      return p;
    } catch {
      return null;
    }
  }
  /** Atomically consume consent and reserve installation, space and budget quota across actors. */
  consumePreview(
    a: EvidenceAccess,
    value: Ref,
    installation: ReceiptInferenceInstallation | null,
  ): ReceiptInferencePreview {
    const input = refSchema.parse(value);
    return this.db
      .transaction(() => {
        const p = this.readLivePreview(
          a,
          {
            previewId: input.previewId,
            payloadHash: input.payloadHash,
            bindingHash: input.bindingHash,
          },
          installation,
        );
        if (!p || p.nonce !== input.nonce)
          throw Error('Receipt inference preview expired or consumed');
        const policy = this.live(a, p, installation);
        const date = a.now.slice(0, 10);
        const rows = this.db
          .prepare(
            'SELECT value FROM transaction_evidence_decisions WHERE actor_id=? AND source_hash=? AND scope_key=?',
          )
          .all(
            system,
            quotaJournal,
            JSON.stringify(['receipt-inference:quota', p.installationId, date]),
          ) as { value: string }[];
        const reservations = rows.map((r) =>
          z
            .object({
              purpose: z.literal('receipt-item-inference-quota'),
              schemaVersion: z.literal(1),
              spaceId: id,
              budgetId: id,
              at: timestamp,
            })
            .strict()
            .parse(JSON.parse(r.value)),
        );
        const used = [
          reservations.length,
          reservations.filter((r) => r.spaceId === a.scope.spaceId).length,
          reservations.filter(
            (r) => r.spaceId === a.scope.spaceId && r.budgetId === a.scope.budgetId,
          ).length,
        ];
        if (used.some((v, i) => v >= policy.limits[i]))
          throw Error('Receipt inference daily quota exhausted');
        this.db
          .prepare(
            'INSERT INTO transaction_evidence_decisions(scope_key,actor_id,source_hash,value) VALUES(?,?,?,?)',
          )
          .run(
            JSON.stringify(['receipt-inference:quota', p.installationId, date]),
            system,
            quotaJournal,
            JSON.stringify({
              purpose: 'receipt-item-inference-quota',
              schemaVersion: 1,
              spaceId: a.scope.spaceId,
              budgetId: a.scope.budgetId,
              at: a.now,
            }),
          );
        return this.append(a, { ...p, status: 'dispatched', at: a.now });
      })
      .immediate();
  }
  /** Accept only one current original live dispatch; deletion, withdrawal and restore cannot resurrect it. */
  finishDispatch(
    a: EvidenceAccess,
    value: Ref & { result: z.infer<typeof resultSchema> },
    installation: ReceiptInferenceInstallation | null,
  ): ReceiptInferencePreview {
    const input = refSchema.extend({ result: resultSchema }).parse(value);
    return this.db
      .transaction(() => {
        const p = this.latest(a, input.previewId);
        if (
          !p ||
          p.status !== 'dispatched' ||
          p.payloadHash !== input.payloadHash ||
          p.bindingHash !== input.bindingHash ||
          p.nonce !== input.nonce ||
          Date.parse(a.now) >= Date.parse(p.expiresAt)
        )
          throw Error('Receipt inference live dispatch required');
        const original = this.findEvent(a, { previewId: p.id, status: 'preview' });
        if (!original || digest({ ...original, status: 'dispatched', at: p.at }) !== digest(p))
          throw Error('Receipt inference original dispatch unavailable');
        const policy = this.live(a, p, installation);
        if (
          input.result.categoryAlias !== null &&
          !Object.hasOwn(p.aliasMapping, input.result.categoryAlias)
        )
          throw Error('Receipt inference category alias unavailable');
        return this.append(a, {
          ...p,
          status: 'completed',
          at: a.now,
          result: input.result,
          cacheUntil: new Date(Date.parse(a.now) + policy.ttl * 1000).toISOString(),
        });
      })
      .immediate();
  }
  /** Record a content-free dispatch failure without refunding reserved quota. */
  failDispatch(
    a: EvidenceAccess,
    value: { previewId: string; payloadHash: string },
    code: ReceiptInferencePreview['failureCode'],
  ): ReceiptInferencePreview {
    const input = shortRef.parse(value);
    const failureCode = previewSchema.shape.failureCode.unwrap().parse(code);
    return this.db
      .transaction(() => {
        const p = this.getPreview(a, input);
        if (!p || p.status !== 'dispatched')
          throw Error('Receipt inference live dispatch required');
        this.authorize(a, p.provider.locality);
        return this.append(a, {
          ...p,
          status: 'failed',
          at: a.now,
          result: null,
          cacheUntil: null,
          failureCode,
        });
      })
      .immediate();
  }
  /** Append an actor-scoped rejection or revocation even if source access has since disappeared. */
  withdraw(
    a: EvidenceAccess,
    value: { previewId: string; payloadHash: string },
    status: 'rejected' | 'revoked',
  ): ReceiptInferencePreview {
    const input = shortRef.parse(value);
    z.enum(['rejected', 'revoked']).parse(status);
    return this.db
      .transaction(() => {
        const p = this.getPreview(a, input);
        if (!p || p.status === 'revoked' || p.status === 'rejected')
          throw Error('Receipt inference record unavailable');
        this.authorize(a, p.provider.locality);
        return this.append(a, { ...p, status, at: a.now, result: null, cacheUntil: null });
      })
      .immediate();
  }
  /** Export only content-free actor-scoped lifecycle attribution under current locality grants. */
  audit(a: EvidenceAccess): ReceiptInferenceAudit[] {
    return this.db.transaction(() => {
      const audit: ReceiptInferenceAudit[] = [];
      for (const p of this.events(a)) {
        if (
          a.authorize({
            scope: a.scope,
            document: null,
            capability: `receipt-inference:${p.provider.locality}`,
          })
        )
          audit.push({
            previewId: p.id,
            at: p.at,
            status: p.status,
            subjectHash: p.subjectHash,
            bindingHash: p.bindingHash,
            payloadHash: p.payloadHash,
            provider: structuredClone(p.provider),
            failureCode: p.failureCode,
          });
      }
      return audit;
    })();
  }
  /** Read only an unexpired completed result under current source, binding and all policy layers. */
  lookup(
    a: EvidenceAccess,
    value: { bindingHash: string; payloadHash?: string },
    installation: ReceiptInferenceInstallation | null,
  ): ReceiptInferencePreview | null {
    const input = z
      .object({ bindingHash: hash, payloadHash: hash.optional() })
      .strict()
      .parse(value);
    const p = this.findEvent(a, input, true);
    if (
      !p ||
      p.status !== 'completed' ||
      !p.cacheUntil ||
      Date.parse(a.now) >= Date.parse(p.cacheUntil)
    )
      return null;
    try {
      this.live(a, p, installation);
      return p;
    } catch {
      return null;
    }
  }
  /** Read the latest current local attempt for explicit escalation decisions, including rejection and failure. */
  latestLocal(
    a: EvidenceAccess,
    value: { subjectHash: string },
    installation: ReceiptInferenceInstallation | null,
  ): ReceiptInferencePreview | null {
    const input = z.object({ subjectHash: hash }).strict().parse(value);
    const p = this.findEvent(a, { ...input, locality: 'local' }, true);
    if (!p) return null;
    try {
      this.live(a, p, installation);
      return p;
    } catch {
      return null;
    }
  }
  /** Find the newest matching live cached suggestion without knowing its randomized payload hash. */
  latestForSubject(
    a: EvidenceAccess,
    value: { subjectHash: string; bindingHash?: string },
    installation: ReceiptInferenceInstallation | null,
  ): ReceiptInferencePreview | null {
    const input = z
      .object({ subjectHash: hash, bindingHash: hash.optional() })
      .strict()
      .parse(value);
    const p = this.findEvent(a, input, true);
    if (!p) return null;
    return this.lookup(a, { bindingHash: p.bindingHash, payloadHash: p.payloadHash }, installation);
  }
}
