import { evidenceItemCategoryDecisionSchema } from './evidence-item-categories.js';
import type { Database } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EvidenceRuleProposalSchema, EvidenceRuleSimulationResultSchema, moneySchema } from '@balanceframe/protocol-generated/validators';
import type { EvidenceAccess } from './transaction-evidence.js';
import { canonicalProposalJson } from './proposal.js';
const id = z.string().trim().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Immutable rule and complete historical simulation; source content is never renewed by approval. */
export const evidenceItemRulePayloadSchema = z
  .object({
    connectorId: id,
    accountId: id,
    rule: EvidenceRuleProposalSchema,
    policyVersion: id,
    requesterMembershipId: id,
    documentIds: z.array(id).min(1).max(10000).refine((ids) => new Set(ids).size === ids.length),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    actualRulesHash: hash,
    simulation: EvidenceRuleSimulationResultSchema,
    learning: z
      .object({
        candidateHash: hash,
        outcomes: z.array(evidenceItemCategoryDecisionSchema).min(2).max(10000),
      })
      .strict()
      .optional(),
    examples: z.array(z.object({ documentId: id, receiptId: id, lineId: id, rawDescription: z.string().max(4096), normalizedDescription: z.string().max(4096), sku: id.nullable(), amount: moneySchema, currentCategoryId: id.nullable() }).strict()).max(10000),
    actualInteraction: z.object({ kind: z.literal('local_item_suggestion_only'), reasonCode: z.literal('actual_item_predicate_unavailable'), actualRuleIds: z.array(id).max(10000) }).strict(),
  })
  .strict();
export type EvidenceItemRulePayload = z.infer<typeof evidenceItemRulePayloadSchema>;
/** Every approval/revocation remains attributable to the exact displayed payload. */
export interface EvidenceItemRuleApproval { actorId: string; membershipId: string; policyVersion: string; payloadHash: string; action: 'approved'|'revoked'; at: string }
/** Public rule state is derived from immutable proposal and append-only human decisions. */
export interface EvidenceItemRuleRecord extends EvidenceItemRulePayload { id: string; requesterActorId: string; payloadHash: string; state: 'proposed'|'approved'|'revoked'|'expired'; approvals: EvidenceItemRuleApproval[] }
/** Persist rules separately from mutable Actual rules and preserve their complete exact approval history. */
export function migrateEvidenceItemRules(db: Database): void {
  db.exec(`CREATE TABLE transaction_evidence_item_rules (scope_key TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope_key,id));
    CREATE TABLE transaction_evidence_item_rule_approvals (sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, rule_id TEXT NOT NULL, value TEXT NOT NULL);`);
}
const namespace = (access: EvidenceAccess): string => JSON.stringify([access.scope.spaceId, access.scope.budgetId, access.scope.connectionId]);
const digest = (value: unknown): string => createHash('sha256').update(canonicalProposalJson(value)).digest('hex');
/** Scoped item-rule storage reuses evidence source authorization and the SQLite transaction fence. */
export class EvidenceItemRuleWorkflow {
  constructor(private readonly db: Database, private readonly currentSources: (access: EvidenceAccess, documentIds: string[]) => boolean) {}
  private allowed(
    access: EvidenceAccess,
    capability: 'item-rule:propose' | 'item-rule:approve' | 'item-rule:read',
  ): boolean {
    id.parse(access.actorId);
    z.string().datetime().parse(access.now);
    return (
      access.authorize({ capability, document: null, scope: structuredClone(access.scope) }) === true
    );
  }
  private load(access: EvidenceAccess, identity: string): EvidenceItemRuleRecord | null {
    const row = this.db.prepare('SELECT value FROM transaction_evidence_item_rules WHERE scope_key=? AND id=? AND actor_id=?').get(namespace(access), id.parse(identity), access.actorId) as { value: string } | undefined;
    if (!row) return null;
    const stored = JSON.parse(row.value) as EvidenceItemRulePayload & { requesterActorId: string; payloadHash: string };
    // Legacy proposals without an exact merchant are withheld individually, never upgraded.
    if (!EvidenceRuleProposalSchema.safeParse(stored.rule).success) return null;
    if (!this.currentSources(access, stored.documentIds)) return null;
    const approvals = (this.db.prepare('SELECT value FROM transaction_evidence_item_rule_approvals WHERE scope_key=? AND rule_id=? ORDER BY sequence').all(namespace(access), identity) as { value: string }[]).map((entry) => JSON.parse(entry.value) as EvidenceItemRuleApproval);
    return {
      ...stored,
      id: stored.rule.id,
      approvals,
      state:
        Date.parse(stored.expiresAt) <= Date.parse(access.now)
          ? 'expired'
          : (approvals.at(-1)?.action ?? 'proposed'),
    };
  }
  /** Store one immutable proposal with an exact canonical payload hash. */
  propose(access: EvidenceAccess, value: EvidenceItemRulePayload): EvidenceItemRuleRecord {
    const input = evidenceItemRulePayloadSchema.parse(value);
    if (input.rule.id !== input.simulation.ruleId || Date.parse(input.createdAt) !== Date.parse(access.now) || Date.parse(input.expiresAt) <= Date.parse(access.now) || Date.parse(input.expiresAt) - Date.parse(input.createdAt) > 30 * 86400000) throw new Error('Invalid evidence rule identity or lifetime');
    return this.db.transaction(() => {
      if (!this.allowed(access, 'item-rule:propose') || !this.currentSources(access, input.documentIds)) throw new Error('Evidence rule is not authorized');
      const stored = { ...input, requesterActorId: access.actorId, payloadHash: digest(input) };
      const prior = this.db.prepare('SELECT value FROM transaction_evidence_item_rules WHERE scope_key=? AND id=?').get(namespace(access), input.rule.id) as { value: string } | undefined;
      if (prior && canonicalProposalJson(JSON.parse(prior.value)) !== canonicalProposalJson(stored)) throw new Error('Evidence rule proposal is immutable');
      this.db.prepare('INSERT OR IGNORE INTO transaction_evidence_item_rules(scope_key,id,actor_id,value) VALUES(?,?,?,?)').run(namespace(access), input.rule.id, access.actorId, JSON.stringify(stored));
      return this.load(access, input.rule.id)!;
    }).immediate();
  }
  /** Read one owner-scoped proposal only while its exact supporting sources remain current and readable. */
  get(access: EvidenceAccess, identity: string): EvidenceItemRuleRecord | null { return this.allowed(access, 'item-rule:read') ? this.load(access, identity) : null; }
  /** List only the caller's supported exact proposals; hidden peers never contribute counts. */
  list(access: EvidenceAccess): EvidenceItemRuleRecord[] {
    if (!this.allowed(access, 'item-rule:read')) return [];
    return (this.db.prepare('SELECT id FROM transaction_evidence_item_rules WHERE scope_key=? AND actor_id=? ORDER BY rowid').all(namespace(access), access.actorId) as { id: string }[]).flatMap(({ id }) => { const rule = this.load(access, id); return rule ? [rule] : []; });
  }
  /** Append exact approval or revocation; fresh human/session policy is checked by the authorization callback. */
  decide(access: EvidenceAccess, value: { proposalId: string; payloadHash: string; policyVersion: string; membershipId: string; action: 'approved'|'revoked' }): EvidenceItemRuleRecord {
    const input = z.object({ proposalId: id, payloadHash: hash, policyVersion: id, membershipId: id, action: z.enum(['approved','revoked']) }).strict().parse(value);
    return this.db.transaction(() => {
      if (!this.allowed(access, 'item-rule:approve')) throw new Error('Evidence rule is not authorized');
      const proposal = this.load(access, input.proposalId);
      if (!proposal || proposal.state === 'expired' || proposal.payloadHash !== input.payloadHash) throw new Error('Evidence rule changed or expired');
      if (proposal.policyVersion !== input.policyVersion) throw new Error('Evidence rule policy changed');
      if (input.action === 'approved' && (proposal.simulation.conflicts.length > 0 || proposal.simulation.matches.length === 0)) throw new Error('Evidence rule historical conflicts require a new proposal');
      const latest = proposal.approvals.at(-1);
      if (latest?.action !== input.action || latest.membershipId !== input.membershipId) this.db.prepare('INSERT INTO transaction_evidence_item_rule_approvals(scope_key,rule_id,value) VALUES(?,?,?)').run(namespace(access), input.proposalId, JSON.stringify({ actorId: access.actorId, membershipId: input.membershipId, policyVersion: input.policyVersion, payloadHash: input.payloadHash, action: input.action, at: access.now } satisfies EvidenceItemRuleApproval));
      return this.load(access, input.proposalId)!;
    }).immediate();
  }
}
