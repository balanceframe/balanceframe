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
    await persistPendingReviewResult(store, budgetId, enabled, snapshot);
    const rows = await store.listReviewItems({ budgetId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ transactionId: transaction.id, categoryId: category.id, classifier: 'rule' });
    expect(rows[0]?.evidence).toMatchObject({ ruleIds: [rule.id], proposedCategoryName: category.name });
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
      proposedCategoryId: category.id, ruleIds: [rule.id],
    });
    await store.setRuleOverride({ ...scope, ruleId: rule.id, inactive: false, expectedVersion: paused.version });
    expect((await protocol.pendingReview(snapshot, null, { store, scope })).candidates[0]).toMatchObject({
      proposedCategoryId: category.id, ruleIds: [rule.id],
    });
    expect(JSON.stringify(snapshot)).toBe(original);
  });
});
