import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { canonicalProposalJson } from '../src/proposal.js';
import { EvidenceItemRuleWorkflow, migrateEvidenceItemRules } from '../src/evidence-item-rules.js';
import { SqliteWorkflowStore } from '../src/store.js';
const now = '2026-10-21T12:00:00.000Z';
const access = { scope: { spaceId: 'space', budgetId: 'budget', connectionId: 'connection' }, actorId: 'owner', now, authorize: () => true };
let store: SqliteWorkflowStore;
afterEach(() => store?.close());
function source() { return store.evidence.ingest(access, { connectorId: 'retail', sourceId: 'receipt', sourceTimestamp: now, mediaType: 'application/json', parserVersion: 'retail-v1', privateActorId: 'owner', retentionUntil: '2026-10-22T12:00:00.000Z', parseStatus: 'parsed', quality: [], extraction: {}, content: Buffer.from('source') }, Buffer.alloc(32)).document; }
function payload(documentId: string) {
  return {
    connectorId: 'retail',
    accountId: 'checking',
    rule: {
      id: 'rule-1',
      sourceId: 'user-import:retail',
      fundingInstrumentId: 'card',
      counterparty: 'Store A',
      sku: 'sku-1',
      normalizedDescription: null,
      categoryId: 'food',
    },
    policyVersion: '1',
    requesterMembershipId: 'membership',
    documentIds: [documentId],
    createdAt: now,
    expiresAt: '2026-10-28T12:00:00.000Z',
    actualRulesHash: 'a'.repeat(64),
    simulation: { ruleId: 'rule-1', resolutionHash: 'b'.repeat(64), matches: [{ receiptId: 'receipt', lineId: 'line', currentCategoryId: 'food', proposedCategoryId: 'food', conflict: false }], conflicts: [], falsePositiveRisk: 'review_required' as const, requiresApproval: true as const },
    examples: [],
    actualInteraction: { kind: 'local_item_suggestion_only' as const, reasonCode: 'actual_item_predicate_unavailable' as const, actualRuleIds: [] },
  };
}
describe('immutable evidence item rules', () => {
  it('binds exact proposals and append-only approval/revocation to current source and owner', () => {
    store = new SqliteWorkflowStore(); const document = source();
    const proposed = store.evidence.itemRules.propose(access, payload(document.id));
    expect(proposed.state).toBe('proposed'); expect(proposed.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    const command = { proposalId: proposed.id, payloadHash: proposed.payloadHash, policyVersion: '1', membershipId: 'membership', action: 'approved' as const };
    expect(store.evidence.itemRules.decide(access, command).state).toBe('approved');
    expect(store.evidence.itemRules.decide(access, command).approvals).toHaveLength(1);
    expect(store.evidence.itemRules.get({ ...access, actorId: 'other' }, proposed.id)).toBeNull();
    expect(() => store.evidence.itemRules.decide(access, { ...command, payloadHash: 'c'.repeat(64) })).toThrow(/changed/);
    expect(() => store.evidence.itemRules.decide(access, { ...command, policyVersion: '2' })).toThrow(/policy/);
    expect(store.evidence.itemRules.decide(access, { ...command, action: 'revoked' }).state).toBe('revoked');
    expect(store.evidence.itemRules.list(access)[0]?.approvals).toHaveLength(2);
    expect(store.evidence.itemRules.get({ ...access, now: '2026-10-29T00:00:00.000Z' }, proposed.id)?.state).toBe('expired');
    expect(() => store.evidence.itemRules.decide({ ...access, authorize: () => false }, command)).toThrow();
  });
  it('refuses stale source, duplicate ids, malformed proposals and denied creation', () => {
    store = new SqliteWorkflowStore();
    const document = source();
    const value = payload(document.id);
    expect(() => store.evidence.itemRules.propose({ ...access, authorize: () => false }, value)).toThrow(/authorized/);
    const saved = store.evidence.itemRules.propose(access, value);
    expect(() => store.evidence.itemRules.propose(access, { ...value, rule: { ...value.rule, categoryId: 'other' } })).toThrow(/immutable/);
    expect(saved.payloadHash).toBe(
      createHash('sha256').update(canonicalProposalJson(value)).digest('hex'),
    );
    expect(() =>
      store.evidence.itemRules.propose(access, {
        ...value,
        rule: { ...value.rule, counterparty: 'Store B' },
      }),
    ).toThrow(/immutable/);
    expect(() => store.evidence.itemRules.propose(access, { ...value, documentIds: ['missing'] })).toThrow();
    expect(() => store.evidence.itemRules.propose(access, { ...value, documentIds: [document.id, document.id] })).toThrow();
    expect(store.evidence.itemRules.get({ ...access, scope: { ...access.scope, spaceId: 'other' } }, saved.id)).toBeNull();
    expect(store.evidence.itemRules.get({ ...access, authorize: () => false }, saved.id)).toBeNull();
  });
});

it('withholds each legacy unscoped rule without changing history or hiding valid scoped rules', () => {
  const db = new Database(':memory:');
  try {
    migrateEvidenceItemRules(db);
    const workflow = new EvidenceItemRuleWorkflow(db, () => true);
    const scoped = {
      ...payload('document'),
      rule: { ...payload('document').rule, counterparty: 'Store A' },
      requesterActorId: access.actorId,
      payloadHash: 'a'.repeat(64),
    };
    const legacy = structuredClone(scoped);
    legacy.rule.id = 'legacy-rule';
    legacy.simulation.ruleId = 'legacy-rule';
    delete (legacy.rule as Record<string, unknown>).counterparty;
    const bytes = JSON.stringify(legacy);
    const scopeKey = JSON.stringify([
      access.scope.spaceId,
      access.scope.budgetId,
      access.scope.connectionId,
    ]);
    const insert = db.prepare(
      'INSERT INTO transaction_evidence_item_rules(scope_key,id,actor_id,value) VALUES(?,?,?,?)',
    );
    insert.run(scopeKey, legacy.rule.id, access.actorId, bytes);
    insert.run(scopeKey, scoped.rule.id, access.actorId, JSON.stringify(scoped));
    expect(workflow.get(access, legacy.rule.id)).toBeNull();
    expect(workflow.list(access).map((record) => record.id)).toEqual([scoped.rule.id]);
    expect(() =>
      workflow.decide(access, {
        proposalId: legacy.rule.id,
        payloadHash: legacy.payloadHash,
        policyVersion: '1',
        membershipId: 'membership',
        action: 'approved',
      }),
    ).toThrow(/changed/);
    expect(
      (
        db
          .prepare('SELECT value FROM transaction_evidence_item_rules WHERE id=?')
          .get(legacy.rule.id) as { value: string }
      ).value,
    ).toBe(bytes);
  } finally {
    db.close();
  }
});
