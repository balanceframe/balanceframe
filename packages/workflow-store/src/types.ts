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

// ---------------------------------------------------------------------------
// WorkflowStore — public persistence contract
// ---------------------------------------------------------------------------

/**
 * SQLite-backed persistence store for immutable suggestions, idempotent
 * candidate jobs, and failure records.
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
}
