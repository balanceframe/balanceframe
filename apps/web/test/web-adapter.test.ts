/**
 * Focused tests for the web-shell/controller adapter contract.
 *
 * These tests define the observable contract between the Nuxt presentation
 * shell and the framework-neutral ReviewController.  They verify that the
 * Vue composable adapter (useReviewController) correctly bridges controller
 * state into reactive form without duplicating state, leaking Actual
 * credentials, or exposing native binding calls.
 *
 * Written before the Nuxt scaffold to guide the adapter shape (TDD).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { CreateReviewItemInput } from '@balanceframe/workflow-store';
import { ReviewController } from '../src/review.js';
import { useReviewController } from '../composables/useReviewController';
import type { ReviewControllerAdapter } from '../types/review-client.js';

// ---------------------------------------------------------------------------
// Deterministic fixtures (mirrors review.test.ts)
// ---------------------------------------------------------------------------

const ACTOR = 'web-test@balanceframe.dev';
const BUDGET = 'budget-test';

const BASE_CREATE: CreateReviewItemInput = {
  transactionId: 'txn-unit-test',
  budgetId: BUDGET,
  categoryId: 'cat-food',
  classifier: 'test-classifier',
  provenance: 'classifier-scan',
  amount: 5000,
  evidence: {
    originalName: 'Supermarket Inc.',
    normalizedMerchant: 'supermarket',
    account: 'Checking',
    amount: 5000,
    currentCategory: 'cat-unknown',
  },
};

function tickSync(): void {
  const future = Date.now() + 15;
  while (Date.now() < future) {
    /* spin */
  }
}

async function seedPendingReview(
  store: SqliteWorkflowStore,
  overrides: Partial<CreateReviewItemInput> = {},
  priority: number = 0,
) {
  const item = await store.createReviewItem({ ...BASE_CREATE, ...overrides });
  const sg = await store.transitionReviewItem(item.id, {
    toStatus: 'suggestion_generated',
    actor: 'system',
    expectedVersion: item.version,
  });
  const pr = await store.transitionReviewItem(sg.id, {
    toStatus: 'pending_review',
    actor: 'system',
    priority,
    expectedVersion: sg.version,
  });
  return pr;
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

let adapter: ReviewControllerAdapter;

describe('ReviewControllerAdapter (web-shell contract)', () => {
  let store: SqliteWorkflowStore;
  let controller: ReviewController;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
    controller = new ReviewController(store, { actorId: ACTOR });
    adapter = useReviewController(controller);
  });

  // ====================================================================
  // Adapter initial state
  // ====================================================================

  describe('initial state', () => {
    it('returns a reactive state with empty items and no current item', () => {
      expect(adapter.state.items).toHaveLength(0);
      expect(adapter.state.currentItem).toBeNull();
      expect(adapter.loading).toBe(false);
      expect(adapter.error).toBeNull();
      expect(adapter.state.hasMore).toBe(true);
    });

    it('exposes a typed ReviewControllerAdapter without store or Actual references', () => {
      const keys = Object.keys(adapter);
      expect(keys).not.toContain('store');
      expect(keys).not.toContain('transitionReviewItem');
      expect(keys).not.toContain('listReviewItems');
      expect(keys).not.toContain('getReviewItem');
    });
  });

  // ====================================================================
  // State synchronisation — controller is the authority
  // ====================================================================

  describe('state synchronisation', () => {
    it('subscribes to controller state changes', async () => {
      const before = adapter.state.items.length;

      await seedPendingReview(store);
      await controller.loadNextPage();

      expect(adapter.state.items.length).toBeGreaterThan(before);
    });

    it('updates after approve action', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();

      const itemId = adapter.state.currentItem!.reviewItem.id;
      await adapter.approve();

      const stored = await store.getReviewItem(itemId);
      expect(stored?.status).toBe('approved');
    });

    it('sets loading flag during asynchronous operations', async () => {
      const loadPromise = adapter.loadNextPage();
      expect(adapter.loading).toBe(true);
      await loadPromise;
      expect(adapter.loading).toBe(false);
    });
  });

  // ====================================================================
  // Action delegation — adapter methods call controller bindings
  // ====================================================================

  describe('action delegation', () => {
    it('adapter.approve delegates to controller bindings', async () => {
      const bindings = controller.getBindings();
      const getBindingsSpy = vi.spyOn(controller, 'getBindings').mockReturnValue(bindings);
      const methodSpy = vi.spyOn(bindings, 'approve');

      await seedPendingReview(store);
      await controller.loadNextPage();
      await adapter.approve();

      expect(getBindingsSpy).toHaveBeenCalledTimes(1);
      expect(methodSpy).toHaveBeenCalledTimes(1);
    });

    it('adapter.reject delegates to controller bindings', async () => {
      const bindings = controller.getBindings();
      const getBindingsSpy = vi.spyOn(controller, 'getBindings').mockReturnValue(bindings);
      const methodSpy = vi.spyOn(bindings, 'reject');

      await seedPendingReview(store);
      await controller.loadNextPage();
      await adapter.reject();

      expect(getBindingsSpy).toHaveBeenCalledTimes(1);
      expect(methodSpy).toHaveBeenCalledTimes(1);
    });

    it('adapter.skip delegates to controller bindings', async () => {
      const bindings = controller.getBindings();
      const getBindingsSpy = vi.spyOn(controller, 'getBindings').mockReturnValue(bindings);
      const methodSpy = vi.spyOn(bindings, 'skip');

      await seedPendingReview(store);
      await controller.loadNextPage();
      await adapter.skip();

      expect(getBindingsSpy).toHaveBeenCalledTimes(1);
      expect(methodSpy).toHaveBeenCalledTimes(1);
    });

    it('adapter.undo delegates to controller bindings', async () => {
      const bindings = controller.getBindings();
      vi.spyOn(controller, 'getBindings').mockReturnValue(bindings);
      const methodSpy = vi.spyOn(bindings, 'undo');

      await seedPendingReview(store);
      await controller.loadNextPage();
      await adapter.approve();
      await adapter.undo();

      expect(methodSpy).toHaveBeenCalledTimes(1);
    });

    it('adapter.correct delegates with the category argument', async () => {
      const bindings = controller.getBindings();
      const getBindingsSpy = vi.spyOn(controller, 'getBindings').mockReturnValue(bindings);
      const methodSpy = vi.spyOn(bindings, 'correct');

      await seedPendingReview(store);
      await controller.loadNextPage();
      await adapter.correct('cat-transport');

      expect(getBindingsSpy).toHaveBeenCalledTimes(1);
      expect(methodSpy).toHaveBeenCalledWith('cat-transport');
    });

    it('adapter.correct returns WebActionResult with success:true on success', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      const result = await adapter.correct('cat-transport');

      expect(result).toMatchObject({
        success: true,
        error: null,
        itemId: expect.any(String),
      });
    });

    it('adapter.selectNext delegates to controller bindings', () => {
      const bindings = controller.getBindings();
      const getBindingsSpy = vi.spyOn(controller, 'getBindings').mockReturnValue(bindings);
      const methodSpy = vi.spyOn(bindings, 'selectNext');

      adapter.selectNext();

      expect(getBindingsSpy).toHaveBeenCalledTimes(1);
      expect(methodSpy).toHaveBeenCalledTimes(1);
    });

    it('adapter.toggleSelection delegates to controller bindings', () => {
      const bindings = controller.getBindings();
      const getBindingsSpy = vi.spyOn(controller, 'getBindings').mockReturnValue(bindings);
      const methodSpy = vi.spyOn(bindings, 'toggleSelection');

      adapter.toggleSelection(2);

      expect(getBindingsSpy).toHaveBeenCalledTimes(1);
      expect(methodSpy).toHaveBeenCalledWith(2);
    });
  });

  // ====================================================================
  // WebActionResult shape
  // ====================================================================

  describe('WebActionResult contract', () => {
    it('returns success result for approve', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      const result = await adapter.approve();

      expect(result).toHaveProperty('itemId');
      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('error', null);
    });

    it('returns error result when action fails', async () => {
      const result = await adapter.approve();

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  // ====================================================================
  // Boundary isolation — no credential or store leakage
  // ====================================================================

  describe('boundary isolation', () => {
    it('adapter does not expose WorkflowStore methods', () => {
      const keys = Object.keys(adapter) as string[];

      const storeKeys = [
        'createReviewItem',
        'transitionReviewItem',
        'transitionReviewItems',
        'undoReviewTransition',
        'listReviewItems',
        'getReviewItem',
        'saveSuggestion',
      ];

      for (const sk of storeKeys) {
        expect(keys).not.toContain(sk);
      }
    });

    it('adapter does not expose Actual or budget binding names', () => {
      const keysStr = JSON.stringify(Object.keys(adapter).sort());

      expect(keysStr).not.toContain('actual');
      expect(keysStr).not.toContain('Actual');
      expect(keysStr).not.toContain('budget');
      expect(keysStr).not.toContain('Budget');
    });

    it('adapter has no writable properties that could bypass controller', () => {
      for (const [key, value] of Object.entries(adapter)) {
        if (typeof value === 'function') continue;
        const desc = Object.getOwnPropertyDescriptor(adapter, key);
        if (desc) {
          const isReadonly =
            (desc.get !== undefined && desc.set === undefined) ||
            desc.writable === false;
          expect(isReadonly).toBe(true);
        }
      }
    });
  });

  // ====================================================================
  // Navigation helpers
  // ====================================================================

  describe('navigation', () => {
    it('selectNext moves to the next item', async () => {
      await seedPendingReview(store, { transactionId: 'txn-a' });
      await tickSync();
      await seedPendingReview(store, { transactionId: 'txn-b' });
      await controller.loadNextPage();

      const firstId = adapter.state.currentItem!.reviewItem.id;
      adapter.selectNext();
      expect(adapter.state.currentItem!.reviewItem.id).not.toBe(firstId);
    });
  });

  // ====================================================================
  // Bulk action helpers
  // ====================================================================

  describe('bulk actions', () => {
    it('bulkApprove returns WebBulkActionResult with results', async () => {
      await seedPendingReview(store, { transactionId: 'txn-a' });
      await seedPendingReview(store, { transactionId: 'txn-b' });
      await controller.loadNextPage();

      adapter.toggleSelection(0);
      adapter.toggleSelection(1);

      const result = await adapter.bulkApprove();

      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('consumedCount');
      expect(result).toHaveProperty('errorCount');
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.consumedCount).toBeGreaterThan(0);
    });

    it('bulkApprove sets loading flag', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      adapter.toggleSelection(0);

      const promise = adapter.bulkApprove();
      expect(adapter.loading).toBe(true);
      await promise;
      expect(adapter.loading).toBe(false);
    });
  });

  // ====================================================================
  // Refresh / lifecycle
  // ====================================================================

  describe('lifecycle', () => {
    it('refresh clears and reloads the queue', async () => {
      await seedPendingReview(store);
      await controller.loadNextPage();
      expect(adapter.state.items.length).toBe(1);

      await seedPendingReview(store, { transactionId: 'txn-b' });
      await adapter.refresh();

      expect(adapter.state.items.length).toBe(2);
    });

    it('clearSelection delegates to controller', () => {
      const bindings = controller.getBindings();
      vi.spyOn(controller, 'getBindings').mockReturnValue(bindings);
      const spy = vi.spyOn(bindings, 'clearSelection');

      adapter.clearSelection();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('resetMetrics delegates to controller', () => {
      const spy = vi.spyOn(controller, 'resetMetrics');

      adapter.resetMetrics();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('setError surfaces in both error property and controller', () => {
      adapter.setError('custom', 'Something went wrong', true);

      expect(adapter.error).toBe('Something went wrong');
      expect(adapter.state.error).not.toBeNull();
      expect(adapter.state.error!.code).toBe('custom');
    });
  });
});
