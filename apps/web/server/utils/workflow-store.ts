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
 * Mirrors the envelope shape the GET /api/review handler constructs.
 * Defined server-side to avoid depending on the client `src/review.ts`
 * module, which does not resolve under Nitro's module resolution.
 */
export interface ReviewQueueItem {
  readonly reviewItem: ReviewItem;
  readonly evidence: {
    readonly historicalClassifications: readonly unknown[];
    readonly changePreview: {
      readonly budgetId: string;
      readonly transactionId: string;
      readonly currentCategoryId: string | null;
      readonly proposedCategoryId: string | null;
      readonly transactionDate: string | null;
      readonly merchantName: string | null;
      readonly amount: number | null;
      readonly description: string | null;
    };
  };
  readonly homogeneity: {
    readonly sameMerchant: boolean;
    readonly sameAmount: boolean;
    readonly sameClassifier: boolean;
    readonly sameCategory: boolean;
  };
  readonly actionable: boolean;
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

  // Read config — Nitro auto-imports useRuntimeConfig when called from a
  // route handler, but the utility receives the event directly.
  const config = useRuntimeConfig();
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
      // Semantically: "approve with a different category".
      // pending_review -> approved; the corrected categoryId is carried
      // in the transition metadata so downstream processors can distinguish.
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'skip':
      return 'skipped';
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
}

/**
 * Perform a single review-item action against the store.
 *
 * Pure business logic — does not touch HTTP request/response.
 * Testable with any WorkflowStore implementation.
 *
 * @param store   - an initialised WorkflowStore
 * @param reviewId - the review-item ID to act on
 * @param action  - one of 'approve', 'correct', 'reject', 'skip'
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
    return { itemId: reviewId, success: false, error: 'Review item not found' };
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
    return { itemId: result.id, success: true, error: null };
  } catch (e) {
    return {
      itemId: reviewId,
      success: false,
      error: e instanceof Error ? e.message : String(e),
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
