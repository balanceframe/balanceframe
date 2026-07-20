/**
 * Vue composable that implements the ReviewControllerAdapter interface
 * by calling Nitro API endpoints instead of using a local WorkflowStore.
 *
 * When the API is not yet wired to real data, the adapter manages an
 * empty default state.  Once the server routes serve real review items
 * the adapter will populate state from the API responses.
 */

import { ref, shallowRef } from 'vue';
import type {
  ReviewControllerAdapter,
  WebActionResult,
  WebBulkActionResult,
} from '../types/review-client';
import type {
  ReviewSurfaceState,
  ReviewQueueItem,
  ReviewMetricsSnapshot,
  ReviewError,
  HomogeneityInfo,
} from '../src/review';

// ---------------------------------------------------------------------------
// Default values for required state shapes
// ---------------------------------------------------------------------------

const EMPTY_METRICS: ReviewMetricsSnapshot = {
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
};

const EMPTY_HOMOGENEITY: HomogeneityInfo = {
  homogeneous: false,
  commonStatus: null,
  commonCategory: null,
  commonClassifier: null,
  groupSize: 0,
  conflictReason: null,
};

function createDefaultState(): ReviewSurfaceState {
  return {
    items: [],
    currentIndex: -1,
    currentItem: null,
    selectedIndices: [],
    selectionHomogeneity: EMPTY_HOMOGENEITY,
    metrics: EMPTY_METRICS,
    hasMore: false,
    loading: false,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Envelope types matching the server JSON envelopes
// ---------------------------------------------------------------------------

interface AuthorizationInfo {
  actorId: string;
  capability: string;
  allowed: boolean;
}

interface ReviewListResult {
  items: ReviewQueueItem[];
  total: number;
}

interface SingleActionResult {
  itemId: string | null;
  success: boolean;
  error: string | null;
}

interface ApiEnvelope<T> {
  schemaVersion: string;
  requestId: string;
  status: 'ok' | 'error';
  dataFreshness: unknown | null;
  authorization: AuthorizationInfo | null;
  result: T;
  error: { code: string; message: string; retryable: boolean } | null;
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useApiReviewController(baseUrl: string): ReviewControllerAdapter {
  // ── Reactive state ──────────────────────────────────────────────
  const state = shallowRef<ReviewSurfaceState>(createDefaultState());
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Normalise the base URL (strip trailing slash).
  const api = baseUrl.replace(/\/+$/, '');

  // ── Helpers ─────────────────────────────────────────────────────

  /** Generic API call returning the envelope's result. */
  async function callApi<T>(
    path: string,
    method: string = 'GET',
    body?: unknown,
  ): Promise<ApiEnvelope<T>> {
    const url = `${api}${path}`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API error (${res.status}): ${text || res.statusText}`);
    }
    return res.json();
  }

  /** Perform a single-item action via the API and return a WebActionResult. */
  async function doAction(
    actionName: string,
    extraBody: Record<string, string> = {},
  ): Promise<WebActionResult> {
    loading.value = true;
    error.value = null;

    const currentId = state.value.currentItem?.reviewItem.id ?? '<no-current>';

    try {
      const envelope = await callApi<SingleActionResult>(
        `/api/review/${actionName}`,
        'POST',
        { reviewId: currentId, actorId: 'web-user', ...extraBody },
      );

      if (envelope.status === 'error' || envelope.error) {
        const msg = envelope.error?.message ?? 'Unknown error';
        error.value = msg;
        return { itemId: currentId, success: false, error: msg };
      }

      return {
        itemId: envelope.result?.itemId ?? currentId,
        success: envelope.result?.success ?? true,
        error: envelope.result?.error ?? null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
      return { itemId: currentId, success: false, error: msg };
    } finally {
      loading.value = false;
    }
  }

  /** Fetch the current review list from the API and update state. */
  async function fetchItems(): Promise<void> {
    loading.value = true;
    error.value = null;

    try {
      const envelope = await callApi<ReviewListResult>('/api/review');

      if (envelope.status === 'error') {
        throw new Error(envelope.error?.message ?? 'Failed to load review items');
      }

      const items = envelope.result?.items ?? [];
      const total = envelope.result?.total ?? items.length;
      const currentItem = items.length > 0 ? items[0] : null;

      state.value = {
        items,
        currentIndex: currentItem ? 0 : -1,
        currentItem,
        selectedIndices: [],
        selectionHomogeneity: EMPTY_HOMOGENEITY,
        metrics: { ...EMPTY_METRICS, backlogCount: total },
        hasMore: items.length < total,
        loading: false,
        error: null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
      state.value = {
        ...state.value,
        error: { code: 'LOAD_ERROR', message: msg, retryable: true },
      };
    } finally {
      loading.value = false;
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async function loadNextPage(): Promise<void> {
    await fetchItems();
  }

  async function refresh(): Promise<void> {
    state.value = createDefaultState();
    await fetchItems();
  }

  // ── Single-item actions ─────────────────────────────────────────

  async function approve(): Promise<WebActionResult> {
    return doAction('approve');
  }

  async function correct(categoryId: string): Promise<WebActionResult> {
    return doAction('correct', { categoryId });
  }

  async function reject(): Promise<WebActionResult> {
    return doAction('reject');
  }

  async function skip(): Promise<WebActionResult> {
    return doAction('skip');
  }

  async function undo(): Promise<WebActionResult> {
    // Undo is not yet wired to an API endpoint — return no-op success.
    return { itemId: state.value.currentItem?.reviewItem.id ?? '<no-current>', success: true, error: null };
  }

  // ── Bulk actions ────────────────────────────────────────────────

  async function bulkApprove(): Promise<WebBulkActionResult> {
    return { results: [], consumedCount: 0, errorCount: 0 };
  }

  async function bulkCorrect(_categoryId: string): Promise<WebBulkActionResult> {
    return { results: [], consumedCount: 0, errorCount: 0 };
  }

  async function bulkReject(): Promise<WebBulkActionResult> {
    return { results: [], consumedCount: 0, errorCount: 0 };
  }

  async function bulkSkip(): Promise<WebBulkActionResult> {
    return { results: [], consumedCount: 0, errorCount: 0 };
  }

  // ── Navigation ──────────────────────────────────────────────────

  function selectNext(): void {
    const items = state.value.items;
    if (items.length === 0) return;
    const next = Math.min(state.value.currentIndex + 1, items.length - 1);
    state.value = {
      ...state.value,
      currentIndex: next,
      currentItem: items[next],
      selectedIndices: [],
    };
  }

  function selectPrevious(): void {
    const prev = Math.max(state.value.currentIndex - 1, 0);
    state.value = {
      ...state.value,
      currentIndex: prev,
      currentItem: state.value.items[prev] ?? null,
      selectedIndices: [],
    };
  }

  function toggleSelection(index: number): void {
    const sel = [...state.value.selectedIndices];
    const pos = sel.indexOf(index);
    if (pos >= 0) {
      sel.splice(pos, 1);
    } else {
      sel.push(index);
    }
    state.value = { ...state.value, selectedIndices: sel };
  }

  function clearSelection(): void {
    state.value = { ...state.value, selectedIndices: [] };
  }

  // ── Metrics ─────────────────────────────────────────────────────

  function resetMetrics(): void {
    state.value = { ...state.value, metrics: EMPTY_METRICS };
  }

  // ── Error management ────────────────────────────────────────────

  function setError(code: string, message: string, retryable = true): void {
    error.value = message;
    state.value = {
      ...state.value,
      error: { code, message, retryable },
    };
  }

  function clearError(): void {
    error.value = null;
    state.value = { ...state.value, error: null };
  }

  // ── Public adapter ──────────────────────────────────────────────

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
    toggleSelection,
    clearSelection,
    resetMetrics,
    setError,
    clearError,
  };
}
