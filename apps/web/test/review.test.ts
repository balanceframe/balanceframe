/**
 * Failing tests for ReviewController — framework-neutral review surface.
 *
 * TDD: these tests are written before the implementation and will fail
 * until the minimal controller code in review.ts makes them pass.
 */

import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type {
  CreateReviewItemInput,
  TransitionReviewInput,
  ReviewItem,
} from '@balanceframe/workflow-store';
import { ReviewController } from '../src/review.js';
import type {
  ReviewSurfaceState,
  ReviewMetricsSnapshot,
} from '../src/review.js';

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

const ACTOR = 'reviewer@test.dev';
const BUDGET = 'budget-test';

const BASE_CREATE: CreateReviewItemInput = {
  budgetId: BUDGET,
  transactionId: 'txn-001',
  categoryId: 'cat-food',
  classifier: 'fast-classifier',
  provenance: 'classifier-scan',
};

/** Wait just enough for fresh timestamps. */
function tickSync(): void {
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a review item all the way to pending_review status. */
async function seedPendingReview(
  store: SqliteWorkflowStore,
  overrides: Partial<CreateReviewItemInput> = {},
  priority: number = 0,
): Promise<ReviewItem> {
  const item = await store.createReviewItem({
    ...BASE_CREATE,
    ...overrides,
    priority,
  });
  const item1 = await store.transitionReviewItem(item.id, {
    toStatus: 'suggestion_generated',
    actor: 'system',
    expectedVersion: 1,
  });
  const item2 = await store.transitionReviewItem(item1.id, {
    toStatus: 'pending_review',
    actor: 'system',
    expectedVersion: item1.version,
  });
  return item2;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewController', () => {
  let store: SqliteWorkflowStore;
  let controller: ReviewController;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
    controller = new ReviewController(store, { actorId: ACTOR });
  });

  // =======================================================================
  // Priority queue — items returned in priority order (highest first)
  // =======================================================================

  describe('priority queue', () => {
    it('returns items in priority order (descending)', async () => {
      await seedPendingReview(store, { transactionId: 'txn-a' }, 0);
      await seedPendingReview(store, { transactionId: 'txn-b' }, 10);
      await seedPendingReview(store, { transactionId: 'txn-c' }, 5);

      await controller.loadNextPage();
      const state = controller.getState();
      expect(state.items).toHaveLength(3);
      expect(state.items[0].reviewItem.priority).toBe(10);
      expect(state.items[1].reviewItem.priority).toBe(5);
      expect(state.items[2].reviewItem.priority).toBe(0);
    });

    it('excludes terminal items from the queue', async () => {
      await seedPendingReview(store, { transactionId: 'txn-a' });
      const item2 = await seedPendingReview(store, { transactionId: 'txn-b' });
      // Transition item2 through full lifecycle to 'applied'
      const t1 = await store.transitionReviewItem(item2.id, {
        toStatus: 'approved', actor: ACTOR, reason: 'Approved',
        expectedVersion: item2.version,
      });
      const t2 = await store.transitionReviewItem(item2.id, {
        toStatus: 'correcting', actor: ACTOR, reason: 'Correcting',
        expectedVersion: t1.version,
      });
      await store.transitionReviewItem(item2.id, {
        toStatus: 'applied', actor: 'system', reason: 'Applied',
        expectedVersion: t2.version,
      });

      await controller.loadNextPage();
      const state = controller.getState();
      expect(state.items).toHaveLength(1);
      expect(state.items[0].reviewItem.transactionId).toBe('txn-a');
    });
  });

  // =======================================================================
  // Evidence visibility
  // =======================================================================

  describe('evidence visibility', () => {
    it('populates evidence from stored suggestion and review item', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      const state = controller.getState();

      expect(state.currentItem).not.toBeNull();
      const evidence = state.currentItem!.evidence;
      expect(evidence.provenance).toBe('classifier-scan');
      expect(evidence.provenance.length).toBeGreaterThan(0);
      expect(evidence.currentCategory).toBe('cat-food');
      expect(typeof evidence.originalImportedName).toBe('string');
      expect(typeof evidence.normalizedMerchant).toBe('string');
    });
  });

  // =======================================================================
  // Keyboard / touch parity — same action semantics through any pathway
  // =======================================================================

  describe('keyboard/touch parity', () => {
    it('approve binding transitions current item to approved', async () => {
      const item = await seedPendingReview(store);
      await controller.loadNextPage();
      expect(controller.getState().currentItem?.reviewItem.id).toBe(item.id);

      await controller.getBindings().approve();
      const state = controller.getState();
      expect(state.currentItem).toBeNull(); // immediate progression — consumed item

      // Verify store persisted the transition
      const stored = await store.getReviewItem(item.id);
      expect(stored?.status).toBe('approved');
    });

    it('reject binding transitions current item to rejected', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      const itemId = controller.getState().currentItem!.reviewItem.id;

      await controller.getBindings().reject();
      const stored = await store.getReviewItem(itemId);
      expect(stored?.status).toBe('rejected');
    });

    it('skip binding transitions current item to skipped', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      const itemId = controller.getState().currentItem!.reviewItem.id;

      await controller.getBindings().skip();
      const stored = await store.getReviewItem(itemId);
      expect(stored?.status).toBe('skipped');
    });

    it('correct binding transitions current item to correcting', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      const itemId = controller.getState().currentItem!.reviewItem.id;

      // Correction with explicit category
      await controller.getBindings().correct('cat-transport');
      const stored = await store.getReviewItem(itemId);
      expect(stored?.status).toBe('correcting');
    });

    it('approve, reject, skip, correct all share the same binding interface', async () => {
      // Verify all bindings are functions with identical calling convention
      const bindings = controller.getBindings();
      expect(typeof bindings.approve).toBe('function');
      expect(typeof bindings.reject).toBe('function');
      expect(typeof bindings.skip).toBe('function');
      expect(typeof bindings.correct).toBe('function');
      expect(typeof bindings.undo).toBe('function');
      expect(typeof bindings.selectNext).toBe('function');
      expect(typeof bindings.selectPrevious).toBe('function');
      expect(typeof bindings.toggleSelection).toBe('function');
    });
  });

  // =======================================================================
  // Heterogeneity rejection — bulk action only works on homogeneous items
  // =======================================================================

  describe('heterogeneity rejection', () => {
    it('rejects bulk approve when selected items have mixed statuses', async () => {
      const item1 = await seedPendingReview(store, { transactionId: 'txn-a' });
      const item2 = await seedPendingReview(store, { transactionId: 'txn-b' });

      // Approve item2 first so statuses differ
      await store.transitionReviewItem(item2.id, {
        toStatus: 'approved',
        actor: ACTOR,
        reason: 'Looks good',
        expectedVersion: item2.version,
      });

      await controller.loadNextPage();
      // Select both items
      controller.getBindings().toggleSelection(0);
      controller.getBindings().toggleSelection(1);

      await expect(controller.getBindings().bulkApprove()).rejects.toThrow(
        /heterogeneous|mixed status|conflict/i,
      );
    });

    it('allows bulk approve when all selected items are pending_review', async () => {
      await seedPendingReview(store, { transactionId: 'txn-a' });
      await seedPendingReview(store, { transactionId: 'txn-b' });

      await controller.loadNextPage();

      // Capture item IDs before bulk action
      const stateBefore = controller.getState();
      const ids = stateBefore.selectedIndices
        .concat([0, 1])
        .filter((v, i, a) => a.indexOf(v) === i)
        .map(i => stateBefore.items[i].reviewItem.id);

      controller.getBindings().toggleSelection(0);
      controller.getBindings().toggleSelection(1);

      await controller.getBindings().bulkApprove();

      // All consumed — queue should be empty
      const state = controller.getState();
      expect(state.currentItem).toBeNull();
      expect(state.items).toHaveLength(0);
    });

    it('rejects bulk correct when selected items have different current categories', async () => {
      await seedPendingReview(store, {
        transactionId: 'txn-a',
        categoryId: 'cat-food',
      });
      await seedPendingReview(store, {
        transactionId: 'txn-b',
        categoryId: 'cat-transport',
      });

      await controller.loadNextPage();
      controller.getBindings().toggleSelection(0);
      controller.getBindings().toggleSelection(1);

      await expect(controller.getBindings().bulkCorrect('cat-util')).rejects.toThrow(
        /heterogeneous|mixed categories|conflict/i,
      );
    });

    it('allows bulk correct when all items share the same current category', async () => {
      await seedPendingReview(store, {
        transactionId: 'txn-a',
        categoryId: 'cat-food',
      });
      await seedPendingReview(store, {
        transactionId: 'txn-b',
        categoryId: 'cat-food',
      });

      await controller.loadNextPage();
      controller.getBindings().toggleSelection(0);
      controller.getBindings().toggleSelection(1);

      await controller.getBindings().bulkCorrect('cat-food-new');
      const state = controller.getState();
      expect(state.currentItem).toBeNull(); // consumed
    });

    it('rejects bulk reject when selected items are not all pending_review', async () => {
      const item1 = await seedPendingReview(store, { transactionId: 'txn-a' });
      const item2 = await seedPendingReview(store, { transactionId: 'txn-b' });

      // Approve item1 so statuses differ (rejected items are filtered from queue)
      await store.transitionReviewItem(item1.id, {
        toStatus: 'approved',
        actor: ACTOR,
        reason: 'Approved',
        expectedVersion: item1.version,
      });

      await controller.loadNextPage();
      controller.getBindings().toggleSelection(0);
      controller.getBindings().toggleSelection(1);

      await expect(controller.getBindings().bulkReject()).rejects.toThrow(
        /heterogeneous|mixed status|conflict/i,
      );
    });
  });

  // =======================================================================
  // Undo — reversible transitions
  // =======================================================================

  describe('undo', () => {
    it('undo transitions approved item back to pending_review', async () => {
      const item = await seedPendingReview(store);
      await controller.loadNextPage();
      await controller.getBindings().approve();

      // Undo the approve
      await controller.getBindings().undo();
      const stored = await store.getReviewItem(item.id);
      expect(stored?.status).toBe('pending_review');
    });

    it('undo transitions correcting item back to pending_review', async () => {
      const item = await seedPendingReview(store);
      await controller.loadNextPage();
      await controller.getBindings().correct('cat-util');

      await controller.getBindings().undo();
      const stored = await store.getReviewItem(item.id);
      expect(stored?.status).toBe('pending_review');
    });

    it('undo is rejected for non-reversible status (rejected)', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      await controller.getBindings().reject();

      await expect(controller.getBindings().undo()).rejects.toThrow(
        /cannot undo|not reversible|undo/i,
      );
    });
  });

  // =======================================================================
  // Inaccessible provider / model-disabled states
  // =======================================================================

  describe('inaccessible provider', () => {
    it('handles store errors gracefully when provider is inaccessible', async () => {
      // Close the store to simulate an inaccessible provider
      store.close();

      // The controller should surface the error without crashing
      await expect(controller.loadNextPage()).rejects.toThrow();
      const state = controller.getState();
      expect(state.error).not.toBeNull();
      expect(state.error!.code).toBe('load_failed');
      expect(state.error!.message.length).toBeGreaterThan(0);
    });

    it('action on failed load state propagates the error', async () => {
      store.close();
      await expect(controller.loadNextPage()).rejects.toThrow();
      await expect(controller.getBindings().approve()).rejects.toThrow(
        /error|not loaded|no current/i,
      );
    });
  });

  describe('model-disabled', () => {
    it('allows review of items that have no suggestion (discovered directly)', async () => {
      // An item that goes directly to pending_review without a suggestion
      const item = await store.createReviewItem({
        ...BASE_CREATE,
        transactionId: 'txn-no-model',
        provenance: 'manual-review',
      });
      await store.transitionReviewItem(item.id, {
        toStatus: 'pending_review',
        actor: 'system',
        expectedVersion: 1,
      });

      await controller.loadNextPage();
      const state = controller.getState();
      expect(state.items).toHaveLength(1);
      expect(state.currentItem?.actionable).toBe(true);
    });
  });

  // =======================================================================
  // Duplicate attention prevention
  // =======================================================================

  describe('duplicate attention prevention', () => {
    it('does not present duplicate items for the same underlying issue', async () => {
      // Create two items for the same issue — store deduplicates by design
      await store.createReviewItem(BASE_CREATE);
      await store.createReviewItem(BASE_CREATE); // idempotent, returns same item

      await controller.loadNextPage();
      const state = controller.getState();
      expect(state.items).toHaveLength(1);
    });

    it('superseded items are excluded from the attention queue', async () => {
      const item = await seedPendingReview(store);
      await store.transitionReviewItem(item.id, {
        toStatus: 'superseded',
        actor: 'system',
        reason: 'Newer data available',
        expectedVersion: item.version,
      });

      await controller.loadNextPage();
      const state = controller.getState();
      expect(state.items).toHaveLength(0);
    });
  });

  // =======================================================================
  // Metrics hooks — deterministic measurement
  // =======================================================================

  describe('metrics hooks', () => {
    it('collects view events when items are loaded', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      const metrics = controller.getMetricsSnapshot();
      expect(metrics.createdCount).toBe(1);
      expect(metrics.backlogCount).toBe(1);
    });

    it('records approve, reject, and skip as resolved transitions', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      await controller.getBindings().approve();

      const metrics = controller.getMetricsSnapshot();
      expect(metrics.acceptanceRate).toBeGreaterThan(0);
      expect(metrics.resolvedCount).toBe(1);
    });

    it('tracks interactions per action', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();

      const before = controller.getMetricsSnapshot();
      await controller.getBindings().skip();
      const after = controller.getMetricsSnapshot();
      expect(after.resolvedCount).toBe(before.resolvedCount + 1);
    });

    it('resets metrics on demand', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      await controller.getBindings().approve();

      controller.resetMetrics();
      const metrics = controller.getMetricsSnapshot();
      expect(metrics.resolvedCount).toBe(0);
    });
  });

  // =======================================================================
  // Immediate progression — queue advances after action
  // =======================================================================

  describe('immediate progression', () => {
    it('advances to next item after approving the current one', async () => {
      const item1 = await seedPendingReview(store, { transactionId: 'txn-a' });
      await tickSync();
      const item2 = await seedPendingReview(store, { transactionId: 'txn-b' });

      await controller.loadNextPage();
      expect(controller.getState().currentItem?.reviewItem.transactionId).toBe(
        'txn-a',
      );

      await controller.getBindings().approve();
      const state = controller.getState();
      expect(state.currentItem?.reviewItem.transactionId).toBe('txn-b');
    });

    it('shows null currentItem when all items in page are consumed', async () => {
      await seedPendingReview(store, { transactionId: 'txn-a' });

      await controller.loadNextPage();
      await controller.getBindings().approve();
      expect(controller.getState().currentItem).toBeNull();
    });
  });

  // =======================================================================
  // Missing from the enumerated suite — bulk conflicts with results
  // =======================================================================

  describe('bulk conflict results', () => {
    it('reports per-item results for successful bulk approve', async () => {
      await seedPendingReview(store, { transactionId: 'txn-a' });
      await seedPendingReview(store, { transactionId: 'txn-b' });

      await controller.loadNextPage();
      controller.getBindings().toggleSelection(0);
      controller.getBindings().toggleSelection(1);

      // The controller should resolve the promise with results
      await expect(
        controller.getBindings().bulkApprove(),
      ).resolves.toBeDefined();
    });
  });
});
