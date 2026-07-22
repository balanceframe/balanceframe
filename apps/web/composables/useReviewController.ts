/**
 * Vue composable that adapts the framework-neutral ReviewController to
 * Vue 3 reactivity.
 *
 * The controller remains the sole state authority — every state change
 * originates from controller.subscribe().  No state is duplicated in
 * Pinia or component scope.
 *
 * Never exposes Actual credentials, raw Actual methods, or native bindings.
 */

import { ref, shallowRef } from 'vue';
import type { ReviewController, ReviewSurfaceState } from '../src/review.js';
import type {
  ReviewControllerAdapter,
  WebActionResult,
  WebBulkActionResult,
} from '../types/review-client';

/**
 * Wrap a framework-neutral ReviewController in a reactive adapter.
 *
 * @param controller - an initialised ReviewController instance
 * @returns a {@link ReviewControllerAdapter} that the template layer consumes
 */
export function useReviewController(
  controller: ReviewController,
): ReviewControllerAdapter {
  // ── Reactive state ────────────────────────────────────────────────
  const state = shallowRef<ReviewSurfaceState>(controller.getState());
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Subscribe to every controller state change.
  controller.subscribe((newState: ReviewSurfaceState) => {
    state.value = newState;
  });

  // Each action resolves bindings fresh — getBindings() creates a new object each call.


  // ── Lifecycle ─────────────────────────────────────────────────────

  async function loadNextPage(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await controller.loadNextPage();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
    } finally {
      loading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await controller.refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
    } finally {
      loading.value = false;
    }
  }

  // ── Action helpers ────────────────────────────────────────────────

  async function runAction(
    action: () => Promise<void>,
  ): Promise<WebActionResult> {
    loading.value = true;
    error.value = null;
    const itemId =
      state.value.currentItem?.reviewItem.id ?? '<no-current>';
    try {
      await action();
      return { itemId, success: true, error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
      return { itemId, success: false, error: msg };
    } finally {
      loading.value = false;
    }
  }

  async function runBulkAction(
    action: () => Promise<unknown>,
  ): Promise<WebBulkActionResult> {
    loading.value = true;
    error.value = null;
    try {
      const results = (await action()) as {
        itemId: string;
        success: boolean;
        error: string | null;
      }[];
      const mapped: readonly WebActionResult[] = results.map(r => ({
        itemId: r.itemId,
        success: r.success,
        error: r.error ?? null,
      }));
      return {
        results: mapped,
        consumedCount: mapped.filter(r => r.success).length,
        errorCount: mapped.filter(r => !r.success).length,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
      return { results: [], consumedCount: 0, errorCount: 0 };
    } finally {
      loading.value = false;
    }
  }

  // ── Single-item actions ───────────────────────────────────────────
  async function approve(): Promise<WebActionResult> {
    return runAction(() => controller.getBindings().approve());
  }

  async function correct(categoryId: string): Promise<WebActionResult> {
    return runAction(() => controller.getBindings().correct(categoryId));
  }

  async function reject(): Promise<WebActionResult> {
    return runAction(() => controller.getBindings().reject());
  }

  async function skip(): Promise<WebActionResult> {
    return runAction(() => controller.getBindings().skip());
  }

  async function undo(): Promise<WebActionResult> {
    return runAction(() => controller.getBindings().undo());
  }


  // ── Bulk actions ──────────────────────────────────────────────────
  async function bulkApprove(): Promise<WebBulkActionResult> {
    return runBulkAction(() => controller.getBindings().bulkApprove());
  }

  async function bulkCorrect(categoryId: string): Promise<WebBulkActionResult> {
    return runBulkAction(() => controller.getBindings().bulkCorrect(categoryId));
  }

  async function bulkReject(): Promise<WebBulkActionResult> {
    return runBulkAction(() => controller.getBindings().bulkReject());
  }

  async function bulkSkip(): Promise<WebBulkActionResult> {
    return runBulkAction(() => controller.getBindings().bulkSkip());
  }

  // ── Navigation ────────────────────────────────────────────────────
  function selectNext(): void {
    controller.getBindings().selectNext();
  }

  function selectPrevious(): void {
    controller.getBindings().selectPrevious();
  }
  function selectIndex(index: number): void {
    controller.getBindings().selectIndex(index);
  }

  function toggleSelection(index: number): void {
    controller.getBindings().toggleSelection(index);
  }

  function clearSelection(): void {
    controller.getBindings().clearSelection();
  }

  // ── Metrics ───────────────────────────────────────────────────────

  function resetMetrics(): void {
    controller.resetMetrics();
  }

  // ── Error management ──────────────────────────────────────────────

  function setError(code: string, message: string, retryable = true): void {
    error.value = message;
    controller.setError(code, message, retryable);
  }

  function clearError(): void {
    error.value = null;
    controller.clearError();
  }

  return {
    get state() {
      return state.value as Readonly<ReviewSurfaceState>;
    },
    get loading() {
      return loading.value;
    },
    get error() {
      return error.value;
    },
    loadNextPage,
    refresh,
    approve,
    correct,
    reject,
    skip,
    undo,
    bulkApprove,
    bulkCorrect,
    bulkReject,
    bulkSkip,
    selectNext,
    selectPrevious,
    selectIndex,
    toggleSelection,
    clearSelection,
    resetMetrics,
    setError,
    clearError,
  };
}
