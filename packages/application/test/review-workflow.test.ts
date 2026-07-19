/**
 * Tests for review workflow commands and analysis handlers.
 *
 * Covers: parser/routing, success/error envelopes, stale conflict,
 * inaccessible provider, model-disabled manual path, parity of action
 * semantics, immediate next-item progression, correlation IDs/provenance.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  type ReviewActionResult,
  type ReviewBulkActionResult,
  type ReviewGroupResult,
  type AnalysisProtocol,
  type CommandInput,
  type ReviewDetailResult,
  type PendingReviewResult,
  type BudgetSummaryResult,
  routeCommand,
} from '../src/commands';
import {
  reviewApproveAnalysis,
  reviewCorrectAnalysis,
  reviewRejectAnalysis,
  reviewSkipAnalysis,
  reviewUndoAnalysis,
  reviewApproveBulkAnalysis,
  reviewGroupAnalysis,
} from '../src/analysis';
import { ReasonCodes } from '../src/errors';
import { type ResponseEnvelope, AuthorizationContext, ErrorInfo, errorResponse, okResponse } from '../src/envelope';
import { type Money } from '@balanceframe/protocol-generated';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockMoney(minorUnits = '0', currency = 'USD'): Money {
  return { minorUnits, currency };
}

function mockReviewItem(overrides: Partial<ReviewDetailResult> = {}): ReviewDetailResult {
  return {
    reviewId: 'rev_test',
    generatedAt: '2026-07-19T00:00:00Z',
    status: 'pending_review',
    description: 'Test review item',
    totalAmount: mockMoney('5000', 'USD'),
    itemCount: 1,
    items: [
      {
        transactionId: 'tx_001',
        amount: mockMoney('5000', 'USD'),
        payeeName: 'Test Store',
        date: '2026-07-15',
        categoryName: null,
        suggestedCategoryId: 'cat_food',
        suggestedCategoryName: 'Food & Dining',
        confidence: 0.85,
        reasonCodes: ['exact_payee_match'],
      },
    ],
    ...overrides,
  };
}

function mockProtocol(): {
  protocol: AnalysisProtocol;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {
    pendingReview: [],
    reviewShow: [],
    reviewApprove: [],
    reviewCorrect: [],
    reviewReject: [],
    reviewSkip: [],
    reviewUndo: [],
    reviewApproveBulk: [],
    reviewGroup: [],
    budgetSummary: [],
  };

  const protocol: AnalysisProtocol = {
    async pendingReview(ledger, freshness) {
      calls.pendingReview.push({ ledger, freshness });
      return {
        uncategorizedCount: 5,
        totalUncategorizedAmount: mockMoney('15000', 'USD'),
        candidates: [],
        oldestUncategorizedDate: '2026-06-01',
        healthState: 'healthy',
        blockers: [],
      };
    },

    async reviewShow(ledger, reviewId) {
      calls.reviewShow.push({ ledger, reviewId });
      return mockReviewItem({ reviewId });
    },

    async budgetSummary() {
      calls.budgetSummary.push({});
      return {
        month: '2026-07',
        totalBudgeted: mockMoney('500000', 'USD'),
        totalSpent: mockMoney('120000', 'USD'),
        totalRemaining: mockMoney('380000', 'USD'),
        categories: [],
      };
    },

    async reviewApprove(ledger, reviewId, options) {
      calls.reviewApprove.push({ ledger, reviewId, options });
      return {
        reviewId,
        action: 'approved',
        fromStatus: 'pending_review',
        toStatus: 'approved',
        timestamp: '2026-07-19T00:01:00Z',
        correlationId: 'corr_001',
        actorId: 'usr_test',
        reversible: true,
        nextItemId: 'rev_next',
      } satisfies ReviewActionResult;
    },

    async reviewCorrect(ledger, reviewId, categoryId, options) {
      calls.reviewCorrect.push({ ledger, reviewId, categoryId, options });
      return {
        reviewId,
        action: 'corrected',
        fromStatus: 'pending_review',
        toStatus: 'correcting',
        timestamp: '2026-07-19T00:01:00Z',
        correlationId: 'corr_002',
        actorId: 'usr_test',
        reversible: false,
        nextItemId: null,
      } satisfies ReviewActionResult;
    },

    async reviewReject(ledger, reviewId, options) {
      calls.reviewReject.push({ ledger, reviewId, options });
      return {
        reviewId,
        action: 'rejected',
        fromStatus: 'pending_review',
        toStatus: 'rejected',
        timestamp: '2026-07-19T00:01:00Z',
        correlationId: 'corr_003',
        actorId: 'usr_test',
        reversible: false,
        nextItemId: 'rev_next',
      } satisfies ReviewActionResult;
    },

    async reviewSkip(ledger, reviewId, options) {
      calls.reviewSkip.push({ ledger, reviewId, options });
      return {
        reviewId,
        action: 'skipped',
        fromStatus: 'pending_review',
        toStatus: 'skipped',
        timestamp: '2026-07-19T00:01:00Z',
        correlationId: 'corr_004',
        actorId: 'usr_test',
        reversible: false,
        nextItemId: 'rev_next',
      } satisfies ReviewActionResult;
    },

    async reviewUndo(ledger, reviewId, options) {
      calls.reviewUndo.push({ ledger, reviewId, options });
      return {
        reviewId,
        action: 'undone',
        fromStatus: 'approved',
        toStatus: 'pending_review',
        timestamp: '2026-07-19T00:02:00Z',
        correlationId: 'corr_005',
        actorId: 'usr_test',
        reversible: false,
        nextItemId: reviewId,
      } satisfies ReviewActionResult;
    },

    async reviewApproveBulk(ledger, reviewIds, options) {
      calls.reviewApproveBulk.push({ ledger, reviewIds, options });
      return {
        total: reviewIds.length,
        succeeded: reviewIds.length,
        failed: 0,
        results: reviewIds.map(id => ({
          reviewId: id,
          action: 'approved',
          status: 'ok' as const,
          fromStatus: 'pending_review',
          toStatus: 'approved',
        })),
      } satisfies ReviewBulkActionResult;
    },

    async reviewGroup(ledger, reviewIds, options) {
      calls.reviewGroup.push({ ledger, reviewIds, options });
      return {
        items: reviewIds.map(id => mockReviewItem({ reviewId: id })),
        homogeneous: true,
        totalAmount: mockMoney('10000', 'USD'),
        itemCount: reviewIds.length,
      } satisfies ReviewGroupResult;
    },
  };

  return { protocol, calls };
}

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

function fieldPresenceChecks(envelope: ResponseEnvelope): void {
  expect(envelope).toHaveProperty('schemaVersion');
  expect(envelope).toHaveProperty('status');
  expect(envelope).toHaveProperty('requestId');
  expect(envelope).toHaveProperty('timestamp');
}

// ---------------------------------------------------------------------------
// Route parsing for review actions
// ---------------------------------------------------------------------------

describe('routeCommand — review action routing', () => {
  it('routes reviews approve REVIEW_ID', () => {
    const result = routeCommand({
      args: ['reviews', 'approve', 'rev_abc'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_001',
      ledger: null,
      freshness: null,
    });
    expect(result.command).toBe('reviews.approve');
    expect(result.route).toBe('analysis');
  });

  it('routes reviews correct REVIEW_ID CATEGORY_ID', () => {
    const result = routeCommand({
      args: ['reviews', 'correct', 'rev_abc', 'cat_xyz'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_002',
      ledger: null,
      freshness: null,
    });
    expect(result.command).toBe('reviews.correct');
    expect(result.route).toBe('analysis');
  });

  it('routes reviews reject REVIEW_ID', () => {
    const result = routeCommand({
      args: ['reviews', 'reject', 'rev_abc'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_003',
      ledger: null,
      freshness: null,
    });
    expect(result.command).toBe('reviews.reject');
    expect(result.route).toBe('analysis');
  });

  it('routes reviews skip REVIEW_ID', () => {
    const result = routeCommand({
      args: ['reviews', 'skip', 'rev_abc'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_004',
      ledger: null,
      freshness: null,
    });
    expect(result.command).toBe('reviews.skip');
    expect(result.route).toBe('analysis');
  });

  it('routes reviews undo REVIEW_ID', () => {
    const result = routeCommand({
      args: ['reviews', 'undo', 'rev_abc'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_005',
      ledger: null,
      freshness: null,
    });
    expect(result.command).toBe('reviews.undo');
    expect(result.route).toBe('analysis');
  });

  it('routes reviews approve-bulk with multiple IDs', () => {
    const result = routeCommand({
      args: ['reviews', 'approve-bulk', 'rev_a', 'rev_b', 'rev_c'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_006',
      ledger: null,
      freshness: null,
    });
    expect(result.command).toBe('reviews.approve-bulk');
    expect(result.route).toBe('analysis');
  });

  it('routes reviews group with multiple IDs', () => {
    const result = routeCommand({
      args: ['reviews', 'group', 'rev_a', 'rev_b'],
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      requestId: 'req_007',
      ledger: null,
      freshness: null,
    });
    expect(result.command).toBe('reviews.group');
    expect(result.route).toBe('analysis');
  });
});

// ---------------------------------------------------------------------------
// Observe mode blocks review action writes
// ---------------------------------------------------------------------------

describe('routeCommand — observe mode blocks review actions', () => {
  const reviewActions = ['approve', 'correct', 'reject', 'skip', 'undo', 'approve-bulk', 'group'] as const;

  for (const action of reviewActions) {
    const args = action === 'approve-bulk' || action === 'group'
      ? ['reviews', action, 'rev_abc', 'rev_def']
      : action === 'correct'
      ? ['reviews', action, 'rev_abc', 'cat_xyz']
      : ['reviews', action, 'rev_abc'];
    const cmdName = `reviews.${action}`;

    it(`blocks '${cmdName}' in observe mode`, () => {
      expect(() =>
        routeCommand({
          args,
          mode: 'observe',
          actorId: 'usr_test',
          requestId: 'req_obs',
          ledger: null,
          freshness: null,
        }),
      ).toThrow(/observe/i);
    });
  }
});

// ---------------------------------------------------------------------------
// ReviewActionResult envelope shapes
// ---------------------------------------------------------------------------

describe('ReviewActionResult — envelope field presence', () => {
  it('has all core envelope fields', () => {
    const result: ReviewActionResult = {
      reviewId: 'rev_001',
      action: 'approved',
      fromStatus: 'pending_review',
      toStatus: 'approved',
      timestamp: '2026-07-19T00:00:00Z',
      correlationId: 'corr_001',
      actorId: 'usr_test',
      reversible: true,
      nextItemId: 'rev_next',
    };
    expect(result.reviewId).toBe('rev_001');
    expect(result.action).toMatch(/^(approved|corrected|rejected|skipped|undone)$/);
    expect(typeof result.reversible).toBe('boolean');
    expect(typeof result.nextItemId).toBe('string');
    expect(result.correlationId).toBeTruthy();
    expect(result.fromStatus).toBeTruthy();
    expect(result.toStatus).toBeTruthy();
  });

  it('nextItemId can be null (end of queue)', () => {
    const result: ReviewActionResult = {
      reviewId: 'rev_end',
      action: 'skipped',
      fromStatus: 'pending_review',
      toStatus: 'skipped',
      timestamp: '2026-07-19T00:00:00Z',
      correlationId: 'corr_end',
      actorId: 'usr_test',
      reversible: false,
      nextItemId: null,
    };
    expect(result.nextItemId).toBeNull();
  });
});

describe('ReviewBulkActionResult — envelope field presence', () => {
  it('aggregates per-item results', () => {
    const result: ReviewBulkActionResult = {
      total: 3,
      succeeded: 2,
      failed: 1,
      results: [
        { reviewId: 'rev_a', action: 'approved', status: 'ok', fromStatus: 'pending_review', toStatus: 'approved' },
        { reviewId: 'rev_b', action: 'approved', status: 'ok', fromStatus: 'pending_review', toStatus: 'approved' },
        { reviewId: 'rev_c', action: 'approved', status: 'error', fromStatus: 'pending_review', toStatus: 'pending_review', error: 'Stale conflict' },
      ],
    };
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[2].error).toBe('Stale conflict');
  });
});

describe('ReviewGroupResult — envelope field presence', () => {
  it('contains homogeneous items with aggregate totals', () => {
    const result: ReviewGroupResult = {
      items: [
        mockReviewItem({ reviewId: 'rev_a' }),
        mockReviewItem({ reviewId: 'rev_b' }),
      ],
      homogeneous: true,
      totalAmount: mockMoney('10000', 'USD'),
      itemCount: 2,
    };
    expect(result.items).toHaveLength(2);
    expect(result.homogeneous).toBe(true);
    expect(result.itemCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Analysis handlers — reviewApproveAnalysis
// ---------------------------------------------------------------------------

describe('reviewApproveAnalysis', () => {
  it('calls protocol.reviewApprove and returns success envelope', async () => {
    const { protocol, calls } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reviewApproveAnalysis(input, 'rev_abc');

    expect(calls.reviewApprove).toHaveLength(1);
    expect(calls.reviewApprove[0]).toMatchObject({ ledger: input.ledger, reviewId: 'rev_abc' });
    expect(envelope.status).toBe('ok');
    expect(envelope.result).toBeTruthy();
    expect(envelope.result.action).toBe('approved');
    expect(envelope.result.nextItemId).toBe('rev_next');
    expect(envelope.result.reversible).toBe(true);
    expect(envelope.authorization).toBeTruthy();
    expect(envelope.authorization!.actorId).toBe('usr_test');
    expect(envelope.authorization!.capability).toBe('observe');
    expect(envelope.authorization!.allowed).toBe(true);
  });

  it('returns error when ledger is null', async () => {
    const { protocol } = mockProtocol();
    const input = baseInput({ ledger: null, analysisProtocol: protocol });
    const envelope = await reviewApproveAnalysis(input, 'rev_abc');
    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });

  it('returns error when freshness is stale', async () => {
    const { protocol } = mockProtocol();
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
    const envelope = await reviewApproveAnalysis(input, 'rev_abc');
    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_snapshot');
  });

  it('returns error when analysisProtocol is missing', async () => {
    const input = baseInput({ analysisProtocol: undefined });
    const envelope = await reviewApproveAnalysis(input, 'rev_abc');
    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('no_analysis_protocol');
    expect(envelope.error!.reasonCodes).toContain(ReasonCodes.MISSING_ANALYSIS_PROTOCOL);
  });

  it('returns error envelope when protocol throws', async () => {
    const protocol: AnalysisProtocol = {
      async pendingReview() { return {} as PendingReviewResult; },
      async reviewShow() { return {} as ReviewDetailResult; },
      async budgetSummary() { return {} as BudgetSummaryResult; },
      async reviewApprove() { throw new Error('Protocol unavailable'); },
      async reviewCorrect() { return {} as ReviewActionResult; },
      async reviewReject() { return {} as ReviewActionResult; },
      async reviewSkip() { return {} as ReviewActionResult; },
      async reviewUndo() { return {} as ReviewActionResult; },
      async reviewApproveBulk() { return {} as ReviewBulkActionResult; },
      async reviewGroup() { return {} as ReviewGroupResult; },
    };
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reviewApproveAnalysis(input, 'rev_abc');
    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('analysis_failed');
    expect(envelope.error!.message).toContain('Protocol unavailable');
  });
});

// ---------------------------------------------------------------------------
// Analysis handlers — reviewCorrectAnalysis
// ---------------------------------------------------------------------------

describe('reviewCorrectAnalysis', () => {
  it('calls protocol.reviewCorrect with categoryId', async () => {
    const { protocol, calls } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reviewCorrectAnalysis(input, 'rev_abc', 'cat_xyz');

    expect(calls.reviewCorrect).toHaveLength(1);
    expect(calls.reviewCorrect[0]).toMatchObject({
      ledger: input.ledger,
      reviewId: 'rev_abc',
      categoryId: 'cat_xyz',
    });
    expect(envelope.status).toBe('ok');
    expect(envelope.result.action).toBe('corrected');
    expect(envelope.result.toStatus).toBe('correcting');
  });

  it('returns error for stale snapshot', async () => {
    const { protocol } = mockProtocol();
    const input = baseInput({
      analysisProtocol: protocol,
      freshness: { actualDownloadedAt: '2026-06-01T00:00:00Z', bankSyncedAt: null, pendingTransactionsIncluded: false, stalenessDays: 30, isStale: true },
    });
    const envelope = await reviewCorrectAnalysis(input, 'rev_abc', 'cat_xyz');
    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_snapshot');
  });
});

// ---------------------------------------------------------------------------
// Analysis handlers — reviewRejectAnalysis, reviewSkipAnalysis, reviewUndoAnalysis
// ---------------------------------------------------------------------------

describe('reviewRejectAnalysis', () => {
  it('calls protocol.reviewReject and returns success', async () => {
    const { protocol, calls } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reviewRejectAnalysis(input, 'rev_abc');
    expect(calls.reviewReject).toHaveLength(1);
    expect(envelope.status).toBe('ok');
    expect(envelope.result.action).toBe('rejected');
    expect(envelope.result.nextItemId).toBe('rev_next');
  });

  it('returns error when analysisProtocol is missing', async () => {
    const input = baseInput({ analysisProtocol: undefined });
    const envelope = await reviewRejectAnalysis(input, 'rev_abc');
    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('no_analysis_protocol');
  });
});

describe('reviewSkipAnalysis', () => {
  it('calls protocol.reviewSkip and returns success', async () => {
    const { protocol, calls } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reviewSkipAnalysis(input, 'rev_abc');
    expect(calls.reviewSkip).toHaveLength(1);
    expect(envelope.status).toBe('ok');
    expect(envelope.result.action).toBe('skipped');
    expect(envelope.result.nextItemId).toBe('rev_next');
  });
});

describe('reviewUndoAnalysis', () => {
  it('calls protocol.reviewUndo and returns success', async () => {
    const { protocol, calls } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reviewUndoAnalysis(input, 'rev_abc');
    expect(calls.reviewUndo).toHaveLength(1);
    expect(envelope.status).toBe('ok');
    expect(envelope.result.action).toBe('undone');
    expect(envelope.result.nextItemId).toBe('rev_abc');
  });
});

// ---------------------------------------------------------------------------
// Analysis handlers — reviewApproveBulkAnalysis
// ---------------------------------------------------------------------------

describe('reviewApproveBulkAnalysis', () => {
  it('calls protocol.reviewApproveBulk with multiple IDs', async () => {
    const { protocol, calls } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const ids = ['rev_a', 'rev_b', 'rev_c'];
    const envelope = await reviewApproveBulkAnalysis(input, ids);

    expect(calls.reviewApproveBulk).toHaveLength(1);
    expect(calls.reviewApproveBulk[0]).toMatchObject({
      ledger: input.ledger,
      reviewIds: ids,
    });
    expect(envelope.status).toBe('ok');
    expect(envelope.result.total).toBe(3);
    expect(envelope.result.succeeded).toBe(3);
  });

  it('returns error when not connected', async () => {
    const { protocol } = mockProtocol();
    const input = baseInput({ ledger: null, analysisProtocol: protocol });
    const envelope = await reviewApproveBulkAnalysis(input, ['rev_a']);
    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('not_connected');
  });
});

// ---------------------------------------------------------------------------
// Analysis handlers — reviewGroupAnalysis
// ---------------------------------------------------------------------------

describe('reviewGroupAnalysis', () => {
  it('calls protocol.reviewGroup with multiple IDs', async () => {
    const { protocol, calls } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const ids = ['rev_a', 'rev_b'];
    const envelope = await reviewGroupAnalysis(input, ids);

    expect(calls.reviewGroup).toHaveLength(1);
    expect(calls.reviewGroup[0]).toMatchObject({
      ledger: input.ledger,
      reviewIds: ids,
    });
    expect(envelope.status).toBe('ok');
    expect(envelope.result.homogeneous).toBe(true);
    expect(envelope.result.itemCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Correlation / provenance
// ---------------------------------------------------------------------------

describe('Review action correlation & provenance', () => {
  it('includes correlationId and actorId in action results', async () => {
    const { protocol } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    const envelope = await reviewApproveAnalysis(input, 'rev_abc');
    expect(envelope.result.correlationId).toBeTruthy();
    expect(envelope.result.actorId).toBe('usr_test');
    expect(envelope.authorization!.actorId).toBe('usr_test');
  });
});

// ---------------------------------------------------------------------------
// Semantic parity — all action handlers share the same error guards
// ---------------------------------------------------------------------------

describe('Review action error guard parity', () => {
  const actions: Array<{
    name: string;
    handler: (input: CommandInput) => Promise<ResponseEnvelope>;
  }> = [
    { name: 'approve', handler: (i) => reviewApproveAnalysis(i, 'rev_test') },
    { name: 'correct', handler: (i) => reviewCorrectAnalysis(i, 'rev_test', 'cat_test') },
    { name: 'reject', handler: (i) => reviewRejectAnalysis(i, 'rev_test') },
    { name: 'skip', handler: (i) => reviewSkipAnalysis(i, 'rev_test') },
    { name: 'undo', handler: (i) => reviewUndoAnalysis(i, 'rev_test') },
  ];

  for (const { name, handler } of actions) {
    it(`'${name}' returns stale_snapshot error when freshness is stale`, async () => {
      const { protocol } = mockProtocol();
      const input = baseInput({
        analysisProtocol: protocol,
        freshness: { actualDownloadedAt: '2026-06-01T00:00:00Z', bankSyncedAt: null, pendingTransactionsIncluded: false, stalenessDays: 30, isStale: true },
      });
      const envelope = await handler(input);
      expect(envelope.status).toBe('error');
      expect(envelope.error!.code).toBe('stale_snapshot');
    });

    it(`'${name}' returns no_analysis_protocol error when protocol missing`, async () => {
      const input = baseInput({ analysisProtocol: undefined });
      const envelope = await handler(input);
      expect(envelope.status).toBe('error');
      expect(envelope.error!.code).toBe('no_analysis_protocol');
    });

    it(`'${name}' returns not_connected error when ledger is null`, async () => {
      const input = baseInput({ ledger: null, analysisProtocol: mockProtocol().protocol });
      const envelope = await handler(input);
      expect(envelope.status).toBe('error');
      expect(envelope.error!.code).toBe('not_connected');
    });
  }

  it('approve-bulk shares the same error guards', async () => {
    const { protocol } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol, freshness: { actualDownloadedAt: '2026-06-01T00:00:00Z', bankSyncedAt: null, pendingTransactionsIncluded: false, stalenessDays: 30, isStale: true } });
    const envelope = await reviewApproveBulkAnalysis(input, ['rev_test']);
    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_snapshot');
  });

  it('group shares the same error guards', async () => {
    const { protocol } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol, freshness: { actualDownloadedAt: '2026-06-01T00:00:00Z', bankSyncedAt: null, pendingTransactionsIncluded: false, stalenessDays: 30, isStale: true } });
    const envelope = await reviewGroupAnalysis(input, ['rev_test']);
    expect(envelope.status).toBe('error');
    expect(envelope.error!.code).toBe('stale_snapshot');
  });
});

// ---------------------------------------------------------------------------
// Flag/options propagation (model-disabled manual path)
// ---------------------------------------------------------------------------

describe('Review action options propagation', () => {
  it('passes options to protocol.reviewApprove', async () => {
    const { protocol, calls } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    await reviewApproveAnalysis(input, 'rev_abc', { message: 'Looks good' });

    expect(calls.reviewApprove[0]).toMatchObject({
      options: { message: 'Looks good' },
    });
  });

  it('passes reason to protocol.reviewReject', async () => {
    const { protocol, calls } = mockProtocol();
    const input = baseInput({ analysisProtocol: protocol });
    await reviewRejectAnalysis(input, 'rev_abc', { reason: 'wrong_category' });

    expect(calls.reviewReject[0]).toMatchObject({
      options: { reason: 'wrong_category' },
    });
  });
});
