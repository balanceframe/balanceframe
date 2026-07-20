/**
 * Vue composable that implements the ReviewControllerAdapter interface
 * by calling Nitro API endpoints instead of using a local WorkflowStore.
 *
 * Accepts an optional session credential callback — never reads a private
 * server token from runtimeConfig.public nor hard-codes an actor identity.
 * Same-origin credentials are always sent; a Bearer token is added when
 * a getSessionToken function is provided.
 *
 * Response envelopes are validated before result consumption. Result-level
 * failures propagate to adapter error state. Actions with no current item
 * are rejected early. Unsupported operations return explicit failures.
 * After a successful action the consumed item is removed from the local
 * queue.
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

export interface ApiReviewControllerOptions {
  /**
   * Optional callback that returns a Bearer token for the Authorization
   * header.  The adapter never reads a token from runtimeConfig.public or
   * stores credentials in reactive state — it calls this function just
   * before each fetch.  Return null or omit to rely on same-origin cookies.
   */
  getSessionToken?: () => string | null;
}

export function useApiReviewController(
  baseUrl: string,
  options?: ApiReviewControllerOptions,
): ReviewControllerAdapter {
  // ── Reactive state ──────────────────────────────────────────────
  const state = shallowRef<ReviewSurfaceState>(createDefaultState());
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Normalise the base URL (strip trailing slash).
  const api = baseUrl.replace(/\/+$/, '');

  // ── Helpers ─────────────────────────────────────────────────────

  /** Build headers including optional session credential. */
  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const token = options?.getSessionToken?.() ?? null;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * Parse a JSON response body into an ApiEnvelope.
   * Throws on malformed (non-JSON, missing status) responses.
   */
  async function parseEnvelope<T>(res: Response): Promise<ApiEnvelope<T>> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(
        `Invalid response: non-JSON body (HTTP ${res.status})`,
      );
    }

    if (!body || typeof body !== 'object') {
      throw new Error(
        `Invalid response: empty body (HTTP ${res.status})`,
      );
    }

    const envelope = body as Record<string, unknown>;

    if (
      typeof envelope.status !== 'string' ||
      (envelope.status !== 'ok' && envelope.status !== 'error')
    ) {
      throw new Error(
        `Invalid response envelope: missing or invalid status field`,
      );
    }

    return body as ApiEnvelope<T>;
  }

  /** Generic API call returning the envelope. */
  async function callApi<T>(
    path: string,
    method: string = 'GET',
    body?: unknown,
  ): Promise<ApiEnvelope<T>> {
    const url = `${api}${path}`;
    const res = await fetch(url, {
      method,
      headers: buildHeaders(),
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const envelope = await parseEnvelope<T>(res);

    if (!res.ok && envelope.status === 'error') {
      throw new Error(
        envelope.error?.message ?? `HTTP ${res.status}`,
      );
    }

    if (!res.ok) {
      // Non-JSON or unusual HTTP error
      throw new Error(`API error (${res.status})`);
    }

    return envelope;
  }

  /** Perform a single-item action via the API and return a WebActionResult. */
  async function doAction(
    actionName: string,
    extraBody: Record<string, string> = {},
  ): Promise<WebActionResult> {
    loading.value = true;
    error.value = null;

    const currentItem = state.value.currentItem;
    if (!currentItem) {
      const result: WebActionResult = {
        itemId: '<no-current>',
        success: false,
        error: 'No current item to act on',
      };
      error.value = result.error;
      loading.value = false;
      return result;
    }

    const currentId = currentItem.reviewItem.id;

    try {
      // The server derives actor identity from the auth context, never
      // from the request body — do not send an actorId here.
      const envelope = await callApi<SingleActionResult>(
        `/api/review/${actionName}`,
        'POST',
        { reviewId: currentId, ...extraBody },
      );

      if (envelope.status === 'error' || envelope.error) {
        const msg = envelope.error?.message ?? 'Unknown error';
        error.value = msg;
        return { itemId: currentId, success: false, error: msg };
      }

      // Validate the result envelope
      const result = envelope.result;
      if (!result || typeof result !== 'object') {
        const msg = 'Invalid action result envelope';
        error.value = msg;
        return { itemId: currentId, success: false, error: msg };
      }

      // Propagate result-level failures
      if (!result.success) {
        const msg = result.error ?? 'Action failed';
        error.value = msg;
        return { itemId: currentId, success: false, error: msg };
      }

      // ── Success path — update state ────────────────────────────
      // Remove the processed item from the local queue and advance
      // to the next item or to empty.
      const items = state.value.items;
      const index = state.value.currentIndex;
      const newItems = [...items];
      newItems.splice(index, 1);

      const nextIndex = newItems.length > 0
        ? Math.min(index, newItems.length - 1)
        : -1;

      state.value = {
        ...state.value,
        items: newItems,
        currentIndex: nextIndex,
        currentItem: newItems[nextIndex] ?? null,
      };

      return {
        itemId: result.itemId ?? currentId,
        success: true,
        error: null,
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
        throw new Error(
          envelope.error?.message ?? 'Failed to load review items',
        );
      }

      // Validate result shape
      const result = envelope.result;
      if (!result || typeof result !== 'object') {
        throw new Error('Invalid review list envelope: missing result');
      }

      const items = Array.isArray(result.items) ? result.items : [];
      const total =
        typeof result.total === 'number' ? result.total : items.length;
      const currentItem = items.length > 0 ? items[0]! : null;

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
    // Undo is not supported by the API — return explicit failure
    // rather than a no-op success.
    const currentId =
      state.value.currentItem?.reviewItem.id ?? '<no-current>';
    const msg = 'Undo is not supported by the API';
    error.value = msg;
    return { itemId: currentId, success: false, error: msg };
  }

  // ── Bulk actions ────────────────────────────────────────────────

  async function bulkApprove(): Promise<WebBulkActionResult> {
    return {
      results: [
        {
          itemId: '<bulk>',
          success: false,
          error: 'Bulk operations are not supported by the API',
        },
      ],
      consumedCount: 0,
      errorCount: 1,
    };
  }

  async function bulkCorrect(_categoryId: string): Promise<WebBulkActionResult> {
    return {
      results: [
        {
          itemId: '<bulk>',
          success: false,
          error: 'Bulk operations are not supported by the API',
        },
      ],
      consumedCount: 0,
      errorCount: 1,
    };
  }

  async function bulkReject(): Promise<WebBulkActionResult> {
    return {
      results: [
        {
          itemId: '<bulk>',
          success: false,
          error: 'Bulk operations are not supported by the API',
        },
      ],
      consumedCount: 0,
      errorCount: 1,
    };
  }

  async function bulkSkip(): Promise<WebBulkActionResult> {
    return {
      results: [
        {
          itemId: '<bulk>',
          success: false,
          error: 'Bulk operations are not supported by the API',
        },
      ],
      consumedCount: 0,
      errorCount: 1,
    };
  }

  // ── Navigation ──────────────────────────────────────────────────

  function selectNext(): void {
    const items = state.value.items;
    if (items.length === 0) return;
    const next = Math.min(state.value.currentIndex + 1, items.length - 1);
    state.value = {
      ...state.value,
      currentIndex: next,
      currentItem: items[next] ?? null,
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
