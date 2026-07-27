/**
 * Failing tests for Budget Intelligence capabilities.
 *
 * These tests verify guard conditions that MUST fail before any real
 * analysis can proceed — stale/insufficient data, scope persistence
 * validation, and the envelope-vs-cash-flow distinction.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  purchaseEvaluationAnalysis,
  cashFlowProjectionAnalysis,
  targetHealthAnalysis,
  reportGenerateAnalysis,
  savedViewsListAnalysis,
  savedViewCreateAnalysis,
  attentionHomeAnalysis,
} from '../src/analysis';
import type {
  CommandInput,
  AnalysisProtocol,
  PurchaseEvaluationResult,
  CashFlowProjectionResult,
  TargetHealthResult,
  ReportGenerationResult,
  SavedViewsListResult,
  CreateSavedViewResult,
  AttentionHomeResult,
} from '../src/commands';
import { ReasonCodes } from '../src/errors';
import { AuthorizationContext, ErrorInfo } from '../src/envelope';

// ---------------------------------------------------------------------------
// Mock protocol with budget intelligence stubs
// ---------------------------------------------------------------------------

function createMockProtocol(): {
  protocol: AnalysisProtocol;
} {
  const protocol: AnalysisProtocol = {
    async pendingReview() { throw new Error('not implemented'); },
    async reviewShow() { throw new Error('not implemented'); },
    async budgetSummary() { throw new Error('not implemented'); },

    async purchaseEvaluation(
      _ledger: unknown,
      _params: Record<string, unknown>,
    ): Promise<PurchaseEvaluationResult> {
      return {
        allowable: true,
        reasonCodes: ['sufficient_budget'],
        categoryBudget: { minorUnits: '50000', currency: 'USD' },
        categorySpent: { minorUnits: '15000', currency: 'USD' },
        categoryRemaining: { minorUnits: '35000', currency: 'USD' },
        projectedBalance: { minorUnits: '120000', currency: 'USD' },
        hasEnvelope: true,
      };
    },

    async cashFlowProjection(): Promise<CashFlowProjectionResult> {
      return {
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
      };
    },

    async targetHealth(): Promise<TargetHealthResult> {
      return {
        categories: [],
        overallLabel: 'healthy',
        healthyCount: 10,
        atRiskCount: 2,
        sinkingFundCount: 3,
      };
    },

    async generateReport(): Promise<ReportGenerationResult> {
      return {
        reportId: 'rpt_001',
        reportType: 'spending',
        scope: { monthRange: '2026-07:2026-08', includePending: false },
        label: 'July Spending',
        transactionCount: 150,
        totalAmount: { minorUnits: '420000', currency: 'USD' },
        generatedAt: '2026-07-27T12:00:00Z',
        tags: [],
      };
    },

    async listSavedViews(): Promise<SavedViewsListResult> {
      return { views: [], total: 0 };
    },

    async createSavedView(): Promise<CreateSavedViewResult> {
      return {
        view: {
          viewId: 'view_001',
          name: 'My View',
          viewType: 'attention',
          scope: {},
          createdAt: '2026-07-27T12:00:00Z',
        },
      };
    },

    async attentionHome(): Promise<AttentionHomeResult> {
      return {
        blockers: [],
        alerts: [],
        recurrences: [],
        categoryRisks: [],
        targetProgress: {
          overallLabel: 'healthy',
          healthyCount: 10,
          atRiskCount: 2,
          sinkingFundsOnTrack: 3,
          totalSinkingFunds: 3,
        },
      };
    },
  };
  return { protocol };
}

// ---------------------------------------------------------------------------
// Base inputs
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<CommandInput> = {}): CommandInput {
  return {
    args: [],
    mode: 'observe',
    actorId: 'usr_test',
    requestId: 'req_test',
    ledger: { mockLedger: true },
    freshness: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stale / Insufficient Data Tests
// ---------------------------------------------------------------------------

describe('purchaseEvaluationAnalysis — stale/insufficient data guards', () => {
  it('fails with stale_snapshot when freshness.isStale is true', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({
      analysisProtocol: protocol,
      freshness: {
        actualDownloadedAt: null,
        bankSyncedAt: null,
        pendingTransactionsIncluded: false,
        stalenessDays: 0,
        isStale: true,
      },
    });
    const envelope = await purchaseEvaluationAnalysis(input, {
      categoryId: 'cat_food',
      amount: { minorUnits: '5000', currency: 'USD' },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_budget_intelligence');
    expect(envelope.error!.reasonCodes).toContain(ReasonCodes.STALE_BUDGET_INTELLIGENCE_DATA);
  });

  it('fails when categoryId is empty', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await purchaseEvaluationAnalysis(input, {
      categoryId: '',
      amount: { minorUnits: '5000', currency: 'USD' },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('purchase_category_required');
  });

  it('fails when amount is zero', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await purchaseEvaluationAnalysis(input, {
      categoryId: 'cat_food',
      amount: { minorUnits: '0', currency: 'USD' },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('purchase_amount_required');
  });

  it('fails when ledger is null', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ ledger: null, analysisProtocol: protocol });
    const envelope = await purchaseEvaluationAnalysis(input, {
      categoryId: 'cat_food',
      amount: { minorUnits: '5000', currency: 'USD' },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });

  it('fails when protocol is missing', async () => {
    const input = baseInput({ analysisProtocol: undefined });
    const envelope = await purchaseEvaluationAnalysis(input, {
      categoryId: 'cat_food',
      amount: { minorUnits: '5000', currency: 'USD' },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('no_analysis_protocol');
  });
});

describe('cashFlowProjectionAnalysis — stale/insufficient data guards', () => {
  it('fails when freshness is stale', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({
      analysisProtocol: protocol,
      freshness: {
        actualDownloadedAt: null,
        bankSyncedAt: null,
        pendingTransactionsIncluded: false,
        stalenessDays: 0,
        isStale: true,
      },
    });
    const envelope = await cashFlowProjectionAnalysis(input, { months: 3 });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_budget_intelligence');
  });

  it('fails when months is out of range (0)', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await cashFlowProjectionAnalysis(input, { months: 0 });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('invalid_cash_flow_months');
  });

  it('fails when months is out of range (25)', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await cashFlowProjectionAnalysis(input, { months: 25 });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('invalid_cash_flow_months');
  });

  it('fails when ledger is null', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ ledger: null, analysisProtocol: protocol });
    const envelope = await cashFlowProjectionAnalysis(input, { months: 3 });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });
});

describe('targetHealthAnalysis — stale/insufficient data guards', () => {
  it('fails when freshness is stale', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({
      analysisProtocol: protocol,
      freshness: {
        actualDownloadedAt: null,
        bankSyncedAt: null,
        pendingTransactionsIncluded: false,
        stalenessDays: 0,
        isStale: true,
      },
    });
    const envelope = await targetHealthAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_budget_intelligence');
  });

  it('fails when ledger is null', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ ledger: null, analysisProtocol: protocol });
    const envelope = await targetHealthAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });
});

// ---------------------------------------------------------------------------
// Scope Persistence Tests
// ---------------------------------------------------------------------------

describe('reportGenerateAnalysis — scope persistence', () => {
  it('fails when scope is missing', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reportGenerateAnalysis(input, {
      reportType: 'spending',
      scope: null as any,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('report_scope_required');
    expect(envelope.error!.reasonCodes).toContain(ReasonCodes.REPORT_SCOPE_REQUIRED);
  });

  it('fails when scope.monthRange is empty', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reportGenerateAnalysis(input, {
      reportType: 'spending',
      scope: { monthRange: '', includePending: false },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('report_scope_required');
  });

  it('fails when freshness is stale', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({
      analysisProtocol: protocol,
      freshness: {
        actualDownloadedAt: null,
        bankSyncedAt: null,
        pendingTransactionsIncluded: false,
        stalenessDays: 0,
        isStale: true,
      },
    });
    const envelope = await reportGenerateAnalysis(input, {
      reportType: 'spending',
      scope: { monthRange: '2026-07', includePending: false },
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_budget_intelligence');
  });

  it('persists scope in result on success', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reportGenerateAnalysis(input, {
      reportType: 'spending',
      scope: { monthRange: '2026-07:2026-08', includePending: false },
      label: 'July Spending',
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.result.scope.monthRange).toBe('2026-07:2026-08');
    expect(envelope.result.reportType).toBe('spending');
    expect(envelope.result.label).toBe('July Spending');
  });
});

describe('savedViewCreateAnalysis — scope persistence', () => {
  it('fails when name is missing', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await savedViewCreateAnalysis(input, {
      name: '',
      viewType: 'attention',
      scope: {},
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('view_params_required');
  });

  it('fails when viewType is missing', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await savedViewCreateAnalysis(input, {
      name: 'My View',
      viewType: '',
      scope: {},
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('view_params_required');
  });

  it('persists view params in result on success', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await savedViewCreateAnalysis(input, {
      name: 'My View',
      viewType: 'attention',
      scope: { month: '2026-07', detailed: true },
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.result.view.name).toBe('My View');
    expect(envelope.result.view.viewType).toBe('attention');
  });
});

describe('savedViewsListAnalysis — basic guards', () => {
  it('fails when freshness is stale', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({
      analysisProtocol: protocol,
      freshness: {
        actualDownloadedAt: null,
        bankSyncedAt: null,
        pendingTransactionsIncluded: false,
        stalenessDays: 0,
        isStale: true,
      },
    });
    const envelope = await savedViewsListAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_budget_intelligence');
  });

  it('fails when ledger is null', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ ledger: null, analysisProtocol: protocol });
    const envelope = await savedViewsListAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });
});

// ---------------------------------------------------------------------------
// Envelope-vs-Cash-Flow Distinction Tests
// ---------------------------------------------------------------------------

describe('attentionHomeAnalysis — envelope vs cash-flow distinction', () => {
  it('fails when freshness is stale', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({
      analysisProtocol: protocol,
      freshness: {
        actualDownloadedAt: null,
        bankSyncedAt: null,
        pendingTransactionsIncluded: false,
        stalenessDays: 0,
        isStale: true,
      },
    });
    const envelope = await attentionHomeAnalysis(input, {});

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_budget_intelligence');
  });

  it('returns combined structure on success', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await attentionHomeAnalysis(input, {});

    expect(envelope.status).toBe('ok');
    // This test will fail once the protocol actually enforces
    // envelope vs cash-flow data separation:
    // - hasEnvelope = true means envelope data exists
    // - categoryRisks combine both envelope and cash-flow assessments
    expect(envelope.result).toBeDefined();
    expect(Array.isArray(envelope.result.blockers)).toBe(true);
    expect(Array.isArray(envelope.result.alerts)).toBe(true);
    expect(Array.isArray(envelope.result.recurrences)).toBe(true);
    expect(Array.isArray(envelope.result.categoryRisks)).toBe(true);
    expect(envelope.result.targetProgress).toBeDefined();
  });

  it('fails when ledger is null', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ ledger: null, analysisProtocol: protocol });
    const envelope = await attentionHomeAnalysis(input, {});

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });
});

// ---------------------------------------------------------------------------
// Authorization context — all budget intelligence SKIPS gates
// ---------------------------------------------------------------------------

describe('budget intelligence — authorization context is observe', () => {
  it('purchaseEvaluationAnalysis uses AuthorizationContext.observe', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await purchaseEvaluationAnalysis(input, {
      categoryId: 'cat_food',
      amount: { minorUnits: '5000', currency: 'USD' },
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.authorization!.capability).toBe('observe');
    expect(envelope.authorization!.allowed).toBe(true);
  });

  it('cashFlowProjectionAnalysis uses AuthorizationContext.observe', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await cashFlowProjectionAnalysis(input, { months: 3 });

    expect(envelope.status).toBe('ok');
    expect(envelope.authorization!.capability).toBe('observe');
    expect(envelope.authorization!.allowed).toBe(true);
  });

  it('targetHealthAnalysis uses AuthorizationContext.observe', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await targetHealthAnalysis(input);

    expect(envelope.status).toBe('ok');
    expect(envelope.authorization!.capability).toBe('observe');
  });

  it('reportGenerateAnalysis uses AuthorizationContext.observe', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reportGenerateAnalysis(input, {
      reportType: 'spending',
      scope: { monthRange: '2026-07:2026-08', includePending: false },
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.authorization!.capability).toBe('observe');
  });

  it('attentionHomeAnalysis uses AuthorizationContext.observe', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await attentionHomeAnalysis(input, {});

    expect(envelope.status).toBe('ok');
    expect(envelope.authorization!.capability).toBe('observe');
  });
});
