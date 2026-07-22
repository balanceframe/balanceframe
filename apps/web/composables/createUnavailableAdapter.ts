/**
 * Factory for a non-operational ReviewControllerAdapter.
 *
 * Returned when no API backend is configured.  Every mutation method is a
 * no-op that returns an error result — the UI renders the `CONFIG_MISSING`
 * error state without exposing mutation controls.
 *
 * This module intentionally does NOT import SqliteWorkflowStore or any
 * Node-only dependency — it is safe for the browser bundle.
 */

import type {
  ReviewControllerAdapter,
  WebActionResult,
  WebBulkActionResult,
} from '../types/review-client';

// ---------------------------------------------------------------------------
// Default empty shape values
// ---------------------------------------------------------------------------

const EMPTY_METRICS = {
  medianReviewTimeMs: 0,
  interactionsPerAction: 0,
  acceptanceRate: 0,
  correctionRate: 0,
  rejectionRate: 0,
  backlogCount: 0,
  backlogMaxAgeMs: 0,
  backlogMeanAgeMs: 0,
  coverage: 0,
  interactionLatencyMs: 0,
  recurrenceCount: 0,
  duplicatesAvoided: 0,
  createdCount: 0,
  resolvedCount: 0,
} as const;

const EMPTY_HOMOGENEITY = {
  homogeneous: true,
  commonStatus: null,
  commonCategory: null,
  commonClassifier: null,
  groupSize: 0,
  conflictReason: null,
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createUnavailableAdapter(): ReviewControllerAdapter {
  const errorResult: WebActionResult = {
    itemId: '',
    success: false,
    error: 'API backend not configured',
  };

  const bulkErrorResult: WebBulkActionResult = {
    results: [],
    consumedCount: 0,
    errorCount: 0,
  };

  return {
    loading: false,
    error: null,

    state: {
      items: [],
      currentIndex: 0,
      currentItem: null,
      selectedIndices: [],
      selectionHomogeneity: { ...EMPTY_HOMOGENEITY },
      metrics: { ...EMPTY_METRICS },
      hasMore: false,
      loading: false,
      error: {
        code: 'CONFIG_MISSING',
        message:
          'BalanceFrame API backend is not configured. ' +
          'Set NUXT_PUBLIC_API_BASE (or runtimeConfig.public.apiBase) ' +
          'to enable review operations.',
        retryable: false,
      },
    },

    // ── Lifecycle (no-ops) ────────────────────────────────────────────
    loadNextPage: () => Promise.resolve(),
    refresh: () => Promise.resolve(),

    // ── Single-item actions ───────────────────────────────────────────
    approve: () => Promise.resolve(errorResult),
    correct: (_categoryId: string) => Promise.resolve(errorResult),

    // ── Rule creation ─────────────────────────────────────────────────
    proposeRule: (_reviewId: string, _merchant: string, _categoryId: string) =>
      Promise.resolve(errorResult),
    reject: () => Promise.resolve(errorResult),
    skip: () => Promise.resolve(errorResult),
    undo: () => Promise.resolve(errorResult),

    // ── Bulk actions ──────────────────────────────────────────────────
    bulkApprove: () => Promise.resolve(bulkErrorResult),
    bulkCorrect: (_categoryId: string) => Promise.resolve(bulkErrorResult),
    bulkReject: () => Promise.resolve(bulkErrorResult),
    bulkSkip: () => Promise.resolve(bulkErrorResult),

    // ── Navigation (no-ops) ───────────────────────────────────────────
    selectNext: () => {},
    selectPrevious: () => {},
    toggleSelection: (_index: number) => {},
    selectIndex: (_index: number) => {},
    clearSelection: () => {},

    // ── Metrics ───────────────────────────────────────────────────────
    resetMetrics: () => {},

    // ── Error management ──────────────────────────────────────────────
    setError: (_code: string, _message: string, _retryable?: boolean) => {},
    clearError: () => {},
  };
}
