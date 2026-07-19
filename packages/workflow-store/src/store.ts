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

interface FailureRow {
  id: string;
  job_id: string;
  error_code: string;
  error_message: string;
  created_at: string;
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
    upsertJob: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectJobByCandidate: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectJobById: null as unknown as ReturnType<DatabaseType['prepare']>,
    claimJobPending: null as unknown as ReturnType<DatabaseType['prepare']>,
    claimJobExpired: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectClaimedJob: null as unknown as ReturnType<DatabaseType['prepare']>,
    completeJob: null as unknown as ReturnType<DatabaseType['prepare']>,
    insertFailure: null as unknown as ReturnType<DatabaseType['prepare']>,
    selectPendingJobs: null as unknown as ReturnType<DatabaseType['prepare']>,
    failJobStatus: null as unknown as ReturnType<DatabaseType['prepare']>,
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
              @transactionVersion, NULL, @createdAt)
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

    // ── Jobs ───────────────────────────────────────────────────────────

    this.stmt.upsertJob = this.db.prepare(`
      INSERT INTO candidate_jobs (id, job_type, candidate_id, status,
                                  claim_token, claimed_at,
                                  claim_expires_at, created_at, updated_at)
      VALUES (@id, @jobType, @candidateId, 'pending',
              NULL, NULL, NULL, @now, @now)
      ON CONFLICT(job_type, candidate_id) DO UPDATE SET
        updated_at = excluded.updated_at
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
         AND status IN ('processing', 'pending')
    `);

    this.stmt.insertFailure = this.db.prepare(`
      INSERT INTO failure_records (id, job_id, error_code, error_message, created_at)
      VALUES (@id, @jobId, @errorCode, @errorMessage, @createdAt)
    `);

    this.stmt.failJobStatus = this.db.prepare(`
      UPDATE candidate_jobs
         SET status = 'failed',
             updated_at = @now
       WHERE id = @jobId
         AND status IN ('processing', 'pending')
    `);

    this.stmt.selectPendingJobs = this.db.prepare(`
      SELECT * FROM candidate_jobs
       WHERE status = 'pending'
       ORDER BY created_at ASC
    `);
  }


  // ── Suggestion lifecycle ───────────────────────────────────────────

  async saveSuggestion(input: SaveSuggestionInput): Promise<Suggestion> {
    const id = randomUUID();
    const now = nowISO();
    const payloadJson = JSON.stringify(input.payload);

    const txn = this.db.transaction(() => {
      // Supersede any existing active suggestion for the same key
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

    const row = this.stmt.upsertJob.get({
      id,
      jobType: input.jobType,
      candidateId: input.candidateId,
      now,
    }) as JobRow | undefined;

    if (!row) {
      // ON CONFLICT DO UPDATE RETURNING * should always return a row;
      // fallback to a select if the upsert hit a race.
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

  async completeJob(jobId: string): Promise<void> {
    const now = nowISO();
    this.stmt.completeJob.run({ jobId, now });
  }

  async failJob(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<FailureRecord> {
    const now = nowISO();
    const failureId = randomUUID();

    const txn = this.db.transaction(() => {
      this.stmt.failJobStatus.run({ jobId, now });
      this.stmt.insertFailure.run({
        id: failureId,
        jobId,
        errorCode,
        errorMessage,
        createdAt: now,
      });
    });

    txn();

    return {
      id: failureId,
      jobId,
      errorCode,
      errorMessage,
      createdAt: now,
    };
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
}
