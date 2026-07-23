/**
 * Server-side utility for initialising and accessing the SqliteWorkflowStore.
 *
 * Lazily instantiates a singleton store from runtime config on first access.
 * Returns a structured `{ error: string }` result when the store cannot be
 * initialised — the caller MUST check for `error` before using `store`.
 *
 * Usage:
 *   const wf = getWorkflowStore(event);
 *   if ('error' in wf) { return errorEnvelope(wf.error); }
 *   const items = await wf.store.listReviewItems(...);
 */

import { setResponseStatus } from 'h3';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type {
  WorkflowStore,
  ReviewStatus,
  ReviewItem,
  ReviewAction,
  TransitionReviewInput,
  ReviewListOptions,
  TransitionReviewResult,
} from '@balanceframe/workflow-store';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Server-side ReviewQueueItem type.
 *
 * Mirrors the complete ReviewEvidence shape consumed by the client
 * (ReviewItem.vue renders originalImportedName, normalizedMerchant,
 * account, amount, provenance, changePreview.fromCategory/toCategory/
 * affectsEnvelope, alternatives, history, and other evidence fields).
 *
 * Built from the persisted ReviewItem via buildReviewQueueItem().
 * Defined server-side to avoid depending on client `src/review.ts`,
 * which does not resolve under Nitro's module resolution.
 */
export interface ClassificationHistoryEntry {
  readonly categoryId: string;
  readonly count: number;
  readonly lastClassified: string;
}

export interface RuleCandidate {
  readonly merchant: string;
  readonly currentCategory: string;
  readonly matchCount: number;
  readonly consistency: number;
}

export interface ReviewQueueItem {
  readonly reviewItem: ReviewItem;
  readonly evidence: {
    readonly originalImportedName: string;
    readonly normalizedMerchant: string;
    readonly account: string;
    readonly amount: number;
    readonly currentCategory: string;
    readonly suggestedCategory: string;
    readonly alternatives: readonly string[];
    readonly history: readonly ClassificationHistoryEntry[];
    readonly ruleCandidates: readonly RuleCandidate[];
    readonly provenance: string;
    readonly freshness: string | null;
    readonly changePreview: {
      readonly fromCategory: string;
      readonly toCategory: string;
      readonly affectsEnvelope: boolean;
    };
    readonly correlationId: string | null;
    readonly categoryNames?: Record<string, string>;
    readonly promptVersion: string;
  };
  readonly homogeneity: {
    readonly sameMerchant: boolean;
    readonly sameAmount: boolean;
    readonly sameClassifier: boolean;
    readonly sameCategory: boolean;
  };
  readonly actionable: boolean;
}

/**
 * Build a complete ReviewQueueItem from persisted review data.
 *
 * Enriches the item with evidence derived from the classifier payload
 * (`item.evidence` Record) and deterministic safe defaults where the
 * persisted data lacks enrichment.  Mirrors the client-side
 * `extractEvidence()` logic in `src/review.ts` so that the API response
 * is immediately render-compatible without client-side re-derivation.
 *
 * @param item - a persisted ReviewItem (may carry classifier evidence)
 */
export function buildReviewQueueItem(item: ReviewItem): ReviewQueueItem {
  const pay = item.evidence as Record<string, unknown> | undefined;

  const originalImportedName: string =
    typeof pay?.originalName === 'string'
      ? pay.originalName
      : item.transactionId;

  const normalizedMerchant: string =
    typeof pay?.normalizedMerchant === 'string'
      ? pay.normalizedMerchant
      : item.transactionId;

  const account: string =
    typeof pay?.account === 'string' ? pay.account : '';

  const amount: number =
    typeof pay?.amount === 'number' ? pay.amount : 0;

  const alternativesList: readonly string[] =
    Array.isArray(pay?.alternatives)
      ? (pay.alternatives as string[])
      : [];

  const historyList: readonly ClassificationHistoryEntry[] =
    Array.isArray(pay?.history)
      ? (pay.history as ClassificationHistoryEntry[])
      : [];

  const totalCount = historyList.reduce((sum, h) => sum + h.count, 0);
  const ruleCandidates: RuleCandidate[] = totalCount > 0
    ? historyList.map((h) => ({
        merchant: normalizedMerchant,
        currentCategory: h.categoryId,
        matchCount: h.count,
        consistency: h.count / totalCount,
      }))
    : [];

  const fromCategory: string =
    typeof pay?.currentCategory === 'string' && pay.currentCategory
      ? pay.currentCategory
      : (item.categoryId || 'Uncategorized');
  const toCategory: string = item.categoryId || '—';


  return {
    reviewItem: item,
    evidence: {
      originalImportedName,
      normalizedMerchant,
      account,
      amount,
      currentCategory: fromCategory,
      suggestedCategory: item.categoryId || '—',
      alternatives: alternativesList,
      history: historyList,
      ruleCandidates,
      provenance: item.provenance,
      freshness: item.freshnessExpiresAt,
      changePreview: {
        fromCategory,
        toCategory,
        affectsEnvelope: fromCategory !== toCategory,
      },
      correlationId: item.correlationId,
      promptVersion: item.promptVersion,
      categoryNames: (pay?.categoryNames as Record<string, string> | undefined) ?? undefined,
    },
    homogeneity: {
      sameMerchant: false,
      sameAmount: false,
      sameClassifier: false,
      sameCategory: false,
    },
    actionable: item.status === 'pending_review' || item.status === 'correcting',
  };
}

// ---------------------------------------------------------------------------
// Structural event type
// ---------------------------------------------------------------------------

/**
 * Structural event type compatible with both real Nitro/H3 events and test
 * doubles.  Replaces narrow inline types that failed weak-type assignability
 * with `H3Event` (whose `H3EventContext` has no overlapping properties).
 *
 * The index signature on `context` allows any object — real `H3Event` carries
 * `context: H3EventContext`, test doubles carry `context: { ... }`.
 */
export interface EventWithContext {
  context: {
    [key: string]: unknown;
    runtimeConfig?: Record<string, unknown>;
    auth?: { authenticated: boolean; actorId?: string };
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton (persistent for the process lifetime)
// ---------------------------------------------------------------------------

let store: SqliteWorkflowStore | null = null;
let storeError: string | null = null;

/**
 * Get (or initialise) the workflow store.
 *
 * @returns `{ store }` on success or `{ error: string }` when the store
 */
export function getWorkflowStore(
  event: EventWithContext,
): { store: SqliteWorkflowStore } | { error: string } {
  if (storeError) return { error: storeError };
  if (store) return { store };

  let config: Record<string, unknown>;
  try {
    config = useRuntimeConfig(event) as Record<string, unknown>;
  } catch {
    config = (event.context.runtimeConfig as Record<string, unknown> | undefined) ?? {};
  }
  const dbPath: string =
    (config.workflowDbPath as string) ||
    process.env.BALANCEFRAME_WORKFLOW_DB_PATH ||
    './data/workflow.db';

  if (!dbPath) {
    storeError =
      'Workflow database path not configured. Set workflowDbPath in ' +
      'runtime config or BALANCEFRAME_WORKFLOW_DB_PATH env var.';
    return { error: storeError };
  }

  // Ensure the parent directory exists — better-sqlite3 cannot create it.
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {
    // Directory creation failed — let the store constructor report the error.
  }


  try {
    store = new SqliteWorkflowStore(dbPath);
    return { store };
  } catch (e) {
    storeError = e instanceof Error ? e.message : String(e);
    return { error: storeError };
  }
}

// ---------------------------------------------------------------------------
// Actor identity
// ---------------------------------------------------------------------------

/**
 * Derive the acting identity from the request's auth context.
 *
 * The auth middleware validates a Bearer token and sets
 * `event.context.auth = { authenticated: true, actorId }`.
 * The actor identity is never taken from the request body (which would
 * allow spoofing) — it comes from trusted server configuration via the
 * middleware.
 */
export function getActorId(
  event: EventWithContext,
): string {
  if (!event.context.auth?.authenticated) return 'anonymous';
  return event.context.auth.actorId || 'api-user';
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

/** Map a route action name to the corresponding target review status. */
function statusForAction(action: string): ReviewStatus {
  switch (action) {
    case 'approve':
      return 'approved';
    case 'correct':
      // pending_review -> correcting; the corrected categoryId is carried
      // in the transition metadata so downstream processors know which
      // category the reviewer selected.
      return 'correcting';
    case 'reject':
      return 'rejected';
    case 'skip':
      return 'skipped';
    case 'undo':
      return 'pending_review';
    default:
      throw new Error(`Unknown review action: ${action}`);
  }
}

/**
 * Result of a single-item review action.
 * Mirrors the SingleActionResult envelope shape for the API response.
 */
export interface ActionOutcome {
  readonly itemId: string;
  readonly success: boolean;
  readonly error: string | null;
  /** Resulting review status after the action, or null on failure. */
  readonly status: ReviewStatus | null;
}

/**
 * Perform a single review-item action against the store.
 *
 * Pure business logic — does not touch HTTP request/response.
 * Testable with any WorkflowStore implementation.
 *
 * @param store   - an initialised WorkflowStore
 * @param reviewId - the review-item ID to act on
 * @param action  - one of 'approve', 'correct', 'reject', 'skip', 'undo'
 * @param actorId - the authenticated actor identifier
 * @param categoryId - optional category for 'correct' action
 */
export async function performReviewAction(
  store: WorkflowStore,
  reviewId: string,
  action: string,
  actorId: string,
  categoryId?: string,
): Promise<ActionOutcome> {
  // Verify the item exists and get its current version for optimistic locking.
  const item = await store.getReviewItem(reviewId);
  if (!item) {
    return { itemId: reviewId, success: false, error: 'Review item not found', status: null };
  }

  if (action === 'undo') {
    try {
      const result = await store.undoReviewTransition(reviewId, actorId, 'Reversed by reviewer');
      return { itemId: result.id, success: true, error: null, status: result.status };
    } catch (e) {
      return {
        itemId: reviewId,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        status: null,
      };
    }
  }
  const toStatus = statusForAction(action);

  try {
    const input: TransitionReviewInput = {
      toStatus,
      actor: actorId,
      expectedVersion: item.version,
      metadata: categoryId ? { categoryId } : undefined,
    };
    const result = await store.transitionReviewItem(reviewId, input);

    // After a correct action, also update the item's category_id so
    // downstream display (change preview, queue) reflects the edit.
    if (action === 'correct' && categoryId) {
      await store.updateReviewItemCategory(
        reviewId,
        categoryId,
        result.version,
      );
    }

    return { itemId: result.id, success: true, error: null, status: result.status };
  } catch (e) {
    return {
      itemId: reviewId,
      success: false,
      error: e instanceof Error ? e.message : String(e),
      status: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

/**
 * Envelope shape matching what the client composable's `ApiEnvelope<T>`
 * expects (see `useApiReviewController.ts`).
 */
export interface AuthorizationInfo {
  actorId: string;
  capability: string;
  allowed: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ApiEnvelope<T> {
  schemaVersion: string;
  requestId: string;
  status: 'ok' | 'error';
  dataFreshness: unknown | null;
  authorization: AuthorizationInfo | null;
  result: T;
  error: ApiError | null;
}

/**
 * Build an ok envelope.
 * @param requestId defaults to crypto.randomUUID().
 */
export function okEnvelope<T>(
  result: T,
  auth: AuthorizationInfo | null,
  requestId: string = crypto.randomUUID(),
): ApiEnvelope<T> {
  return {
    schemaVersion: '1',
    requestId,
    status: 'ok',
    dataFreshness: null,
    authorization: auth,
    result,
    error: null,
  };
}

/**
 * Build an error envelope (caller should also setResponseStatus).
 * @param requestId defaults to crypto.randomUUID().
 */
export function errorEnvelope(
  code: string,
  message: string,
  auth: AuthorizationInfo | null,
  retryable: boolean = false,
  requestId: string = crypto.randomUUID(),
): ApiEnvelope<null> {
  return {
    schemaVersion: '1',
    requestId,
    status: 'error',
    dataFreshness: null,
    authorization: auth,
    result: null,
    error: { code, message, retryable },
  };
}


/** Build the authorization info for the response envelope. */
export function buildAuthorizationInfo(
  event: EventWithContext,
  capability: string,
): AuthorizationInfo | null {
  const auth = event.context.auth as { authenticated: boolean } | undefined;
  if (!auth) return null;
  return {
    actorId: getActorId(event),
    capability,
    allowed: true,
  };
}

/**
 * Result of a route-level authorization guard check.
 * When `ok` is true, `info` holds the AuthorizationInfo for response envelopes.
 * When `ok` is false, `response` is the error envelope (status code already set).
 */
export type AuthGuardResult =
  | { ok: true; info: AuthorizationInfo }
  | { ok: false; response: ApiEnvelope<null> };

/**
 * Require that the request is authenticated and has the given capability.
 *
 * Checks:
 *   1. Auth context exists on the event (set by middleware)
 *   2. Workflow store is available
 *   3. Actor's membership is active and includes the capability
 *
 * On success returns `{ ok: true, info: AuthorizationInfo }`.
 * On failure sets the response status (403, 503, or 500) and returns
 * `{ ok: false, response: ApiEnvelope<null> }` — the caller MUST return early.
 */
export async function requireAuthorization(
  event: EventWithContext,
  capability: string,
): Promise<AuthGuardResult> {
  const auth = event.context.auth as { authenticated: boolean; actorId?: string } | undefined;
  if (!auth?.authenticated) {
    setResponseStatus(event, 403);
    return {
      ok: false,
      response: errorEnvelope(
        'AUTHORIZATION_REQUIRED',
        'Authentication is required for this operation',
        null,
        false,
      ),
    };
  }

  const actorId = getActorId(event);
  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return {
      ok: false,
      response: errorEnvelope('STORE_UNAVAILABLE', wf.error, null, false),
    };
  }

  let result: { allowed: boolean; reason: string };
  try {
    result = await wf.store.evaluateAuthorization(actorId, capability, '*', '1.0');
  } catch {
    setResponseStatus(event, 500);
    return {
      ok: false,
      response: errorEnvelope(
        'AUTHORIZATION_CHECK_FAILED',
        'Authorization check could not be completed',
        null,
        false,
      ),
    };
  }

  if (!result.allowed) {
    setResponseStatus(event, 403);
    return {
      ok: false,
      response: errorEnvelope('FORBIDDEN', result.reason, null, false),
    };
  }

  return {
    ok: true,
    info: { actorId, capability, allowed: true },
  };
}

// ---------------------------------------------------------------------------
// Error sanitization — prevent internal details from leaking to API clients
// ---------------------------------------------------------------------------

/**
 * Result of sanitizing a caught error for user-safe API responses.
 */
export interface SanitizedError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Strip filesystem paths, source references, and adapter-internal details
 * from a raw error message, returning a user-safe summary.
 */
export function sanitizeErrorMessage(raw: string): string {
  // Remove Unix filesystem paths: /path/to/file or /path/to/dir.ext
  let safe = raw.replace(/\/(?:[^\s/]+\/)+[^\s/]*/g, '');
  // Remove Windows filesystem paths: C:\path\to\file.ext
  safe = safe.replace(/[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]*/g, '');
  // Remove stack-frame trailers (Node/V8 stack lines)
  safe = safe.replace(/\n\s*at\s.*$/s, '');
  // Remove inline source references: (file.ts:42) or at file.ts:42:10
  safe = safe.replace(/\s*\([\w./-]+\.\w+:\d+(?::\d+)?\)/, '');
  // Remove error-type prefixes like "Error:" "TypeError:" at the start
  safe = safe.replace(/^\w+Error:\s*/, '');
  // Remove internal adapter/component names in parens: (ActualLedger)
  safe = safe.replace(/\s*\([A-Z][a-zA-Z]*(?:Adapter|Ledger|Store|Service|Manager)\)/g, '');
  // Collapse internal method/class references: ActualLedger.deleteRule
  safe = safe.replace(/\b[A-Z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*/g, '');
  return safe.trim() || 'An unexpected error occurred.';
}

/**
 * Process a caught Error for safe API error responses.
 *
 * Logs the full error details (message + stack trace) with the correlation
 * ID to the server log, then returns a user-safe structure whose `message`
 * contains no filesystem paths, adapter internals, or source-level detail.
 *
 * @example
 *   catch (err) {
 *     const safe = sanitizeError(err, requestId, 'RULE_UPDATE_FAILED', true);
 *     setResponseStatus(event, 500);
 *     return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
 *   }
 */
export function sanitizeError(
  err: unknown,
  requestId: string,
  code: string,
  retryable: boolean = false,
): SanitizedError {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';

  // Log EVERYTHING with the correlation ID for server-side debugging
  console.error(`[${requestId}] ${code}: ${rawMessage}${stack}`);

  return {
    code,
    message: sanitizeErrorMessage(rawMessage),
    retryable,
  };
}

// ---------------------------------------------------------------------------
// Mutation service seam — typed bridge between web routes and the
// CategorizationMutationService (in @balanceframe/application).  The web
// layer does NOT depend on the application package; instead, the composition
// root (or test harness) injects a ReviewMutationExecutor callback.
//
// reviewAndApply mode (enabled via runtimeConfig) makes approve/correct
// actually write categorization mutations, not just transition workflow state.
// ---------------------------------------------------------------------------

/**
 * Status values for the mutation phase of a review action.
 *
 * - `noop`       — no mutation was attempted (Observe mode).
 * - `denied`     — reviewAndApply is configured but no executor is wired.
 * - `applying`   — mutation is in progress (async / deferred).
 * - `applied`    — mutation write succeeded (verification pending / not done).
 * - `apply_failed` — mutation write failed.
 * - `stale`      — mutation was not attempted because snapshot data is stale.
 * - `verified`   — mutation write succeeded AND postcondition verification passed.
 */
export type MutationStatus = 'noop' | 'denied' | 'applying' | 'applied' | 'apply_failed' | 'stale' | 'verified';

/** Input to the review mutation executor. */
export interface ReviewMutationInput {
  readonly reviewId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly categoryId?: string;
  readonly correlationId?: string;
}

/** Result of a categorized mutation from the executor. */
export interface ReviewMutationResult {
  readonly mutationStatus: MutationStatus;
  readonly success: boolean;
  readonly applied: boolean;
  readonly verified: boolean;
  readonly stale: boolean;
  readonly transactionId: string | null;
  readonly previousCategoryId: string | null;
  readonly newCategoryId: string | null;
  readonly error: string | null;
}

/**
 * Typed callback that performs the actual ledger mutation for a review action.
 *
 * The composition root (@balanceframe/application's CategorizationMutationService)
 * wires this, so web routes never depend on application internals.
 */
export type ReviewMutationExecutor = (
  input: ReviewMutationInput,
  store: WorkflowStore,
  item: ReviewItem,
) => Promise<ReviewMutationResult>;

/** Module-level executor — set by the composition root at startup. */
let _mutationExecutor: ReviewMutationExecutor | null = null;

/**
 * Inject the mutation executor (called once by the composition root).
 */
export function setReviewMutationExecutor(fn: ReviewMutationExecutor | null): void {
  _mutationExecutor = fn;
}

/**
 * Get the currently registered mutation executor, or null.
 */
export function getReviewMutationExecutor(): ReviewMutationExecutor | null {
  return _mutationExecutor;
}

/**
 * Check whether reviewAndApply (mutation-enabled) mode is active for this
 * request based on runtime configuration.
 */
export function reviewAndApplyEnabled(event: EventWithContext): boolean {
  const config = event.context.runtimeConfig as Record<string, unknown> | undefined;
  return config?.reviewAndApply === true;
}

// ---------------------------------------------------------------------------
// Factory-based executor creation (event-context-aware)
// ---------------------------------------------------------------------------

/**
 * Factory type — creates a per-request ReviewMutationExecutor from the
 * event context.  This allows the composition root to wire real services
 * (BudgetLedger, CategorizationMutationService) without the web layer
 * depending on @balanceframe/application or @balanceframe/actual-adapter.
 */
export type ReviewMutationExecutorFactory = (
  event: EventWithContext,
) => ReviewMutationExecutor | null;

/** Module-level factory — set by the composition root at startup. */
let _executorFactory: ReviewMutationExecutorFactory | null = null;

/**
 * Register an executor factory (called once by the composition root).
 * Clears any previously set module-level factory.
 */
export function setReviewMutationExecutorFactory(
  fn: ReviewMutationExecutorFactory | null,
): void {
  _executorFactory = fn;
}

/**
 * Get the current executor factory, or null.
 */
export function getReviewMutationExecutorFactory(): ReviewMutationExecutorFactory | null {
  return _executorFactory;
}

/**
 * Resolve a mutation executor for the given event context.
 *
 * Priority:
 * 1. Factory-based executor (per-request, from event context)
 * 2. Module-level singleton (set via setReviewMutationExecutor)
 *
 * Returns null when no executor is available for this request.
 */
export function getReviewMutationExecutorFromEvent(
  event: EventWithContext,
): ReviewMutationExecutor | null {
  if (_executorFactory) {
    const fromFactory = _executorFactory(event);
    if (fromFactory) return fromFactory;
  }
  return _mutationExecutor;
}

// ---------------------------------------------------------------------------
// Mutation transition orchestration
// ---------------------------------------------------------------------------

/**
 * Result of executing a review mutation with workflow-state transitions.
 */
export interface MutationTransitionResult {
  readonly mutationResult: ReviewMutationResult;
  readonly finalStatus: ReviewStatus;
}

/**
 * Execute a mutation with the applying → (applied | apply_failed) state
 * transition semantics.
 *
 * Flow:
 *   approved → applied (on verified success)
 *   approved → apply_failed (on failure / stale / unverified)
 *
 * Maps stale and verification failures explicitly — a successful write
 * that fails verification lands in apply_failed with metadata.
 *
 * @param store        — the workflow store
 * @param reviewId     — the item to act on
 * @param actorId      — authenticated actor
 * @param executor     — the mutation executor callback
 * @param requestId    — tracking ID
 * @param categoryId   — optional category override (for 'correct')
 * @param executionId  — optional correlation/execution ID
 */
export async function applyReviewMutationWithTransition(
  store: WorkflowStore,
  reviewId: string,
  actorId: string,
  executor: ReviewMutationExecutor,
  requestId: string,
  categoryId?: string,
  executionId?: string,
): Promise<MutationTransitionResult> {
  // Read current item state (should be 'approved' after performReviewAction)
  const item = await store.getReviewItem(reviewId);
  if (!item) {
    throw new Error(`Review item ${reviewId} not found before mutation`);
  }

  // Execute the mutation
  const mutationResult = await executor(
    { reviewId, actorId, requestId, categoryId, correlationId: executionId },
    store,
    item,
  );

  // Determine final workflow status based on the mutation result.
  // Map stale and verification failures explicitly.
  let finalStatus: ReviewStatus;
  const metadata: Record<string, unknown> = {
    mutationStatus: mutationResult.mutationStatus,
    stale: mutationResult.stale,
    transactionId: mutationResult.transactionId,
  };

  if (mutationResult.mutationStatus === 'denied') {
    // Executor declined the operation — leave in approved (no change)
    finalStatus = item.status;
  } else if (mutationResult.verified) {
    // Write + verification all passed
    finalStatus = 'applied';
    metadata.verified = true;
  } else if (mutationResult.stale) {
    // Explicit staleness mapping
    finalStatus = 'apply_failed';
    metadata.staleReason = 'snapshot_stale';
    metadata.error = mutationResult.error;
  } else if (mutationResult.applied && !mutationResult.verified) {
    // Write happened but postcondition verification failed
    finalStatus = 'apply_failed';
    metadata.verificationFailed = true;
    metadata.error = mutationResult.error;
  } else {
    // Generic failure
    finalStatus = 'apply_failed';
    metadata.error = mutationResult.error;
  }

  // Only issue a transition if the final status differs from current
  if (finalStatus !== item.status) {
    const itemBeforeTransition = await store.getReviewItem(reviewId);
    if (!itemBeforeTransition) {
      throw new Error(`Review item ${reviewId} not found for final transition`);
    }
    await store.transitionReviewItem(reviewId, {
      toStatus: finalStatus,
      actor: actorId,
      expectedVersion: itemBeforeTransition.version,
      metadata,
    });
  }

  return { mutationResult, finalStatus };
}

/** Re-export ReviewStatus for route handler convenience. */
export type { ReviewStatus } from '@balanceframe/workflow-store';
