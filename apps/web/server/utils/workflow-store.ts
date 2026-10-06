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

import { setHeader, setResponseStatus } from 'h3';
import type { H3Event } from 'h3';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type {
  WorkflowStore,
  ReviewStatus,
  ReviewItem,
  AuthorizedReviewTransitionInput,
  ReviewActionAuthorization,
  ReviewListOptions,
  GovernanceResourceKind,
  OperationalAuth,
} from '@balanceframe/workflow-store';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { requireSelectedSpace } from './space-context';
import type { Money } from '@balanceframe/protocol-generated';
import type { CategorizationCandidate, MerchantAnalysisView, MerchantPublicSuggestion, MerchantPublicRecurrence, MerchantReviewProof } from '@balanceframe/application';
import type { CredentialLifetime } from '@balanceframe/workflow-store';

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
  readonly firstDate?: string;
  readonly lastDate?: string;
  readonly ledgerCount?: number;
  readonly correctionCount?: number;
}

export interface RuleCandidate {
  readonly merchant: string;
  readonly currentCategory: string;
  readonly matchCount: number;
  readonly payeeId: string;
  readonly categoryId: string;
  readonly supportCount: number;
  readonly consistencyNumerator: number;
  readonly consistencyDenominator: number;
}


export interface PublicReviewItem {
  readonly id: string;
  readonly budgetId: string;
  readonly transactionId: string;
  readonly categoryId: string;
  readonly classifier: 'Review';
  readonly promptVersion: '';
  readonly transactionVersion: number;
  readonly status: ReviewItem['status'];
  readonly correlationId: null;
  readonly reviewersRequired: number;
  readonly priority: number;
  readonly freshnessExpiresAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewQueueItem {
  readonly reviewItem: PublicReviewItem;
  readonly evidence: {
    readonly originalImportedName: string;
    readonly normalizedMerchant: string;
    readonly account: string;
    readonly amount?: number;
    readonly money?: Money;
    readonly currency?: string;
    readonly merchantProof?: MerchantReviewProof;
    readonly merchantEvidence?: MerchantPublicSuggestion;
    readonly merchantRecurrences?: readonly MerchantPublicRecurrence[];
    readonly source?: CategorizationCandidate['source'];
    readonly merchantAsOfDate?: string;
    readonly merchantNormalizationVersion?: MerchantAnalysisView['normalizationVersion'];
    readonly merchantExpiresAt?: string;
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

export interface ProjectedReviewEvidence {
  readonly originalImportedName: string;
  readonly normalizedMerchant: string;
  readonly account: string;
  readonly amount?: number;
  readonly money?: Money;
  readonly currency?: string;
  readonly merchantProof?: MerchantReviewProof;
  readonly merchantEvidence?: MerchantPublicSuggestion;
  readonly merchantRecurrences?: readonly MerchantPublicRecurrence[];
  readonly source?: CategorizationCandidate['source'];
  readonly merchantAsOfDate?: string;
  readonly merchantNormalizationVersion?: MerchantAnalysisView['normalizationVersion'];
  readonly merchantExpiresAt?: string;
  readonly provenance?: string;
  readonly history?: readonly ClassificationHistoryEntry[];
  readonly alternatives?: readonly string[];
  readonly ruleCandidates?: readonly RuleCandidate[];
  readonly currentCategory: string;
  readonly suggestedCategory: string;
  readonly categoryNames: Record<string, string>;
  readonly actionable?: boolean;
}


/**
 * Build a public review DTO from persisted workflow state and current
 * independently authorized transaction facts. Classifier evidence is opaque.
 */
export function buildReviewQueueItem(
  item: ReviewItem,
  projected?: ProjectedReviewEvidence,
): ReviewQueueItem {
  const currentCategory = projected?.currentCategory ?? 'Restricted category';
  const suggestedCategory = projected?.suggestedCategory ?? 'Restricted category';

  return {
    reviewItem: {
      id: item.id,
      budgetId: item.budgetId,
      transactionId: item.transactionId,
      categoryId: item.categoryId,
      classifier: 'Review',
      promptVersion: '',
      transactionVersion: item.transactionVersion,
      status: item.status,
      correlationId: null,
      reviewersRequired: item.reviewersRequired,
      priority: item.priority,
      freshnessExpiresAt: item.freshnessExpiresAt,
      version: item.version,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    },
    evidence: {
      originalImportedName: projected?.originalImportedName ?? '',
      normalizedMerchant: projected?.normalizedMerchant ?? '',
      account: projected?.account ?? '',
      ...(projected?.amount !== undefined ? { amount: projected.amount } : {}),
      ...(projected?.money ? { money: projected.money, currency: projected.money.currency } : {}),
      ...(projected?.merchantProof ? { merchantProof: projected.merchantProof } : {}),
      ...(projected?.merchantEvidence ? { merchantEvidence: projected.merchantEvidence } : {}),
      ...(projected?.merchantRecurrences ? { merchantRecurrences: projected.merchantRecurrences } : {}),
      ...(projected?.source ? { source: projected.source } : {}),
      ...(projected?.merchantAsOfDate ? { merchantAsOfDate: projected.merchantAsOfDate } : {}),
      ...(projected?.merchantNormalizationVersion ? { merchantNormalizationVersion: projected.merchantNormalizationVersion } : {}),
      ...(projected?.merchantExpiresAt ? { merchantExpiresAt: projected.merchantExpiresAt } : {}),
      currentCategory,
      suggestedCategory,
      alternatives: projected?.alternatives ?? [],
      history: projected?.history ?? [],
      ruleCandidates: projected?.ruleCandidates ?? [],
      provenance: projected?.provenance ?? '',
      freshness: item.freshnessExpiresAt,
      changePreview: {
        fromCategory: currentCategory,
        toCategory: suggestedCategory,
        affectsEnvelope: item.categoryId !== '' && currentCategory !== suggestedCategory,
      },
      correlationId: null,
      promptVersion: '',
      ...(projected ? { categoryNames: projected.categoryNames } : {}),
    },
    homogeneity: {
      sameMerchant: false,
      sameAmount: false,
      sameClassifier: false,
      sameCategory: false,
    },
    actionable: projected?.actionable ?? (item.status === 'pending_review' || item.status === 'correcting'),
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
    auth?: CredentialLifetime & {
      authenticated: boolean;
      actorId?: string;
      method?: 'session' | 'api-key' | 'legacy-token' | 'development';
      principalType?: 'human' | 'agent';
      sessionId?: string;
      credentialId?: string;
      credentialOwnerId?: string;
      delegationId?: string;
      delegationVersion?: string;
      impersonatedBy?: string | null;
      user?: Record<string, unknown>;
    };
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
    config = useRuntimeConfig(event as unknown as H3Event) as Record<string, unknown>;
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
export function getActorId(event: EventWithContext): string {
  const auth = event.context.auth;
  if (!auth?.authenticated || auth.impersonatedBy) return 'anonymous';
  if (auth.principalType === 'agent') return auth.actorId || 'anonymous';

  // Human sessions use Better Auth's canonical identity; an agent's issuer is not its principal.
  const userId = auth.user?.id;
  if (typeof userId === 'string' && userId.length > 0) return userId;
  return auth.actorId || 'anonymous';
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

/** Performs human non-ledger triage with exact trusted facts; Native commits scope, status and audit atomically. */
export async function performReviewAction(
  store: WorkflowStore,
  reviewId: string,
  action: 'reject' | 'skip' | 'undo',
  actorId: string,
  authorization: ReviewActionAuthorization,
): Promise<ActionOutcome> {
  if (!authorization)
    throw new Error('Review action authorization unavailable', { cause: 'authorization_denied' });
  // Verify the item exists and get its current version for optimistic locking.
  const item = await store.getReviewItem(reviewId);
  if (!item) {
    return { itemId: reviewId, success: false, error: 'Review item not found', status: null };
  }

  if (action === 'undo') {
    try {
      const result = await store.undoReviewTransition(reviewId, actorId, 'Reversed by reviewer', item.version, authorization);
      return { itemId: result.id, success: true, error: null, status: result.status };
    } catch (e) {
      if (e instanceof Error && e.cause === 'authorization_denied') throw e;
      return {
        itemId: reviewId,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        status: null,
      };
    }
  }
  const toStatus = action === 'reject' ? 'rejected' : 'skipped';

  try {
    const input: AuthorizedReviewTransitionInput = {
      toStatus,
      actor: actorId,
      expectedVersion: item.version,
      authorization,
    };
    const result = await store.transitionReviewItem(reviewId, input);


    return { itemId: result.id, success: true, error: null, status: result.status };
  } catch (e) {
    if (e instanceof Error && e.cause === 'authorization_denied') throw e;
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
  dataFreshness: {
    actualDownloadedAt: string | null;
    bankSyncedAt: string | null;
    pendingTransactionsIncluded: boolean;
    stalenessDays: number;
    isStale: boolean;
  } | null;
  authorization: AuthorizationInfo | null;
  result: T;
  error: ApiError | null;
  /** Optional analysis scope. */
  scope?: Record<string, unknown>;
  /** Optional semantic classification tags. */
  semanticClasses?: string[];
  /** Optional evidence references. */
  evidence?: Array<{ source: string; id: string; weight: number }>;
  /** Optional policy version. */
  policyVersion?: string;
}

export interface WebEnvelopeMetadata {
  dataFreshness?: ApiEnvelope<unknown>['dataFreshness'];
  scope?: Record<string, unknown>;
  semanticClasses?: string[];
  evidence?: Array<{ source: string; id: string; weight: number }>;
  policyVersion?: string;
}
/**
 * Extract application envelope metadata for forwarding through the web API.
 * Keeping this structural avoids coupling the web package to application types.
 */
export function envelopeMetadata(envelope: {
  dataFreshness: ApiEnvelope<unknown>['dataFreshness'];
  scope?: Record<string, unknown>;
  semanticClasses?: string[];
  evidence?: Array<{ source: string; id: string; weight: number }>;
  policyVersion?: string;
}): WebEnvelopeMetadata {
  return {
    dataFreshness: envelope.dataFreshness,
    ...(envelope.scope !== undefined ? { scope: envelope.scope } : {}),
    ...(envelope.semanticClasses !== undefined
      ? { semanticClasses: envelope.semanticClasses }
      : {}),
    ...(envelope.evidence !== undefined ? { evidence: envelope.evidence } : {}),
    ...(envelope.policyVersion !== undefined ? { policyVersion: envelope.policyVersion } : {}),
  };
}

/**
 * Build an ok envelope.
 * @param requestId defaults to crypto.randomUUID().
 */
export function okEnvelope<T>(
  result: T,
  auth: AuthorizationInfo | null,
  requestId: string = crypto.randomUUID(),
  metadata?: WebEnvelopeMetadata,
): ApiEnvelope<T> {
  return {
    schemaVersion: '1',
    requestId,
    status: 'ok',
    dataFreshness: metadata?.dataFreshness ?? null,
    authorization: auth,
    result,
    error: null,
    ...(metadata?.scope !== undefined ? { scope: metadata.scope } : {}),
    ...(metadata?.semanticClasses !== undefined
      ? { semanticClasses: metadata.semanticClasses }
      : {}),
    ...(metadata?.evidence !== undefined ? { evidence: metadata.evidence } : {}),
    ...(metadata?.policyVersion !== undefined ? { policyVersion: metadata.policyVersion } : {}),
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
  metadata?: WebEnvelopeMetadata,
): ApiEnvelope<null> {
  return {
    schemaVersion: '1',
    requestId,
    status: 'error',
    dataFreshness: metadata?.dataFreshness ?? null,
    authorization: auth,
    result: null,
    error: { code, message, retryable },
    ...(metadata?.scope !== undefined ? { scope: metadata.scope } : {}),
    ...(metadata?.semanticClasses !== undefined
      ? { semanticClasses: metadata.semanticClasses }
      : {}),
    ...(metadata?.evidence !== undefined ? { evidence: metadata.evidence } : {}),
    ...(metadata?.policyVersion !== undefined ? { policyVersion: metadata.policyVersion } : {}),
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
  { ok: true; info: AuthorizationInfo } | { ok: false; response: ApiEnvelope<null> };

const scopeKinds: Readonly<Record<string, GovernanceResourceKind>> = {
  space: 'space', budget: 'budget', account: 'account', category: 'category',
  transaction: 'transaction', rule: 'rule', evidence: 'evidence', wallet: 'wallet',
  receipt: 'receipt', commitment: 'commitment', scenario: 'scenario',
  reservation: 'reservation', purchase: 'purchase', transfer: 'transfer',
  ledger_effect: 'ledger_effect', session: 'session', proposal: 'proposal',
};

/** Admits a named proposal scope; full-payload Native authorization remains mandatory before creating an intent. */
export async function requireProposalAuthorization(
  event: EventWithContext, capability: string, exactScope: string, operation: string,
): Promise<AuthGuardResult> {
  return authorizeSelectedResource(event, capability, exactScope, 'propose', operation);
}

/**
 * Require a current scoped grant inside the explicitly selected space.
 * This read-admission guard does not replace full-payload action authorization
 * or the separately verified human control/approval proof.
 */
export async function requireAuthorization(
  event: EventWithContext,
  capability: string,
  exactScope?: string,
): Promise<AuthGuardResult> {
  return authorizeSelectedResource(event, capability, exactScope, 'read', capability);
}

/** Admits aggregate-only conclusions without granting any resource-level visibility. */
export async function requireAggregateAuthorization(
  event: EventWithContext, capability: string, exactScope: string,
): Promise<AuthGuardResult> {
  return authorizeSelectedResource(event, capability, exactScope, 'read', capability, 'aggregate');
}

/** Persist admitted scope and verified identity without recording financial payloads or credentials. */
export async function recordReadAdmission(
  event: EventWithContext,
  store: WorkflowStore,
  input: {
    readonly actorId: string; readonly spaceId: string; readonly membershipId: string;
    readonly budgetId: string | null; readonly policyVersion: string | null;
    readonly capability?: string; readonly resourceKind: GovernanceResourceKind; readonly resourceId: string;
    readonly operation: string; readonly phase: 'read' | 'propose'; readonly auth: OperationalAuth;
  },
): Promise<void> {
  const requestId = typeof event.context.requestId === 'string' ? event.context.requestId : crypto.randomUUID();
  event.context.requestId = requestId;
  setHeader(event as unknown as H3Event, 'X-BalanceFrame-Request-ID', requestId);
  await store.appendAuditRecord({
    classification: 'authorization_check', actorId: input.actorId,
    operation: input.operation, budgetId: input.budgetId, policyVersion: input.policyVersion,
    requestId, correlationId: requestId, authorizationDisposition: { kind: 'authorized_without_approval' },
    result: JSON.stringify({
      kind: input.phase === 'read' ? 'read_admission' : 'proposal_admission',
      spaceId: input.spaceId, membershipId: input.membershipId, capability: input.capability,
      resourceKind: input.resourceKind, resourceId: input.resourceId,
      principalType: input.auth.method === 'api-key' ? input.auth.principalType ?? 'human' : 'human',
      authenticationMethod: input.auth.method,
      ...(input.auth.method === 'api-key' && input.auth.principalType === 'agent'
        ? { delegationId: input.auth.delegationId, delegationVersion: input.auth.delegationVersion } : {}),
    }),
  });
}

async function authorizeSelectedResource(
  event: EventWithContext,
  capability: string,
  exactScope: string | undefined,
  phase: 'read' | 'propose',
  operation: string,
  visibility: 'resource' | 'aggregate' = 'resource',
): Promise<AuthGuardResult> {
  const selected = await requireSelectedSpace(event);
  if (!selected.ok) return selected;
  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event as unknown as H3Event, 503);
    return { ok: false, response: errorEnvelope('STORE_UNAVAILABLE', wf.error, null) };
  }
  let resourceKind: GovernanceResourceKind = 'space';
  let resourceId = selected.space.id;
  if (exactScope !== undefined && exactScope !== selected.space.id) {
    const separator = exactScope.indexOf(':');
    const kind = exactScope.slice(0, separator);
    resourceId = exactScope.slice(separator + 1);
    if (separator < 1 || !Object.hasOwn(scopeKinds, kind) || !resourceId || resourceId === '*' ||
        (kind === 'space' && resourceId !== selected.space.id) ||
        (kind === 'budget' && resourceId !== selected.space.budgetId)) {
      setResponseStatus(event as unknown as H3Event, 403);
      return { ok: false, response: errorEnvelope('FORBIDDEN', 'Requested scope is unavailable', null) };
    }
    resourceKind = scopeKinds[kind]!;
  }
  const policy = wf.store.governance.getPolicy({ spaceId: selected.space.id });
  if (!policy) {
    setResponseStatus(event as unknown as H3Event, 403);
    return { ok: false, response: errorEnvelope('FORBIDDEN', 'Current space policy is unavailable', null) };
  }
  const auth = selected.auth;
  const result = wf.store.governance.authorize({
    actorId: auth.actorId,
    spaceId: selected.space.id,
    membershipId: selected.membership.id,
    expectedPolicyVersion: policy.version,
    phase,
    operation,
    required: [{ capability, resourceKind, resourceId, visibility }],
    payload: { operations: [] },
    now: new Date().toISOString(),
    auth,
    ...(auth.method === 'api-key' && auth.principalType === 'agent' ? {
      agentId: auth.actorId, delegationId: auth.delegationId, delegationVersion: auth.delegationVersion,
    } : {}),
  });

  if (!result.allowed) {
    setResponseStatus(event as unknown as H3Event, 403);
    return {
      ok: false,
      response: errorEnvelope('FORBIDDEN', result.reason, null, false),
    };
  }
  try {
    await recordReadAdmission(event, wf.store, {
      actorId: auth.actorId, spaceId: selected.space.id, membershipId: selected.membership.id,
      budgetId: selected.space.budgetId, policyVersion: policy.version,
      capability, resourceKind, resourceId, operation, phase, auth,
    });
  } catch {
    setResponseStatus(event as unknown as H3Event, 503);
    return { ok: false, response: errorEnvelope('READ_AUDIT_UNAVAILABLE', 'Read admission could not be recorded.', null, true) };
  }

  return {
    ok: true,
    info: { actorId: auth.actorId, capability, allowed: true },
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
 * Map a missing selected-budget failure to the canonical recoverable API error.
 *
 * Other configuration failures remain operational errors so unreadable or
 * invalid configuration is never misreported as an unconfigured installation.
 */
export function classifyConnectionError(error: unknown): SanitizedError | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'not_connected'
  ) {
    return null;
  }
  return {
    code: 'not_connected',
    message: 'No ledger connected. Configure an Actual budget first.',
    retryable: true,
  };
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

  return (
    classifyConnectionError(err) ?? {
      code,
      message: sanitizeErrorMessage(rawMessage),
      retryable,
    }
  );
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
 * Status values returned by the review proposal seam.
 *
 * `approval_required` means an exact native proposal was persisted. It never
 * means that the review item or ledger mutation was approved or executed.
 */
export type MutationStatus =
  | 'noop'
  | 'denied'
  | 'approval_required'
  | 'applying'
  | 'applied'
  | 'apply_failed'
  | 'stale'
  | 'verified';

export type ReviewMutationDisposition =
  | 'approval_required'
  | 'denied'
  | 'native_unavailable'
  | 'stale'
  | 'failed';

export interface PendingNativeProposal {
  readonly proposalId: string;
  readonly payloadHash: string;
  readonly governancePolicyVersion: string;
  readonly requiredApprovers: number;
}

export type ReviewMutationResult = {
  readonly mutationStatus: MutationStatus;
  readonly success: boolean;
  readonly applied: boolean;
  readonly verified: boolean;
  readonly stale: boolean;
  readonly transactionId: string | null;
  readonly previousCategoryId: string | null;
  readonly newCategoryId: string | null;
  readonly error: string | null;
} & (
  | ({ readonly disposition: 'approval_required' } & PendingNativeProposal)
  | {
      readonly disposition?: Exclude<ReviewMutationDisposition, 'approval_required'>;
      readonly proposalId?: null;
      readonly payloadHash?: null;
      readonly governancePolicyVersion?: null;
      readonly requiredApprovers?: null;
    }
);

export interface MutationTransitionResult {
  readonly mutationResult: ReviewMutationResult;
  readonly finalStatus: ReviewStatus;
  readonly disposition: ReviewMutationDisposition;
}

export async function applyReviewMutationWithTransition(
  store: WorkflowStore,
  reviewId: string,
  actorId: string,
  executor: ReviewMutationExecutor,
  requestId: string,
  categoryId?: string,
  executionId?: string,
): Promise<MutationTransitionResult> {
  const item = await store.getReviewItem(reviewId);
  if (!item) throw new Error(`Review item ${reviewId} not found`);
  if (item.status !== 'pending_review')
    throw new Error('Only pending review items can create a native proposal');

  const result = await executor(
    { reviewId, actorId, requestId, categoryId, correlationId: executionId },
    store,
    item,
  );
  if (
    result.disposition === 'approval_required' &&
    (result.mutationStatus !== 'approval_required' ||
      !result.proposalId ||
      !/^[a-f0-9]{64}$/i.test(result.payloadHash) ||
      !result.governancePolicyVersion ||
      !Number.isInteger(result.requiredApprovers) ||
      result.requiredApprovers < 1 ||
      result.success ||
      result.applied ||
      result.verified)
  ) {
    throw new Error('Native proposal result is incomplete or claims financial success');
  }
  if (
    result.disposition !== 'approval_required' &&
    (result.proposalId != null ||
      result.payloadHash != null ||
      result.governancePolicyVersion != null ||
      result.requiredApprovers != null ||
      result.mutationStatus === 'verified' ||
      result.mutationStatus === 'applied' ||
      result.applied ||
      result.verified ||
      result.success)
  ) {
    throw new Error('Only an exact pending native proposal may be returned from review');
  }

  return {
    mutationResult: result,
    finalStatus: item.status,
    disposition: result.disposition ?? 'failed',
  };
}

/** Input to the review mutation executor. */
export interface ReviewMutationInput {
  readonly reviewId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly categoryId?: string;
  readonly correlationId?: string;
}


/** Produces a native proposal from the review item; it cannot mutate the ledger. */
export type ReviewMutationExecutor = (
  input: ReviewMutationInput,
  store: WorkflowStore,
  item: ReviewItem,
) => Promise<ReviewMutationResult>;
let _mutationExecutor: ReviewMutationExecutor | null = null;

/** Test injection for the review proposal seam. */
export function setReviewMutationExecutor(fn: ReviewMutationExecutor | null): void {
  _mutationExecutor = fn;
}

export function getReviewMutationExecutor(): ReviewMutationExecutor | null {
  return _mutationExecutor;
}


/**
 * Check whether reviewAndApply (mutation-enabled) mode is active for this
 * request based on runtime configuration.
 */
export function reviewAndApplyEnabled(event: EventWithContext): boolean {
  try {
    return (useRuntimeConfig(event as H3Event) as Record<string, unknown>).reviewAndApply === true;
  } catch {
    // Unit tests and non-Nitro callers may provide the config on the event.
    return event.context.runtimeConfig?.reviewAndApply === true;
  }
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
export function setReviewMutationExecutorFactory(fn: ReviewMutationExecutorFactory | null): void {
  _executorFactory = fn;
}

/**
 * Get the current executor factory, or null.
 */
export function getReviewMutationExecutorFactory(): ReviewMutationExecutorFactory | null {
  return _executorFactory;
}

/**
 * Resolve only the request-context factory; unscoped singleton executors are not admitted.
 */
export function getReviewMutationExecutorFromEvent(
  event: EventWithContext,
): ReviewMutationExecutor | null {
  return _executorFactory?.(event) ?? _mutationExecutor;
}

// ---------------------------------------------------------------------------
// Mutation transition orchestration
// ---------------------------------------------------------------------------


/** Re-export ReviewStatus for route handler convenience. */
export type { ReviewStatus } from '@balanceframe/workflow-store';
