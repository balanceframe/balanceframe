import { describe, it, expect } from 'vitest';
import { main } from '../src/index';
import type { AnalysisProtocol, LifecycleCallbacks } from '@balanceframe/application';
import type {
  PendingReviewResult,
  ReviewDetailResult,
  BudgetSummaryResult,
  ExportResult,
  DisconnectResult,
  RemovalResult,
} from '@balanceframe/application';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function noopProtocol(): AnalysisProtocol {
  return {
    async pendingReview() {
      return {
        uncategorizedCount: 0,
        totalUncategorizedAmount: { minorUnits: '0', currency: 'USD' },
        candidates: [],
        oldestUncategorizedDate: null,
        healthState: 'unknown',
        blockers: [],
      } as PendingReviewResult;
    },
    async reviewShow(_ledger, reviewId) {
      return {
        reviewId,
        generatedAt: '2026-07-18T12:00:00Z',
        status: 'not_found',
        description: 'Review not found',
        totalAmount: { minorUnits: '0', currency: 'USD' },
        itemCount: 0,
        items: [],
      } as ReviewDetailResult;
    },
    async budgetSummary() {
      return {
        month: '2026-07',
        totalBudgeted: { minorUnits: '0', currency: 'USD' },
        totalSpent: { minorUnits: '0', currency: 'USD' },
        totalRemaining: { minorUnits: '0', currency: 'USD' },
        categories: [],
      } as BudgetSummaryResult;
    },
  };
}

interface LifecycleTracker {
  callbacks: LifecycleCallbacks;
  exportCallCount: number;
  disconnectCallCount: number;
  removeCallCount: number;
  exportResult: ExportResult;
  disconnectResult: DisconnectResult;
  removalResult: RemovalResult;
}

function createLifecycleTracker(): LifecycleTracker {
  const tracker: LifecycleTracker = {
    callbacks: null as unknown as LifecycleCallbacks,
    exportCallCount: 0,
    disconnectCallCount: 0,
    removeCallCount: 0,
    exportResult: {
      exportedAt: '2026-07-18T10:00:00Z',
      budgetName: 'My Budget',
      exportPath: '/tmp/balanceframe-export/my-budget.json',
      accountCount: 5,
      transactionCount: 250,
    },
    disconnectResult: {
      disconnected: true,
      cacheRemoved: true,
      credentialsRemoved: true,
      message: 'Connection removed. Actual server was not modified.',
    },
    removalResult: {
      removed: true,
      cacheRemoved: true,
      credentialsRemoved: true,
      broadAccessCaveat:
        'The BalanceFrame connector accesses all budget data including bank-sync credentials ' +
        'stored on the Actual server (which are not protected by Actual E2E encryption). ' +
        'Project-side filtering does not reduce the broad access held by the connector. ' +
        'Ensure your Actual server and backups have appropriate security.',
    },
  };

  tracker.callbacks = {
    async doExport(_ledger) {
      tracker.exportCallCount++;
      return tracker.exportResult;
    },
    async doDisconnect(_ledger) {
      tracker.disconnectCallCount++;
      return tracker.disconnectResult;
    },
    async doRemoveConnection(_ledger) {
      tracker.removeCallCount++;
      return tracker.removalResult;
    },
  };

  return tracker;
}

// ---------------------------------------------------------------------------
// Lifecycle handler tests
// ---------------------------------------------------------------------------

describe('CLI lifecycle — export', () => {
  it('calls doExport callback and returns success envelope', async () => {
    const t = createLifecycleTracker();
    const result = await main(['export', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_export',
      ledger: { mockLedger: true },
      lifecycleCallbacks: t.callbacks,
      analysisProtocol: noopProtocol(),
    });

    expect(t.exportCallCount).toBe(1);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.exportedAt).toBe(t.exportResult.exportedAt);
    expect(parsed.result.budgetName).toBe('My Budget');
    expect(parsed.result.accountCount).toBe(5);
    expect(parsed.result.transactionCount).toBe(250);
  });

  it('reports error when callbacks are missing', async () => {
    const result = await main(['export', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_export',
      ledger: { mockLedger: true },
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('no_lifecycle_callbacks');
  });

  it('reports error when ledger is null', async () => {
    const t = createLifecycleTracker();
    const result = await main(['export', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_export',
      ledger: null,
      lifecycleCallbacks: t.callbacks,
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('not_connected');
  });
});

describe('CLI lifecycle — disconnect', () => {
  it('calls doDisconnect callback and returns success envelope', async () => {
    const t = createLifecycleTracker();
    const result = await main(['disconnect'], {
      actorId: 'usr_test',
      requestId: 'req_dc',
      ledger: { mockLedger: true },
      lifecycleCallbacks: t.callbacks,
    });

    expect(t.disconnectCallCount).toBe(1);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.disconnected).toBe(true);
    expect(parsed.result.cacheRemoved).toBe(true);
    expect(parsed.result.credentialsRemoved).toBe(true);
  });
});

describe('CLI lifecycle — remove-connection', () => {
  it('calls doRemoveConnection callback and returns success envelope', async () => {
    const t = createLifecycleTracker();
    const result = await main(['remove-connection'], {
      actorId: 'usr_test',
      requestId: 'req_rem',
      mode: 'managedAutomation',
      ledger: { mockLedger: true },
      lifecycleCallbacks: t.callbacks,
    });

    expect(t.removeCallCount).toBe(1);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.removed).toBe(true);
    expect(parsed.result.cacheRemoved).toBe(true);
    expect(parsed.result.broadAccessCaveat).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle authorization — mode enforcement
// ---------------------------------------------------------------------------

describe('CLI lifecycle — authorization', () => {
  it('rejects remove-connection in observe mode and does not call callback', async () => {
    const t = createLifecycleTracker();
    const result = await main(['remove-connection'], {
      actorId: 'usr_test',
      requestId: 'req_rem_obs',
      mode: 'observe',
      ledger: { mockLedger: true },
      lifecycleCallbacks: t.callbacks,
    });

    // Callback must not be invoked
    expect(t.removeCallCount).toBe(0);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('write_rejected');
  });

  it('allows remove-connection in managedAutomation mode', async () => {
    const t = createLifecycleTracker();
    const result = await main(['remove-connection'], {
      actorId: 'usr_test',
      requestId: 'req_rem_auto',
      mode: 'managedAutomation',
      ledger: { mockLedger: true },
      lifecycleCallbacks: t.callbacks,
    });

    expect(t.removeCallCount).toBe(1);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
  });

  it('includes mode-appropriate authorization in remove-connection response', async () => {
    const t = createLifecycleTracker();
    const result = await main(['remove-connection'], {
      actorId: 'usr_test',
      requestId: 'req_auth_rem',
      mode: 'managedAutomation',
      ledger: { mockLedger: true },
      lifecycleCallbacks: t.callbacks,
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.authorization).toEqual({
      actorId: 'usr_test',
      capability: 'remove-connection',
      allowed: true,
    });
  });

  it('includes authorized context in export response', async () => {
    const t = createLifecycleTracker();
    const result = await main(['export', '--json'], {
      actorId: 'usr_test',
      requestId: 'req_auth_exp',
      mode: 'observe',
      ledger: { mockLedger: true },
      lifecycleCallbacks: t.callbacks,
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.authorization).toEqual({
      actorId: 'usr_test',
      capability: 'export',
      allowed: true,
    });
  });

  it('includes authorized context in disconnect response', async () => {
    const t = createLifecycleTracker();
    const result = await main(['disconnect'], {
      actorId: 'usr_test',
      requestId: 'req_auth_dc',
      mode: 'observe',
      ledger: { mockLedger: true },
      lifecycleCallbacks: t.callbacks,
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.authorization).toEqual({
      actorId: 'usr_test',
      capability: 'disconnect',
      allowed: true,
    });
  });
});
