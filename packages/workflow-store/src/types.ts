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
   * Rejects replay with different proposalId, operation, or serialisedEffect
   * under the same idempotency key.
   */
  createIdempotencyRecord(input: CreateIdempotencyInput): Promise<IdempotencyRecord>;

  /** Retrieve an idempotency record by key, or null. */
  getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null>;

  /**
   * Mark an idempotency record as completed.
   *
   * @param errorMessage Optional error message if the execution failed.
   */
  completeIdempotencyRecord(
    key: string,
    errorMessage?: string | null,
  ): Promise<IdempotencyRecord>;

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
}

// ---------------------------------------------------------------------------
// CategorizationProposal — immutable proposal for a workflow action
// ---------------------------------------------------------------------------

/** Supported categorization proposal operations. */
export type ProposalOperation = 'set_category';

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

/** Record of an idempotent workflow operation. */
export interface IdempotencyRecord {
  readonly idempotencyKey: string;
  readonly proposalId: string;
  readonly operation: string;
  readonly executedAt: string;
  readonly completed: boolean;
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
