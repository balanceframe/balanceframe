/**
 * Tests for the production dependency composition for Observe mode.
 *
 * These tests verify that {@link createObserveComposition} returns a usable
 * {@link ObserveComposition} with test doubles for the Actual and native
 * seams, and that the factory validates configuration errors, preserves the
 * Observe default, and never leaks credentials.
 *
 * Written before the implementation (TDD — these tests fail until the
 * composition module is correctly wired).
 */

import { describe, it, expect } from 'vitest';
import {
  createObserveComposition,
  createNativeAnalysisProtocol,
  createLifecycleCallbacks,
  CompositionConfigurationError,
  type ObserveComposition,
  type NativeBindingShim,
} from '../src/composition';
import type {
  AnalysisProtocol,
  ExportResult,
  DisconnectResult,
  RemovalResult,
  DeletionResult,
  PendingReviewResult,
  ReviewDetailResult,
  BudgetSummaryResult,
  ReviewActionResult,
  ReviewBulkActionResult,
  ReviewGroupResult,
  ProposalCreateResult,
  ProposalDetailResult,
  ProposalActionResult,
  ProposalListResult,
  AuditQueryResult,
  RuleListResult,
  RuleShowResult,
  RuleUpdateResult,
} from '../src/commands';
import { ReasonCodes } from '../src/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a stub native binding shim for testing. */
function stubNativeBindings(): { shim: NativeBindingShim; calls: string[] } {
  const calls: string[] = [];
  const shim: NativeBindingShim = {
    analyzeDeterministic(input: string): string {
      calls.push('analyzeDeterministic');
      return JSON.stringify({ status: 'ok', requestId: 'stub', schemaVersion: '1' });
    },
    analyzeSnapshot(input: string): string {
      calls.push('analyzeSnapshot');
      return JSON.stringify({ status: 'ok' });
    },
    findCategorizationCandidates(input: string): string {
      calls.push('findCategorizationCandidates');
      return JSON.stringify([]);
    },
  };
  return { shim, calls };
}

/** Create a mock AnalysisProtocol that records calls. */
function mockProtocol(): {
  protocol: AnalysisProtocol;
  calls: string[];
} {
  const calls: string[] = [];
  const protocol: AnalysisProtocol = {
    async pendingReview(_ledger, _freshness): Promise<PendingReviewResult> {
      calls.push('pendingReview');
      return {
        uncategorizedCount: 3,
        totalUncategorizedAmount: { minorUnits: '12000', currency: 'USD' },
        candidates: [
          {
            transactionId: 'tx_test_001',
            amount: { minorUnits: '4000', currency: 'USD' },
            payeeName: 'Test Corp',
            date: '2026-07-20',
            reasons: [{ kind: 'uncategorized', details: 'No category assigned' }],
          },
        ],
        oldestUncategorizedDate: '2026-06-15',
        healthState: 'healthy',
        blockers: [],
      };
    },
    async reviewShow(_ledger, reviewId): Promise<ReviewDetailResult> {
      calls.push('reviewShow');
      return {
        reviewId,
        generatedAt: '2026-07-21T00:00:00Z',
        status: 'pending_review',
        description: 'Test review',
        totalAmount: { minorUnits: '12000', currency: 'USD' },
        itemCount: 3,
        items: [],
      };
    },
    async budgetSummary(_ledger): Promise<BudgetSummaryResult> {
      calls.push('budgetSummary');
      return {
        month: '2026-07',
        totalBudgeted: { minorUnits: '500000', currency: 'USD' },
        totalSpent: { minorUnits: '120000', currency: 'USD' },
        totalRemaining: { minorUnits: '380000', currency: 'USD' },
        categories: [],
      };
    },
  };
  return { protocol, calls };
}

/** Create a mock ledger for testing — synchronizable with a minimal snapshot. */
function mockLedger(): unknown {
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
          accounts: [
            {
              id: 'acct_1',
              name: 'Checking',
              accountType: 'checking' as const,
              offBudget: false,
              isClosed: false,
              clearedBalance: { minorUnits: '50000', currency: 'USD' },
              importedBalance: { minorUnits: '50000', currency: 'USD' },
              mtid: null,
            },
          ],
          transactions: [
            {
              id: 'tx_1',
              accountId: 'acct_1',
              date: '2026-07-01',
              payeeId: 'payee_1',
              payeeName: 'Amazon',
              categoryId: 'cat_1',
              categoryName: 'Shopping',
              amount: { minorUnits: '-5000', currency: 'USD' },
              cleared: true,
              reconciled: false,
              importedId: null,
              importedPayee: null,
              notes: null,
              tags: [],
              transferAccountId: null,
              subtransactions: [],
            },
          ],
          categories: [
            {
              id: 'cat_1',
              name: 'Shopping',
              groupName: 'Expenses',
              isIncome: false,
              mtid: null,
              deleted: false,
            },
          ],
          payees: [
            {
              id: 'payee_1',
              name: 'Amazon',
              transferAccountId: null,
              mtid: null,
            },
          ],
          rules: [],
          schedules: [],
          budgets: [],
          tags: [],
        },
        health: { state: 'healthy' as const, checks: [] },
        watermark: {
          lastTransactionDate: null,
          lastTransactionCount: 0,
          lastSyncCompletedAt: null,
          overlapDays: 3,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// createObserveComposition — basic contract
// ---------------------------------------------------------------------------

describe('createObserveComposition', () => {
  it('returns a composition with all required fields when no options provided', async () => {
    // With a stub native binding override so no real addon is loaded
    const { shim } = stubNativeBindings();
    const comp = await createObserveComposition({
      nativeBindings: () => Promise.resolve(shim),
    });

    expect(comp).toBeDefined();
    expect(typeof comp.mode).toBe('string');
    expect(typeof comp.actorId).toBe('string');
    expect(typeof comp.requestId).toBe('string');
    expect(comp.analysisProtocol).toBeDefined();
  });

  it('defaults mode to "observe"', async () => {
    const { shim } = stubNativeBindings();
    const comp = await createObserveComposition({
      nativeBindings: () => Promise.resolve(shim),
    });

    expect(comp.mode).toBe('observe');
  });

  it('defaults actorId to "usr_cli"', async () => {
    const { shim } = stubNativeBindings();
    const comp = await createObserveComposition({
      nativeBindings: () => Promise.resolve(shim),
    });

    expect(comp.actorId).toBe('usr_cli');
  });

  it('defaults ledger to null', async () => {
    const { shim } = stubNativeBindings();
    const comp = await createObserveComposition({
      nativeBindings: () => Promise.resolve(shim),
    });

    expect(comp.ledger).toBeNull();
  });

  it('defaults freshness to null', async () => {
    const { shim } = stubNativeBindings();
    const comp = await createObserveComposition({
      nativeBindings: () => Promise.resolve(shim),
    });

    expect(comp.freshness).toBeNull();
  });

  it('generates a requestId when none provided', async () => {
    const { shim } = stubNativeBindings();
    const comp = await createObserveComposition({
      nativeBindings: () => Promise.resolve(shim),
    });

    expect(comp.requestId).toBeTruthy();
    expect(comp.requestId.startsWith('req_')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createObserveComposition — option overrides (test injection)
// ---------------------------------------------------------------------------

describe('createObserveComposition — option overrides', () => {
  it('accepts a mode override', async () => {
    const comp = await createObserveComposition({ mode: 'reviewAndApply' });
    expect(comp.mode).toBe('reviewAndApply');
  });

  it('accepts an actorId override', async () => {
    const comp = await createObserveComposition({ actorId: 'test-user' });
    expect(comp.actorId).toBe('test-user');
  });

  it('accepts a ledger override', async () => {
    const ledger = mockLedger();
    const comp = await createObserveComposition({ ledger });
    expect(comp.ledger).toBe(ledger);
  });

  it('accepts a freshness override', async () => {
    const freshness = {
      actualDownloadedAt: '2026-07-20T00:00:00Z',
      bankSyncedAt: null,
      pendingTransactionsIncluded: false,
      stalenessDays: 1,
      isStale: false,
    };
    const comp = await createObserveComposition({ freshness });
    expect(comp.freshness).toBe(freshness);
    expect(comp.freshness!.isStale).toBe(false);
  });

  it('accepts an analysisProtocol override', async () => {
    const { protocol } = mockProtocol();
    const comp = await createObserveComposition({
      analysisProtocol: protocol,
    });

    expect(comp.analysisProtocol).toBe(protocol);
  });

  it('accepts a requestId override', async () => {
    const comp = await createObserveComposition({ requestId: 'req_test_001' });
    expect(comp.requestId).toBe('req_test_001');
  });

  it('accepts lifecycleCallbacks override', async () => {
    const callbacks = {
      async doExport() {
        return {
          exportedAt: new Date().toISOString(),
          budgetName: 'test',
          exportPath: '/tmp/test',
          accountCount: 5,
          transactionCount: 100,
        };
      },
      async doDisconnect() {
        return {
          disconnected: true,
          cacheRemoved: true,
          credentialsRemoved: true,
          message: 'Disconnected.',
        };
      },
      async doRemoveConnection() {
        return {
          removed: true,
          cacheRemoved: true,
          credentialsRemoved: true,
          broadAccessCaveat: 'Test caveat.',
        };
      },
      async doDeleteData() {
        return {
          actorId: 'test',
          scope: 'test',
          recordsDeleted: 0,
          recordsRetained: 0,
          retentionReasons: [],
          revokedCredentials: 0,
          revokedDelegations: 0,
          cancelledJobs: 0,
          backupRetentionStatus: 'completed',
          actualNonMutation: false,
          correlationId: '',
          failures: [],
        };
      },
    };
    const comp = await createObserveComposition({
      lifecycleCallbacks: callbacks,
    });
    expect(comp.lifecycleCallbacks).toBe(callbacks);
  });
});

// ---------------------------------------------------------------------------
// createObserveComposition — analysis protocol availability
// ---------------------------------------------------------------------------

describe('createObserveComposition — analysis protocol', () => {
  it('always provides an analysisProtocol when native bindings succeed', async () => {
    const { shim } = stubNativeBindings();
    const comp = await createObserveComposition({
      nativeBindings: () => Promise.resolve(shim),
    });

    expect(comp.analysisProtocol).toBeDefined();
    // The protocol must expose at least the read-only methods
    expect(typeof comp.analysisProtocol.pendingReview).toBe('function');
    expect(typeof comp.analysisProtocol.reviewShow).toBe('function');
    expect(typeof comp.analysisProtocol.budgetSummary).toBe('function');
  });

  it('uses the override protocol when provided instead of native bindings', async () => {
    const { protocol, calls } = mockProtocol();
    const comp = await createObserveComposition({
      analysisProtocol: protocol,
    });

    expect(comp.analysisProtocol).toBe(protocol);

    // The native bindings should never be loaded when override is provided
    const result = await comp.analysisProtocol.pendingReview(
      { mock: true },
      null,
    );
    expect(calls).toContain('pendingReview');
    expect(result.uncategorizedCount).toBe(3);
  });

  it('native protocol adapter can call pendingReview through stub bindings', async () => {
    const { shim } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );

    const result = await protocol.pendingReview({ mock: true }, null);
    expect(result).toBeDefined();
    expect(typeof result.uncategorizedCount).toBe('number');
    expect(result.healthState).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
  it('lifecycle callbacks throw ApplicationError when ledger is null', async () => {
    const callbacks = createLifecycleCallbacks(() => null);

    await expect(callbacks.doExport(null)).rejects.toThrow('No ledger connected');
    await expect(callbacks.doDisconnect(null)).rejects.toThrow('No ledger connected');
    await expect(callbacks.doRemoveConnection(null)).rejects.toThrow('No ledger connected');
    await expect(callbacks.doDeleteData(null, 'test')).rejects.toThrow('No ledger connected');
  });

  it('lifecycle callbacks return success with a ledger', async () => {
    const ledger = mockLedger();
    const callbacks = createLifecycleCallbacks(() => ledger);

    const exportResult = await callbacks.doExport(ledger);
    expect(exportResult.exportedAt).toBeTruthy();
    expect(exportResult.byteSize).toBeGreaterThan(50);
    expect(exportResult.sha256Hash).toMatch(/^[a-f0-9]{64}$/);
    expect(exportResult.accountCount).toBeGreaterThan(0);
    expect(exportResult.transactionCount).toBeGreaterThan(0);
    expect(exportResult.exportPath).toMatch(/\/tmp\/balanceframe-export\/budget-export-.+\.json$/);

    // Without a store, no cleanup was performed
    const disconnectResult = await callbacks.doDisconnect(ledger);
    expect(disconnectResult.disconnected).toBe(false);
    expect(disconnectResult.cacheRemoved).toBe(false);
    expect(disconnectResult.credentialsRemoved).toBe(false);

    const removeResult = await callbacks.doRemoveConnection(ledger);
    expect(removeResult.removed).toBe(false);
    expect(removeResult.cacheRemoved).toBe(false);
    expect(removeResult.credentialsRemoved).toBe(false);

    // Without a store, delete-data is rejected (both error messages contain "export" and "first")
    await expect(callbacks.doDeleteData(ledger, 'connection')).rejects.toThrowError(
      /export.*first/i,
    );
  });

  it('doExport throws export_not_implemented when ledger lacks synchronize', async () => {
    const nonSyncLedger = { mockLedger: true, noSync: true };
    const callbacks = createLifecycleCallbacks(() => nonSyncLedger);
    await expect(callbacks.doExport(nonSyncLedger)).rejects.toThrowError(
      /cannot provide a full budget snapshot/i,
    );
  });

  it('doDeleteData rejects placeholder export with zero accounts and transactions', async () => {
    const store = {
      async cancelPendingJobs() { return 0; },
      async deleteActorMembership() { return true; },
      async recordExport() {},
      async getLastExport() {
        return {
          exportedAt: new Date().toISOString(),
          budgetName: 'Placeholder',
          exportPath: '/tmp/placeholder-export.json',
          accountCount: 0,
          transactionCount: 0,
        };
      },
      async deleteScopeData() {
        return { deleted: { memberships: 0, jobs: 0, corrections: 0 }, retained: { count: 0, reasons: [] } };
      },
    };
    const ledger = mockLedger();
    const callbacks = createLifecycleCallbacks(
      () => ledger,
      { workflowStore: store, actorId: 'usr_placeholder' },
    );
    await expect(callbacks.doDeleteData(ledger, 'connection')).rejects.toThrowError(
      /no budget data/i,
    );
  });

  it('doDisconnect calls ledger.disconnect and reports cleanup when ledger supports it', async () => {
    let disconnectCalled = false;
    const ledger = {
      ...mockLedger(),
      async disconnect() {
        disconnectCalled = true;
      },
    };
    const callbacks = createLifecycleCallbacks(() => ledger);
    const result = await callbacks.doDisconnect(ledger);
    expect(disconnectCalled).toBe(true);
    expect(result.disconnected).toBe(true);
    expect(result.cacheRemoved).toBe(true);
    expect(result.credentialsRemoved).toBe(true);
    expect(result.message).toMatch(/Disconnected successfully/);
  });

  it('doDisconnect reports no cache/credential removal when ledger lacks disconnect', async () => {
    const ledger = { mockLedger: true, noSync: true };
    const callbacks = createLifecycleCallbacks(() => ledger);
    const result = await callbacks.doDisconnect(ledger);
    expect(result.disconnected).toBe(false);
    expect(result.cacheRemoved).toBe(false);
    expect(result.credentialsRemoved).toBe(false);
    expect(result.message).toMatch(/does not support disconnect cleanup/);
  });

  it('doDisconnect reports no cache/credential removal even with store when ledger lacks disconnect', async () => {
    const store = {
      async cancelPendingJobs() { return 5; },
      async deleteActorMembership() { return true; },
      async recordExport() {},
      async getLastExport() { return null; },
      async deleteScopeData() {
        return { deleted: {}, retained: { count: 0, reasons: [] } };
      },
    };
    const ledger = { mockLedger: true };
    const callbacks = createLifecycleCallbacks(
      () => ledger,
      { workflowStore: store, actorId: 'usr_disc_test' },
    );
    const result = await callbacks.doDisconnect(ledger);
    // Store operations run (jobs cancelled, membership deleted) but cache/credentials
    // cannot be removed without a disconnect-capable ledger
    expect(result.disconnected).toBe(false);
    expect(result.cacheRemoved).toBe(false);
    expect(result.credentialsRemoved).toBe(false);
    expect(result.message).toMatch(/does not support disconnect cleanup/);
  });

  it('doRemoveConnection calls ledger.disconnect and reports cleanup when ledger supports it', async () => {
    let disconnectCalled = false;
    const ledger = {
      ...mockLedger(),
      async disconnect() {
        disconnectCalled = true;
      },
    };
    const callbacks = createLifecycleCallbacks(() => ledger);
    const result = await callbacks.doRemoveConnection(ledger);
    expect(disconnectCalled).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.cacheRemoved).toBe(true);
    expect(result.credentialsRemoved).toBe(true);
    expect(result.broadAccessCaveat).toMatch(/broad access/i);
  });

  it('doRemoveConnection reports no cache/credential removal when ledger lacks disconnect', async () => {
    const ledger = { mockLedger: true, noSync: true };
    const callbacks = createLifecycleCallbacks(() => ledger);
    const result = await callbacks.doRemoveConnection(ledger);
    expect(result.removed).toBe(false);
    expect(result.cacheRemoved).toBe(false);
    expect(result.credentialsRemoved).toBe(false);
    expect(result.broadAccessCaveat).toMatch(/does not support disconnect cleanup/);
  });

  it('doRemoveConnection reports no cache/credential removal even with store when ledger lacks disconnect', async () => {
    const store = {
      async cancelPendingJobs() { return 3; },
      async deleteActorMembership() { return true; },
      async recordExport() {},
      async getLastExport() { return null; },
      async deleteScopeData() {
        return { deleted: { memberships: 1, jobs: 0, corrections: 0 }, retained: { count: 0, reasons: [] } };
      },
    };
    const ledger = { mockLedger: true };
    const callbacks = createLifecycleCallbacks(
      () => ledger,
      { workflowStore: store, actorId: 'usr_rem_test' },
    );
    const result = await callbacks.doRemoveConnection(ledger);
    expect(result.removed).toBe(false);
    expect(result.cacheRemoved).toBe(false);
    expect(result.credentialsRemoved).toBe(false);
    expect(result.broadAccessCaveat).toMatch(/does not support disconnect cleanup/);
  });

// ---------------------------------------------------------------------------
// createObserveComposition — configuration errors
// ---------------------------------------------------------------------------

describe('createObserveComposition — configuration errors', () => {
  it('throws CompositionConfigurationError when native bindings fail to load', async () => {
    await expect(
      createObserveComposition({
        nativeBindings: () => Promise.reject(new Error('Addon not found')),
      }),
    ).rejects.toThrow(CompositionConfigurationError);
  });

  it('CompositionConfigurationError includes reason code', async () => {
    try {
      await createObserveComposition({
        nativeBindings: () => Promise.reject(new Error('Addon not found')),
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(CompositionConfigurationError);
      expect((err as CompositionConfigurationError).reasonCodes).toContain(
        ReasonCodes.MISSING_ANALYSIS_PROTOCOL,
      );
    }
  });

  it('CompositionConfigurationError is retryable', async () => {
    try {
      await createObserveComposition({
        nativeBindings: () => Promise.reject(new Error('Addon not found')),
      });
    } catch (err) {
      expect((err as CompositionConfigurationError).retryable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// No credential leakage
// ---------------------------------------------------------------------------

describe('createObserveComposition — no credential leakage', () => {
  it('does not include credentials in error messages', async () => {
    try {
      await createObserveComposition({
        nativeBindings: () =>
          Promise.reject(
            new Error(
              'Failed to load native addon (no credentials in this message)',
            ),
          ),
      });
    } catch (err) {
      const msg = (err as Error).message;
      // The error message should not contain any credential-like values
      expect(msg).not.toContain('password');
      expect(msg).not.toContain('secret');
      expect(msg).not.toContain('token');
      expect(msg).not.toContain('key');
    }
  });
});

// ---------------------------------------------------------------------------
// createNativeAnalysisProtocol
// ---------------------------------------------------------------------------

describe('createNativeAnalysisProtocol', () => {
  it('returns an AnalysisProtocol with all required methods', async () => {
    const { shim } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );

    expect(typeof protocol.pendingReview).toBe('function');
    expect(typeof protocol.reviewShow).toBe('function');
    expect(typeof protocol.budgetSummary).toBe('function');
  });

  it('pendingReview returns a PendingReviewResult shape', async () => {
    const { shim } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );

    const result = await protocol.pendingReview({ mock: true }, null);
    expect(result).toHaveProperty('uncategorizedCount');
    expect(result).toHaveProperty('totalUncategorizedAmount');
    expect(result).toHaveProperty('candidates');
    expect(result).toHaveProperty('oldestUncategorizedDate');
    expect(result).toHaveProperty('healthState');
    expect(result).toHaveProperty('blockers');
  });
});

// ---------------------------------------------------------------------------
// Integration: composition + pendingReviewAnalysis
// ---------------------------------------------------------------------------

describe('composition + pendingReviewAnalysis (integration)', () => {
  it('produces a CommandInput that pendingReviewAnalysis can dispatch', async () => {
    const { protocol, calls } = mockProtocol();
    const comp = await createObserveComposition({
      ledger: mockLedger(),
      analysisProtocol: protocol,
    });

    // Simulate what the CLI main() does — build a commandInput
    const { pendingReviewAnalysis } = await import('../src/analysis');
    const envelope = await pendingReviewAnalysis({
      args: ['transactions', 'pending-review', '--json'],
      mode: comp.mode,
      actorId: comp.actorId,
      requestId: comp.requestId,
      ledger: comp.ledger,
      freshness: comp.freshness,
      analysisProtocol: comp.analysisProtocol,
    });

    expect(calls).toContain('pendingReview');
    expect(envelope.status).toBe('ok');
    expect(envelope.result.uncategorizedCount).toBe(3);
  });

  it('returns not_connected when ledger is null', async () => {
    const { protocol } = mockProtocol();
    const comp = await createObserveComposition({
      ledger: null,
      analysisProtocol: protocol,
    });

    const { pendingReviewAnalysis } = await import('../src/analysis');
    const envelope = await pendingReviewAnalysis({
      args: ['transactions', 'pending-review', '--json'],
      mode: comp.mode,
      actorId: comp.actorId,
      requestId: comp.requestId,
      ledger: comp.ledger,
      freshness: comp.freshness,
      analysisProtocol: comp.analysisProtocol,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });
});
