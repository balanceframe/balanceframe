/**
 * Public types for @balanceframe/workflow-store.
 *
 * All externally visible types are declared here; the store implementation
 * satisfies the {@link WorkflowStore} interface.
 *
 * Design rules:
 * - Suggestions are immutable once saved (content never changes).
 * - Supersession marks a suggestion inactive without altering its fields.
 * - Jobs use a claim-token pattern for idempotent processing and crash
 *   recovery — the same token always yields the same result.
 */

import type { CategoryReallocation, MerchantNativeRuleBlock, MerchantNativeRulePart, MerchantNativeRuleSet, TransferPlan } from '@balanceframe/protocol-generated';
import type { TransferState } from './liquidity-types.js';
import type { LiquidityWorkflow } from './liquidity.js';
import type { SpaceGovernance } from './governance.js';
import type { GovernanceDisposition, HumanControlContext, OperationalAuth } from './governance-types.js';

// ---------------------------------------------------------------------------
// Suggestion — immutable candidate output from a classifier
// ---------------------------------------------------------------------------

/** A single suggestion emitted by a classifier. Immutable once persisted. */
export interface Suggestion {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Budget this suggestion applies to. */
  readonly budgetId: string;
  /** The transaction the classifier evaluated. */
  readonly transactionId: string;
  /** The suggested category. */
  readonly categoryId: string;
  /** Classifier identity (e.g. "fast-classifier", "deep-analysis"). */
  readonly classifier: string;
  /** Semantic version of the prompt / model that produced this. */
  readonly promptVersion: string;
  /** Classifier-provided payload (may include confidence, explanation, etc.). */
  readonly payload: Record<string, unknown>;
  /** Monotonic version of the transaction snapshot at time of classification. */
  readonly transactionVersion: number;
  /** ISO-8601 timestamp when this suggestion was superseded, or null if active. */
  readonly supersededAt: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Input to save a new suggestion. */
export interface SaveSuggestionInput {
  readonly transactionId: string;
  readonly budgetId: string;
  readonly categoryId: string;
  readonly classifier: string;
  readonly promptVersion: string;
  readonly payload: Record<string, unknown>;
  readonly transactionVersion: number;
}

// ---------------------------------------------------------------------------
// CandidateJob — idempotent unit of classifier work
// ---------------------------------------------------------------------------

/** Lifecycle status of a candidate job. */
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** An idempotent job wrapping a candidate evaluation. */
export interface CandidateJob {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Logical job type (e.g. "classify", "reclassify"). */
  readonly jobType: string;
  /** Opaque identifier for the candidate being processed (deterministic). */
  readonly candidateId: string;
  /** Current lifecycle status. */
  readonly status: JobStatus;
  /** Claim token set when a worker claims this job. */
  readonly claimToken: string | null;
  /** ISO-8601 timestamp when the job was claimed, or null. */
  readonly claimedAt: string | null;
  /** ISO-8601 timestamp after which the claim expires (crash recovery). */
  readonly claimExpiresAt: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-update timestamp. */
  readonly updatedAt: string;
}

/** Exact selected space, budget, and acting human for lifecycle operations. */
export interface LifecycleScope {
  readonly spaceId: string;
  readonly budgetId: string;
  readonly actorId: string;
}

/** Input to enqueue a new candidate job. Omitted scope marks legacy/unscoped work. */
export interface EnqueueJobInput {
  readonly jobType: string;
  readonly candidateId: string;
  readonly spaceId?: string;
  readonly budgetId?: string;
  readonly actorId?: string;
}

// ---------------------------------------------------------------------------
// FailureRecord — persisted error details
// ---------------------------------------------------------------------------

/** Record of a failed job. Immutable once written. */
export interface FailureRecord {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** The job that failed. */
  readonly jobId: string;
  /** Machine-readable error code. */
  readonly errorCode: string;
  /** Human-readable error description. */
  readonly errorMessage: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// ReviewItem — lifecycle of a human-review workflow record
// ---------------------------------------------------------------------------

/** Lifecycle status of a review item. */
export type ReviewStatus =
  | 'discovered'
  | 'suggestion_generated'
  | 'pending_review'
  | 'approved'
  | 'applying'
  | 'correcting'
  | 'applied'
  | 'apply_failed'
  | 'rejected'
  | 'skipped'
  | 'superseded';

/** A review item tracking one candidate through the review-apply lifecycle. */
export interface ReviewItem {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Link to the source suggestion, if one was generated. */
  readonly suggestionId: string | null;
  readonly budgetId: string;
  readonly transactionId: string;
  /** Canonical source-ledger authority; classifier evidence never supplies these facts. */
  readonly sourceTransaction: ReviewActionAuthorization['transaction'] | null;
  /** The proposed (or applied) category. */
  readonly categoryId: string;
  /** Classifier identity that produced the suggestion. */
  readonly classifier: string;
  /** Semantic version of the prompt / model used. */
  readonly promptVersion: string;
  /** Monotonic version of the transaction snapshot at classification time. */
  readonly transactionVersion: number;
  /** Current lifecycle status. */
  readonly status: ReviewStatus;
  /** Opaque correlation ID for grouping related review items. */
  readonly correlationId: string | null;
  /** Reviewer assigned to this item, if any. */
  readonly assignedReviewerId: string | null;
  /** Actors who have approved this review item (ordered). */
  readonly approvedBy: string[];
  /** How many distinct reviewers are required for approval. */
  readonly reviewersRequired: number;
  /** Priority value (higher = more urgent). */
  readonly priority: number;
  /** Evidence payload from the classifier (free-form). */
  readonly evidence: Record<string, unknown>;
  /** Provenance description of how this item was created. */
  readonly provenance: string;
  /** ID of the review item that superseded this one, or null. */
  readonly supersededBy: string | null;
  /** Human-readable reason for supersession, or null. */
  readonly supersededReason: string | null;
  /** ISO-8601 timestamp after which this item is considered stale, or null. */
  readonly freshnessExpiresAt: string | null;
  /** Monotonic optimistic-lock version, incremented on each transition. */
  readonly version: number;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-update timestamp. */
  readonly updatedAt: string;
}

/** Input to create a new review item. */
export interface CreateReviewItemInput {
  /** Suggestion ID if a suggestion has already been generated. */
  readonly suggestionId?: string;
  readonly budgetId: string;
  readonly transactionId: string;
  /** Trusted synchronized source facts, separate from arbitrary classifier evidence. */
  readonly sourceTransaction?: ReviewActionAuthorization['transaction'];
  /** Trusted synchronous publication fence, rechecked inside the write transaction. */
  readonly authorize?: () => boolean;
  readonly categoryId: string;
  readonly classifier: string;
  readonly promptVersion?: string;
  readonly transactionVersion?: number;
  /** Shared correlation ID for batching. */
  readonly correlationId?: string;
  /** Pre-assigned reviewer. */
  readonly assignedReviewerId?: string;
  /** Number of distinct reviewers needed for approval (default 1). */
  readonly reviewersRequired?: number;
  /** Priority (higher = first in list). */
  readonly priority?: number;
  /** Classifier evidence payload. */
  readonly evidence?: Record<string, unknown>;
  /** How this item was discovered. */
  readonly provenance: string;
  /** ISO-8601 timestamp after which this item is considered stale. */
  readonly freshnessExpiresAt?: string;
}

/** Trusted selected Actual namespace; a reference is provenance, never read authority. */
export interface ReviewRuleSetScope {
  readonly spaceId: string;
  readonly budgetId: string;
  readonly connectionId: string;
}
export type ReviewRuleSetReference =
  | { readonly kind: 'scoped'; readonly scope: ReviewRuleSetScope; readonly id: string }
  | { readonly kind: 'historical-unattributed'; readonly budgetId: string; readonly id: string };
/** Prepared source publication; indexes refer to complete groups shared by this batch. */
export interface CreateReviewItemsInput {
  readonly scope?: ReviewRuleSetScope;
  readonly nativeRuleBlocks: MerchantNativeRuleBlock[];
  readonly nativeRuleParts: MerchantNativeRulePart[];
  readonly nativeRuleSets: MerchantNativeRuleSet[];
  readonly items: Array<CreateReviewItemInput & { readonly ruleSetIndex?: number }>;
  readonly authorize?: () => boolean;
}

/** Trusted source-ledger facts and verified identity for an atomic non-ledger review action. */
export interface ReviewActionAuthorization {
  readonly spaceId: string;
  readonly policyVersion: string;
  readonly auth: OperationalAuth;
  readonly transaction: {
    readonly id: string;
    readonly accountId: string;
    readonly categoryId: string | null;
    readonly direction: 'outgoing' | 'incoming';
    readonly amount: { readonly minorUnits: string; readonly currency: string };
  };
}

/** Verified human context and current selected-space policy for atomic intent cancellation. */
export interface DiscardProposalAuthorization {
  readonly spaceId: string;
  readonly governancePolicyVersion: string;
  readonly now: string;
  readonly auth: OperationalAuth;
}

/** Input describing a single status transition. */
export interface TransitionReviewInput {
  /** Target status. */
  readonly toStatus: ReviewStatus;
  /** Actor performing the transition (email, system ID, etc.). */
  readonly actor: string;
  /** Human-readable reason for the transition. */
  readonly reason?: string;
  /** Free-form metadata attached to this transition. */
  readonly metadata?: Record<string, unknown>;
  /** Expected optimistic-lock version; must match current item version. */
  readonly expectedVersion: number;
  /**
   * When transitioning to `superseded`, the ID of the review item that
   * supersedes this one (establishes the successor link).
   */
  readonly supersededBy?: string;
  /** Optional for trusted internal workflows; required by public reject/skip/undo inputs. */
  readonly authorization?: ReviewActionAuthorization;
  // ── Correction evidence fields ─────────────────────────────────────────
  // These are captured as structured history when transitioning to
  // `approved` or `correcting`.
  /** Normalized merchant name from the transaction payee. */
  readonly merchant?: string;
  /** Imported payee name from the transaction import data. */
  readonly importedPayee?: string;
  /** Account ID the transaction belongs to. */
  readonly accountId?: string;
  /** Direction — `'inflow'` or `'outflow'`. */
  readonly direction?: string;
  /** Transaction amount in minor units. */
  readonly amount?: number;
  /** Transaction date (ISO-8601). */
  readonly date?: string;
  /** Human-readable category name assigned by the correction. */
  readonly categoryName?: string;
}

/** Public reject, skip, and undo operations with the current trusted human context. */
export type AuthorizedReviewTransitionInput = Pick<
  TransitionReviewInput,
  'actor' | 'reason' | 'metadata' | 'expectedVersion'
> & {
  readonly toStatus: 'rejected' | 'skipped' | 'pending_review';
  readonly authorization: ReviewActionAuthorization;
};

/** An audited action recording a review-item status transition. */
export interface ReviewAction {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Owning review item. */
  readonly reviewItemId: string;
  /** Status prior to the transition. */
  readonly fromStatus: ReviewStatus;
  /** Status after the transition. */
  readonly toStatus: ReviewStatus;
  /** Actor who performed the transition. */
  readonly actor: string;
  /** Human-readable reason. */
  readonly reason: string | null;
  /** Free-form metadata. */
  readonly metadata: Record<string, unknown>;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Result of a single item in a bulk transition. */
export interface TransitionReviewResult {
  readonly itemId: string;
  readonly success: boolean;
  readonly item: ReviewItem | null;
  readonly error: string | null;
}

/** Options for listing review items. */
export interface ReviewListOptions {
  /** Trusted selected-budget scope, applied before pagination and counting. */
  readonly budgetId?: string;
  readonly status?: ReviewStatus;
  readonly limit?: number;
  readonly offset?: number;
}

/** Options for listing categorization proposals. */
export interface ListProposalsOptions {
  readonly operations?: readonly ProposalOperation[];
  /** Filter by superseded state. Omit for all. */
  readonly superseded?: boolean;
  /** Filter by budget ID. Omit for all budgets. */
  readonly budgetId?: string;
  /** Maximum number of proposals to return (default 50). */
  readonly limit?: number;
  /** Number of proposals to skip. */
  readonly offset?: number;
}

// ---------------------------------------------------------------------------
// Notification Event — immutable outbound event
// ---------------------------------------------------------------------------

/**
 * An immutable notification event — the canonical record of a notification
 * that should be dispatched.  Events are written before any outbox record
 * is created (persist-before-dispatch).
 */
export interface NotificationEvent {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Monotonic event version for ordering and deduplication. */
  readonly eventVersion: number;
  /** Budget this event is associated with. */
  readonly budgetId: string;
  /** Classification label (e.g. 'budget_alert', 'review_complete'). */
  readonly classification: string;
  /** Intended recipient; unbound legacy events cannot authorize reads or delivery. */
  readonly recipientId: string | null;
  /** Exact bound budget scope captured by the notification producer. */
  readonly scope: string | null;
  /** Original selected space, or null for inert legacy or unbound events. */
  readonly spaceId: string | null;
  /** Original recipient period; replacement memberships never inherit private notifications. */
  readonly recipientMembershipId: string | null;
  /** Security / redaction class hint (e.g. 'public', 'internal', 'sensitive'). */
  readonly redactionClass: string | null;
  /** Version of the channel/provider config active when the event was created. */
  readonly channelConfigVersion: string | null;
  /** Policy version active when the event was created. */
  readonly policyVersion: string;
  /** Optional correlation ID for grouping related events. */
  readonly correlationId: string | null;
  /** JSON-encoded event payload. */
  readonly payload: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Input to create a new notification event. */
export interface CreateNotificationEventInput {
  readonly budgetId: string;
  readonly classification: string;
  readonly payload: Record<string, unknown>;
  readonly policyVersion: string;
  readonly recipientId?: string | null;
  readonly scope?: string | null;
  readonly redactionClass?: string | null;
  readonly channelConfigVersion?: string | null;
  /** Correlates the immutable event with its attributable producer operation. */
  readonly correlationId?: string | null;
  /** Operation time used to bind recipient provenance to the current membership epoch. */
  readonly now?: string;
}

/** Input to atomically create or retrieve a deduplicated notification event. */
export interface CreateOrGetNotificationEventInput extends CreateNotificationEventInput {
  /**
   * Stable producer identity.  Persistence scopes it to the exact recipient
   * and authorization scope so one recipient can never reuse another's event.
   */
  readonly dedupKey: string;
}

// ---------------------------------------------------------------------------
// Notification Outbox — delivery-tracked outbound record
// ---------------------------------------------------------------------------

/** Lifecycle status of a notification outbox record. */
export type OutboxStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'suppressed';

/**
 * An outbox record tracking delivery of a single notification to a single
 * channel.  Supports claim-based dispatch, retry with backoff, and
 * acknowledgement/failure/suppression lifecycle.
 */
export interface NotificationOutboxRecord {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Reference to the immutable notification event. */
  readonly eventId: string;
  /**
   * Canonical delivery / idempotency key — scoped to (eventId, channelType)
   * to prevent duplicate visible sends.
   */
  readonly deliveryKey: string;
  /** Channel type (e.g. 'email', 'webhook', 'push'). */
  readonly channelType: string;
  /** Version of the channel config active when enqueued. */
  readonly channelConfigVersion: string | null;
  /** Current delivery lifecycle status. */
  readonly status: OutboxStatus;
  /** Number of delivery attempts made so far. */
  readonly attemptCount: number;
  /** Maximum delivery attempts before terminal failure. */
  readonly maxAttempts: number;
  /** Claim token guarding delivery processing (null when not claimed). */
  readonly claimToken: string | null;
  /** ISO-8601 timestamp when the delivery claim expires. */
  readonly claimExpiresAt: string | null;
  /** ISO-8601 timestamp of the most recent delivery attempt. */
  readonly lastAttemptedAt: string | null;
  /** ISO-8601 timestamp for the next scheduled retry (null if not scheduled). */
  readonly nextAttemptAt: string | null;
  /** ISO-8601 timestamp when the notification was acknowledged by the recipient. */
  readonly acknowledgedAt: string | null;
  /** ISO-8601 timestamp when delivery was permanently failed. */
  readonly failedAt: string | null;
  /** Human-readable failure reason. */
  readonly failureReason: string | null;
  /** ISO-8601 timestamp when the record was suppressed. */
  readonly suppressedAt: string | null;
  /** Human-readable suppression reason. */
  readonly suppressedReason: string | null;
  /** Optional correlation ID propagated from the event. */
  readonly correlationId: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  readonly updatedAt: string;
}

/** Input to enqueue a notification for delivery. */
export interface EnqueueNotificationInput {
  /** The immutable notification event to deliver. */
  readonly eventId: string;
  /**
   * Delivery idempotency key — must be unique per (eventId, channelType)
   * to prevent duplicate sends.
   */
  readonly deliveryKey: string;
  /** Channel type for delivery. */
  readonly channelType: string;
  /** Version of the channel config to use. */
  readonly channelConfigVersion?: string | null;
  /** Maximum delivery attempts (default 3). */
  readonly maxAttempts?: number;
  /** Optional correlation ID propagated from the event. */
  readonly correlationId?: string | null;
}

// ---------------------------------------------------------------------------
// DeliveryAttempt — immutable record of a single delivery attempt
// ---------------------------------------------------------------------------

/** Outcome of a single delivery attempt. */
export type DeliveryAttemptStatus = 'success' | 'failed';

/**
 * An immutable record of one delivery attempt for a notification outbox
 * record.  Multiple attempts may exist for the same outbox record during
 * retry cycles.
 */
export interface DeliveryAttempt {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Reference to the notification outbox record. */
  readonly outboxId: string;
  /** Monotonic attempt number (1-based). */
  readonly attemptNumber: number;
  /** Outcome of this attempt. */
  readonly status: DeliveryAttemptStatus;
  /** Response code from the channel provider (if applicable). */
  readonly responseCode: string | null;
  /** Response body from the channel provider (if applicable). */
  readonly responseBody: string | null;
  /** Error message if the attempt failed. */
  readonly errorMessage: string | null;
  /** ISO-8601 timestamp of the attempt. */
  readonly attemptedAt: string;
}

/** Input to record a delivery attempt. */
export interface RecordDeliveryAttemptInput {
  readonly outboxId: string;
  readonly attemptNumber: number;
  readonly status: DeliveryAttemptStatus;
  readonly responseCode?: string | null;
  readonly responseBody?: string | null;
  readonly errorMessage?: string | null;
}

// ---------------------------------------------------------------------------
// PolicyVersion — immutable policy version tracking
// ---------------------------------------------------------------------------

/** A tracked policy version.  Versions are append-only once superseded. */
export interface PolicyVersion {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Policy domain key (e.g. 'authorization', 'notification', 'classification'). */
  readonly policyKey: string;
  /** Monotonic version number within the policy domain. */
  readonly version: number;
  /** Hex-encoded SHA-256 hash of the policy content. */
  readonly policyHash: string;
  /** Human-readable description of this version. */
  readonly description: string;
  /** Whether this version is currently the active one for its policy key. */
  readonly isActive: boolean;
  /** ISO-8601 timestamp when superseded, or null if still active. */
  readonly supersededAt: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Input to record a new policy version. */
export interface RecordPolicyVersionInput {
  readonly policyKey: string;
  readonly policyHash: string;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// SavedView — saved phase-8 view configuration
// ---------------------------------------------------------------------------

/**
 * Verified selected-space authority for saved-view persistence.
 * The membership ID pins the view to one immutable membership period.
 */
export interface SavedViewAuthority {
  readonly actorId: string;
  readonly spaceId: string;
  readonly budgetId: string;
  readonly membershipId: string;
}

/** A saved view configuration persisted for one selected space and membership period. */
export interface SavedViewResult {
  /** Stable unique identifier (UUID v4). */
  readonly viewId: string;
  /** Human-readable name for this view. */
  readonly name: string;
  /** View type identifier (e.g. "attention", "pending_review", "budget_summary"). */
  readonly viewType: string;
  /** JSON-encoded scope/filter configuration. */
  readonly scope: Record<string, unknown>;
  /** Optional user-defined sort expression. */
  readonly sort: string | null;
  /** Actor who owns this view. */
  readonly actorId: string;
  /** Immutable originating space and budget. */
  readonly spaceId: string;
  readonly budgetId: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 timestamp of last use, or null if never used since creation. */
  readonly lastUsedAt: string | null;
}

/** Input to create a saved view in the verified selected space. */
export interface CreateSavedViewInput {
  readonly authority: SavedViewAuthority;
  readonly name: string;
  readonly viewType: string;
  readonly scope: Record<string, unknown>;
  readonly sort?: string;
}

/** Input to update an existing saved view without changing its provenance. */
export interface UpdateSavedViewInput {
  readonly authority: SavedViewAuthority;
  readonly name?: string;
  readonly scope?: Record<string, unknown>;
  readonly sort?: string | null;
}

/** Input to duplicate a view within the same verified selected scope. */
export interface DuplicateSavedViewInput {
  readonly sourceViewId: string;
  readonly name: string;
  readonly authority: SavedViewAuthority;
}

// ---------------------------------------------------------------------------
// SavedFilter — persistable report filter / view configuration
// ---------------------------------------------------------------------------

/** A saved report filter or view.  Policy-aware scope controls visibility. */
export interface SavedFilter {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Human-readable name for this filter/view. */
  readonly name: string;
  /** Budget this filter is scoped to, or null for global filters. */
  readonly budgetId: string | null;
  /** JSON-encoded filter configuration. */
  readonly filterConfig: string;
  /** JSON-encoded view configuration (display settings), or null. */
  readonly viewConfig: string | null;
  /** Policy-aware scope controlling visibility (e.g. 'owner', 'role:admin', 'public'). */
  readonly scope: string;
  /** Policy version that was active when this filter was created/updated. */
  readonly policyVersion: string;
  /** Whether this is the default filter for its scope/budget combination. */
  readonly isDefault: boolean;
  /** Actor who created this filter. */
  readonly actorId: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  readonly updatedAt: string;
}

/** Input to create a new saved filter/view. */
export interface CreateSavedFilterInput {
  readonly name: string;
  readonly filterConfig: Record<string, unknown>;
  readonly scope: string;
  readonly policyVersion: string;
  readonly budgetId?: string | null;
  readonly viewConfig?: Record<string, unknown> | null;
  readonly isDefault?: boolean;
  readonly actorId: string;
}

/** Input to update an existing saved filter/view. */
export interface UpdateSavedFilterInput {
  readonly name?: string;
  readonly filterConfig?: Record<string, unknown>;
  readonly viewConfig?: Record<string, unknown> | null;
  readonly scope?: string;
  readonly policyVersion?: string;
  readonly isDefault?: boolean;
}

/** Options for listing saved filters. */
export interface SavedFilterListOptions {
  readonly budgetId?: string;
  readonly scope?: string;
  readonly actorId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

// ---------------------------------------------------------------------------
// Finding — versioned observation with full lifecycle
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a finding.
 *
 * Transitions:
 *   open → acknowledged | corrected | dismissed | superseded | expired
 *   acknowledged → corrected | dismissed | reopened | superseded | expired
 *   corrected → superseded | expired
 *   dismissed → reopened | superseded
 *   reopened → acknowledged | corrected | dismissed | superseded | expired
 *   expired → superseded (reopen not allowed)
 *   superseded → (terminal)
 */
export type FindingStatus =
  'open' | 'acknowledged' | 'corrected' | 'dismissed' | 'reopened' | 'expired' | 'superseded';

/**
 * A versioned finding — an observation about categorization, budget health,
 * data quality, or workflow state that may require action.
 *
 * Findings are versioned for safe concurrent transitions and support a
 * complete lifecycle including acknowledgement, correction, dismissal,
 * reopening, expiry, and supersession. Evidence references link findings
 * to review items, corrections, or other external records.
 */
export interface Finding {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Budget this finding is associated with. */
  readonly budgetId: string;
  /** Classification label (e.g. 'uncategorized', 'budget_risk', 'data_quality'). */
  readonly classification: string;
  /** Human-readable description of the finding. */
  readonly description: string;
  /** Evidence payload (free-form, classifier-provided). */
  readonly evidence: Record<string, unknown>;
  /** References to supporting evidence records (e.g. review_item IDs, correction IDs). */
  readonly evidenceRefs: string[];
  /** Severity of the finding. */
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  /** Current lifecycle status. */
  readonly status: FindingStatus;
  /** Actor who owns or is assigned this finding, or null. */
  readonly actorId: string | null;
  /** ISO-8601 timestamp when acknowledged, or null. */
  readonly acknowledgedAt: string | null;
  /** Actor who acknowledged this finding, or null. */
  readonly acknowledgedBy: string | null;
  /** ISO-8601 timestamp when corrected, or null. */
  readonly correctedAt: string | null;
  /** Actor who corrected this finding, or null. */
  readonly correctedBy: string | null;
  /** Reference to the correction record or action that addressed this finding. */
  readonly correctionRef: string | null;
  /** ISO-8601 timestamp when dismissed, or null. */
  readonly dismissedAt: string | null;
  /** Actor who dismissed this finding, or null. */
  readonly dismissedBy: string | null;
  /** Human-readable reason for dismissal. */
  readonly dismissedReason: string | null;
  /** ISO-8601 timestamp when reopened, or null. */
  readonly reopenedAt: string | null;
  /** Actor who reopened this finding, or null. */
  readonly reopenedBy: string | null;
  /** ISO-8601 timestamp when superseded, or null. */
  readonly supersededAt: string | null;
  /** Finding ID that superseded this one, or null. */
  readonly supersededBy: string | null;
  /** Human-readable reason for supersession. */
  readonly supersededReason: string | null;
  /** ISO-8601 timestamp after which this finding automatically expires, or null. */
  readonly expiresAt: string | null;
  /** Monotonic optimistic-lock version, incremented on each transition. */
  readonly version: number;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-update timestamp. */
  readonly updatedAt: string;
}

/** Input to create a new finding. */
export interface CreateFindingInput {
  readonly budgetId: string;
  readonly classification: string;
  readonly description: string;
  readonly evidence: Record<string, unknown>;
  /** References to supporting evidence records. */
  readonly evidenceRefs?: string[];
  /** Severity (default 'medium'). */
  readonly severity?: 'low' | 'medium' | 'high' | 'critical';
  /** Actor who owns or is assigned this finding. */
  readonly actorId?: string;
  /** ISO-8601 expiry timestamp, if the finding should auto-expire. */
  readonly expiresAt?: string;
}

/** Input to acknowledge a finding. */
export interface AcknowledgeFindingInput {
  readonly findingId: string;
  readonly actorId: string;
  readonly expectedVersion: number;
}

/** Input to mark a finding as corrected. */
export interface CorrectFindingInput {
  readonly findingId: string;
  readonly actorId: string;
  /** Reference to the correction record or action that addressed the finding. */
  readonly correctionRef: string;
  readonly expectedVersion: number;
}

/** Input to dismiss a finding. */
export interface DismissFindingInput {
  readonly findingId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly expectedVersion: number;
}

/** Input to reopen a previously dismissed or acknowledged finding. */
export interface ReopenFindingInput {
  readonly findingId: string;
  readonly actorId: string;
  readonly expectedVersion: number;
}

/** Input to supersede a finding (mark it replaced by another). */
export interface SupersedeFindingInput {
  readonly findingId: string;
  readonly supersededBy: string;
  readonly reason: string;
  readonly actorId: string;
  readonly expectedVersion: number;
}

/** Options for listing findings. */
export interface ListFindingsOptions {
  readonly status?: FindingStatus;
  readonly budgetId?: string;
  readonly classification?: string;
  readonly severity?: 'low' | 'medium' | 'high' | 'critical';
  readonly limit?: number;
  readonly offset?: number;
}

// ---------------------------------------------------------------------------
// ReportRecord — persisted report metadata
// ---------------------------------------------------------------------------

/** A report record storing metadata about a generated report. */
export interface ReportRecord {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Report type label (e.g. 'budget_summary', 'transaction_audit'). */
  readonly reportType: string;
  /** Budget this report is associated with, or null for global reports. */
  readonly budgetId: string | null;
  /** Optional saved filter that was used to generate this report. */
  readonly filterId: string | null;
  /** JSON-encoded report configuration/parameters. */
  readonly config: string;
  /** Policy version active when the report was generated. */
  readonly policyVersion: string;
  /** ISO-8601 generation timestamp. */
  readonly generatedAt: string;
  /** ISO-8601 expiry timestamp (null = no expiry). */
  readonly expiresAt: string | null;
  /** Reference to stored report data (e.g. file path, blob key). */
  readonly dataRef: string | null;
}

/** Input to create a new report record. */
export interface CreateReportRecordInput {
  readonly reportType: string;
  readonly config: Record<string, unknown>;
  readonly policyVersion: string;
  readonly budgetId?: string | null;
  readonly filterId?: string | null;
  readonly expiresAt?: string | null;
  readonly dataRef?: string | null;
}

/** Options for listing report records. */
export interface ReportListOptions {
  readonly budgetId?: string;
  readonly reportType?: string;
  readonly limit?: number;
  readonly offset?: number;
}

// ---------------------------------------------------------------------------
// ReportHistoryEntry — time-ordered report history item
// ---------------------------------------------------------------------------

/**
 * A single entry in the report history timeline.
 * Returned by getReportHistory to give a chronological view of report
 * generation activity for a budget or across budgets.
 */
export interface ReportHistoryEntry {
  /** Stable report record ID. */
  readonly id: string;
  /** Report type label. */
  readonly reportType: string;
  /** Budget this report is associated with, or null. */
  readonly budgetId: string | null;
  /** ISO-8601 generation timestamp. */
  readonly generatedAt: string;
  /** Human-readable label derived from report config. */
  readonly label: string;
  /** Whether the report has expired. */
  readonly isExpired: boolean;
}

// ---------------------------------------------------------------------------
// ListOutboxRecordsOptions — pagination/filter for outbox listing
// ---------------------------------------------------------------------------

/** Options for listing notification outbox records. */
export interface ListOutboxRecordsOptions {
  /** Filter by status (optional). */
  readonly status?: OutboxStatus;
  /** Filter by channel type (optional). */
  readonly channelType?: string;
  /** Maximum records to return (default 50). */
  readonly limit?: number;
  /** Number of records to skip (default 0). */
  readonly offset?: number;
}

// ---------------------------------------------------------------------------
// NotificationPolicyRecord — persisted per-space notification policy
// ---------------------------------------------------------------------------

/**
 * A persisted notification policy for a space.
 * Policies are versioned and keyed by (spaceId, policyKey).
 */
export interface NotificationPolicyRecord {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Space this policy belongs to. */
  readonly spaceId: string;
  /** Policy domain key (e.g. 'delivery', 'eligibility', 'redaction'). */
  readonly policyKey: string;
  /** Semantic version string for this policy. */
  readonly policyVersion: string;
  /** JSON-encoded policy content. */
  readonly policy: string;
  /** Whether this policy is currently active. */
  readonly isActive: boolean;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-updated timestamp. */
  readonly updatedAt: string;
}

/** Input to save or update a notification policy for a space. */
export interface SaveNotificationPolicyInput {
  readonly spaceId: string;
  readonly policyKey: string;
  readonly policyVersion: string;
  readonly policy: Record<string, unknown>;
}

/**
 * Result of resolving recipients for a notification within a space.
 */
export interface RecipientResolution {
  /** Space the resolution applies to. */
  readonly spaceId: string;
  /** Resolved actor IDs eligible to receive the notification. */
  readonly actorIds: string[];
  /** Channels available for delivery given the space policy. */
  readonly channels: string[];
  /** ISO-8601 timestamp of the resolution. */
  readonly resolvedAt: string;
}

/** Options for listing notification policies. */
export interface ListNotificationPoliciesOptions {
  readonly spaceId?: string;
  readonly policyKey?: string;
  readonly isActive?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

/** Exact governed binding for local rule annotations. */
export interface RuleOverrideScope {
  readonly spaceId: string;
  readonly budgetId: string;
}

/** Versioned local inactive-state override; null is a retained tombstone. */
export interface RuleOverride {
  readonly ruleId: string;
  readonly inactive: boolean | null;
  readonly version: number;
}

export interface GetRuleOverrideInput extends RuleOverrideScope {
  readonly ruleId: string;
}

export interface SetRuleOverrideInput extends GetRuleOverrideInput {
  readonly inactive: boolean;
  readonly expectedVersion: number | null;
}

export interface RemoveRuleOverrideInput extends GetRuleOverrideInput {
  readonly expectedVersion: number;
}

// ---------------------------------------------------------------------------
// WorkflowStore — public persistence contract
// ---------------------------------------------------------------------------

/**
 * SQLite-backed persistence store for immutable suggestions, idempotent
 * candidate jobs, failure records, notification outbox, policy versions,
 * saved report filters/views, and report records.
 *
 * All methods are async (the implementation wraps synchronous better-sqlite3).
 */
export interface WorkflowStore {
  readonly governance: SpaceGovernance;
  readonly liquidity: LiquidityWorkflow;
  // ── Suggestion lifecycle ───────────────────────────────────────────

  /**
   * Persist a new immutable suggestion.
   *
   * If an active suggestion already exists for the same
   * `(budgetId, transactionId, classifier, promptVersion)` key, it is
   * auto-superseded (only `supersededAt` is set; all other fields are
   * preserved).
   *
   * @returns The newly created suggestion.
   */
  saveSuggestion(input: SaveSuggestionInput): Promise<Suggestion>;

  /**
   * Retrieve the active (non-superseded) suggestion for a given key, or
   * null if none exists.
   */
  getActiveSuggestion(
    budgetId: string,
    transactionId: string,
    classifier: string,
    promptVersion: string,
  ): Promise<Suggestion | null>;

  /** Retrieve a single suggestion by stable ID, or null. */
  getSuggestion(id: string): Promise<Suggestion | null>;

  /** Return all suggestions (active and superseded) for a transaction. */
  getTransactionSuggestions(transactionId: string): Promise<Suggestion[]>;

  /**
   * Supersede all active suggestions for the given budget + transaction
   * whose `transactionVersion` is < `newTransactionVersion`.
   *
   * @returns The number of suggestions superseded.
   */
  supersedeSuggestions(
    budgetId: string,
    transactionId: string,
    newTransactionVersion: number,
  ): Promise<number>;

  // ── Job lifecycle ─────────────────────────────────────────────────

  /**
   * Enqueue a candidate job.
   *
   * Idempotent: if a job with the same `(jobType, candidateId)` already
   * exists, the existing record is returned unchanged.
   */
  enqueueJob(input: EnqueueJobInput): Promise<CandidateJob>;

  /**
   * Claim a pending job for processing.
   *
   * Idempotent: re-claiming with the same `claimToken` returns the
   * already-claimed job. If the job is claimed by another token this
   * returns null. Jobs whose `claimExpiresAt` is in the past may be
   * re-claimed (crash recovery).
   *
   * @param claimTimeoutMs Claim expiry in milliseconds (default 60000).
   */
  claimJob(
    jobId: string,
    claimToken: string,
    claimTimeoutMs?: number,
  ): Promise<CandidateJob | null>;

  /** Mark a processing job as completed. Requires the active claim token. */
  completeJob(jobId: string, claimToken: string): Promise<void>;

  /**
   * Mark a processing job as failed and persist a failure record.
   * Requires the active claim token.
   * Idempotent on already-terminal jobs with the correct claim token.
   *
   * @throws If the claim token does not match a processing job
   *         (stale worker or wrong token).
   */
  failJob(
    jobId: string,
    claimToken: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<FailureRecord>;

  // ── Queries ───────────────────────────────────────────────────────

  /** Return all jobs with status `pending`. */
  getPendingJobs(): Promise<CandidateJob[]>;

  /** Look up a job by job type + candidateId, or null. */
  getJobByCandidateId(jobType: string, candidateId: string): Promise<CandidateJob | null>;

  // ── Review lifecycle ──────────────────────────────────────────────

  /**
   * Create a new review item in `discovered` status.
   *
   * Idempotent: if an active (non-superseded) item already exists for the
   * same `(budgetId, transactionId, categoryId, classifier)` key, the
   * existing item is returned unchanged.
   */
  createReviewItem(input: CreateReviewItemInput): Promise<ReviewItem>;
  /** Atomically publish complete shared provenance, Review rows, and source supersessions. */
  createReviewItems(input: CreateReviewItemsInput): Promise<ReviewItem[]>;
  /** Trusted internal resolver only; this does not authorize disclosure or current evidence. */
  getReviewRuleSet(reference: ReviewRuleSetReference): string[] | null;
  /** Immutable reference/namespace only; bulk admission must not expand provenance. */
  getReviewRuleSetMetadata(id: string): ReviewRuleSetReference | null;

  /** Retrieve a single review item by ID, or null. */
  getReviewItem(id: string): Promise<ReviewItem | null>;
  /** Check a linked categorization proposal against its captured review row. */
  isProposalReviewProvenanceCurrent(proposalId: string): Promise<boolean>;

  /** Atomically apply a verified categorization result to its linked review. */
  completeVerifiedCategorizationReview(idempotencyKey: string): Promise<ReviewItem | null>;


  /**
   * Find the active (non-superseded) review item for the given issue
   * key, or null.
   */
  findReviewByIssue(
    budgetId: string,
    transactionId: string,
    categoryId: string,
    classifier: string,
  ): Promise<ReviewItem | null>;

  /**
   * List review items ordered by priority (highest first), then creation
   * time.
   */
  listReviewItems(options?: ReviewListOptions): Promise<ReviewItem[]>;

  /**
   * Return the total number of review items matching the given filter.
   * Used for pagination totals.
   */
  countReviewItems(options?: ReviewListOptions): Promise<number>;

  /** Return all review items sharing a correlation ID. */
  listReviewItemsByCorrelation(correlationId: string): Promise<ReviewItem[]>;

  /** Executes a current-authorized human reject, skip, or undo action. */
  transitionReviewItem(id: string, input: AuthorizedReviewTransitionInput): Promise<ReviewItem>;

  /** Internal lifecycle primitive for trusted synchronization and verified workflows. */
  transitionInternalReviewItem(id: string, input: TransitionReviewInput): Promise<ReviewItem>;

  /** Internal batch lifecycle primitive; callers must be trusted workflow code. */
  transitionInternalReviewItems(
    ids: string[],
    toStatus: ReviewStatus,
    actor: string,
    reason?: string,
  ): Promise<TransitionReviewResult[]>;

  /**
   * Update the category assigned to a review item.
   *
   * Used after a correct/edit action to persist the reviewer's chosen
   * category so downstream display (change preview, queue) reflects it.
   *
   * @throws If the item does not exist or the version lock fails.
   */
  updateReviewItemCategory(
    id: string,
    categoryId: string,
    expectedVersion: number,
  ): Promise<ReviewItem>;

  /** Public undo requires current trusted human context for each reversible transition. */
  undoReviewTransition(
    id: string,
    actor: string,
    reason: string | undefined,
    expectedVersion: number | undefined,
    authorization: ReviewActionAuthorization,
  ): Promise<ReviewItem>;

  /** Internal undo primitive for trusted workflow code. */
  undoInternalReviewTransition(
    id: string,
    actor: string,
    reason?: string,
    expectedVersion?: number,
  ): Promise<ReviewItem>;

  /** Return all audit actions for a review item, ordered by creation. */
  getReviewActions(reviewItemId: string): Promise<ReviewAction[]>;

  // ── Categorization proposal lifecycle ─────────────────────────────────

  /**
   * Persist an exact proposal after checking its authenticated proposer and
   * current space/resource authority. The store computes the canonical hash.
   */
  createProposal(input: CreateProposalInput): Promise<GenericActionProposal>;

  /** Retrieve a single proposal by ID, or null. */
  getProposal(id: string): Promise<ActionProposal | null>;

  /** Return current scope-authorized human approval eligibility without consuming approvals or exposing payload. */
  getProposalApprovalSummary(
    input: GetProposalApprovalSummaryInput,
  ): Promise<ProposalApprovalSummary>;

  /** Atomically admit current proposal rows and the exact complete private output without awaited publication gaps. */
  getProposalApprovalReads(input: GetProposalApprovalReadsInput): ProposalApprovalRead[];

  /**
   * Find the active (non-superseded) proposal for a given target, or null.
   */
  findActiveProposal(
    budgetId: string,
    transactionId: string | null,
    operation: ProposalOperation,
  ): Promise<ActionProposal | null>;

  /**
   * List categorization proposals ordered by creation time descending.
   */
  listProposals(options?: ListProposalsOptions): Promise<ActionProposal[]>;

  /**
   * Return the total number of categorization proposals matching the
   * given filter.  Used for pagination totals.
   */
  countProposals(options?: ListProposalsOptions): Promise<number>;

  /**
   * Supersede a proposal (and cascade-supersede its approvals).
   *
   * Idempotent on already-superseded proposals.
   */
  supersedeProposal(id: string): Promise<ActionProposal>;

  /** Discard an exact intent under current complete-resource human authority; unavailable or unauthorized intents return null. */
  discardProposal(id: string, actorId: string, authorization: DiscardProposalAuthorization): Promise<ActionProposal | null>;

  // ── Proposal approval lifecycle ───────────────────────────────────

  /**
   * Create a one-time approval for a proposal.
   *
   * Atomically validates current active issuer membership, operation execution
   * capability and exact budget scope, proposal state, payload hash and expiry.
   * Idempotent for the same active `(proposalId, actorId)` after reauthorization.
   */
  createApproval(input: CreateApprovalInput): Promise<ProposalApproval>;

  /** Atomically grant the same reauthenticated human approval to exact proposals in one space. */
  createApprovals(input: CreateApprovalsInput): Promise<ProposalApproval[]>;

  /**
   * Atomically authorize and acquire the one generic proposal write intent,
   * consuming its complete distinct human approval set with durable audit.
   */
  acquireProposalExecution(
    input: AcquireProposalExecutionInput,
  ): Promise<ProposalExecutionAcquisition>;

  /**
   * Synchronously reauthorize the exact acquired write at the final SDK boundary.
   * Throws on revoked authority, changed approvals, or an expired/inactive claim.
   * Call immediately before invoking the mutation, with no intervening await.
   */
  validateAcquiredProposalExecution(input: ValidateAcquiredProposalExecutionInput): void;

  /** Retrieve a single approval by ID, or null. */
  getApproval(id: string): Promise<ProposalApproval | null>;

  /**
   * Find all active (non-consumed, non-expired, non-superseded) approvals
   * for a proposal.
   */
  findActiveApprovals(proposalId: string): Promise<ProposalApproval[]>;


  // ── Idempotency records ───────────────────────────────────────────

  /**
   * Create an idempotency record for at-most-once execution.
   *
   * Claims the record as `in_progress` with a lease expiration.  Rejects
   * replay with different proposalId, operation, or serialisedEffect
   * under the same idempotency key.
   *
   * @returns An {@link IdempotencyClaim} — the record and whether this
   *          call is the owner (fresh insert).
   */
  createIdempotencyRecord(input: CreateIdempotencyInput): Promise<IdempotencyClaim>;

  /** Retrieve an idempotency record by key, or null. */
  getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null>;

  /**
   * Transition an idempotency record to a terminal status.
   *
   * - No errorMessage    → `succeeded`
   * - isRetryable=true    → `retryable_failed`
   * - isRetryable=false   → `terminal_failed`
   *
   * @param key            The idempotency key.
   * @param errorMessage   Optional error message if the execution failed.
   * @param isRetryable    Whether a failed execution is safe to retry.
   * @param serialisedResult The actual verified output; failed and legacy records remain null.
   */
  completeIdempotencyRecord(
    key: string,
    errorMessage?: string | null,
    isRetryable?: boolean,
    serialisedResult?: string | null,
  ): Promise<IdempotencyRecord>;

  /**
   * Find all idempotency records whose lease has expired while still
   * `in_progress`.  These records represent executions that may have been
   * stranded by a crash or timeout.
   */
  findStrandedIdempotencyRecords(): Promise<IdempotencyRecord[]>;

  /**
   * Reconcile stranded `in_progress` records whose lease has expired.
   *
   * Marks each as `retryable_failed` and records the error.  Returns the
   * number of records reconciled.
   */
  reconcileStrandedIdempotencyRecords(): Promise<number>;

  // ── Audit records (append-only) ───────────────────────────────────

  /** Append a new audit record. */
  appendAuditRecord(input: AppendAuditInput): Promise<AuditRecord>;

  /**
   * Query audit records, optionally filtered by classification.
   * Ordered by timestamp descending.
   */
  queryAuditRecords(
    classification?: AuditClassification,
    limit?: number,
    offset?: number,
  ): Promise<AuditRecord[]>;

  /**
   * Query audit records for a specific proposal.
   * Ordered by timestamp descending.
   */
  queryAuditRecordsByProposal(proposalId: string, limit?: number): Promise<AuditRecord[]>;

  // ── Authorization ─────────────────────────────────────────────────

  // ── Correction history ────────────────────────────────────────────────

  /**
   * Query structured correction evidence recorded from approved/corrected
   * review transitions.
   *
   * Corrections are append-only; the original suggestion is never mutated.
   */
  queryCorrectionHistory(options?: CorrectionHistoryOptions): Promise<CorrectionRecord[]>;

  /**
   * Find conflicting account / direction / category values across
   * corrections for the same merchant.  Conflicts are flagged rather
   * than collapsed, so callers can decide how to resolve them.
   *
   * @param limit  Maximum number of conflicts to return (default 50).
   */
  findCorrectionConflicts(limit?: number): Promise<CorrectionConflict[]>;

  // ── Registration and invitations ────────────────────────────────

  /**
   * Get the current registration state (mode, owner info).
   */
  getRegistrationState(): Promise<RegistrationState>;

  /**
   * Claim the bootstrap slot atomically.
   * Idempotent for same email on retry; rejects different email if claimed.
   */
  claimBootstrap(input: BootstrapClaimInput): Promise<BootstrapClaimResult>;

  /**
   * Finalize bootstrap after Better Auth user creation.
   * Writes owner ID, membership, timestamp, and audit atomically.
   * Idempotent on already-finalized claims.
   */
  finalizeBootstrap(input: FinalizeBootstrapInput): Promise<FinalizeBootstrapResult>;

  /** Creates a membership-only invitation under current scoped human control. */
  createInvitation(input: InvitationControlInput): Promise<CreateInvitationResult>;

  /** Revokes only an invitation in the selected space, preserving attribution. */
  revokeInvitation(input: InvitationControlInput & { readonly invitationId: string }): Promise<void>;

  /** Lists public invitation metadata only within the authorized selected space. */
  listInvitations(input: InvitationControlInput): Promise<InvitationMetadata[]>;

  /**
   * Claim an invitation by presenting the bearer token.
   * Transitions the invitation from 'active' to 'claimed' and returns
   * a claim ID for cross-database identity creation recovery.
   *
   * Idempotent: re-claiming with the same token and email returns the
   * existing claim; a different email is rejected.
   *
   * @throws If the token is invalid, revoked, already redeemed,
   *         already claimed by a different email, or expired.
   *         Expired invitations are marked as such before the throw.
   */
  claimInvitation(input: ClaimInvitationInput): Promise<ClaimInvitationResult>;

  /**
   * Atomically completes the canonical claim and creates a membership-only join.
   * Fresh target identity and verified email must match; stale issuer consent
   * never revives on rejoin, and failure creates no identity or membership.
   */
  completeInvitationRedemption(
    claimId: string,
    userId: string,
    options: {
      readonly auth: HumanControlContext;
      readonly email: string;
      readonly now?: string;
      readonly requestId?: string;
    },
  ): Promise<void>;

  /**
   * Evaluate whether an actor is authorized for a given capability/scope.
   *
   * Checks: actor exists in membership registry, status is 'active',
   * capabilities include the required capability, scope covers the required
   * scope.
   */
  evaluateAuthorization(
    actorId: string,
    capability: string,
    scope: string,
    policyVersion: string,
  ): Promise<AuthorizationResult>;

  /**
   * Upsert an actor's membership record.
   *
   * Creates or overwrites the actor's status, capabilities, and scope.
   */
  upsertActorMembership(
    actorId: string,
    status: MembershipStatus,
    capabilities: string[],
    scope: string,
  ): Promise<void>;

  /**
   * Get an actor's membership record, or null if not registered.
   */
  getActorMembership(actorId: string): Promise<{
    actorId: string;
    status: MembershipStatus;
    capabilities: string[];
    scope: string;
  } | null>;

  // ── Lifecycle / administrative operations ─────────────────────────

  /** Cancel pending jobs in one exact selected scope; legacy unscoped jobs are retained. */
  cancelPendingJobs(scope: LifecycleScope, options?: { actorOnly?: boolean }): Promise<number>;

  /**
   * Delete an actor's membership record. Returns true if a
   * record was found and deleted.
   */
  deleteActorMembership(actorId: string): Promise<boolean>;

  /** Record export provenance for this exact actor/space/budget. */
  recordExport(input: LifecycleScope & {
    budgetName: string;
    exportPath: string;
    sha256Hash: string;
    byteSize: number;
    accountCount: number;
    transactionCount: number;
  }): Promise<void>;

  /** Get the latest export for one exact actor/space/budget. */
  getLastExport(scope: LifecycleScope): Promise<{
    exportedAt: string;
    budgetName: string;
    exportPath: string;
    sha256Hash: string;
    byteSize: number;
    accountCount: number;
    transactionCount: number;
  } | null>;

  /**
   * Delete all records for a given lifecycle scope.
   *
   * Supported scopes: connection, space, user, provider, workflow,
   * notification.
   *
   * @returns Deleted counts per entity type, plus retained records
   *          count and reasons why certain records were preserved.
   */
  // ── Rule overrides ────────────────────────────────────────────

  /**
   * Read active local rule overrides for one exact space/budget binding.
   * Tombstones are omitted; never-created overrides are absent.
   */
  getRuleOverrides(scope: RuleOverrideScope): Promise<Map<string, RuleOverride>>;

  /** Read one active override or retained tombstone; null means never created. */
  getRuleOverride(input: GetRuleOverrideInput): Promise<RuleOverride | null>;

  /** Compare-and-swap the local inactive state, retaining a monotonically versioned row. */
  setRuleOverride(input: SetRuleOverrideInput): Promise<RuleOverride>;

  /** Compare-and-swap an active override to a retained tombstone. */
  removeRuleOverride(input: RemoveRuleOverrideInput): Promise<void>;

  deleteScopeData(
    scope: string,
    lifecycleScope: LifecycleScope,
  ): Promise<{
    deleted: Record<string, number>;
    retained: { count: number; reasons: string[] };
  }>;

  // ── Notification event lifecycle (immutable) ─────────────────────

  /**
   * Create an immutable notification event.
   *
   * The event is persisted before any outbox record is created
   * (persist-before-dispatch invariant).
   */
  createNotificationEvent(input: CreateNotificationEventInput): Promise<NotificationEvent>;

  /**
   * Atomically create an immutable event or return the event already persisted
   * for the same `(dedupKey, recipientId, scope)` identity.
   *
   * The database is the authority for this identity across processes and
   * connections. Existing event contents are returned unchanged.
   */
  createOrGetNotificationEvent(
    input: CreateOrGetNotificationEventInput,
  ): Promise<NotificationEvent>;

  /** Retrieve a notification event by ID, or null. */
  getNotificationEvent(id: string): Promise<NotificationEvent | null>;

  // ── Notification outbox lifecycle ───────────────────────────────

  /**
   * Enqueue a notification for delivery by creating an outbox record.
   *
   * Idempotent: re-enqueuing with the same deliveryKey returns the
   * existing outbox record unchanged.
   */
  enqueueNotification(input: EnqueueNotificationInput): Promise<NotificationOutboxRecord>;

  /**
   * Claim a pending notification outbox record for delivery.
   *
   * Idempotent: re-claiming with the same claimToken returns the
   * already-claimed record.  Records whose claimExpiresAt is in the
   * past may be reclaimed (crash recovery).
   */
  claimNotificationDelivery(
    outboxId: string,
    claimToken: string,
    claimTimeoutMs?: number,
  ): Promise<NotificationOutboxRecord | null>;

  /**
   * Complete a notification delivery.
   *
   * Marks the outbox record as delivered, records a delivery attempt,
   * and clears the claim token.  Requires the active claim token.
   */
  completeNotificationDelivery(
    outboxId: string,
    claimToken: string,
    response?: { code?: string; body?: string },
  ): Promise<NotificationOutboxRecord>;

  /**
   * Fail a notification delivery.
   *
   * Marks the outbox record as failed (or schedules a retry if attempts
   * remain), records a failed delivery attempt.  Requires the active
   * claim token.
   */
  failNotificationDelivery(
    outboxId: string,
    claimToken: string,
    errorMessage: string,
    retryable?: boolean,
  ): Promise<NotificationOutboxRecord>;

  /**
   * Acknowledge a delivered notification (recipient confirmed receipt).
   * Only applicable to records in 'delivered' status.
   */
  acknowledgeNotification(outboxId: string): Promise<NotificationOutboxRecord>;

  /**
   * Suppress a notification, preventing future delivery attempts.
   * Works on any non-terminal outbox record.
   */
  suppressNotification(outboxId: string, reason: string): Promise<NotificationOutboxRecord>;

  /** Retrieve an outbox record by ID, or null. */
  getOutboxRecord(id: string): Promise<NotificationOutboxRecord | null>;

  /**
   * Return all pending (undelivered, unclaimed) outbox records.
   * Optionally filtered by channel type.
   */
  getPendingNotifications(
    limit?: number,
    channelType?: string,
  ): Promise<NotificationOutboxRecord[]>;

  /**
   * Return outbox records ready for retry (failed with attempts remaining
   * and nextAttemptAt <= now).  Optionally filtered by channel type.
   */
  getRetryableNotifications(
    limit?: number,
    channelType?: string,
  ): Promise<NotificationOutboxRecord[]>;

  /** Return all delivery attempts for a given outbox record. */
  getDeliveryAttempts(outboxId: string): Promise<DeliveryAttempt[]>;

  /**
   * List outbox records with optional status/channel filter and pagination.
   * Ordered by created_at descending (newest first).
   */
  listOutboxRecords(options?: ListOutboxRecordsOptions): Promise<NotificationOutboxRecord[]>;

  // ── Policy version lifecycle ────────────────────────────────────

  /**
   * Record a new policy version.
   *
   * The created version is automatically set as the active version for
   * its policyKey.  Any previously active version for the same key is
   * superseded.
   */
  recordPolicyVersion(input: RecordPolicyVersionInput): Promise<PolicyVersion>;

  /** Retrieve a policy version by ID, or null. */
  getPolicyVersion(id: string): Promise<PolicyVersion | null>;

  /**
   * Return the currently active policy version for a given policy key,
   * or null if none is recorded.
   */
  getActivePolicyVersion(policyKey: string): Promise<PolicyVersion | null>;

  /**
   * List policy versions for a given policy key, ordered by version
   * descending.
   */
  listPolicyVersions(policyKey: string, limit?: number, offset?: number): Promise<PolicyVersion[]>;

  // ── Saved filter / view lifecycle ───────────────────────────────

  /**
   * Create a new saved filter or view.
   *
   * If isDefault is true, any existing default for the same
   * (budgetId, scope) combination is demoted.
   */
  createSavedFilter(input: CreateSavedFilterInput): Promise<SavedFilter>;

  /**
   * Update an existing saved filter/view.
   *
   * Only the provided fields are changed.  If isDefault is set to true,
   * any existing default for the same (budgetId, scope) is demoted.
   */
  updateSavedFilter(id: string, input: UpdateSavedFilterInput): Promise<SavedFilter>;

  /** Retrieve a saved filter by ID, or null. */
  getSavedFilter(id: string): Promise<SavedFilter | null>;

  /**
   * List saved filters, optionally filtered by budget, scope, or actor.
   */
  listSavedFilters(options?: SavedFilterListOptions): Promise<SavedFilter[]>;

  /** Delete a saved filter by ID. */
  deleteSavedFilter(id: string): Promise<void>;

  // ── Report record lifecycle ─────────────────────────────────────

  /** Persist a new report record. */
  createReportRecord(input: CreateReportRecordInput): Promise<ReportRecord>;

  /** Retrieve a report record by ID, or null. */
  getReportRecord(id: string): Promise<ReportRecord | null>;

  /**
   * List report records, optionally filtered by budget or report type.
   */
  listReportRecords(options?: ReportListOptions): Promise<ReportRecord[]>;

  /**
   * Expire a report record by setting its expiresAt to now.
   * Idempotent on already-expired records.
   */
  expireReportRecord(id: string): Promise<ReportRecord>;

  // ── Saved view lifecycle (Phase 8) ──────────────────────────────

  /** List saved views originating in this current selected membership period. */
  listSavedViews(authority: SavedViewAuthority): Promise<SavedViewResult[]>;

  /** Create a saved view tied to the verified selected space, budget, and membership. */
  createSavedView(input: CreateSavedViewInput): Promise<SavedViewResult>;

  /** Update a view only while the originating space and membership period remain current. */
  updateSavedView(viewId: string, input: UpdateSavedViewInput): Promise<SavedViewResult>;

  /** Duplicate a view only within its originating current scope. */
  duplicateSavedView(input: DuplicateSavedViewInput): Promise<SavedViewResult>;

  /** Delete a view only within its originating current scope. */
  deleteSavedView(viewId: string, authority: SavedViewAuthority): Promise<boolean>;

  /** Record usage only within the originating current scope. */
  recordSavedViewUsage(viewId: string, authority: SavedViewAuthority): Promise<SavedViewResult>;

  /** Retrieve a view by ID only within its originating current scope. */
  getSavedView(viewId: string, authority: SavedViewAuthority): Promise<SavedViewResult | null>;

  // ── Finding lifecycle (Phase 8.5) ────────────────────────────────

  /**
   * Create a new finding in 'open' status.
   *
   * @returns The newly created finding with a stable ID and version.
   */
  createFinding(input: CreateFindingInput): Promise<Finding>;

  /** Retrieve a single finding by ID, or null. */
  getFinding(id: string): Promise<Finding | null>;

  /**
   * List findings, optionally filtered by status, budget, classification,
   * or severity. Ordered by severity (critical first), then creation time.
   */
  listFindings(options?: ListFindingsOptions): Promise<Finding[]>;

  /**
   * Return the total number of findings matching the given filter.
   */
  countFindings(options?: ListFindingsOptions): Promise<number>;

  /**
   * Acknowledge a finding. Transitions from 'open' to 'acknowledged'.
   *
   * @throws If the transition is not allowed or version lock fails.
   */
  acknowledgeFinding(input: AcknowledgeFindingInput): Promise<Finding>;

  /**
   * Mark a finding as corrected. Transitions from 'open' or 'acknowledged'
   * to 'corrected'. Requires a correction reference.
   *
   * @throws If the transition is not allowed or version lock fails.
   */
  correctFinding(input: CorrectFindingInput): Promise<Finding>;

  /**
   * Dismiss a finding. Transitions from 'open', 'acknowledged' to 'dismissed'.
   *
   * @throws If the transition is not allowed or version lock fails.
   */
  dismissFinding(input: DismissFindingInput): Promise<Finding>;

  /**
   * Reopen a previously dismissed or acknowledged finding.
   * Transitions from 'acknowledged' or 'dismissed' to 'reopened'.
   *
   * @throws If the transition is not allowed or version lock fails.
   */
  reopenFinding(input: ReopenFindingInput): Promise<Finding>;

  /**
   * Supersede a finding. Transitions from any non-terminal status to
   * 'superseded'. Indicates the finding has been replaced.
   *
   * @throws If the transition is not allowed or version lock fails.
   */
  supersedeFinding(input: SupersedeFindingInput): Promise<Finding>;

  /**
   * Expire a finding whose expiresAt has passed.
   * Transitions from any non-terminal status to 'expired'.
   * Idempotent on already-expired findings.
   */
  expireFinding(id: string): Promise<Finding>;

  // ── Notification policy lifecycle (Phase 8.5) ────────────────────

  /**
   * Save or update a notification policy for a space.
   * The policy is stored as JSON-encoded content.
   * If a policy with the same (spaceId, policyKey) exists, it is updated;
   * otherwise a new record is created.
   */
  saveNotificationPolicy(input: SaveNotificationPolicyInput): Promise<NotificationPolicyRecord>;

  /**
   * Retrieve a notification policy by (spaceId, policyKey), or null.
   */
  getNotificationPolicy(
    spaceId: string,
    policyKey: string,
  ): Promise<NotificationPolicyRecord | null>;

  /**
   * List notification policies, optionally filtered by space, policy key,
   * or active status.
   */
  listNotificationPolicies(
    options?: ListNotificationPoliciesOptions,
  ): Promise<NotificationPolicyRecord[]>;

  /**
   * Resolve recipients for a notification within a space based on the
   * active notification policy. Returns actor IDs and eligible channels.
   */
  resolveRecipients(
    spaceId: string,
    classification: string,
    severity: string,
  ): Promise<RecipientResolution>;

  /**
   * Delete a notification policy by ID. Returns true if found and deleted.
   */
  deleteNotificationPolicy(id: string): Promise<boolean>;

  // ── Report history (Phase 8.5) ───────────────────────────────────

  /**
   * Retrieve time-ordered report history, optionally filtered by budget.
   */
  getReportHistory(
    budgetId?: string,
    limit?: number,
    offset?: number,
  ): Promise<ReportHistoryEntry[]>;

  /**
   * Count total report records, optionally filtered by budget.
   */
  countReportRecords(budgetId?: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// ActionProposal — immutable proposal for a workflow action
// ---------------------------------------------------------------------------

/** Supported workflow action proposal operations. */
export type ProposalOperation =
  | 'set_category'
  | 'create_rule'
  | 'update_rule'
  | 'delete_rule'
  | 'transfer'
  | 'session_completion';

/** Operations admitted by the native generic proposal lifecycle. */
export type GenericProposalOperation =
  | 'set_category'
  | 'create_rule'
  | 'update_rule'
  | 'delete_rule';

/** Exact signed amount accepted by the Actual manual-transaction boundary. */
export interface SessionCompletionMoney {
  readonly minorUnits: string;
  readonly currency: string;
}

/** One exact split child in an immutable session-completion payload. */
export interface SessionCompletionSplit {
  readonly amount: number;
  readonly accountId: string;
  readonly date: string;
  readonly categoryId: string;
}

/** Structurally compatible manual input; workflow-store does not depend on Actual adapter code. */
export interface SessionCompletionManualInput {
  readonly parentId: string;
  readonly correlationId: string;
  readonly accountId: string;
  readonly amount: number;
  readonly date: string;
  readonly categoryId?: string | null;
  readonly payeeName?: string;
  readonly notes?: string;
  readonly splits?: readonly SessionCompletionSplit[];
}

/** Exact native Card category charge copied into a completion payload. */
export interface SessionCompletionCategoryCharge {
  readonly categoryId: string;
  readonly amount: SessionCompletionMoney;
}

/** Immutable server-constructed payload for one saved-session completion. */
export interface SessionCompletionPayload {
  readonly kind: 'session_completion';
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly intentHash: string;
  readonly materialHash: string;
  readonly manualInput: SessionCompletionManualInput;
  readonly categoryCharges: readonly SessionCompletionCategoryCharge[];
  readonly cooldownUntil: string | null;
}

/** Durable lifecycle phase for a session-completion proposal. */
export type SessionCompletionPhase =
  | 'proposed'
  | 'approved'
  | 'write_intent'
  | 'verified'
  | 'review_required'
  | 'closed';

/** Durable terminal/diagnostic outcome for a session-completion proposal. */
export type SessionCompletionOutcome =
  | null
  | 'expired'
  | 'superseded'
  | 'cancelled'
  | 'reconciliation_required'
  | 'ambiguous'
  | 'policy_changed'
  | 'session_changed'
  | 'cooldown'
  | 'revoked'
  | (string & {});

/** State machine stored separately from transfer state. */
export interface SessionCompletionState {
  readonly phase: SessionCompletionPhase;
  readonly outcome: SessionCompletionOutcome;
}

/**
 * Shared immutable proposal fields. The state parameter keeps transfer and
 * session-completion state machines distinct while preserving the old default.
 */
export interface ActionProposalBase<State = TransferState> {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** Budget this proposal targets. */
  readonly budgetId: string;
  /** Server-selected space that authorized the proposer. */
  readonly spaceId: string | null;
  /** Original requester membership period, or the original agent delegation issuer period. */
  readonly requesterMembershipId: string | null;
  readonly governancePolicyVersion: string | null;
  /** Hex-encoded SHA-256 hash of the full proposal content. */
  readonly payloadHash: string;
  /** Policy version active when the proposal was created. */
  readonly policyVersion: string;
  /** JSON-encoded preconditions that must hold for execution. */
  readonly preconditions: string;
  /** ISO-8601 timestamp after which the proposal is no longer valid. */
  readonly expiresAt: string;
  /** The actor who authored this proposal. */
  readonly actorId: string;
  /** Provenance label (e.g. "model-derived", "manual"). */
  readonly provenance: string;
  /** Model identifier if AI-generated, null otherwise. */
  readonly providerModel: string | null;
  /** Optional correlation ID for grouping related proposals. */
  readonly correlationId: string | null;
  /** ISO-8601 timestamp when superseded, or null if active. */
  readonly supersededAt: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  readonly version: number;
  readonly state: State;
}

/** Recursively JSON-safe value stored in a generic proposal envelope. */
export type ProposalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProposalJsonValue[]
  | ProposalJsonObject;

/** JSON object persisted as part of an exact generic proposal component. */
export interface ProposalJsonObject {
  readonly [key: string]: ProposalJsonValue;
}

/** Complete frozen composite envelope; each component array participates in hashing and authorization. */
export interface GenericProposalComposite {
  readonly operations: readonly ProposalJsonObject[];
  readonly reallocations: readonly (ProposalJsonObject | CategoryReallocation)[];
  readonly transferRecommendations: readonly (ProposalJsonObject | TransferPlan)[];
  readonly ledgerProjections: readonly ProposalJsonObject[];
  readonly evidenceReferences: readonly ProposalJsonObject[];
  readonly nativePayloadHash?: string;
}

/** Exact set-category mutation plus its optional complete composite envelope. */
export interface CategoryActionPayload {
  readonly kind: 'set_category';
  readonly transactionId: string;
  readonly categoryId: string;
  readonly composite?: GenericProposalComposite;
}

/** Exact rule mutation plus its optional complete composite envelope. */
export interface RuleActionPayload {
  readonly kind: 'create_rule';
  readonly transactionId: string | null;
  readonly categoryId: string;
  readonly rule: Record<string, unknown>;
  readonly composite?: GenericProposalComposite;
}

/** Exact local inactive override mutation plus its complete generic envelope. */
export interface UpdateRuleActionPayload {
  readonly kind: 'update_rule';
  readonly ruleId: string;
  readonly inactive: boolean;
  readonly composite?: GenericProposalComposite;
}

/** Exact Actual rule deletion plus its complete generic envelope. */
export interface DeleteRuleActionPayload {
  readonly kind: 'delete_rule';
  readonly ruleId: string;
  readonly composite?: GenericProposalComposite;
}

/** All proposal variants, including the specialized completion operation. */
export type ActionProposal =
  | (
      ActionProposalBase<TransferState> &
        (
          | { readonly operation: 'set_category'; readonly payload: CategoryActionPayload }
          | { readonly operation: 'create_rule'; readonly payload: RuleActionPayload }
          | { readonly operation: 'update_rule'; readonly payload: UpdateRuleActionPayload }
          | { readonly operation: 'delete_rule'; readonly payload: DeleteRuleActionPayload }
          | {
              readonly operation: 'transfer';
              readonly payload: {
                readonly kind: 'transfer';
                readonly plan: TransferPlan;
                readonly sessionId: string | null;
                readonly sessionVersion: number | null;
              };
            }
        )
    )
  | (ActionProposalBase<SessionCompletionState> & {
      readonly operation: 'session_completion';
      readonly payload: SessionCompletionPayload;
    });

/** Specialized completion proposal extracted from the shared action union. */
export type SessionCompletionProposal = Extract<ActionProposal, { operation: 'session_completion' }>;

/** Input to create a new authenticated generic proposal; the store computes its hash. */
export interface CreateProposalInput {
  readonly operation: GenericProposalOperation;
  readonly budgetId: string;
  readonly spaceId: string;
  readonly payload: CategoryActionPayload | RuleActionPayload | UpdateRuleActionPayload | DeleteRuleActionPayload;
  /** Current generic mutation algorithm version. */
  readonly policyVersion: string;
  /** JSON-encoded, server-derived facts and execution preconditions. */
  readonly preconditions: string;
  /** ISO-8601 expiry timestamp. */
  readonly expiresAt: string;
  readonly actorId: string;
  /** Trusted server credential metadata; never accepted from an HTTP body. */
  readonly auth: OperationalAuth;
  readonly provenance: string;
  readonly providerModel?: string | null;
  readonly correlationId?: string | null;
}

/** Hash input covering every immutable generic proposal field. */
export interface CanonicalProposalEnvelope {
  readonly operation: string;
  readonly budgetId: string;
  readonly payload: unknown;
  readonly preconditions: unknown;
  readonly actorId: string;
  readonly policyVersion: string;
  readonly expiresAt: string;
}

/** Classified failure codes exposed by the generic proposal acquisition boundary. */
export type ProposalAcquisitionReasonCode =
  | 'approval_required'
  | 'policy_version_mismatch'
  | 'payload_hash_mismatch'
  | 'approval_consumed'
  | 'idempotency_in_progress'
  | 'authorization_denied'
  | 'proposal_expired'
  | 'proposal_superseded'
  | 'idempotency_replay_mismatch';

/** Input to the one-shot generic proposal execution acquisition. */
export interface AcquireProposalExecutionInput {
  readonly actorId: string;
  readonly proposalId: string;
  readonly payloadHash: string;
  readonly governancePolicyVersion: string;
  readonly idempotencyKey: string;
  readonly serialisedEffect: string;
  readonly approvalId?: string;
  readonly auth: OperationalAuth;
  readonly now?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

/** Exact durable acquisition token for a final check using the store's fresh clock. */
export type ValidateAcquiredProposalExecutionInput =
  Omit<AcquireProposalExecutionInput, 'now' | 'approvalId'> & {
    readonly acquisitionAuditId: string;
  };

/** Atomic authorization, idempotency claim, approval consumption and audit result. */
export interface ProposalExecutionAcquisition {
  readonly claim: IdempotencyClaim;
  readonly approvals: readonly ProposalApproval[];
  readonly auditRecord: AuditRecord | null;
}

/** The only operations accepted by the generic mutation acquisition boundary. */
export type GenericActionProposal = Extract<ActionProposal, { operation: GenericProposalOperation }>;

/** Exact eligible human-approval projection safe to return without session credentials. */
export interface CurrentHumanApproval {
  readonly actorId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Input to query a current governance-bound approval summary for one selected space. */
export interface GetProposalApprovalSummaryInput {
  readonly proposalId: string;
  readonly spaceId: string;
  readonly actorId: string;
  readonly auth: OperationalAuth;
  readonly now: string;
  /** Trusted adapter correlation identifier; generated by Native when omitted. */
  readonly requestId?: string;
}

/** Trusted projection selection for current selected-space proposal publication. */
export interface GetProposalApprovalReadsInput extends Omit<GetProposalApprovalSummaryInput, 'proposalId'> {
  readonly proposalIds: readonly string[];
  readonly privateProjection: 'preconditions' | 'envelope' | 'detail';
}

/** Current admitted row and projection facts; payload is private unless its summary admits disclosure. */
export interface ProposalApprovalRead {
  readonly proposal: GenericActionProposal;
  readonly preconditions: Readonly<Record<string, unknown>> | null;
  readonly summary: ProposalApprovalSummary;
}

/** Current native governance state and caller capabilities for an exact generic proposal. */
export interface ProposalApprovalSummary {
  readonly currentGovernancePolicyVersion: string;
  readonly requesterMembershipCurrent: boolean;
  /** Independent private-read authority for the complete server-owned envelope. */
  readonly privateEnvelopeVisible: boolean;
  /** Exact current approval-operation rights, independent of proposal liveness or private-envelope reads. */
  readonly approvalAuthorized: boolean;
  /** Exact current execution-operation rights, independent of quorum or mutable execution baselines. */
  readonly executionAuthorized: boolean;
  readonly requiredApprovers: number;
  readonly approvers: readonly CurrentHumanApproval[];
  readonly disposition: GovernanceDisposition;
  readonly canApprove: boolean;
  readonly canExecute: boolean;
}

// ---------------------------------------------------------------------------
// ProposalApproval — one-time authorization to execute a proposal
// ---------------------------------------------------------------------------

/** Lifecycle status of a proposal approval. */
export type ApprovalStatus = 'active' | 'consumed' | 'expired' | 'superseded';

/** An approval granting one-time authorization to execute a proposal. */
export interface ProposalApproval {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** The proposal this approval is for. */
  readonly proposalId: string;
  /** Payload hash of the proposal at time of approval. */
  readonly payloadHash: string;
  /** The actor who granted this approval. */
  readonly actorId: string;
  /** Current approval lifecycle status. */
  readonly status: ApprovalStatus;
  /** Current original membership period of the approver, or null for legacy rows. */
  readonly membershipId: string | null;
  /** Governance version under which human consent was recorded. */
  readonly governancePolicyVersion: string | null;
  /** Reauthenticated session that granted consent; null for legacy rows. */
  readonly reauthenticatedSessionId: string | null;
  /** Reauthentication time captured at approval issuance; null for legacy rows. */
  readonly reauthenticatedAt: string | null;
  /** ISO-8601 expiry timestamp. */
  readonly expiresAt: string;
  /** ISO-8601 timestamp when consumed, or null. */
  readonly consumedAt: string | null;
  /** ISO-8601 timestamp when superseded, or null. */
  readonly supersededAt: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Input to create a fresh, reauthenticated human approval. */
export interface CreateApprovalInput {
  readonly proposalId: string;
  /** Must match the displayed proposal hash exactly. */
  readonly payloadHash: string;
  readonly actorId: string;
  /** ISO-8601 expiry timestamp (must be in the future). */
  readonly expiresAt: string;
  /** Trusted server-verified human session and fresh reauthentication. */
  readonly auth: HumanControlContext;
  /** Trusted operation time; server time in production. */
  readonly now: string;
}

/** Input to issue approvals for multiple exact proposals atomically. */
export interface CreateApprovalsInput {
  readonly spaceId: string;
  readonly approvals: readonly {
    readonly proposalId: string;
    /** Must match the hash the human displayed for this proposal. */
    readonly payloadHash: string;
  }[];
  readonly auth: HumanControlContext;
  /** Trusted operation time; server time in production. */
  readonly now?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}


// ---------------------------------------------------------------------------
// IdempotencyRecord — at-most-once execution tracking
// ---------------------------------------------------------------------------
export type IdempotencyStatus =
  'in_progress' | 'succeeded' | 'retryable_failed' | 'terminal_failed';

/** Record of an idempotent workflow operation. */
export interface IdempotencyRecord {
  readonly idempotencyKey: string;
  readonly proposalId: string;
  readonly operation: string;
  readonly executedAt: string;
  readonly completed: boolean;
  /** Lifecycle status of this record. */
  readonly status: IdempotencyStatus;
  /** ISO-8601 timestamp after which the in_progress claim expires. */
  readonly leaseExpiresAt: string | null;
  /** Serialised effect of the execution. */
  readonly serialisedEffect: string;
  /** Nullable verified output; null legacy/failed writes are never inferred as success. */
  readonly serialisedResult: string | null;
  readonly errorMessage: string | null;
  readonly updatedAt: string;
}

/** Input to create an idempotency record. */
export interface CreateIdempotencyInput {
  readonly idempotencyKey: string;
  readonly proposalId: string;
  readonly operation: string;
  readonly serialisedEffect: string;
  /** Duration in milliseconds for the initial lease.  Defaults to 60 000. */
  readonly leaseDurationMs?: number;
}

/**
 * Result of claiming an idempotency record — indicates whether this
 * invocation created the record (isOwner === true) or found an existing one.
 */
export interface IdempotencyClaim {
  readonly record: IdempotencyRecord;
  readonly isOwner: boolean;
}

// ---------------------------------------------------------------------------
// AuditRecord — append-only workflow audit trail
// ---------------------------------------------------------------------------

/**
 * Classification label for audit records.
 * Open-ended to allow extension; common values are defined as literals
 * for documentation purposes.
 */
export type AuditClassification =
  | 'proposal_created'
  | 'approval_granted'
  | 'approval_consumed'
  | 'execution_started'
  | 'execution_completed'
  | 'execution_failed'
  | 'proposal_superseded'
  | 'authorization_check'
  | 'invitation_created'
  | 'invitation_claimed'
  | 'invitation_revoked'
  | 'invitation_redeemed'
  | 'invitation_expired'
  | 'notification_created'
  | 'notification_enqueued'
  | 'notification_delivered'
  | 'notification_failed'
  | 'notification_acknowledged'
  | 'notification_suppressed'
  | 'notification_retried'
  | 'finding_created'
  | 'finding_acknowledged'
  | 'finding_corrected'
  | 'finding_dismissed'
  | 'finding_reopened'
  | 'finding_superseded'
  | 'finding_expired'
  | 'saved_view_updated'
  | 'saved_view_deleted'
  | 'saved_view_duplicated'
  | 'saved_view_usage_recorded'
  | 'notification_policy_saved'
  | 'notification_policy_deleted'
  | (string & {});

/** An append-only audit record. Immutable once written. */
export interface AuditRecord {
  readonly id: string;
  readonly classification: string;
  readonly timestamp: string;
  readonly actorId: string;
  readonly operation: string | null;
  readonly proposalId: string | null;
  readonly payloadHash: string | null;
  readonly budgetId: string | null;
  readonly backendIds: string;
  readonly policyVersion: string | null;
  readonly authorizationDisposition: AuthorizationDisposition | null;
  readonly idempotencyKey: string | null;
  readonly expectedPriorState: string | null;
  readonly observedResultState: string | null;
  readonly providerModel: string | null;
  readonly correlationId: string | null;
  readonly requestId: string | null;
  readonly result: string;
  readonly isError: boolean;
}

/** Input to append a new audit record. */
export interface AppendAuditInput {
  readonly classification: string;
  readonly actorId: string;
  readonly operation?: string | null;
  readonly proposalId?: string | null;
  readonly payloadHash?: string | null;
  readonly budgetId?: string | null;
  readonly backendIds?: string;
  readonly policyVersion?: string | null;
  readonly authorizationDisposition?: AuthorizationDisposition | null;
  readonly idempotencyKey?: string | null;
  readonly expectedPriorState?: string | null;
  readonly observedResultState?: string | null;
  readonly providerModel?: string | null;
  readonly correlationId?: string | null;
  readonly requestId?: string | null;
  readonly result: string;
  readonly isError?: boolean;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CorrectionRecord — structured evidence from approved/corrected reviews
// ---------------------------------------------------------------------------

/**
 * Structured evidence captured when a review item is approved/corrected or
 * when a verified categorization is applied.  Immutable once written.
 */
export interface CorrectionRecord {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** The review item that was approved or corrected. */
  readonly reviewItemId: string;
  /** Transaction this correction applies to. */
  readonly transactionId: string;
  /** Monotonic version of the transaction at time of correction. */
  readonly transactionVersion: number;
  /** Normalized merchant name from the transaction payee. */
  readonly merchant: string | null;
  /** Imported payee name from the transaction import data. */
  readonly importedPayee: string | null;
  /** Account ID the transaction belongs to. */
  readonly accountId: string | null;
  /** Direction — `'inflow'`, `'outflow'`, or null. */
  readonly direction: string | null;
  /** Transaction amount in minor units, or null. */
  readonly amount: number | null;
  /** Transaction date (ISO-8601), or null. */
  readonly date: string | null;
  /** The category that was approved or assigned. */
  readonly categoryId: string;
  /** Category before verified categorization, or null for legacy corrections. */
  readonly previousCategoryId: string | null;
  /** Proposal and immutable execution envelope for verified categorization. */
  readonly proposalId: string | null;
  readonly proposalActorId: string | null;
  readonly payloadHash: string | null;
  readonly idempotencyKey: string | null;
  readonly verified: boolean;
  /** Human-readable category name, or null. */
  readonly categoryName: string | null;
  /** Actor who performed the approval or correction. */
  readonly actor: string;
  /** Review status before this transition. */
  readonly fromStatus: ReviewStatus;
  /** Review status after this transition. */
  readonly toStatus: ReviewStatus;
  /** The review item ID that is the source of this correction. */
  readonly sourceReviewId: string;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/**
 * A detected conflict among corrections for the same merchant across
 * different approved or corrected reviews.
 */
export interface CorrectionConflict {
  /** The field that has conflicting values (`'account'`, `'direction'`, `'category'`). */
  readonly field: 'account' | 'direction' | 'category';
  /** The merchant name shared by the conflicting corrections. */
  readonly merchant: string;
  /** The distinct values found for this field across corrections. */
  readonly values: string[];
  /** IDs of the correction records that contribute to this conflict. */
  readonly correctionIds: string[];
}

/** Options for querying correction history. */
export interface CorrectionHistoryOptions {
  /** Filter by review item ID. */
  readonly reviewItemId?: string;
  /** Filter by merchant name. */
  readonly merchant?: string;
  /** Filter by transaction ID. */
  readonly transactionId?: string;
  /** Filter by actor. */
  readonly actor?: string;
  /** Maximum number of records to return (default 50). */
  readonly limit?: number;
  /** Number of records to skip. */
  readonly offset?: number;
}
// Authorization types
// ---------------------------------------------------------------------------

/**
 * Authorization disposition — the outcome of evaluating policy.
 */
export type AuthorizationDisposition =
  | { kind: 'authorized_without_approval' }
  | { kind: 'approval_required' }
  | { kind: 'denied'; reason: string };

/** Membership status for an actor in the workflow store. */
export type MembershipStatus = 'active' | 'inactive' | 'suspended';

/** Result of evaluating an actor's authorization for a capability/scope. */
export interface AuthorizationResult {
  readonly allowed: boolean;
  readonly disposition: AuthorizationDisposition;
  readonly actorId: string;
  readonly membershipStatus: MembershipStatus | 'unknown';
  readonly capability: string;
  readonly scope: string;
  readonly policyVersion: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Registration — self-hosted bootstrap lifecycle
// ---------------------------------------------------------------------------

/**
 * Registration mode indicating whether the instance has been bootstrapped.
 * `'bootstrap'` — no owner exists, setup is available.
 * `'complete'` — an owner has been registered, further bootstrap is blocked.
 */
export type RegistrationMode = 'bootstrap' | 'complete';

/**
 * Public registration state returned by {@link SqliteWorkflowStore.getRegistrationState}.
 * Contains no secrets.
 */
export interface RegistrationState {
  readonly mode: RegistrationMode;
  readonly ownerUserId: string | null;
  readonly bootstrappedAt: string | null;
}

/**
 * Input to claim the bootstrap slot.
 * No secrets here — those are validated by the route before calling the store.
 */
export interface BootstrapClaimInput {
  readonly name: string;
  readonly email: string;
  readonly claimId: string;
}

/**
 * Result of claiming the bootstrap slot — a claimId for cross-database recovery.
 */
export interface BootstrapClaimResult {
  readonly claimId: string;
}

/**
 * Input to finalize bootstrap after Better Auth user creation.
 * Writes the actual user ID, owner membership, timestamp, and audit atomically.
 */
export interface FinalizeBootstrapInput {
  readonly claimId: string;
  readonly ownerUserId: string;
}

/**
 * Result of finalizing bootstrap — the now-immutable owner identity.
 */
export interface FinalizeBootstrapResult {
  readonly ownerUserId: string;
  readonly bootstrappedAt: string;
}

/** Current scoped human authority for invitation management. */
export interface InvitationControlInput {
  readonly spaceId: string;
  readonly auth: HumanControlContext;
  readonly now?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

/**
 * Input to claim an invitation by presenting the bearer token.
 * Optional request/correlation IDs are propagated to audit records.
 */
export interface ClaimInvitationInput {
  readonly token: string;
  readonly email: string;
  /** Optional request/correlation IDs propagated to audit records. */
  readonly requestId?: string;
  readonly correlationId?: string;
}
/**
 * Lifecycle status of an invitation token.
 * - `active`: ready to be claimed.
 * - `claimed`: a recipient has bound their email; awaiting identity creation.
 * - `redeemed`: the recipient has created their account.
 * - `revoked`: explicitly invalidated by the owner before use.
 * - `expired`: the token lifetime has elapsed without redemption.
 */
export type InvitationStatus = 'active' | 'claimed' | 'redeemed' | 'revoked' | 'expired';

/**
 * Full invitation record as stored in the database.
 * Never contains the raw bearer token.
 */
export interface Invitation {
  readonly id: string;
  readonly tokenDigest: string;
  readonly status: InvitationStatus;
  readonly createdByUserId: string;
  readonly spaceId: string | null;
  readonly issuerMembershipId: string | null;
  readonly governancePolicyVersion: string | null;
  readonly expiresAt: string;
  readonly claimedEmail: string | null;
  readonly claimId: string | null;
  readonly redeemedUserId: string | null;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly redeemedAt: string | null;
}

/**
 * Public metadata for an invitation returned in list responses.
 * Contains no token digest or raw token.
 */
export interface InvitationMetadata {
  readonly id: string;
  readonly status: InvitationStatus;
  readonly createdByUserId: string;
  readonly spaceId: string;
  readonly issuerMembershipId: string;
  readonly governancePolicyVersion: string;
  readonly expiresAt: string;
  readonly claimedEmail: string | null;
  readonly redeemedUserId: string | null;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly redeemedAt: string | null;
}

/**
 * Result of creating an invitation.
 * The `inviteUrl` contains the raw bearer token in the fragment;
 * the `invitation` object exposes only the stable identifier and metadata.
 */
export interface CreateInvitationResult {
  readonly invitation: {
    readonly id: string;
    readonly expiresAt: string;
    readonly status: InvitationStatus;
  };
  readonly inviteUrl: string;
}

/**
 * Result of a successful invitation claim.
 * The `claimId` is used for cross-database identity creation recovery.
 */
export interface ClaimInvitationResult {
  readonly claimId: string;
  readonly email: string;
  readonly spaceId: string;
}

/**
 * Input to complete invitation redemption after identity creation.
 */
export interface CompleteInvitationRedemptionInput {
  readonly claimId: string;
  readonly userId: string;
}

/**
 * Result of finalizing an invitation redemption.
 */
export interface CompleteInvitationRedemptionResult {
  readonly invitationId: string;
  readonly userId: string;
  readonly redeemedAt: string;
}
