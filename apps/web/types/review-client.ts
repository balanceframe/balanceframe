/**
 * Narrow typed client boundary for the Nuxt review surface.
 *
 * Defines only the proposal/action result types that the web layer observes.
 * Never exposes Actual credentials, raw Actual methods, N-API calls, or
 * alternate mutation paths.  The framework-neutral ReviewController remains
 * the sole state authority.
 */

import type { ReviewQueueItem, ReviewSurfaceState, ReviewActionBindings } from '../src/review.js';

// ---------------------------------------------------------------------------
// Web-visible proposal result
// ---------------------------------------------------------------------------

/** Outcome of a single item action, as presented to the UI. */
export interface WebActionResult {
  readonly itemId: string;
  readonly success: boolean;
  readonly error: string | null;
}

/** Result of a bulk action with per-item outcomes. */
export interface WebBulkActionResult {
  readonly results: readonly WebActionResult[];
  readonly consumedCount: number;
  readonly errorCount: number;
}

// ---------------------------------------------------------------------------
// Web-shell adapter — the contract between Nuxt and ReviewController
// ---------------------------------------------------------------------------

/**
 * Reactive adapter that bridges the framework-neutral ReviewController
 * to the Vue/Nuxt reactivity system.
 *
 * - Subscribes to controller state changes and surfaces them reactively.
 * - Exposes typed action methods that delegate to controller bindings.
 * - Never accesses the WorkflowStore or Actual API directly.
 */
export interface ReviewControllerAdapter {
  /** Reactive snapshot of the current review surface state. */
  readonly state: Readonly<ReviewSurfaceState>;

  /** True while an async load or transition is in flight. */
  readonly loading: boolean;

  /** Human-readable error message when the last operation failed, or null. */
  readonly error: string | null;

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Load the next page of review items from the store. */
  loadNextPage(): Promise<void>;

  /** Reload the queue from scratch. */
  refresh(): Promise<void>;


  // ── Single-item actions ────────────────────────────────────────────
  
  /** Approve the current item. Returns the action result. */
  approve(): Promise<WebActionResult>;
  
  /** Correct the current item to the given category. */
  correct(categoryId: string): Promise<WebActionResult>;
  
  /** Reject the current item. */
  reject(): Promise<WebActionResult>;
  
  /** Skip the current item. */
  skip(): Promise<WebActionResult>;
  
  /** Undo the last reversible transition. */
  undo(): Promise<WebActionResult>;
  
  // ── Rule creation ──────────────────────────────────────────────────
  
  /** Propose a new automation rule for the given merchant and category. */
  proposeRule(reviewId: string, merchant: string, categoryId: string): Promise<WebActionResult>;
  
  // ── Bulk actions ───────────────────────────────────────────────────

  /** Bulk-approve all selected items. */
  bulkApprove(): Promise<WebBulkActionResult>;

  /** Bulk-correct all selected items to the given category. */
  bulkCorrect(categoryId: string): Promise<WebBulkActionResult>;

  /** Bulk-reject all selected items. */
  bulkReject(): Promise<WebBulkActionResult>;

  /** Bulk-skip all selected items. */
  bulkSkip(): Promise<WebBulkActionResult>;

  // ── Navigation ─────────────────────────────────────────────────────

  /** Move focus to the next item. */
  selectNext(): void;

  /** Move focus to the previous item. */
  selectPrevious(): void;

  /** Toggle selection of the item at the given index. */
  toggleSelection(index: number): void;

  /** Clear the current selection. */
  clearSelection(): void;

  // ── Metrics ────────────────────────────────────────────────────────

  /** Reset all collected metrics. */
  resetMetrics(): void;

  // ── Error management ───────────────────────────────────────────────

  /** Surface an external error. */
  setError(code: string, message: string, retryable?: boolean): void;

  /** Clear the current error. */
  clearError(): void;
}
