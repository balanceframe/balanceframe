import type { ConnectionManager, ConnectionUseOptions } from '@balanceframe/application';
import type { EventWithContext } from '../../server/utils/workflow-store';
import type { ReviewItem } from '@balanceframe/workflow-store';
import { afterAll, describe, it, expect, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { createNativeCategorizationMutationProtocol } from '@balanceframe/application';
import { merchantConnectionId } from '../../../../packages/application/src/merchant-service';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import { createDefaultExecutorFactory } from '../../server/utils/mutation-executor';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import fixture from '../../../../protocol/fixtures/representative.json';
import { nativeReviewFixture } from './native-review.fixture';
import { completeNativeRuleSourceAvailability } from './native-rule-source.fixture';
let providerStore: SqliteWorkflowStore | null = null;
let bootstrapInitialized = false;
let fixtureSequence = 0;

afterAll(() => providerStore?.close());


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ACTOR = 'test-actor';
const canonicalFixture = canonicalProtocolSnapshotSchema.parse(fixture);
const nativeTransaction = canonicalFixture.transactions.find((candidate) => candidate.categoryId !== null);
if (!nativeTransaction?.categoryId) throw new Error('Native fixture transaction is missing a current category');
const nativeTargetCategory = canonicalFixture.categories.find(
  (category) => category.id !== nativeTransaction.categoryId && !category.deleted,
);
if (!nativeTargetCategory) throw new Error('Native fixture target category is missing');
const TEST_TX_ID = nativeTransaction.id;
const sourceAmount = BigInt(nativeTransaction.amount.minorUnits);
const sourceTransaction = {
  id: nativeTransaction.id,
  accountId: nativeTransaction.accountId,
  categoryId: nativeTransaction.categoryId,
  direction: sourceAmount < 0n ? 'outgoing' as const : 'incoming' as const,
  amount: {
    minorUnits: (sourceAmount < 0n ? -sourceAmount : sourceAmount).toString(),
    currency: nativeTransaction.amount.currency,
  },
};

function mockEvent(config?: Record<string, unknown>): EventWithContext {
  return {
    context: {
      auth: { authenticated: true, actorId: TEST_ACTOR },
      runtimeConfig: config ?? {},
    },
  };
}


function fakeReviewItem(
  overrides: Partial<{
    id: string;
    transactionId: string;
    budgetId: string;
    categoryId: string;
    classifier: string;
    provenance: string;
    status: string;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    evidence: Record<string, unknown>;
  }> = {},
): ReviewItem {
  return {
    id: 'review-001',
    transactionId: TEST_TX_ID,
    budgetId: 'budget-1',
    categoryId: 'cat-food',
    classifier: 'test',
    promptVersion: '1.0',
    transactionVersion: 1,
    status: 'approved',
    correlationId: null,
    assignedReviewerId: null,
    approvedBy: [TEST_ACTOR],
    reviewersRequired: 1,
    priority: 0,
    evidence: {},
    sourceTransaction,
    provenance: 'test',
    supersededBy: null,
    supersededReason: null,
    freshnessExpiresAt: null,
    version: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const TEST_BUDGET_ID = 'budget-native-proposal';
const TEST_ACCOUNT_ID = nativeTransaction.accountId;
const TEST_CURRENT_CATEGORY = nativeTransaction.categoryId;
const TEST_TARGET_CATEGORY = nativeTargetCategory.id;
const TEST_SPACE_OWNER = 'space-owner';
const SERVER_URL = 'https://actual.mutation-composition.example.test';

async function createGovernedExecutorFixture(withProposalGrants = true) {
  const now = new Date().toISOString();
  const ownerAuth = {
    method: 'human-session' as const,
    actorId: TEST_SPACE_OWNER,
    sessionId: `session:${TEST_SPACE_OWNER}`,
    reauthenticatedAt: now,
  };
  const responseHeaders = new Map<string, string>();
  const requestEvent = {
    node: {
      req: { headers: {} as Record<string, string> },
      res: {
        statusCode: 200,
        setHeader: (name: string, value: string) => responseHeaders.set(name.toLowerCase(), value),
        getHeader: (name: string) => responseHeaders.get(name.toLowerCase()),
      },
    },
    context: {
      auth: {
        authenticated: true,
        actorId: TEST_ACTOR,
        method: 'session' as const,
        principalType: 'human' as const,
        sessionId: `session:${TEST_ACTOR}`,
        user: { id: TEST_ACTOR },
      },
      runtimeConfig: { workflowDbPath: ':memory:', reviewAndApply: true },
    },
  };
  const workflow = getWorkflowStore(requestEvent as unknown as EventWithContext);
  if ('error' in workflow) throw new Error(workflow.error);
  const store = workflow.store;
  providerStore = store;
  if (!bootstrapInitialized) {
    await store.claimBootstrap({
      name: 'Space owner',
      email: 'owner@example.test',
      claimId: 'mutation-executor-native-fixture',
    });
    await store.finalizeBootstrap({
      claimId: 'mutation-executor-native-fixture',
      ownerUserId: TEST_SPACE_OWNER,
    });
    bootstrapInitialized = true;
  }

  const budgetId = `${TEST_BUDGET_ID}-${++fixtureSequence}`;
  const space = store.governance.createSpace({
    actorId: TEST_SPACE_OWNER,
    name: 'Native mutation proposal',
    kind: 'shared',
    now,
    auth: ownerAuth,
  });
  store.governance.bindBudget({ spaceId: space.id, budgetId, now, auth: ownerAuth });
  await store.upsertActorMembership(TEST_ACTOR, 'active', [], '');
  const membership = store.governance.addMembership({
    spaceId: space.id,
    actorId: TEST_ACTOR,
    validFrom: now,
    now,
    auth: ownerAuth,
  });
  if (withProposalGrants) {
    for (const resource of [
      { resourceKind: 'budget' as const, resourceId: budgetId },
      { resourceKind: 'transaction' as const, resourceId: TEST_TX_ID },
      { resourceKind: 'account' as const, resourceId: TEST_ACCOUNT_ID },
      { resourceKind: 'category' as const, resourceId: TEST_CURRENT_CATEGORY },
      { resourceKind: 'category' as const, resourceId: TEST_TARGET_CATEGORY },
    ]) {
      store.governance.provisionResourceGrant({
        spaceId: space.id,
        actorId: TEST_ACTOR,
        membershipId: membership.id,
        budgetId,
        capability: 'categorization:propose',
        ...resource,
        granted: true,
        now,
      });
    }
  }
  requestEvent.node.req.headers['x-balanceframe-space'] = space.id;
  const synchronize = vi.fn().mockResolvedValue({
    snapshot: structuredClone(canonicalFixture),
    rulePlanningSourceAvailability: completeNativeRuleSourceAvailability(canonicalFixture),
  });
  const connected = {
    config: { budgetId, serverUrl: SERVER_URL },
    budget: { id: budgetId },
    connector: { synchronize },
  };
  const manager = {
    loadConfig: vi.fn().mockResolvedValue({ budgetId, serverUrl: SERVER_URL }),
    withConnection: vi.fn(async (
      operation: (connection: typeof connected) => Promise<unknown>,
      _options?: ConnectionUseOptions,
    ) => operation(connected)),
  };
  const factory = createDefaultExecutorFactory(manager as unknown as ConnectionManager);
  const executor = factory(requestEvent as unknown as EventWithContext);
  if (!executor) throw new Error('Review-and-apply executor was not configured');
  return { store, space, budgetId, manager, synchronize, executor };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDefaultExecutorFactory', () => {
  it('returns null when reviewAndApply is not configured (observe default)', () => {
    const factory = createDefaultExecutorFactory();
    const ev = mockEvent({});
    const executor = factory(ev);
    expect(executor).toBeNull();
  });

  it('returns null when reviewAndApply is explicitly false', () => {
    const factory = createDefaultExecutorFactory();
    const ev = mockEvent({ reviewAndApply: false });
    const executor = factory(ev);
    expect(executor).toBeNull();
  });



  it('rethrows connection-selection errors after current scope authorization', async () => {
    const fixture = await createGovernedExecutorFixture();
    const missingSelection = Object.assign(new Error('No BalanceFrame connection configured.'), {
      code: 'not_connected',
    });
    fixture.manager.withConnection.mockRejectedValue(missingSelection);
    const item = fakeReviewItem({
      transactionId: TEST_TX_ID,
      budgetId: fixture.budgetId,
      categoryId: TEST_TARGET_CATEGORY,
    });

    await expect(
      fixture.executor(
        { reviewId: item.id, actorId: TEST_ACTOR, requestId: 'connection-selection-error' },
        fixture.store,
        item,
      ),
    ).rejects.toBe(missingSelection);
  });

  it('returns a safe failure result for ordinary connection errors', async () => {
    const fixture = await createGovernedExecutorFixture();
    fixture.manager.withConnection.mockRejectedValue(new Error('Could not read Actual configuration.'));
    const item = fakeReviewItem({
      transactionId: TEST_TX_ID,
      budgetId: fixture.budgetId,
      categoryId: TEST_TARGET_CATEGORY,
    });

    const result = await fixture.executor(
      { reviewId: item.id, actorId: TEST_ACTOR, requestId: 'ordinary-connection-error' },
      fixture.store,
      item,
    );

    expect(result).toMatchObject({
      disposition: 'failed',
      mutationStatus: 'denied',
      success: false,
      error: 'Native proposal could not be created',
    });
  });

  it('creates an exact native proposal only with current grants in the selected scope', async () => {
    const fixture = await createGovernedExecutorFixture();
    const nativeItem = await nativeReviewFixture(fixture.store, {
      scope: {
        spaceId: fixture.space.id,
        budgetId: fixture.budgetId,
        connectionId: merchantConnectionId({ budgetId: fixture.budgetId, serverUrl: SERVER_URL }),
      },
      transaction: nativeTransaction,
      categoryId: TEST_TARGET_CATEGORY,
    });
    fixture.store['db'].prepare('UPDATE review_items SET evidence=? WHERE id=?')
      .run(JSON.stringify({ ...nativeItem.evidence, currentCategory: 'untrusted-review-evidence' }), nativeItem.id);
    const item = await fixture.store.getReviewItem(nativeItem.id);
    if (!item) throw new Error('Native review fixture disappeared');
    const native = await createNativeCategorizationMutationProtocol();
    const nativePlan = native.planSetCategory(nativeTransaction, nativeTargetCategory);
    const result = await fixture.executor(
      { reviewId: item.id, actorId: TEST_ACTOR, requestId: 'native-proposal-request' },
      fixture.store,
      item,
    );

    expect(result.error).toBeNull();
    expect(result).toMatchObject({
      disposition: 'approval_required',
      mutationStatus: 'approval_required',
      applied: false,
      verified: false,
    });
    const proposal = await fixture.store.findActiveProposal(fixture.budgetId, TEST_TX_ID, 'set_category');
    if (!proposal) throw new Error('Native proposal was not persisted');
    expect(proposal).toMatchObject({
      spaceId: fixture.space.id,
      payload: {
        kind: 'set_category',
        transactionId: TEST_TX_ID,
        categoryId: TEST_TARGET_CATEGORY,
        composite: { nativePayloadHash: nativePlan.hash },
      },
    });
    expect(JSON.parse(proposal.preconditions)).toMatchObject({
      reviewId: item.id,
      currentCategoryId: TEST_CURRENT_CATEGORY,
      transaction: {
        id: TEST_TX_ID,
        accountId: TEST_ACCOUNT_ID,
        categoryId: TEST_CURRENT_CATEGORY,
      },
      nativePlan,
    });
    expect(await fixture.store.getReviewItem(item.id)).toMatchObject({
      id: item.id,
      status: 'pending_review',
      version: item.version,
    });
  });

  it('denies a selected budget without its explicit grant before reading native ledger data', async () => {
    const fixture = await createGovernedExecutorFixture(false);
    const item = fakeReviewItem({
      transactionId: TEST_TX_ID,
      budgetId: fixture.budgetId,
      categoryId: TEST_TARGET_CATEGORY,
    });
    const result = await fixture.executor(
      { reviewId: item.id, actorId: TEST_ACTOR, requestId: 'hidden-budget-request' },
      fixture.store,
      item,
    );

    expect(result.disposition).toBe('denied');
    expect(fixture.manager.withConnection).not.toHaveBeenCalled();
    expect(fixture.synchronize).not.toHaveBeenCalled();
    expect(await fixture.store.findActiveProposal(fixture.budgetId, TEST_TX_ID, 'set_category'))
      .toBeNull();
  });
});
