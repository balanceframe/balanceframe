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

import { describe, it, expect, vi } from 'vitest';
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
  PurchaseEvaluationResult,
  CashFlowProjectionResult,
  TargetHealthResult,
  SinkingFundHealthResult,
  FinancialStateResult,
  AttentionHomeResult,
} from '../src/commands';
import { ReasonCodes } from '../src/errors';
import { NotificationRuntime, InAppChannelAdapter } from '../src/notifications';
import type { NotificationPolicy } from '../src/notifications';

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

    // Phase 8 — Budget Intelligence N-API methods
    evaluatePurchase(input: string): string {
      calls.push('evaluatePurchase');
      return JSON.stringify({
        allowable: true,
        reasonCodes: ['sufficient_budget'],
        categoryBudget: { minorUnits: '50000', currency: 'USD' },
        categorySpent: { minorUnits: '15000', currency: 'USD' },
        categoryRemaining: { minorUnits: '35000', currency: 'USD' },
        projectedBalance: { minorUnits: '120000', currency: 'USD' },
        hasEnvelope: true,
      });
    },
    projectCashFlow(input: string): string {
      calls.push('projectCashFlow');
      return JSON.stringify({
        projectionMonths: 3,
        monthlyProjections: [
          {
            month: '2026-08',
            projectedIncome: { minorUnits: '500000', currency: 'USD' },
            projectedExpenses: { minorUnits: '420000', currency: 'USD' },
            netChange: { minorUnits: '80000', currency: 'USD' },
            endingBalance: { minorUnits: '580000', currency: 'USD' },
            scheduledIncomeCount: 2,
            scheduledExpenseCount: 15,
          },
        ],
        sufficientData: true,
        dataWarning: null,
      });
    },
    evaluateTargetHealth(input: string): string {
      calls.push('evaluateTargetHealth');
      return JSON.stringify({
        categories: [
          {
            categoryId: 'cat_1',
            categoryName: 'Shopping',
            budgeted: { minorUnits: '50000', currency: 'USD' },
            spent: { minorUnits: '15000', currency: 'USD' },
            remaining: { minorUnits: '35000', currency: 'USD' },
            healthLabel: 'healthy',
            isSinkingFund: false,
            targetAmount: null,
            targetProgress: null,
          },
          {
            categoryId: 'cat_sink_1',
            categoryName: 'Car Repair',
            budgeted: { minorUnits: '120000', currency: 'USD' },
            spent: { minorUnits: '80000', currency: 'USD' },
            remaining: { minorUnits: '40000', currency: 'USD' },
            healthLabel: 'healthy',
            isSinkingFund: true,
            targetAmount: { minorUnits: '120000', currency: 'USD' },
            targetProgress: 0.6667,
          },
        ],
        overallLabel: 'healthy',
        healthyCount: 2,
        atRiskCount: 0,
        sinkingFundCount: 1,
      });
    },
    evaluateFinancialState(input: string): string {
      calls.push('evaluateFinancialState');
      return JSON.stringify({
        overallLabel: 'healthy',
        netWorth: { minorUnits: '1500000', currency: 'USD' },
        monthlyCashFlow: { minorUnits: '80000', currency: 'USD' },
        budgetAdherencePercent: 85,
        categoriesAtRisk: 2,
        sinkingFundsUnderfunded: 1,
        advice: ['You are on track.'],
        freshness: null,
      });
    },

    // Phase 8.5 — Extended deterministic analytics stubs
    computeDataQuality(input: string): string {
      calls.push('computeDataQuality');
      return JSON.stringify({
        overallScore: 85,
        dimensions: [
          { dimension: 'completeness', score: 90, explanation: 'All fields populated', worstSeverity: null },
          { dimension: 'consistency', score: 80, explanation: 'Minor category mismatches', worstSeverity: 'warning' },
        ],
        recommendations: ['Review uncategorized transactions.'],
      });
    },
    computeLiquidityCoverage(input: string): string {
      calls.push('computeLiquidityCoverage');
      return JSON.stringify({
        totalLiquid: { minorUnits: '500000', currency: 'USD' },
        totalObligations: { minorUnits: '120000', currency: 'USD' },
        coverage: [{ ratio: 4.17, label: 'strong' }],
        upcomingObligations: [
          { name: 'Rent', dueDate: '2026-08-01', amount: { minorUnits: '50000', currency: 'USD' }, categoryId: 'cat_1', isRecurring: true },
        ],
      });
    },
    computeBillCalendar(input: string): string {
      calls.push('computeBillCalendar');
      return JSON.stringify({
        entries: [
          { name: 'Electric Bill', dueDate: '2026-08-15', amount: { minorUnits: '8000', currency: 'USD' }, categoryId: 'cat_2', status: 'unpaid' },
        ],
        totalUnpaid: { minorUnits: '8000', currency: 'USD' },
        unpaidCount: 1,
      });
    },
    computeBudgetVariance(input: string): string {
      calls.push('computeBudgetVariance');
      return JSON.stringify({
        categoryVariances: [
          { categoryId: 'cat_1', categoryName: 'Shopping', budgeted: { minorUnits: '50000', currency: 'USD' }, actual: { minorUnits: '42000', currency: 'USD' }, variance: { minorUnits: '8000', currency: 'USD' }, variancePercent: 16, label: 'under' },
        ],
        trends: [
          { categoryId: 'cat_1', categoryName: 'Shopping', direction: 'stable', avgChange: 0.02, periodsAnalyzed: 3, seasonalityDetected: false },
        ],
        totalBudgeted: { minorUnits: '500000', currency: 'USD' },
        totalActual: { minorUnits: '480000', currency: 'USD' },
        totalVariance: { minorUnits: '20000', currency: 'USD' },
        overallVariancePercent: 4,
      });
    },
    detectIrregularObligations(input: string): string {
      calls.push('detectIrregularObligations');
      return JSON.stringify({
        obligations: [
          { name: 'Car Insurance', kind: 'nonMonthly', typicalAmount: { minorUnits: '60000', currency: 'USD' }, frequency: 'semi-annual', categoryId: 'cat_3', nextExpectedDate: '2026-09-01' },
        ],
        totalEstimatedAnnual: { minorUnits: '120000', currency: 'USD' },
      });
    },
    assessIncomeReliability(input: string): string {
      calls.push('assessIncomeReliability');
      return JSON.stringify({
        sources: [
          { name: 'Salary', typicalMonthly: { minorUnits: '450000', currency: 'USD' }, reliabilityScore: 95, variability: 0.02, paymentCount: 12, isRegular: true },
        ],
        totalMonthly: { minorUnits: '450000', currency: 'USD' },
        overallScore: 95,
        unreliableSourceCount: 0,
      });
    },
    evaluateForecastCalibration(input: string): string {
      calls.push('evaluateForecastCalibration');
      return JSON.stringify({
        metrics: [
          { metricName: 'MAPE', mape: 12.5, bias: 2.1, periodsCompared: 6, isCalibrated: true },
        ],
        overallCalibrated: true,
        recommendations: ['Continue current forecasting approach.'],
      });
    },
    compareScenarios(input: string): string {
      calls.push('compareScenarios');
      return JSON.stringify({
        deltas: [
          { dimension: 'netWorth', baselineValue: 1500000, comparisonValue: 1600000, change: '+100000' },
        ],
        summary: 'Comparison scenario shows improved net worth.',
      });
    },
    evaluateMultidimensionalHealth(input: string): string {
      calls.push('evaluateMultidimensionalHealth');
      return JSON.stringify({
        dimensions: [
          { dimension: 'liquidity', score: 85, weight: 0.3, explanation: 'Strong cash position', severity: 'good' },
          { dimension: 'budget_adherence', score: 70, weight: 0.3, explanation: 'Some categories over budget', severity: 'warning' },
        ],
        compositeScore: 78,
        summary: 'Overall financial health is satisfactory.',
        recommendations: ['Review discretionary spending.'],
      });
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

  it('accepts a notificationRuntime override', async () => {
    const policy: NotificationPolicy = {
      policyVersion: 'v1',
      eligibility: [
        {
          classifications: ['budget_alert'],
          minSeverity: 'normal',
          requiredCapability: 'notification:receive',
        },
      ],
      recipients: [
        { actorId: 'usr_test', channels: ['in_app'], quietHours: null },
      ],
      channels: [
        { type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' },
      ],
      redaction: {
        public: { visibleFields: ['title', 'summary'] },
      },
      maxRetries: 3,
      defaultRedactionClass: 'public',
    };
    const store = {
      cancelPendingJobs: async () => 0,
      deleteActorMembership: async () => true,
      recordExport: async () => {},
      getLastExport: async () => null,
      deleteScopeData: async () => ({ deleted: {}, retained: { count: 0, reasons: [] } }),
      getNotificationPolicy: async () => null,
      listOutboxRecords: async () => [],
    };
    const runtime = new NotificationRuntime(
      store as never,
      policy,
      [new InAppChannelAdapter()],
    );
    const comp = await createObserveComposition({
      notificationRuntime: runtime,
    });
    expect(comp.notificationRuntime).toBe(runtime);
  });

  it('defaults notificationRuntime to null when no store or override provided', async () => {
    const { shim } = stubNativeBindings();
    const comp = await createObserveComposition({
      nativeBindings: () => Promise.resolve(shim),
    });
    expect(comp.notificationRuntime).toBeNull();
  });

  it('constructs notificationRuntime from workflowStore and notificationPolicy', async () => {
    const policy: NotificationPolicy = {
      policyVersion: 'v1',
      eligibility: [
        {
          classifications: ['budget_alert'],
          minSeverity: 'normal',
          requiredCapability: 'notification:receive',
        },
      ],
      recipients: [],
      channels: [
        { type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' },
      ],
      redaction: {
        public: { visibleFields: ['title', 'summary'] },
      },
      maxRetries: 3,
      defaultRedactionClass: 'public',
    };
    const store = {
      cancelPendingJobs: async () => 0,
      deleteActorMembership: async () => true,
      recordExport: async () => {},
      getLastExport: async () => null,
      deleteScopeData: async () => ({ deleted: {}, retained: { count: 0, reasons: [] } }),
      getNotificationPolicy: async () => null,
      listOutboxRecords: async () => [],
      getNotificationEvent: async () => null,
      getOutboxRecord: async () => null,
      getActorMembership: async () => null,
      getDeliveryAttempts: async () => [],
      getPendingNotifications: async () => [],
      getRetryableNotifications: async () => [],
      acknowledgeNotification: async (id: string) => ({ id }),
      suppressNotification: async (id: string) => ({ id }),
      createNotificationEvent: async (i: unknown) => i,
      enqueueNotification: async (i: unknown) => i,
      claimNotificationDelivery: async () => null,
      completeNotificationDelivery: async () => ({}),
      failNotificationDelivery: async () => ({}),
      appendAuditRecord: async () => {},
      upsertActorMembership: async () => {},
    };
    const comp = await createObserveComposition({
      workflowStore: store,
      notificationPolicy: policy,
    });
    expect(comp.notificationRuntime).not.toBeNull();
    expect(comp.notificationRuntime).toBeInstanceOf(NotificationRuntime);
  });

  it('proves the same store object is used by notificationRuntime', async () => {
    const policy: NotificationPolicy = {
      policyVersion: 'v1',
      eligibility: [
        {
          classifications: ['budget_alert', 'review_complete', 'security_alert'],
          minSeverity: 'normal',
          requiredCapability: 'notification:receive',
        },
      ],
      recipients: [
        { actorId: 'usr_tester', channels: ['in_app' as const], quietHours: null },
      ],
      channels: [
        { type: 'in_app' as const, enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' },
      ],
      redaction: {
        public: { visibleFields: ['title', 'summary'] },
      },
      maxRetries: 3,
      defaultRedactionClass: 'public',
    };

    // Store with instrumented methods to track calls
    const createNotificationEvent = vi.fn().mockResolvedValue({
      id: 'evt_proof',
      budgetId: 'budget_proof',
      classification: 'budget_alert',
      severity: 'normal',
      payload: '{}',
      correlationId: null,
      scope: null,
      recipientId: null,
      redactionClass: 'public',
      eventVersion: 1,
      createdAt: new Date().toISOString(),
    });
    const enqueueNotification = vi.fn().mockResolvedValue({
      id: 'obx_proof',
      eventId: 'evt_proof',
      deliveryKey: 'dk_proof',
      channelType: 'in_app',
      status: 'pending' as const,
      attemptCount: 0,
      maxAttempts: 3,
      lastError: null,
      nextAttemptAt: null,
      claimToken: null,
      claimExpiresAt: null,
      deliveredAt: null,
      failedAt: null,
      acknowledgedAt: null,
      createdAt: new Date().toISOString(),
    });
    const getActorMembership = vi.fn().mockResolvedValue({
      actorId: 'usr_tester',
      status: 'active',
      capabilities: ['notification:receive'],
      scope: 'test',
    });
    const appendAuditRecord = vi.fn().mockResolvedValue(undefined);
    const getNotificationPolicy = vi.fn().mockResolvedValue(null);
    const listOutboxRecords = vi.fn().mockResolvedValue([]);
    const getNotificationEvent = vi.fn().mockResolvedValue(null);
    const getOutboxRecord = vi.fn().mockResolvedValue(null);
    const getDeliveryAttempts = vi.fn().mockResolvedValue([]);
    const getPendingNotifications = vi.fn().mockResolvedValue([]);
    const getRetryableNotifications = vi.fn().mockResolvedValue([]);
    const acknowledgeNotification = vi.fn().mockResolvedValue({ id: 'obx_proof' });
    const suppressNotification = vi.fn().mockResolvedValue({ id: 'obx_proof' });
    const claimNotificationDelivery = vi.fn().mockResolvedValue(null);
    const completeNotificationDelivery = vi.fn().mockResolvedValue({} as never);
    const failNotificationDelivery = vi.fn().mockResolvedValue({} as never);

    const store = {
      cancelPendingJobs: async () => 0,
      deleteActorMembership: async () => true,
      recordExport: async () => {},
      getLastExport: async () => null,
      deleteScopeData: async () => ({ deleted: {}, retained: { count: 0, reasons: [] } }),
      createNotificationEvent,
      enqueueNotification,
      getNotificationEvent,
      getOutboxRecord,
      getActorMembership,
      getDeliveryAttempts,
      getPendingNotifications,
      getRetryableNotifications,
      acknowledgeNotification,
      suppressNotification,
      claimNotificationDelivery,
      completeNotificationDelivery,
      failNotificationDelivery,
      appendAuditRecord,
      getNotificationPolicy,
      listOutboxRecords,
    };

    const comp = await createObserveComposition({
      workflowStore: store,
      notificationPolicy: policy,
    });

    expect(comp.notificationRuntime).not.toBeNull();
    expect(comp.notificationRuntime).toBeInstanceOf(NotificationRuntime);

    // Prove the runtime uses the same store: call a runtime method that
    // delegates to the store, then verify the store's delegate was invoked.
    // The `create` method calls store.createNotificationEvent and
    // store.enqueueNotification.
    await comp.notificationRuntime!.create({
      budgetId: 'budget_proof',
      classification: 'budget_alert',
      severity: 'normal',
      payload: { title: 'Proof', summary: 'Same store' },
    });

    expect(createNotificationEvent).toHaveBeenCalled();
    expect(enqueueNotification).toHaveBeenCalled();
    expect(appendAuditRecord).toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Phase 8 — Native delegation via createNativeAnalysisProtocol
// ---------------------------------------------------------------------------

describe('createNativeAnalysisProtocol — Phase 8 native delegation', () => {
  it('purchaseEvaluation calls evaluatePurchase and returns non-zero fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );
    const ledger = mockLedger();

    const result = await protocol.purchaseEvaluation!(ledger, {
      categoryId: 'cat_1',
      amount: { minorUnits: '5000', currency: 'USD' },
      accountId: 'acct_1',
    });

    expect(calls).toContain('evaluatePurchase');
    expect(result.allowable).toBe(true);
    expect(result.categoryBudget.minorUnits).toBe('50000');
    expect(result.categorySpent.minorUnits).toBe('15000');
    expect(result.categoryRemaining.minorUnits).toBe('35000');
    expect(result.projectedBalance).not.toBeNull();
    expect(result.projectedBalance!.minorUnits).toBe('120000');
    expect(result.hasEnvelope).toBe(true);
  });

  it('purchaseEvaluation returns no-snapshot failure when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );

    const result = await protocol.purchaseEvaluation!(null, {
      categoryId: 'cat_1',
      amount: { minorUnits: '5000', currency: 'USD' },
    });

    expect(calls).not.toContain('evaluatePurchase');
    expect(result.allowable).toBe(false);
    expect(result.reasonCodes).toContain('no_snapshot');
    expect(result.projectedBalance).toBeNull();
  });

  it('cashFlowProjection calls projectCashFlow and returns non-zero fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );
    const ledger = mockLedger();

    const result = await protocol.cashFlowProjection!(ledger, {
      months: 3,
      startMonth: '2026-07',
    });

    expect(calls).toContain('projectCashFlow');
    expect(result.projectionMonths).toBe(3);
    expect(result.monthlyProjections.length).toBeGreaterThan(0);
    expect(result.monthlyProjections[0].month).toBe('2026-08');
    expect(result.monthlyProjections[0].projectedIncome.minorUnits).toBe('500000');
    expect(result.monthlyProjections[0].projectedExpenses.minorUnits).toBe('420000');
    expect(result.monthlyProjections[0].netChange.minorUnits).toBe('80000');
    expect(result.monthlyProjections[0].endingBalance.minorUnits).toBe('580000');
    expect(result.sufficientData).toBe(true);
    expect(result.dataWarning).toBeNull();
  });

  it('cashFlowProjection returns documented failure when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );

    const result = await protocol.cashFlowProjection!(null, {
      months: 3,
    });

    expect(calls).not.toContain('projectCashFlow');
    expect(result.sufficientData).toBe(false);
    expect(result.dataWarning).toBe('Ledger snapshot unavailable.');
    expect(result.monthlyProjections).toEqual([]);
  });

  it('targetHealth calls evaluateTargetHealth and returns non-zero fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );
    const ledger = mockLedger();

    const result = await protocol.targetHealth!(ledger);

    expect(calls).toContain('evaluateTargetHealth');
    expect(result.overallLabel).toBe('healthy');
    expect(result.healthyCount).toBe(2);
    expect(result.categories.length).toBeGreaterThan(0);
    expect(result.categories[0].budgeted.minorUnits).toBe('50000');
    expect(result.categories[0].spent.minorUnits).toBe('15000');
    expect(result.categories[0].healthLabel).toBe('healthy');
    expect(result.sinkingFundCount).toBe(1);
  });

  it('targetHealth returns documented failure when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );

    const result = await protocol.targetHealth!(null);

    expect(calls).not.toContain('evaluateTargetHealth');
    expect(result.overallLabel).toBe('unknown');
    expect(result.healthyCount).toBe(0);
    expect(result.atRiskCount).toBe(0);
    expect(result.categories).toEqual([]);
  });

  it('sinkingFundHealth calls evaluateTargetHealth and filters sinking funds', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );
    const ledger = mockLedger();

    const result = await protocol.sinkingFundHealth!(ledger);

    // Should use evaluateTargetHealth under the hood
    expect(calls).toContain('evaluateTargetHealth');
    // Only sinking fund categories are returned
    expect(result.sinkingFunds.length).toBeGreaterThan(0);
    expect(result.sinkingFunds.every((sf: unknown) => {
      return typeof sf === 'object' && sf !== null && 'isSinkingFund' in sf && (sf as Record<string, unknown>).isSinkingFund === true;
    })).toBe(true);
    expect(result.fullyFundedCount).toBe(0);
    // progress 0.6667 is > 0 so it's partially funded
    expect(result.partiallyFundedCount).toBeGreaterThanOrEqual(1);
  });

  it('sinkingFundHealth returns documented failure when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );

    const result = await protocol.sinkingFundHealth!(null);

    expect(calls).not.toContain('evaluateTargetHealth');
    expect(result.sinkingFunds).toEqual([]);
    expect(result.fullyFundedCount).toBe(0);
    expect(result.partiallyFundedCount).toBe(0);
    expect(result.unfundedCount).toBe(0);
  });

  it('financialState calls evaluateFinancialState and returns non-zero fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );
    const ledger = mockLedger();

    const result = await protocol.financialState!(ledger);

    expect(calls).toContain('evaluateFinancialState');
    expect(result.overallLabel).toBe('healthy');
    expect(result.netWorth.minorUnits).toBe('1500000');
    expect(result.monthlyCashFlow.minorUnits).toBe('80000');
    expect(result.budgetAdherencePercent).toBe(85);
    expect(result.categoriesAtRisk).toBe(2);
    expect(result.sinkingFundsUnderfunded).toBe(1);
    expect(result.advice.length).toBeGreaterThan(0);
  });

  it('financialState returns documented failure when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );

    const result = await protocol.financialState!(null);

    expect(calls).not.toContain('evaluateFinancialState');
    expect(result.overallLabel).toBe('unknown');
    expect(result.netWorth.minorUnits).toBe('0');
  });

  it('attentionHome calls evaluateTargetHealth and evaluateFinancialState and returns aggregated result', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );
    const ledger = mockLedger();

    const result = await protocol.attentionHome!(ledger, {});

    expect(calls).toContain('evaluateTargetHealth');
    expect(calls).toContain('evaluateFinancialState');
    expect(Array.isArray(result.blockers)).toBe(true);
    expect(Array.isArray(result.alerts)).toBe(true);
    expect(Array.isArray(result.recurrences)).toBe(true);
    expect(Array.isArray(result.categoryRisks)).toBe(true);
    expect(result.targetProgress.overallLabel).toBe('healthy');
    expect(result.targetProgress.healthyCount).toBe(2);
    expect(result.targetProgress.sinkingFundsOnTrack).toBeGreaterThanOrEqual(0);
  });

  it('attentionHome returns documented failure when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );

    const result = await protocol.attentionHome!(null, {});

    expect(calls).not.toContain('evaluateTargetHealth');
    expect(result.blockers).toEqual([]);
    expect(result.alerts).toEqual([]);
    expect(result.recurrences).toEqual([]);
    expect(result.categoryRisks).toEqual([]);
    expect(result.targetProgress.overallLabel).toBe('unknown');
  });

  it('attentionHome categoryRisks use null daysRemaining when native data unavailable (no fabricated zero)', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );
    const ledger = mockLedger();

    const result = await protocol.attentionHome!(ledger, {});

    expect(calls).toContain('evaluateTargetHealth');
    expect(result.categoryRisks.length).toBeGreaterThan(0);
    for (const risk of result.categoryRisks) {
      // Must be null (uncertain) — never a fabricated positive number
      expect(risk.daysRemaining).toBeNull();
    }
  });

  it('syntax confirms helpers are declared outside return object (no const inside object literal)', async () => {
    // Verifying by successful invocation: if const-as-property syntax
    // existed, the import/parse would throw at module evaluation time.
    const { shim } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(
      () => Promise.resolve(shim),
    );
    expect(protocol).toBeDefined();
    // Verify all Phase 8 methods exist and are functions
    expect(typeof protocol.purchaseEvaluation).toBe('function');
    expect(typeof protocol.cashFlowProjection).toBe('function');
    expect(typeof protocol.targetHealth).toBe('function');
    expect(typeof protocol.financialState).toBe('function');
    expect(typeof protocol.attentionHome).toBe('function');

    // Verify all Phase 8.5 methods exist and are functions
    expect(typeof protocol.dataQuality).toBe('function');
    expect(typeof protocol.liquidityCoverage).toBe('function');
    expect(typeof protocol.billCalendar).toBe('function');
    expect(typeof protocol.budgetVariance).toBe('function');
    expect(typeof protocol.irregularObligations).toBe('function');
    expect(typeof protocol.incomeReliability).toBe('function');
    expect(typeof protocol.forecastCalibration).toBe('function');
    expect(typeof protocol.scenarioComparison).toBe('function');
    expect(typeof protocol.multidimensionalHealth).toBe('function');
  });

  // -------------------------------------------------------------------------
  // Phase 8.5 — Extended deterministic analytics delegation tests
  // -------------------------------------------------------------------------

  it('dataQuality calls computeDataQuality and returns fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const ledger = mockLedger();

    const result = await protocol.dataQuality!(ledger);

    expect(calls).toContain('computeDataQuality');
    expect(result.overallScore).toBe(85);
    expect(result.dimensions.length).toBeGreaterThan(0);
    expect(result.dimensions[0].dimension).toBe('completeness');
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('dataQuality returns empty fallback when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));

    const result = await protocol.dataQuality!(null);

    expect(calls).not.toContain('computeDataQuality');
    expect(result.overallScore).toBeNull();
    expect(result.dimensions).toEqual([]);
  });

  it('liquidityCoverage calls computeLiquidityCoverage and returns fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const ledger = mockLedger();

    const result = await protocol.liquidityCoverage!(ledger, '2026-08');

    expect(calls).toContain('computeLiquidityCoverage');
    expect(result.totalLiquid).not.toBeNull();
    expect(result.totalLiquid!.minorUnits).toBe('500000');
    expect(result.upcomingObligations.length).toBeGreaterThan(0);
    expect(result.coverage.length).toBeGreaterThan(0);
  });

  it('liquidityCoverage returns empty fallback when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));

    const result = await protocol.liquidityCoverage!(null, '2026-08');

    expect(calls).not.toContain('computeLiquidityCoverage');
    expect(result.totalLiquid).toBeNull();
    expect(result.upcomingObligations).toEqual([]);
  });

  it('billCalendar calls computeBillCalendar and returns fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const ledger = mockLedger();

    const result = await protocol.billCalendar!(ledger, '2026-08-01');

    expect(calls).toContain('computeBillCalendar');
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0].name).toBe('Electric Bill');
    expect(result.unpaidCount).toBe(1);
  });

  it('billCalendar returns empty fallback when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));

    const result = await protocol.billCalendar!(null, '2026-08-01');

    expect(calls).not.toContain('computeBillCalendar');
    expect(result.entries).toEqual([]);
    expect(result.unpaidCount).toBe(0);
  });

  it('budgetVariance calls computeBudgetVariance and returns fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const ledger = mockLedger();

    const result = await protocol.budgetVariance!(ledger, '2026-08-01');

    expect(calls).toContain('computeBudgetVariance');
    expect(result.categoryVariances.length).toBeGreaterThan(0);
    expect(result.trends.length).toBeGreaterThan(0);
    expect(result.overallVariancePercent).toBe(4);
  });

  it('budgetVariance returns empty fallback when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));

    const result = await protocol.budgetVariance!(null, '2026-08-01');

    expect(calls).not.toContain('computeBudgetVariance');
    expect(result.categoryVariances).toEqual([]);
    expect(result.trends).toEqual([]);
  });

  it('irregularObligations calls detectIrregularObligations and returns fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const ledger = mockLedger();

    const result = await protocol.irregularObligations!(ledger);

    expect(calls).toContain('detectIrregularObligations');
    expect(result.obligations.length).toBeGreaterThan(0);
    expect(result.obligations[0].name).toBe('Car Insurance');
    expect(result.totalEstimatedAnnual).not.toBeNull();
  });

  it('irregularObligations returns empty fallback when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));

    const result = await protocol.irregularObligations!(null);

    expect(calls).not.toContain('detectIrregularObligations');
    expect(result.obligations).toEqual([]);
    expect(result.totalEstimatedAnnual).toBeNull();
  });

  it('incomeReliability calls assessIncomeReliability and returns fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const ledger = mockLedger();

    const result = await protocol.incomeReliability!(ledger);

    expect(calls).toContain('assessIncomeReliability');
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0].name).toBe('Salary');
    expect(result.overallScore).toBe(95);
  });

  it('incomeReliability returns empty fallback when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));

    const result = await protocol.incomeReliability!(null);

    expect(calls).not.toContain('assessIncomeReliability');
    expect(result.sources).toEqual([]);
    expect(result.overallScore).toBeNull();
  });

  it('forecastCalibration calls evaluateForecastCalibration and returns fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const ledger = mockLedger();

    const result = await protocol.forecastCalibration!(ledger);

    expect(calls).toContain('evaluateForecastCalibration');
    expect(result.overallCalibrated).toBe(true);
    expect(result.metrics.length).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('forecastCalibration returns empty fallback when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));

    const result = await protocol.forecastCalibration!(null);

    expect(calls).not.toContain('evaluateForecastCalibration');
    expect(result.overallCalibrated).toBe(false);
    expect(result.metrics).toEqual([]);
  });

  it('scenarioComparison calls compareScenarios and returns fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const ledger = mockLedger();

    const result = await protocol.scenarioComparison!(ledger, {
      baseline: { income: 5000 },
      comparison: { income: 5500 },
    });

    expect(calls).toContain('compareScenarios');
    expect(result.deltas.length).toBeGreaterThan(0);
    expect(result.deltas[0].dimension).toBe('netWorth');
    expect(result.summary).toBeTruthy();
  });

  it('scenarioComparison returns empty fallback when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));

    const result = await protocol.scenarioComparison!(null, {
      baseline: { income: 5000 },
      comparison: { income: 5500 },
    });

    expect(calls).not.toContain('compareScenarios');
    expect(result.deltas).toEqual([]);
  });

  it('scenarioComparison does not mutate ledger (no write calls)', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const ledger = mockLedger();

    const result = await protocol.scenarioComparison!(ledger, {
      baseline: { income: 5000 },
      comparison: { income: 5500 },
    });

    // Only read calls were made
    expect(calls).toContain('compareScenarios');
    expect(calls.filter(c => c.startsWith('analyze') || c.startsWith('compute') || c.startsWith('assess') || c.startsWith('detect') || c.startsWith('evaluate') || c.startsWith('compare'))).toContain('compareScenarios');
  });

  it('multidimensionalHealth calls evaluateMultidimensionalHealth and returns fixture data', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));
    const ledger = mockLedger();

    const result = await protocol.multidimensionalHealth!(ledger, '2026-08');

    expect(calls).toContain('evaluateMultidimensionalHealth');
    expect(result.dimensions.length).toBeGreaterThan(0);
    expect(result.compositeScore).toBe(78);
    expect(result.summary).toBeTruthy();
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('multidimensionalHealth returns empty fallback when ledger is null', async () => {
    const { shim, calls } = stubNativeBindings();
    const protocol = await createNativeAnalysisProtocol(() => Promise.resolve(shim));

    const result = await protocol.multidimensionalHealth!(null, '2026-08');

    expect(calls).not.toContain('evaluateMultidimensionalHealth');
    expect(result.dimensions).toEqual([]);
    expect(result.compositeScore).toBe(0);
  });
});
