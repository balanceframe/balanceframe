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
 * - Job idempotency under retries / duplicate delivery / crash recovery
 * - Failure record preservation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type { WorkflowStore, Suggestion, SaveSuggestionInput } from '../src/types.js';

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
      await new Promise(resolve => setTimeout(resolve, 10));

      // New worker with different token reclaims it
      const recovered = await store.claimJob(job.id, 'token-new', 60_000);
      expect(recovered).not.toBeNull();
      expect(recovered!.claimToken).toBe('token-new');
      expect(recovered!.status).toBe('processing');
    });
  });

  describe('completeJob', () => {
    it('marks a claimed job as completed', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      await store.claimJob(job.id, 'token-abc');

      await store.completeJob(job.id);

      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('completed');
    });

    it('is idempotent on already-completed jobs', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      await store.claimJob(job.id, 'token-abc');
      await store.completeJob(job.id);
      await store.completeJob(job.id); // should not throw
      const jobById = await store.getJobByCandidateId('classify', 'txn-001/1');
      expect(jobById!.status).toBe('completed');
    });
  });

  describe('failJob', () => {
    it('marks a claimed job as failed and records the failure', async () => {
      const job = await store.enqueueJob({ jobType: 'classify', candidateId: 'txn-001/1' });
      await store.claimJob(job.id, 'token-abc');

      const failure = await store.failJob(job.id, 'INFERENCE_TIMEOUT', 'Model did not respond');

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
      await store.failJob(job.id, 'NETWORK_ERROR', 'Connection lost');

      // Unrelated suggestion untouched
      const reloaded = await store.getSuggestion(saved.id);
      expect(reloaded!.supersededAt).toBeNull();
      expect(reloaded!.categoryId).toBe('cat-food');
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
      await store.completeJob(j1.id);
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
      await store.completeJob(job.id);
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

      const failure = await store.failJob(job.id, 'PROVIDER_ERROR', 'Provider returned 503');

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
  });
});
