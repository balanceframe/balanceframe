import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteWorkflowStore } from '../../../../packages/workflow-store/src/store';
import type {
  CreateReviewItemInput,
  ReviewActionAuthorization,
  ReviewItem,
} from '@balanceframe/workflow-store';
import fixture from '../../../../protocol/fixtures/representative.json';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { getActorId, performReviewAction } from '../../server/utils/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { projectReviewQueueItem } from '../../server/utils/review-projection';

const ACTOR = 'test-api-user';
const OWNER = 'review-api-owner';
const BUDGET = 'budget-test';
const canonicalSnapshot = canonicalProtocolSnapshotSchema.parse(fixture);
const transaction = canonicalSnapshot.transactions[0]!;
const currentCategoryId = transaction.categoryId!;
const targetCategoryId = canonicalSnapshot.transactions[1]!.categoryId!;
const privateCategoryId = 'private-category';
const BASE_CREATE: CreateReviewItemInput = {
  transactionId: transaction.id,
  budgetId: BUDGET,
  categoryId: targetCategoryId,
  classifier: 'test-classifier',
  provenance: 'api-test',
};
let now: string;
let ownerAuth: {
  method: 'human-session';
  actorId: string;
  sessionId: string;
  reauthenticatedAt: string;
};

let store: SqliteWorkflowStore;
let spaceId: string;
let membershipId: string;
let policyVersion: string;

async function seedPendingReview(
  overrides: Partial<CreateReviewItemInput> = {},
  priority = 0,
): Promise<ReviewItem> {
  let item = await store.createReviewItem({ ...BASE_CREATE, ...overrides, priority });
  for (const toStatus of ['suggestion_generated', 'pending_review'] as const) {
    item = await store.transitionInternalReviewItem(item.id, {
      toStatus,
      actor: 'trusted-fixture',
      expectedVersion: item.version,
    });
  }
  return item;
}

function setGrant(resourceKind: 'budget' | 'account' | 'category' | 'transaction', resourceId: string, capability: string) {
  store.governance.setResourceGrant({
    spaceId,
    actorId: ACTOR,
    budgetId: BUDGET,
    membershipId,
    resourceKind,
    resourceId,
    capability,
    granted: true,
    now,
    auth: ownerAuth,
  });
}

function authorization(): ReviewActionAuthorization {
  const signedAmount = BigInt(transaction.amount.minorUnits);
  return {
    spaceId,
    policyVersion,
    auth: { method: 'session', actorId: ACTOR, sessionId: 'session:test-api-user' },
    transaction: {
      id: transaction.id,
      accountId: transaction.accountId,
      categoryId: currentCategoryId,
      direction: signedAmount < 0n ? 'outgoing' : 'incoming',
      amount: {
        minorUnits: (signedAmount < 0n ? -signedAmount : signedAmount).toString(),
        currency: transaction.amount.currency,
      },
    },
  };
}

function grantReviewAction(categoryId = targetCategoryId) {
  for (const [kind, id] of [
    ['budget', BUDGET],
    ['transaction', transaction.id],
    ['account', transaction.accountId],
    ['category', categoryId],
    ['category', currentCategoryId],
  ] as const) setGrant(kind, id, 'categorization:execute');
}

function grantProjectionResources() {
  for (const [kind, id, capability] of [
    ['account', transaction.accountId, 'existence'],
    ['account', transaction.accountId, 'history'],
    ['account', transaction.accountId, 'name'],
    ['category', currentCategoryId, 'existence'],
    ['category', currentCategoryId, 'name'],
    ['category', targetCategoryId, 'existence'],
    ['category', targetCategoryId, 'name'],
  ] as const) setGrant(kind, id, capability);
}

beforeEach(async () => {
  now = new Date().toISOString();
  ownerAuth = {
    method: 'human-session',
    actorId: OWNER,
    sessionId: 'session:review-api-owner',
    reauthenticatedAt: now,
  };
  store = new SqliteWorkflowStore(':memory:');
  await store.claimBootstrap({
    name: 'Review API owner',
    email: 'review-api-owner@example.test',
    claimId: 'review-api-fixture',
  });
  await store.finalizeBootstrap({ claimId: 'review-api-fixture', ownerUserId: OWNER });
  const space = store.governance.createSpace({
    actorId: OWNER,
    name: 'Review API fixture',
    kind: 'shared',
    now,
    auth: ownerAuth,
  });
  spaceId = space.id;
  store.governance.bindBudget({ spaceId, budgetId: BUDGET, now, auth: ownerAuth });
  await store.upsertActorMembership(ACTOR, 'active', [], '');
  membershipId = store.governance.addMembership({
    spaceId,
    actorId: ACTOR,
    validFrom: now,
    now,
    auth: ownerAuth,
  }).id;
  policyVersion = store.governance.getPolicy({ spaceId })!.version;
  grantReviewAction();
});

afterEach(() => store.close());

describe('trusted review identity and non-ledger actions', () => {
  it('uses the authenticated human identity, never legacy or body identity', () => {
    const event = {
      body: { actorId: 'body-attacker' },
      context: {
        auth: {
          authenticated: true,
          actorId: 'legacy-attacker',
          user: { id: ACTOR },
          method: 'session',
          principalType: 'human',
          sessionId: 'session:test-api-user',
          impersonatedBy: null,
        },
      },
    } as unknown as EventWithContext & { body: unknown };
    expect(getActorId(event)).toBe(ACTOR);
  });

  it.each([
    ['reject', 'rejected'],
    ['skip', 'skipped'],
  ] as const)('%s records one scoped Native transition without applying a ledger mutation', async (action, status) => {
    const item = await seedPendingReview();
    const outcome = await performReviewAction(store, item.id, action, ACTOR, authorization());

    expect(outcome).toMatchObject({ success: true, status, error: null });
    expect((await store.getReviewItem(item.id))?.status).toBe(status);
    expect((await store.getReviewActions(item.id)).at(-1)?.actor).toBe(ACTOR);
  });

  it('undo returns a skipped item to the queue under the same current scope', async () => {
    const item = await seedPendingReview();
    await performReviewAction(store, item.id, 'skip', ACTOR, authorization());
    const outcome = await performReviewAction(store, item.id, 'undo', ACTOR, authorization());

    expect(outcome).toMatchObject({ success: true, status: 'pending_review' });
    expect((await store.getReviewItem(item.id))?.status).toBe('pending_review');
  });

  it('does not transition when a review grant has been revoked', async () => {
    const item = await seedPendingReview();
    store.governance.setResourceGrant({
      spaceId,
      actorId: ACTOR,
      budgetId: BUDGET,
      membershipId,
      resourceKind: 'transaction',
      resourceId: transaction.id,
      capability: 'categorization:execute',
      granted: false,
      now,
      auth: ownerAuth,
    });

    await expect(performReviewAction(store, item.id, 'reject', ACTOR, authorization()))
      .rejects.toMatchObject({ cause: 'authorization_denied' });
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });

  it('reports an invalid transition without changing the rejected item', async () => {
    const item = await seedPendingReview();
    await performReviewAction(store, item.id, 'reject', ACTOR, authorization());

    const outcome = await performReviewAction(store, item.id, 'skip', ACTOR, authorization());

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("from 'rejected'");
    expect((await store.getReviewItem(item.id))?.status).toBe('rejected');
  });
});

describe('review queue Native privacy projection', () => {
  it('returns only independently granted current facts and denies an ungranted category', async () => {
    grantProjectionResources();
    const item = await seedPendingReview({
      evidence: {
        rawModelInput: 'private-model-input-sentinel',
        alternatives: ['private-alternative-sentinel'],
      },
      provenance: 'private-provider-prompt',
    });
    const snapshot = {
      ...canonicalSnapshot,
      categories: [
        ...canonicalSnapshot.categories,
        { ...canonicalSnapshot.categories[0]!, id: privateCategoryId, name: 'Private category sentinel' },
      ],
    };
    const policy = store.governance.getPolicy({ spaceId })!;
    const actor = {
      actorId: ACTOR,
      budgetId: BUDGET,
      spaceId,
      membershipId,
      governancePolicyVersion: policy.version,
      now,
      auth: { method: 'session' as const, actorId: ACTOR, sessionId: 'session:test-api-user' },
    };

    const projected = projectReviewQueueItem(store, actor, item, snapshot);
    expect(projected).not.toBeNull();
    expect(projected?.evidence).toMatchObject({
      account: canonicalSnapshot.accounts.find(({ id }) => id === transaction.accountId)!.name,
      currentCategory: canonicalSnapshot.categories.find(({ id }) => id === currentCategoryId)!.name,
      suggestedCategory: canonicalSnapshot.categories.find(({ id }) => id === targetCategoryId)!.name,
    });
    expect(JSON.stringify(projected)).not.toContain('private-model-input-sentinel');
    expect(JSON.stringify(projected)).not.toContain('private-alternative-sentinel');
    expect(JSON.stringify(projected)).not.toContain('private-provider-prompt');
    expect(JSON.stringify(projected)).not.toContain('Private category sentinel');
    expect(projected?.evidence.history).toEqual([]);
    expect(projected?.evidence.alternatives).toEqual([]);

    const inaccessible = await seedPendingReview({ categoryId: privateCategoryId });
    expect(projectReviewQueueItem(store, actor, inaccessible, snapshot)).toBeNull();
  });
});
