/**
 * TDD: failing tests for the mutation composition executor factory.
 *
 * The executor factory (createDefaultExecutorFactory) MUST use the
 * ConnectionManager restore path to load the persisted selected budget
 * and synchronize it before applying a mutation — NOT the per-request
 * EnvCredentialStore / ACTUAL_BUDGET_ID fallback pattern.
 *
 * Tests:
 * - Observe-mode default returns null (no executor).
 * - reviewAndApply opt-in creates an executor that calls restore().
 * - The restored connector is used for setTransactionCategory and
 *   synchronize — not ACTUAL_BUDGET_ID.
 * - A testable ConnectionManager can be injected via the factory
 *   argument without real secrets.
 * - Existing interfaces remain type-safe.
 */

import { describe, it, expect, vi } from 'vitest';

import { createDefaultExecutorFactory } from '../../server/utils/mutation-executor';
import type { EventWithContext } from '../../server/utils/workflow-store';

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
  createdAt: Date; updatedAt: Date;
}> = {}) {
  return {
    id: 'review-001',
    transactionId: TEST_TX_ID,
    budgetId: 'budget-1',
    categoryId: 'cat-food',
    classifier: 'test',
    provenance: 'test',
    status: 'pending_review',
    version: 3,
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

  it('uses ConnectionManager.restore() — not EnvCredentialStore — to get the connector', async () => {
    const { manager, connector } = fakeConnectionManager();
    const factory = createDefaultExecutorFactory(manager);
    const ev = mockEvent({ reviewAndApply: true });
    const executor = factory(ev)!;

    await executor(
      { reviewId: 'review-001', actorId: TEST_ACTOR, requestId: 'req-1' },
      {} as never,
      fakeReviewItem(),
    );

    expect(manager.restore).toHaveBeenCalledTimes(1);
    expect(connector.setTransactionCategory).toHaveBeenCalledWith(
      TEST_TX_ID, 'cat-food', 'cat-food',
    );
    expect(connector.synchronize).toHaveBeenCalled();
  });

  it('does not read ACTUAL_BUDGET_ID env var (uses persisted config via restore)', async () => {
    vi.stubEnv('ACTUAL_BUDGET_ID', 'env-budget-should-not-be-used');

    const { manager, connector } = fakeConnectionManager();
    const factory = createDefaultExecutorFactory(manager);
    const ev = mockEvent({ reviewAndApply: true });
    const executor = factory(ev)!;

    await executor(
      { reviewId: 'review-001', actorId: TEST_ACTOR, requestId: 'req-2' },
      {} as never,
      fakeReviewItem(),
    );

    expect(manager.restore).toHaveBeenCalled();
    expect(connector.setTransactionCategory).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('uses the restored connector for both setTransactionCategory and reread synchronize', async () => {
    const customConnector = {
      connect: vi.fn(),
      selectBudget: vi.fn(),
      synchronize: vi.fn().mockResolvedValue({
        snapshot: {
          transactions: [{ id: TEST_TX_ID, categoryId: 'cat-new' }],
        },
      }),
      setTransactionCategory: vi.fn().mockResolvedValue({
        success: true,
        transactionId: TEST_TX_ID,
        previousCategoryId: 'cat-old',
      }),
    };

    const { manager } = fakeConnectionManager({
      restoreResult: { connector: customConnector },
    });

    const factory = createDefaultExecutorFactory(manager);
    const ev = mockEvent({ reviewAndApply: true });
    const executor = factory(ev)!;

    const result = await executor(
      { reviewId: 'review-001', actorId: TEST_ACTOR, requestId: 'req-3', categoryId: 'cat-new' },
      {} as never,
      fakeReviewItem({ categoryId: 'cat-old' }),
    );

    expect(customConnector.setTransactionCategory).toHaveBeenCalledWith(
      TEST_TX_ID, 'cat-new', 'cat-old',
    );
    expect(customConnector.synchronize).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.mutationStatus).toBe('verified');
    expect(result.transactionId).toBe(TEST_TX_ID);
    expect(result.newCategoryId).toBe('cat-new');
  });

  it('returns apply_failed when setTransactionCategory fails', async () => {
    const failingConnector = {
      connect: vi.fn(),
      selectBudget: vi.fn(),
      synchronize: vi.fn().mockResolvedValue({ snapshot: { transactions: [] } }),
      setTransactionCategory: vi.fn().mockRejectedValue(new Error('Actual write failed')),
    };

    const { manager } = fakeConnectionManager({
      restoreResult: { connector: failingConnector },
    });

    const factory = createDefaultExecutorFactory(manager);
    const ev = mockEvent({ reviewAndApply: true });
    const executor = factory(ev)!;

    const result = await executor(
      { reviewId: 'review-001', actorId: TEST_ACTOR, requestId: 'req-4' },
      {} as never,
      fakeReviewItem(),
    );

    expect(result.success).toBe(false);
    expect(result.mutationStatus).toBe('apply_failed');
    expect(result.error).toBe('Actual write failed');
  });

  it('returns apply_failed when restore throws', async () => {
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
      {} as never,
      fakeReviewItem(),
    );

    expect(result.success).toBe(false);
    expect(result.mutationStatus).toBe('apply_failed');
    expect(result.error).toContain('No BalanceFrame connection configured');
  });

  it('preserves module-level factory wiring (without injection the default works)', () => {
    const factory = createDefaultExecutorFactory();
    expect(factory).toBeInstanceOf(Function);

    const ev = mockEvent({});
    const executor = factory(ev);
    expect(executor).toBeNull();
  });

  it('passes null as currentCategoryId when the review item has an empty categoryId', async () => {
    const { manager, connector } = fakeConnectionManager();
    const factory = createDefaultExecutorFactory(manager);
    const ev = mockEvent({ reviewAndApply: true });
    const executor = factory(ev)!;

    const item = fakeReviewItem({ categoryId: '' });

    await executor(
      { reviewId: 'review-001', actorId: TEST_ACTOR, requestId: 'req-empty-cat' },
      {} as never,
      item,
    );

    expect(connector.setTransactionCategory).toHaveBeenCalledWith(
      TEST_TX_ID,
      // proposed: falls back to item.categoryId which is '' — the same as the on-file value
      '',
      // currentCategoryId: empty persisted value is mapped to null
      null,
    );
  });
});
