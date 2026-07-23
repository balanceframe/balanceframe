/**
 * TDD: Tests for the mutation composition executor factory.
 *
 * The executor factory (createDefaultExecutorFactory) now constructs a
 * CategorizationMutationService bridge that creates proposals and approvals
 * in the workflow store, then calls the service's execute() path.
 *
 * Tests:
 * - Observe-mode default returns null (no executor).
 * - reviewAndApply opt-in creates an executor.
 * - The executor calls manager.restore() to get the ledger.
 * - It creates a proposal and approval in the workflow store.
 * - The executor returns apply_failed when restore throws.
 * - Existing interfaces remain type-safe.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';

import { createDefaultExecutorFactory } from '../../server/utils/mutation-executor';
import type { EventWithContext } from '../../server/utils/workflow-store';
import type { ReviewItem } from '@balanceframe/workflow-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ACTOR = 'test-actor';
const TEST_TX_ID = 'txn-001';

function mockEvent(config?: Record<string, unknown>): EventWithContext {
  return {
    context: {
      auth: { authenticated: true, actorId: TEST_ACTOR },
      runtimeConfig: config ?? {},
    },
  };
}

function fakeConnectionManager(overrides?: {
  restoreResult?: {
    budget?: { id: string; groupId: string; name: string; encrypted: boolean };
    connector?: Record<string, unknown>;
    synchronization?: unknown;
  };
}) {
  const defaultConnector = {
    connect: vi.fn(),
    selectBudget: vi.fn(),
    synchronize: vi.fn().mockResolvedValue({
      snapshot: {
        transactions: [{ id: TEST_TX_ID, categoryId: 'cat-food-verified' }],
      },
    }),
    setTransactionCategory: vi.fn().mockResolvedValue({
      success: true,
      transactionId: TEST_TX_ID,
      previousCategoryId: 'cat-food',
    }),
  };

  const restoreResult = overrides?.restoreResult ?? {};
  const connector = (restoreResult.connector ?? defaultConnector) as typeof defaultConnector;

  const manager = {
    restore: vi.fn().mockResolvedValue({
      budget: restoreResult.budget ?? {
        id: 'budget-1', groupId: 'group-1', name: 'Test Budget', encrypted: false,
      },
      connector,
      synchronization: restoreResult.synchronization ?? null,
    }),
    connect: vi.fn(),
    listBudgets: vi.fn(),
    loadConfig: vi.fn(),
  };

  return { manager, connector: connector as typeof defaultConnector };
}

function fakeReviewItem(overrides: Partial<{
  id: string; transactionId: string; budgetId: string; categoryId: string;
  classifier: string; provenance: string; status: string; version: number;
  createdAt: Date; updatedAt: Date; evidence: Record<string, unknown>;
}> = {}): ReviewItem {
  return {
    id: 'review-001',
    transactionId: TEST_TX_ID,
    budgetId: 'budget-1',
    categoryId: 'cat-food',
    classifier: 'test',
    promptVersion: '1.0',
    transactionVersion: 1,
    status: 'approved',
    correlationId: null,
    assignedReviewerId: null,
    approvedBy: [TEST_ACTOR],
    reviewersRequired: 1,
    priority: 0,
    evidence: {},
    provenance: 'test',
    supersededBy: null,
    supersededReason: null,
    freshnessExpiresAt: null,
    version: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDefaultExecutorFactory', () => {
  it('returns null when reviewAndApply is not configured (observe default)', () => {
    const factory = createDefaultExecutorFactory();
    const ev = mockEvent({});
    const executor = factory(ev);
    expect(executor).toBeNull();
  });

  it('returns null when reviewAndApply is explicitly false', () => {
    const factory = createDefaultExecutorFactory();
    const ev = mockEvent({ reviewAndApply: false });
    const executor = factory(ev);
    expect(executor).toBeNull();
  });

  it('creates an executor when reviewAndApply is true', () => {
    const { manager } = fakeConnectionManager();
    const factory = createDefaultExecutorFactory(manager);
    const ev = mockEvent({ reviewAndApply: true });
    const executor = factory(ev);
    expect(executor).not.toBeNull();
  });

  it('uses ConnectionManager.restore() to get the ledger', async () => {
    const store = new SqliteWorkflowStore(':memory:');
    const { manager } = fakeConnectionManager();
    const factory = createDefaultExecutorFactory(manager);
    const ev = mockEvent({ reviewAndApply: true });
    const executor = factory(ev)!;

    const result = await executor(
      { reviewId: 'review-001', actorId: TEST_ACTOR, requestId: 'req-1' },
      store,
      fakeReviewItem(),
    );

    // The bridge calls manager.restore() to get the ledger
    expect(manager.restore).toHaveBeenCalledTimes(1);
  });

  it('creates a proposal and approval in the store before executing', async () => {
    const store = new SqliteWorkflowStore(':memory:');
    const { manager } = fakeConnectionManager();
    const factory = createDefaultExecutorFactory(manager);
    const ev = mockEvent({ reviewAndApply: true });
    const executor = factory(ev)!;

    const createProposalSpy = vi.spyOn(store, 'createProposal');
    const createApprovalSpy = vi.spyOn(store, 'createApproval');

    await executor(
      { reviewId: 'review-001', actorId: TEST_ACTOR, requestId: 'req-2' },
      store,
      fakeReviewItem(),
    );

    expect(createProposalSpy).toHaveBeenCalledTimes(1);
    expect(createApprovalSpy).toHaveBeenCalledTimes(1);
  });

  it('returns apply_failed when restore throws', async () => {
    const store = new SqliteWorkflowStore(':memory:');
    const brokenManager = {
      restore: vi.fn().mockRejectedValue(new Error('No BalanceFrame connection configured.')),
      connect: vi.fn(),
      listBudgets: vi.fn(),
      loadConfig: vi.fn(),
    };

    const factory = createDefaultExecutorFactory(brokenManager);
    const ev = mockEvent({ reviewAndApply: true });
    const executor = factory(ev)!;

    const result = await executor(
      { reviewId: 'review-001', actorId: TEST_ACTOR, requestId: 'req-5' },
      store,
      fakeReviewItem(),
    );

    expect(result.success).toBe(false);
    expect(result.mutationStatus).toBe('apply_failed');
  });

  it('construction without connectionManager returns a working factory (production path)', () => {
    // In production, no connectionManager is passed. The factory now constructs
    // a real connection manager internally rather than returning null.
    const factory = createDefaultExecutorFactory();
    expect(factory).toBeInstanceOf(Function);

    const ev = mockEvent({});
    const executor = factory(ev);
    // Observe mode should still return null
    expect(executor).toBeNull();

    // reviewAndApply mode creates an executor (even though it will fail at
    // runtime without real Actual credentials — the point is it doesn't
    // unconditionally return null)
    const raaEv = mockEvent({ reviewAndApply: true });
    const raaExecutor = factory(raaEv);
    expect(raaExecutor).not.toBeNull();
  });

  it('prefers evidence.currentCategory over item.categoryId as currentCategoryId in the proposal preconditions', async () => {
    const store = new SqliteWorkflowStore(':memory:');
    const { manager } = fakeConnectionManager();
    const factory = createDefaultExecutorFactory(manager);
    const ev = mockEvent({ reviewAndApply: true });
    const executor = factory(ev)!;

    const item = fakeReviewItem({
      categoryId: 'cat-corrected-by-reviewer',
      evidence: { currentCategory: 'cat-original-from-classifier' },
    });

    const createProposalSpy = vi.spyOn(store, 'createProposal');
    await executor(
      { reviewId: 'review-001', actorId: TEST_ACTOR, requestId: 'req-override' },
      store,
      item,
    );

    // The proposal preconditions should contain the evidence.currentCategory
    const proposalInput = createProposalSpy.mock.calls[0][0];
    const preconditions = JSON.parse(proposalInput.preconditions);
    expect(preconditions.currentCategoryId).toBe('cat-original-from-classifier');
  });
});
