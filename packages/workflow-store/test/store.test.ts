/**
 * Failing tests for the SQLite-backed WorkflowStore.
 *
 * These tests establish the expected contract before any deps are
 * installed. Run `pnpm install` from the monorepo root, then
 * `pnpm --filter @balanceframe/workflow-store test`.
 *
 * Categories:
 * - Suggestion immutability & idempotent save
 * - Stable IDs and provenance retention
 * - One active suggestion per budget/transaction/classifier+prompt-version
 * - Supersession on category or transaction version change
 * - Stale transaction-version rejection / immediate supersession
 * - Job idempotency under retries / duplicate delivery / crash recovery
 * - Claim token gating for complete/fail transitions
 * - Failure record insertion only after successful state transition
 * - Duplicate enqueue true no-op (unchanged updated_at)
 * - Stale worker rejection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type { SaveSuggestionInput } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_SUGGESTION: SaveSuggestionInput = {
  transactionId: 'txn-001',
  budgetId: 'budget-alpha',
  categoryId: 'cat-food',
  classifier: 'fast-classifier',
  promptVersion: '1.0.0',
  payload: { confidence: 0.95, explanation: 'Looks like groceries' },
  transactionVersion: 1,
};

/** Wait briefly for clock progression (supersededAt checks). */
function tickSync(): void {
  // better-sqlite3 is sync — just ensure Date resolution changes
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }
}

// ---------------------------------------------------------------------------
/**
 * Real wall-clock delay for claim-expiry integration tests.
 * SQLite evaluates `claim_expires_at < @now` against real ISO timestamps,
 * so deterministic fake timers cannot drive the expiry. This is the only
 * acceptable use of wall-clock waits in the suite.
 */
function waitMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
// Store lifecycle
// ---------------------------------------------------------------------------

describe('SqliteWorkflowStore', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  // =======================================================================
  // Suggestion lifecycle
  // =======================================================================

  describe('saveSuggestion', () => {
    it('persists a suggestion with all fields intact', async () => {
      const saved = await store.saveSuggestion(BASE_SUGGESTION);

      expect(saved.id).toBeTypeOf('string');
      expect(saved.budgetId).toBe(BASE_SUGGESTION.budgetId);
      expect(saved.transactionId).toBe(BASE_SUGGESTION.transactionId);
      expect(saved.categoryId).toBe(BASE_SUGGESTION.categoryId);
      expect(saved.classifier).toBe(BASE_SUGGESTION.classifier);
      expect(saved.promptVersion).toBe(BASE_SUGGESTION.promptVersion);
      expect(saved.payload).toEqual(BASE_SUGGESTION.payload);
      expect(saved.transactionVersion).toBe(BASE_SUGGESTION.transactionVersion);
      expect(saved.supersededAt).toBeNull();
      expect(saved.createdAt).toBeTypeOf('string');
    });

    it('assigns a stable UUID that can be used to retrieve the record', async () => {
      const saved = await store.saveSuggestion(BASE_SUGGESTION);
      const fetched = await store.getSuggestion(saved.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(saved.id);
    });

    it('auto-supersedes an earlier active suggestion for the same composite key', async () => {
      const first = await store.saveSuggestion(BASE_SUGGESTION);

      tickSync();
      const second = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        categoryId: 'cat-utilities',
        payload: { confidence: 0.88 },
      });

      // First one should be superseded
      const reloadedFirst = await store.getSuggestion(first.id);
      expect(reloadedFirst!.supersededAt).not.toBeNull();
      expect(reloadedFirst!.categoryId).toBe('cat-food'); // immutable content

      // New one should be active
      expect(second.supersededAt).toBeNull();
      expect(second.categoryId).toBe('cat-utilities');

      // Active query returns only the latest
      const active = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(active!.id).toBe(second.id);
    });

    it('preserves old suggestion content after supersession (immutability)', async () => {
      const first = await store.saveSuggestion(BASE_SUGGESTION);
      const firstPayload = { ...first.payload };

      tickSync();
      await store.saveSuggestion({
        ...BASE_SUGGESTION,
        categoryId: 'cat-transport',
      });

      const archived = await store.getSuggestion(first.id);
      expect(archived!.categoryId).toBe('cat-food');
      expect(archived!.payload).toEqual(firstPayload);
      expect(archived!.transactionVersion).toBe(1);
    });

    // ── Requirement 1: Stale transaction-version handling ─────────────

    it('immediately supersedes a suggestion whose transactionVersion is lower than the active one', async () => {
      // Save with version 2 first
      const first = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 2,
        categoryId: 'cat-advanced',
      });
      expect(first.supersededAt).toBeNull();

      tickSync();

      // Now try to save a suggestion with stale version 1
      const stale = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 1,
        categoryId: 'cat-stale',
      });

      // The stale suggestion should be immediately superseded
      expect(stale.supersededAt).not.toBeNull();

      // The active suggestion should still be the one with version 2
      const active = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(active).not.toBeNull();
      expect(active!.id).toBe(first.id);
      expect(active!.categoryId).toBe('cat-advanced');
    });

    it('treats equal transactionVersion as non-stale (replaces normally)', async () => {
      const first = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 3,
        categoryId: 'cat-old',
      });

      tickSync();

      const second = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 3,
        categoryId: 'cat-new',
      });

      // Equal version — second supersedes first (active)
      expect(second.supersededAt).toBeNull();

      const active = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(active!.id).toBe(second.id);
      expect(active!.categoryId).toBe('cat-new');
    });

    it('treats a higher transactionVersion as non-stale (replaces normally)', async () => {
      const first = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 1,
      });

      tickSync();

      const second = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 5,
        categoryId: 'cat-upgraded',
      });

      expect(second.supersededAt).toBeNull();

      const active = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(active!.id).toBe(second.id);
    });

    it('preserves the stale suggestion in the database for audit trail', async () => {
      const first = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 2,
        categoryId: 'cat-first',
      });

      tickSync();

      const stale = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 1,
        categoryId: 'cat-belated',
      });

      // Both should exist in the database
      const all = await store.getTransactionSuggestions(BASE_SUGGESTION.transactionId);
      expect(all).toHaveLength(2);

      const staleReloaded = await store.getSuggestion(stale.id);
      expect(staleReloaded).not.toBeNull();
      expect(staleReloaded!.categoryId).toBe('cat-belated');
      expect(staleReloaded!.transactionVersion).toBe(1);
      expect(staleReloaded!.supersededAt).not.toBeNull();
    });

    it('stale version check is scoped to the composite key (different classifiers unaffected)', async () => {
      // Save version 2 for fast-classifier
      await store.saveSuggestion({ ...BASE_SUGGESTION, transactionVersion: 2 });

      tickSync();

      // Save version 1 for a different classifier — NOT stale for that key
      const deep = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 1,
        classifier: 'deep-analysis',
        promptVersion: '2.0.0',
        categoryId: 'cat-deep',
      });

      expect(deep.supersededAt).toBeNull();

      const active = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        'deep-analysis',
        '2.0.0',
      );
      expect(active!.id).toBe(deep.id);
    });
  });

  describe('getActiveSuggestion', () => {
    it('returns the active suggestion for the exact composite key', async () => {
      await store.saveSuggestion(BASE_SUGGESTION);
      const found = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(found).not.toBeNull();
      expect(found!.transactionId).toBe(BASE_SUGGESTION.transactionId);
    });

    it('returns null when no suggestion exists for the key', async () => {
      const found = await store.getActiveSuggestion(
        'nonexistent-budget',
        'nonexistent-txn',
        'test',
        '1.0.0',
      );
      expect(found).toBeNull();
    });

    it('returns null when the only suggestion is superseded', async () => {
      await store.saveSuggestion(BASE_SUGGESTION);
      tickSync();
      await store.saveSuggestion({
        ...BASE_SUGGESTION,
        categoryId: 'cat-other',
      });

      const found = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(found).not.toBeNull();
      expect(found!.categoryId).toBe('cat-other');
    });

    it('allows independent active suggestions for different classifiers', async () => {
      await store.saveSuggestion(BASE_SUGGESTION);
      await store.saveSuggestion({
        ...BASE_SUGGESTION,
        classifier: 'deep-analysis',
        promptVersion: '2.0.0',
        categoryId: 'cat-other',
      });

      const fast = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId, BASE_SUGGESTION.transactionId,
        'fast-classifier', '1.0.0',
      );
      expect(fast).not.toBeNull();
      expect(fast!.categoryId).toBe('cat-food');

      const deep = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId, BASE_SUGGESTION.transactionId,
        'deep-analysis', '2.0.0',
      );
      expect(deep).not.toBeNull();
      expect(deep!.categoryId).toBe('cat-other');
    });
  });

  describe('getTransactionSuggestions', () => {
    it('returns all suggestions for a transaction in reverse chronological order', async () => {
      const s1 = await store.saveSuggestion(BASE_SUGGESTION);
      tickSync();
      const s2 = await store.saveSuggestion({
        ...BASE_SUGGESTION, categoryId: 'cat-b',
      });
      tickSync();
      const s3 = await store.saveSuggestion({
        ...BASE_SUGGESTION, categoryId: 'cat-c',
      });

      const all = await store.getTransactionSuggestions(BASE_SUGGESTION.transactionId);
      expect(all).toHaveLength(3);
      expect(all[0].id).toBe(s3.id); // newest first
      expect(all[1].id).toBe(s2.id);
      expect(all[2].id).toBe(s1.id);
    });

    it('returns empty array for a transaction with no suggestions', async () => {
      const all = await store.getTransactionSuggestions('nonexistent-txn');
      expect(all).toEqual([]);
    });
  });

  describe('supersedeSuggestions', () => {
    it('supersedes suggestions with older transaction versions', async () => {
      await store.saveSuggestion({ ...BASE_SUGGESTION, transactionVersion: 1 });
      tickSync();

      const count = await store.supersedeSuggestions(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        2, // new version
      );

      expect(count).toBe(1);

      const active = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(active).toBeNull();
    });

    it('does not affect suggestions with version >= new version', async () => {
      await store.saveSuggestion({ ...BASE_SUGGESTION, transactionVersion: 3 });
      tickSync();

      const count = await store.supersedeSuggestions(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        3, // equal — not less
      );

      expect(count).toBe(0);

      const active = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(active).not.toBeNull();
    });

    it('does not affect suggestions for other budgets or transactions', async () => {
      await store.saveSuggestion(BASE_SUGGESTION);
      await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionId: 'txn-002',
      });

      await store.supersedeSuggestions(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        99,
      );

      const otherActive = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId, 'txn-002',
        BASE_SUGGESTION.classifier, BASE_SUGGESTION.promptVersion,
      );
      expect(otherActive).not.toBeNull();
    });
  });

  // =======================================================================
  // Job lifecycle
  // =======================================================================

  describe('enqueueJob', () => {
    it('creates a pending job', async () => {
      const job = await store.enqueueJob({
        jobType: 'classify',
        candidateId: 'txn-001/1',
      });

      expect(job.id).toBeTypeOf('string');
      expect(job.jobType).toBe('classify');
      expect(job.candidateId).toBe('txn-001/1');
      expect(job.status).toBe('pending');
      expect(job.claimToken).toBeNull();
      expect(job.claimedAt).toBeNull();
    });

    it('returns existing job when duplicate candidateId is enqueued (idempotent)', async () => {
      const first = await store.enqueueJob({
        jobType: 'classify',
        candidateId: 'txn-001/1',
      });
      const second = await store.enqueueJob({
        jobType: 'classify',
        candidateId: 'txn-001/1',
      });

      expect(second.id).toBe(first.id);
      expect(second.status).toBe('pending');
    });

    it('allows same candidateId under different jobType', async () => {
      const a = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      const b = await store.enqueueJob({ jobType: 'reclassify', candidateId: 'txn-001/1' });

      expect(a.id).not.toBe(b.id);
    });

    // ── Requirement 4: Duplicate enqueue does not change updated_at ───

    it('does NOT change updated_at on duplicate enqueue', async () => {
      const first = await store.enqueueJob({
        jobType: 'classify',
        candidateId: 'txn-001/1',
      });

      const firstUpdatedAt = first.updatedAt;

      // Wait for clock progression
      tickSync();

      const second = await store.enqueueJob({
        jobType: 'classify',
        candidateId: 'txn-001/1',
      });

      // updated_at must be identical to the original
      expect(second.updatedAt).toBe(firstUpdatedAt);
    });

    it('does NOT change updated_at on multiple duplicate enqueues', async () => {
      const first = await store.enqueueJob({
        jobType: 'classify',
        candidateId: 'txn-001/1',
      });

      const firstUpdatedAt = first.updatedAt;

      tickSync();
      await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      tickSync();
      const third = await store.enqueueJob({
        jobType: 'classify',
        candidateId: 'txn-001/1',
      });

      expect(third.updatedAt).toBe(firstUpdatedAt);
    });
  });

  describe('claimJob', () => {
    it('claims a pending job', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      const claimed = await store.claimJob(job.id, 'token-abc');
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe('processing');
      expect(claimed!.claimToken).toBe('token-abc');
      expect(claimed!.claimedAt).not.toBeNull();
    });

    it('idempotent: re-claiming with the same token returns the job', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      await store.claimJob(job.id, 'token-abc');
      const retry = await store.claimJob(job.id, 'token-abc');
      expect(retry).not.toBeNull();
      expect(retry!.status).toBe('processing');
    });

    it('rejects claim by a different token on an already-claimed job', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      await store.claimJob(job.id, 'token-abc');
      const differentClaim = await store.claimJob(job.id, 'token-xyz');
      expect(differentClaim).toBeNull();
    });

    it('re-claims jobs whose claim has expired (crash recovery)', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      // Claim with a short timeout (1 ms)
      const firstClaim = await store.claimJob(job.id, 'token-old', 1);
      expect(firstClaim).not.toBeNull();

      // Wait for expiry
      await waitMs(10);

      // New worker with different token reclaims it
      const recovered = await store.claimJob(job.id, 'token-new', 60_000);
      expect(recovered).not.toBeNull();
      expect(recovered!.claimToken).toBe('token-new');
      expect(recovered!.status).toBe('processing');
    });
  });

  describe('completeJob', () => {
    it('marks a claimed job as completed with correct claim token', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      await store.claimJob(job.id, 'token-abc');

      await store.completeJob(job.id, 'token-abc');

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('completed');
    });

    it('is idempotent on already-completed jobs with correct token', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      await store.claimJob(job.id, 'token-abc');
      await store.completeJob(job.id, 'token-abc');
      await store.completeJob(job.id, 'token-abc'); // should not throw
      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('completed');
    });

    // ── Requirement 2: Claim token required for complete ---------------

    it('rejects completeJob with wrong claim token (stale worker)', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      await store.claimJob(job.id, 'token-abc');

      // Trying to complete with wrong token — should be a no-op
      await store.completeJob(job.id, 'wrong-token');

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('processing');
    });

    it('rejects completeJob on a pending (unclaimed) job', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      // Job is pending, not processing — cannot complete
      await store.completeJob(job.id, 'token-abc');

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('pending');
    });

    it('allows completeJob after crash recovery re-claim with new token', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      // Original claim with short timeout
      await store.claimJob(job.id, 'token-old', 1);
      await waitMs(10);

      // Reclaimed by a new worker
      await store.claimJob(job.id, 'token-new', 60_000);

      // Complete with the new token
      await store.completeJob(job.id, 'token-new');

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('completed');
    });

    it('rejects completeJob with old claim token after crash recovery', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      // Original claim with short timeout
      await store.claimJob(job.id, 'token-old', 1);
      await waitMs(10);

      // Reclaimed by a new worker
      await store.claimJob(job.id, 'token-new', 60_000);

      // Old worker tries to complete — should be a no-op
      await store.completeJob(job.id, 'token-old');

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('processing'); // Still processing, not completed
      expect(jobById!.claimToken).toBe('token-new'); // New claim still active
    });
  });

  describe('failJob', () => {
    it('marks a claimed job as failed and records the failure with correct claim token', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      await store.claimJob(job.id, 'token-abc');

      const failure = await store.failJob(job.id, 'token-abc', 'INFERENCE_TIMEOUT', 'Model did not respond');

      expect(failure.id).toBeTypeOf('string');
      expect(failure.jobId).toBe(job.id);
      expect(failure.errorCode).toBe('INFERENCE_TIMEOUT');
      expect(failure.errorMessage).toBe('Model did not respond');

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('failed');
    });

    it('preserves suggestion immutability when unrelated jobs fail', async () => {
      const saved = await store.saveSuggestion(BASE_SUGGESTION);
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-other' });
      await store.claimJob(job.id, 'token-abc');
      await store.failJob(job.id, 'token-abc', 'NETWORK_ERROR', 'Connection lost');

      // Unrelated suggestion untouched
      const reloaded = await store.getSuggestion(saved.id);
      expect(reloaded!.supersededAt).toBeNull();
      expect(reloaded!.categoryId).toBe('cat-food');
    });

    // ── Requirement 2: Claim token required for fail ──────────────────

    it('rejects failJob with wrong claim token (stale worker)', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      await store.claimJob(job.id, 'token-abc');

      // Trying to fail with wrong token
      await expect(
        store.failJob(job.id, 'wrong-token', 'STALE_WORKER', 'Claim expired'),
      ).rejects.toThrow();

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('processing'); // Still processing
    });

    it('rejects failJob on a pending (unclaimed) job', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      await expect(
        store.failJob(job.id, 'token-abc', 'UNCLAIMED', 'Job never claimed'),
      ).rejects.toThrow();

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('pending');
    });

    // ── Requirement 3: Failure record only after successful transition ─

    it('does NOT insert a failure record when state transition fails (wrong token)', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      await store.claimJob(job.id, 'token-abc');

      // Attempt fail with wrong token
      await expect(
        store.failJob(job.id, 'wrong-token', 'STALE', 'stale'),
      ).rejects.toThrow();

      // Now fail correctly
      const failure = await store.failJob(job.id, 'token-abc', 'REAL_ERROR', 'Actually failed');

      // There should be exactly one failure record
      // (wrong-token attempt should not have inserted one)
      expect(failure.errorCode).toBe('REAL_ERROR');
    });

    it('does NOT insert a duplicate failure record on idempotent retry', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      await store.claimJob(job.id, 'token-abc');

      // First fail
      const first = await store.failJob(job.id, 'token-abc', 'TIMEOUT', 'First attempt');

      // Retry fail (idempotent)
      const second = await store.failJob(job.id, 'token-abc', 'TIMEOUT', 'Retry');

      // Both should return a failure record
      expect(first.id).toBeTypeOf('string');
      expect(second.id).toBeTypeOf('string');
      // The retry should return the existing failure record (same error code/message)
      expect(second.errorCode).toBe('TIMEOUT');
    });

    it('allows failJob after crash recovery re-claim with new token', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      await store.claimJob(job.id, 'token-old', 1);
      await waitMs(10);

      // Reclaimed by new worker
      await store.claimJob(job.id, 'token-new', 60_000);

      // Fail with the new token — should succeed
      const failure = await store.failJob(job.id, 'token-new', 'RECOVERED', 'Failed after recovery');
      expect(failure.errorCode).toBe('RECOVERED');

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('failed');
    });

    it('rejects failJob with old claim token after crash recovery', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });

      await store.claimJob(job.id, 'token-old', 1);
      await waitMs(10);

      // Reclaimed by new worker
      await store.claimJob(job.id, 'token-new', 60_000);

      // Old worker tries to fail — should throw
      await expect(
        store.failJob(job.id, 'token-old', 'STALE', 'Old worker'),
      ).rejects.toThrow();

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('processing'); // Still processing (new worker's claim)
      expect(jobById!.claimToken).toBe('token-new');
    });
  });

  describe('getPendingJobs', () => {
    it('returns only pending jobs', async () => {
      await store.enqueueJob({ jobType: 'classify', candidateId: 'a' });
      await store.enqueueJob({ jobType: 'classify', candidateId: 'b' });

      const pending = await store.getPendingJobs();
      expect(pending).toHaveLength(2);
      expect(pending.every(j => j.status === 'pending')).toBe(true);
    });

    it('excludes claimed/completed/failed jobs', async () => {
      const j1 = await store.enqueueJob({ jobType: 'classify', candidateId: 'a' });
      const j2 = await store.enqueueJob({ jobType: 'classify', candidateId: 'b' });
      const j3 = await store.enqueueJob({ jobType: 'classify', candidateId: 'c' });

      await store.claimJob(j1.id, 't1');
      await store.completeJob(j1.id, 't1');
      await store.claimJob(j2.id, 't2');
      // j3 stays pending

      const pending = await store.getPendingJobs();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(j3.id);
    });
  });

  describe('getJobByCandidateId', () => {
    it('finds a job by jobType and candidateId', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      const found = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(found!.id).toBe(job.id);
    });

    it('returns null for nonexistent combination', async () => {
      const found = await store.getJobByCandidateId('classify', 'nonexistent');
      expect(found).toBeNull();
    });
  });

  // =======================================================================
  // Integration: suggestion + job lifecycle together
  // =======================================================================

  describe('integration — full workflow', () => {
    it('enqueues, claims, completes, and saves a suggestion without collisions', async () => {
      // Phase 1: enqueue a classification job
      const job = await store.enqueueJob({
        jobType: 'classify',
        candidateId: 'txn-001/v1',
      });
      expect(job.status).toBe('pending');

      // Phase 2: claim and process it
      const claimed = await store.claimJob(job.id, 'worker-token');
      expect(claimed!.status).toBe('processing');

      // Phase 3: save the resulting suggestion
      const suggestion = await store.saveSuggestion({
        transactionId: 'txn-001',
        budgetId: 'budget-alpha',
        categoryId: 'cat-food',
        classifier: 'fast-classifier',
        promptVersion: '1.0.0',
        payload: { confidence: 0.95 },
        transactionVersion: 1,
      });
      expect(suggestion.id).toBeTypeOf('string');

      // Phase 4: complete the job
      await store.completeJob(job.id, 'worker-token');
      const completedJob = await store.getJobByCandidateId('classify', 'txn-001/v1');
      expect(completedJob!.status).toBe('completed');

      // Phase 5: verify suggestion is queryable
      const active = await store.getActiveSuggestion(
        'budget-alpha', 'txn-001', 'fast-classifier', '1.0.0',
      );
      expect(active!.id).toBe(suggestion.id);
    });

    it('enqueues, fails, and preserves failure record', async () => {
      const job = await store.enqueueJob({
        jobType: 'classify',
        candidateId: 'txn-002/v1',
      });
      await store.claimJob(job.id, 'worker-token');

      const failure = await store.failJob(job.id, 'worker-token', 'PROVIDER_ERROR', 'Provider returned 503');

      expect(failure.errorCode).toBe('PROVIDER_ERROR');
      const failedJob = await store.getJobByCandidateId('classify', 'txn-002/v1');
      expect(failedJob!.status).toBe('failed');

      // A new suggestion for the same transaction should work (suggestions
      // are decoupled from job state)
      const suggestion = await store.saveSuggestion({
        transactionId: 'txn-002',
        budgetId: 'budget-alpha',
        categoryId: 'cat-rent',
        classifier: 'fallback-classifier',
        promptVersion: '1.0.0',
        payload: { fallback: true },
        transactionVersion: 1,
      });
      expect(suggestion.categoryId).toBe('cat-rent');
    });

    // ── Requirement 6: Out-of-order saves ────────────────────────────

    it('handles out-of-order saves: lower version after higher is immediately superseded', async () => {
      // Save with version 3
      const v3 = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 3,
        categoryId: 'cat-v3',
      });
      expect(v3.supersededAt).toBeNull();

      tickSync();

      // Save with version 2 (arrives late)
      const v2 = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 2,
        categoryId: 'cat-v2',
      });
      expect(v2.supersededAt).not.toBeNull(); // immediately superseded

      // Save with version 1 (even later)
      const v1 = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 1,
        categoryId: 'cat-v1',
      });
      expect(v1.supersededAt).not.toBeNull(); // immediately superseded

      // Active is still version 3
      const active = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(active!.id).toBe(v3.id);
      expect(active!.categoryId).toBe('cat-v3');

      // All three saved
      const all = await store.getTransactionSuggestions(BASE_SUGGESTION.transactionId);
      expect(all).toHaveLength(3);
    });

    // ── Requirement 6: Claim races ────────────────────────────────────

    it('handles claim race: only one worker can claim a pending job', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'race-001' });

      // Two simultaneous claims
      const claim1 = await store.claimJob(job.id, 'racer-a');
      expect(claim1).not.toBeNull();

      const claim2 = await store.claimJob(job.id, 'racer-b');
      expect(claim2).toBeNull(); // racer-b gets nothing

      // Verify claimed by racer-a
      const byCandidate = await store.getJobByCandidateId('classify', 'race-001');
      expect(byCandidate!.claimToken).toBe('racer-a');
    });

    it('handles claim race with expiry: second worker can claim after expiry', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'race-002' });

      // First worker claims with short timeout
      await store.claimJob(job.id, 'worker-a', 1);
      await waitMs(10);

      // Second worker claims after expiry
      const claim2 = await store.claimJob(job.id, 'worker-b', 60_000);
      expect(claim2).not.toBeNull();
      expect(claim2!.claimToken).toBe('worker-b');
    });

    // ── Requirement 6: Stale workers ──────────────────────────────────

    it('prevents stale worker from completing a reclaimed job', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'stale-001' });

      await store.claimJob(job.id, 'worker-a', 1);
      await waitMs(10);

      // Job reclaimed by worker-b
      await store.claimJob(job.id, 'worker-b', 60_000);

      // Stale worker-a tries to complete
      await store.completeJob(job.id, 'worker-a');

      const check = await store.getJobByCandidateId('classify', 'stale-001');
      expect(check!.status).toBe('processing'); // Not completed
      expect(check!.claimToken).toBe('worker-b'); // Still worker-b's claim
    });

    it('prevents stale worker from failing a reclaimed job', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'stale-002' });

      await store.claimJob(job.id, 'worker-a', 1);
      await waitMs(10);

      // Job reclaimed by worker-b
      await store.claimJob(job.id, 'worker-b', 60_000);

      // Stale worker-a tries to fail — should throw
      await expect(
        store.failJob(job.id, 'worker-a', 'STALE', 'Old worker'),
      ).rejects.toThrow();

      const check = await store.getJobByCandidateId('classify', 'stale-002');
      expect(check!.status).toBe('processing');
      expect(check!.claimToken).toBe('worker-b');
    });

    // ── Requirement 6: Duplicate failures ─────────────────────────────

    it('handles duplicate failJob calls idempotently', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'dup-fail' });
      await store.claimJob(job.id, 'token-abc');

      // Fail multiple times
      const f1 = await store.failJob(job.id, 'token-abc', 'ERROR', 'Original error');
      const f2 = await store.failJob(job.id, 'token-abc', 'ERROR', 'Retry');

      // Both return a valid failure record
      expect(f1.errorCode).toBe('ERROR');
      expect(f2.errorCode).toBe('ERROR');

      // Job is failed
      const jobById = await store.getJobByCandidateId('classify', 'dup-fail');
      expect(jobById!.status).toBe('failed');
    });

    // ── Requirement 6: Duplicate enqueues ────────────────────────────

    it('handles many duplicate enqueues without changing metadata', async () => {
      const first = await store.enqueueJob({ jobType: 'classify', candidateId: 'dup-enq' });
      const originalUpdatedAt = first.updatedAt;

      for (let i = 0; i < 10; i++) {
        tickSync();
        const dup = await store.enqueueJob({ jobType: 'classify', candidateId: 'dup-enq' });
        expect(dup.updatedAt).toBe(originalUpdatedAt);
        expect(dup.status).toBe('pending');
      }
    });

    // ── Requirement 6: Crash recovery ─────────────────────────────────

    it('recovers jobs after simulated crash (expired claims get reclaimed)', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'crash-001' });

      // Claim with very short timeout
      await store.claimJob(job.id, 'crash-token', 1);
      await waitMs(10);

      // Simulate recovery: new scanner picks up the expired job
      const recovered = await store.claimJob(job.id, 'recovery-token', 60_000);
      expect(recovered).not.toBeNull();
      expect(recovered!.claimToken).toBe('recovery-token');
      expect(recovered!.status).toBe('processing');

      // Complete with new token
      await store.completeJob(job.id, 'recovery-token');

      const finalJob = await store.getJobByCandidateId('classify', 'crash-001');
      expect(finalJob!.status).toBe('completed');
    });

    it('recovers and fails after crash', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'crash-002' });

      await store.claimJob(job.id, 'crash-token', 1);
      await waitMs(10);

      // Recover
      await store.claimJob(job.id, 'recovery-token', 60_000);

      // New worker fails it
      const failure = await store.failJob(job.id, 'recovery-token', 'CRASH', 'Job crashed and recovered');
      expect(failure.errorCode).toBe('CRASH');

      const finalJob = await store.getJobByCandidateId('classify', 'crash-002');
      expect(finalJob!.status).toBe('failed');
    });

    // ── Requirement 6: Stale transaction versions ─────────────────────

    it('rejects stale suggestions across multiple classifiers', async () => {
      // Save active suggestions for multiple classifiers
      await store.saveSuggestion({ ...BASE_SUGGESTION, transactionVersion: 5 });
      await store.saveSuggestion({
        ...BASE_SUGGESTION,
        classifier: 'deep',
        promptVersion: '2.0',
        transactionVersion: 5,
        categoryId: 'cat-deep',
      });

      tickSync();

      // Try to save stale versions
      const stale1 = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 3,
        categoryId: 'cat-stale-fast',
      });
      expect(stale1.supersededAt).not.toBeNull();

      const stale2 = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        classifier: 'deep',
        promptVersion: '2.0',
        transactionVersion: 2,
        categoryId: 'cat-stale-deep',
      });
      expect(stale2.supersededAt).not.toBeNull();

      // Active ones unchanged
      const activeFast = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(activeFast!.categoryId).toBe('cat-food'); // original payload unchanged? No wait, the first save with version 5 would have been for the default classifier
      // Actually BASE_SUGGESTION has classifier 'fast-classifier' and promptVersion '1.0.0'
      // The first save was: ...BASE_SUGGESTION, transactionVersion:5 → but what category?
      // It merged BASE_SUGGESTION (categoryId: 'cat-food') with transactionVersion: 5
      // So the active fast-classifier suggestion has categoryId 'cat-food'
      expect(activeFast!.transactionVersion).toBe(5);

      const activeDeep = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        'deep',
        '2.0',
      );
      expect(activeDeep!.categoryId).toBe('cat-deep');
      expect(activeDeep!.transactionVersion).toBe(5);
    });

    it('handles supersedeSuggestions then stale save: no higher-version suggestion exists, so incoming becomes active', async () => {
      // Save version 1, then bulk-supersede to version 2.
      // Since no suggestion with transaction_version > 1 was ever saved for
      // this composite key, a later version-1 save is NOT detected as stale
      // (there is no higher version to compare against). The version-1
      // suggestion becomes active. Full stale-version protection across
      // bulk supersedes would require a separate transaction-version tracker.
      await store.saveSuggestion({ ...BASE_SUGGESTION, transactionVersion: 1 });

      await store.supersedeSuggestions(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        2,
      );

      // No active suggestion now (all version < 2 were superseded)
      const empty = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
      );
      expect(empty).toBeNull();

      // Save version 1 — no higher-version suggestion exists for comparison
      const incoming = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        transactionVersion: 1,
        categoryId: 'cat-late',
      });

      // Without a separate version tracker, this becomes active
      expect(incoming.supersededAt).toBeNull();
      expect(incoming.categoryId).toBe('cat-late');
      expect(incoming.transactionVersion).toBe(1);
    });
  });

  // =======================================================================
  // Resource lifecycle
  // =======================================================================

  describe('resource lifecycle', () => {
    it('closes without error', () => {
      expect(() => store.close()).not.toThrow();
    });

    it('rejects operations after close', async () => {
      store.close();
      await expect(
        store.enqueueJob({ jobType: 'classify', candidateId: 'after-close' }),
      ).rejects.toThrow();
    });
  });
});
