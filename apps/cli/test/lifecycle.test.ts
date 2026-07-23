import { describe, it, expect } from 'vitest';
import { main } from '../src/index';
import { createLifecycleCallbacks } from '@balanceframe/application';
import type { LifecycleStore } from '@balanceframe/application';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  AnalysisProtocol,
  PendingReviewResult,
  ReviewDetailResult,
  BudgetSummaryResult,
  ExportResult,
  DisconnectResult,
  RemovalResult,
  DeletionResult,
  LifecycleCallbacks,
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
  deleteDataCallCount: number;
  exportResult: ExportResult;
  disconnectResult: DisconnectResult;
  removalResult: RemovalResult;
  deletionResult: DeletionResult;
}

function createLifecycleTracker(): LifecycleTracker {
  const deletionResult: DeletionResult = {
    actorId: 'usr_test',
    scope: 'connection',
    recordsDeleted: 3,
    recordsRetained: 0,
    retentionReasons: [],
    revokedCredentials: 2,
    revokedDelegations: 0,
    cancelledJobs: 1,
    backupRetentionStatus: 'retained',
    actualNonMutation: false,
    correlationId: 'corr_del_001',
    failures: [],
  };
  const tracker: LifecycleTracker = {
    callbacks: null as unknown as LifecycleCallbacks,
    exportCallCount: 0,
    disconnectCallCount: 0,
    removeCallCount: 0,
    deleteDataCallCount: 0,
    exportResult: {
      exportedAt: '2026-07-18T10:00:00Z',
      budgetName: 'My Budget',
      exportPath: '/tmp/balanceframe-export/my-budget.json',
      byteSize: 1024,
      sha256Hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
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
    deletionResult,
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
    async doDeleteData(_ledger, _scope) {
      tracker.deleteDataCallCount++;
      return tracker.deletionResult;
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

// ---------------------------------------------------------------------------
// delete-data tests
// ---------------------------------------------------------------------------

describe('CLI lifecycle — delete-data', () => {
  it('calls doDeleteData callback with valid scope and returns success envelope', async () => {
    const t = createLifecycleTracker();
    const result = await main(['delete-data', '--scope', 'connection'], {
      actorId: 'usr_test',
      requestId: 'req_del',
      mode: 'managedAutomation',
      ledger: { mockLedger: true },
      lifecycleCallbacks: t.callbacks,
    });

    expect(t.deleteDataCallCount).toBe(1);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.scope).toBe('connection');
    expect(parsed.result.recordsDeleted).toBe(3);
    expect(parsed.result.correlationId).toBe('corr_del_001');
  });

  it('rejects delete-data in observe mode and does not call callback', async () => {
    const t = createLifecycleTracker();
    const result = await main(['delete-data', '--scope', 'connection'], {
      actorId: 'usr_test',
      requestId: 'req_del_obs',
      mode: 'observe',
      ledger: { mockLedger: true },
      lifecycleCallbacks: t.callbacks,
    });

    expect(t.deleteDataCallCount).toBe(0);
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('write_rejected');
  });

  it('rejects delete-data without lifecycle callbacks', async () => {
    const result = await main(['delete-data', '--scope', 'connection'], {
      actorId: 'usr_test',
      requestId: 'req_del_nc',
      mode: 'managedAutomation',
      ledger: { mockLedger: true },
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.error.code).toBe('no_lifecycle_callbacks');
  });
});

// ---------------------------------------------------------------------------
// Destructive-flow tests — real filesystem export + verification
// ---------------------------------------------------------------------------

describe('CLI lifecycle — destructive flow (real artifacts)', () => {
  /** Create a minimal in-memory store that satisfies LifecycleStore. */
  function createTestStore(): LifecycleStore & { exports: Array<{ exportedAt: string; budgetName: string; exportPath: string; accountCount: number; transactionCount: number }> } {
    const exports: Array<{
      exportedAt: string;
      budgetName: string;
      exportPath: string;
      accountCount: number;
      transactionCount: number;
    }> = [];
    return {
      exports,
      async cancelPendingJobs() { return 0; },
      async deleteActorMembership() { return true; },
      async recordExport(input) {
        exports.length = 0; // single-row tracking
        exports.push({ ...input, exportedAt: new Date().toISOString() });
      },
      async getLastExport() {
        return exports[0] ?? null;
      },
      async deleteScopeData() {
        return { deleted: { memberships: 1, jobs: 0, corrections: 3 }, retained: { count: 0, reasons: [] } };
      },
    };
  }

  /** Create a minimal synchronizable ledger with one account and one transaction. */
  function mockSyncLedger(): unknown {
    return {
      async synchronize() {
        return {
          snapshot: {
            schemaVersion: '1',
            actualVersion: '1.0.0',
            snapshotDate: new Date().toISOString(),
            actualDownloadedAt: null,
            bankSyncedAt: null,
            encrypted: false,
            unlocked: true,
            accounts: [{
              id: 'a1', name: 'Test Checking', accountType: 'checking' as const,
              offBudget: false, isClosed: false,
              clearedBalance: { minorUnits: '100000', currency: 'USD' },
              importedBalance: { minorUnits: '100000', currency: 'USD' },
              mtid: null,
            }],
            transactions: [{
              id: 't1', accountId: 'a1',
              date: '2026-07-15', payeeId: 'p1', payeeName: 'Test Store',
              categoryId: 'c1', categoryName: 'Groceries',
              amount: { minorUnits: '-2500', currency: 'USD' },
              cleared: true, reconciled: false,
              importedId: null, importedPayee: null,
              notes: null, tags: [], transferAccountId: null, subtransactions: [],
            }],
            categories: [{
              id: 'c1', name: 'Groceries', groupName: 'Food',
              isIncome: false, mtid: null, deleted: false,
            }],
            payees: [{
              id: 'p1', name: 'Test Store', transferAccountId: null, mtid: null,
            }],
            rules: [], schedules: [], budgets: [], tags: [],
          },
          health: { state: 'healthy' as const, checks: [] },
          watermark: { lastTransactionDate: null, lastTransactionCount: 0, lastSyncCompletedAt: null, overlapDays: 3 },
        };
      },
    };
  }

  it('full export + delete-data succeeds with real artifact verification', async () => {
    const exportDir = await mkdtemp(join(tmpdir(), 'bf-test-'));
    try {
      const store = createTestStore();
      const ledger = mockSyncLedger();
      const callbacks = createLifecycleCallbacks(() => ledger, { workflowStore: store, actorId: 'usr_dtest' });

      const exportResult = await callbacks.doExport(ledger);
      expect(exportResult.byteSize).toBeGreaterThan(50);
      expect(exportResult.sha256Hash).toMatch(/^[a-f0-9]{64}$/);

      const deleteResult = await callbacks.doDeleteData(ledger, 'connection');
      expect(deleteResult.scope).toBe('connection');
      expect(deleteResult.recordsDeleted).toBeGreaterThan(0);
    } finally {
      await rm(exportDir, { recursive: true, force: true });
    }
  });

  it('rejects delete-data when no export has been performed', async () => {
    const store = createTestStore();
    const ledger = { mockLedger: true };
    const callbacks = createLifecycleCallbacks(() => ledger, { workflowStore: store, actorId: 'usr_dtest2' });

    await expect(callbacks.doDeleteData(ledger, 'connection')).rejects.toThrowError(
      /export.*first/i,
    );
  });

  it('rejects delete-data when export file has been tampered', async () => {
    const exportDir = await mkdtemp(join(tmpdir(), 'bf-tamper-'));
    try {
      const store = createTestStore();
      const ledger = mockSyncLedger();
      const callbacks = createLifecycleCallbacks(() => ledger, { workflowStore: store, actorId: 'usr_dtest3' });

      // Perform export to create real files
      const exportResult = await callbacks.doExport(ledger);
      expect(exportResult.byteSize).toBeGreaterThan(0);

      // Tamper with the export file (truncate it)
      await writeFile(exportResult.exportPath, 'TAMPERED', 'utf-8');

      // Delete should now fail with hash mismatch
      await expect(callbacks.doDeleteData(ledger, 'connection')).rejects.toThrowError(
        /content hash does not match/i,
      );
    } finally {
      await rm(exportDir, { recursive: true, force: true });
    }
  });

  it('rejects delete-data when no workflow store is configured', async () => {
    const ledger = { mockLedger: true };
    const callbacks = createLifecycleCallbacks(() => ledger);

    await expect(callbacks.doDeleteData(ledger, 'connection')).rejects.toThrowError(
      /export.*first/i,
    );
  });

  it('disconnect reports only completed cleanup', async () => {
    const ledger = { mockLedger: true };

    // Without store — no cleanup performed
    const callbacksNoStore = createLifecycleCallbacks(() => ledger);
    const resultNoCleanup = await callbacksNoStore.doDisconnect(ledger);
    expect(resultNoCleanup.cacheRemoved).toBe(false);
    expect(resultNoCleanup.credentialsRemoved).toBe(false);

    // With store — cleanup performed
    const store = createTestStore();
    const callbacksClean = createLifecycleCallbacks(() => ledger, { workflowStore: store, actorId: 'usr_dtest4' });
    const resultClean = await callbacksClean.doDisconnect(ledger);
    expect(resultClean.cacheRemoved).toBe(true);
    expect(resultClean.credentialsRemoved).toBe(true);
  });

  it('remove-connection reports only completed cleanup', async () => {
    const ledger = { mockLedger: true };

    // Without store — no cleanup performed
    const callbacksNoStore = createLifecycleCallbacks(() => ledger);
    const resultNoCleanup = await callbacksNoStore.doRemoveConnection(ledger);
    expect(resultNoCleanup.cacheRemoved).toBe(false);
    expect(resultNoCleanup.credentialsRemoved).toBe(false);

    // With store — cleanup performed
    const store = createTestStore();
    const callbacksClean = createLifecycleCallbacks(() => ledger, { workflowStore: store, actorId: 'usr_dtest5' });
    const resultClean = await callbacksClean.doRemoveConnection(ledger);
    expect(resultClean.cacheRemoved).toBe(true);
    expect(resultClean.credentialsRemoved).toBe(true);
  });
});
