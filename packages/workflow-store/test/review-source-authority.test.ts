import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fixture from '../../../protocol/fixtures/representative.json';
import { SqliteWorkflowStore } from '../src/store.js';
import type { ReviewActionAuthorization } from '../src/types.js';

const transaction = fixture.transactions[0]!;
const signedAmount = BigInt(transaction.amount.minorUnits);
const source: ReviewActionAuthorization['transaction'] = {
  id: transaction.id,
  accountId: transaction.accountId,
  categoryId: transaction.categoryId ?? null,
  direction: signedAmount < 0n ? 'outgoing' : 'incoming',
  amount: {
    minorUnits: (signedAmount < 0n ? -signedAmount : signedAmount).toString(),
    currency: transaction.amount.currency,
  },
};
const input = {
  budgetId: 'canonical-source-budget', transactionId: transaction.id,
  categoryId: fixture.categories[0]!.id, classifier: 'deterministic',
  provenance: 'Actual synchronized snapshot deterministic analysis',
};

describe('trusted review source authority', () => {
  let store: SqliteWorkflowStore;
  beforeEach(() => { store = new SqliteWorkflowStore(':memory:'); });
  afterEach(() => { store.close(); });

  it('stores canonical source facts separately from untrusted classifier evidence', async () => {
    const item = await store.createReviewItem({ ...input, sourceTransaction: source,
      evidence: { sourceTransaction: { ...source, accountId: 'forged-account' } },
    });
    expect(item.sourceTransaction).toEqual(source);
    expect((await store.getReviewItem(item.id))!.sourceTransaction).toEqual(source);
    const untrusted = await store.createReviewItem({ ...input, classifier: 'model-only',
      evidence: { sourceTransaction: source },
    });
    expect(untrusted.sourceTransaction).toBeNull();
  });

  it('refreshes trusted source facts without replacing pending identity, recommendation, or history', async () => {
    const legacy = await store.createReviewItem(input);
    const pending = await store.transitionInternalReviewItem(legacy.id, {
      toStatus: 'pending_review', actor: 'trusted-sync', reason: 'Canonical fixture',
      expectedVersion: legacy.version,
    });
    const captured = await store.createReviewItem({ ...input, sourceTransaction: source });
    expect(captured).toMatchObject({
      id: pending.id, status: 'pending_review', categoryId: input.categoryId,
      version: pending.version + 1, sourceTransaction: source,
    });
    const repeated = await store.createReviewItem({ ...input, sourceTransaction: source });
    expect(repeated.version).toBe(captured.version);
    const movedSource = { ...source, accountId: fixture.accounts[1]!.id };
    const moved = await store.createReviewItem({ ...input, sourceTransaction: movedSource });
    expect(moved).toMatchObject({ id: pending.id, status: 'pending_review',
      categoryId: input.categoryId, version: captured.version + 1, sourceTransaction: movedSource });
    expect(await store.getReviewActions(pending.id)).toMatchObject([
      { actor: 'trusted-sync', fromStatus: 'discovered', toStatus: 'pending_review' },
    ]);
  });

  it.each(['0', '9223372036854775807'])('preserves exact source magnitude %s without floating-point conversion', async (minorUnits) => {
    const facts = { ...source, amount: { ...source.amount, minorUnits } };
    expect((await store.createReviewItem({ ...input, sourceTransaction: facts })).sourceTransaction).toEqual(facts);
  });

  it.each([
    { ...source, id: 'another-transaction' },
    { ...source, accountId: '' },
    { ...source, amount: { minorUnits: '-1', currency: 'USD' } },
    { ...source, amount: { minorUnits: '9223372036854775808', currency: 'USD' } },
    { ...source, amount: { minorUnits: '1', currency: '' } },
  ])('rejects malformed canonical authority before creating an item', async (sourceTransaction) => {
    await expect(store.createReviewItem({ ...input, sourceTransaction })).rejects.toThrow();
    expect(await store.listReviewItems({ budgetId: input.budgetId })).toEqual([]);
  });
});
