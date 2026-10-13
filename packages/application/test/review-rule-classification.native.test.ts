import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { createNativeAnalysisProtocol } from '../src/composition';
import { persistPendingReviewResult } from '../src/review-persistence';

const fixture = canonicalProtocolSnapshotSchema.parse(
  JSON.parse(readFileSync(new URL('../../../protocol/fixtures/representative.json', import.meta.url), 'utf8')),
);
const now = '2098-01-01T12:00:00.000Z';
const auth = { method: 'human-session' as const, actorId: 'owner', sessionId: 'rule-review-owner', reauthenticatedAt: now };
let store: SqliteWorkflowStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

/** Exercise the compiled classifier and SQLite consumer, not a copied native response. */
describe('scoped native classification through persisted review', () => {
  it('persists the rule category and provenance, isolates pauses, and resumes without mutating Actual snapshots', async () => {
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'rule-review-fixture' });
    await store.finalizeBootstrap({ claimId: 'rule-review-fixture', ownerUserId: 'owner' });
    const space = store.governance.createSpace({ actorId: 'owner', name: 'Rule review', kind: 'shared', now, auth });
    const budgetId = 'rule-review-budget';
    store.governance.bindBudget({ spaceId: space.id, budgetId, now, auth });
    const scope = { spaceId: space.id, budgetId };
    const other = store.governance.createSpace({ actorId: 'owner', name: 'Other rule review', kind: 'shared', now, auth });
    store.governance.bindBudget({ spaceId: other.id, budgetId: 'other-rule-review-budget', now, auth });
    const otherScope = { spaceId: other.id, budgetId: 'other-rule-review-budget' };
    const category = fixture.categories.find((entry) => !entry.deleted)!;
    const transaction = {
      ...fixture.transactions[0]!, id: 'rule-review-uncategorized',
      payeeId: null, payeeName: 'Fixture scoped rule merchant', categoryId: null, categoryName: null,
    };
    const rule = {
      id: 'rule-review-category', name: 'Fixture scoped rule merchant', order: 0, inactive: false,
      trigger: { stage: 'post', conditionsOp: 'and', conditions: [{ field: 'payee_name', op: 'is', value: transaction.payeeName }] },
      actions: [{ field: 'category', op: 'set', value: category.id }],
    };
    const snapshot: ProtocolSnapshot = { ...fixture, transactions: [transaction], rules: [rule] };
    const original = JSON.stringify(snapshot);
    const protocol = await createNativeAnalysisProtocol();
    const enabled = await protocol.pendingReview(snapshot, null, { store, scope });
    const persistenceScope = { ...scope, connectionId: 'actual-rule-review-fixture' };
    await persistPendingReviewResult(store, budgetId, enabled, snapshot, { scope: persistenceScope, authorize: () => true });
    const rows = await store.listReviewItems({ budgetId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transactionId: transaction.id, categoryId: category.id, classifier: 'rule' });
    expect(enabled.nativeRuleBlocks).toEqual([{ ruleIds: [rule.id] }]);
    expect(enabled.nativeRuleParts.length).toBeGreaterThan(0);
    expect(enabled.nativeRuleSets).toHaveLength(1);
    expect(rows[0]?.evidence).toMatchObject({ ruleSetRef: { kind: 'scoped', scope: persistenceScope, id: expect.any(String) }, proposedCategoryName: category.name });
    expect(rows[0]?.evidence.ruleIds).toBeUndefined();
    const signedAmount = BigInt(transaction.amount.minorUnits);
    expect(rows[0]?.sourceTransaction).toEqual({
      id: transaction.id, accountId: transaction.accountId, categoryId: null,
      direction: signedAmount < 0n ? 'outgoing' : 'incoming',
      amount: { minorUnits: (signedAmount < 0n ? -signedAmount : signedAmount).toString(),
        currency: transaction.amount.currency },
    });

    const paused = await store.setRuleOverride({ ...scope, ruleId: rule.id, inactive: true, expectedVersion: null });
    expect((await protocol.pendingReview(snapshot, null, { store, scope })).candidates).toEqual([]);
    expect((await protocol.pendingReview(snapshot, null, { store, scope: otherScope })).candidates[0]).toMatchObject({
      proposedCategoryId: category.id, ruleSetIndex: 0,
    });
    await store.setRuleOverride({ ...scope, ruleId: rule.id, inactive: false, expectedVersion: paused.version });
    expect((await protocol.pendingReview(snapshot, null, { store, scope })).candidates[0]).toMatchObject({
      proposedCategoryId: category.id, ruleSetIndex: 0,
    });
    expect(JSON.stringify(snapshot)).toBe(original);
  });

  it('keeps every native outcome and matching ID shared when no merchant inference service is configured', async () => {
    store = new SqliteWorkflowStore(':memory:');
    const category = fixture.categories.find((entry) => !entry.deleted)!;
    const transactions = Array.from({ length: 32 }, (_, index) => ({
      ...fixture.transactions[0]!, id: `native-complete-${String(index).padStart(3, '0')}`,
      payeeId: null, payeeName: 'Complete native fixture merchant',
      categoryId: null, categoryName: null, subtransactions: [],
    }));
    const rules = Array.from({ length: 128 }, (_, index) => ({
      id: `native-rule-${String(index).padStart(3, '0')}`, name: 'Complete native fixture merchant', order: index, inactive: false,
      trigger: { stage: 'post', conditionsOp: 'and', conditions: [{ field: 'payee_name', op: 'is', value: 'Complete native fixture merchant' }] },
      actions: [{ field: 'category', op: 'set', value: category.id }],
    }));
    const snapshot: ProtocolSnapshot = { ...fixture, transactions, rules };
    const original = JSON.stringify(snapshot);
    const protocol = await createNativeAnalysisProtocol();
    const analysis = await protocol.pendingReview(snapshot, null);
    expect(analysis.nativeRuleBlocks).toEqual([{ ruleIds: rules.map((rule) => rule.id) }]);
    expect(analysis.nativeRuleParts.length).toBeGreaterThan(0);
    expect(analysis.nativeRuleSets).toHaveLength(1);
    expect(analysis.candidates).toHaveLength(32);
    for (const candidate of analysis.candidates) {
      expect(candidate).toMatchObject({ source: 'native-rule', proposedCategoryId: category.id, ruleSetIndex: 0 });
      expect(candidate).not.toHaveProperty('ruleIds');
    }
    const scope = { spaceId: 'native-complete-space', budgetId: 'native-complete-budget', connectionId: 'actual-native-complete-fixture' };
    await persistPendingReviewResult(store, scope.budgetId, analysis, snapshot, { scope, authorize: () => true });
    const persisted = await store.listReviewItems({ budgetId: scope.budgetId, limit: 1000 });
    expect(persisted).toHaveLength(32);
    expect(new Set(persisted.map((row) => JSON.stringify(row.evidence.ruleSetRef))).size).toBe(1);
    expect(persisted.every((row) => row.classifier === 'rule' && row.evidence.ruleIds === undefined)).toBe(true);
    expect(store['db'].prepare('SELECT COUNT(*) AS count FROM review_rule_sets').get()).toEqual({ count: 1 });
    expect(JSON.stringify(snapshot)).toBe(original);
  });
});
