import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';
import type * as H3 from 'h3';
import type * as WorkflowStorePackage from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../../../protocol/fixtures/representative.json';
import { getWorkflowStore, requireProposalAuthorization } from '../../server/utils/workflow-store';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { merchantConnectionId } from '../../../../packages/application/src/merchant-service';
import { handleReviewWorkflowAction } from '../../server/utils/review-workflow-action';
import { nativeReviewFixture } from './native-review.fixture';
import { completeNativeRuleSourceAvailability } from './native-rule-source.fixture';

const sdk = vi.hoisted(() => ({
  budgetId: '',
  loadConfig: vi.fn(),
  synchronize: vi.fn(),
  withConnection: vi.fn(),
}));
vi.mock('h3', async (original) => ({ ...(await original<typeof H3>()), readBody: async (event: { body: unknown }) => event.body }));
vi.mock('@balanceframe/workflow-store', async (original) => ({
  ...(await original<typeof WorkflowStorePackage>()),
  // Vitest hoists this mock; load the package source so tests do not use stale workspace output.
  SqliteWorkflowStore: (await import('../../../../packages/workflow-store/src/store')).SqliteWorkflowStore,
}));
vi.mock('../../server/utils/mutation-executor', () => ({
  createMutationConnectionManager: () => ({
    loadConfig: sdk.loadConfig,
    withConnection: sdk.withConnection,
  }),
}));

const snapshot = canonicalProtocolSnapshotSchema.parse(fixture);
const transaction = snapshot.transactions[0]!;
const categoryId = snapshot.transactions[1]!.categoryId!;
const SERVER_URL = 'https://actual.review-scope.example.test';
const actorId = 'scoped-review-human';
const now = '2098-01-01T12:00:00.000Z';
const human = { method: 'human-session' as const, actorId: 'owner', sessionId: 'owner-session', reauthenticatedAt: now };
let store: SqliteWorkflowStore;
let selectedSpace = '';
let membershipId = '';
let initialized = false;
let sequence = 0;
function request(reviewId: string) {
  return {
    body: { reviewId },
    node: {
      req: { headers: { origin: 'https://balanceframe.example.test', 'x-balanceframe-space': selectedSpace } },
      res: { statusCode: 200, statusMessage: '', setHeader: vi.fn(), getHeader: vi.fn() },
    },
    context: { auth: { authenticated: true, method: 'session' as const, actorId, principalType: 'human' as const, user: { id: actorId }, sessionId: 'review-session' }, runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false } },
  };
}
function grant(resourceKind: 'budget' | 'account' | 'category' | 'transaction', resourceId: string, restrictions = {}, granted = true) {
  store.governance.setResourceGrant({ spaceId: selectedSpace, actorId, budgetId: sdk.budgetId, membershipId, resourceKind, resourceId, capability: 'categorization:execute', restrictions, granted, now, auth: human });
}
function grantAll(restrictions = {}) {
  grant('budget', sdk.budgetId, restrictions);
  grant('account', transaction.accountId, restrictions);
  grant('transaction', transaction.id, restrictions);
  grant('category', categoryId, restrictions);
  if (transaction.categoryId && transaction.categoryId !== categoryId)
    grant('category', transaction.categoryId, restrictions);
}
async function pending(includeSourceTransaction = true) {
  if (includeSourceTransaction)
    return nativeReviewFixture(store, {
      scope: { spaceId: selectedSpace, budgetId: sdk.budgetId, connectionId: merchantConnectionId({ budgetId: sdk.budgetId, serverUrl: SERVER_URL }) },
      transaction,
      categoryId,
    });
  let item = await store.createReviewItem({
    budgetId: sdk.budgetId,
    transactionId: transaction.id,
    categoryId,
    classifier: 'fixture',
    provenance: 'canonical-fixture',
  });
  for (const toStatus of ['suggestion_generated', 'pending_review'] as const)
    item = await store.transitionInternalReviewItem(item.id, { toStatus, actor: 'system', expectedVersion: item.version });
  return item;
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.example.test');
  sdk.budgetId = `scoped-review-budget-${++sequence}`;
  sdk.loadConfig.mockReset();
  sdk.loadConfig.mockResolvedValue({ budgetId: sdk.budgetId, serverUrl: SERVER_URL });
  sdk.synchronize.mockReset();
  sdk.synchronize.mockResolvedValue({ snapshot, rulePlanningSourceAvailability: completeNativeRuleSourceAvailability(snapshot) });
  sdk.withConnection.mockReset();
  sdk.withConnection.mockImplementation(async (callback: (connected: unknown) => Promise<unknown>) =>
    callback({ config: { budgetId: sdk.budgetId, serverUrl: SERVER_URL }, budget: { id: sdk.budgetId }, connector: { synchronize: sdk.synchronize } }),
  );
  const opened = getWorkflowStore(request('') as unknown as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  if (!initialized) {
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'scoped-review' });
    await store.finalizeBootstrap({ claimId: 'scoped-review', ownerUserId: 'owner' });
    await store.upsertActorMembership('owner', 'active', [], 'unscoped');
    await store.upsertActorMembership(actorId, 'active', [], 'unscoped');
    initialized = true;
  }
  const space = store.governance.createSpace({ actorId: 'owner', name: 'Scoped review', kind: 'shared', now, auth: human });
  selectedSpace = store.governance.bindBudget({ spaceId: space.id, budgetId: sdk.budgetId, now, auth: human }).id;
  membershipId = store.governance.addMembership({ spaceId: selectedSpace, actorId, validFrom: now, now, auth: human }).id;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(() => store.close());

describe('source non-ledger review action authorization', () => {
  it.each(['reject', 'skip'] as const)('does not let budget-only execute authority %s an ungranted transaction', async (action) => {
    grant('budget', sdk.budgetId);
    const item = await pending();
    const event = request(item.id);
    const result = await handleReviewWorkflowAction(event as unknown as ReauthenticationEvent, action);
    expect(event.node.res.statusCode).toBe(404);
    expect(result.result).toBeNull();
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });
  it.each([true, false])('hides an inaccessible review item like an unknown ID before connection config (stored source facts: %s)', async (includeSourceTransaction) => {
    grant('budget', sdk.budgetId);
    const item = await pending(includeSourceTransaction);
    const inaccessibleEvent = request(item.id);
    const inaccessible = await handleReviewWorkflowAction(
      inaccessibleEvent as unknown as ReauthenticationEvent,
      'reject',
    );
    const unknownEvent = request('review-item-that-does-not-exist');
    const unknown = await handleReviewWorkflowAction(
      unknownEvent as unknown as ReauthenticationEvent,
      'reject',
    );

    expect({
      status: inaccessibleEvent.node.res.statusCode,
      code: inaccessible.error?.code,
      message: inaccessible.error?.message,
    }).toEqual({
      status: unknownEvent.node.res.statusCode,
      code: unknown.error?.code,
      message: unknown.error?.message,
    });
    expect(inaccessibleEvent.node.res.statusCode).toBe(404);
    expect(sdk.loadConfig).not.toHaveBeenCalled();
    expect(sdk.withConnection).not.toHaveBeenCalled();
    expect(sdk.synchronize).not.toHaveBeenCalled();
    expect(JSON.stringify(inaccessible)).not.toContain(item.transactionId);
    if (transaction.payeeName) expect(JSON.stringify(inaccessible)).not.toContain(transaction.payeeName);
    if (transaction.categoryId) expect(JSON.stringify(inaccessible)).not.toContain(transaction.categoryId);
    expect(JSON.stringify(inaccessible)).not.toContain(categoryId);
  });
  it('rechecks a revoked account grant at the native commit, after trusted SDK facts were captured', async () => {
    grantAll();
    const item = await pending();
    sdk.synchronize.mockImplementation(async () => { grant('account', transaction.accountId, {}, false); return { snapshot, rulePlanningSourceAvailability: completeNativeRuleSourceAvailability(snapshot) }; });
    const event = request(item.id);
    const result = await handleReviewWorkflowAction(event as unknown as ReauthenticationEvent, 'skip');
    expect(event.node.res.statusCode).toBe(403);
    expect(result.result).toBeNull();
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });
  it('keeps exact authorized human triage separate from ledger approval and execution', async () => {
    grantAll({ operations: ['reject_review'] });
    const item = await pending();
    const event = request(item.id);
    const result = await handleReviewWorkflowAction(event as unknown as ReauthenticationEvent, 'reject');
    expect(event.node.res.statusCode).toBe(200);
    expect(result.result).toMatchObject({ itemId: item.id, applied: false, categorizationExecuted: false });
    expect((await store.getReviewItem(item.id))?.status).toBe('rejected');
    expect((await store.getReviewActions(item.id)).at(-1)?.actor).toBe(actorId);
  });
  it('admits an exact named proposal through a proposal-only operation-restricted grant without granting read or execute authority', async () => {
    store.governance.setResourceGrant({
      spaceId: selectedSpace, actorId, budgetId: sdk.budgetId, membershipId,
      resourceKind: 'budget', resourceId: sdk.budgetId, capability: 'categorization:propose',
      restrictions: { proposalOnly: true, operations: ['set_category'] },
      granted: true, now, auth: human,
    });
    const allowed = await requireProposalAuthorization(
      request('') as unknown as EventWithContext, 'categorization:propose', `budget:${sdk.budgetId}`, 'set_category',
    );
    expect(allowed.ok).toBe(true);
    const denied = await requireProposalAuthorization(
      request('') as unknown as EventWithContext, 'categorization:propose', `budget:${sdk.budgetId}`, 'create_rule',
    );
    expect(denied.ok).toBe(false);
    const item = await pending();
    const event = request(item.id);
    const hidden = await handleReviewWorkflowAction(event as unknown as ReauthenticationEvent, 'reject');
    const unknownEvent = request('unknown-review-id');
    const unknown = await handleReviewWorkflowAction(unknownEvent as unknown as ReauthenticationEvent, 'reject');
    expect(event.node.res.statusCode).toBe(404);
    expect(unknownEvent.node.res.statusCode).toBe(404);
    expect(hidden.error).toEqual(unknown.error);
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });
});
