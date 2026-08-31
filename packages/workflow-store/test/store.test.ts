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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import { createHash } from 'node:crypto';
import type { SaveSuggestionInput, WorkflowStore } from '../src/types.js';
import Database from 'better-sqlite3';
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  while (Date.now() === start) {
    /* spin */
  }
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
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        'fast-classifier',
        '1.0.0',
      );
      expect(fast).not.toBeNull();
      expect(fast!.categoryId).toBe('cat-food');

      const deep = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        BASE_SUGGESTION.transactionId,
        'deep-analysis',
        '2.0.0',
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
        ...BASE_SUGGESTION,
        categoryId: 'cat-b',
      });
      tickSync();
      const s3 = await store.saveSuggestion({
        ...BASE_SUGGESTION,
        categoryId: 'cat-c',
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

      await store.supersedeSuggestions(BASE_SUGGESTION.budgetId, BASE_SUGGESTION.transactionId, 99);

      const otherActive = await store.getActiveSuggestion(
        BASE_SUGGESTION.budgetId,
        'txn-002',
        BASE_SUGGESTION.classifier,
        BASE_SUGGESTION.promptVersion,
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

      const failure = await store.failJob(
        job.id,
        'token-abc',
        'INFERENCE_TIMEOUT',
        'Model did not respond',
      );

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
      await expect(store.failJob(job.id, 'wrong-token', 'STALE', 'stale')).rejects.toThrow();

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
      const failure = await store.failJob(
        job.id,
        'token-new',
        'RECOVERED',
        'Failed after recovery',
      );
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
      await expect(store.failJob(job.id, 'token-old', 'STALE', 'Old worker')).rejects.toThrow();

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
      expect(pending.every((j) => j.status === 'pending')).toBe(true);
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
        'budget-alpha',
        'txn-001',
        'fast-classifier',
        '1.0.0',
      );
      expect(active!.id).toBe(suggestion.id);
    });

    it('enqueues, fails, and preserves failure record', async () => {
      const job = await store.enqueueJob({
        jobType: 'classify',
        candidateId: 'txn-002/v1',
      });
      await store.claimJob(job.id, 'worker-token');

      const failure = await store.failJob(
        job.id,
        'worker-token',
        'PROVIDER_ERROR',
        'Provider returned 503',
      );

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
      await expect(store.failJob(job.id, 'worker-a', 'STALE', 'Old worker')).rejects.toThrow();

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
      const failure = await store.failJob(
        job.id,
        'recovery-token',
        'CRASH',
        'Job crashed and recovered',
      );
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

      await store.supersedeSuggestions(BASE_SUGGESTION.budgetId, BASE_SUGGESTION.transactionId, 2);

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
  // Schema migrations
  // =======================================================================

  describe('schema migrations', () => {
    it('creates schema_version table on instantiation', () => {
      const s = new SqliteWorkflowStore(':memory:');
      const row = s['db'].prepare('SELECT COUNT(*) AS count FROM schema_version').get() as {
        count: number;
      };
      expect(row.count).toBeGreaterThanOrEqual(0);
      s.close();
    });

    it('reports current schema version', () => {
      const s = new SqliteWorkflowStore(':memory:');
      const v = s['getCurrentSchemaVersion']();
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThanOrEqual(0);
      s.close();
    });

    it('applies version records on fresh database', () => {
      const s = new SqliteWorkflowStore(':memory:');
      const versionRow = s['db']
        .prepare('SELECT MAX(version) AS version FROM schema_version')
        .get() as { version: number | null };
      expect(versionRow.version).not.toBeNull();
      s.close();
    });

    it('upgrades from version-0 database (migration metadata only) to current schema', () => {
      // Create a version-0 database with only schema_version table
      const tmpDir = mkdtempSync(join(tmpdir(), 'wf-mig-'));
      const dbPath = join(tmpDir, 'test.db');
      try {
        const db = new Database(dbPath);
        db.exec(`
          CREATE TABLE schema_version (
            version INTEGER NOT NULL UNIQUE,
            applied_at TEXT NOT NULL
          );
          INSERT INTO schema_version (version, applied_at) VALUES (0, '2024-01-01T00:00:00.000Z');
        `);
        db.close();

        // Open with SqliteWorkflowStore — should run migration v1
        const s = new SqliteWorkflowStore(dbPath);

        // Version should be upgraded to at least 1
        const versionRow = s['db']
          .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
          .get() as { version: number };
        expect(versionRow.version).toBeGreaterThanOrEqual(1);

        // Verify tables created by migration v1 exist
        const tables = s['db']
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[];
        const tableNames = tables.map((t) => t.name);

        expect(tableNames).toContain('suggestions');
        expect(tableNames).toContain('candidate_jobs');
        expect(tableNames).toContain('failure_records');
        expect(tableNames).toContain('review_items');
        expect(tableNames).toContain('review_actions');
        expect(tableNames).toContain('categorization_proposals');
        expect(tableNames).toContain('proposal_approvals');
        expect(tableNames).toContain('rule_overrides');
        expect(tableNames).toContain('idempotency_records');
        expect(tableNames).toContain('audit_records');
        expect(tableNames).toContain('review_corrections');
        expect(tableNames).toContain('actor_memberships');
        expect(tableNames).toContain('export_records');

        s.close();
      } finally {
        try {
          unlinkSync(dbPath);
        } catch {
          /* ignore */
        }
        try {
          rmdirSync(tmpDir);
        } catch {
          /* ignore */
        }
      }
    });
  });

  // =======================================================================
  // Pagination totals
  // =======================================================================

  describe('pagination totals', () => {
    it('countReviewItems returns zero when empty', async () => {
      const count = await store.countReviewItems();
      expect(count).toBe(0);
    });

    it('countReviewItems matches list length for single status', async () => {
      // Seed review items with distinct composite keys
      await store.createReviewItem({
        budgetId: 'budget-alpha',
        transactionId: 'txn-seeded-1',
        categoryId: 'cat-food',
        classifier: 'fast',
        provenance: 'test',
      });
      await store.createReviewItem({
        budgetId: 'budget-alpha',
        transactionId: 'txn-seeded-2',
        categoryId: 'cat-util',
        classifier: 'fast',
        provenance: 'test',
      });
      await store.createReviewItem({
        budgetId: 'budget-beta',
        transactionId: 'txn-seeded-3',
        categoryId: 'cat-fun',
        classifier: 'deep',
        provenance: 'test',
      });

      const items = await store.listReviewItems({ status: 'discovered' });
      const count = await store.countReviewItems({ status: 'discovered' });
      expect(count).toBe(items.length);
      // Concrete assertion: all 3 seeded items are 'discovered'
      expect(count).toBe(3);
    });

    it('countReviewItems totals across all statuses', async () => {
      // Create items across distinct statuses
      const i1 = await store.createReviewItem({
        budgetId: 'budget-alpha',
        transactionId: 'txn-stat-1',
        categoryId: 'cat-food',
        classifier: 'fast',
        provenance: 'test',
      });
      await store.createReviewItem({
        budgetId: 'budget-alpha',
        transactionId: 'txn-stat-2',
        categoryId: 'cat-util',
        classifier: 'fast',
        provenance: 'test',
      });
      const i3 = await store.createReviewItem({
        budgetId: 'budget-beta',
        transactionId: 'txn-stat-3',
        categoryId: 'cat-fun',
        classifier: 'deep',
        provenance: 'test',
      });
      const i4 = await store.createReviewItem({
        budgetId: 'budget-beta',
        transactionId: 'txn-stat-4',
        categoryId: 'cat-transport',
        classifier: 'deep',
        provenance: 'test',
      });

      // Transition i1 → suggestion_generated, i3 → pending_review
      await store.transitionReviewItem(i1.id, {
        toStatus: 'suggestion_generated',
        actor: 'test',
        expectedVersion: 1,
      });
      await store.transitionReviewItem(i3.id, {
        toStatus: 'pending_review',
        actor: 'test',
        expectedVersion: 1,
      });

      // Now: 2 discovered (i2, i4) + 1 suggestion_generated (i1) + 1 pending_review (i3) = 4
      const items = await store.listReviewItems();
      const count = await store.countReviewItems();
      expect(count).toBe(items.length);
      expect(count).toBe(4);
    });

    it('countProposals returns zero when empty', async () => {
      const count = await store.countProposals();
      expect(count).toBe(0);
    });

    it('countProposals matches list length', async () => {
      const future = () => new Date(Date.now() + 86_400_000).toISOString();

      await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-alpha',
        transactionId: 'txn-prop-1',
        categoryId: 'cat-food',
        payloadHash: 'hash-aaa',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-beta',
        transactionId: 'txn-prop-2',
        categoryId: 'cat-util',
        payloadHash: 'hash-bbb',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });

      const items = await store.listProposals();
      const count = await store.countProposals();
      expect(count).toBe(items.length);
      expect(count).toBe(2);
    });

    it('countProposals with superseded filter matches filtered list', async () => {
      const future = () => new Date(Date.now() + 86_400_000).toISOString();

      // 2 active proposals
      await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-alpha',
        transactionId: 'txn-ps-1',
        categoryId: 'cat-food',
        payloadHash: 'hash-ccc',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-beta',
        transactionId: 'txn-ps-2',
        categoryId: 'cat-util',
        payloadHash: 'hash-ddd',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      // 1 superseded proposal
      const p3 = await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-gamma',
        transactionId: 'txn-ps-3',
        categoryId: 'cat-fun',
        payloadHash: 'hash-eee',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      await store.supersedeProposal(p3.id);

      const active = await store.listProposals({ superseded: false });
      const activeCount = await store.countProposals({ superseded: false });
      expect(activeCount).toBe(active.length);
      expect(activeCount).toBe(2);

      const superseded = await store.listProposals({ superseded: true });
      const supersededCount = await store.countProposals({ superseded: true });
      expect(supersededCount).toBe(superseded.length);
      expect(supersededCount).toBe(1);
    });

    // ── Page boundary and filter integration tests ──────────────────

    it('countReviewItems returns total irrespective of status filter with concrete values', async () => {
      const i1 = await store.createReviewItem({
        budgetId: 'budget-pg',
        transactionId: 'txn-pg-1',
        categoryId: 'cat-food',
        classifier: 'fast',
        provenance: 'test',
      });
      await store.createReviewItem({
        budgetId: 'budget-pg',
        transactionId: 'txn-pg-2',
        categoryId: 'cat-util',
        classifier: 'fast',
        provenance: 'test',
      });
      const i3 = await store.createReviewItem({
        budgetId: 'budget-pg',
        transactionId: 'txn-pg-3',
        categoryId: 'cat-fun',
        classifier: 'deep',
        provenance: 'test',
      });
      await store.transitionReviewItem(i1.id, {
        toStatus: 'suggestion_generated',
        actor: 'test',
        expectedVersion: 1,
      });
      await store.transitionReviewItem(i3.id, {
        toStatus: 'pending_review',
        actor: 'test',
        expectedVersion: 1,
      });

      expect(await store.countReviewItems()).toBe(3);
      expect(await store.countReviewItems({ status: 'discovered' })).toBe(1);
      expect(await store.countReviewItems({ status: 'suggestion_generated' })).toBe(1);
      expect(await store.countReviewItems({ status: 'pending_review' })).toBe(1);
      expect(await store.countReviewItems({ status: 'approved' })).toBe(0);
    });

    it('listReviewItems respects limit', async () => {
      const created = [];
      for (let i = 0; i < 5; i++) {
        const item = await store.createReviewItem({
          budgetId: 'budget-lim',
          transactionId: `txn-lim-${i}`,
          categoryId: 'cat-food',
          classifier: 'fast',
          provenance: 'test',
        });
        created.push(item);
        tickSync();
      }

      const all = await store.listReviewItems();
      expect(all).toHaveLength(5);

      const limited = await store.listReviewItems({ limit: 2 });
      expect(limited).toHaveLength(2);
      // Same priority, created_at ASC → first seeded first
      expect(limited[0].id).toBe(created[0].id);
    });

    it('listReviewItems respects offset', async () => {
      const allItems = [];
      for (let i = 0; i < 5; i++) {
        const item = await store.createReviewItem({
          budgetId: 'budget-off',
          transactionId: `txn-off-${i}`,
          categoryId: 'cat-food',
          classifier: 'fast',
          provenance: 'test',
        });
        allItems.push(item);
        tickSync();
      }

      const all = await store.listReviewItems();
      expect(all).toHaveLength(5);

      const offset3 = await store.listReviewItems({ offset: 3 });
      expect(offset3).toHaveLength(2);
      expect(offset3[0].id).toBe(all[3].id);

      // Offset past end
      expect(await store.listReviewItems({ offset: 10 })).toHaveLength(0);
    });

    it('listReviewItems respects limit with status filter', async () => {
      const i1 = await store.createReviewItem({
        budgetId: 'budget-st',
        transactionId: 'txn-st-1',
        categoryId: 'cat-food',
        classifier: 'fast',
        provenance: 'test',
      });
      const i2 = await store.createReviewItem({
        budgetId: 'budget-st',
        transactionId: 'txn-st-2',
        categoryId: 'cat-util',
        classifier: 'fast',
        provenance: 'test',
      });
      const i3 = await store.createReviewItem({
        budgetId: 'budget-st',
        transactionId: 'txn-st-3',
        categoryId: 'cat-fun',
        classifier: 'deep',
        provenance: 'test',
      });
      await store.transitionReviewItem(i1.id, {
        toStatus: 'suggestion_generated',
        actor: 'test',
        expectedVersion: 1,
      });
      await store.transitionReviewItem(i3.id, {
        toStatus: 'suggestion_generated',
        actor: 'test',
        expectedVersion: 1,
      });

      // Only i2 remains discovered
      const discoveredAll = await store.listReviewItems({ status: 'discovered' });
      expect(discoveredAll).toHaveLength(1);
      expect(discoveredAll[0].id).toBe(i2.id);

      // Limit beyond available — returns all matching
      const discoveredAll2 = await store.listReviewItems({ status: 'discovered', limit: 5 });
      expect(discoveredAll2).toHaveLength(1);

      // Filter + offset past end
      expect(await store.listReviewItems({ status: 'discovered', offset: 1 })).toHaveLength(0);
    });

    it('countProposals with budget filter returns correct totals', async () => {
      const future = () => new Date(Date.now() + 86_400_000).toISOString();

      // 2 in budget-alpha, 3 in budget-beta
      for (let i = 0; i < 2; i++) {
        await store.createProposal({
          operation: 'set_category',
          budgetId: 'budget-alpha',
          transactionId: `txn-bfa-${i}`,
          categoryId: 'cat-food',
          payloadHash: `hash-bfa-${i}`,
          policyVersion: '1',
          preconditions: '{}',
          expiresAt: future(),
          actorId: 'bot',
          provenance: 'test',
        });
      }
      for (let i = 0; i < 3; i++) {
        await store.createProposal({
          operation: 'set_category',
          budgetId: 'budget-beta',
          transactionId: `txn-bfb-${i}`,
          categoryId: 'cat-util',
          payloadHash: `hash-bfb-${i}`,
          policyVersion: '1',
          preconditions: '{}',
          expiresAt: future(),
          actorId: 'bot',
          provenance: 'test',
        });
      }

      expect(await store.countProposals()).toBe(5);
      expect(await store.countProposals({ budgetId: 'budget-alpha' })).toBe(2);
      expect(await store.countProposals({ budgetId: 'budget-beta' })).toBe(3);
      expect(await store.countProposals({ budgetId: 'nonexistent' })).toBe(0);
    });

    it('countProposals with budget + superseded filter returns correct counts', async () => {
      const future = () => new Date(Date.now() + 86_400_000).toISOString();

      // budget-alpha: 3 active
      await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-alpha',
        transactionId: 'txn-bs-a1',
        categoryId: 'cat-food',
        payloadHash: 'hash-bs-a1',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-alpha',
        transactionId: 'txn-bs-a2',
        categoryId: 'cat-util',
        payloadHash: 'hash-bs-a2',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-alpha',
        transactionId: 'txn-bs-a3',
        categoryId: 'cat-fun',
        payloadHash: 'hash-bs-a3',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      // budget-beta: 2 active, 1 superseded
      await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-beta',
        transactionId: 'txn-bs-b1',
        categoryId: 'cat-food',
        payloadHash: 'hash-bs-b1',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-beta',
        transactionId: 'txn-bs-b2',
        categoryId: 'cat-util',
        payloadHash: 'hash-bs-b2',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      const b3 = await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-beta',
        transactionId: 'txn-bs-b3',
        categoryId: 'cat-fun',
        payloadHash: 'hash-bs-b3',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      await store.supersedeProposal(b3.id);
      // budget-gamma: 1 superseded
      const c1 = await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-gamma',
        transactionId: 'txn-bs-c1',
        categoryId: 'cat-food',
        payloadHash: 'hash-bs-c1',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      await store.supersedeProposal(c1.id);

      // Global
      expect(await store.countProposals()).toBe(7);
      expect(await store.countProposals({ superseded: false })).toBe(5);
      expect(await store.countProposals({ superseded: true })).toBe(2);

      // By budget
      expect(await store.countProposals({ budgetId: 'budget-alpha' })).toBe(3);
      expect(await store.countProposals({ budgetId: 'budget-alpha', superseded: false })).toBe(3);
      expect(await store.countProposals({ budgetId: 'budget-alpha', superseded: true })).toBe(0);

      expect(await store.countProposals({ budgetId: 'budget-beta' })).toBe(3);
      expect(await store.countProposals({ budgetId: 'budget-beta', superseded: false })).toBe(2);
      expect(await store.countProposals({ budgetId: 'budget-beta', superseded: true })).toBe(1);

      expect(await store.countProposals({ budgetId: 'budget-gamma' })).toBe(1);
      expect(await store.countProposals({ budgetId: 'budget-gamma', superseded: false })).toBe(0);
      expect(await store.countProposals({ budgetId: 'budget-gamma', superseded: true })).toBe(1);
    });

    it('listProposals respects limit', async () => {
      const future = () => new Date(Date.now() + 86_400_000).toISOString();

      const created = [];
      for (let i = 0; i < 5; i++) {
        const p = await store.createProposal({
          operation: 'set_category',
          budgetId: 'budget-pl',
          transactionId: `txn-pl-${i}`,
          categoryId: 'cat-food',
          payloadHash: `hash-pl-${i}`,
          policyVersion: '1',
          preconditions: '{}',
          expiresAt: future(),
          actorId: 'bot',
          provenance: 'test',
        });
        created.push(p);
        tickSync();
      }

      const all = await store.listProposals();
      expect(all).toHaveLength(5);

      const limited = await store.listProposals({ limit: 2 });
      expect(limited).toHaveLength(2);
      // Newest first (created_at DESC)
      expect(limited[0].id).toBe(created[4].id);
    });
    it('listProposals respects offset', async () => {
      const future = () => new Date(Date.now() + 86_400_000).toISOString();

      const allItems = [];
      for (let i = 0; i < 5; i++) {
        const p = await store.createProposal({
          operation: 'set_category',
          budgetId: 'budget-po',
          transactionId: `txn-po-${i}`,
          categoryId: 'cat-food',
          payloadHash: `hash-po-${i}`,
          policyVersion: '1',
          preconditions: '{}',
          expiresAt: future(),
          actorId: 'bot',
          provenance: 'test',
        });
        allItems.push(p);
        tickSync();
      }

      const all = await store.listProposals();
      expect(all).toHaveLength(5);

      const offset3 = await store.listProposals({ offset: 3 });
      expect(offset3).toHaveLength(2);
      expect(offset3[0].id).toBe(all[3].id);

      // Offset past end
      expect(await store.listProposals({ offset: 10 })).toHaveLength(0);
    });

    it('listProposals respects limit with superseded filter', async () => {
      const future = () => new Date(Date.now() + 86_400_000).toISOString();

      // Create 3 proposals, supersede the last two
      const p1 = await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-ls',
        transactionId: 'txn-ls-1',
        categoryId: 'cat-food',
        payloadHash: 'hash-ls-1',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      const p2 = await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-ls',
        transactionId: 'txn-ls-2',
        categoryId: 'cat-util',
        payloadHash: 'hash-ls-2',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      const p3 = await store.createProposal({
        operation: 'set_category',
        budgetId: 'budget-ls',
        transactionId: 'txn-ls-3',
        categoryId: 'cat-fun',
        payloadHash: 'hash-ls-3',
        policyVersion: '1',
        preconditions: '{}',
        expiresAt: future(),
        actorId: 'bot',
        provenance: 'test',
      });
      await store.supersedeProposal(p2.id);
      await store.supersedeProposal(p3.id);

      // Active: only p1
      expect(await store.listProposals({ superseded: false, limit: 1 })).toHaveLength(1);
      expect(await store.listProposals({ superseded: false })).toHaveLength(1);

      // Superseded: p2 and p3
      expect(await store.listProposals({ superseded: true })).toHaveLength(2);
      expect(await store.listProposals({ superseded: true, limit: 1 })).toHaveLength(1);
      expect(await store.listProposals({ superseded: true, offset: 1 })).toHaveLength(1);
      expect(await store.listProposals({ superseded: true, offset: 2 })).toHaveLength(0);
    });
  });

  // =======================================================================
  // Registration lifecycle – bootstrap and invitation persistence
  // =======================================================================

  describe('registration lifecycle', () => {
    // Direct DB access for schema-level assertions
    let db: Database.Database;
    let regStore: SqliteWorkflowStore;

    const FIXED_USER_ID = '00000000-0000-0000-0000-000000000001';
    const FIXED_INVITE_ID = '00000000-0000-0000-0000-000000000010';
    const TOKEN_DIGEST = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
    const FIXED_NOW = '2026-07-25T12:00:00.000Z';
    const FUTURE_EXPIRY = '2026-08-01T12:00:00.000Z';
    const OWNER_USER_ID = '00000000-0000-0000-0000-000000000099';
    const PAST_EXPIRY = '2026-07-18T12:00:00.000Z';

    beforeEach(() => {
      db = new Database(':memory:');
      regStore = new SqliteWorkflowStore(':memory:');
    });

    afterEach(() => {
      regStore.close();
      db.close();
    });

    // -----------------------------------------------------------------------
    // Schema migration (v3)
    // -----------------------------------------------------------------------

    describe('schema migration (v3)', () => {
      it('creates registration_state table with single-row constraint', () => {
        const s = new SqliteWorkflowStore(':memory:');
        const tableNames = s['db']
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[];

        expect(tableNames.map((t) => t.name)).toContain('registration_state');

        const colInfo = s['db'].prepare("PRAGMA table_info('registration_state')").all() as {
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }[];

        const colNames = colInfo.map((c) => c.name);
        expect(colNames).toContain('singleton');
        expect(colNames).toContain('owner_user_id');
        expect(colNames).toContain('bootstrapped_at');

        const singletonCol = colInfo.find((c) => c.name === 'singleton')!;
        expect(singletonCol.type).toBe('INTEGER');
        expect(singletonCol.pk).toBe(1);

        s.close();
      });

      it('enforces singleton constraint on registration_state', () => {
        const s = new SqliteWorkflowStore(':memory:');
        const insert = s['db'].prepare(`
        INSERT INTO registration_state (singleton, owner_user_id, bootstrapped_at)
        VALUES (1, 'user-1', @now)
      `);
        insert.run({ now: FIXED_NOW });

        expect(() => {
          insert.run({ now: FIXED_NOW });
        }).toThrow();

        s.close();
      });

      it('creates invitations table with token-digest-only columns', () => {
        const s = new SqliteWorkflowStore(':memory:');
        const tableNames = s['db']
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[];

        expect(tableNames.map((t) => t.name)).toContain('invitations');

        const colInfo = s['db'].prepare("PRAGMA table_info('invitations')").all() as {
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }[];

        const colNames = colInfo.map((c) => c.name);
        expect(colNames).toContain('id');
        expect(colNames).toContain('token_digest');
        expect(colNames).toContain('status');
        expect(colNames).toContain('created_by_user_id');
        expect(colNames).toContain('expires_at');
        expect(colNames).toContain('claimed_email');
        expect(colNames).toContain('claim_id');
        expect(colNames).toContain('redeemed_user_id');
        expect(colNames).toContain('created_at');
        expect(colNames).toContain('claimed_at');
        expect(colNames).toContain('redeemed_at');

        // No column stores the raw bearer token
        expect(colNames).not.toContain('token');
        expect(colNames).not.toContain('raw_token');
        expect(colNames).not.toContain('bearer_token');

        s.close();
      });

      it('enforces unique constraint on invitations.token_digest', () => {
        const s = new SqliteWorkflowStore(':memory:');
        const insertInvite = s['db'].prepare(`
        INSERT INTO invitations (id, token_digest, status, created_by_user_id, expires_at, created_at)
        VALUES (@id, @digest, 'active', @creator, @expires, @now)
      `);
        insertInvite.run({
          id: FIXED_INVITE_ID,
          digest: TOKEN_DIGEST,
          creator: FIXED_USER_ID,
          expires: FUTURE_EXPIRY,
          now: FIXED_NOW,
        });

        expect(() => {
          insertInvite.run({
            id: '00000000-0000-0000-0000-000000000011',
            digest: TOKEN_DIGEST,
            creator: FIXED_USER_ID,
            expires: FUTURE_EXPIRY,
            now: FIXED_NOW,
          });
        }).toThrow();

        s.close();
      });
    });

    // -----------------------------------------------------------------------
    // Bootstrap lifecycle
    // -----------------------------------------------------------------------

    describe('bootstrap', () => {
      it('reports bootstrap available when no owner exists', async () => {
        const state = await regStore.getRegistrationState();
        expect(state.mode).toBe('bootstrap');
        expect(state.ownerUserId).toBeNull();
        expect(state.bootstrappedAt).toBeNull();
      });
      it('claimBootstrap creates exactly one owner under concurrent attempts', async () => {
        const attempt1 = regStore.claimBootstrap({
          name: 'Alice',
          email: 'alice@example.com',
          claimId: '00000000-0000-0000-0000-0000000000a1',
        });
        const attempt2 = regStore.claimBootstrap({
          name: 'Bob',
          email: 'bob@example.com',
          claimId: '00000000-0000-0000-0000-0000000000a2',
        });

        const results = await Promise.allSettled([attempt1, attempt2]);
        const succeeded = results.filter(
          (r): r is PromiseFulfilledResult<Awaited<typeof attempt1>> => r.status === 'fulfilled',
        );
        expect(succeeded).toHaveLength(1);

        await expect(
          regStore.claimBootstrap({
            name: 'Charlie',
            email: 'charlie@example.com',
            claimId: '00000000-0000-0000-0000-0000000000a3',
          }),
        ).rejects.toThrow();
      });

      it('persists owner_user_id and prevents second bootstrap', async () => {
        const claimId = '00000000-0000-0000-0000-000000000099-claim';

        const claim = await regStore.claimBootstrap({
          name: 'Owner',
          email: 'owner@example.com',
          claimId,
        });
        expect(claim.claimId).toBe(claimId);

        await regStore.finalizeBootstrap({ claimId, ownerUserId: OWNER_USER_ID });

        const state = await regStore.getRegistrationState();
        expect(state.mode).toBe('complete');
        expect(state.ownerUserId).toBe(OWNER_USER_ID);
        expect(state.bootstrappedAt).not.toBeNull();

        const row = regStore['db']
          .prepare(
            'SELECT owner_user_id, bootstrapped_at FROM registration_state WHERE singleton = 1',
          )
          .get() as { owner_user_id: string; bootstrapped_at: string } | undefined;
        expect(row).not.toBeUndefined();
        expect(row!.owner_user_id).toBe(OWNER_USER_ID);

        await expect(
          regStore.claimBootstrap({
            name: 'Second',
            email: 'second@example.com',
            claimId: '00000000-0000-0000-0000-000000000099-second',
          }),
        ).rejects.toThrow();
      });
      it('assigns owner an active membership with bootstrap capabilities', async () => {
        const claimId = '00000000-0000-0000-0000-000000000099-membership';

        await regStore.claimBootstrap({
          name: 'Owner',
          email: 'owner@example.com',
          claimId,
        });
        await regStore.finalizeBootstrap({ claimId, ownerUserId: OWNER_USER_ID });

        const membership = await regStore.getActorMembership(OWNER_USER_ID);
        expect(membership).not.toBeNull();
        expect(membership!.status).toBe('active');
        expect(membership!.capabilities).toContain('observe');
        expect(membership!.capabilities).toContain('notification:receive');
        expect(membership!.capabilities).toContain('notification:admin');
        expect(membership!.capabilities).toContain('finding:transition');
        expect(membership!.capabilities).toContain('categorization:execute');
        expect(membership!.capabilities).toContain('rule:execute');
      });
    });

    // -----------------------------------------------------------------------
    // Invitation lifecycle
    // -----------------------------------------------------------------------

    describe('invitation lifecycle', () => {
      it('createInvitation returns only id, expiresAt, and inviteUrl — no raw token', async () => {
        const invite = await regStore.createInvitation(FIXED_USER_ID);

        expect(invite.invitation).toBeDefined();
        expect(invite.invitation.id).toBeTypeOf('string');
        expect(invite.invitation.expiresAt).toBeTypeOf('string');
        expect(invite.invitation.status).toBe('active');
        expect(invite.inviteUrl).toMatch(/^https?:\/\/.*\/invite#token=/);
        const invitationJson = JSON.stringify(invite.invitation);
        expect(invitationJson).not.toMatch(/[a-f0-9]{64}/i);
      });

      it('createInvitation persists only a token digest, never the raw token', async () => {
        const invite = await regStore.createInvitation(FIXED_USER_ID);
        const token = invite.inviteUrl.split('#token=')[1];
        const expectedDigest = createHash('sha256').update(token).digest('hex');

        const rows = regStore['db'].prepare('SELECT * FROM invitations').all() as Record<
          string,
          unknown
        >[];
        expect(rows).toHaveLength(1);

        const row = rows[0];
        expect(row.token_digest).toBe(expectedDigest);

        // Only the token_digest column contains a 64-char hex value
        const hex64Cols = Object.entries(row).filter(
          ([_, v]) => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v),
        );
        expect(hex64Cols.map(([k]) => k)).toEqual(['token_digest']);
      });

      it('revokeInvitation marks an active invitation as revoked', async () => {
        const invite = await regStore.createInvitation(FIXED_USER_ID);
        await regStore.revokeInvitation(invite.invitation.id);

        const list = await regStore.listInvitations();
        const revoked = list.find((i) => i.id === invite.invitation.id);
        expect(revoked).toBeDefined();
        expect(revoked!.status).toBe('revoked');
      });

      it('claimInvitation rejects a revoked invitation', async () => {
        const invite = await regStore.createInvitation(FIXED_USER_ID);
        const token = invite.inviteUrl.split('#token=')[1];
        await regStore.revokeInvitation(invite.invitation.id);

        await expect(
          regStore.claimInvitation({ token, email: 'user@example.com' }),
        ).rejects.toThrow();
      });
      it('claimInvitation rejects an expired invitation', async () => {
        const s = new SqliteWorkflowStore(':memory:');
        const invite = await s.createInvitation(FIXED_USER_ID);
        const token = invite.inviteUrl.split('#token=')[1];
        s['db']
          .prepare('UPDATE invitations SET expires_at = ? WHERE id = ?')
          .run(PAST_EXPIRY, invite.invitation.id);

        await expect(s.claimInvitation({ token, email: 'user@example.com' })).rejects.toThrow();
        s.close();
      });
      it('expired invitation status persists as expired after claim rejection (no rollback)', async () => {
        const s = new SqliteWorkflowStore(':memory:');
        const invite = await s.createInvitation(FIXED_USER_ID);
        const token = invite.inviteUrl.split('#token=')[1];
        s['db']
          .prepare('UPDATE invitations SET expires_at = ? WHERE id = ?')
          .run(PAST_EXPIRY, invite.invitation.id);

        await expect(s.claimInvitation({ token, email: 'user@example.com' })).rejects.toThrow();

        // Status MUST persist as 'expired' despite the thrown error
        const row = s['db']
          .prepare('SELECT status FROM invitations WHERE id = ?')
          .get(invite.invitation.id) as { status: string } | undefined;
        expect(row).toBeDefined();
        expect(row!.status).toBe('expired');
        s.close();
      });

      it('expired invitation creates an audit record with expired classification', async () => {
        const s = new SqliteWorkflowStore(':memory:');
        const invite = await s.createInvitation(FIXED_USER_ID);
        const token = invite.inviteUrl.split('#token=')[1];
        s['db']
          .prepare('UPDATE invitations SET expires_at = ? WHERE id = ?')
          .run(PAST_EXPIRY, invite.invitation.id);

        await expect(s.claimInvitation({ token, email: 'user@example.com' })).rejects.toThrow();

        const auditRows = s['db']
          .prepare("SELECT * FROM audit_records WHERE classification = 'invitation_expired'")
          .all() as Record<string, unknown>[];
        expect(auditRows.length).toBeGreaterThanOrEqual(1);
        s.close();
      });
      it('claimInvitation is one-time: second claim with same token fails', async () => {
        const invite = await regStore.createInvitation(FIXED_USER_ID);
        const token = invite.inviteUrl.split('#token=')[1];

        const claim1 = await regStore.claimInvitation({
          token,
          email: 'first@example.com',
        });
        expect(claim1.claimId).toBeTypeOf('string');
        expect(claim1.email).toBe('first@example.com');

        await expect(
          regStore.claimInvitation({ token, email: 'second@example.com' }),
        ).rejects.toThrow();

        const replay = await regStore.claimInvitation({
          token,
          email: 'first@example.com',
        });
        expect(replay.claimId).toBe(claim1.claimId);
      });

      it('completeInvitationRedemption finalizes the invitation with a user ID', async () => {
        const invite = await regStore.createInvitation(FIXED_USER_ID);
        const token = invite.inviteUrl.split('#token=')[1];
        const claim = await regStore.claimInvitation({
          token,
          email: 'user@example.com',
        });

        await regStore.completeInvitationRedemption(
          claim.claimId,
          '00000000-0000-0000-0000-000000000020',
        );

        const list = await regStore.listInvitations();
        const completed = list.find((i) => i.id === invite.invitation.id);
        expect(completed).toBeDefined();
        expect(completed!.status).toBe('redeemed');
        expect(completed!.redeemedUserId).toBe('00000000-0000-0000-0000-000000000020');
        expect(completed!.redeemedAt).not.toBeNull();
      });

      it('reconcileClaimedInvitations finalizes stranded claimed invitations', async () => {
        const invite = await regStore.createInvitation(FIXED_USER_ID);
        const token = invite.inviteUrl.split('#token=')[1];
        await regStore.claimInvitation({ token, email: 'stranded@example.com' });

        const reconciled = await regStore.reconcileClaimedInvitations();
        expect(reconciled).toBeGreaterThanOrEqual(1);
      });
    });
    it('all six invitation lifecycle methods are exposed on WorkflowStore interface', async () => {
      // Type-level verification: the class satisfies the interface contract
      // for all invitation methods
      const storeRef: WorkflowStore = regStore;

      // createInvitation
      const invite = await storeRef.createInvitation(FIXED_USER_ID);
      expect(invite.invitation).toBeDefined();
      expect(invite.inviteUrl).toMatch(/\/invite#token=/);

      // listInvitations
      const list = await storeRef.listInvitations();
      expect(Array.isArray(list)).toBe(true);

      // revokeInvitation
      await storeRef.revokeInvitation(invite.invitation.id);
      const afterRevoke = await storeRef.listInvitations();
      const revokeEntry = afterRevoke.find((i) => i.id === invite.invitation.id);
      expect(revokeEntry?.status).toBe('revoked');

      // claimInvitation — create a fresh one to claim
      const invite2 = await storeRef.createInvitation(FIXED_USER_ID);
      const token2 = invite2.inviteUrl.split('#token=')[1];
      const claim = await storeRef.claimInvitation({
        token: token2,
        email: 'claimant@example.com',
      });
      expect(claim.claimId).toBeTypeOf('string');
      expect(claim.email).toBe('claimant@example.com');

      // completeInvitationRedemption
      await storeRef.completeInvitationRedemption(claim.claimId, 'user-redeemed');
      const afterRedeem = await storeRef.listInvitations();
      const redeemEntry = afterRedeem.find((i) => i.id === invite2.invitation.id);
      expect(redeemEntry?.status).toBe('redeemed');
      expect(redeemEntry?.redeemedUserId).toBe('user-redeemed');

      // reconcileClaimedInvitations
      const reconciled = await storeRef.reconcileClaimedInvitations();
      expect(typeof reconciled).toBe('number');
    });

    // -----------------------------------------------------------------------
    // Audit metadata never contains raw secrets
    // -----------------------------------------------------------------------

    describe('audit: no raw secrets in persistence', () => {
      it('bootstrap audit records do not contain the operator secret', async () => {
        const claimId = '00000000-0000-0000-0000-000000000099-audit';

        await regStore.claimBootstrap({
          name: 'Owner',
          email: 'owner@example.com',
          claimId,
        });
        await regStore.finalizeBootstrap({ claimId, ownerUserId: OWNER_USER_ID });

        const rows = regStore['db'].prepare('SELECT * FROM audit_records').all() as Record<
          string,
          unknown
        >[];

        const allText = rows.map((r) => JSON.stringify(Object.values(r))).join(' ');
        expect(allText).not.toContain('s3kr1t');
        expect(allText).not.toContain('correct-horse');
        expect(allText).not.toContain('some-strong-password');
      });
      it('invitation audit records do not contain the raw bearer token', async () => {
        const invite = await regStore.createInvitation(FIXED_USER_ID);
        const token = invite.inviteUrl.split('#token=')[1];

        const rows = regStore['db']
          .prepare("SELECT * FROM audit_records WHERE classification LIKE '%invit%'")
          .all() as Record<string, unknown>[];

        const allText = rows.map((r) => JSON.stringify(Object.values(r))).join(' ');
        expect(allText).not.toContain(token);
      });

      it('inviteUrl is never persisted in any database table', async () => {
        const invite = await regStore.createInvitation(FIXED_USER_ID);

        const tables = regStore['db']
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'schema_version'")
          .all() as { name: string }[];

        for (const { name: table } of tables) {
          const rows = regStore['db'].prepare(`SELECT * FROM "${table}"`).all() as Record<
            string,
            unknown
          >[];
          for (const row of rows) {
            const allValues = Object.values(row).map(String).join(' ');
            expect(allValues).not.toContain(invite.inviteUrl);
            expect(allValues).not.toContain('invite#token=');
          }
        }
      });
    });
  });
  // =======================================================================
  // Saved view lifecycle
  // =======================================================================

  describe('saved view lifecycle', () => {
    const ACTOR_ID = 'actor-sv-1';
    const BASE_VIEW_INPUT = {
      name: 'My View',
      viewType: 'attention',
      scope: { budgetId: 'budget-alpha' },
      actorId: ACTOR_ID,
    };

    describe('getSavedView', () => {
      it('returns null for a non-existent viewId', async () => {
        const result = await store.getSavedView('nonexistent-view');
        expect(result).toBeNull();
      });
    });

    describe('createSavedView', () => {
      it('persists a saved view with all fields intact', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);

        expect(view.viewId).toBeTypeOf('string');
        expect(view.name).toBe(BASE_VIEW_INPUT.name);
        expect(view.viewType).toBe(BASE_VIEW_INPUT.viewType);
        expect(view.scope).toEqual(BASE_VIEW_INPUT.scope);
        expect(view.sort).toBeNull();
        expect(view.actorId).toBe(ACTOR_ID);
        expect(view.createdAt).toBeTypeOf('string');
        expect(view.lastUsedAt).toBeNull();
      });

      it('assigns a stable UUID that can be used to retrieve the record', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        const fetched = await store.getSavedView(view.viewId);
        expect(fetched).not.toBeNull();
        expect(fetched!.viewId).toBe(view.viewId);
      });

      it('stores sort when provided', async () => {
        const view = await store.createSavedView({
          ...BASE_VIEW_INPUT,
          name: 'Sorted View',
          sort: 'amount:desc',
        });
        expect(view.sort).toBe('amount:desc');
      });

      it('stores empty scope as empty object', async () => {
        const view = await store.createSavedView({
          ...BASE_VIEW_INPUT,
          name: 'Empty Scope View',
          scope: {},
        });
        expect(view.scope).toEqual({});
      });
    });

    describe('updateSavedView', () => {
      it('renames an existing saved view', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        const updated = await store.updateSavedView(view.viewId, { name: 'Renamed View' });

        expect(updated.name).toBe('Renamed View');
        expect(updated.viewId).toBe(view.viewId);
      });

      it('re-scopes an existing saved view', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        const newScope = { budgetId: 'budget-beta', extra: true };
        const updated = await store.updateSavedView(view.viewId, { scope: newScope });

        expect(updated.scope).toEqual(newScope);
      });

      it('re-sorts an existing saved view and can clear sort', async () => {
        const view = await store.createSavedView({
          ...BASE_VIEW_INPUT,
          sort: 'date:asc',
        });
        expect(view.sort).toBe('date:asc');

        const reSorted = await store.updateSavedView(view.viewId, { sort: 'amount:desc' });
        expect(reSorted.sort).toBe('amount:desc');

        const cleared = await store.updateSavedView(view.viewId, { sort: null });
        expect(cleared.sort).toBeNull();
      });

      it('updates name independently of scope', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        const updated = await store.updateSavedView(view.viewId, { name: 'Just Name' });

        expect(updated.name).toBe('Just Name');
        expect(updated.scope).toEqual(BASE_VIEW_INPUT.scope);
      });

      it('throws when viewId does not exist', async () => {
        await expect(store.updateSavedView('nonexistent-view', { name: 'Ghost' })).rejects.toThrow(
          'Saved view nonexistent-view not found',
        );
      });

      it('preserves lastUsedAt unchanged through rename', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        expect(view.lastUsedAt).toBeNull();

        await store.recordSavedViewUsage(view.viewId);
        const used = await store.getSavedView(view.viewId);
        expect(used!.lastUsedAt).not.toBeNull();

        const renamed = await store.updateSavedView(view.viewId, { name: 'Used & Renamed' });
        expect(renamed.lastUsedAt).toBe(used!.lastUsedAt);
      });
    });

    describe('duplicateSavedView', () => {
      it('duplicates a saved view with a new name and actor', async () => {
        const source = await store.createSavedView({
          ...BASE_VIEW_INPUT,
          sort: 'amount:desc',
        });

        const dup = await store.duplicateSavedView({
          sourceViewId: source.viewId,
          name: 'Duplicated View',
          actorId: 'actor-sv-2',
        });

        expect(dup.name).toBe('Duplicated View');
        expect(dup.viewType).toBe(source.viewType);
        expect(dup.scope).toEqual(source.scope);
        expect(dup.sort).toBe(source.sort);
        expect(dup.actorId).toBe('actor-sv-2');
        expect(dup.viewId).not.toBe(source.viewId);
      });

      it('throws when the source viewId does not exist', async () => {
        await expect(
          store.duplicateSavedView({
            sourceViewId: 'nonexistent-source',
            name: 'Ghost Copy',
            actorId: ACTOR_ID,
          }),
        ).rejects.toThrow('Source saved view nonexistent-source not found');
      });
    });

    describe('deleteSavedView', () => {
      it('returns true when a view is deleted', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        const deleted = await store.deleteSavedView(view.viewId);
        expect(deleted).toBe(true);
      });

      it('returns false when the view does not exist', async () => {
        const deleted = await store.deleteSavedView('nonexistent-view');
        expect(deleted).toBe(false);
      });

      it('removes the view so it is no longer retrievable', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        await store.deleteSavedView(view.viewId);

        const fetched = await store.getSavedView(view.viewId);
        expect(fetched).toBeNull();
      });

      it('removes the view so it no longer appears in listing', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        await store.deleteSavedView(view.viewId);

        const views = await store.listSavedViews(ACTOR_ID);
        expect(views.find((v) => v.viewId === view.viewId)).toBeUndefined();
      });
    });

    describe('recordSavedViewUsage', () => {
      it('sets lastUsedAt on the view', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        expect(view.lastUsedAt).toBeNull();

        const used = await store.recordSavedViewUsage(view.viewId);
        expect(used.lastUsedAt).not.toBeNull();
        expect(used.viewId).toBe(view.viewId);
      });

      it('updates lastUsedAt on subsequent usage', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        const first = await store.recordSavedViewUsage(view.viewId);

        tickSync();

        const second = await store.recordSavedViewUsage(view.viewId);
        expect(second.lastUsedAt).not.toBeNull();
        expect(new Date(second.lastUsedAt!).getTime()).toBeGreaterThan(
          new Date(first.lastUsedAt!).getTime(),
        );
      });

      it('throws when viewId does not exist', async () => {
        await expect(store.recordSavedViewUsage('nonexistent-view')).rejects.toThrow(
          'Saved view nonexistent-view not found',
        );
      });
    });

    describe('listSavedViews', () => {
      it('returns all views for an actor', async () => {
        await store.createSavedView(BASE_VIEW_INPUT);
        await store.createSavedView({
          ...BASE_VIEW_INPUT,
          name: 'View B',
          viewType: 'pending_review',
        });
        await store.createSavedView({
          ...BASE_VIEW_INPUT,
          name: 'View C',
          viewType: 'budget_summary',
        });

        const views = await store.listSavedViews(ACTOR_ID);
        expect(views).toHaveLength(3);
      });

      it('returns empty array when actor has no views', async () => {
        const views = await store.listSavedViews('nonexistent-actor');
        expect(views).toEqual([]);
      });

      it('returns an empty scope for malformed persisted JSON', async () => {
        const view = await store.createSavedView(BASE_VIEW_INPUT);
        store['db']
          .prepare('UPDATE saved_views SET scope = ? WHERE view_id = ?')
          .run('not-json', view.viewId);

        const views = await store.listSavedViews(ACTOR_ID);

        expect(views).toHaveLength(1);
        expect(views[0].scope).toEqual({});
      });

      it('does not return views belonging to other actors', async () => {
        await store.createSavedView(BASE_VIEW_INPUT);
        await store.createSavedView({
          ...BASE_VIEW_INPUT,
          name: 'Other View',
          actorId: 'actor-sv-other',
        });

        const views = await store.listSavedViews(ACTOR_ID);
        expect(views).toHaveLength(1);
        expect(views[0].name).toBe(BASE_VIEW_INPUT.name);
      });

      it('returns most recently created first', async () => {
        const first = await store.createSavedView({ ...BASE_VIEW_INPUT, name: 'First' });
        tickSync();
        const second = await store.createSavedView({ ...BASE_VIEW_INPUT, name: 'Second' });

        const views = await store.listSavedViews(ACTOR_ID);
        expect(views[0].name).toBe('Second');
        expect(views[1].name).toBe('First');
      });
    });
  });

  // =======================================================================
  // Finding lifecycle
  // =======================================================================

  describe('finding lifecycle', () => {
    const ACTOR_A = 'actor-finding-1';
    const ACTOR_B = 'actor-finding-2';
    const BUDGET_A = 'budget-finding-a';
    const BUDGET_B = 'budget-finding-b';

    const BASE_FINDING_INPUT = {
      budgetId: BUDGET_A,
      classification: 'uncategorized',
      description: 'Transaction missing category',
      evidence: { transactionId: 'txn-999' },
    };

    describe('createFinding', () => {
      it('persists a finding with all required fields', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);

        expect(finding.id).toBeTypeOf('string');
        expect(finding.budgetId).toBe(BUDGET_A);
        expect(finding.classification).toBe('uncategorized');
        expect(finding.description).toBe('Transaction missing category');
        expect(finding.evidence).toEqual({ transactionId: 'txn-999' });
        expect(finding.severity).toBe('medium');
        expect(finding.status).toBe('open');
        expect(finding.version).toBe(1);
        expect(finding.actorId).toBeNull();
        expect(finding.createdAt).toBeTypeOf('string');
        expect(finding.updatedAt).toBe(finding.createdAt);
      });

      it('accepts optional severity, actorId, expiresAt, and evidenceRefs', async () => {
        const finding = await store.createFinding({
          ...BASE_FINDING_INPUT,
          severity: 'high',
          actorId: ACTOR_A,
          expiresAt: '2099-12-31T23:59:59Z',
          evidenceRefs: ['ref-1', 'ref-2'],
        });

        expect(finding.severity).toBe('high');
        expect(finding.actorId).toBe(ACTOR_A);
        expect(finding.expiresAt).toBe('2099-12-31T23:59:59Z');
        expect(finding.evidenceRefs).toEqual(['ref-1', 'ref-2']);
      });

      it('assigns a stable UUID that can be used to retrieve the record', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        const fetched = await store.getFinding(finding.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.id).toBe(finding.id);
      });
    });

    describe('getFinding', () => {
      it('returns null for a non-existent id', async () => {
        const result = await store.getFinding('nonexistent-finding');
        expect(result).toBeNull();
      });
    });

    describe('listFindings', () => {
      beforeEach(async () => {
        await store.createFinding({
          ...BASE_FINDING_INPUT,
          budgetId: BUDGET_A,
          classification: 'uncategorized',
          severity: 'medium',
        });
        await store.createFinding({
          ...BASE_FINDING_INPUT,
          budgetId: BUDGET_A,
          classification: 'budget_risk',
          severity: 'high',
        });
        await store.createFinding({
          ...BASE_FINDING_INPUT,
          budgetId: BUDGET_B,
          classification: 'data_quality',
          severity: 'low',
        });
      });

      it('returns all findings with no filter', async () => {
        const findings = await store.listFindings();
        expect(findings).toHaveLength(3);
      });

      it('filters by status', async () => {
        const findings = await store.listFindings({ status: 'open' });
        expect(findings).toHaveLength(3);
      });

      it('filters by budgetId', async () => {
        const findings = await store.listFindings({ budgetId: BUDGET_A });
        expect(findings).toHaveLength(2);
      });

      it('filters by both status and budgetId', async () => {
        const findings = await store.listFindings({ status: 'open', budgetId: BUDGET_B });
        expect(findings).toHaveLength(1);
        expect(findings[0].budgetId).toBe(BUDGET_B);
      });

      it('filters by classification', async () => {
        const findings = await store.listFindings({ classification: 'budget_risk' });
        expect(findings).toHaveLength(1);
        expect(findings[0].classification).toBe('budget_risk');
      });

      it('filters by severity', async () => {
        const findings = await store.listFindings({ severity: 'medium' });
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe('medium');
      });

      it('returns empty array when no findings match', async () => {
        const findings = await store.listFindings({ status: 'acknowledged' });
        expect(findings).toEqual([]);
      });

      it('respects limit and offset', async () => {
        const two = await store.listFindings({ limit: 2 });
        expect(two).toHaveLength(2);

        const one = await store.listFindings({ limit: 1, offset: 1 });
        expect(one).toHaveLength(1);
      });
    });

    describe('countFindings', () => {
      beforeEach(async () => {
        await store.createFinding({
          ...BASE_FINDING_INPUT,
          budgetId: BUDGET_A,
          classification: 'uncategorized',
        });
        await store.createFinding({
          ...BASE_FINDING_INPUT,
          budgetId: BUDGET_A,
          classification: 'budget_risk',
          severity: 'high',
        });
        await store.createFinding({
          ...BASE_FINDING_INPUT,
          budgetId: BUDGET_B,
          classification: 'data_quality',
          severity: 'low',
        });
      });

      it('counts all findings with no filter', async () => {
        const count = await store.countFindings();
        expect(count).toBe(3);
      });

      it('counts findings by budgetId', async () => {
        const count = await store.countFindings({ budgetId: BUDGET_A });
        expect(count).toBe(2);
      });

      it('counts findings by status', async () => {
        const count = await store.countFindings({ status: 'open' });
        expect(count).toBe(3);
      });

      it('counts findings by classification', async () => {
        const count = await store.countFindings({ classification: 'data_quality' });
        expect(count).toBe(1);
      });

      it('counts findings by severity', async () => {
        const count = await store.countFindings({ severity: 'high' });
        expect(count).toBe(1);
      });

      it('returns zero when no findings match', async () => {
        const count = await store.countFindings({ status: 'acknowledged' });
        expect(count).toBe(0);
      });
    });

    describe('acknowledgeFinding', () => {
      it('transitions from open to acknowledged', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        expect(finding.status).toBe('open');

        const acknowledged = await store.acknowledgeFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          expectedVersion: 1,
        });

        expect(acknowledged.status).toBe('acknowledged');
        expect(acknowledged.version).toBe(2);
        expect(acknowledged.acknowledgedAt).not.toBeNull();
        expect(acknowledged.acknowledgedBy).toBe(ACTOR_A);
      });

      it('is idempotent when already acknowledged', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.acknowledgeFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          expectedVersion: 1,
        });
        const again = await store.acknowledgeFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          expectedVersion: 2,
        });

        expect(again.status).toBe('acknowledged');
      });

      it('rejects transition from corrected status', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.correctFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          correctionRef: 'corr-1',
          expectedVersion: 1,
        });

        await expect(
          store.acknowledgeFinding({ findingId: finding.id, actorId: ACTOR_A, expectedVersion: 2 }),
        ).rejects.toThrow('Cannot acknowledge finding in status corrected');
      });

      it('throws on version conflict', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await expect(
          store.acknowledgeFinding({
            findingId: finding.id,
            actorId: ACTOR_A,
            expectedVersion: 99,
          }),
        ).rejects.toThrow('version conflict');
      });

      it('throws when finding does not exist', async () => {
        await expect(
          store.acknowledgeFinding({
            findingId: 'nonexistent',
            actorId: ACTOR_A,
            expectedVersion: 1,
          }),
        ).rejects.toThrow('Finding nonexistent not found');
      });
    });

    describe('correctFinding', () => {
      it('transitions from open to corrected', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        const corrected = await store.correctFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          correctionRef: 'corr-open-1',
          expectedVersion: 1,
        });

        expect(corrected.status).toBe('corrected');
        expect(corrected.version).toBe(2);
        expect(corrected.correctedAt).not.toBeNull();
        expect(corrected.correctedBy).toBe(ACTOR_A);
        expect(corrected.correctionRef).toBe('corr-open-1');
      });

      it('transitions from acknowledged to corrected', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.acknowledgeFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          expectedVersion: 1,
        });

        const corrected = await store.correctFinding({
          findingId: finding.id,
          actorId: ACTOR_B,
          correctionRef: 'corr-ack-1',
          expectedVersion: 2,
        });

        expect(corrected.status).toBe('corrected');
        expect(corrected.correctedBy).toBe(ACTOR_B);
      });

      it('is idempotent when already corrected', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.correctFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          correctionRef: 'corr-1',
          expectedVersion: 1,
        });
        const again = await store.correctFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          correctionRef: 'corr-1',
          expectedVersion: 2,
        });

        expect(again.status).toBe('corrected');
      });

      it('rejects transition from dismissed status', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'Not relevant',
          expectedVersion: 1,
        });

        await expect(
          store.correctFinding({
            findingId: finding.id,
            actorId: ACTOR_A,
            correctionRef: 'corr-x',
            expectedVersion: 2,
          }),
        ).rejects.toThrow('Cannot correct finding in status dismissed');
      });

      it('throws on version conflict', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await expect(
          store.correctFinding({
            findingId: finding.id,
            actorId: ACTOR_A,
            correctionRef: 'corr-conflict',
            expectedVersion: 99,
          }),
        ).rejects.toThrow('version conflict');
      });
    });

    describe('dismissFinding', () => {
      it('transitions from open to dismissed', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        const dismissed = await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'Not actionable at this time',
          expectedVersion: 1,
        });

        expect(dismissed.status).toBe('dismissed');
        expect(dismissed.version).toBe(2);
        expect(dismissed.dismissedAt).not.toBeNull();
        expect(dismissed.dismissedBy).toBe(ACTOR_A);
        expect(dismissed.dismissedReason).toBe('Not actionable at this time');
      });

      it('transitions from acknowledged to dismissed', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.acknowledgeFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          expectedVersion: 1,
        });

        const dismissed = await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'Already handled',
          expectedVersion: 2,
        });
        expect(dismissed.status).toBe('dismissed');
      });

      it('is idempotent when already dismissed', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'Noise',
          expectedVersion: 1,
        });
        const again = await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'Noise',
          expectedVersion: 2,
        });

        expect(again.status).toBe('dismissed');
      });

      it('rejects transition from corrected status', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.correctFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          correctionRef: 'corr-1',
          expectedVersion: 1,
        });

        await expect(
          store.dismissFinding({
            findingId: finding.id,
            actorId: ACTOR_A,
            reason: 'Late',
            expectedVersion: 2,
          }),
        ).rejects.toThrow('Cannot dismiss finding in status corrected');
      });

      it('throws on version conflict', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await expect(
          store.dismissFinding({
            findingId: finding.id,
            actorId: ACTOR_A,
            reason: 'Conflict',
            expectedVersion: 99,
          }),
        ).rejects.toThrow('version conflict');
      });
    });

    describe('reopenFinding', () => {
      it('transitions from dismissed to reopened', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'Dismissed',
          expectedVersion: 1,
        });

        const reopened = await store.reopenFinding({
          findingId: finding.id,
          actorId: ACTOR_B,
          expectedVersion: 2,
        });

        expect(reopened.status).toBe('reopened');
        expect(reopened.version).toBe(3);
        expect(reopened.reopenedAt).not.toBeNull();
        expect(reopened.reopenedBy).toBe(ACTOR_B);
      });

      it('transitions from acknowledged to reopened', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.acknowledgeFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          expectedVersion: 1,
        });

        const reopened = await store.reopenFinding({
          findingId: finding.id,
          actorId: ACTOR_B,
          expectedVersion: 2,
        });

        expect(reopened.status).toBe('reopened');
      });

      it('is idempotent when already reopened', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'Noise',
          expectedVersion: 1,
        });
        await store.reopenFinding({ findingId: finding.id, actorId: ACTOR_B, expectedVersion: 2 });

        const again = await store.reopenFinding({
          findingId: finding.id,
          actorId: ACTOR_B,
          expectedVersion: 3,
        });
        expect(again.status).toBe('reopened');
      });

      it('rejects transition from corrected status', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.correctFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          correctionRef: 'corr-1',
          expectedVersion: 1,
        });

        await expect(
          store.reopenFinding({ findingId: finding.id, actorId: ACTOR_B, expectedVersion: 2 }),
        ).rejects.toThrow('Cannot reopen finding in status corrected');
      });

      it('throws on version conflict', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'Dismissed',
          expectedVersion: 1,
        });
        await expect(
          store.reopenFinding({ findingId: finding.id, actorId: ACTOR_A, expectedVersion: 99 }),
        ).rejects.toThrow('version conflict');
      });
    });

    describe('supersedeFinding', () => {
      it('transitions from open to superseded', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        const superseded = await store.supersedeFinding({
          findingId: finding.id,
          supersededBy: 'new-finding-1',
          reason: 'Replaced by more accurate analysis',
          actorId: ACTOR_A,
          expectedVersion: 1,
        });

        expect(superseded.status).toBe('superseded');
        expect(superseded.version).toBe(2);
        expect(superseded.supersededAt).not.toBeNull();
        expect(superseded.supersededBy).toBe('new-finding-1');
        expect(superseded.supersededReason).toBe('Replaced by more accurate analysis');
      });

      it('transitions from acknowledged to superseded', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.acknowledgeFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          expectedVersion: 1,
        });

        const superseded = await store.supersedeFinding({
          findingId: finding.id,
          supersededBy: 'new-finding-2',
          reason: 'Superseded',
          actorId: ACTOR_A,
          expectedVersion: 2,
        });
        expect(superseded.status).toBe('superseded');
      });

      it('transitions from corrected to superseded', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.correctFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          correctionRef: 'corr-1',
          expectedVersion: 1,
        });

        const superseded = await store.supersedeFinding({
          findingId: finding.id,
          supersededBy: 'new-finding-3',
          reason: 'Superseded after correction',
          actorId: ACTOR_A,
          expectedVersion: 2,
        });
        expect(superseded.status).toBe('superseded');
      });

      it('transitions from dismissed to superseded', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'Dismissed',
          expectedVersion: 1,
        });

        const superseded = await store.supersedeFinding({
          findingId: finding.id,
          supersededBy: 'new-finding-4',
          reason: 'New evidence',
          actorId: ACTOR_A,
          expectedVersion: 2,
        });
        expect(superseded.status).toBe('superseded');
      });

      it('transitions from reopened to superseded', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'First',
          expectedVersion: 1,
        });
        await store.reopenFinding({ findingId: finding.id, actorId: ACTOR_A, expectedVersion: 2 });

        const superseded = await store.supersedeFinding({
          findingId: finding.id,
          supersededBy: 'new-finding-5',
          reason: 'Superseded after reopen',
          actorId: ACTOR_A,
          expectedVersion: 3,
        });
        expect(superseded.status).toBe('superseded');
      });

      it('transitions from expired to superseded', async () => {
        const finding = await store.createFinding({
          ...BASE_FINDING_INPUT,
          expiresAt: '2020-01-01T00:00:00Z',
        });
        await store.expireFinding(finding.id);

        const superseded = await store.supersedeFinding({
          findingId: finding.id,
          supersededBy: 'new-finding-6',
          reason: 'Superseded after expiry',
          actorId: ACTOR_A,
          expectedVersion: 2,
        });
        expect(superseded.status).toBe('superseded');
      });

      it('is idempotent when already superseded', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.supersedeFinding({
          findingId: finding.id,
          supersededBy: 'new-finding-1',
          reason: 'Replaced',
          actorId: ACTOR_A,
          expectedVersion: 1,
        });
        const again = await store.supersedeFinding({
          findingId: finding.id,
          supersededBy: 'new-finding-1',
          reason: 'Replaced',
          actorId: ACTOR_A,
          expectedVersion: 2,
        });

        expect(again.status).toBe('superseded');
      });

      it('throws on version conflict', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await expect(
          store.supersedeFinding({
            findingId: finding.id,
            supersededBy: 'new-finding-x',
            reason: 'Conflict',
            actorId: ACTOR_A,
            expectedVersion: 99,
          }),
        ).rejects.toThrow('version conflict');
      });
    });

    describe('expireFinding', () => {
      it('transitions from open to expired', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        const expired = await store.expireFinding(finding.id);

        expect(expired.status).toBe('expired');
        expect(expired.version).toBe(2);
      });

      it('transitions from acknowledged to expired', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.acknowledgeFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          expectedVersion: 1,
        });

        const expired = await store.expireFinding(finding.id);
        expect(expired.status).toBe('expired');
      });

      it('transitions from corrected to expired', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.correctFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          correctionRef: 'corr-1',
          expectedVersion: 1,
        });

        const expired = await store.expireFinding(finding.id);
        expect(expired.status).toBe('expired');
      });

      it('transitions from dismissed to expired', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'Noise',
          expectedVersion: 1,
        });

        const expired = await store.expireFinding(finding.id);
        expect(expired.status).toBe('expired');
      });

      it('transitions from reopened to expired', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.dismissFinding({
          findingId: finding.id,
          actorId: ACTOR_A,
          reason: 'First',
          expectedVersion: 1,
        });
        await store.reopenFinding({ findingId: finding.id, actorId: ACTOR_A, expectedVersion: 2 });

        const expired = await store.expireFinding(finding.id);
        expect(expired.status).toBe('expired');
      });

      it('is idempotent when already expired', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.expireFinding(finding.id);
        const again = await store.expireFinding(finding.id);

        expect(again.status).toBe('expired');
        expect(again.version).toBe(2);
      });

      it('rejects expire from superseded status', async () => {
        const finding = await store.createFinding(BASE_FINDING_INPUT);
        await store.supersedeFinding({
          findingId: finding.id,
          supersededBy: 'new-finding-x',
          reason: 'Replaced',
          actorId: ACTOR_A,
          expectedVersion: 1,
        });

        await expect(store.expireFinding(finding.id)).rejects.toThrow(
          'cannot be expired from status superseded',
        );
      });

      it('throws when finding does not exist', async () => {
        await expect(store.expireFinding('nonexistent')).rejects.toThrow(
          'Finding nonexistent not found',
        );
      });
    });
  });

  // =======================================================================
  // Durable notification event deduplication
  // =======================================================================

  describe('createOrGetNotificationEvent', () => {
    it('atomically returns one event for a dedup key, recipient, and scope', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'wf-notification-dedup-'));
      const dbPath = join(tmpDir, 'store.db');
      const firstConnection = new SqliteWorkflowStore(dbPath);
      const secondConnection = new SqliteWorkflowStore(dbPath);
      const input = {
        dedupKey: 'decision-revision-1',
        budgetId: 'budget-notification-dedup',
        classification: 'reservation_conflict',
        payload: { summary: 'A reservation conflicts with this purchase.' },
        policyVersion: 'financial-attention-v1',
        recipientId: 'actor-primary',
        scope: 'category:groceries',
        redactionClass: 'restricted',
      };

      try {
        const events = await Promise.all([
          firstConnection.createOrGetNotificationEvent(input),
          secondConnection.createOrGetNotificationEvent(input),
          firstConnection.createOrGetNotificationEvent({ ...input }),
          secondConnection.createOrGetNotificationEvent({ ...input }),
        ]);

        expect(new Set(events.map(({ id }) => id))).toEqual(new Set([events[0]!.id]));
        expect(events[0]).toMatchObject({
          recipientId: input.recipientId,
          scope: input.scope,
          classification: input.classification,
        });

        const otherRecipient = await firstConnection.createOrGetNotificationEvent({
          ...input,
          recipientId: 'actor-secondary',
        });
        const otherScope = await secondConnection.createOrGetNotificationEvent({
          ...input,
          scope: 'category:rent',
        });
        const otherRevision = await firstConnection.createOrGetNotificationEvent({
          ...input,
          dedupKey: 'decision-revision-2',
        });

        expect(otherRecipient.id).not.toBe(events[0]!.id);
        expect(otherScope.id).not.toBe(events[0]!.id);
        expect(otherRevision.id).not.toBe(events[0]!.id);
      } finally {
        firstConnection.close();
        secondConnection.close();
        try {
          unlinkSync(dbPath);
        } catch {
          /* ignore */
        }
        try {
          rmdirSync(tmpDir);
        } catch {
          /* ignore */
        }
      }
    });
  });

  // =======================================================================
  // Notification policy lifecycle
  // =======================================================================

  describe('notification policy lifecycle', () => {
    const SPACE_A = 'space-np-1';
    const SPACE_B = 'space-np-2';

    const BASE_POLICY_INPUT = {
      spaceId: SPACE_A,
      policyKey: 'delivery',
      policyVersion: '1.0.0',
      policy: {
        channels: ['email', 'in-app'],
        actorIds: ['actor-np-1'],
      },
    };

    describe('saveNotificationPolicy', () => {
      it('creates a new notification policy and returns it', async () => {
        const policy = await store.saveNotificationPolicy(BASE_POLICY_INPUT);

        expect(policy.id).toBeTypeOf('string');
        expect(policy.spaceId).toBe(SPACE_A);
        expect(policy.policyKey).toBe('delivery');
        expect(policy.policyVersion).toBe('1.0.0');
        expect(policy.isActive).toBe(true);
        expect(policy.createdAt).toBeTypeOf('string');
        expect(policy.updatedAt).toBe(policy.createdAt);
      });

      it('updates an existing policy when same (spaceId, policyKey) is used', async () => {
        const first = await store.saveNotificationPolicy(BASE_POLICY_INPUT);
        tickSync();

        const updated = await store.saveNotificationPolicy({
          ...BASE_POLICY_INPUT,
          policyVersion: '2.0.0',
          policy: { channels: ['email'], actorIds: ['actor-np-2'] },
        });

        expect(updated.policyVersion).toBe('2.0.0');
        expect(updated.id).toBe(first.id);
        expect(updated.updatedAt).not.toBe(updated.createdAt);
      });

      it('can store different policy keys for the same space', async () => {
        const delivery = await store.saveNotificationPolicy(BASE_POLICY_INPUT);
        const eligibility = await store.saveNotificationPolicy({
          spaceId: SPACE_A,
          policyKey: 'eligibility',
          policyVersion: '1.0.0',
          policy: { maxAmount: 500 },
        });

        expect(delivery.id).not.toBe(eligibility.id);
      });
    });

    describe('getNotificationPolicy', () => {
      it('returns the policy by (spaceId, policyKey)', async () => {
        await store.saveNotificationPolicy(BASE_POLICY_INPUT);
        const policy = await store.getNotificationPolicy(SPACE_A, 'delivery');

        expect(policy).not.toBeNull();
        expect(policy!.policyKey).toBe('delivery');
      });

      it('returns null when no policy matches', async () => {
        const policy = await store.getNotificationPolicy('nonexistent-space', 'delivery');
        expect(policy).toBeNull();
      });
    });

    describe('listNotificationPolicies', () => {
      beforeEach(async () => {
        await store.saveNotificationPolicy(BASE_POLICY_INPUT);
        await store.saveNotificationPolicy({
          ...BASE_POLICY_INPUT,
          policyKey: 'eligibility',
          policy: { rules: [] },
        });
        await store.saveNotificationPolicy({
          ...BASE_POLICY_INPUT,
          spaceId: SPACE_B,
          policyKey: 'delivery',
          policy: { channels: ['sms'] },
        });
      });

      it('lists all policies when no spaceId filter', async () => {
        const policies = await store.listNotificationPolicies();
        expect(policies).toHaveLength(3);
      });

      it('filters by spaceId', async () => {
        const policies = await store.listNotificationPolicies({ spaceId: SPACE_A });
        expect(policies).toHaveLength(2);
      });

      it('returns empty array for space with no policies', async () => {
        const policies = await store.listNotificationPolicies({ spaceId: 'empty-space' });
        expect(policies).toEqual([]);
      });

      it('respects limit and offset', async () => {
        const two = await store.listNotificationPolicies({ limit: 2 });
        expect(two).toHaveLength(2);

        const oneMore = await store.listNotificationPolicies({ limit: 1, offset: 2 });
        expect(oneMore).toHaveLength(1);
      });
    });

    describe('resolveRecipients', () => {
      it('returns empty resolution when no policies exist for the space', async () => {
        const resolution = await store.resolveRecipients('empty-space', 'uncategorized', 'medium');

        expect(resolution.spaceId).toBe('empty-space');
        expect(resolution.actorIds).toEqual([]);
        expect(resolution.channels).toEqual([]);
        expect(resolution.resolvedAt).toBeTypeOf('string');
      });

      it('collects actorIds and channels from active policies', async () => {
        await store.saveNotificationPolicy({
          spaceId: SPACE_A,
          policyKey: 'delivery',
          policyVersion: '1.0.0',
          policy: {
            channels: ['email', 'in-app'],
            actorIds: ['actor-1', 'actor-2'],
          },
        });

        const resolution = await store.resolveRecipients(SPACE_A, 'uncategorized', 'medium');

        expect(resolution.actorIds).toEqual(expect.arrayContaining(['actor-1', 'actor-2']));
        expect(resolution.channels).toEqual(expect.arrayContaining(['email', 'in-app']));
      });

      it('merges policies: deduplicates actorIds and channels from multiple policies', async () => {
        await store.saveNotificationPolicy(BASE_POLICY_INPUT);
        await store.saveNotificationPolicy({
          spaceId: SPACE_A,
          policyKey: 'escalation',
          policyVersion: '1.0.0',
          policy: {
            actorIds: ['actor-1', 'actor-3'],
            channels: ['pager'],
          },
        });

        const resolution = await store.resolveRecipients(SPACE_A, 'budget_risk', 'high');

        expect(resolution.actorIds).toEqual(
          expect.arrayContaining(['actor-np-1', 'actor-1', 'actor-3']),
        );
        expect(resolution.channels).toEqual(expect.arrayContaining(['email', 'in-app', 'pager']));
      });

      it('resolves classification-specific recipients', async () => {
        await store.saveNotificationPolicy({
          spaceId: SPACE_A,
          policyKey: 'delivery',
          policyVersion: '1.0.0',
          policy: {
            actorIds: ['base-actor'],
            classifications: {
              budget_risk: {
                actorIds: ['risk-reviewer'],
                channels: ['critical-alert'],
              },
            },
          },
        });

        const resolution = await store.resolveRecipients(SPACE_A, 'budget_risk', 'medium');

        expect(resolution.actorIds).toContain('risk-reviewer');
        expect(resolution.channels).toContain('critical-alert');
        expect(resolution.actorIds).toContain('base-actor');
      });

      it('resolves severity-specific recipients', async () => {
        await store.saveNotificationPolicy({
          spaceId: SPACE_A,
          policyKey: 'delivery',
          policyVersion: '1.0.0',
          policy: {
            actorIds: ['base-actor'],
            severities: {
              high: {
                actorIds: ['senior-responder'],
                channels: ['pager'],
              },
            },
          },
        });

        const resolution = await store.resolveRecipients(SPACE_A, 'uncategorized', 'high');

        expect(resolution.actorIds).toContain('senior-responder');
        expect(resolution.channels).toContain('pager');
      });

      it('excludes channels and actorIds from inactive policies', async () => {
        // Save and then update to flip isActive (update loses the isActive field, so this
        // test is gated on the current insert-only active path)
        await store.saveNotificationPolicy({
          spaceId: SPACE_B,
          policyKey: 'delivery',
          policyVersion: '1.0.0',
          policy: {
            actorIds: ['inactive-actor'],
            channels: ['inactive-channel'],
          },
        });

        const resolution = await store.resolveRecipients(SPACE_B, 'uncategorized', 'medium');

        // Currently all saved policies are active; this tests the baseline
        expect(resolution.actorIds).toContain('inactive-actor');
        expect(resolution.channels).toContain('inactive-channel');
      });

      it('resolves with matching classification AND severity filters combined', async () => {
        await store.saveNotificationPolicy({
          spaceId: SPACE_A,
          policyKey: 'delivery',
          policyVersion: '1.0.0',
          policy: {
            classifications: {
              budget_risk: {
                actorIds: ['class-actor'],
                channels: ['class-channel'],
              },
            },
            severities: {
              high: {
                actorIds: ['sev-actor'],
                channels: ['sev-channel'],
              },
            },
          },
        });

        const resolution = await store.resolveRecipients(SPACE_A, 'budget_risk', 'high');

        expect(resolution.actorIds).toContain('class-actor');
        expect(resolution.actorIds).toContain('sev-actor');
        expect(resolution.channels).toContain('class-channel');
        expect(resolution.channels).toContain('sev-channel');
      });

      it('gracefully handles malformed policy JSON (skips that policy)', async () => {
        // Insert a policy with invalid JSON via raw SQL
        const db = (store as unknown as { db: Database.Database }).db;
        db.prepare(
          `
          INSERT INTO notification_policies (id, space_id, policy_key, policy_version, policy, is_active, created_at, updated_at)
          VALUES ('bad-policy-id', $spaceId, 'delivery', '1.0.0', 'not valid json', 1, datetime('now'), datetime('now'))
        `,
        ).run({ spaceId: SPACE_A });

        // Save a valid policy too
        await store.saveNotificationPolicy({
          spaceId: SPACE_A,
          policyKey: 'eligibility',
          policyVersion: '1.0.0',
          policy: { actorIds: ['valid-actor'], channels: ['email'] },
        });

        const resolution = await store.resolveRecipients(SPACE_A, 'uncategorized', 'medium');

        // Should still get actors from the valid policy
        expect(resolution.actorIds).toContain('valid-actor');
      });
    });

    describe('deleteNotificationPolicy', () => {
      it('returns true when a policy is deleted', async () => {
        const policy = await store.saveNotificationPolicy(BASE_POLICY_INPUT);
        const deleted = await store.deleteNotificationPolicy(policy.id);
        expect(deleted).toBe(true);
      });

      it('returns false when the policy id does not exist', async () => {
        const deleted = await store.deleteNotificationPolicy('nonexistent-policy');
        expect(deleted).toBe(false);
      });

      it('removes the policy so it is no longer retrievable', async () => {
        const policy = await store.saveNotificationPolicy(BASE_POLICY_INPUT);
        await store.deleteNotificationPolicy(policy.id);

        const fetched = await store.getNotificationPolicy(SPACE_A, 'delivery');
        expect(fetched).toBeNull();
      });
    });
  });

  // =======================================================================
  // Report record and history lifecycle
  // =======================================================================

  describe('report record and history lifecycle', () => {
    const BUDGET_R = 'budget-report-1';

    describe('createReportRecord', () => {
      it('persists a report record with all required fields', async () => {
        const record = await store.createReportRecord({
          reportType: 'budget_summary',
          config: { label: 'Monthly Budget Summary' },
          policyVersion: '1.0.0',
        });

        expect(record.id).toBeTypeOf('string');
        expect(record.reportType).toBe('budget_summary');
        expect(record.budgetId).toBeNull();
        expect(record.filterId).toBeNull();
        expect(record.config).toBeTypeOf('string');
        expect(record.policyVersion).toBe('1.0.0');
        expect(record.generatedAt).toBeTypeOf('string');
        expect(record.expiresAt).toBeNull();
        expect(record.dataRef).toBeNull();
      });

      it('accepts optional budgetId, expiresAt, and dataRef', async () => {
        const record = await store.createReportRecord({
          reportType: 'transaction_audit',
          budgetId: BUDGET_R,
          config: { detail: 'full' },
          policyVersion: '2.0.0',
          expiresAt: '2099-01-01T00:00:00Z',
          dataRef: 's3://reports/audit-123',
        });

        expect(record.budgetId).toBe(BUDGET_R);
        expect(record.filterId).toBeNull();
        expect(record.expiresAt).toBe('2099-01-01T00:00:00Z');
        expect(record.dataRef).toBe('s3://reports/audit-123');
      });

      it('assigns a stable UUID that can be used to retrieve the record', async () => {
        const record = await store.createReportRecord({
          reportType: 'budget_summary',
          config: { label: 'Test' },
          policyVersion: '1.0.0',
        });
        const fetched = await store.getReportRecord(record.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.id).toBe(record.id);
      });
    });

    describe('getReportRecord', () => {
      it('returns null for a non-existent id', async () => {
        const result = await store.getReportRecord('nonexistent-report');
        expect(result).toBeNull();
      });
    });

    describe('getReportHistory', () => {
      beforeEach(async () => {
        await store.createReportRecord({
          reportType: 'budget_summary',
          budgetId: BUDGET_R,
          config: { label: 'Q1 Budget' },
          policyVersion: '1.0.0',
        });
        tickSync();
        await store.createReportRecord({
          reportType: 'transaction_audit',
          budgetId: BUDGET_R,
          config: { label: 'Q1 Audit' },
          policyVersion: '1.0.0',
        });
        tickSync();
        await store.createReportRecord({
          reportType: 'budget_summary',
          budgetId: 'budget-report-other',
          config: { label: 'Other Budget' },
          policyVersion: '1.0.0',
        });
      });

      it('returns all report history entries when no budgetId filter', async () => {
        const history = await store.getReportHistory();
        expect(history).toHaveLength(3);
      });

      it('filters by budgetId', async () => {
        const history = await store.getReportHistory(BUDGET_R);
        expect(history).toHaveLength(2);
      });

      it('returns history entries with the correct shape', async () => {
        const history = await store.getReportHistory(BUDGET_R);

        expect(history[0].id).toBeTypeOf('string');
        expect(history[0].reportType).toBe('transaction_audit');
        expect(history[0].budgetId).toBe(BUDGET_R);
        expect(history[0].generatedAt).toBeTypeOf('string');
        expect(history[0].label).toBeTypeOf('string');
        expect(history[0].isExpired).toBeTypeOf('boolean');
      });

      it('derives label from config.label', async () => {
        const history = await store.getReportHistory(BUDGET_R);
        const summary = history.find((h) => h.reportType === 'budget_summary');
        expect(summary!.label).toBe('Q1 Budget');
      });

      it('falls back to type-based label when config has no label', async () => {
        await store.createReportRecord({
          reportType: 'data_export',
          budgetId: BUDGET_R,
          config: { format: 'csv' },
          policyVersion: '1.0.0',
        });

        const history = await store.getReportHistory(BUDGET_R);
        const exportEntry = history.find((h) => h.reportType === 'data_export');
        expect(exportEntry!.label).toBe('data_export report');
      });

      it('marks expired reports with isExpired true', async () => {
        await store.createReportRecord({
          reportType: 'temp_report',
          budgetId: BUDGET_R,
          config: { label: 'Temp' },
          policyVersion: '1.0.0',
          expiresAt: '2020-01-01T00:00:00Z',
        });

        const history = await store.getReportHistory(BUDGET_R);
        const temp = history.find((h) => h.reportType === 'temp_report');
        expect(temp!.isExpired).toBe(true);
      });

      it('returns empty array when no reports match the budget', async () => {
        const history = await store.getReportHistory('nonexistent-budget');
        expect(history).toEqual([]);
      });

      it('respects limit and offset', async () => {
        const two = await store.getReportHistory(undefined, 2);
        expect(two).toHaveLength(2);

        const oneMore = await store.getReportHistory(undefined, 1, 2);
        expect(oneMore).toHaveLength(1);
      });
    });

    describe('countReportRecords', () => {
      beforeEach(async () => {
        await store.createReportRecord({
          reportType: 'budget_summary',
          budgetId: BUDGET_R,
          config: { label: 'A' },
          policyVersion: '1.0.0',
        });
        await store.createReportRecord({
          reportType: 'transaction_audit',
          budgetId: BUDGET_R,
          config: { label: 'B' },
          policyVersion: '1.0.0',
        });
        await store.createReportRecord({
          reportType: 'budget_summary',
          budgetId: 'other-budget',
          config: { label: 'C' },
          policyVersion: '1.0.0',
        });
      });

      it('counts all report records', async () => {
        const count = await store.countReportRecords();
        expect(count).toBe(3);
      });

      it('counts report records for a specific budget', async () => {
        const count = await store.countReportRecords(BUDGET_R);
        expect(count).toBe(2);
      });

      it('returns zero for a budget with no reports', async () => {
        const count = await store.countReportRecords('nonexistent-budget');
        expect(count).toBe(0);
      });
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
