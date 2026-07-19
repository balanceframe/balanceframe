import { describe, it, expect, vi } from 'vitest';
import {
  pendingReviewAnalysis,
  reviewShowAnalysis,
  budgetSummaryAnalysis,
} from '../src/analysis';
import type {
  CommandInput,
  AnalysisProtocol,
  PendingReviewResult,
  ReviewDetailResult,
  BudgetSummaryResult,
} from '../src/commands';
import { ReasonCodes } from '../src/errors';
import { AuthorizationContext, ErrorInfo } from '../src/envelope';

// ---------------------------------------------------------------------------
// Mock protocol
// ---------------------------------------------------------------------------

function createMockProtocol(): {
  protocol: AnalysisProtocol;
  calls: { pendingReview: unknown[]; reviewShow: unknown[]; budgetSummary: unknown[] };
} {
  const calls: { pendingReview: unknown[]; reviewShow: unknown[]; budgetSummary: unknown[] } = {
    pendingReview: [],
    reviewShow: [],
    budgetSummary: [],
  };
  const protocol: AnalysisProtocol = {
    async pendingReview(ledger, freshness) {
      calls.pendingReview.push({ ledger, freshness });
      const result: PendingReviewResult = {
        uncategorizedCount: 5,
        totalUncategorizedAmount: { minorUnits: '15000', currency: 'USD' },
        candidates: [
          {
            transactionId: 'tx_001',
            amount: { minorUnits: '5000', currency: 'USD' },
            payeeName: 'Test Store',
            date: '2026-07-15',
            reasons: [{ kind: 'uncategorized', details: 'No category assigned' }],
          },
        ],
        oldestUncategorizedDate: '2026-06-01',
        healthState: 'healthy',
        blockers: [],
      };
      return result;
    },
    async reviewShow(ledger, reviewId) {
      calls.reviewShow.push({ ledger, reviewId });
      const result: ReviewDetailResult = {
        reviewId,
        generatedAt: '2026-07-18T12:00:00Z',
        status: 'pending_review',
        description: 'Review 5 uncategorized transactions',
        totalAmount: { minorUnits: '15000', currency: 'USD' },
        itemCount: 5,
        items: [
          {
            transactionId: 'tx_001',
            amount: { minorUnits: '5000', currency: 'USD' },
            payeeName: 'Test Store',
            date: '2026-07-15',
            categoryName: null,
            suggestedCategoryId: 'cat_food',
            suggestedCategoryName: 'Food & Dining',
            confidence: 0.85,
            reasonCodes: ['exact_payee_match'],
          },
        ],
      };
      return result;
    },
    async budgetSummary(ledger) {
      calls.budgetSummary.push({ ledger });
      const result: BudgetSummaryResult = {
        month: '2026-07',
        totalBudgeted: { minorUnits: '500000', currency: 'USD' },
        totalSpent: { minorUnits: '120000', currency: 'USD' },
        totalRemaining: { minorUnits: '380000', currency: 'USD' },
        categories: [
          {
            categoryId: 'cat_1',
            categoryName: 'Food & Dining',
            budgeted: { minorUnits: '200000', currency: 'USD' },
            spent: { minorUnits: '85000', currency: 'USD' },
            remaining: { minorUnits: '115000', currency: 'USD' },
          },
        ],
      };
      return result;
    },
  };
  return { protocol, calls };
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
// pendingReviewAnalysis
// ---------------------------------------------------------------------------

describe('pendingReviewAnalysis', () => {
  it('calls protocol.pendingReview and returns success envelope', async () => {
    const { protocol, calls } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await pendingReviewAnalysis(input);

    expect(calls.pendingReview).toHaveLength(1);
    expect(calls.pendingReview[0]).toMatchObject({ ledger: input.ledger, freshness: null });
    expect(envelope.status).toBe('ok');
    expect(envelope.result).toBeTruthy();
    expect(envelope.result.uncategorizedCount).toBe(5);
    expect(envelope.result.totalUncategorizedAmount.minorUnits).toBe('15000');
    expect(envelope.authorization).toBeTruthy();
    expect(envelope.authorization!.actorId).toBe('usr_test');
    expect(envelope.authorization!.capability).toBe('observe');
    expect(envelope.authorization!.allowed).toBe(true);
  });

  it('returns error when ledger is null', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ ledger: null, analysisProtocol: protocol });
    const envelope = await pendingReviewAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });

  it('returns error when freshness is stale', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({
      analysisProtocol: protocol,
      freshness: {
        actualDownloadedAt: '2026-06-01T00:00:00Z',
        bankSyncedAt: null,
        pendingTransactionsIncluded: false,
        stalenessDays: 30,
        isStale: true,
      },
    });
    const envelope = await pendingReviewAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_snapshot');
  });

  it('returns error when analysisProtocol is missing', async () => {
    const input = baseInput({ analysisProtocol: undefined });
    const envelope = await pendingReviewAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('no_analysis_protocol');
    expect(envelope.error!.reasonCodes).toContain(ReasonCodes.MISSING_ANALYSIS_PROTOCOL);
  });

  it('returns error envelope when protocol throws', async () => {
    const protocol: AnalysisProtocol = {
      async pendingReview() {
        throw new Error('Protocol unavailable');
      },
      async reviewShow() {
        return {} as ReviewDetailResult;
      },
      async budgetSummary() {
        return {} as BudgetSummaryResult;
      },
    };
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await pendingReviewAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('analysis_failed');
    expect(envelope.error!.message).toContain('Protocol unavailable');
  });
});

// ---------------------------------------------------------------------------
// reviewShowAnalysis
// ---------------------------------------------------------------------------

describe('reviewShowAnalysis', () => {
  it('calls protocol.reviewShow and returns success envelope', async () => {
    const { protocol, calls } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reviewShowAnalysis(input, 'rev_test');

    expect(calls.reviewShow).toHaveLength(1);
    expect(calls.reviewShow[0]).toMatchObject({ ledger: input.ledger, reviewId: 'rev_test' });
    expect(envelope.status).toBe('ok');
    expect(envelope.result.reviewId).toBe('rev_test');
    expect(envelope.result.items).toHaveLength(1);
    expect(envelope.authorization).toBeTruthy();
    expect(envelope.authorization!.actorId).toBe('usr_test');
    expect(envelope.authorization!.capability).toBe('observe');
    expect(envelope.authorization!.allowed).toBe(true);
  });

  it('returns error when ledger is null', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ ledger: null, analysisProtocol: protocol });
    const envelope = await reviewShowAnalysis(input, 'rev_test');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });

  it('returns error when freshness is stale (fail-closed guard)', async () => {
    const { protocol, calls } = createMockProtocol();
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
    const envelope = await reviewShowAnalysis(input, 'rev_test');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_snapshot');
    expect(calls.reviewShow).toHaveLength(0);
  });

  it('returns error when analysisProtocol is missing', async () => {
    const input = baseInput({ analysisProtocol: undefined });
    const envelope = await reviewShowAnalysis(input, 'rev_test');

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('no_analysis_protocol');
    expect(envelope.error!.reasonCodes).toContain(ReasonCodes.MISSING_ANALYSIS_PROTOCOL);
  });

  it('does not call protocol when freshness is stale', async () => {
    const { protocol, calls } = createMockProtocol();
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
    await reviewShowAnalysis(input, 'rev_test');

    expect(calls.reviewShow).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// budgetSummaryAnalysis
// ---------------------------------------------------------------------------

describe('budgetSummaryAnalysis', () => {
  it('calls protocol.budgetSummary and returns success envelope', async () => {
    const { protocol, calls } = createMockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await budgetSummaryAnalysis(input);

    expect(calls.budgetSummary).toHaveLength(1);
    expect(calls.budgetSummary[0]).toMatchObject({ ledger: input.ledger });
    expect(envelope.status).toBe('ok');
    expect(envelope.result.month).toBe('2026-07');
    expect(envelope.result.categories).toHaveLength(1);
    expect(envelope.authorization).toBeTruthy();
    expect(envelope.authorization!.actorId).toBe('usr_test');
    expect(envelope.authorization!.capability).toBe('observe');
    expect(envelope.authorization!.allowed).toBe(true);
  });

  it('returns error when ledger is null', async () => {
    const { protocol } = createMockProtocol();
    const input = baseInput({ ledger: null, analysisProtocol: protocol });
    const envelope = await budgetSummaryAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });

  it('returns error when freshness is stale (fail-closed guard)', async () => {
    const { protocol, calls } = createMockProtocol();
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
    const envelope = await budgetSummaryAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_snapshot');
    expect(calls.budgetSummary).toHaveLength(0);
  });

  it('returns error when analysisProtocol is missing', async () => {
    const input = baseInput({ analysisProtocol: undefined });
    const envelope = await budgetSummaryAnalysis(input);

    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('no_analysis_protocol');
    expect(envelope.error!.reasonCodes).toContain(ReasonCodes.MISSING_ANALYSIS_PROTOCOL);
  });

  it('does not call protocol when freshness is stale', async () => {
    const { protocol, calls } = createMockProtocol();
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
    await budgetSummaryAnalysis(input);

    expect(calls.budgetSummary).toHaveLength(0);
  });
});
