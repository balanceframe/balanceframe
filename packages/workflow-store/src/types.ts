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
}
