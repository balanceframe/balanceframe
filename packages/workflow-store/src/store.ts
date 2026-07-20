/**
 * SQLite-backed {@link WorkflowStore} implementation.
 *
 * Uses better-sqlite3 synchronously (the idiomatic Node binding) and wraps
 * results in Promises for interface compatibility.
 *
 * Schema determinism:
 * - All IDs are UUID v4 (via `crypto.randomUUID()`).
 * - Timestamps are ISO 8601 UTC strings.
 * - The `payload` field is stored as JSON text.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type {
  Suggestion,
  SaveSuggestionInput,
  CandidateJob,
  JobStatus,
  FailureRecord,
  EnqueueJobInput,
  WorkflowStore,
  ReviewItem,
  ReviewStatus,
  ReviewAction,
  ReviewListOptions,
  TransitionReviewInput,
  CreateReviewItemInput,
  TransitionReviewResult,
  CategorizationProposal,
  ProposalOperation,
  ApprovalStatus,
  ProposalApproval,
  IdempotencyRecord,
  AuditRecord,
  AuditClassification,
  CreateProposalInput,
  CreateApprovalInput,
  CreateIdempotencyInput,
  AppendAuditInput,
  ListProposalsOptions,
  AuthorizationDisposition,
  AuthorizationResult,
  MembershipStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Current UTC time as ISO-8601 string. */
function nowISO(): string {
  return new Date().toISOString();
}

/** Map a raw DB row to a typed Suggestion. */
function rowToSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    budgetId: row.budget_id,
    transactionId: row.transaction_id,
    categoryId: row.category_id,
    classifier: row.classifier,
    promptVersion: row.prompt_version,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    transactionVersion: row.transaction_version,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed CandidateJob. */
function rowToJob(row: JobRow): CandidateJob {
  return {
    id: row.id,
    jobType: row.job_type,
    candidateId: row.candidate_id,
    status: row.status as JobStatus,
    claimToken: row.claim_token,
    claimedAt: row.claimed_at,
    claimExpiresAt: row.claim_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a raw DB row to a typed FailureRecord. */
function rowToFailure(row: FailureRow): FailureRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed ReviewItem. */
function rowToReviewItem(row: ReviewItemRow): ReviewItem {
  return {
    id: row.id,
    suggestionId: row.suggestion_id,
    budgetId: row.budget_id,
    transactionId: row.transaction_id,
    categoryId: row.category_id,
    classifier: row.classifier,
    promptVersion: row.prompt_version,
    transactionVersion: row.transaction_version,
    status: row.status as ReviewStatus,
    correlationId: row.correlation_id,
    assignedReviewerId: row.assigned_reviewer_id,
    approvedBy: JSON.parse(row.approved_by) as string[],
    reviewersRequired: row.reviewers_required,
    priority: row.priority,
    evidence: JSON.parse(row.evidence) as Record<string, unknown>,
    provenance: row.provenance,
    supersededBy: row.superseded_by,
    supersededReason: row.superseded_reason,
    freshnessExpiresAt: row.freshness_expires_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Map a raw DB row to a typed ReviewAction. */
function rowToReviewAction(row: ReviewActionRow): ReviewAction {
  return {
    id: row.id,
    reviewItemId: row.review_item_id,
    fromStatus: row.from_status as ReviewStatus,
    toStatus: row.to_status as ReviewStatus,
    actor: row.actor,
    reason: row.reason,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed CategorizationProposal. */
function rowToProposal(row: ProposalRow): CategorizationProposal {
  return {
    id: row.id,
    operation: row.operation as ProposalOperation,
    budgetId: row.budget_id,
    transactionId: row.transaction_id,
    categoryId: row.category_id,
    payloadHash: row.payload_hash,
    policyVersion: row.policy_version,
    preconditions: row.preconditions,
    expiresAt: row.expires_at,
    actorId: row.actor_id,
    provenance: row.provenance,
    providerModel: row.provider_model,
    correlationId: row.correlation_id,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed ProposalApproval. */
function rowToApproval(row: ApprovalRow): ProposalApproval {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    payloadHash: row.payload_hash,
    actorId: row.actor_id,
    status: row.status as ApprovalStatus,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/** Map a raw DB row to a typed IdempotencyRecord. */
function rowToIdempotency(row: IdempotencyRow): IdempotencyRecord {
  return {
    idempotencyKey: row.idempotency_key,
    proposalId: row.proposal_id,
    operation: row.operation as ProposalOperation,
    executedAt: row.executed_at,
    completed: row.completed !== 0,
    serialisedEffect: row.serialised_effect,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  };
}

/** Map a raw DB row to a typed AuditRecord. */
function rowToAudit(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    classification: row.classification as AuditClassification,
    timestamp: row.timestamp,
    actorId: row.actor_id,
    operation: row.operation as ProposalOperation | null,
    proposalId: row.proposal_id,
    payloadHash: row.payload_hash,
    budgetId: row.budget_id,
    backendIds: row.backend_ids,
    policyVersion: row.policy_version,
    authorizationDisposition: row.authorization_disposition
      ? (JSON.parse(row.authorization_disposition) as AuthorizationDisposition)
      : null,
    idempotencyKey: row.idempotency_key,
    expectedPriorState: row.expected_prior_state,
    observedResultState: row.observed_result_state,
    providerModel: row.provider_model,
    correlationId: row.correlation_id,
    requestId: row.request_id,
    result: row.result,
    isError: row.is_error !== 0,
  };
}

// ---------------------------------------------------------------------------
// Review transition validation
// ---------------------------------------------------------------------------

/** Allowed transitions between review statuses. */
const REVIEW_TRANSITIONS: Record<ReviewStatus, ReviewStatus[]> = {
  discovered: ['suggestion_generated', 'pending_review', 'superseded'],
  suggestion_generated: ['pending_review', 'skipped', 'superseded'],
  pending_review: ['approved', 'rejected', 'skipped', 'superseded'],
  approved: ['correcting', 'pending_review', 'superseded'],
  correcting: ['applied', 'apply_failed', 'pending_review', 'superseded'],
  applied: ['superseded'],
  apply_failed: ['correcting', 'pending_review', 'superseded'],
  rejected: ['superseded'],
  skipped: ['superseded'],
  superseded: [],
};

/** Statuses for which `pending_review` is an undo, not a forward transition. */
const UNDO_SOURCES: ReviewStatus[] = ['approved', 'correcting'];

/** Terminal statuses that cannot transition forward. */
const TERMINAL_STATUSES: ReviewStatus[] = ['applied', 'apply_failed', 'rejected', 'skipped', 'superseded'];

// ---------------------------------------------------------------------------
// Row shapes (internal, matching DB schema)
// ---------------------------------------------------------------------------

interface SuggestionRow {
  id: string;
  budget_id: string;
  transaction_id: string;
  category_id: string;
  classifier: string;
  prompt_version: string;
  payload: string;
  transaction_version: number;
  superseded_at: string | null;
  created_at: string;
}

interface JobRow {
  id: string;
  job_type: string;
  candidate_id: string;
  status: string;
  claim_token: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReviewItemRow {
  id: string;
  suggestion_id: string | null;
  budget_id: string;
  transaction_id: string;
  category_id: string;
  classifier: string;
  prompt_version: string;
  transaction_version: number;
  status: string;
  correlation_id: string | null;
  assigned_reviewer_id: string | null;
  approved_by: string;
  reviewers_required: number;
  priority: number;
  evidence: string;
  provenance: string;
  superseded_by: string | null;
  superseded_reason: string | null;
  freshness_expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ReviewActionRow {
  id: string;
  review_item_id: string;
  from_status: string;
  to_status: string;
  actor: string;
  reason: string | null;
  metadata: string;
  created_at: string;
}

interface FailureRow {
  id: string;
  job_id: string;
  error_code: string;
  error_message: string;
  created_at: string;
}

interface ProposalRow {
  id: string;
  operation: string;
  budget_id: string;
  transaction_id: string;
  category_id: string;
  payload_hash: string;
  policy_version: string;
  preconditions: string;
  expires_at: string;
  actor_id: string;
  provenance: string;
  provider_model: string | null;
  correlation_id: string | null;
  superseded_at: string | null;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  proposal_id: string;
  payload_hash: string;
  actor_id: string;
  status: string;
  expires_at: string;
  consumed_at: string | null;
  superseded_at: string | null;
  created_at: string;
}

interface IdempotencyRow {
  idempotency_key: string;
  proposal_id: string;
  operation: string;
  executed_at: string;
  completed: number;
  serialised_effect: string;
  error_message: string | null;
  updated_at: string;
}

interface AuditRow {
  id: string;
  classification: string;
  timestamp: string;
  actor_id: string;
  operation: string | null;
  proposal_id: string | null;
  payload_hash: string | null;
  budget_id: string | null;
  backend_ids: string;
  policy_version: string | null;
  authorization_disposition: string | null;
  idempotency_key: string | null;
  expected_prior_state: string | null;
  observed_result_state: string | null;
  provider_model: string | null;
  correlation_id: string | null;
  request_id: string | null;
  result: string;
  is_error: number;
}

interface ActorMembershipRow {
  actor_id: string;
  status: string;
  capabilities: string;
  scope: string;
}

// ---------------------------------------------------------------------------
// SqliteWorkflowStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed workflow store.
 *
 * @param filename  Path to the SQLite database file, or `:memory:` for an
 *                  in-memory database (useful in tests).
 */
export class SqliteWorkflowStore implements WorkflowStore {
  private readonly db: DatabaseType;

  /** Prepared statements cached for the lifetime of the store. */
  private readonly stmt = {
    insertSuggestion: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedeMatch: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectActiveSuggestion: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectSuggestion: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectTransactionSuggestions: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedeByVersion: null as unknown as ReturnType<DatabaseType['prepare']>,
    countSuperseded: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectMaxVersion: null as unknown as ReturnType<DatabaseType['prepare']>,
    upsertJob: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectJobByCandidate: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectJobById: null as unknown as ReturnType<DatabaseType['prepare']>,
    claimJobPending: null as unknown as ReturnType<DatabaseType['prepare']>,
    claimJobExpired: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectClaimedJob: null as unknown as ReturnType<DatabaseType['prepare']>,
    completeJob: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertFailure: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectLatestFailure: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectPendingJobs: null as unknown as ReturnType<DatabaseType['prepare']>,
    failJobStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertReviewItem: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReviewItem: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReviewByIssue: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReviewItems: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReviewItemsByStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    listReviewItemsByCorrelation: null as unknown as ReturnType<DatabaseType['prepare']>,
    transitionReviewItemStale: null as unknown as ReturnType<DatabaseType['prepare']>,
    transitionReviewItemUpdate: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedeReviewItem: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertReviewAction: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReviewActions: null as unknown as ReturnType<DatabaseType['prepare']>,
    updateApprovedBy: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReviewItemStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectReviewItemsByIds: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertProposal: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectProposal: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectActiveProposal: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedeProposalStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposals: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposalsActive: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposalsByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposalsByBudgetActive: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposalsSuperseded: null as unknown as ReturnType<DatabaseType['prepare']>,
    listProposalsSupersededByBudget: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertApproval: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectApproval: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectActiveApprovals: null as unknown as ReturnType<DatabaseType['prepare']>,
    consumeApprovalStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    supersedeProposalApprovals: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectProposalStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertIdempotency: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectIdempotency: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectIdempotencyByProposalOp: null as unknown as ReturnType<DatabaseType['prepare']>,
    completeIdempotencyStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertAudit: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectAuditByClassification: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectAuditByProposal: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectAuditCount: null as unknown as ReturnType<DatabaseType['prepare']>,
    upsertActorMembershipStmt: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectActorMembership: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectExpiredApprovals: null as unknown as ReturnType<DatabaseType['prepare']>,
    markExpiredApprovals: null as unknown as ReturnType<DatabaseType['prepare']>,
  };

  constructor(filename: string = ':memory:') {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
    this.prepareStatements();
  }

  /** Release the database connection. */
  close(): void {
    this.db.close();
  }

  // ── Schema initialisation ─────────────────────────────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS suggestions (
        id                  TEXT PRIMARY KEY,
        budget_id           TEXT NOT NULL,
        transaction_id      TEXT NOT NULL,
        category_id         TEXT NOT NULL,
        classifier          TEXT NOT NULL,
        prompt_version      TEXT NOT NULL,
        payload             TEXT NOT NULL,
        transaction_version INTEGER NOT NULL,
        superseded_at       TEXT,
        created_at          TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_active
        ON suggestions(budget_id, transaction_id, classifier, prompt_version)
        WHERE superseded_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_suggestions_transaction
        ON suggestions(transaction_id);

      CREATE TABLE IF NOT EXISTS candidate_jobs (
        id               TEXT PRIMARY KEY,
        job_type         TEXT NOT NULL,
        candidate_id     TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        claim_token      TEXT,
        claimed_at       TEXT,
        claim_expires_at TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE(job_type, candidate_id)
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status
        ON candidate_jobs(status);

      CREATE TABLE IF NOT EXISTS failure_records (
        id            TEXT PRIMARY KEY,
        job_id        TEXT NOT NULL REFERENCES candidate_jobs(id),
        error_code    TEXT NOT NULL,
        error_message TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_failures_job
        ON failure_records(job_id);

      CREATE TABLE IF NOT EXISTS review_items (
        id                   TEXT PRIMARY KEY,
        suggestion_id        TEXT,
        budget_id            TEXT NOT NULL,
        transaction_id       TEXT NOT NULL,
        category_id          TEXT NOT NULL,
        classifier           TEXT NOT NULL,
        prompt_version       TEXT NOT NULL DEFAULT '',
        transaction_version  INTEGER NOT NULL DEFAULT 0,
        status               TEXT NOT NULL DEFAULT 'discovered',
        correlation_id       TEXT,
        assigned_reviewer_id TEXT,
        approved_by          TEXT NOT NULL DEFAULT '[]',
        reviewers_required   INTEGER NOT NULL DEFAULT 1,
        priority             INTEGER NOT NULL DEFAULT 0,
        evidence             TEXT NOT NULL DEFAULT '{}',
        provenance           TEXT NOT NULL,
        superseded_by        TEXT,
        superseded_reason    TEXT,
        freshness_expires_at TEXT,
        version              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_items_status
        ON review_items(status);

      CREATE INDEX IF NOT EXISTS idx_review_items_correlation
        ON review_items(correlation_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_review_items_active_issue
        ON review_items(budget_id, transaction_id, category_id, classifier)
        WHERE status != 'superseded';

      CREATE TABLE IF NOT EXISTS review_actions (
        id               TEXT PRIMARY KEY,
        review_item_id   TEXT NOT NULL REFERENCES review_items(id),
        from_status      TEXT NOT NULL,
        to_status        TEXT NOT NULL,
        actor            TEXT NOT NULL,
        reason           TEXT,
        metadata         TEXT NOT NULL DEFAULT '{}',
        created_at       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_actions_item
        ON review_actions(review_item_id);

      CREATE TABLE IF NOT EXISTS categorization_proposals (
        id               TEXT PRIMARY KEY,
        operation        TEXT NOT NULL,
        budget_id        TEXT NOT NULL,
        transaction_id   TEXT NOT NULL,
        category_id      TEXT NOT NULL,
        payload_hash     TEXT NOT NULL,
        policy_version   TEXT NOT NULL,
        preconditions    TEXT NOT NULL,
        expires_at       TEXT NOT NULL,
        actor_id         TEXT NOT NULL,
        provenance       TEXT NOT NULL,
        provider_model   TEXT,
        correlation_id   TEXT,
        superseded_at    TEXT,
        created_at       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proposals_active_target
        ON categorization_proposals(budget_id, transaction_id, operation)
        WHERE superseded_at IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_payload_unique
        ON categorization_proposals(budget_id, transaction_id, operation, payload_hash);

      CREATE TABLE IF NOT EXISTS proposal_approvals (
        id            TEXT PRIMARY KEY,
        proposal_id   TEXT NOT NULL REFERENCES categorization_proposals(id),
        payload_hash  TEXT NOT NULL,
        actor_id      TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active',
        expires_at    TEXT NOT NULL,
        consumed_at   TEXT,
        superseded_at TEXT,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_proposal
        ON proposal_approvals(proposal_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_active_actor
        ON proposal_approvals(proposal_id, actor_id)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS idempotency_records (
        idempotency_key   TEXT PRIMARY KEY,
        proposal_id       TEXT NOT NULL,
        operation         TEXT NOT NULL,
        executed_at       TEXT NOT NULL,
        completed         INTEGER NOT NULL DEFAULT 0,
        serialised_effect TEXT NOT NULL,
        error_message     TEXT,
        updated_at        TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_records (
        id                       TEXT PRIMARY KEY,
        classification           TEXT NOT NULL,
        timestamp                TEXT NOT NULL,
        actor_id                 TEXT NOT NULL,
        operation                TEXT,
        proposal_id              TEXT,
        payload_hash             TEXT,
        budget_id                TEXT,
        backend_ids              TEXT NOT NULL DEFAULT '[]',
        policy_version           TEXT,
        authorization_disposition TEXT,
        idempotency_key          TEXT,
        expected_prior_state     TEXT,
        observed_result_state    TEXT,
        provider_model           TEXT,
        correlation_id           TEXT,
        request_id               TEXT,
        result                   TEXT NOT NULL,
        is_error                 INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_audit_classification
        ON audit_records(classification);

      CREATE INDEX IF NOT EXISTS idx_audit_proposal
        ON audit_records(proposal_id);

      CREATE TABLE IF NOT EXISTS actor_memberships (
        actor_id     TEXT PRIMARY KEY,
        status       TEXT NOT NULL DEFAULT 'active',
        capabilities TEXT NOT NULL DEFAULT '[]',
        scope        TEXT NOT NULL DEFAULT '*'
      );
    `);
  }

  private prepareStatements(): void {
    // ── Suggestions ────────────────────────────────────────────────────

    this.stmt.insertSuggestion = this.db.prepare(`
      INSERT INTO suggestions (id, budget_id, transaction_id, category_id,
                               classifier, prompt_version, payload,
                               transaction_version, superseded_at, created_at)
      VALUES (@id, @budgetId, @transactionId, @categoryId,
              @classifier, @promptVersion, @payload,
              @transactionVersion, @supersededAt, @createdAt)
    `);

    this.stmt.supersedeMatch = this.db.prepare(`
      UPDATE suggestions
         SET superseded_at = @now
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND classifier = @classifier
         AND prompt_version = @promptVersion
         AND superseded_at IS NULL
    `);

    this.stmt.selectActiveSuggestion = this.db.prepare(`
      SELECT * FROM suggestions
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND classifier = @classifier
         AND prompt_version = @promptVersion
         AND superseded_at IS NULL
       LIMIT 1
    `);

    this.stmt.selectSuggestion = this.db.prepare(`
      SELECT * FROM suggestions WHERE id = ?
    `);

    this.stmt.selectTransactionSuggestions = this.db.prepare(`
      SELECT * FROM suggestions WHERE transaction_id = ? ORDER BY created_at DESC
    `);

    this.stmt.supersedeByVersion = this.db.prepare(`
      UPDATE suggestions
         SET superseded_at = @now
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND superseded_at IS NULL
         AND transaction_version < @newVersion
    `);

    this.stmt.countSuperseded = this.db.prepare(`
      SELECT changes() AS count
    `);

    this.stmt.selectMaxVersion = this.db.prepare(`
      SELECT MAX(transaction_version) AS max_version FROM suggestions
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND classifier = @classifier
         AND prompt_version = @promptVersion
    `);

    // ── Jobs ───────────────────────────────────────────────────────────

    this.stmt.upsertJob = this.db.prepare(`
      INSERT INTO candidate_jobs (id, job_type, candidate_id, status,
                                  claim_token, claimed_at,
                                  claim_expires_at, created_at, updated_at)
      VALUES (@id, @jobType, @candidateId, 'pending',
              NULL, NULL, NULL, @now, @now)
      ON CONFLICT(job_type, candidate_id) DO NOTHING
      RETURNING *
    `);

    this.stmt.selectJobByCandidate = this.db.prepare(`
      SELECT * FROM candidate_jobs
       WHERE job_type = @jobType AND candidate_id = @candidateId
    `);

    this.stmt.selectJobById = this.db.prepare(`
      SELECT * FROM candidate_jobs WHERE id = ?
    `);

    this.stmt.claimJobPending = this.db.prepare(`
      UPDATE candidate_jobs
         SET status = 'processing',
             claim_token = @claimToken,
             claimed_at = @now,
             claim_expires_at = @expiresAt,
             updated_at = @now
       WHERE id = @jobId
         AND status = 'pending'
    `);

    this.stmt.claimJobExpired = this.db.prepare(`
      UPDATE candidate_jobs
         SET status = 'processing',
             claim_token = @claimToken,
             claimed_at = @now,
             claim_expires_at = @expiresAt,
             updated_at = @now
       WHERE id = @jobId
         AND status = 'processing'
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at < @now
    `);

    this.stmt.selectClaimedJob = this.db.prepare(`
      SELECT * FROM candidate_jobs WHERE id = @jobId AND claim_token = @claimToken
    `);

    this.stmt.completeJob = this.db.prepare(`
      UPDATE candidate_jobs
         SET status = 'completed',
             updated_at = @now
       WHERE id = @jobId
         AND status = 'processing'
         AND claim_token = @claimToken
    `);

    this.stmt.insertFailure = this.db.prepare(`
      INSERT INTO failure_records (id, job_id, error_code, error_message, created_at)
      VALUES (@id, @jobId, @errorCode, @errorMessage, @createdAt)
    `);

    this.stmt.selectLatestFailure = this.db.prepare(`
      SELECT * FROM failure_records
       WHERE job_id = ?
       ORDER BY created_at DESC
       LIMIT 1
    `);

    this.stmt.failJobStatus = this.db.prepare(`
      UPDATE candidate_jobs
         SET status = 'failed',
             updated_at = @now
       WHERE id = @jobId
         AND status = 'processing'
         AND claim_token = @claimToken
    `);

    this.stmt.selectPendingJobs = this.db.prepare(`
      SELECT * FROM candidate_jobs
       WHERE status = 'pending'
       ORDER BY created_at ASC
    `);

    // ── Review items ───────────────────────────────────────────────────

    this.stmt.insertReviewItem = this.db.prepare(`
      INSERT INTO review_items (id, suggestion_id, budget_id, transaction_id,
                                category_id, classifier, prompt_version,
                                transaction_version, status, correlation_id,
                                assigned_reviewer_id, approved_by,
                                reviewers_required, priority, evidence,
                                provenance, superseded_by, superseded_reason,
                                freshness_expires_at, version, created_at,
                                updated_at)
      VALUES (@id, @suggestionId, @budgetId, @transactionId,
              @categoryId, @classifier, @promptVersion,
              @transactionVersion, @status, @correlationId,
              @assignedReviewerId, @approvedBy,
              @reviewersRequired, @priority, @evidence,
              @provenance, @supersededBy, @supersededReason,
              @freshnessExpiresAt, @version, @createdAt,
              @updatedAt)
      ON CONFLICT(budget_id, transaction_id, category_id, classifier)
        WHERE status != 'superseded'
        DO NOTHING
      RETURNING *
    `);

    this.stmt.selectReviewItem = this.db.prepare(`
      SELECT * FROM review_items WHERE id = ?
    `);

    this.stmt.selectReviewByIssue = this.db.prepare(`
      SELECT * FROM review_items
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND category_id = @categoryId
         AND classifier = @classifier
         AND status != 'superseded'
       LIMIT 1
    `);

    this.stmt.listReviewItems = this.db.prepare(`
      SELECT * FROM review_items
       WHERE 1=1
       ORDER BY
         CASE WHEN status IN ('applied', 'apply_failed', 'rejected', 'skipped', 'superseded') THEN 1 ELSE 0 END ASC,
         priority DESC,
         created_at ASC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listReviewItemsByStatus = this.db.prepare(`
      SELECT * FROM review_items
       WHERE status = @status
       ORDER BY priority DESC, created_at ASC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.listReviewItemsByCorrelation = this.db.prepare(`
      SELECT * FROM review_items
       WHERE correlation_id = @correlationId
       ORDER BY created_at ASC
    `);

    this.stmt.transitionReviewItemUpdate = this.db.prepare(`
      UPDATE review_items
         SET status = @toStatus,
             superseded_reason = @reason,
             superseded_by = CASE WHEN @toStatus = 'superseded' THEN @supersededBy ELSE superseded_by END,
             approved_by = CASE WHEN @toStatus = 'approved' THEN @approvedBy ELSE approved_by END,
             updated_at = @now,
             version = version + 1
       WHERE id = @id
         AND status = @fromStatus
         AND version = @expectedVersion
    `);

    this.stmt.supersedeReviewItem = this.db.prepare(`
      UPDATE review_items
         SET status = 'superseded',
             superseded_by = @supersededBy,
             superseded_reason = @reason,
             updated_at = @now,
             version = version + 1
       WHERE id = @id
         AND status = @oldStatus
         AND version = @oldVersion
    `);

    this.stmt.updateApprovedBy = this.db.prepare(`
      UPDATE review_items
         SET approved_by = @approvedBy,
             updated_at = @now,
             version = CASE WHEN @isNew THEN version + 1 ELSE version END
       WHERE id = @id
         AND version = @expectedVersion
    `);

    this.stmt.insertReviewAction = this.db.prepare(`
      INSERT INTO review_actions (id, review_item_id, from_status, to_status,
                                  actor, reason, metadata, created_at)
      VALUES (@id, @reviewItemId, @fromStatus, @toStatus,
              @actor, @reason, @metadata, @createdAt)
    `);

    this.stmt.selectReviewActions = this.db.prepare(`
      SELECT * FROM review_actions
       WHERE review_item_id = ?
       ORDER BY created_at ASC
    `);

    this.stmt.selectReviewItemStatus = this.db.prepare(`
      SELECT id, status, version, approved_by FROM review_items WHERE id = ?
    `);

    this.stmt.selectReviewItemsByIds = this.db.prepare(`
      SELECT id, status, version, approved_by FROM review_items WHERE id = ?
    `);

    // ── Proposals ──────────────────────────────────────────────────────

    this.stmt.insertProposal = this.db.prepare(`
      INSERT INTO categorization_proposals (id, operation, budget_id, transaction_id,
                                            category_id, payload_hash, policy_version,
                                            preconditions, expires_at, actor_id,
                                            provenance, provider_model, correlation_id,
                                            superseded_at, created_at)
      VALUES (@id, @operation, @budgetId, @transactionId,
              @categoryId, @payloadHash, @policyVersion,
              @preconditions, @expiresAt, @actorId,
              @provenance, @providerModel, @correlationId,
              @supersededAt, @createdAt)
      ON CONFLICT(budget_id, transaction_id, operation, payload_hash)
        DO NOTHING
      RETURNING *
    `);

    this.stmt.selectProposal = this.db.prepare(`
      SELECT * FROM categorization_proposals WHERE id = ?
    `);

    this.stmt.selectActiveProposal = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE budget_id = @budgetId
         AND transaction_id = @transactionId
         AND operation = @operation
         AND superseded_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
    `);

    this.stmt.supersedeProposalStmt = this.db.prepare(`
      UPDATE categorization_proposals
         SET superseded_at = @now
       WHERE id = @id
    `);

    // ── Approvals ─────────────────────────────────────────────────────

    this.stmt.insertApproval = this.db.prepare(`
      INSERT INTO proposal_approvals (id, proposal_id, payload_hash, actor_id,
                                      status, expires_at, consumed_at,
                                      superseded_at, created_at)
      VALUES (@id, @proposalId, @payloadHash, @actorId,
              'active', @expiresAt, NULL,
              NULL, @createdAt)
      ON CONFLICT(proposal_id, actor_id)
        WHERE status = 'active'
        DO NOTHING
      RETURNING *
    `);

    this.stmt.selectApproval = this.db.prepare(`
      SELECT * FROM proposal_approvals WHERE id = ?
    `);

    this.stmt.selectActiveApprovals = this.db.prepare(`
      SELECT * FROM proposal_approvals
       WHERE proposal_id = @proposalId
         AND status = 'active'
         AND expires_at > @now
         AND consumed_at IS NULL
         AND superseded_at IS NULL
       ORDER BY created_at ASC
    `);

    this.stmt.consumeApprovalStmt = this.db.prepare(`
      UPDATE proposal_approvals
         SET status = 'consumed',
             consumed_at = @now
       WHERE id = @id
         AND status = 'active'
         AND consumed_at IS NULL
         AND expires_at > @now
    `);

    this.stmt.supersedeProposalApprovals = this.db.prepare(`
      UPDATE proposal_approvals
         SET status = 'superseded',
             superseded_at = @now
       WHERE proposal_id = @proposalId
         AND status = 'active'
    `);

    this.stmt.selectProposalStatus = this.db.prepare(`
      SELECT superseded_at FROM categorization_proposals WHERE id = ?
    `);

    this.stmt.listProposals = this.db.prepare(`
      SELECT * FROM categorization_proposals
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsActive = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE superseded_at IS NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsByBudget = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE budget_id = @budgetId
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsByBudgetActive = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE budget_id = @budgetId
         AND superseded_at IS NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsSuperseded = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE superseded_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.listProposalsSupersededByBudget = this.db.prepare(`
      SELECT * FROM categorization_proposals
       WHERE budget_id = @budgetId
         AND superseded_at IS NOT NULL
      ORDER BY created_at DESC
      LIMIT @limit OFFSET @offset
    `);

    this.stmt.markExpiredApprovals = this.db.prepare(`
      UPDATE proposal_approvals
         SET status = 'expired'
       WHERE status = 'active'
         AND expires_at <= @now
    `);

    this.stmt.selectExpiredApprovals = this.db.prepare(`
      SELECT id FROM proposal_approvals
       WHERE status = 'active'
         AND expires_at <= @now
    `);

    // ── Idempotency ───────────────────────────────────────────────────

    this.stmt.insertIdempotency = this.db.prepare(`
      INSERT INTO idempotency_records (idempotency_key, proposal_id, operation,
                                       executed_at, completed, serialised_effect,
                                       error_message, updated_at)
      VALUES (@idempotencyKey, @proposalId, @operation,
              @executedAt, 0, @serialisedEffect,
              NULL, @updatedAt)
    `);

    this.stmt.selectIdempotency = this.db.prepare(`
      SELECT * FROM idempotency_records WHERE idempotency_key = ?
    `);

    this.stmt.selectIdempotencyByProposalOp = this.db.prepare(`
      SELECT * FROM idempotency_records WHERE proposal_id = @proposalId AND operation = @operation
    `);

    this.stmt.completeIdempotencyStmt = this.db.prepare(`
      UPDATE idempotency_records
         SET completed = 1,
             error_message = @errorMessage,
             updated_at = @now
       WHERE idempotency_key = @key
    `);

    // ── Audit ─────────────────────────────────────────────────────────

    this.stmt.insertAudit = this.db.prepare(`
      INSERT INTO audit_records (id, classification, timestamp, actor_id,
                                 operation, proposal_id, payload_hash,
                                 budget_id, backend_ids, policy_version,
                                 authorization_disposition, idempotency_key,
                                 expected_prior_state, observed_result_state,
                                 provider_model, correlation_id, request_id,
                                 result, is_error)
      VALUES (@id, @classification, @timestamp, @actorId,
              @operation, @proposalId, @payloadHash,
              @budgetId, @backendIds, @policyVersion,
              @authorizationDisposition, @idempotencyKey,
              @expectedPriorState, @observedResultState,
              @providerModel, @correlationId, @requestId,
              @result, @isError)
    `);

    this.stmt.selectAuditByClassification = this.db.prepare(`
      SELECT * FROM audit_records
       WHERE (@classification IS NULL OR classification = @classification)
       ORDER BY timestamp DESC
       LIMIT @limit OFFSET @offset
    `);

    this.stmt.selectAuditByProposal = this.db.prepare(`
      SELECT * FROM audit_records
       WHERE proposal_id = @proposalId
       ORDER BY timestamp DESC
       LIMIT @limit
    `);

    this.stmt.selectAuditCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM audit_records
    `);

    // ── Actor memberships ──────────────────────────────────────────────

    this.stmt.upsertActorMembershipStmt = this.db.prepare(`
      INSERT INTO actor_memberships (actor_id, status, capabilities, scope)
      VALUES (@actorId, @status, @capabilities, @scope)
      ON CONFLICT(actor_id) DO UPDATE SET
        status = @status,
        capabilities = @capabilities,
        scope = @scope
    `);

    this.stmt.selectActorMembership = this.db.prepare(`
      SELECT * FROM actor_memberships WHERE actor_id = ?
    `);
  }



  // ── Suggestion lifecycle ───────────────────────────────────────────

  async saveSuggestion(input: SaveSuggestionInput): Promise<Suggestion> {
    const id = randomUUID();
    const now = nowISO();
    const payloadJson = JSON.stringify(input.payload);

    const txn = this.db.transaction(() => {
      // ── Stale-version detection ────────────────────────────────────
      // If a suggestion already exists (active or superseded) with a
      // higher transactionVersion for the same composite key, the
      // incoming suggestion is stale — save it but immediately supersede
      // so it never becomes the active suggestion (audit trail preserved).
      const versionRow = this.stmt.selectMaxVersion.get({
        budgetId: input.budgetId,
        transactionId: input.transactionId,
        classifier: input.classifier,
        promptVersion: input.promptVersion,
      }) as { max_version: number | null } | undefined;

      const maxVersion = versionRow?.max_version ?? null;

      if (maxVersion !== null && maxVersion > input.transactionVersion) {
        // Stale incoming suggestion — save with supersededAt = now so
        // it is immediately inactive. The higher-version suggestion
        // remains the active one.
        this.stmt.insertSuggestion.run({
          id,
          budgetId: input.budgetId,
          transactionId: input.transactionId,
          categoryId: input.categoryId,
          classifier: input.classifier,
          promptVersion: input.promptVersion,
          payload: payloadJson,
          transactionVersion: input.transactionVersion,
          supersededAt: now,
          createdAt: now,
        });
        return;
      }

      // Fresh (or first) suggestion — supersede any existing active
      // suggestion for the same composite key, then insert as active.
      this.stmt.supersedeMatch.run({
        now,
        budgetId: input.budgetId,
        transactionId: input.transactionId,
        classifier: input.classifier,
        promptVersion: input.promptVersion,
      });

      this.stmt.insertSuggestion.run({
        id,
        budgetId: input.budgetId,
        transactionId: input.transactionId,
        categoryId: input.categoryId,
        classifier: input.classifier,
        promptVersion: input.promptVersion,
        payload: payloadJson,
        transactionVersion: input.transactionVersion,
        supersededAt: null,
        createdAt: now,
      });
    });

    txn();

    const row = this.stmt.selectSuggestion.get(id) as SuggestionRow | undefined;
    if (!row) throw new Error('Failed to read back saved suggestion');
    return rowToSuggestion(row);
  }

  async getActiveSuggestion(
    budgetId: string,
    transactionId: string,
    classifier: string,
    promptVersion: string,
  ): Promise<Suggestion | null> {
    const row = this.stmt.selectActiveSuggestion.get({
      budgetId, transactionId, classifier, promptVersion,
    }) as SuggestionRow | undefined;
    return row ? rowToSuggestion(row) : null;
  }

  async getSuggestion(id: string): Promise<Suggestion | null> {
    const row = this.stmt.selectSuggestion.get(id) as SuggestionRow | undefined;
    return row ? rowToSuggestion(row) : null;
  }

  async getTransactionSuggestions(transactionId: string): Promise<Suggestion[]> {
    const rows = this.stmt.selectTransactionSuggestions.all(transactionId) as SuggestionRow[];
    return rows.map(rowToSuggestion);
  }

  async supersedeSuggestions(
    budgetId: string,
    transactionId: string,
    newTransactionVersion: number,
  ): Promise<number> {
    const now = nowISO();
    const result = this.stmt.supersedeByVersion.run({
      now,
      budgetId,
      transactionId,
      newVersion: newTransactionVersion,
    });
    return result.changes;
  }

  // ── Job lifecycle ─────────────────────────────────────────────────

  async enqueueJob(input: EnqueueJobInput): Promise<CandidateJob> {
    const id = randomUUID();
    const now = nowISO();

    // ON CONFLICT DO NOTHING RETURNING * returns undefined on duplicate
    const row = this.stmt.upsertJob.get({
      id,
      jobType: input.jobType,
      candidateId: input.candidateId,
      now,
    }) as JobRow | undefined;

    if (!row) {
      // Row already existed — fetch the existing record unchanged
      // (no updated_at modification, true no-op).
      const existing = this.stmt.selectJobByCandidate.get({
        jobType: input.jobType, candidateId: input.candidateId,
      }) as JobRow | undefined;
      if (!existing) throw new Error('Failed to enqueue or retrieve job');
      return rowToJob(existing);
    }

    return rowToJob(row);
  }

  async claimJob(
    jobId: string,
    claimToken: string,
    claimTimeoutMs: number = 60_000,
  ): Promise<CandidateJob | null> {
    const now = nowISO();
    const expiresAt = new Date(Date.now() + claimTimeoutMs).toISOString();

    // 1. Try to claim a pending job
    const pendingResult = this.stmt.claimJobPending.run({
      jobId,
      claimToken,
      now,
      expiresAt,
    });

    if (pendingResult.changes > 0) {
      const row = this.stmt.selectJobById.get(jobId) as JobRow | undefined;
      return row ? rowToJob(row) : null;
    }

    // 2. Try to claim an expired processing job (crash recovery)
    const expiredResult = this.stmt.claimJobExpired.run({
      jobId,
      claimToken,
      now,
      expiresAt,
    });

    if (expiredResult.changes > 0) {
      const row = this.stmt.selectJobById.get(jobId) as JobRow | undefined;
      return row ? rowToJob(row) : null;
    }

    // 3. Idempotent retry: if already claimed with this token, return it
    const claimedRow = this.stmt.selectClaimedJob.get({ jobId, claimToken }) as JobRow | undefined;
    if (claimedRow) {
      return rowToJob(claimedRow);
    }

    return null;
  }

  async completeJob(jobId: string, claimToken: string): Promise<void> {
    const now = nowISO();
    this.stmt.completeJob.run({ jobId, claimToken, now });
  }

  async failJob(
    jobId: string,
    claimToken: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<FailureRecord> {
    const now = nowISO();
    const failureId = randomUUID();

    // Transaction: update status AND insert failure record atomically.
    // The failure record is only inserted when the state transition
    // succeeds (job was 'processing' with matching claim_token).
    const txn = this.db.transaction(() => {
      const result = this.stmt.failJobStatus.run({ jobId, claimToken, now });

      if (result.changes === 0) {
        // State transition did not happen. This could mean the job is
        // already terminal or the claim token doesn't match.
        // We'll handle idempotency / errors after the transaction.
        return;
      }

      // Transition succeeded — insert failure record
      this.stmt.insertFailure.run({
        id: failureId,
        jobId,
        errorCode,
        errorMessage,
        createdAt: now,
      });
    });

    txn();

    // Determine outcome based on current job state
    const job = this.stmt.selectJobById.get(jobId) as JobRow | undefined;
    if (!job) throw new Error(`Job ${jobId} not found`);

    // Idempotent retry or successful transition: return latest failure record
    if (job.status === 'failed') {
      const failureRow = this.stmt.selectLatestFailure.get(jobId) as FailureRow | undefined;
      if (failureRow) return rowToFailure(failureRow);
      // No failure record found — fall through to error
    }

    // Stale/expired worker: claim token doesn't match the current processing job
    if (job.status === 'processing' && job.claim_token !== claimToken) {
      throw new Error(
        `Cannot fail job ${jobId}: claim token mismatch (current token: ${job.claim_token})`,
      );
    }

    // Job is 'pending' (never claimed) or 'completed' (no failure record) —
    // the transition was rejected because the job wasn't in 'processing'
    // with the matching claim token.
    throw new Error(
      `Cannot fail job ${jobId}: status is '${job.status}', must be 'processing' with matching claim token`,
    );
  }

  // ── Queries ───────────────────────────────────────────────────────

  async getPendingJobs(): Promise<CandidateJob[]> {
    const rows = this.stmt.selectPendingJobs.all({}) as JobRow[];
    return rows.map(rowToJob);
  }

  async getJobByCandidateId(
    jobType: string,
    candidateId: string,
  ): Promise<CandidateJob | null> {
    const row = this.stmt.selectJobByCandidate.get({ jobType, candidateId }) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  // ── Review lifecycle ──────────────────────────────────────────────

  async createReviewItem(input: CreateReviewItemInput): Promise<ReviewItem> {
    const id = randomUUID();
    const now = nowISO();
    const inputVersion = input.transactionVersion ?? 1;

    // Check for existing active item for the same issue key
    const existingActive = this.stmt.selectReviewByIssue.get({
      budgetId: input.budgetId,
      transactionId: input.transactionId,
      categoryId: input.categoryId,
      classifier: input.classifier,
    }) as ReviewItemRow | undefined;

    if (existingActive) {
      if (inputVersion <= existingActive.transaction_version) {
        // Not newer — return existing (idempotent)
        return rowToReviewItem(existingActive);
      }

      // Newer transactionVersion — supersede old item, create new one
      const actionId = randomUUID();

      const txn = this.db.transaction(() => {
        // Supersede the old active item
        this.stmt.supersedeReviewItem.run({
          id: existingActive.id,
          oldStatus: existingActive.status,
          oldVersion: existingActive.version,
          supersededBy: id,
          reason: `Superseded by newer classification (transactionVersion ${inputVersion})`,
          now,
        });

        // Record audit action for the supersession
        this.stmt.insertReviewAction.run({
          id: actionId,
          reviewItemId: existingActive.id,
          fromStatus: existingActive.status,
          toStatus: 'superseded',
          actor: 'system',
          reason: `Superseded by newer snapshot (version ${inputVersion})`,
          metadata: JSON.stringify({ newItemId: id }),
          createdAt: now,
        });

        // Create the new item
        this.stmt.insertReviewItem.run({
          id,
          suggestionId: input.suggestionId ?? null,
          budgetId: input.budgetId,
          transactionId: input.transactionId,
          categoryId: input.categoryId,
          classifier: input.classifier,
          promptVersion: input.promptVersion ?? '',
          transactionVersion: inputVersion,
          status: 'discovered',
          correlationId: input.correlationId ?? null,
          assignedReviewerId: input.assignedReviewerId ?? null,
          approvedBy: '[]',
          reviewersRequired: input.reviewersRequired ?? 1,
          priority: input.priority ?? 0,
          evidence: JSON.stringify(input.evidence ?? {}),
          provenance: input.provenance,
          supersededBy: null,
          supersededReason: null,
          freshnessExpiresAt: input.freshnessExpiresAt ?? null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      });

      txn();

      const newRow = this.stmt.selectReviewItem.get(id) as ReviewItemRow | undefined;
      if (!newRow) throw new Error('Failed to read back created review item');
      return rowToReviewItem(newRow);
    }

    // No existing active item — insert normally (idempotent via unique partial index)
    const row = this.stmt.insertReviewItem.get({
      id,
      suggestionId: input.suggestionId ?? null,
      budgetId: input.budgetId,
      transactionId: input.transactionId,
      categoryId: input.categoryId,
      classifier: input.classifier,
      promptVersion: input.promptVersion ?? '',
      transactionVersion: inputVersion,
      status: 'discovered',
      correlationId: input.correlationId ?? null,
      assignedReviewerId: input.assignedReviewerId ?? null,
      approvedBy: '[]',
      reviewersRequired: input.reviewersRequired ?? 1,
      priority: input.priority ?? 0,
      evidence: JSON.stringify(input.evidence ?? {}),
      provenance: input.provenance,
      supersededBy: null,
      supersededReason: null,
      freshnessExpiresAt: input.freshnessExpiresAt ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    }) as ReviewItemRow | undefined;

    if (!row) {
      // Rare race: another connection created it; fetch existing
      const existing = this.stmt.selectReviewByIssue.get({
        budgetId: input.budgetId,
        transactionId: input.transactionId,
        categoryId: input.categoryId,
        classifier: input.classifier,
      }) as ReviewItemRow | undefined;
      if (!existing) throw new Error('Failed to create or retrieve review item');
      return rowToReviewItem(existing);
    }

    return rowToReviewItem(row);
  }

  async getReviewItem(id: string): Promise<ReviewItem | null> {
    const row = this.stmt.selectReviewItem.get(id) as ReviewItemRow | undefined;
    return row ? rowToReviewItem(row) : null;
  }

  async findReviewByIssue(
    budgetId: string,
    transactionId: string,
    categoryId: string,
    classifier: string,
  ): Promise<ReviewItem | null> {
    const row = this.stmt.selectReviewByIssue.get({
      budgetId, transactionId, categoryId, classifier,
    }) as ReviewItemRow | undefined;
    return row ? rowToReviewItem(row) : null;
  }

  async listReviewItems(options?: ReviewListOptions): Promise<ReviewItem[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    let rows: ReviewItemRow[];
    if (options?.status) {
      rows = this.stmt.listReviewItemsByStatus.all({
        status: options.status,
        limit,
        offset,
      }) as ReviewItemRow[];
    } else {
      rows = this.stmt.listReviewItems.all({ limit, offset }) as ReviewItemRow[];
    }
    return rows.map(rowToReviewItem);
  }

  async listReviewItemsByCorrelation(correlationId: string): Promise<ReviewItem[]> {
    const rows = this.stmt.listReviewItemsByCorrelation.all({ correlationId }) as ReviewItemRow[];
    return rows.map(rowToReviewItem);
  }

  async transitionReviewItem(
    id: string,
    input: TransitionReviewInput,
  ): Promise<ReviewItem> {
    const now = nowISO();
    const current = this.stmt.selectReviewItemStatus.get(id) as { id: string; status: string; version: number; approved_by: string } | undefined;
    if (!current) throw new Error(`Review item ${id} not found`);

    const fromStatus = current.status as ReviewStatus;
    const toStatus = input.toStatus;

    // Idempotent: already at target status
    if (fromStatus === toStatus) {
      const full = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
      return rowToReviewItem(full);
    }

    // Validate transition
    if (fromStatus === 'superseded') {
      throw new Error(`Cannot transition from superseded status`);
    }
    const allowed = REVIEW_TRANSITIONS[fromStatus];
    if (!allowed.includes(toStatus)) {
      throw new Error(
        `Cannot transition review item ${id} from '${fromStatus}' to '${toStatus}'`,
      );
    }

    // Track approvedBy for final approval persistence
    let approvedByArr: string[] | null = null;

    // Special handling for approval
    if (toStatus === 'approved') {
      approvedByArr = JSON.parse(current.approved_by) as string[];
      if (approvedByArr.includes(input.actor)) {
        // Same actor approving again — idempotent, return current item
        const full = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
        return rowToReviewItem(full);
      }
      approvedByArr.push(input.actor);

      // Need the full item to check reviewersRequired
      const fullRow = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
      const needed = fullRow.reviewers_required;

      if (approvedByArr.length < needed) {
        // Not enough reviewers yet — just record the approval, stay in current status
        const updatedBy = JSON.stringify(approvedByArr);

        // Atomic: update approvedBy AND insert audit action in one transaction
        const partialTxn = this.db.transaction(() => {
          const result = this.stmt.updateApprovedBy.run({
            id,
            approvedBy: updatedBy,
            now,
            expectedVersion: input.expectedVersion,
            isNew: 1, // increment version since we added a reviewer
          });

          if (result.changes === 0) {
            throw new Error(`Version conflict on review item ${id}: expected ${input.expectedVersion}`);
          }

          // Record action for the approval step (even though status didn't change)
          this.stmt.insertReviewAction.run({
            id: randomUUID(),
            reviewItemId: id,
            fromStatus: fromStatus,
            toStatus: fromStatus, // stayed same
            actor: input.actor,
            reason: input.reason ?? `Approved by ${input.actor} (${approvedByArr!.length}/${needed} reviewers)`,
            metadata: JSON.stringify(input.metadata ?? {}),
            createdAt: now,
          });
        });

        partialTxn();

        const updated = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
        return rowToReviewItem(updated);
      }
      // Else: enough reviewers — fall through to the full transition below
    }

    // Perform the transition atomically (status change + audit + optional field updates)
    const actionId = randomUUID();
    const approvedByJson = approvedByArr ? JSON.stringify(approvedByArr) : null;

    const txn = this.db.transaction(() => {
      const result = this.stmt.transitionReviewItemUpdate.run({
        id,
        fromStatus,
        toStatus,
        expectedVersion: input.expectedVersion,
        reason: toStatus === 'superseded' ? (input.reason ?? null) : null,
        supersededBy: input.supersededBy ?? null,
        approvedBy: approvedByJson,
        now,
      });

      if (result.changes === 0) {
        // Version conflict or state changed
        throw new Error(
          `Version conflict on review item ${id}: expected ${input.expectedVersion}, ` +
          `current version may have changed`,
        );
      }

      this.stmt.insertReviewAction.run({
        id: actionId,
        reviewItemId: id,
        fromStatus,
        toStatus,
        actor: input.actor,
        reason: input.reason ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
        createdAt: now,
      });
    });

    txn();

    const updated = this.stmt.selectReviewItem.get(id) as ReviewItemRow;
    return rowToReviewItem(updated);
  }

  async transitionReviewItems(
    ids: string[],
    toStatus: ReviewStatus,
    actor: string,
    reason?: string,
  ): Promise<TransitionReviewResult[]> {
    if (ids.length === 0) return [];

    // Read current statuses for all items, tracking found/missing per index
    const items: ({ id: string; status: ReviewStatus; version: number } | null)[] = ids.map(id => {
      const row = this.stmt.selectReviewItemsByIds.get(id) as { id: string; status: string; version: number } | undefined;
      return row ? { id: row.id, status: row.status as ReviewStatus, version: row.version } : null;
    });

    // Collect only found items for validation
    const foundItems = items.filter((x): x is NonNullable<typeof x> => x !== null);

    if (foundItems.length === 0) {
      // All IDs are missing
      return ids.map(id => ({
        itemId: id,
        success: false,
        item: null,
        error: 'Not found',
      }));
    }

    // Heterogeneous group check: all found items must share the same current status
    const firstStatus = foundItems[0].status;
    if (!foundItems.every(i => i.status === firstStatus)) {
      throw new Error(
        `Heterogeneous group: all items must have the same current status ` +
        `(found items with statuses: ${[...new Set(foundItems.map(i => i.status))].join(', ')})`,
      );
    }

    // Validate the transition for this status group
    const allowed = REVIEW_TRANSITIONS[firstStatus];
    if (!allowed.includes(toStatus)) {
      throw new Error(
        `Cannot transition from '${firstStatus}' to '${toStatus}'`,
      );
    }

    // Transition each item atomically, collecting per-item results
    // (one result per requested ID, including missing IDs)
    const results: TransitionReviewResult[] = [];

    for (let i = 0; i < ids.length; i++) {
      const item = items[i];
      if (!item) {
        results.push({
          itemId: ids[i],
          success: false,
          item: null,
          error: 'Not found',
        });
        continue;
      }

      try {
        const transitioned = await this.transitionReviewItem(item.id, {
          toStatus,
          actor,
          reason,
          expectedVersion: item.version,
        });
        results.push({
          itemId: item.id,
          success: true,
          item: transitioned,
          error: null,
        });
      } catch (err) {
        results.push({
          itemId: item.id,
          success: false,
          item: null,
          error: (err as Error).message,
        });
      }
    }

    return results;
  }

  async undoReviewTransition(
    id: string,
    actor: string,
    reason?: string,
    expectedVersion?: number,
  ): Promise<ReviewItem> {
    const current = this.stmt.selectReviewItemStatus.get(id) as { id: string; status: string; version: number } | undefined;
    if (!current) throw new Error(`Review item ${id} not found`);

    const fromStatus = current.status as ReviewStatus;

    // Only approved -> pending_review and correcting -> pending_review are reversible
    if (!UNDO_SOURCES.includes(fromStatus)) {
      throw new Error(
        `Cannot undo from '${fromStatus}': only ${UNDO_SOURCES.join(', ')} support undo`,
      );
    }

    const version = expectedVersion ?? current.version;

    return this.transitionReviewItem(id, {
      toStatus: 'pending_review',
      actor,
      reason: reason ?? `Undo from '${fromStatus}'`,
      metadata: { undo: true, previousStatus: fromStatus },
      expectedVersion: version,
    });
  }

  async getReviewActions(reviewItemId: string): Promise<ReviewAction[]> {
    const rows = this.stmt.selectReviewActions.all(reviewItemId) as ReviewActionRow[];
    return rows.map(rowToReviewAction);
  }

  // ── Categorization proposal lifecycle ─────────────────────────────

  async createProposal(input: CreateProposalInput): Promise<CategorizationProposal> {
    const id = randomUUID();
    const now = nowISO();

    const row = this.stmt.insertProposal.get({
      id,
      operation: input.operation,
      budgetId: input.budgetId,
      transactionId: input.transactionId,
      categoryId: input.categoryId,
      payloadHash: input.payloadHash,
      policyVersion: input.policyVersion,
      preconditions: input.preconditions,
      expiresAt: input.expiresAt,
      actorId: input.actorId,
      provenance: input.provenance,
      providerModel: input.providerModel ?? null,
      correlationId: input.correlationId ?? null,
      supersededAt: null,
      createdAt: now,
    }) as ProposalRow | undefined;

    if (!row) {
      // Duplicate (same target + payload_hash) — fetch existing
      const existing = this.stmt.selectActiveProposal.get({
        budgetId: input.budgetId,
        transactionId: input.transactionId,
        operation: input.operation,
      }) as ProposalRow | undefined;
      if (existing) return rowToProposal(existing);
      // Fallback: fetch by payload unique key
      const byPayload = this.stmt.selectProposal.all('') as ProposalRow[];
      const match = byPayload.find(r =>
        r.budget_id === input.budgetId &&
        r.transaction_id === input.transactionId &&
        r.operation === input.operation &&
        r.payload_hash === input.payloadHash
      );
      if (match) return rowToProposal(match);
      throw new Error('Failed to create or retrieve proposal');
    }

    return rowToProposal(row);
  }

  async getProposal(id: string): Promise<CategorizationProposal | null> {
    const row = this.stmt.selectProposal.get(id) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  async findActiveProposal(
    budgetId: string,
    transactionId: string,
    operation: ProposalOperation,
  ): Promise<CategorizationProposal | null> {
    const row = this.stmt.selectActiveProposal.get({
      budgetId, transactionId, operation,
    }) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  async supersedeProposal(id: string): Promise<CategorizationProposal> {
    const existing = this.stmt.selectProposal.get(id) as ProposalRow | undefined;
    if (!existing) throw new Error(`Proposal ${id} not found`);
    if (existing.superseded_at) {
      // Already superseded — idempotent
      return rowToProposal(existing);
    }

    const now = nowISO();
    this.db.transaction(() => {
      this.stmt.supersedeProposalStmt.run({ id, now });
      this.stmt.supersedeProposalApprovals.run({ proposalId: id, now });
    })();

    const updated = this.stmt.selectProposal.get(id) as ProposalRow;
    return rowToProposal(updated);
  }

  async listProposals(options?: ListProposalsOptions): Promise<CategorizationProposal[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const hasBudget = options?.budgetId != null;

    let rows: ProposalRow[];

    if (hasBudget) {
      if (options?.superseded === false) {
        rows = this.stmt.listProposalsByBudgetActive.all({
          budgetId: options.budgetId,
          limit,
          offset,
        }) as ProposalRow[];
      } else if (options?.superseded === true) {
        rows = this.stmt.listProposalsSupersededByBudget.all({
          budgetId: options.budgetId,
          limit,
          offset,
        }) as ProposalRow[];
      } else {
        rows = this.stmt.listProposalsByBudget.all({
          budgetId: options.budgetId,
          limit,
          offset,
        }) as ProposalRow[];
      }
    } else {
      if (options?.superseded === false) {
        rows = this.stmt.listProposalsActive.all({ limit, offset }) as ProposalRow[];
      } else if (options?.superseded === true) {
        rows = this.stmt.listProposalsSuperseded.all({ limit, offset }) as ProposalRow[];
      } else {
        rows = this.stmt.listProposals.all({ limit, offset }) as ProposalRow[];
      }
    }

    return rows.map(rowToProposal);
  }

  // ── Proposal approval lifecycle ───────────────────────────────────

  async createApproval(input: CreateApprovalInput): Promise<ProposalApproval> {
    // Validate proposal exists and is not superseded
    const proposalRow = this.stmt.selectProposal.get(input.proposalId) as ProposalRow | undefined;
    if (!proposalRow) throw new Error(`Proposal ${input.proposalId} not found`);
    if (proposalRow.superseded_at) throw new Error(`Proposal ${input.proposalId} is superseded`);

    // Validate payload hash matches proposal
    if (input.payloadHash !== proposalRow.payload_hash) {
      throw new Error(`Payload hash mismatch: approval hash ${input.payloadHash} does not match proposal hash ${proposalRow.payload_hash}`);
    }

    // Validate expiry is in the future
    if (new Date(input.expiresAt) <= new Date()) {
      throw new Error(`Approval expiry ${input.expiresAt} is in the past`);
    }

    const id = randomUUID();
    const now = nowISO();

    const row = this.stmt.insertApproval.get({
      id,
      proposalId: input.proposalId,
      payloadHash: input.payloadHash,
      actorId: input.actorId,
      expiresAt: input.expiresAt,
      createdAt: now,
    }) as ApprovalRow | undefined;

    if (!row) {
      // Idempotent: existing active approval for (proposalId, actorId)
      const existing = this.stmt.selectActiveApprovals.all({
        proposalId: input.proposalId,
        now: nowISO(),
      }) as ApprovalRow[];
      const match = existing.find(a => a.actor_id === input.actorId);
      if (match) return rowToApproval(match);
      // If no active match found, the conflict is with a consumed/expired one — fetch by direct query
      const allRows = this.stmt.selectApproval.all('') as ApprovalRow[];
      const actorApproval = allRows.find(a => a.proposal_id === input.proposalId && a.actor_id === input.actorId);
      if (actorApproval) return rowToApproval(actorApproval);
      throw new Error('Failed to create approval');
    }

    return rowToApproval(row);
  }

  async getApproval(id: string): Promise<ProposalApproval | null> {
    const row = this.stmt.selectApproval.get(id) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  async findActiveApprovals(proposalId: string): Promise<ProposalApproval[]> {
    // First mark any expired approvals
    const now = nowISO();
    this.stmt.markExpiredApprovals.run({ now });

    const rows = this.stmt.selectActiveApprovals.all({ proposalId, now }) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  async consumeApproval(id: string): Promise<ProposalApproval> {
    const existing = this.stmt.selectApproval.get(id) as ApprovalRow | undefined;
    if (!existing) throw new Error(`Approval ${id} not found`);

    if (existing.consumed_at) throw new Error(`Approval ${id} already consumed at ${existing.consumed_at}`);
    if (existing.superseded_at) throw new Error(`Approval ${id} is superseded`);

    // Check proposal is not superseded
    const proposalRow = this.stmt.selectProposal.get(existing.proposal_id) as ProposalRow | undefined;
    if (!proposalRow) throw new Error(`Proposal ${existing.proposal_id} not found`);
    if (proposalRow.superseded_at) throw new Error(`Proposal ${existing.proposal_id} is superseded — cannot consume its approval`);

    // Check expiry
    const now = nowISO();
    if (new Date(existing.expires_at) <= new Date()) {
      throw new Error(`Approval ${id} expired at ${existing.expires_at}`);
    }

    const result = this.stmt.consumeApprovalStmt.run({ id, now });
    if (result.changes === 0) {
      throw new Error(`Approval ${id} could not be consumed (concurrent state change)`);
    }

    const updated = this.stmt.selectApproval.get(id) as ApprovalRow;
    return rowToApproval(updated);
  }

  async verifyApprovalForExecution(
    proposalId: string,
    payloadHash: string,
  ): Promise<string | null> {
    // Check proposal exists
    const proposalRow = this.stmt.selectProposal.get(proposalId) as ProposalRow | undefined;
    if (!proposalRow) return `Proposal ${proposalId} not found`;

    // Check proposal is not superseded
    if (proposalRow.superseded_at) return `Proposal ${proposalId} was superseded at ${proposalRow.superseded_at}`;

    // Check payload hash matches
    if (payloadHash !== proposalRow.payload_hash) {
      return `Payload hash mismatch: expected ${proposalRow.payload_hash}, got ${payloadHash}`;
    }

    // Find active approvals
    const now = nowISO();
    this.stmt.markExpiredApprovals.run({ now });
    const activeApprovals = this.stmt.selectActiveApprovals.all({ proposalId, now }) as ApprovalRow[];

    if (activeApprovals.length === 0) {
      return `No active approvals found for proposal ${proposalId}`;
    }

    return null;
  }

  // ── Idempotency records ───────────────────────────────────────────

  async createIdempotencyRecord(input: CreateIdempotencyInput): Promise<IdempotencyRecord> {
    const now = nowISO();

    // Check if key already exists
    const existing = this.stmt.selectIdempotency.get(input.idempotencyKey) as IdempotencyRow | undefined;
    if (existing) {
      if (existing.proposal_id !== input.proposalId || existing.operation !== input.operation) {
        throw new Error(
          `Idempotency key ${input.idempotencyKey} replay mismatch: ` +
          `already recorded for proposal ${existing.proposal_id} (op: ${existing.operation}), ` +
          `cannot reuse with proposal ${input.proposalId} (op: ${input.operation})`,
        );
      }
      if (existing.serialised_effect !== input.serialisedEffect) {
        throw new Error(
          `Idempotency key ${input.idempotencyKey} replay mismatch: ` +
          `serialised effect differs from original`,
        );
      }
      return rowToIdempotency(existing);
    }

    this.stmt.insertIdempotency.run({
      idempotencyKey: input.idempotencyKey,
      proposalId: input.proposalId,
      operation: input.operation,
      executedAt: now,
      serialisedEffect: input.serialisedEffect,
      updatedAt: now,
    });

    const row = this.stmt.selectIdempotency.get(input.idempotencyKey) as IdempotencyRow;
    return rowToIdempotency(row);
  }

  async getIdempotencyRecord(key: string): Promise<IdempotencyRecord | null> {
    const row = this.stmt.selectIdempotency.get(key) as IdempotencyRow | undefined;
    return row ? rowToIdempotency(row) : null;
  }

  async completeIdempotencyRecord(
    key: string,
    errorMessage?: string | null,
  ): Promise<IdempotencyRecord> {
    const now = nowISO();
    this.stmt.completeIdempotencyStmt.run({ key, errorMessage: errorMessage ?? null, now });
    const row = this.stmt.selectIdempotency.get(key) as IdempotencyRow;
    return rowToIdempotency(row);
  }

  // ── Audit records (append-only) ───────────────────────────────────

  async appendAuditRecord(input: AppendAuditInput): Promise<AuditRecord> {
    const id = randomUUID();
    const now = nowISO();

    const authDispositionJson = input.authorizationDisposition
      ? JSON.stringify(input.authorizationDisposition)
      : null;

    this.stmt.insertAudit.run({
      id,
      classification: input.classification,
      timestamp: now,
      actorId: input.actorId,
      operation: input.operation ?? null,
      proposalId: input.proposalId ?? null,
      payloadHash: input.payloadHash ?? null,
      budgetId: input.budgetId ?? null,
      backendIds: input.backendIds ?? '[]',
      policyVersion: input.policyVersion ?? null,
      authorizationDisposition: authDispositionJson,
      idempotencyKey: input.idempotencyKey ?? null,
      expectedPriorState: input.expectedPriorState ?? null,
      observedResultState: input.observedResultState ?? null,
      providerModel: input.providerModel ?? null,
      correlationId: input.correlationId ?? null,
      requestId: input.requestId ?? null,
      result: input.result,
      isError: input.isError ? 1 : 0,
    });

    const row = this.stmt.selectAuditByProposal.all({ proposalId: id ?? '', limit: 1 }) as AuditRow[];
    // Fetch by scanning recent — simplest with no index on id
    const allRows = (this.stmt.selectAuditCount.get as () => { count: number })();
    const rows = this.stmt.selectAuditByClassification.all({
      classification: null,
      limit: 1,
      offset: 0,
    }) as AuditRow[];
    // Actually, let's construct from what we have
    const resultRecord: AuditRecord = {
      id,
      classification: input.classification,
      timestamp: now,
      actorId: input.actorId,
      operation: input.operation ?? null,
      proposalId: input.proposalId ?? null,
      payloadHash: input.payloadHash ?? null,
      budgetId: input.budgetId ?? null,
      backendIds: input.backendIds ?? '[]',
      policyVersion: input.policyVersion ?? null,
      authorizationDisposition: input.authorizationDisposition ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      expectedPriorState: input.expectedPriorState ?? null,
      observedResultState: input.observedResultState ?? null,
      providerModel: input.providerModel ?? null,
      correlationId: input.correlationId ?? null,
      requestId: input.requestId ?? null,
      result: input.result,
      isError: input.isError ?? false,
    };
    return resultRecord;
  }

  async queryAuditRecords(
    classification?: AuditClassification,
    limit?: number,
    offset?: number,
  ): Promise<AuditRecord[]> {
    const rows = this.stmt.selectAuditByClassification.all({
      classification: classification ?? null,
      limit: limit ?? 50,
      offset: offset ?? 0,
    }) as AuditRow[];
    return rows.map(rowToAudit);
  }

  async queryAuditRecordsByProposal(
    proposalId: string,
    limit?: number,
  ): Promise<AuditRecord[]> {
    const rows = this.stmt.selectAuditByProposal.all({
      proposalId,
      limit: limit ?? 50,
    }) as AuditRow[];
    return rows.map(rowToAudit);
  }

  // ── Authorization ─────────────────────────────────────────────────

  async evaluateAuthorization(
    actorId: string,
    capability: string,
    scope: string,
    policyVersion: string,
  ): Promise<AuthorizationResult> {
    const row = this.stmt.selectActorMembership.get(actorId) as ActorMembershipRow | undefined;

    if (!row) {
      return {
        allowed: false,
        disposition: { kind: 'denied', reason: 'Actor not found in membership registry' },
        actorId,
        membershipStatus: 'unknown',
        capability,
        scope,
        policyVersion,
        reason: 'Actor is not a registered member',
      };
    }

    if (row.status !== 'active') {
      return {
        allowed: false,
        disposition: { kind: 'denied', reason: `Member status is '${row.status}', not 'active'` },
        actorId,
        membershipStatus: row.status as MembershipStatus,
        capability,
        scope,
        policyVersion,
        reason: `Member is ${row.status}, requires active membership`,
      };
    }

    const capabilities = JSON.parse(row.capabilities) as string[];
    if (!capabilities.includes(capability)) {
      return {
        allowed: false,
        disposition: { kind: 'denied', reason: `Missing capability '${capability}'` },
        actorId,
        membershipStatus: 'active',
        capability,
        scope,
        policyVersion,
        reason: `Actor lacks required capability '${capability}'`,
      };
    }

    if (row.scope !== '*' && row.scope !== scope) {
      return {
        allowed: false,
        disposition: { kind: 'denied', reason: `Scope '${row.scope}' does not cover required scope '${scope}'` },
        actorId,
        membershipStatus: 'active',
        capability,
        scope,
        policyVersion,
        reason: `Actor scope '${row.scope}' does not include '${scope}'`,
      };
    }

    return {
      allowed: true,
      disposition: { kind: 'authorized_without_approval' },
      actorId,
      membershipStatus: 'active',
      capability,
      scope,
      policyVersion,
      reason: 'Authorized',
    };
  }

  async upsertActorMembership(
    actorId: string,
    status: MembershipStatus,
    capabilities: string[],
    scope: string,
  ): Promise<void> {
    this.stmt.upsertActorMembershipStmt.run({
      actorId,
      status,
      capabilities: JSON.stringify(capabilities),
      scope,
    });
  }

  async getActorMembership(actorId: string): Promise<{
    actorId: string;
    status: MembershipStatus;
    capabilities: string[];
    scope: string;
  } | null> {
    const row = this.stmt.selectActorMembership.get(actorId) as ActorMembershipRow | undefined;
    if (!row) return null;
    return {
      actorId: row.actor_id,
      status: row.status as MembershipStatus,
      capabilities: JSON.parse(row.capabilities) as string[],
      scope: row.scope,
    };
  }
}
