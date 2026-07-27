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

/** Input to enqueue a new candidate job. */
export interface EnqueueJobInput {
  readonly jobType: string;
  readonly candidateId: string;
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
  readonly status?: ReviewStatus;
  readonly limit?: number;
  readonly offset?: number;
}

/** Options for listing categorization proposals. */
export interface ListProposalsOptions {
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
  /**
   * Intended recipient identifier.
   * Nullable for extensibility — Phase 7 will supply typed recipient/scope.
   */
  readonly recipientId: string | null;
  /**
   * Scope the event applies to.
   * Nullable — Phase 7 will provide typed scope resolution.
   */
  readonly scope: string | null;
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
  readonly correlationId?: string | null;
}

// ---------------------------------------------------------------------------
// Notification Outbox — delivery-tracked outbound record
// ---------------------------------------------------------------------------

/** Lifecycle status of a notification outbox record. */
export type OutboxStatus =
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'suppressed';

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
 * A saved view configuration persisted for Phase 8.
 * Each view belongs to a single actor.
 */
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
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Input to create a new saved view. */
export interface CreateSavedViewInput {
  /** Human-readable name for this view. */
  readonly name: string;
  /** View type identifier. */
  readonly viewType: string;
  /** Scope/filter configuration. */
  readonly scope: Record<string, unknown>;
  /** Optional user-defined sort expression. */
  readonly sort?: string;
  /** Actor who owns this view. */
  readonly actorId: string;
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
  getJobByCandidateId(
    jobType: string,
    candidateId: string,
  ): Promise<CandidateJob | null>;

  // ── Review lifecycle ──────────────────────────────────────────────

  /**
   * Create a new review item in `discovered` status.
   *
   * Idempotent: if an active (non-superseded) item already exists for the
   * same `(budgetId, transactionId, categoryId, classifier)` key, the
   * existing item is returned unchanged.
   */
  createReviewItem(input: CreateReviewItemInput): Promise<ReviewItem>;

  /** Retrieve a single review item by ID, or null. */
  getReviewItem(id: string): Promise<ReviewItem | null>;

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

  /**
   * Transition a single review item to a new status.
   *
   * The transition is validated against the allowed state machine. If the
   * current status equals `toStatus`, the call is idempotent.
   *
   * @throws If the transition is not allowed or the expectedVersion
   *         optimistic lock fails.
   */
  transitionReviewItem(
    id: string,
    input: TransitionReviewInput,
  ): Promise<ReviewItem>;

  /**
   * Bulk-transition multiple review items to the same target status.
   *
   * All items MUST have the same current status (heterogeneous groups are
   * rejected). Each item is transitioned atomically; results report
   * per-item success or failure. Version conflicts are reported per-item
   * without aborting the batch.
   */
  transitionReviewItems(
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

  /**
   * Undo the last reversible transition.
   *
   * Reversible transitions: `approved -> pending_review`,
   * `correcting -> pending_review`. Creates an audit action for the undo.
   *
   * @throws If the current status does not have a reversible transition.
   */
  undoReviewTransition(
    id: string,
    actor: string,
    reason?: string,
    expectedVersion?: number,
  ): Promise<ReviewItem>;

  /** Return all audit actions for a review item, ordered by creation. */
  getReviewActions(reviewItemId: string): Promise<ReviewAction[]>;

  // ── Categorization proposal lifecycle ─────────────────────────────────

  /**
   * Create a new categorization proposal.
   *
   * Idempotent: if a proposal with the same `(budgetId, transactionId, operation,
   * payloadHash)` already exists, the existing record is returned unchanged.
   */
  createProposal(input: CreateProposalInput): Promise<CategorizationProposal>;

  /** Retrieve a single proposal by ID, or null. */
  getProposal(id: string): Promise<CategorizationProposal | null>;

  /**
   * Find the active (non-superseded) proposal for a given target, or null.
   */
  findActiveProposal(
    budgetId: string,
    transactionId: string,
    operation: ProposalOperation,
  ): Promise<CategorizationProposal | null>;

  /**
   * List categorization proposals ordered by creation time descending.
   */
  listProposals(options?: ListProposalsOptions): Promise<CategorizationProposal[]>;

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
  supersedeProposal(id: string): Promise<CategorizationProposal>;

  // ── Proposal approval lifecycle ───────────────────────────────────

  /**
   * Create a one-time approval for a proposal.
   *
   * Validates: proposal exists and is not superseded, payload hash matches
   * proposal, expiry is in the future. Idempotent for same
   * `(proposalId, actorId)`.
   */
  createApproval(input: CreateApprovalInput): Promise<ProposalApproval>;

  /** Retrieve a single approval by ID, or null. */
  getApproval(id: string): Promise<ProposalApproval | null>;

  /**
   * Find all active (non-consumed, non-expired, non-superseded) approvals
   * for a proposal.
   */
  findActiveApprovals(proposalId: string): Promise<ProposalApproval[]>;

  /**
   * Consume an approval (one-time use).
   *
   * @throws If the approval is already consumed, expired, superseded, or
   *         its proposal is superseded.
   */
  consumeApproval(id: string): Promise<ProposalApproval>;

  /**
   * Verify that a proposal has at least one active approval for execution.
   *
   * @returns null if the proposal can be executed, or an error string
   *          describing the reason it cannot.
   */
  verifyApprovalForExecution(
    proposalId: string,
    payloadHash: string,
  ): Promise<string | null>;

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
   */
  completeIdempotencyRecord(
    key: string,
    errorMessage?: string | null,
    isRetryable?: boolean,
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
  queryAuditRecordsByProposal(
    proposalId: string,
    limit?: number,
  ): Promise<AuditRecord[]>;

  // ── Authorization ─────────────────────────────────────────────────

  // ── Correction history ────────────────────────────────────────────────

  /**
   * Query structured correction evidence recorded from approved/corrected
   * review transitions.
   *
   * Corrections are append-only; the original suggestion is never mutated.
   */
  queryCorrectionHistory(
    options?: CorrectionHistoryOptions,
  ): Promise<CorrectionRecord[]>;

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

  /**
   * Create a new invitation for self-hosted account creation.
   * Persists only a SHA-256 digest of the bearer token.
   * Returns the stable metadata plus a copyable invite URL containing
   * the raw token in the fragment.
   *
   * @param creatorUserId The authenticated user creating the invitation.
   * @param auditContext Optional request/correlation IDs for audit records.
   */
  createInvitation(
    creatorUserId: string,
    auditContext?: { requestId?: string; correlationId?: string },
  ): Promise<CreateInvitationResult>;

  /**
   * Revoke an active invitation by its stable ID.
   * Idempotent on already-revoked invitations.
   *
   * @param actorId  The authenticated actor performing the revocation
   *                 (stored in the audit record).  Defaults to 'system'.
   * @param requestId Correlation ID for the request (stored in the audit).
   *
   * @throws If the invitation is not found or is in a non-revocable state.
   */
  revokeInvitation(invitationId: string, actorId?: string, requestId?: string): Promise<void>;

  /**
   * List all invitations ordered by creation time descending.
   * Returns public metadata only — no token digest or raw token.
   */
  listInvitations(): Promise<InvitationMetadata[]>;

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
   * Complete invitation redemption after identity creation.
   * Transitions the invitation from 'claimed' to 'redeemed' and records
   * the created user ID.
   *
   * @throws If the claim ID is not found or the invitation is not in
   *         the 'claimed' state.
   */
  completeInvitationRedemption(claimId: string, userId: string, requestId?: string): Promise<void>;

  /**
   * Find stranded 'claimed' invitations whose redemption was interrupted.
   * Returns a count for reconciliation reporting.
   */
  reconcileClaimedInvitations(): Promise<number>;
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

  /**
   * Cancel all pending (unclaimed) jobs. Returns count cancelled.
   * Processing and completed jobs are left untouched.
   */
  cancelPendingJobs(): Promise<number>;

  /**
   * Delete an actor's membership record. Returns true if a
   * record was found and deleted.
   */
  deleteActorMembership(actorId: string): Promise<boolean>;

  /**
   * Record an export event for export-before-delete tracking.
   * Overwrites any previous export record (only the most recent
   * export is tracked).
   */
  recordExport(input: {
    budgetName: string;
    exportPath: string;
    accountCount: number;
    transactionCount: number;
  }): Promise<void>;

  /**
   * Get the most recent export record, or null if none exists.
   */
  getLastExport(): Promise<{
    exportedAt: string;
    budgetName: string;
    exportPath: string;
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
   * Persist or clear a local override for a rule's inactive state.
   * This is the source of truth for rule toggling since the Actual
   * sync protocol does not support updating rule fields.
   */
  setRuleOverride(ruleId: string, inactive: boolean): Promise<void>;

  /**
   * Return all active rule overrides as a Map<ruleId, inactive>.
   */
  getRuleOverrides(): Promise<Map<string, boolean>>;

  /**
   * Remove a local override for a rule's inactive state.
   * Called after the Actual ledger has been successfully updated or when
   * cleaning up stale local annotations.
   */
  removeRuleOverride(ruleId: string): Promise<void>;

  deleteScopeData(
    scope: string,
    options?: { actorId?: string },
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
  listPolicyVersions(
    policyKey: string,
    limit?: number,
    offset?: number,
  ): Promise<PolicyVersion[]>;

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
  updateSavedFilter(
    id: string,
    input: UpdateSavedFilterInput,
  ): Promise<SavedFilter>;

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

  /**
   * List all saved views for the given actor.
   * Views are scoped per-actor; each actor sees only their own saved views.
   */
  listSavedViews(actorId: string): Promise<SavedViewResult[]>;

  /**
   * Create a new saved view for the given actor.
   *
   * @returns The newly created saved view with a stable ID and timestamp.
   */
  createSavedView(input: CreateSavedViewInput): Promise<SavedViewResult>;
}

// ---------------------------------------------------------------------------
// CategorizationProposal — immutable proposal for a workflow action
// ---------------------------------------------------------------------------

/** Supported categorization proposal operations. */
export type ProposalOperation = 'set_category' | 'create_rule';

/**
 * A categorized proposal for a transaction. Immutable once persisted.
 * The payload hash binds the proposal to exact content — any change
 * produces a distinct hash and thus a distinct proposal.
 */
export interface CategorizationProposal {
  /** Stable unique identifier (UUID v4). */
  readonly id: string;
  /** The operation this proposal represents. */
  readonly operation: ProposalOperation;
  /** Budget this proposal targets. */
  readonly budgetId: string;
  /** The transaction being proposed for change. */
  readonly transactionId: string;
  /** The proposed new category. */
  readonly categoryId: string;
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
}

/** Input to create a new categorization proposal. */
export interface CreateProposalInput {
  readonly operation: ProposalOperation;
  readonly budgetId: string;
  readonly transactionId: string;
  readonly categoryId: string;
  /** Hex-encoded SHA-256 hash of the full proposal content. */
  readonly payloadHash: string;
  readonly policyVersion: string;
  /** JSON-encoded preconditions for execution. */
  readonly preconditions: string;
  /** ISO-8601 expiry timestamp. */
  readonly expiresAt: string;
  readonly actorId: string;
  readonly provenance: string;
  readonly providerModel?: string | null;
  readonly correlationId?: string | null;
}

/** Input to create a new rule proposal. */
export interface CreateRuleProposalInput {
  /** The operation — always 'create_rule' for this input. */
  readonly operation: 'create_rule';
  /** Budget this rule targets. */
  readonly budgetId: string;
  /** The transaction being proposed for change, or null for rule-only proposals. */
  readonly transactionId: string | null;
  /** Rule action configuration (serializable JSON object). */
  readonly action: Record<string, unknown>;
  /** Rule condition / filter configuration (serializable JSON object). */
  readonly conditions: Record<string, unknown>;
  /** Hex-encoded SHA-256 hash of the full proposal content. */
  readonly payloadHash: string;
  readonly policyVersion: string;
  /** JSON-encoded preconditions for execution. */
  readonly preconditions: string;
  /** ISO-8601 expiry timestamp. */
  readonly expiresAt: string;
  readonly actorId: string;
  readonly provenance: string;
  readonly providerModel?: string | null;
  readonly correlationId?: string | null;
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
  /** Current status: 'active', 'consumed', 'expired', or 'superseded'. */
  readonly status: string;
  /** ISO-8601 expiry timestamp. */
  readonly expiresAt: string;
  /** ISO-8601 timestamp when consumed, or null. */
  readonly consumedAt: string | null;
  /** ISO-8601 timestamp when superseded, or null. */
  readonly supersededAt: string | null;
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
}

/** Input to create a new proposal approval. */
export interface CreateApprovalInput {
  readonly proposalId: string;
  /** Must match the proposal's payload hash exactly. */
  readonly payloadHash: string;
  readonly actorId: string;
  /** ISO-8601 expiry timestamp (must be in the future). */
  readonly expiresAt: string;
}

// ---------------------------------------------------------------------------
// IdempotencyRecord — at-most-once execution tracking
// ---------------------------------------------------------------------------
export type IdempotencyStatus = 'in_progress' | 'succeeded' | 'retryable_failed' | 'terminal_failed';

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
 * Structured evidence captured when a review item transitions to
 * `approved` or `correcting`.  Immutable once written.
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
  | { kind: 'authorized_expired' }
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
