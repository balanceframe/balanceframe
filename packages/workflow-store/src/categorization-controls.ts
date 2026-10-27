import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';

const id = z.string().min(1).max(256);
const unsignedMinor = z.string().max(19).regex(/^(0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const currency = z.string().regex(/^[A-Z]{3}$/);
const capSchema = z.object({
  window: z.enum(['day', 'week', 'month']),
  maxOperations: z.number().int().min(0).max(1_000_000),
  maxMagnitude: z.array(z.object({ currency, minorUnits: unsignedMinor }).strict()).min(1).max(100)
    .refine((values) => new Set(values.map((value) => value.currency)).size === values.length),
}).strict();
/** Calendar caps bound categorization magnitude without changing existing outgoing-only grants. */
export const categorizationControlPolicySchema = z.object({
  enabled: z.boolean(), stopped: z.boolean(),
  cooldownSeconds: z.number().int().min(0).max(86_400),
  caps: z.array(capSchema).max(3)
    .refine((values) => new Set(values.map((value) => value.window)).size === values.length),
}).strict().refine((value) => !value.enabled || value.caps.length > 0);
/** Validated UTC cap and stop configuration, disabled when absent. */
export type CategorizationControlPolicy = z.infer<typeof categorizationControlPolicySchema>;
/** One retained control-policy version, with null identifying the shared parent limit. */
export interface CategorizationControlVersion {
  spaceId: string; budgetId: string; agentId: string | null; version: string;
  policy: CategorizationControlPolicy; actorId: string; createdAt: string;
}
/** Internal exact proposal facts supplied only after normal authorization and human quorum checks. */
export interface CategorizationDispatchAdmission {
  spaceId: string; budgetId: string; agentId: string; delegationId: string; delegationVersion: string;
  proposalId: string; payloadHash: string; idempotencyKey: string;
  amount: { minorUnits: string; currency: string }; now: string;
}
interface PolicyRow { space_id: string; budget_id: string; agent_key: string; version: string; policy: string; actor_id: string; created_at: string }
interface AdmissionRow {
  space_id: string; budget_id: string; agent_id: string; proposal_id: string; payload_hash: string;
  idempotency_key: string; admitted_at: string; currency: string; magnitude: string; state: 'uncertain' | 'verified';
}
function timestamp(value: string): number {
  if (!z.string().datetime().safeParse(value).success || !Number.isFinite(Date.parse(value))) throw new Error('Invalid admission timestamp');
  return Date.parse(value);
}
/** Start of the UTC calendar window; ISO weeks begin on Monday. */
export function categorizationWindowStart(now: string, window: 'day' | 'week' | 'month'): string {
  const date = new Date(timestamp(now));
  date.setUTCHours(0, 0, 0, 0);
  if (window === 'month') date.setUTCDate(1);
  if (window === 'week') date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString();
}
function policyValue(row: PolicyRow): CategorizationControlVersion {
  return { spaceId: row.space_id, budgetId: row.budget_id, agentId: row.agent_key || null,
    version: row.version, policy: categorizationControlPolicySchema.parse(JSON.parse(row.policy)),
    actorId: row.actor_id, createdAt: row.created_at };
}
/** Append-only migration; never edits an already released migration. */
export function migrateCategorizationControls(db: Database): void {
  db.exec(`
    CREATE TABLE categorization_control_versions (
      space_id TEXT NOT NULL, budget_id TEXT NOT NULL, agent_key TEXT NOT NULL,
      version TEXT NOT NULL, policy TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
      is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),
      PRIMARY KEY(space_id,budget_id,agent_key,version)
    );
    CREATE UNIQUE INDEX categorization_control_current ON categorization_control_versions(space_id,budget_id,agent_key) WHERE is_current=1;
    CREATE TABLE categorization_dispatch_admissions (
      proposal_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
      space_id TEXT NOT NULL, budget_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      delegation_id TEXT NOT NULL, delegation_version TEXT NOT NULL,
      parent_policy_version TEXT NOT NULL, agent_policy_version TEXT NOT NULL,
      admitted_at TEXT NOT NULL, currency TEXT NOT NULL, magnitude TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('uncertain','verified'))
    );
    CREATE INDEX categorization_dispatch_scope ON categorization_dispatch_admissions(space_id,budget_id,admitted_at);
    CREATE INDEX categorization_dispatch_agent ON categorization_dispatch_admissions(space_id,budget_id,agent_id,admitted_at);
    CREATE INDEX categorization_dispatch_uncertain ON categorization_dispatch_admissions(space_id,budget_id) WHERE state='uncertain';
  `);
}
/** Store-internal accounting; callers own current governance and independent approval admission. */
export class CategorizationControls {
  constructor(private readonly db: Database) {}
  private budget(spaceId: string): string {
    id.parse(spaceId);
    const space = this.db.prepare('SELECT budget_id FROM spaces WHERE id=? AND deleted_at IS NULL').get(spaceId) as { budget_id: string | null } | undefined;
    if (!space?.budget_id) throw new Error('Selected space budget unavailable');
    return space.budget_id;
  }
  /** Lists current policies without exposing charged source facts. */
  list(spaceId: string): CategorizationControlVersion[] {
    const budgetId = this.budget(spaceId);
    return (this.db.prepare('SELECT * FROM categorization_control_versions WHERE space_id=? AND budget_id=? AND is_current=1 ORDER BY agent_key')
      .all(spaceId, budgetId) as PolicyRow[]).map(policyValue);
  }
  /** Appends a compare-and-swap control version; human management admission belongs to governance. */
  set(input: { spaceId: string; agentId: string | null; expectedVersion: string | null; policy: unknown; actorId: string; now: string }): CategorizationControlVersion {
    timestamp(input.now);
    const budgetId = this.budget(input.spaceId);
    const policy = categorizationControlPolicySchema.parse(input.policy);
    if (input.agentId !== null) {
      id.parse(input.agentId);
      const agent = this.db.prepare('SELECT status FROM governance_agents WHERE agent_id=? AND registered_space_id=?')
        .get(input.agentId, input.spaceId) as { status: string } | undefined;
      if (!agent || (policy.enabled && !policy.stopped && agent.status !== 'active')) throw new Error('Selected agent unavailable');
    }
    const key = input.agentId ?? '';
    return this.db.transaction(() => {
      const current = this.db.prepare('SELECT version FROM categorization_control_versions WHERE space_id=? AND budget_id=? AND agent_key=? AND is_current=1')
        .get(input.spaceId, budgetId, key) as { version: string } | undefined;
      if ((current?.version ?? null) !== input.expectedVersion) throw new Error('Categorization control version conflict');
      this.db.prepare('UPDATE categorization_control_versions SET is_current=0 WHERE space_id=? AND budget_id=? AND agent_key=? AND is_current=1').run(input.spaceId, budgetId, key);
      const version = randomUUID();
      this.db.prepare('INSERT INTO categorization_control_versions VALUES (?,?,?,?,?,?,?,1)')
        .run(input.spaceId, budgetId, key, version, JSON.stringify(policy), input.actorId, input.now);
      return { spaceId: input.spaceId, budgetId, agentId: input.agentId, version, policy, actorId: input.actorId, createdAt: input.now };
    }).immediate();
  }
  private check(input: CategorizationDispatchAdmission): { parent: CategorizationControlVersion; agent: CategorizationControlVersion; magnitude: bigint } {
    for (const field of ['spaceId', 'budgetId', 'agentId', 'delegationId', 'delegationVersion', 'proposalId', 'payloadHash', 'idempotencyKey'] as const) id.parse(input[field]);
    const current = timestamp(input.now);
    if (this.budget(input.spaceId) !== input.budgetId) throw new Error('Categorization budget identity differs');
    if (!z.object({ currency, minorUnits: z.string().max(20).regex(/^-?(0|[1-9]\d*)$/).refine((value) => value !== '-0') }).strict().safeParse(input.amount).success)
      throw new Error('Invalid categorization amount');
    const value = BigInt(input.amount.minorUnits);
    const magnitude = value < 0n ? -value : value;
    if (magnitude > 9_223_372_036_854_775_807n) throw new Error('Overflowing categorization amount');
    const rows = this.list(input.spaceId), parent = rows.find((row) => row.agentId === null), agent = rows.find((row) => row.agentId === input.agentId);
    if (!parent?.policy.enabled || !agent?.policy.enabled) throw new Error('Delegated categorization is disabled');
    if (parent.policy.stopped || agent.policy.stopped) throw new Error('Delegated categorization is stopped');
    if (this.db.prepare("SELECT 1 FROM categorization_dispatch_admissions WHERE space_id=? AND budget_id=? AND state='uncertain' LIMIT 1")
      .get(input.spaceId, input.budgetId)) throw new Error('A prior categorization dispatch is uncertain');
    for (const policy of [parent, agent]) {
      const scope = policy.agentId === null ? 'space_id=? AND budget_id=?' : 'space_id=? AND budget_id=? AND agent_id=?';
      const params = policy.agentId === null ? [input.spaceId, input.budgetId] : [input.spaceId, input.budgetId, policy.agentId];
      const last = this.db.prepare(`SELECT admitted_at FROM categorization_dispatch_admissions WHERE ${scope} ORDER BY admitted_at DESC LIMIT 1`)
        .get(...params) as { admitted_at: string } | undefined;
      if (last && (timestamp(last.admitted_at) > current || current - timestamp(last.admitted_at) < policy.policy.cooldownSeconds * 1000))
        throw new Error('Categorization cooldown is active');
      for (const cap of policy.policy.caps) {
        const start = categorizationWindowStart(input.now, cap.window);
        const count = this.db.prepare(`SELECT COUNT(*) AS count FROM categorization_dispatch_admissions WHERE ${scope} AND admitted_at>=?`)
          .get(...params, start) as { count: number };
        if (!Number.isSafeInteger(count.count) || count.count + 1 > cap.maxOperations) throw new Error('Categorization operation limit exceeded');
        const limit = cap.maxMagnitude.find((item) => item.currency === input.amount.currency);
        if (!limit) throw new Error('Explicit categorization currency limit required');
        let total = magnitude;
        for (const row of this.db.prepare(`SELECT magnitude FROM categorization_dispatch_admissions WHERE ${scope} AND admitted_at>=? AND currency=?`)
          .iterate(...params, start, input.amount.currency) as Iterable<{ magnitude: string }>) {
          total += BigInt(unsignedMinor.parse(row.magnitude));
          if (total > BigInt(limit.minorUnits)) break;
        }
        if (total > BigInt(limit.minorUnits)) throw new Error('Categorization magnitude limit exceeded');
      }
    }
    return { parent, agent, magnitude };
  }
  /** Read-only preflight never reserves allowance or consumes human approval. */
  preflight(input: CategorizationDispatchAdmission): void { this.check(input); }
  /** Final synchronous admission is serialized with stop and cap updates by SQLite. */
  admit(input: CategorizationDispatchAdmission): void {
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM categorization_dispatch_admissions WHERE proposal_id=? OR idempotency_key=?')
        .get(input.proposalId, input.idempotencyKey) as AdmissionRow | undefined;
      if (existing) {
        if (existing.proposal_id !== input.proposalId || existing.idempotency_key !== input.idempotencyKey ||
          existing.payload_hash !== input.payloadHash || existing.agent_id !== input.agentId || existing.space_id !== input.spaceId || existing.budget_id !== input.budgetId)
          throw new Error('Categorization admission identity differs');
        throw new Error('Categorization effect was already admitted; read-only recovery required');
      }
      const { parent, agent, magnitude } = this.check(input);
      this.db.prepare('INSERT INTO categorization_dispatch_admissions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(input.proposalId, input.idempotencyKey, input.payloadHash, input.spaceId, input.budgetId, input.agentId,
          input.delegationId, input.delegationVersion, parent.version, agent.version,
          new Date(timestamp(input.now)).toISOString(), input.amount.currency, magnitude.toString(), 'uncertain');
    }).immediate();
  }
  /** Restore never silently revives automation or erases original accounting history. */
  quarantineRestore(now: string): void {
    timestamp(now);
    const rows = this.db.prepare('SELECT * FROM categorization_control_versions WHERE is_current=1').all() as PolicyRow[];
    for (const row of rows) {
      const policy = { ...policyValue(row).policy, enabled: false, stopped: true };
      this.db.prepare('UPDATE categorization_control_versions SET is_current=0 WHERE space_id=? AND budget_id=? AND agent_key=? AND version=?')
        .run(row.space_id, row.budget_id, row.agent_key, row.version);
      this.db.prepare('INSERT INTO categorization_control_versions VALUES (?,?,?,?,?,?,?,1)')
        .run(row.space_id, row.budget_id, row.agent_key, randomUUID(), JSON.stringify(policy), 'system:restore', now);
      this.db.prepare('INSERT INTO space_governance_audit VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), row.space_id, 'system:restore', 'categorization_restore_stopped', row.agent_key || null, now, '{}');
    }
  }
  /** Trusted native-verification completion preserves charged history while clearing the uncertainty fence. */
  verified(idempotencyKey: string): void {
    this.db.prepare("UPDATE categorization_dispatch_admissions SET state='verified' WHERE idempotency_key=? AND state='uncertain'").run(idempotencyKey);
  }
}
