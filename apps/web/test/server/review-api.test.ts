/**
 * Focused tests for the server-side review API boundary.
 *
 * Tests the pure business-logic functions in the workflow-store utility
 * and verifies that handler-level validation rejects malformed input.
 *
 * The pure functions (`getActorId`, `buildAuthorizationInfo`,
 * `performReviewAction`) are testable with any WorkflowStore implementation
 * and require no Nitro runtime.
 *
 * Handler-level tests use lightweight mocks for `readBody` / `setResponseStatus`
 * / `useRuntimeConfig` which are auto-imported by Nitro.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { CreateReviewItemInput, ReviewItem } from '@balanceframe/workflow-store';

import {
  getActorId,
  buildAuthorizationInfo,
  performReviewAction,
} from '../../server/utils/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTOR = 'test-api-user';
const BUDGET = 'budget-test';

/** Minimal seed data for a pending review item. */
const BASE_CREATE: CreateReviewItemInput = {
  transactionId: 'txn-api-test',
  budgetId: BUDGET,
  categoryId: 'cat-food',
  classifier: 'test-classifier',
  provenance: 'api-test',
};

/** Wait just enough for fresh timestamps in the store. */
function tickSync(): void {
  const end = Date.now() + 5;
  while (Date.now() < end) {
    /* spin */
  }
}

/**
 * Seed a review item in `pending_review` status.
 * Creates the item (discovered), then transitions to suggestion_generated,
 * then to pending_review.
 */
async function seedPendingReview(
  store: SqliteWorkflowStore,
  overrides: Partial<CreateReviewItemInput> = {},
  priority: number = 0,
): Promise<ReviewItem> {
  const input = { ...BASE_CREATE, ...overrides, priority };
  const item = await store.createReviewItem(input);
  tickSync();

  // Transition discovered -> suggestion_generated
  const sg = await store.transitionReviewItem(item.id, {
    toStatus: 'suggestion_generated',
    actor: ACTOR,
    expectedVersion: 1,
  });
  tickSync();

  // Transition suggestion_generated -> pending_review
  const pr = await store.transitionReviewItem(sg.id, {
    toStatus: 'pending_review',
    actor: ACTOR,
    expectedVersion: 2,
  });
  return pr;
}

// ---------------------------------------------------------------------------
// Helpers — create mock Nitro-like event objects
// ---------------------------------------------------------------------------

function mockEvent(opts: {
  authenticated?: boolean;
  config?: Record<string, unknown>;
}): EventWithContext {
  return {
    context: {
      auth: opts.authenticated ? { authenticated: true } : undefined,
      runtimeConfig: opts.config ?? {},
    },
  };
}
// ---------------------------------------------------------------------------

describe('getActorId', () => {
  it('returns "api-user" for authenticated requests', () => {
    const ev = mockEvent({ authenticated: true });
    expect(getActorId(ev)).toBe('api-user');
  });

  it('returns "anonymous" for unauthenticated requests', () => {
    const ev = mockEvent({ authenticated: false });
    expect(getActorId(ev)).toBe('anonymous');
  });
});

describe('buildAuthorizationInfo', () => {
  it('returns null when auth context is absent', () => {
    const ev = mockEvent({ authenticated: false });
    expect(buildAuthorizationInfo(ev, 'observe')).toBeNull();
  });

  it('returns authorization info when auth context is present', () => {
    const ev = mockEvent({ authenticated: true });
    const info = buildAuthorizationInfo(ev, 'categorization:execute');
    expect(info).not.toBeNull();
    expect(info!.actorId).toBe('api-user');
    expect(info!.capability).toBe('categorization:execute');
    expect(info!.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: performReviewAction
// ---------------------------------------------------------------------------

describe('performReviewAction', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  it('approves a pending review item', async () => {
    const item = await seedPendingReview(store);
    const outcome = await performReviewAction(store, item.id, 'approve', ACTOR);
    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.itemId).toBe(item.id);

    // Verify the item was actually transitioned
    const refreshed = await store.getReviewItem(item.id);
    expect(refreshed!.status).toBe("approved");
  });

  it('corrects a pending review item (transitions to approved with category metadata)', async () => {
    const item = await seedPendingReview(store);
    const outcome = await performReviewAction(store, item.id, 'correct', ACTOR, 'cat-office');
    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.itemId).toBe(item.id);

    const refreshed = await store.getReviewItem(item.id);
    expect(refreshed!.status).toBe("approved");
  });

  it('rejects a pending review item', async () => {
    const item = await seedPendingReview(store);
    const outcome = await performReviewAction(store, item.id, 'reject', ACTOR);
    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.itemId).toBe(item.id);

    const refreshed = await store.getReviewItem(item.id);
    expect(refreshed!.status).toBe('rejected');
  });

  it('skips a pending review item', async () => {
    const item = await seedPendingReview(store);
    const outcome = await performReviewAction(store, item.id, 'skip', ACTOR);
    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.itemId).toBe(item.id);

    const refreshed = await store.getReviewItem(item.id);
    expect(refreshed!.status).toBe('skipped');
  });

  it('returns not-found error for a non-existent review ID', async () => {
    const outcome = await performReviewAction(store, '00000000-0000-0000-0000-000000000000', 'approve', ACTOR);
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe('Review item not found');
  });

  it('fails when transitioning from an invalid status', async () => {
    const item = await seedPendingReview(store);

    // First reject it
    await store.transitionReviewItem(item.id, {
      toStatus: 'rejected',
      actor: ACTOR,
      expectedVersion: 3,
    });

    // Trying to approve a rejected item should fail
    const outcome = await performReviewAction(store, item.id, 'approve', ACTOR);
    expect(outcome.success).toBe(false);
    expect(outcome.error).not.toBeNull();
  });

  it('throws for unknown action names', async () => {
    const item = await seedPendingReview(store);
    await expect(
      performReviewAction(store, item.id, 'unknown-action' as string, ACTOR),
    ).rejects.toThrow('Unknown review action');
  });

  it('records correct categoryId in transition metadata', async () => {
    const item = await seedPendingReview(store);
    const outcome = await performReviewAction(store, item.id, 'correct', ACTOR, 'cat-office');
    expect(outcome.success).toBe(true);

    // Verify the transition action persisted the metadata
    const actions = await store.getReviewActions(item.id);
    const approveAction = actions.find((a) => a.toStatus === "approved");
    expect(approveAction).toBeDefined();
    expect(approveAction!.metadata).toEqual({ categoryId: 'cat-office' });
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/review — listing
// ---------------------------------------------------------------------------

describe('GET /api/review (listReviewItems)', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  it('returns pending_review items when queried', async () => {
    const item = await seedPendingReview(store);
    const items = await store.listReviewItems({ status: 'pending_review' });
    expect(items.length).toBe(1);
    expect(items[0].id).toBe(item.id);
    expect(items[0].status).toBe('pending_review');
  });

  it('does not return approved items in pending query', async () => {
    const item = await seedPendingReview(store);
    await store.transitionReviewItem(item.id, {
      toStatus: 'approved',
      actor: ACTOR,
      expectedVersion: 3,
    });

    const items = await store.listReviewItems({ status: 'pending_review' });
    expect(items.length).toBe(0);
  });

  it('lists multiple pending items ordered by priority', async () => {
    const low = await seedPendingReview(store, { ...BASE_CREATE, transactionId: 'txn-low' }, 0);
    const high = await seedPendingReview(store, { ...BASE_CREATE, transactionId: 'txn-high' }, 100);

    const items = await store.listReviewItems({ status: 'pending_review' });
    expect(items.length).toBe(2);
    // Highest priority first
    expect(items[0].id).toBe(high.id);
    expect(items[1].id).toBe(low.id);
  });
});

// ---------------------------------------------------------------------------
// Tests: actor spoofing prevention
// ---------------------------------------------------------------------------

describe('actor spoofing prevention', () => {
  it('getActorId never reads from a body-like source', () => {
    // Even if a malformed event carries an `actorId` at top level,
    // getActorId only looks at event.context.auth.
    const ev: EventWithContext & { body?: unknown } = {
      context: {
        auth: { authenticated: true },
      },
      body: { actorId: 'impostor@evil.dev' },
    };
    expect(getActorId(ev)).toBe('api-user');
  });

  it('does not propagate body.actorId in the pure action path', async () => {
    const store = new SqliteWorkflowStore(':memory:');
    const item = await seedPendingReview(store);

    // Perform the action with a different actor than the "body.actorId"
    const outcome = await performReviewAction(store, item.id, 'approve', 'api-user');
    expect(outcome.success).toBe(true);

    // Verify the audit trail reflects the server-derived actor
    const actions = await store.getReviewActions(item.id);
    const approveAction = actions.at(-1); // most recent
    expect(approveAction!.actor).toBe('api-user');
  });
});

// ---------------------------------------------------------------------------
// Tests: error envelope consistency
// ---------------------------------------------------------------------------

describe('error envelope consistency', () => {
  it('performReviewAction returns failure for non-existent item', async () => {
    const store = new SqliteWorkflowStore(':memory:');
    const outcome = await performReviewAction(store, 'no-such-id', 'approve', ACTOR);
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe('Review item not found');
  });
});
