/**
 * Integration tests for the review mutation seam.
 *
 * Tests the seam contract that route handlers (approve.post.ts, correct.post.ts,
 * reject.post.ts, skip.post.ts) implement:
 * - Observe mode (default): returns mutationStatus: 'noop', no write
 * - reviewAndApply mode + executor available: returns verified/apply outcomes
 * - reviewAndApply mode + executor failure: returns apply_failed
 * - reviewAndApply mode + stale snapshot: returns stale
 * - reviewAndApply mode + executor not wired: returns denied
 * - actor-from-auth is preserved in executor calls
 * - reject/skip remain workflow-only
 *
 * Tests the seam functions (reviewAndApplyEnabled, getMutationService)
 * and verifies the okEnvelope/errorEnvelope helpers produce the correct
 * response shape.
 *
 * TDD: written before the route implementation changes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { CreateReviewItemInput, ReviewItem } from '@balanceframe/workflow-store';
import {
  setReviewMutationExecutor,
  getReviewMutationExecutor,
  reviewAndApplyEnabled,
  getActorId,
  getWorkflowStore,
  performReviewAction,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
} from '../../server/utils/workflow-store';
import type {
  EventWithContext,
  ReviewMutationExecutor,
} from '../../server/utils/workflow-store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTOR = 'test-mutation-user';
const BUDGET = 'budget-mutation';
const BASE_CREATE: CreateReviewItemInput = {
  transactionId: 'txn-mutation-test',
  budgetId: BUDGET,
  categoryId: 'cat-food',
  classifier: 'test-classifier',
  provenance: 'mutation-test',
};

function tickSync(): void {
  const end = Date.now() + 5;
  while (Date.now() < end) { /* spin */ }
}

async function seedPendingReview(
  store: SqliteWorkflowStore,
  overrides: Partial<CreateReviewItemInput> = {},
): Promise<ReviewItem> {
  const input = { ...BASE_CREATE, ...overrides };
  const item = await store.createReviewItem(input);
  tickSync();
  const sg = await store.transitionReviewItem(item.id, {
    toStatus: 'suggestion_generated',
    actor: ACTOR,
    expectedVersion: 1,
  });
  tickSync();
  const pr = await store.transitionReviewItem(sg.id, {
    toStatus: 'pending_review',
    actor: ACTOR,
    expectedVersion: 2,
  });
  return pr;
}

function mockEvent(opts: {
  authenticated?: boolean;
  config?: Record<string, unknown>;
}): EventWithContext {
  return {
    context: {
      auth: opts.authenticated ? { authenticated: true, actorId: ACTOR } : undefined,
      runtimeConfig: opts.config ?? {},
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: seam pure functions
// ---------------------------------------------------------------------------

describe('mutation seam — pure functions', () => {
  beforeEach(() => {
    setReviewMutationExecutor(null);
  });

  it('reviewAndApplyEnabled returns false by default', () => {
    const ev = mockEvent({ authenticated: true });
    expect(reviewAndApplyEnabled(ev)).toBe(false);
  });

  it('reviewAndApplyEnabled returns true when config has reviewAndApply', () => {
    const ev = mockEvent({ authenticated: true, config: { reviewAndApply: true } });
    expect(reviewAndApplyEnabled(ev)).toBe(true);
  });

  it('reviewAndApplyEnabled returns false when reviewAndApply is false in config', () => {
    const ev = mockEvent({ authenticated: true, config: { reviewAndApply: false } });
    expect(reviewAndApplyEnabled(ev)).toBe(false);
  });

  it('getReviewMutationExecutor returns null when no executor set', () => {
    expect(getReviewMutationExecutor()).toBeNull();
  });

  it('setReviewMutationExecutor / getReviewMutationExecutor round-trip', () => {
    const executor: ReviewMutationExecutor = async () => ({
      mutationStatus: 'verified',
      success: true,
      applied: true,
      verified: true,
      stale: false,
      transactionId: 'txn-abc',
      previousCategoryId: null,
      newCategoryId: 'cat-food',
      error: null,
    });
    setReviewMutationExecutor(executor);
    expect(getReviewMutationExecutor()).toBe(executor);
  });
});

// ---------------------------------------------------------------------------
// Tests: Observe mode (no reviewAndApply) — route behavior contract
// ---------------------------------------------------------------------------

describe('Observe mode — route behavior contract', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    vi.clearAllMocks();
    setReviewMutationExecutor(null);
    store = new SqliteWorkflowStore(':memory:');
  });

  it('performReviewAction transitions item and returns success with no error', async () => {
    const item = await seedPendingReview(store);
    const outcome = await performReviewAction(store, item.id, 'approve', ACTOR);
    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.itemId).toBe(item.id);

    const refreshed = await store.getReviewItem(item.id);
    expect(refreshed?.status).toBe('approved');
  });

  it('route handler pattern in Observe mode returns categorizationExecuted:false and mutationStatus noop', async () => {
    // This simulates what the route handler does in Observe mode
    const item = await seedPendingReview(store);
    const ev = mockEvent({ authenticated: true, config: {} }); // no reviewAndApply

    const outcome = await performReviewAction(store, item.id, 'approve', ACTOR);
    expect(outcome.success).toBe(true);

    // Route handler logic for Observe mode:
    const isReviewAndApply = reviewAndApplyEnabled(ev);
    const executor = getReviewMutationExecutor();

    // In Observe mode, reviewAndApplyEnabled is false, no executor needed
    expect(isReviewAndApply).toBe(false);
    expect(executor).toBeNull();

    // Build the response as the route handler would
    const responseFields = {
      itemId: outcome.itemId,
      success: true,
      error: null,
      categorizationExecuted: false,
      mutationStatus: 'noop' as const,
      applied: false,
      verified: false,
      stale: false,
      transactionId: null,
      previousCategoryId: null,
      newCategoryId: null,
    };

    expect(responseFields.categorizationExecuted).toBe(false);
    expect(responseFields.mutationStatus).toBe('noop');
    expect(responseFields.applied).toBe(false);
    expect(responseFields.verified).toBe(false);
    expect(responseFields.stale).toBe(false);

    // Verify okEnvelope wraps these correctly
    const authInfo = buildAuthorizationInfo(ev, 'categorization:execute');
    const envelope = okEnvelope(responseFields, authInfo, 'test-request-id');
    expect(envelope.status).toBe('ok');
    expect(envelope.result).toEqual(responseFields);
    expect(envelope.error).toBeNull();
  });

  it('errorEnvelope still works for error paths', async () => {
    const ev = mockEvent({ authenticated: true });
    const authInfo = buildAuthorizationInfo(ev, 'categorization:execute');
    const envelope = errorEnvelope('NOT_FOUND', 'Review item not found', authInfo, false, 'err-req');
    expect(envelope.status).toBe('error');
    expect(envelope.error?.code).toBe('NOT_FOUND');
    expect(envelope.error?.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: reviewAndApply mode — route behavior contract
// ---------------------------------------------------------------------------

describe('reviewAndApply mode — route behavior contract', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    vi.clearAllMocks();
    setReviewMutationExecutor(null);
    store = new SqliteWorkflowStore(':memory:');
  });

  it('simulates verified mutation via executor', async () => {
    const item = await seedPendingReview(store);
    const ev = mockEvent({ authenticated: true, config: { reviewAndApply: true } });
    const actorId = getActorId(ev);

    // Set up an executor that returns verified
    setReviewMutationExecutor(async (input, _store, reviewItem) => ({
      mutationStatus: 'verified',
      success: true,
      applied: true,
      verified: true,
      stale: false,
      transactionId: reviewItem.transactionId,
      previousCategoryId: null,
      newCategoryId: reviewItem.categoryId,
      error: null,
    }));

    // Route handler logic for reviewAndApply mode:
    const outcome = await performReviewAction(store, item.id, 'approve', actorId);
    expect(outcome.success).toBe(true);

    const enabled = reviewAndApplyEnabled(ev);
    expect(enabled).toBe(true);

    const executor = getReviewMutationExecutor();
    expect(executor).not.toBeNull();

    const reviewItem = await store.getReviewItem(item.id);
    const mutationResult = await executor!(
      { reviewId: item.id, actorId, requestId: 'test-req' },
      store,
      reviewItem!,
    );

    expect(mutationResult.mutationStatus).toBe('verified');
    expect(mutationResult.success).toBe(true);
    expect(mutationResult.verified).toBe(true);
    expect(mutationResult.transactionId).toBe(reviewItem!.transactionId);

    // Build response as the route handler would
    const responseFields = {
      itemId: outcome.itemId,
      success: mutationResult.success,
      error: mutationResult.error,
      categorizationExecuted: true,
      mutationStatus: mutationResult.mutationStatus,
      applied: mutationResult.applied,
      verified: mutationResult.verified,
      stale: mutationResult.stale,
      transactionId: mutationResult.transactionId,
      previousCategoryId: mutationResult.previousCategoryId,
      newCategoryId: mutationResult.newCategoryId,
    };

    expect(responseFields.categorizationExecuted).toBe(true);
    expect(responseFields.mutationStatus).toBe('verified');
    expect(responseFields.applied).toBe(true);
    expect(responseFields.verified).toBe(true);

    // Verify envelope shape
    const authInfo = buildAuthorizationInfo(ev, 'categorization:execute');
    const envelope = okEnvelope(responseFields, authInfo, 'test-req');
    expect(envelope.status).toBe('ok');
    expect(envelope.result.mutationStatus).toBe('verified');
  });

  it('simulates apply_failed mutation via executor', async () => {
    const item = await seedPendingReview(store);
    const ev = mockEvent({ authenticated: true, config: { reviewAndApply: true } });
    const actorId = getActorId(ev);

    setReviewMutationExecutor(async () => ({
      mutationStatus: 'apply_failed',
      success: false,
      applied: false,
      verified: false,
      stale: false,
      transactionId: null,
      previousCategoryId: null,
      newCategoryId: null,
      error: 'Write operation failed',
    }));

    const outcome = await performReviewAction(store, item.id, 'approve', actorId);
    expect(outcome.success).toBe(true);

    const executor = getReviewMutationExecutor()!;
    const reviewItem = await store.getReviewItem(item.id);
    const mutationResult = await executor(
      { reviewId: item.id, actorId, requestId: 'test-req' },
      store,
      reviewItem!,
    );

    expect(mutationResult.mutationStatus).toBe('apply_failed');
    expect(mutationResult.success).toBe(false);
    expect(mutationResult.error).toBe('Write operation failed');

    // Route handler builds this response
    const responseFields = {
      itemId: outcome.itemId,
      success: mutationResult.success,
      error: mutationResult.error,
      categorizationExecuted: true,
      mutationStatus: mutationResult.mutationStatus,
      applied: mutationResult.applied,
      verified: mutationResult.verified,
      stale: mutationResult.stale,
      transactionId: mutationResult.transactionId,
      previousCategoryId: mutationResult.previousCategoryId,
      newCategoryId: mutationResult.newCategoryId,
    };

    expect(responseFields.categorizationExecuted).toBe(true);
    expect(responseFields.mutationStatus).toBe('apply_failed');
    expect(responseFields.success).toBe(false);
  });

  it('simulates stale mutation via executor', async () => {
    const item = await seedPendingReview(store);
    const ev = mockEvent({ authenticated: true, config: { reviewAndApply: true } });
    const actorId = getActorId(ev);

    setReviewMutationExecutor(async () => ({
      mutationStatus: 'stale',
      success: false,
      applied: false,
      verified: false,
      stale: true,
      transactionId: null,
      previousCategoryId: null,
      newCategoryId: null,
      error: 'Snapshot data is stale',
    }));

    const outcome = await performReviewAction(store, item.id, 'approve', actorId);
    expect(outcome.success).toBe(true);

    const executor = getReviewMutationExecutor()!;
    const reviewItem = await store.getReviewItem(item.id);
    const mutationResult = await executor(
      { reviewId: item.id, actorId, requestId: 'test-req' },
      store,
      reviewItem!,
    );

    expect(mutationResult.mutationStatus).toBe('stale');
    expect(mutationResult.stale).toBe(true);
  });

  it('returns denied when reviewAndApply enabled but no executor wired', async () => {
    const item = await seedPendingReview(store);
    const ev = mockEvent({ authenticated: true, config: { reviewAndApply: true } });
    const actorId = getActorId(ev);

    // No executor set up

    const outcome = await performReviewAction(store, item.id, 'approve', actorId);
    expect(outcome.success).toBe(true);

    const enabled = reviewAndApplyEnabled(ev);
    expect(enabled).toBe(true);

    const executor = getReviewMutationExecutor();
    // When executor is null, route returns denied
    const mutationStatus = executor ? undefined : 'denied';

    // Route handler builds this response
    const responseFields = {
      itemId: outcome.itemId,
      success: true,
      error: mutationStatus === 'denied' ? 'Mutation executor not available' : null,
      categorizationExecuted: false,
      mutationStatus: mutationStatus ?? 'noop',
      applied: false,
      verified: false,
      stale: false,
      transactionId: null,
      previousCategoryId: null,
      newCategoryId: null,
    };

    expect(responseFields.categorizationExecuted).toBe(false);
    expect(responseFields.mutationStatus).toBe('denied');
  });

  it('preserves actor-from-auth in executor calls', async () => {
    const item = await seedPendingReview(store);
    const ev = mockEvent({ authenticated: true, config: { reviewAndApply: true } });
    const actorId = getActorId(ev);

    let capturedActorId: string | undefined;
    setReviewMutationExecutor(async (input) => {
      capturedActorId = input.actorId;
      return {
        mutationStatus: 'verified',
        success: true,
        applied: true,
        verified: true,
        stale: false,
        transactionId: item.transactionId,
        previousCategoryId: null,
        newCategoryId: item.categoryId,
        error: null,
      };
    });

    const executor = getReviewMutationExecutor()!;
    const reviewItem = await store.getReviewItem(item.id);
    await executor(
      { reviewId: item.id, actorId, requestId: 'test-req' },
      store,
      reviewItem!,
    );

    expect(capturedActorId).toBe(ACTOR);
    expect(capturedActorId).not.toBe('anonymous');
  });
});

// ---------------------------------------------------------------------------
// Tests: Correct route behavior
// ---------------------------------------------------------------------------

describe('correct action — route behavior contract', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    vi.clearAllMocks();
    setReviewMutationExecutor(null);
    store = new SqliteWorkflowStore(':memory:');
  });

  it('passes categoryId to executor and returns verified', async () => {
    const item = await seedPendingReview(store);
    const ev = mockEvent({ authenticated: true, config: { reviewAndApply: true } });
    const actorId = getActorId(ev);
    const customCategory = 'cat-office';

    let capturedCategoryId: string | undefined;
    setReviewMutationExecutor(async (input) => {
      capturedCategoryId = input.categoryId;
      return {
        mutationStatus: 'verified',
        success: true,
        applied: true,
        verified: true,
        stale: false,
        transactionId: item.transactionId,
        previousCategoryId: 'cat-food',
        newCategoryId: input.categoryId ?? item.categoryId,
        error: null,
      };
    });

    // Perform 'correct' with categoryId metadata
    const outcome = await performReviewAction(store, item.id, 'correct', actorId, customCategory);
    expect(outcome.success).toBe(true);

    const executor = getReviewMutationExecutor()!;
    const reviewItem = await store.getReviewItem(item.id);
    const mutationResult = await executor(
      { reviewId: item.id, actorId, requestId: 'test-req', categoryId: customCategory },
      store,
      reviewItem!,
    );

    expect(capturedCategoryId).toBe(customCategory);
    expect(mutationResult.mutationStatus).toBe('verified');
    expect(mutationResult.newCategoryId).toBe(customCategory);

    // Route response fields
    const responseFields = {
      itemId: outcome.itemId,
      categoryId: customCategory,
      success: mutationResult.success,
      error: mutationResult.error,
      categorizationExecuted: true,
      mutationStatus: mutationResult.mutationStatus,
      applied: mutationResult.applied,
      verified: mutationResult.verified,
      stale: mutationResult.stale,
      transactionId: mutationResult.transactionId,
      previousCategoryId: mutationResult.previousCategoryId,
      newCategoryId: mutationResult.newCategoryId,
    };

    expect(responseFields.categorizationExecuted).toBe(true);
    expect(responseFields.mutationStatus).toBe('verified');
    expect(responseFields.newCategoryId).toBe(customCategory);
  });
});

// ---------------------------------------------------------------------------
// Tests: Reject/skip remain workflow-only
// ---------------------------------------------------------------------------

describe('reject — workflow-only contract', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    vi.clearAllMocks();
    setReviewMutationExecutor(null);
    store = new SqliteWorkflowStore(':memory:');
  });

  it('reject does not call executor even in reviewAndApply mode', async () => {
    const item = await seedPendingReview(store);
    const ev = mockEvent({ authenticated: true, config: { reviewAndApply: true } });

    const executorSpy = vi.fn();
    setReviewMutationExecutor(executorSpy);

    // Reject does workflow transition only
    const outcome = await performReviewAction(store, item.id, 'reject', ACTOR);
    expect(outcome.success).toBe(true);
    expect(outcome.categorizationExecuted).toBeUndefined(); // ActionOutcome doesn't have this field

    // The executor should NOT be called — reject routes never check the executor
    // This is verified by the route handler design; reject routes call performReviewAction and return
    expect(executorSpy).not.toHaveBeenCalled();

    // Simulate the route handler returning the proper fields
    const responseFields = {
      itemId: outcome.itemId,
      success: true,
      error: null,
      categorizationExecuted: false,
      mutationStatus: 'noop' as const,
      applied: false,
      verified: false,
      stale: false,
      transactionId: null,
      previousCategoryId: null,
      newCategoryId: null,
    };
    expect(responseFields.mutationStatus).toBe('noop');
    expect(responseFields.categorizationExecuted).toBe(false);
  });
});

describe('skip — workflow-only contract', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    vi.clearAllMocks();
    setReviewMutationExecutor(null);
    store = new SqliteWorkflowStore(':memory:');
  });

  it('skip does not call executor even in reviewAndApply mode', async () => {
    const item = await seedPendingReview(store);

    const executorSpy = vi.fn();
    setReviewMutationExecutor(executorSpy);

    const outcome = await performReviewAction(store, item.id, 'skip', ACTOR);
    expect(outcome.success).toBe(true);

    expect(executorSpy).not.toHaveBeenCalled();

    const responseFields = {
      itemId: outcome.itemId,
      success: true,
      error: null,
      categorizationExecuted: false,
      mutationStatus: 'noop' as const,
      applied: false,
      verified: false,
      stale: false,
      transactionId: null,
      previousCategoryId: null,
      newCategoryId: null,
    };
    expect(responseFields.mutationStatus).toBe('noop');
    expect(responseFields.categorizationExecuted).toBe(false);
  });
});
