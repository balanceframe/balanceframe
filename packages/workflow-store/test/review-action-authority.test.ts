import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../protocol/fixtures/representative.json';
import { SqliteWorkflowStore } from '../src/store.js';

const now = '2098-01-01T12:00:00.000Z';
const budgetId = 'review-authority-budget';
const transaction = fixture.transactions[0]!;
const categoryId = fixture.transactions[1]!.categoryId!;
const human = (actorId: string) => ({ method: 'human-session' as const, actorId, sessionId: `session:${actorId}`, reauthenticatedAt: now });
let store: SqliteWorkflowStore;
let spaceId: string;
let membershipId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  store = new SqliteWorkflowStore(':memory:');
  await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'review-authority' });
  await store.finalizeBootstrap({ claimId: 'review-authority', ownerUserId: 'owner' });
  await store.upsertActorMembership('owner', 'active', [], 'unscoped');
  await store.upsertActorMembership('reviewer', 'active', [], 'unscoped');
  const unbound = store.governance.createSpace({ actorId: 'owner', name: 'Review authority', kind: 'shared', now, auth: human('owner') });
  spaceId = store.governance.bindBudget({ spaceId: unbound.id, budgetId, now, auth: human('owner') }).id;
  membershipId = store.governance.addMembership({ spaceId, actorId: 'reviewer', validFrom: now, now, auth: human('owner') }).id;
});
afterEach(() => { store.close(); vi.useRealTimers(); });

function grant(resourceKind: 'budget' | 'account' | 'category' | 'transaction', resourceId: string, restrictions = {}) {
  return store.governance.setResourceGrant({ spaceId, actorId: 'reviewer', budgetId, membershipId, resourceKind, resourceId, capability: 'categorization:execute', restrictions, granted: true, now, auth: human('owner') });
}
function grantAll(restrictions = {}) {
  grant('budget', budgetId, restrictions);
  grant('account', transaction.accountId);
  grant('transaction', transaction.id);
  grant('category', categoryId);
  if (transaction.categoryId && transaction.categoryId !== categoryId) grant('category', transaction.categoryId);
}
function authorization() {
  const amount = BigInt(transaction.amount.minorUnits);
  return {
    spaceId,
    policyVersion: store.governance.getPolicy({ spaceId })!.version,
    auth: { method: 'session' as const, actorId: 'reviewer', sessionId: 'reviewer-session' },
    now,
    transaction: {
      id: transaction.id,
      accountId: transaction.accountId,
      categoryId: transaction.categoryId ?? null,
      direction: amount < 0n ? 'outgoing' as const : 'incoming' as const,
      amount: { minorUnits: (amount < 0n ? -amount : amount).toString(), currency: transaction.amount.currency },
    },
  };
}
async function pending() {
  let item = await store.createReviewItem({ budgetId, transactionId: transaction.id, categoryId, classifier: 'fixture', provenance: 'canonical-fixture' });
  for (const toStatus of ['suggestion_generated', 'pending_review'] as const) item = await store.transitionInternalReviewItem(item.id, { toStatus, actor: 'system', expectedVersion: item.version });
  return item;
}

describe('atomic exact-resource non-ledger review actions', () => {
  it.each(['rejected', 'skipped'] as const)('allows an ordinary current human to mark an exactly authorized item %s without approving a ledger mutation', async (toStatus) => {
    grantAll();
    const item = await pending();
    const input = { toStatus, actor: 'reviewer', expectedVersion: item.version, authorization: authorization() };
    const changed = await store.transitionReviewItem(item.id, input);
    expect(changed.status).toBe(toStatus);
    expect(changed.approvedBy).toEqual([]);
    expect((await store.getReviewActions(item.id)).at(-1)?.actor).toBe('reviewer');
  });

  it.each(['account', 'category', 'transaction'] as const)('does not turn a budget-only execute grant into %s authority', async (missing) => {
    grantAll();
    const resourceId = missing === 'account' ? transaction.accountId : missing === 'category' ? categoryId : transaction.id;
    store.governance.setResourceGrant({ spaceId, actorId: 'reviewer', budgetId, membershipId, resourceKind: missing, resourceId, capability: 'categorization:execute', granted: false, now, auth: human('owner') });
    const item = await pending();
    const input = { toStatus: 'rejected' as const, actor: 'reviewer', expectedVersion: item.version, authorization: authorization() };
    await expect(store.transitionReviewItem(item.id, input)).rejects.toThrow(/authorization/i);
    expect(await store.getReviewItem(item.id)).toEqual(item);
    expect((await store.getReviewActions(item.id)).map((action) => action.actor)).toEqual(['system', 'system']);
  });

  it.each([
    { accountIds: ['not-this-account'] },
    { categoryIds: ['not-this-category'] },
    { maxGrossOutgoing: [{ currency: transaction.amount.currency, minorUnits: '0' }] },
    { maxOperationCount: 0 },
    { proposalOnly: true },
    { operations: ['set_category'] },
  ])('checks complete target restrictions at the status commit: %j', async (restrictions) => {
    grantAll(restrictions);
    const item = await pending();
    const input = { toStatus: 'skipped' as const, actor: 'reviewer', expectedVersion: item.version, authorization: authorization() };
    await expect(store.transitionReviewItem(item.id, input)).rejects.toThrow(/authorization/i);
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });

  it('rejects stale captured policy and departed membership instead of changing a status', async () => {
    grantAll();
    const item = await pending();
    const captured = authorization();
    const policy = store.governance.getPolicy({ spaceId })!;
    store.governance.setPolicy({ spaceId, expectedVersion: policy.version, policy: { minimumApprovers: policy.minimumApprovers, approvalThresholds: policy.approvalThresholds, operationApprovers: { set_category: 3 } }, now, auth: human('owner') });
    const input = { toStatus: 'rejected' as const, actor: 'reviewer', expectedVersion: item.version, authorization: captured };
    await expect(store.transitionReviewItem(item.id, input)).rejects.toThrow(/authorization/i);
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });

  it('binds the trusted transaction to the persisted review item before committing', async () => {
    grantAll();
    const item = await pending();
    const context = authorization();
    const input = { toStatus: 'rejected' as const, actor: 'reviewer', expectedVersion: item.version, authorization: { ...context, transaction: { ...context.transaction, id: 'other-transaction' } } };
    await expect(store.transitionReviewItem(item.id, input)).rejects.toThrow(/authorization/i);
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });

  it.each(['rejected', 'skipped'] as const)('fails closed on a public %s transition without trusted context', async (toStatus) => {
    const item = await pending();
    const beforeActions = await store.getReviewActions(item.id);
    const missingAuthorization = {
      toStatus,
      actor: 'reviewer',
      expectedVersion: item.version,
    };

    await expect(store.transitionReviewItem(
      item.id,
      missingAuthorization as Parameters<typeof store.transitionReviewItem>[1],
    )).rejects.toThrow(/authorization/i);
    expect(await store.getReviewItem(item.id)).toEqual(item);
    expect(await store.getReviewActions(item.id)).toEqual(beforeActions);
  });

  it.each(['rejected', 'skipped'] as const)('requires trusted context for an idempotent public %s transition', async (toStatus) => {
    grantAll();
    const item = await pending();
    const changed = await store.transitionReviewItem(item.id, {
      toStatus,
      actor: 'reviewer',
      expectedVersion: item.version,
      authorization: authorization(),
    });
    const beforeActions = await store.getReviewActions(item.id);
    const missingAuthorization = {
      toStatus,
      actor: 'reviewer',
      expectedVersion: changed.version,
    };

    await expect(store.transitionReviewItem(
      item.id,
      missingAuthorization as Parameters<typeof store.transitionReviewItem>[1],
    )).rejects.toThrow(/authorization/i);
    expect(await store.getReviewItem(item.id)).toEqual(changed);
    expect(await store.getReviewActions(item.id)).toEqual(beforeActions);
  });

  it('requires trusted context to undo an approved public transition without changing its audit history', async () => {
    const item = await pending();
    const approved = await store.transitionInternalReviewItem(item.id, {
      toStatus: 'approved',
      actor: 'reviewer',
      expectedVersion: item.version,
    });
    const beforeActions = await store.getReviewActions(item.id);
    const undoWithoutAuthorization = store.undoReviewTransition.bind(store) as unknown as (
      reviewItemId: string,
      actor: string,
    ) => Promise<typeof approved>;

    await expect(undoWithoutAuthorization(item.id, 'reviewer')).rejects.toThrow(/authorization/i);
    expect(await store.getReviewItem(item.id)).toEqual(approved);
    expect(await store.getReviewActions(item.id)).toEqual(beforeActions);
  });
});
