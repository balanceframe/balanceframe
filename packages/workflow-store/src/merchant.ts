import type { Database } from 'better-sqlite3';
import type { GovernanceResourceKind } from './governance-types.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(512).refine((value) => value.trim() === value && !/[^\u0020-\u{10ffff}]|\u007f/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = id;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const currency = z.string().regex(/^[A-Z]{3}$/);
const timestamp = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z'), 'Invalid ISO UTC timestamp');
const atoms = z.string().max(128).regex(/^(0|[1-9]\d*)$/);
const positiveAtoms = atoms.refine((value) => BigInt(value) > 0n);
const scopeSchema = z.object({ spaceId: id, budgetId: id, connectionId: id }).strict();
const visibilitySchema = z.object({ hash, privateActorId: id.nullable() }).strict();
/** Validate server-owned derivation ownership and its original, non-renewable lifetime. */
export const merchantDerivationSchema = z.object({ scope: scopeSchema, privateActorId: id.nullable(), capturedAt: timestamp, expiresAt: timestamp }).strict()
  .refine((value) => Date.parse(value.expiresAt) > Date.parse(value.capturedAt), 'Invalid merchant derivation lifetime');
const resourceKind = z.enum(['space', 'budget', 'account', 'category', 'transaction', 'rule', 'evidence', 'wallet', 'receipt', 'commitment', 'scenario', 'reservation', 'purchase', 'transfer', 'ledger_effect', 'session', 'proposal']);
const ids = z.array(id).max(250000).refine((values) => new Set(values).size === values.length, 'Duplicate source identity');
const refsSchema = z.object({
  accountIds: ids, categoryIds: ids, ruleIds: ids, transactionIds: ids, factsHash: hash,
  required: z.array(z.object({ resourceKind, resourceId: id, capability: id, version: version.nullable() }).strict()).max(2000000),
}).strict().superRefine((value, context) => {
  for (const [kind, values] of [['account', value.accountIds], ['category', value.categoryIds], ['rule', value.ruleIds], ['transaction', value.transactionIds]] as const) {
    const required = new Set(value.required.filter((ref) => ref.resourceKind === kind).map((ref) => ref.resourceId));
    if (required.size !== values.length || values.some((identity) => !required.has(identity))) context.addIssue({ code: 'custom', message: `Incomplete ${kind} authority manifest` });
  }
  const keys = value.required.map((ref) => JSON.stringify([ref.resourceKind, ref.resourceId, ref.capability]));
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: 'Duplicate required resource capability' });
});
const payloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('alias'), sourceText: z.string().min(1).max(4096), sourceField: z.enum(['importedPayee', 'description', 'verboseTitle', 'notes', 'payeeName']), normalizationVersion: version, targetPayeeId: id, accountId: id.nullable(), sourceTransactionIds: ids }).strict(),
  z.object({ kind: z.literal('pattern'), patternId: id }).strict(),
]);
const calendarSelectionSchema = z.object({
  jurisdiction: id, subdivision: id.nullable(),
  timeZone: z.string().max(128).regex(/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)*$/).refine((timeZone) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); return true; } catch { return false; }
  }, 'Invalid IANA time zone'),
}).strict();
const calendarConfigurationSchema = z.object({
  budget: calendarSelectionSchema.nullable(),
  accounts: z.array(z.object({ accountId: id, selection: calendarSelectionSchema.nullable() }).strict()).max(10000)
    .refine((accounts) => new Set(accounts.map((account) => account.accountId)).size === accounts.length, 'Duplicate account calendar'),
}).strict();
/** Validate bounded merchant policy values without mixing ledger and provider billing currencies. */
export const merchantPolicyValueSchema = z.object({ mode: z.enum(['disabled', 'local-only', 'external-allowed']), allowedProviderIds: z.array(id).max(100).refine((values) => new Set(values).size === values.length), maxSearchesPerDay: count, maxSpendMinorUnitsPerMonth: count, billingCurrency: currency, cacheTtlHours: z.number().int().min(1).max(720), calendar: calendarConfigurationSchema.optional() }).strict();
const keySchema = z.object({ scope: scopeSchema, queryFingerprint: hash, locale: z.string().min(1).max(64).nullable(), providerId: id, providerVersion: version, parametersHash: hash, normalizationVersion: version, egressPolicyVersion: version, visibilityHash: hash }).strict();
const evidenceValueSchema = z.object({ key: id, revision: hash, snapshotId: id, factsHash: hash, normalizationVersion: version, calendarVersion: version.nullable(), policyVersion: count, capturedAt: timestamp, expiresAt: timestamp, visibility: visibilitySchema, sourceRefs: refsSchema }).strict();
const plainText = (maximum: number) => z.string().max(maximum).refine((value) => !/[^\u0020-\u{10ffff}]|\u007f/u.test(value));
const sourceSchema = z.object({ url: z.string().max(2048).refine((value) => {
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !/[^\u0021-\u{10ffff}]|\u007f/u.test(value); } catch { return false; }
}), title: plainText(256), snippet: plainText(1000) }).strict();
const enrichmentValueSchema = z.object({ key: keySchema, sources: z.array(sourceSchema).max(10), fieldsSent: z.array(z.enum(['merchant', 'locale'])).min(1).max(2).refine((values) => values.includes('merchant') && new Set(values).size === values.length), retrievedAt: timestamp, expiresAt: timestamp, policyVersion: count, evidenceRevision: hash, confidence: z.literal('uncalibrated'), visibility: visibilitySchema, sourceRefs: refsSchema }).strict();
const bucketSchema = z.object({ kind: z.enum(['installation', 'space', 'budget', 'credential', 'delegation']), id, maxSearchesPerDay: count, maxSpendMinorUnitsPerMonth: count }).strict();
const bucketListSchema = z.array(bucketSchema);
const tariffSchema = z.object({ version, billingCurrency: currency, costAtoms: positiveAtoms }).strict();
const outcomeSchema = z.discriminatedUnion('phase', [z.object({ phase: z.literal('succeeded'), costAtoms: atoms }).strict(), z.object({ phase: z.literal('known_failed'), costAtoms: z.literal('0'), providerEvidence: z.literal('not_billed') }).strict(), z.object({ phase: z.literal('uncertain') }).strict()]);
// Stored worker proof is separate from provider billing evidence and is not accepted by settleAttempt.
const workerOutcomeSchema = z.object({ phase: z.literal('known_failed'), costAtoms: z.literal('0'), providerEvidence: z.literal('not_billed'), workerEvidence: z.literal('not_invoked') }).strict();
const storedOutcomeSchema = z.union([outcomeSchema, workerOutcomeSchema]);
const policySchema = merchantPolicyValueSchema.extend({ scope: scopeSchema, version: count, generation: count, updatedAt: timestamp }).strict();
const decisionSchema = z.object({ id, scope: scopeSchema, payload: payloadSchema, state: z.enum(['accepted', 'rejected', 'revoked']), actorId: id, version: count, updatedAt: timestamp, generation: count, visibility: visibilitySchema, sourceRefs: refsSchema }).strict();
const evidenceSchema = evidenceValueSchema.extend({ scope: scopeSchema, generation: count }).strict();
const evidenceFactsSchema = evidenceValueSchema.omit({ capturedAt: true, snapshotId: true, expiresAt: true }).strip();
/** Validate stored historical semantic observations and their complete scoped provenance. */
export const merchantEnrichmentSchema = enrichmentValueSchema.extend({ generation: count }).strict();
const accessSchema = z.object({
  scope: scopeSchema, now: timestamp, expectedGeneration: count,
  authorize: z.custom<MerchantAuthorize>((value) => typeof value === 'function'),
  visibility: visibilitySchema.optional(), actorId: id.optional(),
  id: id.optional(), payload: payloadSchema.optional(), state: z.enum(['accepted', 'rejected', 'revoked']).optional(),
  sourceRefs: refsSchema.optional(), expectedVersion: count.optional(), value: z.unknown().optional(),
  key: z.union([id, keySchema]).optional(), expectedRevision: hash.nullable().optional(),
  idempotencyKey: id.optional(), policyVersion: count.optional(), tariff: tariffSchema.nullable().optional(),
  buckets: bucketListSchema.optional(), attemptId: id.optional(), claimToken: id.optional(),
  outcome: outcomeSchema.optional(), cursor: id.optional(), kind: z.enum(['alias', 'pattern']).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).strict();
const attemptOwnerSchema = z.object({ scope: scopeSchema, now: timestamp, expectedGeneration: count, id, claimToken: id }).strict();

export type MerchantScope = z.infer<typeof scopeSchema>;
export type MerchantVisibility = z.infer<typeof visibilitySchema>;
export type MerchantDerivation = z.infer<typeof merchantDerivationSchema>;
export type MerchantSourceRefs = { accountIds: string[]; categoryIds: string[]; ruleIds: string[]; transactionIds: string[]; factsHash: string; required: { resourceKind: GovernanceResourceKind; resourceId: string; capability: string; version: string | null }[] };
export type MerchantAuthorizationContext = { scope: MerchantScope; now: string; generation: number; visibility: MerchantVisibility | null; sourceRefs: MerchantSourceRefs };
export type MerchantAuthorize = (context: MerchantAuthorizationContext) => boolean;
export type MerchantAccess = { scope: MerchantScope; now: string; expectedGeneration: number; authorize: MerchantAuthorize };
export type MerchantViewAccess = MerchantAccess & { visibility: MerchantVisibility; actorId: string };
export type MerchantDecisionPayload = z.infer<typeof payloadSchema>;
export type MerchantDecision = { id: string; scope: MerchantScope; payload: MerchantDecisionPayload; state: 'accepted' | 'rejected' | 'revoked'; actorId: string; version: number; updatedAt: string; generation: number; visibility: MerchantVisibility; sourceRefs: MerchantSourceRefs };
export type MerchantPolicyValue = z.infer<typeof merchantPolicyValueSchema>;
export type MerchantPolicy = MerchantPolicyValue & { scope: MerchantScope; version: number; generation: number; updatedAt: string };
export type MerchantEvidence = z.infer<typeof evidenceValueSchema> & { scope: MerchantScope; generation: number };
export type MerchantCacheKey = z.infer<typeof keySchema>;
export type MerchantEnrichment = z.infer<typeof enrichmentValueSchema> & { generation: number };
export type MerchantQuotaBucket = z.infer<typeof bucketSchema>;
export type MerchantTariff = z.infer<typeof tariffSchema>;
export type MerchantResearchAttempt = { id: string; scope: MerchantScope; phase: 'reserved' | 'dispatched' | 'succeeded' | 'known_failed' | 'uncertain'; generation: number; policyVersion: number; reservedCostAtoms: string; settledCostAtoms: string | null; billingCurrency: string; tariffVersion: string; createdAt: string; leaseExpiresAt: string; dispatchedAt: string | null; invocationEvidence: 'not_invoked' | null; claimToken: string | null; visibility: MerchantVisibility; sourceRefs: MerchantSourceRefs };
export type MerchantAttemptAdmission = { status: 'admitted' | 'pending'; attempt: MerchantResearchAttempt } | { status: 'denied'; reason: 'unauthorized' | 'stale_generation' | 'restore_pending' | 'restore_billing_hold' | 'policy' | 'unknown_pricing' | 'daily_cap' | 'monthly_cap' };
export type MerchantAttemptOutcome = z.infer<typeof outcomeSchema>;
/** Opaque ownership of one live worker lease; grants and financial content are deliberately absent. */
export type MerchantAttemptOwner = z.infer<typeof attemptOwnerSchema>;

type ScopeRow = { scope_key: string; space_id: string; budget_id: string; connection_id: string; generation: number; restore_pending: number; billing_hold_until: string | null; billing_unresolved: number };
type ValueRow = { value: string };
type AttemptRow = { id: string; scope_key: string; idempotency_hash: string; intent_hash: string; key_hash: string; generation: number; policy_version: number; phase: MerchantResearchAttempt['phase']; reserved_atoms: string; settled_atoms: string | null; billing_currency: string; tariff_version: string; created_at: string; lease_expires_at: string; dispatched_at: string | null; claim_token: string | null; outcome: string | null; visibility: string; source_refs: string; buckets: string; day_window: string; month_window: string; content_deleted: number };
const EMPTY_REFS: MerchantSourceRefs = { accountIds: [], categoryIds: [], ruleIds: [], transactionIds: [], factsHash: '0'.repeat(64), required: [] };
const scopeKey = (scope: MerchantScope) => JSON.stringify([scope.spaceId, scope.budgetId, scope.connectionId]);
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function active(lease: string, now: string): boolean { return Date.parse(lease) > Date.parse(now); }
function lease(now: string): string { return new Date(Date.parse(now) + 30000).toISOString(); }
function validateAccess(input: MerchantAccess, view = false): void {
  accessSchema.parse(input);
  if (view) { const viewed = input as MerchantViewAccess; visibilitySchema.parse(viewed.visibility); id.parse(viewed.actorId); }
}

/** Synchronous merchant operations share the workflow database and its transaction fence. */
export class MerchantWorkflow {
  constructor(private readonly db: Database) {}
  private transaction<T>(body: () => T): T { return this.db.transaction(body).immediate(); }
  private scope(scope: MerchantScope): ScopeRow | undefined { return this.db.prepare('SELECT * FROM merchant_scope_generations WHERE scope_key=?').get(scopeKey(scope)) as ScopeRow | undefined; }
  private ensure(scope: MerchantScope): void {
    const restored = this.db.prepare("SELECT * FROM merchant_scope_generations WHERE scope_key=''").get() as ScopeRow | undefined;
    this.db.prepare('INSERT OR IGNORE INTO merchant_scope_generations(scope_key,space_id,budget_id,connection_id,restore_pending,billing_hold_until,billing_unresolved) VALUES (?,?,?,?,?,?,?)').run(scopeKey(scope), scope.spaceId, scope.budgetId, scope.connectionId, restored?.restore_pending ?? 0, restored?.billing_hold_until ?? null, restored?.billing_unresolved ?? 0);
  }
  private authorize(input: MerchantAccess, sourceRefs = EMPTY_REFS, visibility: MerchantVisibility | null = null): boolean {
    const answer: unknown = input.authorize({ scope: { ...input.scope }, now: input.now, generation: this.scope(input.scope)?.generation ?? 0, visibility: visibility ? { ...visibility } : null, sourceRefs: structuredClone(sourceRefs) });
    if (typeof answer !== 'boolean') throw new Error('Merchant authorization must return a synchronous boolean');
    return answer;
  }
  private permitted(input: MerchantAccess, sourceRefs = EMPTY_REFS, visibility: MerchantVisibility | null = null, allowRestore = false): boolean {
    if (!this.authorize(input, sourceRefs, visibility)) return false;
    if (visibility) {
      const view = input as MerchantViewAccess;
      if (!same(view.visibility, visibility) || (visibility.privateActorId !== null && visibility.privateActorId !== view.actorId)) return false;
    }
    const row = this.scope(input.scope);
    const global = this.db.prepare("SELECT restore_pending FROM merchant_scope_generations WHERE scope_key=''").get() as { restore_pending: number } | undefined;
    return input.expectedGeneration === (row?.generation ?? 0) && (allowRestore || !(row?.restore_pending ?? global?.restore_pending ?? 0));
  }
  private policyValue(scope: MerchantScope): MerchantPolicy | null {
    const row = this.db.prepare('SELECT value FROM merchant_policies WHERE scope_key=?').get(scopeKey(scope)) as ValueRow | undefined;
    return row ? policySchema.parse(JSON.parse(row.value)) : null;
  }
  private external(scope: MerchantScope, policyVersion: number, keyHash?: string, key?: MerchantCacheKey): boolean {
    const policy = this.policyValue(scope);
    return !!policy && policy.mode === 'external-allowed' && policy.version === policyVersion && (!key || policy.allowedProviderIds.includes(key.providerId)) && (!keyHash || keyHash === digest(key));
  }
  private attemptRow(scope: MerchantScope, identity: string): AttemptRow | undefined {
    return this.db.prepare('SELECT * FROM merchant_research_attempts WHERE scope_key=? AND id=?').get(scopeKey(scope), identity) as AttemptRow | undefined;
  }
  private attemptValue(row: AttemptRow, scope: MerchantScope): MerchantResearchAttempt {
    const outcome = row.outcome === null ? null : storedOutcomeSchema.parse(JSON.parse(row.outcome));
    return { id: row.id, scope: { ...scope }, phase: row.phase, generation: row.generation, policyVersion: row.policy_version, reservedCostAtoms: row.reserved_atoms, settledCostAtoms: row.settled_atoms, billingCurrency: row.billing_currency, tariffVersion: row.tariff_version, createdAt: row.created_at, leaseExpiresAt: row.lease_expires_at, dispatchedAt: row.dispatched_at, invocationEvidence: outcome !== null && 'workerEvidence' in outcome && outcome.workerEvidence === 'not_invoked' ? 'not_invoked' : null, claimToken: row.claim_token, visibility: visibilitySchema.parse(JSON.parse(row.visibility)), sourceRefs: refsSchema.parse(JSON.parse(row.source_refs)) };
  }
  private admittedAttempt(input: MerchantViewAccess, row: AttemptRow): boolean {
    return this.permitted(input, refsSchema.parse(JSON.parse(row.source_refs)), visibilitySchema.parse(JSON.parse(row.visibility))) && row.generation === input.expectedGeneration && row.content_deleted === 0;
  }
  private reconcile(now: string): void {
    // A durable dispatch marker is the billing boundary; expired unsent work cannot retain quota.
    this.db.prepare("UPDATE merchant_research_attempts SET phase='known_failed',settled_atoms='0',claim_token=NULL,outcome=? WHERE phase='reserved' AND dispatched_at IS NULL AND lease_expires_at<=?").run(JSON.stringify({ phase: 'known_failed', costAtoms: '0', providerEvidence: 'not_billed' }), new Date(now).toISOString());
    this.db.prepare("UPDATE merchant_research_attempts SET phase='uncertain' WHERE phase='dispatched' AND lease_expires_at<=?").run(new Date(now).toISOString());
  }
  private cancel(scope: MerchantScope): void {
    this.db.prepare("UPDATE merchant_research_attempts SET phase='known_failed',settled_atoms='0',claim_token=NULL,outcome=? WHERE scope_key=? AND phase='reserved'").run(JSON.stringify({ phase: 'known_failed', costAtoms: '0', providerEvidence: 'not_billed' }), scopeKey(scope));
  }

  generation(scope: MerchantScope): number { scopeSchema.parse(scope); return this.scope(scope)?.generation ?? 0; }

  decisions(input: MerchantViewAccess & { kind?: 'alias' | 'pattern'; cursor?: string; limit: number }): { records: MerchantDecision[]; nextCursor: string | null } {
    validateAccess(input, true); z.number().int().min(1).max(1000).parse(input.limit); if (input.kind !== undefined) z.enum(['alias', 'pattern']).parse(input.kind); if (input.cursor !== undefined) id.parse(input.cursor);
    return this.transaction(() => {
      const rows = this.db.prepare('SELECT value FROM merchant_decisions WHERE scope_key=? AND visibility_hash=? AND id>? AND (? IS NULL OR kind=?) ORDER BY id').all(scopeKey(input.scope), input.visibility.hash, input.cursor ?? '', input.kind ?? null, input.kind ?? null) as ValueRow[];
      const records: MerchantDecision[] = [];
      for (const row of rows) {
        const value = decisionSchema.parse(JSON.parse(row.value));
        if (!this.permitted(input, value.sourceRefs, value.visibility)) return { records: [], nextCursor: null };
        if (value.generation === input.expectedGeneration) records.push(value);
        if (records.length > input.limit) break;
      }
      const more = records.length > input.limit;
      if (more) records.pop();
      return { records, nextCursor: more ? records.at(-1)?.id ?? null : null };
    });
  }

  decide(input: MerchantViewAccess & { id: string; payload: MerchantDecisionPayload; state: MerchantDecision['state']; sourceRefs: MerchantSourceRefs; expectedVersion: number }): MerchantDecision | null {
    validateAccess(input, true); id.parse(input.id); payloadSchema.parse(input.payload); refsSchema.parse(input.sourceRefs); count.parse(input.expectedVersion); z.enum(['accepted', 'rejected', 'revoked']).parse(input.state);
    if (input.payload.kind === 'alias' && (input.payload.sourceTransactionIds.some((identity) => !input.sourceRefs.transactionIds.includes(identity)) || (input.payload.accountId !== null && !input.sourceRefs.accountIds.includes(input.payload.accountId)))) throw new Error('Alias source identities must be complete dependencies');
    return this.transaction(() => {
      if (!this.permitted(input, input.sourceRefs, input.visibility)) return null;
      const row = this.db.prepare('SELECT value FROM merchant_decisions WHERE scope_key=? AND visibility_hash=? AND id=?').get(scopeKey(input.scope), input.visibility.hash, input.id) as ValueRow | undefined;
      const previous = row ? decisionSchema.parse(JSON.parse(row.value)) : null;
      if ((previous?.version ?? 0) !== input.expectedVersion || (previous && !this.authorize(input, previous.sourceRefs, previous.visibility))) return null;
      this.ensure(input.scope);
      const value: MerchantDecision = { id: input.id, scope: input.scope, payload: input.payload, state: input.state, actorId: input.actorId, version: input.expectedVersion + 1, updatedAt: input.now, generation: input.expectedGeneration, visibility: input.visibility, sourceRefs: input.sourceRefs };
      this.db.prepare('INSERT INTO merchant_decisions VALUES (?,?,?,?,?,?) ON CONFLICT(scope_key,visibility_hash,id) DO UPDATE SET kind=excluded.kind,updated_at=excluded.updated_at,value=excluded.value').run(scopeKey(input.scope), input.visibility.hash, input.id, input.payload.kind, input.now, JSON.stringify(value));
      return structuredClone(value);
    });
  }

  policy(input: MerchantAccess): MerchantPolicy | null {
    validateAccess(input);
    return this.transaction(() => this.permitted(input) ? this.policyValue(input.scope) : null);
  }

  setPolicy(input: MerchantAccess & { value: MerchantPolicyValue; expectedVersion: number }): MerchantPolicy | null {
    validateAccess(input); const value = merchantPolicyValueSchema.parse(input.value); count.parse(input.expectedVersion);
    return this.transaction(() => {
      if (!this.permitted(input) || (this.policyValue(input.scope)?.version ?? 0) !== input.expectedVersion) return null;
      this.ensure(input.scope);
      this.db.prepare('UPDATE merchant_scope_generations SET generation=generation+1 WHERE scope_key=?').run(scopeKey(input.scope));
      this.cancel(input.scope);
      const policy: MerchantPolicy = { ...value, scope: input.scope, version: input.expectedVersion + 1, generation: input.expectedGeneration + 1, updatedAt: input.now };
      this.db.prepare('INSERT INTO merchant_policies VALUES (?,?) ON CONFLICT(scope_key) DO UPDATE SET value=excluded.value').run(scopeKey(input.scope), JSON.stringify(policy));
      // Confirmed decisions survive consent changes; their authority is still checked on every read.
      const decisions = this.db.prepare('SELECT visibility_hash,id,value FROM merchant_decisions WHERE scope_key=?').all(scopeKey(input.scope)) as (ValueRow & { visibility_hash: string; id: string })[];
      for (const decision of decisions) { const content = decisionSchema.parse(JSON.parse(decision.value)); content.generation = policy.generation; this.db.prepare('UPDATE merchant_decisions SET value=? WHERE scope_key=? AND visibility_hash=? AND id=?').run(JSON.stringify(content), scopeKey(input.scope), decision.visibility_hash, decision.id); }
      return policy;
    });
  }

  evidence(input: MerchantViewAccess & { key: string }): MerchantEvidence | null {
    validateAccess(input, true); id.parse(input.key);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT value FROM merchant_evidence WHERE scope_key=? AND visibility_hash=? AND evidence_key=?').get(scopeKey(input.scope), input.visibility.hash, input.key) as ValueRow | undefined;
      if (!row) return null;
      const value = evidenceSchema.parse(JSON.parse(row.value));
      return this.permitted(input, value.sourceRefs, value.visibility) && value.generation === input.expectedGeneration && active(value.expiresAt, input.now) && value.policyVersion === (this.policyValue(input.scope)?.version ?? 0) ? value : null;
    });
  }

  putEvidence(input: MerchantViewAccess & { value: Omit<MerchantEvidence, 'scope' | 'generation'>; expectedRevision: string | null }): MerchantEvidence | null {
    validateAccess(input, true); const proposed = evidenceValueSchema.parse(input.value); hash.nullable().parse(input.expectedRevision);
    if (!same(proposed.visibility, input.visibility) || proposed.factsHash !== proposed.sourceRefs.factsHash || !active(proposed.expiresAt, proposed.capturedAt)) throw new Error('Inconsistent evidence provenance');
    return this.transaction(() => {
      if (!this.permitted(input, proposed.sourceRefs, proposed.visibility) || !active(proposed.expiresAt, input.now) || proposed.policyVersion !== (this.policyValue(input.scope)?.version ?? 0)) return null;
      const row = this.db.prepare('SELECT value FROM merchant_evidence WHERE scope_key=? AND visibility_hash=? AND evidence_key=?').get(scopeKey(input.scope), input.visibility.hash, proposed.key) as ValueRow | undefined;
      const previous = row ? evidenceSchema.parse(JSON.parse(row.value)) : null;
      if ((previous?.revision ?? null) !== input.expectedRevision) return null;
      if (previous?.revision === proposed.revision && !same(evidenceFactsSchema.parse(previous), evidenceFactsSchema.parse(proposed)))
        throw new Error('Changed evidence facts require a new revision');
      this.ensure(input.scope);
      const value: MerchantEvidence = { ...proposed, scope: input.scope, generation: input.expectedGeneration };
      this.db.prepare('INSERT INTO merchant_evidence VALUES (?,?,?,?,?,?) ON CONFLICT(scope_key,visibility_hash,evidence_key) DO UPDATE SET expires_at=excluded.expires_at,captured_at=excluded.captured_at,value=excluded.value').run(scopeKey(input.scope), input.visibility.hash, value.key, new Date(value.expiresAt).toISOString(), new Date(value.capturedAt).toISOString(), JSON.stringify(value));
      return value;
    });
  }

  cache(input: MerchantViewAccess & { key: MerchantCacheKey }): MerchantEnrichment | null {
    validateAccess(input, true); keySchema.parse(input.key);
    if (!same(input.key.scope, input.scope) || input.key.visibilityHash !== input.visibility.hash) return null;
    return this.transaction(() => {
      const row = this.db.prepare('SELECT value FROM merchant_enrichment_cache WHERE scope_key=? AND key_hash=?').get(scopeKey(input.scope), digest(input.key)) as ValueRow | undefined;
      if (!row) return null;
      const value = merchantEnrichmentSchema.parse(JSON.parse(row.value));
      return this.permitted(input, value.sourceRefs, value.visibility) && value.generation === input.expectedGeneration && this.external(input.scope, value.policyVersion, undefined, input.key) && active(value.expiresAt, input.now) ? value : null;
    });
  }

  putCache(input: MerchantViewAccess & { attemptId: string; claimToken: string; value: Omit<MerchantEnrichment, 'generation'> }): MerchantEnrichment | null {
    validateAccess(input, true); id.parse(input.attemptId); id.parse(input.claimToken); const proposed = enrichmentValueSchema.parse(input.value);
    if (!same(proposed.key.scope, input.scope) || !same(proposed.visibility, input.visibility) || proposed.key.visibilityHash !== input.visibility.hash || !active(proposed.expiresAt, proposed.retrievedAt)) throw new Error('Inconsistent cache provenance');
    return this.transaction(() => {
      if (!this.permitted(input, proposed.sourceRefs, proposed.visibility)) return null;
      const row = this.attemptRow(input.scope, input.attemptId);
      const policy = this.policyValue(input.scope);
      if (!row || row.content_deleted || row.generation !== input.expectedGeneration || row.phase !== 'dispatched' || row.claim_token !== input.claimToken || !active(row.lease_expires_at, input.now) || !this.external(input.scope, proposed.policyVersion, row.key_hash, proposed.key) || row.policy_version !== proposed.policyVersion || !same(visibilitySchema.parse(JSON.parse(row.visibility)), proposed.visibility) || !same(refsSchema.parse(JSON.parse(row.source_refs)), proposed.sourceRefs) || !active(proposed.expiresAt, input.now) || !policy || Date.parse(proposed.expiresAt) - Date.parse(proposed.retrievedAt) > policy.cacheTtlHours * 3600000 || Date.parse(proposed.retrievedAt) > Date.parse(input.now)) return null;
      const existing = this.db.prepare('SELECT value,attempt_id FROM merchant_enrichment_cache WHERE scope_key=? AND key_hash=?').get(scopeKey(input.scope), row.key_hash) as (ValueRow & { attempt_id: string }) | undefined;
      const value: MerchantEnrichment = { ...proposed, generation: input.expectedGeneration };
      if (existing?.attempt_id === row.id) return same(merchantEnrichmentSchema.parse(JSON.parse(existing.value)), value) ? merchantEnrichmentSchema.parse(JSON.parse(existing.value)) : null;
      this.db.prepare('INSERT INTO merchant_enrichment_cache VALUES (?,?,?,?,?,?) ON CONFLICT(scope_key,key_hash) DO UPDATE SET attempt_id=excluded.attempt_id,expires_at=excluded.expires_at,retrieved_at=excluded.retrieved_at,value=excluded.value').run(scopeKey(input.scope), row.key_hash, row.id, new Date(proposed.expiresAt).toISOString(), new Date(proposed.retrievedAt).toISOString(), JSON.stringify(value));
      return value;
    });
  }

  reserveAttempt(input: MerchantViewAccess & { idempotencyKey: string; key: MerchantCacheKey; sourceRefs: MerchantSourceRefs; policyVersion: number; tariff: MerchantTariff | null; buckets: MerchantQuotaBucket[] }): MerchantAttemptAdmission {
    validateAccess(input, true); id.parse(input.idempotencyKey); const key = keySchema.parse(input.key); refsSchema.parse(input.sourceRefs); count.parse(input.policyVersion); const tariff = tariffSchema.nullable().parse(input.tariff); const buckets = bucketListSchema.min(4).max(1000).parse(input.buckets);
    if (!same(key.scope, input.scope) || key.visibilityHash !== input.visibility.hash) throw new Error('Research cache identity is outside its scope');
    const identities = buckets.map((bucket) => JSON.stringify([bucket.kind, bucket.id]));
    if (new Set(identities).size !== buckets.length || ['installation', 'space', 'budget', 'credential'].some((kind) => buckets.filter((bucket) => bucket.kind === kind).length !== 1) || buckets.find((bucket) => bucket.kind === 'space')?.id !== input.scope.spaceId || buckets.find((bucket) => bucket.kind === 'budget')?.id !== `${input.scope.spaceId}/${input.scope.budgetId}`) throw new Error('Incomplete or inconsistent research quota buckets');
    const intent = digest({ key, sourceRefs: input.sourceRefs, visibility: input.visibility, generation: input.expectedGeneration, policyVersion: input.policyVersion, tariff, buckets: [...buckets].sort((a, b) => `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`)) });
    return this.transaction<MerchantAttemptAdmission>(() => {
      if (!this.authorize(input, input.sourceRefs, input.visibility) || (input.visibility.privateActorId !== null && input.visibility.privateActorId !== input.actorId)) return { status: 'denied', reason: 'unauthorized' };
      const state = this.scope(input.scope);
      if (input.expectedGeneration !== (state?.generation ?? 0)) return { status: 'denied', reason: 'stale_generation' };
      const global = this.db.prepare("SELECT * FROM merchant_scope_generations WHERE scope_key=''").get() as ScopeRow | undefined;
      if (state?.restore_pending ?? global?.restore_pending) return { status: 'denied', reason: 'restore_pending' };
      const policy = this.policyValue(input.scope);
      if (!this.external(input.scope, input.policyVersion, undefined, key) || !policy) return { status: 'denied', reason: 'policy' };
      if ((state?.billing_unresolved ?? global?.billing_unresolved) || ((state?.billing_hold_until ?? global?.billing_hold_until) && active((state?.billing_hold_until ?? global?.billing_hold_until)!, input.now))) return { status: 'denied', reason: 'restore_billing_hold' };
      if (!tariff) return { status: 'denied', reason: 'unknown_pricing' };
      if (tariff.billingCurrency !== policy.billingCurrency) return { status: 'denied', reason: 'policy' };
      const original = this.db.prepare('SELECT * FROM merchant_research_attempts WHERE scope_key=? AND idempotency_hash=?').get(scopeKey(input.scope), digest(input.idempotencyKey)) as AttemptRow | undefined;
      if (original?.content_deleted) return { status: 'denied', reason: 'unauthorized' };
      if (original && original.intent_hash !== intent) throw new Error('Merchant idempotency intent conflict');
      this.reconcile(input.now);
      if (original) {
        const current = this.attemptRow(input.scope, original.id)!;
        if (!this.admittedAttempt(input, current)) return { status: 'denied', reason: 'unauthorized' };
        return { status: 'admitted', attempt: this.attemptValue(current, input.scope) };
      }
      const pending = this.db.prepare("SELECT * FROM merchant_research_attempts WHERE scope_key=? AND key_hash=? AND generation=? AND phase IN ('reserved','dispatched') AND lease_expires_at>? ORDER BY created_at LIMIT 1").get(scopeKey(input.scope), digest(key), input.expectedGeneration, new Date(input.now).toISOString()) as AttemptRow | undefined;
      if (pending) {
        if (!this.admittedAttempt(input, pending)) return { status: 'denied', reason: 'unauthorized' };
        return { status: 'pending', attempt: this.attemptValue(pending, input.scope) };
      }
      const day = input.now.slice(0, 10); const month = input.now.slice(0, 7);
      // Exact persisted reservations are the ledger; no lossy SQL SUM/REAL conversion.
      const rows = this.db.prepare("SELECT * FROM merchant_research_attempts WHERE (day_window=? OR month_window=?) AND phase!='known_failed'").all(day, month) as AttemptRow[];
      const ledger = rows.map((row) => ({ row, buckets: bucketListSchema.parse(JSON.parse(row.buckets)) }));
      const constrained = buckets.map((bucket) => bucket.kind === 'budget' ? { ...bucket, maxSearchesPerDay: Math.min(bucket.maxSearchesPerDay, policy.maxSearchesPerDay), maxSpendMinorUnitsPerMonth: Math.min(bucket.maxSpendMinorUnitsPerMonth, policy.maxSpendMinorUnitsPerMonth) } : bucket);
      for (const bucket of constrained) {
        let daily = 0; let monthly = 0n;
        for (const { row, buckets: storedBuckets } of ledger) {
          if (!storedBuckets.some((stored) => stored.kind === bucket.kind && stored.id === bucket.id)) continue;
          if (row.day_window === day) daily++;
          if (row.month_window === month) {
            if (row.billing_currency !== tariff.billingCurrency) return { status: 'denied', reason: 'policy' };
            monthly += BigInt(row.settled_atoms ?? row.reserved_atoms);
          }
        }
        if (daily >= bucket.maxSearchesPerDay) return { status: 'denied', reason: 'daily_cap' };
        if (monthly + BigInt(tariff.costAtoms) > BigInt(bucket.maxSpendMinorUnitsPerMonth) * 1000000n) return { status: 'denied', reason: 'monthly_cap' };
      }
      this.ensure(input.scope);
      const attemptId = randomUUID();
      this.db.prepare(`INSERT INTO merchant_research_attempts(id,scope_key,idempotency_hash,intent_hash,key_hash,generation,policy_version,phase,reserved_atoms,billing_currency,tariff_version,created_at,lease_expires_at,visibility,source_refs,buckets,day_window,month_window) VALUES (?,?,?,?,?,?,?,'reserved',?,?,?,?,?,?,?,?,?,?)`).run(attemptId, scopeKey(input.scope), digest(input.idempotencyKey), intent, digest(key), input.expectedGeneration, input.policyVersion, tariff.costAtoms, tariff.billingCurrency, tariff.version, new Date(input.now).toISOString(), lease(input.now), JSON.stringify(input.visibility), JSON.stringify(input.sourceRefs), JSON.stringify(buckets), day, month);
      return { status: 'admitted', attempt: this.attemptValue(this.attemptRow(input.scope, attemptId)!, input.scope) };
    });
  }

  attempt(input: MerchantViewAccess & { id: string }): MerchantResearchAttempt | null {
    validateAccess(input, true); id.parse(input.id);
    return this.transaction(() => {
      const row = this.attemptRow(input.scope, input.id);
      if (!row || !this.permitted(input, refsSchema.parse(JSON.parse(row.source_refs)), visibilitySchema.parse(JSON.parse(row.visibility))) || row.generation !== input.expectedGeneration || row.content_deleted) return null;
      this.reconcile(input.now);
      return this.attemptValue(this.attemptRow(input.scope, input.id)!, input.scope);
    });
  }

  claimAttempt(input: MerchantViewAccess & { id: string }): MerchantResearchAttempt | null {
    validateAccess(input, true); id.parse(input.id);
    return this.transaction(() => {
      const row = this.attemptRow(input.scope, input.id);
      if (!row || !this.admittedAttempt(input, row)) return null;
      this.reconcile(input.now);
      if (row.phase !== 'reserved' || !active(row.lease_expires_at, input.now) || row.claim_token !== null || !this.external(input.scope, row.policy_version)) return null;
      this.db.prepare('UPDATE merchant_research_attempts SET claim_token=?,lease_expires_at=? WHERE id=?').run(randomUUID(), lease(input.now), row.id);
      return this.attemptValue(this.attemptRow(input.scope, row.id)!, input.scope);
    });
  }

  dispatchAttempt(input: MerchantViewAccess & { id: string; claimToken: string }): boolean {
    validateAccess(input, true); id.parse(input.id); id.parse(input.claimToken);
    return this.transaction(() => {
      const row = this.attemptRow(input.scope, input.id);
      if (!row || !this.admittedAttempt(input, row)) return false;
      this.reconcile(input.now);
      if (row.phase !== 'reserved' || row.claim_token !== input.claimToken || !active(row.lease_expires_at, input.now) || !this.external(input.scope, row.policy_version) ||
        row.day_window !== input.now.slice(0,10) || row.month_window !== input.now.slice(0,7)) return false;
      const buckets = bucketListSchema.parse(JSON.parse(row.buckets));
      const controlling = buckets.filter((bucket) => bucket.kind === 'installation' || bucket.kind === 'credential');
      // Deletion changes phase, not whether an unsettled owner may still be executing.
      const running = this.db.prepare("SELECT buckets FROM merchant_research_attempts WHERE lease_expires_at>? AND (phase='dispatched' OR (phase='uncertain' AND outcome IS NULL))").all(new Date(input.now).toISOString()) as { buckets: string }[];
      for (const bucket of controlling) if (running.filter((other) => bucketListSchema.parse(JSON.parse(other.buckets)).some((item) => item.kind === bucket.kind && item.id === bucket.id)).length >= 2) return false;
      const credential = buckets.find((bucket) => bucket.kind === 'credential')!;
      const launches = this.db.prepare('SELECT dispatched_at,buckets FROM merchant_research_attempts WHERE dispatched_at>?').all(new Date(Date.parse(input.now) - 1000).toISOString()) as { dispatched_at: string; buckets: string }[];
      if (launches.some((other) => bucketListSchema.parse(JSON.parse(other.buckets)).some((item) => item.kind === 'credential' && item.id === credential.id))) return false;
      this.db.prepare("UPDATE merchant_research_attempts SET phase='dispatched',dispatched_at=? WHERE id=?").run(new Date(input.now).toISOString(), row.id);
      return true;
    });
  }

  /** Release proven-unsent work under current authority; a live claimed reservation requires its owner token. */
  abandonAttempt(input: MerchantViewAccess & { id: string; claimToken?: string }): boolean {
    validateAccess(input, true); id.parse(input.id);
    return this.transaction(() => {
      const row = this.attemptRow(input.scope, input.id);
      if (!row || !this.admittedAttempt(input, row) || row.phase !== 'reserved' || row.dispatched_at !== null ||
        (input.claimToken !== undefined ? row.claim_token !== input.claimToken : row.claim_token !== null && active(row.lease_expires_at, input.now))) return false;
      this.db.prepare("UPDATE merchant_research_attempts SET phase='known_failed',settled_atoms='0',claim_token=NULL,outcome=? WHERE id=?").run(JSON.stringify({ phase: 'known_failed', costAtoms: '0', providerEvidence: 'not_billed' }), row.id);
      return true;
    });
  }

  /** Only the trusted owning worker, before invoking its provider, may attest proven-unsent cleanup. */
  releaseUnsentAttempt(input: MerchantAttemptOwner): boolean {
    attemptOwnerSchema.parse(input);
    return this.transaction(() => {
      const row = this.attemptRow(input.scope, input.id);
      if (!row || row.generation !== input.expectedGeneration || row.claim_token !== input.claimToken ||
        !active(row.lease_expires_at, input.now) || (row.phase !== 'reserved' && row.phase !== 'dispatched' && row.phase !== 'uncertain') ||
        (row.outcome !== null && outcomeSchema.parse(JSON.parse(row.outcome)).phase !== 'uncertain')) return false;
      this.db.prepare("UPDATE merchant_research_attempts SET phase='known_failed',settled_atoms='0',claim_token=NULL,outcome=? WHERE id=?")
        .run(JSON.stringify({ phase: 'known_failed', costAtoms: '0', providerEvidence: 'not_billed', workerEvidence: 'not_invoked' }), row.id);
      return true;
    });
  }

  settleAttempt(input: MerchantViewAccess & { id: string; claimToken: string; outcome: MerchantAttemptOutcome }): boolean {
    validateAccess(input, true); id.parse(input.id); id.parse(input.claimToken); const outcome = outcomeSchema.parse(input.outcome);
    return this.transaction(() => {
      const row = this.attemptRow(input.scope, input.id);
      if (!row || !this.admittedAttempt(input, row) || row.claim_token !== input.claimToken || row.dispatched_at === null) return false;
      if (outcome.phase === 'succeeded' && BigInt(outcome.costAtoms) > BigInt(row.reserved_atoms)) throw new Error('Settlement exceeds reserved atoms');
      if (row.outcome !== null) return same(outcomeSchema.parse(JSON.parse(row.outcome)), outcome);
      if (row.phase !== 'dispatched' && row.phase !== 'uncertain') return false;
      this.db.prepare('UPDATE merchant_research_attempts SET phase=?,settled_atoms=?,outcome=? WHERE id=?').run(outcome.phase, outcome.phase === 'uncertain' ? null : outcome.costAtoms, JSON.stringify(outcome), row.id);
      return true;
    });
  }

  purge(input: MerchantAccess): number {
    validateAccess(input);
    return this.transaction(() => {
      if (!this.permitted(input, EMPTY_REFS, null, true)) return this.scope(input.scope)?.generation ?? 0;
      this.ensure(input.scope);
      this.db.prepare('UPDATE merchant_scope_generations SET generation=generation+1 WHERE scope_key=?').run(scopeKey(input.scope));
      this.erase(input.scope);
      redactMerchantDerivedCopies(this.db, input.scope);
      return input.expectedGeneration + 1;
    });
  }
  /** Atomically purge and fence all selected space/budget connections, preserving billing and financial audit. */
  purgeBudget(input: MerchantAccess): number {
    validateAccess(input);
    return this.transaction(() => {
      if (!this.permitted(input, EMPTY_REFS, null, true)) return this.scope(input.scope)?.generation ?? 0;
      this.ensure(input.scope);
      const connections = this.db.prepare('SELECT connection_id FROM merchant_scope_generations WHERE space_id=? AND budget_id=?')
        .all(input.scope.spaceId, input.scope.budgetId) as Array<{ connection_id: string }>;
      this.db.prepare('UPDATE merchant_scope_generations SET generation=generation+1 WHERE space_id=? AND budget_id=?')
        .run(input.scope.spaceId, input.scope.budgetId);
      for (const { connection_id } of connections) this.erase({ ...input.scope, connectionId: connection_id });
      redactMerchantDerivedCopies(this.db, { spaceId: input.scope.spaceId, budgetId: input.scope.budgetId });
      return input.expectedGeneration + 1;
    });
  }
  private erase(scope: MerchantScope): void {
    const key = scopeKey(scope);
    for (const table of ['merchant_decisions', 'merchant_evidence', 'merchant_enrichment_cache']) this.db.prepare(`DELETE FROM ${table} WHERE scope_key=?`).run(key);
    this.cancel(scope);
    this.db.prepare("UPDATE merchant_research_attempts SET phase=CASE WHEN phase='dispatched' THEN 'uncertain' ELSE phase END,source_refs=?,visibility=?,key_hash=?,intent_hash=?,claim_token=CASE WHEN phase IN ('dispatched','uncertain') THEN claim_token ELSE NULL END,content_deleted=1 WHERE scope_key=?").run(JSON.stringify(EMPTY_REFS), JSON.stringify({ hash: '0'.repeat(64), privateActorId: null }), '0'.repeat(64), '0'.repeat(64), key);
  }

  prune(input: { now: string }): void {
    timestamp.parse(input.now);
    this.transaction(() => {
      this.reconcile(input.now);
      const operational = new Date(Date.parse(input.now) - 30 * 86400000).toISOString();
      const billing = new Date(Date.parse(input.now) - 90 * 86400000).toISOString();
      this.db.prepare('DELETE FROM merchant_evidence WHERE expires_at<=? OR captured_at<=?').run(new Date(input.now).toISOString(), operational);
      this.db.prepare('DELETE FROM merchant_enrichment_cache WHERE expires_at<=? OR retrieved_at<=?').run(new Date(input.now).toISOString(), operational);
      this.db.prepare("UPDATE merchant_research_attempts SET visibility=?,key_hash=?,intent_hash=?,content_deleted=1 WHERE created_at<=?").run(JSON.stringify({ hash: '0'.repeat(64), privateActorId: null }), '0'.repeat(64), '0'.repeat(64), operational);
      this.db.prepare('UPDATE merchant_research_attempts SET source_refs=? WHERE created_at<=?').run(JSON.stringify(EMPTY_REFS), operational);
      this.db.prepare("DELETE FROM merchant_research_attempts WHERE created_at<=? AND phase IN ('succeeded','known_failed')").run(billing);
      redactMerchantDerivedCopies(this.db, { now: input.now });
    });
  }

  acknowledgeRestore(input: MerchantAccess & { actorId: string }): boolean {
    validateAccess(input); id.parse(input.actorId);
    return this.transaction(() => {
      if (!this.permitted(input, EMPTY_REFS, null, true)) return false;
      this.ensure(input.scope);
      if (!this.scope(input.scope)?.restore_pending) return false;
      this.db.prepare('UPDATE merchant_scope_generations SET restore_pending=0 WHERE scope_key=?').run(scopeKey(input.scope));
      return true;
    });
  }
}

/** Reconcile only inside the authorized restore transaction, before the copy is exposed. */
export function reconcileMerchantRestore(db: Database, now: string): void {
  timestamp.parse(now);
  const unresolvedRow = db.prepare("SELECT COUNT(*) AS count FROM merchant_research_attempts WHERE phase IN ('dispatched','uncertain')").get() as { count: number };
  const unresolved = unresolvedRow.count > 0;
  const instant = new Date(now);
  const hold = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + 1, 1)).toISOString();
  // This marker quarantines a copy; it is NOT a rollback-proof watermark. Missing later billing
  // is held through its UTC windows, and unresolved sent charges require outside-ledger proof.
  db.prepare("INSERT INTO merchant_scope_generations(scope_key,space_id,budget_id,connection_id,restore_pending,billing_hold_until,billing_unresolved) VALUES ('','','','',1,?,?) ON CONFLICT(scope_key) DO UPDATE SET restore_pending=1,billing_hold_until=excluded.billing_hold_until,billing_unresolved=excluded.billing_unresolved").run(hold, unresolved ? 1 : 0);
  db.prepare("UPDATE merchant_scope_generations SET generation=generation+1,restore_pending=1,billing_hold_until=?,billing_unresolved=? WHERE scope_key!=''").run(hold, unresolved ? 1 : 0);
  db.exec('DELETE FROM merchant_decisions; DELETE FROM merchant_evidence; DELETE FROM merchant_enrichment_cache;');
  db.prepare("UPDATE merchant_research_attempts SET phase='known_failed',settled_atoms='0',claim_token=NULL,outcome=? WHERE phase='reserved'").run(JSON.stringify({ phase: 'known_failed', costAtoms: '0', providerEvidence: 'not_billed' }));
  db.prepare("UPDATE merchant_research_attempts SET phase=CASE WHEN phase='dispatched' THEN 'uncertain' ELSE phase END,source_refs=?,visibility=?,key_hash=?,intent_hash=?,claim_token=NULL,content_deleted=1").run(JSON.stringify(EMPTY_REFS), JSON.stringify({ hash: '0'.repeat(64), privateActorId: null }), '0'.repeat(64), '0'.repeat(64));
  const policies = db.prepare('SELECT scope_key,value FROM merchant_policies').all() as (ValueRow & { scope_key: string })[];
  for (const row of policies) {
    const policy = policySchema.parse(JSON.parse(row.value));
    policy.mode = 'local-only'; policy.generation++; policy.updatedAt = now;
    db.prepare('UPDATE merchant_policies SET value=? WHERE scope_key=?').run(JSON.stringify(policy), row.scope_key);
  }
  redactMerchantDerivedCopies(db);
}

/** Remove derived merchant projections without touching exact proposal/execution intents. */
export function redactMerchantDerivedCopies(db: Database, options: Partial<MerchantScope> & { actorId?: string; now?: string } = {}): number {
  const keys: Record<string, true> = { merchantDerivation: true, merchantProof: true, merchantEvidence: true, merchantAnalysis: true, merchantIntelligence: true, merchantEnrichment: true, merchantResearch: true, merchantRecurrences: true, merchantSuggestions: true };
  const instant = options.now === undefined ? undefined : Date.parse(timestamp.parse(options.now));
  function redact(value: unknown, inherited?: MerchantDerivation, derived = false, target = false, inheritedScope?: MerchantScope): { value: unknown; retained: boolean } {
    if (Array.isArray(value)) {
      const children = value.map((child) => redact(child, inherited, derived, false, inheritedScope));
      return { value: children.filter((child) => child.value !== undefined).map((child) => child.value), retained: children.some((child) => child.retained) };
    }
    if (value === null || typeof value !== 'object') return { value, retained: false };
    const record = value as Record<string, unknown>;
    const ownMarker = Object.hasOwn(record, 'merchantDerivation');
    const parsed = ownMarker ? merchantDerivationSchema.safeParse(record.merchantDerivation) : undefined;
    const marker = ownMarker ? (parsed?.success ? parsed.data : undefined) : inherited;
    const proof = record.merchantProof as { reviewContext?: { scope?: unknown } } | undefined;
    const legacyScope = marker === undefined && proof?.reviewContext?.scope !== undefined ? scopeSchema.safeParse(proof.reviewContext.scope) : undefined;
    const scope = marker?.scope ?? (legacyScope?.success ? legacyScope.data : inheritedScope);
    const selected = (options.actorId === undefined || marker === undefined || marker.privateActorId === options.actorId) &&
      (options.spaceId === undefined || scope === undefined || scope.spaceId === options.spaceId) &&
      (options.budgetId === undefined || scope === undefined || scope.budgetId === options.budgetId) &&
      (options.connectionId === undefined || scope === undefined || scope.connectionId === options.connectionId) &&
      (instant === undefined || marker === undefined || Date.parse(marker.expiresAt) <= instant || Date.parse(marker.capturedAt) <= instant - 30 * 86400000);
    const cleaned: Record<string, unknown> = {};
    let retained = !selected;
    const merchantRevision = target || Object.keys(record).some((key) => keys[key] === true);
    for (const [key, child] of Object.entries(record)) {
      const nested = redact(child, marker, derived || keys[key] === true, false, scope);
      if (selected && (((derived || keys[key] === true) && !nested.retained) || (merchantRevision && key === 'sourceRevision'))) continue;
      cleaned[key] = nested.value;
      retained ||= nested.retained;
    }
    return { value: derived && selected && !retained ? undefined : cleaned, retained };
  }
  let changed = 0;
  const tables: { table: string; columns: string[] }[] = [
    { table: 'suggestions', columns: ['payload'] },
    { table: 'review_items', columns: ['evidence', 'provenance'] },
    { table: 'findings', columns: ['evidence'] },
    { table: 'notification_events', columns: ['payload'] },
    { table: 'report_records', columns: ['config'] },
  ];
  for (const { table, columns } of tables) {
    const merchantColumns = columns.map((column) => `${column} LIKE '%"merchant%'`).join(' OR ');
    const rows = db.prepare(`SELECT id,${columns.join(',')}${table === 'review_items' ? ',classifier' : ''} FROM ${table}
      WHERE (${merchantColumns}${table === 'review_items' ? " OR classifier='merchant'" : ''})${options.budgetId === undefined ? '' : ' AND budget_id=?'}`)
      .all(...(options.budgetId === undefined ? [] : [options.budgetId])) as Record<string, unknown>[];
    for (const row of rows) for (const column of columns) {
      if (typeof row[column] !== 'string') continue;
      let value: unknown; try { value = JSON.parse(row[column]); } catch { continue; }
      const target = table === 'review_items' && column === 'evidence' && row.classifier === 'merchant';
      const cleaned = redact(value, undefined, false, target).value;
      if (same(value, cleaned)) continue;
      changed += db.prepare(`UPDATE ${table} SET ${column}=? WHERE id=?`).run(JSON.stringify(cleaned), row.id as string).changes;
      if (target && value !== null && typeof value === 'object' && cleaned !== null && typeof cleaned === 'object') {
        const before = value as Record<string, unknown>, after = cleaned as Record<string, unknown>;
        const removedTarget = before.merchantProof !== undefined ? after.merchantProof === undefined :
          ['merchantDerivation', 'merchantEvidence', 'sourceRevision'].some((key) => Object.hasOwn(before, key) && !Object.hasOwn(after, key));
        if (removedTarget) changed += db.prepare(`UPDATE review_items SET category_id='',status='superseded',
          superseded_reason='merchant_derived_content_deleted',superseded_by=NULL,version=version+1
          WHERE id=? AND classifier='merchant' AND status IN ('discovered','suggestion_generated','pending_review')`).run(row.id as string).changes;
      }
    }
  }
  return changed;
}
