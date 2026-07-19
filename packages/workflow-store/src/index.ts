/**
 * @balanceframe/workflow-store — SQLite-backed immutable workflow persistence.
 *
 * Exports the public types and the {@link SqliteWorkflowStore} implementation.
 *
 * ## Usage
 *
 * ```ts
 * import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
 *
 * const store = new SqliteWorkflowStore(':memory:');      // tests
 * const store = new SqliteWorkflowStore('/path/to/db');   // production
 * ```
 *
 * ## Design invariants
 *
 * - Suggestions are immutable once persisted (content never changes).
 * - Supersession sets `supersededAt` without altering any other field.
 * - Jobs use a claim-token pattern for idempotent processing and crash recovery.
 * - All IDs are UUID v4; all timestamps are ISO 8601 UTC.
 */

export { SqliteWorkflowStore } from './store.js';

export type {
  Suggestion,
  SaveSuggestionInput,
  CandidateJob,
  JobStatus,
  FailureRecord,
  EnqueueJobInput,
  WorkflowStore,
} from './types.js';
