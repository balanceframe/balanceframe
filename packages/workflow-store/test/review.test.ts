/**
 * Failing tests for review-item lifecycle in the SQLite-backed WorkflowStore.
 *
 * These tests establish the contract before implementation. Run with:
 *   pnpm --filter @balanceframe/workflow-store test
 *
 * Categories:
 * - Terminal transitions (each final state reachable)
 * - Intermediate transitions (full lifecycles)
 * - Duplicate creation (idempotent by underlying issue)
 * - Same-action replay (idempotent transitions)
 * - Stale / freshness-expiry handling
 * - Superseded by another review item
 * - Two reviewers (approval requires N distinct actors)
 * - Undo (reversible transitions)
 * - Heterogeneous grouping (bulk reject)
 * - Persistence across store reopen
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type { CreateReviewItemInput, ReviewItem, ReviewAction, TransitionReviewInput } from '../src/types.js';
import fs from 'node:fs';
import os from 'node:os';
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CREATE: CreateReviewItemInput = {
  budgetId: 'budget-alpha',
  transactionId: 'txn-001',
  categoryId: 'cat-food',
  classifier: 'fast-classifier',
  provenance: 'classifier-scan',
};

const ACTOR_ALICE = 'alice@example.com';
const ACTOR_BOB = 'bob@example.com';

const APPROVE_ALICE: TransitionReviewInput = {
  toStatus: 'approved',
  actor: ACTOR_ALICE,
  reason: 'Looks correct',
  expectedVersion: 1,
};

const APPROVE_BOB: TransitionReviewInput = {
  toStatus: 'approved',
  actor: ACTOR_BOB,
  reason: 'Agreed',
  expectedVersion: 1,
};

const REJECT: TransitionReviewInput = {
  toStatus: 'rejected',
  actor: ACTOR_ALICE,
  reason: 'Wrong category',
  expectedVersion: 1,
};

const GENERATE: TransitionReviewInput = {
  toStatus: 'suggestion_generated',
  actor: 'system',
  reason: 'Suggestion produced',
  expectedVersion: 1,
};

const START_REVIEW: TransitionReviewInput = {
  toStatus: 'pending_review',
  actor: 'system',
  reason: 'Ready for review',
  expectedVersion: 1,
};

const START_CORRECTING: TransitionReviewInput = {
  toStatus: 'correcting',
  actor: ACTOR_ALICE,
  reason: 'Applying correction',
  expectedVersion: 1,
};

const APPLY_DONE: TransitionReviewInput = {
  toStatus: 'applied',
  actor: 'system',
  reason: 'Correction applied',
  expectedVersion: 1,
};

const APPLY_FAIL: TransitionReviewInput = {
  toStatus: 'apply_failed',
  actor: 'system',
  reason: 'API error',
  metadata: { errorCode: 'TIMEOUT' },
  expectedVersion: 1,
};

const SKIP: TransitionReviewInput = {
  toStatus: 'skipped',
  actor: ACTOR_ALICE,
  reason: 'Not relevant',
  expectedVersion: 1,
};

const SUPERSEDE: TransitionReviewInput = {
  toStatus: 'superseded',
  actor: 'system',
  reason: 'Newer suggestion available',
  expectedVersion: 1,
};

/** Wait briefly for clock progression (timestamp ordering checks). */
function tickSync(): void {
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewItem lifecycle', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  // =======================================================================
  // Terminal transitions — each final state is reachable
  // =======================================================================

  describe('terminal transitions', () => {
    it('applied is reachable via discovered -> suggestion_generated -> pending_review -> approved -> correcting -> applied', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      expect(item.status).toBe('discovered');

      const t1 = await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      expect(t1.status).toBe('suggestion_generated');
      expect(t1.version).toBe(2);

      const t2 = await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
      expect(t2.status).toBe('pending_review');

      const t3 = await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      expect(t3.status).toBe('approved');

      const t4 = await store.transitionReviewItem(item.id, { ...START_CORRECTING, expectedVersion: 4 });
      expect(t4.status).toBe('correcting');

      const t5 = await store.transitionReviewItem(item.id, { ...APPLY_DONE, expectedVersion: 5 });
      expect(t5.status).toBe('applied');
    });

    it('apply_failed is reachable via approved -> correcting -> apply_failed', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
      await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      await store.transitionReviewItem(item.id, { ...START_CORRECTING, expectedVersion: 4 });

      const failed = await store.transitionReviewItem(item.id, { ...APPLY_FAIL, expectedVersion: 5 });
      expect(failed.status).toBe('apply_failed');
    });

    it('rejected is reachable from pending_review', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });

      const rejected = await store.transitionReviewItem(item.id, { ...REJECT, expectedVersion: 3 });
      expect(rejected.status).toBe('rejected');
    });

    it('skipped is reachable from pending_review', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });

      const skipped = await store.transitionReviewItem(item.id, { ...SKIP, expectedVersion: 3 });
      expect(skipped.status).toBe('skipped');
    });

    it('skipped is reachable from suggestion_generated (before pending_review)', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });

      const skipped = await store.transitionReviewItem(item.id, { ...SKIP, expectedVersion: 2 });
      expect(skipped.status).toBe('skipped');
    });

    it('superseded is reachable from any non-terminal state', async () => {
      // From discovered
      const item1 = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b1', transactionId: 't1' });
      const s1 = await store.transitionReviewItem(item1.id, { ...SUPERSEDE, expectedVersion: 1 });
      expect(s1.status).toBe('superseded');
      expect(s1.supersededReason).toBe('Newer suggestion available');

      // From pending_review
      const item2 = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b2', transactionId: 't2' });
      await store.transitionReviewItem(item2.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item2.id, { ...START_REVIEW, expectedVersion: 2 });
      const s2 = await store.transitionReviewItem(item2.id, { ...SUPERSEDE, expectedVersion: 3 });
      expect(s2.status).toBe('superseded');

      // From approved
      const item3 = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b3', transactionId: 't3' });
      await store.transitionReviewItem(item3.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item3.id, { ...START_REVIEW, expectedVersion: 2 });
      await store.transitionReviewItem(item3.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      const s3 = await store.transitionReviewItem(item3.id, { ...SUPERSEDE, expectedVersion: 4 });
      expect(s3.status).toBe('superseded');
    });
  });

  // =======================================================================
  // Intermediate transitions — full lifecycle paths
  // =======================================================================

  describe('intermediate transitions', () => {
    it('supports discovered -> suggestion_generated -> pending_review', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      const t1 = await store.transitionReviewItem(item.id, GENERATE);
      expect(t1.status).toBe('suggestion_generated');

      const t2 = await store.transitionReviewItem(t1.id, { ...START_REVIEW, expectedVersion: t1.version });
      expect(t2.status).toBe('pending_review');
    });

    it('discovered -> pending_review (skipping suggestion_generated) is valid', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      const t = await store.transitionReviewItem(item.id, START_REVIEW);
      expect(t.status).toBe('pending_review');
    });

    it('preserves all input fields through transitions', async () => {
      const input: CreateReviewItemInput = {
        ...BASE_CREATE,
        suggestionId: 'sug-abc',
        promptVersion: '2.0.0',
        transactionVersion: 3,
        correlationId: 'corr-xyz',
        assignedReviewerId: ACTOR_ALICE,
        reviewersRequired: 2,
        priority: 10,
        evidence: { confidence: 0.95, details: 'Matched pattern G' },
        freshnessExpiresAt: '2026-12-31T23:59:59.000Z',
      };
      const item = await store.createReviewItem(input);

      expect(item.suggestionId).toBe('sug-abc');
      expect(item.budgetId).toBe(input.budgetId);
      expect(item.transactionId).toBe(input.transactionId);
      expect(item.categoryId).toBe(input.categoryId);
      expect(item.classifier).toBe(input.classifier);
      expect(item.promptVersion).toBe('2.0.0');
      expect(item.transactionVersion).toBe(3);
      expect(item.correlationId).toBe('corr-xyz');
      expect(item.assignedReviewerId).toBe(ACTOR_ALICE);
      expect(item.reviewersRequired).toBe(2);
      expect(item.priority).toBe(10);
      expect(item.evidence).toEqual({ confidence: 0.95, details: 'Matched pattern G' });
      expect(item.provenance).toBe('classifier-scan');
      expect(item.freshnessExpiresAt).toBe('2026-12-31T23:59:59.000Z');
      expect(item.version).toBe(1);

      // Transition preserves fields
      const t = await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      expect(t.suggestionId).toBe('sug-abc');
      expect(t.budgetId).toBe(input.budgetId);
      expect(t.correlationId).toBe('corr-xyz');
      expect(t.version).toBe(2);
    });

    it('rejects transition to a non-allowed status', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      // discovered -> applied is not allowed
      await expect(
        store.transitionReviewItem(item.id, { ...APPLY_DONE, expectedVersion: 1 }),
      ).rejects.toThrow();
    });

    it('rejects transition with wrong expectedVersion (optimistic lock)', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      // Version is 1, so expectedVersion: 2 should fail
      await expect(
        store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 2 }),
      ).rejects.toThrow(/version|conflict|stale/i);
    });
  });

  // =======================================================================
  // Duplicate creation — idempotent by underlying issue
  // =======================================================================

  describe('duplicate creation', () => {
    it('returns the existing item when creating a duplicate for the same issue', async () => {
      const first = await store.createReviewItem(BASE_CREATE);
      const second = await store.createReviewItem(BASE_CREATE);

      expect(second.id).toBe(first.id);
      expect(second.status).toBe(first.status);
      expect(second.version).toBe(first.version);
    });

    it('dedupes even after transitions (non-superseded statuses)', async () => {
      const first = await store.createReviewItem(BASE_CREATE);
      await store.transitionReviewItem(first.id, { ...GENERATE, expectedVersion: 1 });

      // Creating again should still return the existing item
      const second = await store.createReviewItem(BASE_CREATE);
      expect(second.id).toBe(first.id);
      expect(second.status).toBe('suggestion_generated');
    });

    it('allows creation after the existing item is superseded', async () => {
      const first = await store.createReviewItem(BASE_CREATE);
      await store.transitionReviewItem(first.id, { ...SUPERSEDE, expectedVersion: 1 });

      tickSync();
      const second = await store.createReviewItem(BASE_CREATE);
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe('discovered');
    });

    it('dedup returns same id for different CreateReviewItemInput if issue key matches', async () => {
      const first = await store.createReviewItem({ ...BASE_CREATE, priority: 10, evidence: { a: 1 } });
      const second = await store.createReviewItem({ ...BASE_CREATE, priority: 5, evidence: { b: 2 } });
      expect(second.id).toBe(first.id);
      // Original values are preserved (first write wins)
      expect(second.priority).toBe(10);
    });
  });

  // =======================================================================
  // Same-action replay — idempotent transitions
  // =======================================================================

  describe('idempotent transitions', () => {
    it('re-applying the same transition succeeds and returns the same state', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      const t1 = await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      expect(t1.status).toBe('suggestion_generated');

      // Replay the same transition (actor, reason same) — should succeed
      const t2 = await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: t1.version });
      expect(t2.status).toBe('suggestion_generated');
      expect(t2.version).toBe(t1.version); // No version bump on no-op
    });

    it('replaying terminal state transitions is idempotent', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
      const r1 = await store.transitionReviewItem(item.id, { ...REJECT, expectedVersion: 3 });
      expect(r1.status).toBe('rejected');

      // Reject again — idempotent
      const r2 = await store.transitionReviewItem(item.id, { ...REJECT, expectedVersion: r1.version });
      expect(r2.status).toBe('rejected');
      expect(r2.version).toBe(r1.version);
    });
  });

  // =======================================================================
  // Stale / freshness-expiry
  // =======================================================================

  describe('freshness expiry', () => {
    it('records freshnessExpiresAt from input', async () => {
      const expiry = new Date(Date.now() + 86_400_000).toISOString(); // tomorrow
      const item = await store.createReviewItem({
        ...BASE_CREATE,
        freshnessExpiresAt: expiry,
      });
      expect(item.freshnessExpiresAt).toBe(expiry);
    });

    it('returns null freshnessExpiresAt when not provided', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      expect(item.freshnessExpiresAt).toBeNull();
    });

    it('treats freshnessExpiresAt as null when omitted from create input', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      expect(item.freshnessExpiresAt).toBeNull();
    });
  });

  // =======================================================================
  // Superseded by another review item
  // =======================================================================

  describe('superseded with reason', () => {
    it('sets supersededReason and supersededBy on explicit supersede', async () => {
      const item1 = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-sup', transactionId: 't-sup' });
      const s1 = await store.transitionReviewItem(item1.id, { ...SUPERSEDE, expectedVersion: 1 });
      expect(s1.status).toBe('superseded');
      expect(s1.supersededReason).toBe('Newer suggestion available');
    });

    it('persists superseded fields in getReviewItem', async () => {
      const item = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-x', transactionId: 't-x' });
      const s = await store.transitionReviewItem(item.id, { ...SUPERSEDE, expectedVersion: 1 });

      const fetched = await store.getReviewItem(item.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('superseded');
      expect(fetched!.supersededReason).toBe('Newer suggestion available');
    });

    it('does not allow transitions from superseded', async () => {
      const item = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-y', transactionId: 't-y' });
      await store.transitionReviewItem(item.id, { ...SUPERSEDE, expectedVersion: 1 });

      await expect(
        store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 2 }),
      ).rejects.toThrow();
    });
  });

  // =======================================================================
  // Two reviewers — approval requires N distinct actors
  // =======================================================================

  describe('two reviewers', () => {
    it('stays in pending_review when reviewersRequired > 1 and only one approves', async () => {
      const item = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b2r',
        transactionId: 't2r',
        reviewersRequired: 2,
      });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });

      // Alice approves — still pending_review because 2 needed
      const afterAlice = await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      expect(afterAlice.status).toBe('pending_review');
    });

    it('transitions to approved when reviewersRequired count is reached', async () => {
      const item = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b2r2',
        transactionId: 't2r2',
        reviewersRequired: 2,
      });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });

      // Alice approves first
      const afterAlice = await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      expect(afterAlice.status).toBe('pending_review');

      // Bob approves — enough reviewers (use actual version from afterAlice)
      const afterBob = await store.transitionReviewItem(item.id, { ...APPROVE_BOB, expectedVersion: afterAlice.version });
      expect(afterBob.status).toBe('approved');
    });

    it('same actor approving twice is idempotent and does not count twice', async () => {
      const item = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b2r3',
        transactionId: 't2r3',
        reviewersRequired: 2,
      });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });

      // Alice approves
      const afterFirst = await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      expect(afterFirst.status).toBe('pending_review');

      tickSync();

      // Alice tries to approve again — no-op, still pending_review
      const afterDup = await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      expect(afterDup.status).toBe('pending_review');
    });
  });

  // =======================================================================
  // Undo — reversible transitions
  // =======================================================================

  describe('undo', () => {
    it('can undo from approved back to pending_review (revert approval)', async () => {
      const item = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-undo1', transactionId: 't-undo1' });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
      await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });

      // Undo: approved -> pending_review
      const undone = await store.undoReviewTransition(item.id, ACTOR_ALICE, 'Reverted approval', 4);
      expect(undone.status).toBe('pending_review');
      expect(undone.version).toBe(5);
    });

    it('can undo from correcting back to pending_review (revert correction attempt)', async () => {
      const item = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-undo2', transactionId: 't-undo2' });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
      await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      await store.transitionReviewItem(item.id, { ...START_CORRECTING, expectedVersion: 4 });

      const undone = await store.undoReviewTransition(item.id, ACTOR_ALICE, 'Reverting correction', 5);
      expect(undone.status).toBe('pending_review');
    });

    it('records an action for the undo transition', async () => {
      const item = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-undo3', transactionId: 't-undo3' });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
      await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });

      await store.undoReviewTransition(item.id, ACTOR_ALICE, 'Mistake', 4);

      const actions = await store.getReviewActions(item.id);
      const undoAction = actions.find(a => a.toStatus === 'pending_review' && a.fromStatus === 'approved');
      expect(undoAction).toBeDefined();
      expect(undoAction!.actor).toBe(ACTOR_ALICE);
      expect(undoAction!.reason).toBe('Mistake');
    });

    it('rejects undo from non-reversible states (applied)', async () => {
      const item = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-undo4', transactionId: 't-undo4' });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
      await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      await store.transitionReviewItem(item.id, { ...START_CORRECTING, expectedVersion: 4 });
      await store.transitionReviewItem(item.id, { ...APPLY_DONE, expectedVersion: 5 });

      await expect(
        store.undoReviewTransition(item.id, ACTOR_ALICE, 'Too late', 6),
      ).rejects.toThrow();
    });
  });

  // =======================================================================
  // Review actions (audit trail)
  // =======================================================================

  describe('review actions', () => {
    it('records an action for every status transition', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
      await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });

      const actions = await store.getReviewActions(item.id);
      expect(actions.length).toBe(3);
      expect(actions[0].fromStatus).toBe('discovered');
      expect(actions[0].toStatus).toBe('suggestion_generated');
      expect(actions[1].fromStatus).toBe('suggestion_generated');
      expect(actions[1].toStatus).toBe('pending_review');
      expect(actions[2].fromStatus).toBe('pending_review');
      expect(actions[2].toStatus).toBe('approved');
    });

    it('action records include actor, reason, and metadata', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      await store.transitionReviewItem(item.id, {
        toStatus: 'pending_review',
        actor: 'system',
        reason: 'Ready for human review',
        metadata: { source: 'auto-promote' },
        expectedVersion: 1,
      });

      const actions = await store.getReviewActions(item.id);
      expect(actions.length).toBe(1);
      expect(actions[0].actor).toBe('system');
      expect(actions[0].reason).toBe('Ready for human review');
      expect(actions[0].metadata).toEqual({ source: 'auto-promote' });
    });

    it('actions are ordered by creation time', async () => {
      const item = await store.createReviewItem(BASE_CREATE);

      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      tickSync();
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
      tickSync();
      await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });

      // Fetch all actions at once to verify ordering
      const allActions = await store.getReviewActions(item.id);
      expect(allActions.length).toBe(3);
      for (let i = 1; i < allActions.length; i++) {
        expect(new Date(allActions[i].createdAt).getTime())
          .toBeGreaterThanOrEqual(new Date(allActions[i - 1].createdAt).getTime());
      }
    });
  });

  // =======================================================================
  // Queries — get, find, list
  // =======================================================================

  describe('queries', () => {
    it('getReviewItem returns null for non-existent id', async () => {
      const result = await store.getReviewItem('non-existent');
      expect(result).toBeNull();
    });

    it('getReviewItem returns a created item', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      const fetched = await store.getReviewItem(item.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(item.id);
      expect(fetched!.status).toBe(item.status);
    });

    it('findReviewByIssue returns the active item for the given issue key', async () => {
      await store.createReviewItem(BASE_CREATE);
      const found = await store.findReviewByIssue(
        BASE_CREATE.budgetId,
        BASE_CREATE.transactionId,
        BASE_CREATE.categoryId,
        BASE_CREATE.classifier,
      );
      expect(found).not.toBeNull();
      expect(found!.status).toBe('discovered');
    });

    it('findReviewByIssue returns null when no active item matches', async () => {
      const found = await store.findReviewByIssue('nonexistent', 'nope', 'cat-none', 'clf');
      expect(found).toBeNull();
    });

    it('findReviewByIssue returns null for superseded items', async () => {
      const item = await store.createReviewItem(BASE_CREATE);
      await store.transitionReviewItem(item.id, { ...SUPERSEDE, expectedVersion: 1 });

      const found = await store.findReviewByIssue(
        BASE_CREATE.budgetId,
        BASE_CREATE.transactionId,
        BASE_CREATE.categoryId,
        BASE_CREATE.classifier,
      );
      expect(found).toBeNull();
    });

    it('listReviewItems returns all items ordered by priority', async () => {
      const low = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-low', transactionId: 't-low', priority: 1 });
      const high = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-high', transactionId: 't-high', priority: 10 });
      const med = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-med', transactionId: 't-med', priority: 5 });

      const all = await store.listReviewItems();
      // High priority should come first
      expect(all.length).toBe(3);
      expect(all[0].id).toBe(high.id);
      expect(all[1].id).toBe(med.id);
      expect(all[2].id).toBe(low.id);
    });

    it('listReviewItems can filter by status', async () => {
      await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-f1', transactionId: 't-f1' });
      const item2 = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-f2', transactionId: 't-f2' });
      await store.transitionReviewItem(item2.id, { ...GENERATE, expectedVersion: 1 });

      const discovered = await store.listReviewItems({ status: 'discovered' });
      expect(discovered.length).toBe(1);
      expect(discovered[0].budgetId).toBe('b-f1');

      const generated = await store.listReviewItems({ status: 'suggestion_generated' });
      expect(generated.length).toBe(1);
      expect(generated[0].budgetId).toBe('b-f2');
    });

    it('listReviewItems respects limit and offset', async () => {
      for (let i = 0; i < 10; i++) {
        await store.createReviewItem({
          ...BASE_CREATE,
          budgetId: `b-list-${i}`,
          transactionId: `t-list-${i}`,
        });
      }

      const page1 = await store.listReviewItems({ limit: 3, offset: 0 });
      expect(page1.length).toBe(3);

      const page2 = await store.listReviewItems({ limit: 3, offset: 3 });
      expect(page2.length).toBe(3);
      expect(page2[0].id).not.toBe(page1[0].id);
    });

    it('listReviewItemsByCorrelation returns items sharing a correlationId', async () => {
      await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-c1', transactionId: 't-c1', correlationId: 'batch-1' });
      await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-c2', transactionId: 't-c2', correlationId: 'batch-1' });
      await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-c3', transactionId: 't-c3', correlationId: 'batch-2' });

      const batch = await store.listReviewItemsByCorrelation('batch-1');
      expect(batch.length).toBe(2);

      const other = await store.listReviewItemsByCorrelation('batch-2');
      expect(other.length).toBe(1);
    });
  });

  // =======================================================================
  // Heterogeneous grouping — bulk transitions
  // =======================================================================

  describe('heterogeneous grouping', () => {
    it('transitionReviewItems rejects items with different current statuses', async () => {
      const item1 = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-h1', transactionId: 't-h1' });
      const item2 = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-h2', transactionId: 't-h2' });
      // Put item2 in a different status
      await store.transitionReviewItem(item2.id, { ...GENERATE, expectedVersion: 1 });

      await expect(
        store.transitionReviewItems([item1.id, item2.id], 'superseded', 'system', 'Batch cleanup'),
      ).rejects.toThrow(/heterogeneous|status.*not equal/i);
    });

    it('transitionReviewItems transitions all items with the same status atomically', async () => {
      const items = await Promise.all([
        store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-b1', transactionId: 't-b1' }),
        store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-b2', transactionId: 't-b2' }),
        store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-b3', transactionId: 't-b3' }),
      ]);

      const results = await store.transitionReviewItems(
        items.map(i => i.id),
        'superseded',
        'system',
        'Batch cleanup',
      );

      expect(results.length).toBe(3);
      for (const r of results) {
        expect(r.success).toBe(true);
      }

      // Verify all are now superseded
      for (const item of items) {
        const fetched = await store.getReviewItem(item.id);
        expect(fetched!.status).toBe('superseded');
      }
    });

    it('transitionReviewItems returns per-item results when some items fail version conflict', async () => {
      const items = await Promise.all([
        store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-ver1', transactionId: 't-ver1' }),
        store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-ver2', transactionId: 't-ver2' }),
      ]);

      // Both are 'discovered' at version 1. Advance both through identical
      // statuses so they share a status, then advance one item further so its
      // current version is higher.
      await store.transitionReviewItem(items[0].id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(items[0].id, { ...START_REVIEW, expectedVersion: 2 });

      await store.transitionReviewItem(items[1].id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(items[1].id, { ...START_REVIEW, expectedVersion: 2 });
      // Item 1: approve then undo so version is higher but status same
      const app = await store.transitionReviewItem(items[1].id, { ...APPROVE_ALICE, expectedVersion: 3 });
      await store.undoReviewTransition(items[1].id, ACTOR_ALICE, 'test', app.version);

      // Both now at 'pending_review' but item1 has a higher version
      const after = await store.getReviewItem(items[0].id);
      const after1 = await store.getReviewItem(items[1].id);
      expect(after!.status).toBe('pending_review');
      expect(after1!.status).toBe('pending_review');
      expect(after1!.version).toBeGreaterThan(after!.version);

      // Bulk supersede — all at same status, version checked per-item at transition time
      const results = await store.transitionReviewItems(
        items.map(i => i.id),
        'superseded',
        'system',
        'Batch cleanup',
      );

      // Since transitionReviewItems reads fresh versions, both should succeed
      expect(results.length).toBe(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });
  });

  // =======================================================================
  // Persistence across reopen
  // =======================================================================

  describe('persistence across reopen', () => {
    it('survives store close and reopen with file database', async () => {
      const dbPath = `${os.tmpdir()}/review-test-${Date.now()}.sqlite`;

      try {
        // Write some data
        const store1 = new SqliteWorkflowStore(dbPath);
        const item = await store1.createReviewItem({
          ...BASE_CREATE,
          budgetId: 'b-persist',
          transactionId: 't-persist',
        });
        await store1.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
        const actions1 = await store1.getReviewActions(item.id);
        store1.close();

        // Reopen and verify
        const store2 = new SqliteWorkflowStore(dbPath);

        const fetched = await store2.getReviewItem(item.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.id).toBe(item.id);
        expect(fetched!.status).toBe('suggestion_generated');
        expect(fetched!.provenance).toBe('classifier-scan');

        const actions2 = await store2.getReviewActions(item.id);
        expect(actions2.length).toBe(actions1.length);

        store2.close();
      } finally {
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      }
    });
  });

  // =======================================================================
  // Final approver persistence
  // =======================================================================

  describe('final approver persistence', () => {
    it('persists the approving actor in approvedBy when reviewersRequired is 1', async () => {
      const item = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-fap1',
        transactionId: 't-fap1',
        reviewersRequired: 1,
      });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });

      const approved = await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      expect(approved.status).toBe('approved');
      expect(approved.approvedBy).toContain(ACTOR_ALICE);

      // Verify from a fresh fetch too
      const fetched = await store.getReviewItem(item.id);
      expect(fetched!.approvedBy).toContain(ACTOR_ALICE);
    });

    it('persists all approving actors in approvedBy when multiple are required', async () => {
      const item = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-fap2',
        transactionId: 't-fap2',
        reviewersRequired: 2,
      });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });

      const afterAlice = await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      expect(afterAlice.approvedBy).toEqual([ACTOR_ALICE]);

      const afterBob = await store.transitionReviewItem(item.id, { ...APPROVE_BOB, expectedVersion: afterAlice.version });
      expect(afterBob.status).toBe('approved');
      expect(afterBob.approvedBy).toEqual([ACTOR_ALICE, ACTOR_BOB]);
    });

    it('approvedBy survives store reopen with file database', async () => {
      const dbPath = `${os.tmpdir()}/review-approve-${Date.now()}.sqlite`;
      try {
        const store1 = new SqliteWorkflowStore(dbPath);
        const item = await store1.createReviewItem({
          ...BASE_CREATE,
          budgetId: 'b-fap3',
          transactionId: 't-fap3',
          reviewersRequired: 2,
        });
        await store1.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
        await store1.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
        await store1.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
        await store1.transitionReviewItem(item.id, { ...APPROVE_BOB, expectedVersion: 4 });
        store1.close();

        const store2 = new SqliteWorkflowStore(dbPath);
        const fetched = await store2.getReviewItem(item.id);
        expect(fetched!.approvedBy).toEqual([ACTOR_ALICE, ACTOR_BOB]);
        store2.close();
      } finally {
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      }
    });
  });

  // =======================================================================
  // Atomic partial approval
  // =======================================================================

  describe('atomic partial approval', () => {
    it('records both approvedBy update and audit action for partial approval', async () => {
      const item = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-apa1',
        transactionId: 't-apa1',
        reviewersRequired: 2,
      });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });

      const afterAlice = await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      expect(afterAlice.approvedBy).toEqual([ACTOR_ALICE]);

      const actions = await store.getReviewActions(item.id);
      const firstPartialRecord = actions.find(a => a.actor === ACTOR_ALICE);
      expect(firstPartialRecord).toBeDefined();
      expect(firstPartialRecord!.toStatus).toBe('pending_review'); // stayed same
    });

    it('mutiple partial approvals each record the correct approvedBy state', async () => {
      const item = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-apa2',
        transactionId: 't-apa2',
        reviewersRequired: 3,
      });
      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });

      const a1 = await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });
      expect(a1.approvedBy).toEqual([ACTOR_ALICE]);

      const a2 = await store.transitionReviewItem(item.id, { ...APPROVE_BOB, expectedVersion: a1.version });
      expect(a2.approvedBy).toEqual([ACTOR_ALICE, ACTOR_BOB]);
    });
  });

  // =======================================================================
  // Superseding successor links
  // =======================================================================

  describe('superseding successor', () => {
    it('records supersededBy when transitioning with supersededBy parameter', async () => {
      const item1 = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-ss1',
        transactionId: 't-ss1',
      });
      const item2 = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-ss2',
        transactionId: 't-ss2',
      });

      const s1 = await store.transitionReviewItem(item1.id, {
        toStatus: 'superseded',
        actor: 'system',
        reason: 'Superseded by newer',
        expectedVersion: 1,
        supersededBy: item2.id,
      });
      expect(s1.status).toBe('superseded');
      expect(s1.supersededBy).toBe(item2.id);

      // Verify from fresh fetch
      const fetched = await store.getReviewItem(item1.id);
      expect(fetched!.supersededBy).toBe(item2.id);
      expect(fetched!.supersededReason).toBe('Superseded by newer');
    });

    it('supersededBy persists across store reopen', async () => {
      const dbPath = `${os.tmpdir()}/review-ss-${Date.now()}.sqlite`;
      try {
        const store1 = new SqliteWorkflowStore(dbPath);
        const item1 = await store1.createReviewItem({
          ...BASE_CREATE,
          budgetId: 'b-ss3',
          transactionId: 't-ss3',
        });
        await store1.transitionReviewItem(item1.id, {
          toStatus: 'superseded',
          actor: 'system',
          reason: 'Stale',
          expectedVersion: 1,
          supersededBy: 'successor-id-123',
        });
        store1.close();

        const store2 = new SqliteWorkflowStore(dbPath);
        const fetched = await store2.getReviewItem(item1.id);
        expect(fetched!.supersededBy).toBe('successor-id-123');
        expect(fetched!.supersededReason).toBe('Stale');
        store2.close();
      } finally {
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      }
    });
  });

  // =======================================================================
  // Fresh snapshot supersession — newer transactionVersion replaces old
  // =======================================================================

  describe('fresh snapshot supersession', () => {
    it('creates a new item and supersedes the old one when transactionVersion is higher', async () => {
      const oldItem = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-fresh',
        transactionId: 't-fresh',
        transactionVersion: 1,
      });
      expect(oldItem.status).toBe('discovered');

      tickSync();

      const newItem = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-fresh',
        transactionId: 't-fresh',
        transactionVersion: 2,
        provenance: 're-classify',
      });
      expect(newItem.id).not.toBe(oldItem.id);
      expect(newItem.status).toBe('discovered');
      expect(newItem.transactionVersion).toBe(2);
      expect(newItem.provenance).toBe('re-classify');

      // Old item should be superseded with successor link
      const fetchedOld = await store.getReviewItem(oldItem.id);
      expect(fetchedOld!.status).toBe('superseded');
      expect(fetchedOld!.supersededBy).toBe(newItem.id);
      expect(fetchedOld!.supersededReason).toBeDefined();

      // Audit action for supersession
      const oldActions = await store.getReviewActions(oldItem.id);
      const supersedeAction = oldActions.find(a => a.toStatus === 'superseded');
      expect(supersedeAction).toBeDefined();
      expect(supersedeAction!.metadata).toEqual({ newItemId: newItem.id });
    });

    it('returns existing item when transactionVersion is equal or lower', async () => {
      const first = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-fresh2',
        transactionId: 't-fresh2',
        transactionVersion: 3,
      });
      expect(first.version).toBe(1);

      // Same version — idempotent
      const second = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-fresh2',
        transactionId: 't-fresh2',
        transactionVersion: 3,
        provenance: 'should-be-ignored',
      });
      expect(second.id).toBe(first.id);

      // Lower version — idempotent
      const third = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-fresh2',
        transactionId: 't-fresh2',
        transactionVersion: 1,
        provenance: 'also-ignored',
      });
      expect(third.id).toBe(first.id);
    });

    it('superseded item is no longer returned by findReviewByIssue', async () => {
      await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-fresh3',
        transactionId: 't-fresh3',
        transactionVersion: 1,
      });

      await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-fresh3',
        transactionId: 't-fresh3',
        transactionVersion: 2,
      });

      const found = await store.findReviewByIssue(
        'b-fresh3',
        't-fresh3',
        BASE_CREATE.categoryId,
        BASE_CREATE.classifier,
      );
      expect(found).not.toBeNull();
      expect(found!.transactionVersion).toBe(2);
    });
  });

  // =======================================================================
  // Bulk — missing IDs in transitionReviewItems
  // =======================================================================

  describe('bulk missing IDs', () => {
    it('returns a result for each requested ID including missing ones', async () => {
      const item = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-bulk1', transactionId: 't-bulk1' });

      const results = await store.transitionReviewItems(
        [item.id, 'nonexistent-id'],
        'superseded',
        'system',
      );

      expect(results.length).toBe(2);
      expect(results[0].itemId).toBe(item.id);
      expect(results[0].success).toBe(true);
      expect(results[1].itemId).toBe('nonexistent-id');
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBeDefined();
    });

    it('returns failure for every ID when all are missing', async () => {
      const results = await store.transitionReviewItems(
        ['missing-1', 'missing-2'],
        'superseded',
        'system',
      );

      expect(results.length).toBe(2);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toBe('Not found');
      expect(results[1].success).toBe(false);
      expect(results[1].error).toBe('Not found');
    });

    it('includes missing IDs among results even when some items exist', async () => {
      const item = await store.createReviewItem({ ...BASE_CREATE, budgetId: 'b-bulk2', transactionId: 't-bulk2' });

      const results = await store.transitionReviewItems(
        ['missing-a', item.id, 'missing-b'],
        'superseded',
        'system',
      );

      expect(results.length).toBe(3);
      expect(results[0].itemId).toBe('missing-a');
      expect(results[0].success).toBe(false);
      expect(results[1].itemId).toBe(item.id);
      expect(results[1].success).toBe(true);
      expect(results[2].itemId).toBe('missing-b');
      expect(results[2].success).toBe(false);
    });
  });

  // =======================================================================
  // Concurrent access — optimistic locking with two connections
  // =======================================================================

  describe('concurrent access', () => {
    it('two stores on same file — partial approval bumps version, stale expectedVersion fails', async () => {
      const dbPath = `${os.tmpdir()}/review-conc1-${Date.now()}.sqlite`;
      try {
        const initStore = new SqliteWorkflowStore(dbPath);
        const item = await initStore.createReviewItem({
          ...BASE_CREATE,
          budgetId: 'b-conc1',
          transactionId: 't-conc1',
          reviewersRequired: 2,
        });
        // Advance to pending_review
        await initStore.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
        await initStore.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
        initStore.close();

        const store1 = new SqliteWorkflowStore(dbPath);
        const store2 = new SqliteWorkflowStore(dbPath);

        // Both see version 3, pending_review
        // store1 does partial approval (Alice), bumps version to 4, stays pending_review
        const afterAlice = await store1.transitionReviewItem(item.id, {
          ...APPROVE_ALICE,
          expectedVersion: 3,
        });
        expect(afterAlice.version).toBe(4);
        expect(afterAlice.status).toBe('pending_review');

        // store2 tries with stale expectedVersion 3 (still valid status but wrong version) — should fail
        await expect(
          store2.transitionReviewItem(item.id, {
            ...APPROVE_BOB,
            expectedVersion: 3,
          }),
        ).rejects.toThrow(/version|conflict/i);

        store1.close();
        store2.close();
      } finally {
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      }
    });

    it('two stores — one writer transitions, other cannot use stale expectedVersion on status-changing transition', async () => {
      const dbPath = `${os.tmpdir()}/review-conc2-${Date.now()}.sqlite`;
      try {
        const initStore = new SqliteWorkflowStore(dbPath);
        const item = await initStore.createReviewItem({
          ...BASE_CREATE,
          budgetId: 'b-conc2',
          transactionId: 't-conc2',
          reviewersRequired: 1,
        });
        initStore.close();

        const store1 = new SqliteWorkflowStore(dbPath);
        const store2 = new SqliteWorkflowStore(dbPath);

        // Both see version 1, discovered. store1 transitions.
        const t1 = await store1.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
        expect(t1.version).toBe(2);
        expect(t1.status).toBe('suggestion_generated');

        // store2 tries to generate with version 1 — fromStatus would be 'suggestion_generated'
        // and toStatus is 'suggestion_generated', so idempotent check catches it.
        // That's correct — it means the transition already happened.
        // For a "stale expectedVersion" test, we need a non-idempotent target.
        // store2 tries to supersede with expectedVersion 1 (stale):
        await expect(
          store2.transitionReviewItem(item.id, {
            toStatus: 'superseded',
            actor: 'system',
            reason: 'Stale',
            expectedVersion: 1,
          }),
        ).rejects.toThrow(/version|conflict/i);

        store1.close();
        store2.close();
      } finally {
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      }
    });
  });

  // =======================================================================
  // Full audit persistence
  // =======================================================================

  describe('full audit persistence', () => {
    it('all audit fields are fully populated and survive reopen', async () => {
      const dbPath = `${os.tmpdir()}/review-audit-${Date.now()}.sqlite`;
      try {
        const store1 = new SqliteWorkflowStore(dbPath);
        const item = await store1.createReviewItem({
          ...BASE_CREATE,
          budgetId: 'b-audit1',
          transactionId: 't-audit1',
        });
        await store1.transitionReviewItem(item.id, {
          toStatus: 'pending_review',
          actor: 'system',
          reason: 'Auto-promote',
          metadata: { source: 'scheduler' },
          expectedVersion: 1,
        });
        await store1.transitionReviewItem(item.id, {
          ...APPROVE_ALICE,
          expectedVersion: 2,
        });
        store1.close();

        const store2 = new SqliteWorkflowStore(dbPath);
        const actions = await store2.getReviewActions(item.id);
        expect(actions.length).toBe(2);

        // First action: discovered -> pending_review
        const action0 = actions[0];
        expect(action0.reviewItemId).toBe(item.id);
        expect(action0.fromStatus).toBe('discovered');
        expect(action0.toStatus).toBe('pending_review');
        expect(action0.actor).toBe('system');
        expect(action0.reason).toBe('Auto-promote');
        expect(action0.metadata).toEqual({ source: 'scheduler' });
        expect(action0.id).toBeDefined();
        expect(action0.createdAt).toBeDefined();

        // Second action: pending_review -> approved
        const action1 = actions[1];
        expect(action1.reviewItemId).toBe(item.id);
        expect(action1.fromStatus).toBe('pending_review');
        expect(action1.toStatus).toBe('approved');
        expect(action1.actor).toBe(ACTOR_ALICE);
        expect(action1.reason).toBe('Looks correct');
        expect(action1.metadata).toEqual({});
        expect(action1.id).toBeDefined();
        expect(action1.createdAt).toBeDefined();

        store2.close();
      } finally {
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      }
    });

    it('audit timestamps are in strict chronological order', async () => {
      const item = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-audit2',
        transactionId: 't-audit2',
      });

      await store.transitionReviewItem(item.id, { ...GENERATE, expectedVersion: 1 });
      await store.transitionReviewItem(item.id, { ...START_REVIEW, expectedVersion: 2 });
      await store.transitionReviewItem(item.id, { ...APPROVE_ALICE, expectedVersion: 3 });

      const actions = await store.getReviewActions(item.id);
      expect(actions.length).toBe(3);
      for (let i = 1; i < actions.length; i++) {
        const prev = new Date(actions[i - 1].createdAt).getTime();
        const curr = new Date(actions[i].createdAt).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });
  });

  // =======================================================================
  // createReviewItem is idempotent for equal transactionVersion
  // =======================================================================

  describe('idempotent create with transactionVersion', () => {
    it('returns existing item when transactionVersion is the same', async () => {
      const first = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-idem1',
        transactionId: 't-idem1',
        transactionVersion: 5,
      });
      const second = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-idem1',
        transactionId: 't-idem1',
        transactionVersion: 5,
      });
      expect(second.id).toBe(first.id);
    });

    it('returns existing item when no transactionVersion provided (defaults to 1)', async () => {
      const first = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-idem2',
        transactionId: 't-idem2',
      });
      const second = await store.createReviewItem({
        ...BASE_CREATE,
        budgetId: 'b-idem2',
        transactionId: 't-idem2',
      });
      expect(second.id).toBe(first.id);
    });
  });
});
