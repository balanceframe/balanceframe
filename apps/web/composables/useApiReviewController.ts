/**
 * Vue composable that implements the ReviewControllerAdapter interface
 * by calling Nitro API endpoints instead of using a local WorkflowStore.
 *
 * Accepts an optional session credential callback — never reads a private
 * server token from runtimeConfig.public nor hard-codes an actor identity.
 * Same-origin credentials are always sent; a Bearer token is added when
 * a getSessionToken function is provided.
 *
 * Response-level errors propagate to adapter error state. Proposal-based
 * approve/correct actions retain the exact server snapshot without consuming
 * the pending review item; only confirmed reject/skip actions refresh the queue.
 */


import { ref, shallowRef } from 'vue';
import { isProposalApprovalView } from '../types/review-client';
import type {
  ApiReviewControllerAdapter,
  PendingProposalApproval,
  WebActionResult,
  WebBulkActionResult,
} from '../types/review-client';
import type {
  ReviewSurfaceState,
  ReviewQueueItem,
  ReviewMetricsSnapshot,
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
  disposition?: string;
  approvalRequired?: boolean;
  applied?: boolean;
  verified?: boolean;
  categorizationExecuted?: boolean;
  proposal?: unknown;
}

interface RuleProposalResult {
  proposal?: unknown;
  simulationStatus?: string;
  simulationWarning?: string | null;
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
// Proposal detail types (mirrors server-side shapes)
// ---------------------------------------------------------------------------

export interface SimulationExample {
  readonly txId: string;
  readonly payee: string | null;
  readonly amount: { minorUnits: string; currency: string };
  readonly currentCategory: string | null;
  readonly wouldChange: boolean;
}

export interface SimulationEvidence {
  readonly transactionsMatched: number;
  readonly transactionsAffected: readonly string[];
  readonly categoryDistribution: Record<string, number>;
  readonly conflicts: readonly string[];
  readonly examples: readonly SimulationExample[];
  readonly simulatedAt: string;
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
): ApiReviewControllerAdapter {
  // ── Reactive state ──────────────────────────────────────────────
  const state = ref<ReviewSurfaceState>(createDefaultState());
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** ID of the most recently consumed item, for undo when queue resets. */
  const lastActedItemId = ref<string | null>(null);
  const proposalApprovalViews = shallowRef<readonly PendingProposalApproval[]>([]);

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
  function retainProposalApproval(reviewId: string, value: unknown): boolean {
    if (!isProposalApprovalView(value)) return false;
    proposalApprovalViews.value = [
      ...proposalApprovalViews.value.filter((entry) => entry.reviewId !== reviewId),
      { reviewId, proposal: value },
    ];
    return true;
  }

  function clearProposalApprovalViews(proposalId?: string): void {
    proposalApprovalViews.value = proposalId
      ? proposalApprovalViews.value.filter((entry) => entry.proposal.id !== proposalId)
      : [];
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

      if (
        actionName === 'approve' &&
        result.disposition === 'approval_required' &&
        result.approvalRequired === true &&
        result.applied === false &&
        result.verified === false &&
        result.categorizationExecuted === false
      ) {
        if (retainProposalApproval(currentId, result.proposal)) {
          error.value = null;
          return { itemId: currentId, success: false, error: null, approvalRequired: true };
        }
        const msg = 'The server did not return an exact proposal for review.';
        error.value = msg;
        return { itemId: currentId, success: false, error: msg };
      }

      if (!result.success) {
        const msg = result.error ?? 'Action failed';
        error.value = msg;
        return { itemId: currentId, success: false, error: msg };
      }

      if (actionName === 'approve') {
        const msg = 'The server did not return an approval-required proposal.';
        error.value = msg;
        return { itemId: currentId, success: false, error: msg };
      }

      // ── Success path — update state ────────────────────────────
      // Save the consumed item ID so undo can target it later.
      lastActedItemId.value = currentId;
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
    const currentItem = state.value.currentItem;
    if (!currentItem) {
      const result: WebActionResult = {
        itemId: '<no-current>',
        success: false,
        error: 'No current item to edit',
      };
      error.value = result.error;
      return result;
    }

    const currentId = currentItem.reviewItem.id;
    loading.value = true;
    error.value = null;

    try {
      const envelope = await callApi<SingleActionResult>(
        '/api/review/correct',
        'POST',
        { reviewId: currentId, categoryId },
      );

      if (envelope.status === 'error' || envelope.error) {
        const msg = envelope.error?.message ?? 'Unknown error';
        error.value = msg;
        return { itemId: currentId, success: false, error: msg };
      }

      const result = envelope.result;
      if (!result || typeof result !== 'object') {
        const msg = 'Invalid edit result envelope';
        error.value = msg;
        return { itemId: currentId, success: false, error: msg };
      }

      if (
        result.disposition === 'approval_required' &&
        result.approvalRequired === true &&
        result.applied === false &&
        result.verified === false &&
        result.categorizationExecuted === false
      ) {
        if (retainProposalApproval(currentId, result.proposal)) {
          error.value = null;
          return { itemId: currentId, success: false, error: null, approvalRequired: true };
        }
        const msg = 'The server did not return an exact proposal for review.';
        error.value = msg;
        return { itemId: currentId, success: false, error: msg };
      }

      const msg = result.error ?? 'The server did not return an approval-required category proposal.';
      error.value = msg;
      return { itemId: currentId, success: false, error: msg };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
      return { itemId: currentId, success: false, error: msg };
    } finally {
      loading.value = false;
    }
  }

  async function reject(): Promise<WebActionResult> {
    return doAction('reject');
  }
  
  async function skip(): Promise<WebActionResult> {
    return doAction('skip');
  }
  
  async function undo(): Promise<WebActionResult> {
    const targetId = lastActedItemId.value ?? state.value.currentItem?.reviewItem.id ?? '<no-current>';
    if (!lastActedItemId.value) {
      const msg = 'No item to undo. Act on an item first.';
      error.value = msg;
      return { itemId: targetId, success: false, error: msg };
    }
  
    loading.value = true;
    error.value = null;
  
    try {
      const envelope = await callApi<SingleActionResult>(
        '/api/review/undo',
        'POST',
        { reviewId: targetId },
      );
  
      if (envelope.status === 'error' || envelope.error) {
        const msg = envelope.error?.message ?? 'Unknown error';
        error.value = msg;
        return { itemId: targetId, success: false, error: msg };
      }
  
      const result = envelope.result;
      if (!result || typeof result !== 'object') {
        const msg = 'Invalid undo result envelope';
        error.value = msg;
        return { itemId: targetId, success: false, error: msg };
      }
  
      if (!result.success) {
        const msg = result.error ?? 'Undo failed';
        error.value = msg;
        return { itemId: targetId, success: false, error: msg };
      }
  
      // Clear the tracked ID so the same undo can't be replayed,
      // then refresh the queue to show the restored item.
      lastActedItemId.value = null;
      await fetchItems();
  
      return {
        itemId: result.itemId ?? targetId,
        success: true,
        error: null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
      return { itemId: targetId, success: false, error: msg };
    } finally {
      loading.value = false;
    }
  }
  
  async function proposeRule(
    reviewId: string,
    merchant: string,
    categoryId: string,
    simulation?: SimulationEvidence,
  ): Promise<WebActionResult & { simulationStatus?: string; simulationWarning?: string | null }> {
    loading.value = true;
    error.value = null;
  
    try {
      const body: Record<string, unknown> = { reviewId, merchant, categoryId };
      if (simulation) {
        body.simulation = simulation;
      }
  
      const envelope = await callApi<RuleProposalResult>(
        '/api/review/propose-rule',
        'POST',
        body,
      );

      if (envelope.status === 'error' || envelope.error) {
        const msg = envelope.error?.message ?? 'Unknown error';
        error.value = msg;
        return { itemId: reviewId, success: false, error: msg };
      }

      const result = envelope.result;
      if (
        !result ||
        !isProposalApprovalView(result.proposal) ||
        result.proposal.operation !== 'create_rule' ||
        result.proposal.disposition !== 'approval_required' ||
        !retainProposalApproval(reviewId, result.proposal)
      ) {
        const msg = 'The server did not return an exact rule proposal for review.';
        error.value = msg;
        return { itemId: reviewId, success: false, error: msg };
      }

      return {
        itemId: result.proposal.id,
        success: true,
        error: null,
        approvalRequired: true,
        simulationStatus: result.simulationStatus,
        simulationWarning: result.simulationWarning ?? null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error.value = msg;
      return { itemId: reviewId, success: false, error: msg };
    } finally {
      loading.value = false;
    }
  }
  
  // ── Bulk actions ────────────────────────────────────────────────

  async function requestBulkProposals(
    action: 'approve' | 'correct',
    categoryId?: string,
  ): Promise<WebBulkActionResult> {
    const selectedIds = [
      ...new Set(
        state.value.selectedIndices.flatMap((index) => {
          const item = state.value.items[index];
          return item ? [item.reviewItem.id] : [];
        }),
      ),
    ];
    if (!selectedIds.length) {
      return {
        results: [{ itemId: '<bulk>', success: false, error: 'No selected review items.' }],
        consumedCount: 0,
        errorCount: 1,
      };
    }

    loading.value = true;
    error.value = null;
    const results: WebActionResult[] = [];
    let errorCount = 0;
    try {
      for (const reviewId of selectedIds) {
        try {
          const envelope = await callApi<SingleActionResult>(
            `/api/review/${action}`,
            'POST',
            { reviewId, ...(action === 'correct' ? { categoryId } : {}) },
          );
          const result = envelope.result;
          if (
            envelope.status !== 'ok' ||
            envelope.error ||
            !result ||
            result.success !== false ||
            result.disposition !== 'approval_required' ||
            result.approvalRequired !== true ||
            result.applied !== false ||
            result.verified !== false ||
            result.categorizationExecuted !== false ||
            !isProposalApprovalView(result.proposal) ||
            !retainProposalApproval(reviewId, result.proposal)
          ) {
            const message =
              envelope.error?.message ?? result?.error ?? 'The server did not return an exact proposal for review.';
            results.push({ itemId: reviewId, success: false, error: message });
            errorCount += 1;
            continue;
          }
          results.push({ itemId: reviewId, success: false, error: null, approvalRequired: true });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          results.push({ itemId: reviewId, success: false, error: message });
          errorCount += 1;
        }
      }
    } finally {
      loading.value = false;
    }
    error.value = errorCount ? `${errorCount} selected review proposal(s) could not be prepared.` : null;
    return { results, consumedCount: 0, errorCount };
  }

  async function bulkApprove(): Promise<WebBulkActionResult> {
    return requestBulkProposals('approve');
  }

  async function bulkCorrect(categoryId: string): Promise<WebBulkActionResult> {
    return requestBulkProposals('correct', categoryId);
  }

  async function runBulkTransition(action: 'reject' | 'skip'): Promise<WebBulkActionResult> {
    const selectedIds = [
      ...new Set(
        state.value.selectedIndices.flatMap((index) => {
          const item = state.value.items[index];
          return item ? [item.reviewItem.id] : [];
        }),
      ),
    ];
    if (!selectedIds.length) {
      return {
        results: [{ itemId: '<bulk>', success: false, error: 'No selected review items.' }],
        consumedCount: 0,
        errorCount: 1,
      };
    }
    loading.value = true;
    error.value = null;
    const results: WebActionResult[] = [];
    let consumedCount = 0;
    let errorCount = 0;
    try {
      for (const reviewId of selectedIds) {
        try {
          const envelope = await callApi<SingleActionResult>(
            `/api/review/${action}`,
            'POST',
            { reviewId },
          );
          if (envelope.status === 'ok' && !envelope.error && envelope.result?.success) {
            results.push({ itemId: reviewId, success: true, error: null });
            consumedCount += 1;
          } else {
            const message = envelope.error?.message ?? envelope.result?.error ?? 'Review action failed.';
            results.push({ itemId: reviewId, success: false, error: message });
            errorCount += 1;
          }
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          results.push({ itemId: reviewId, success: false, error: message });
          errorCount += 1;
        }
      }
      if (consumedCount > 0) await fetchItems();
    } finally {
      loading.value = false;
    }
    error.value = errorCount ? `${errorCount} selected review action(s) failed.` : null;
    return { results, consumedCount, errorCount };
  }

  async function bulkReject(): Promise<WebBulkActionResult> {
    return runBulkTransition('reject');
  }

  async function bulkSkip(): Promise<WebBulkActionResult> {
    return runBulkTransition('skip');
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

  function selectIndex(index: number): void {
    const items = state.value.items;
    if (index < 0 || index >= items.length) return;
    state.value = {
      ...state.value,
      currentIndex: index,
      currentItem: items[index] ?? null,
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
    get proposalApprovalViews() {
      return proposalApprovalViews.value;
    },
    get loading() {
      return loading.value;
    },
    get error() {
      return error.value;
    },
    clearProposalApprovalViews,
    loadNextPage,
    refresh,
    approve,
    correct,
    reject,
    skip,
    undo,
    proposeRule,
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
