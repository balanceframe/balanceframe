/**
 * CLI review workflow tests.
 *
 * Covers: parseArgs routing, arity/flags, main() dispatch,
 * observe-mode block, stale/inaccessible error envelopes,
 * action semantic parity.
 */

import { describe, it, expect } from 'vitest';
import { parseArgs, main, type CliCommand } from '../src/index';
import type { AnalysisProtocol } from '@balanceframe/application';
import type {
  ReviewActionResult,
  ReviewBulkActionResult,
  ReviewGroupResult,
  PendingReviewResult,
  ReviewDetailResult,
  BudgetSummaryResult,
} from '@balanceframe/application';

// ---------------------------------------------------------------------------
// Mock protocol (minimal)
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
        generatedAt: '2026-07-19T00:00:00Z',
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
    async reviewApprove(_ledger, reviewId, _options?) {
      return {
        reviewId,
        action: 'approved',
        fromStatus: 'pending_review',
        toStatus: 'approved',
        timestamp: '2026-07-19T00:01:00Z',
        correlationId: 'corr_cli_001',
        actorId: 'usr_test',
        reversible: true,
        nextItemId: 'rev_next',
      } as ReviewActionResult;
    },
    async reviewCorrect(_ledger, reviewId, categoryId, _options?) {
      return {
        reviewId,
        action: 'corrected',
        fromStatus: 'pending_review',
        toStatus: 'correcting',
        timestamp: '2026-07-19T00:01:00Z',
        correlationId: 'corr_cli_002',
        actorId: 'usr_test',
        reversible: false,
        nextItemId: null,
      } as ReviewActionResult;
    },
    async reviewReject(_ledger, reviewId, _options?) {
      return {
        reviewId,
        action: 'rejected',
        fromStatus: 'pending_review',
        toStatus: 'rejected',
        timestamp: '2026-07-19T00:01:00Z',
        correlationId: 'corr_cli_003',
        actorId: 'usr_test',
        reversible: false,
        nextItemId: null,
      } as ReviewActionResult;
    },
    async reviewSkip(_ledger, reviewId, _options?) {
      return {
        reviewId,
        action: 'skipped',
        fromStatus: 'pending_review',
        toStatus: 'skipped',
        timestamp: '2026-07-19T00:01:00Z',
        correlationId: 'corr_cli_004',
        actorId: 'usr_test',
        reversible: false,
        nextItemId: null,
      } as ReviewActionResult;
    },
    async reviewUndo(_ledger, reviewId, _options?) {
      return {
        reviewId,
        action: 'undone',
        fromStatus: 'approved',
        toStatus: 'pending_review',
        timestamp: '2026-07-19T00:02:00Z',
        correlationId: 'corr_cli_005',
        actorId: 'usr_test',
        reversible: false,
        nextItemId: reviewId,
      } as ReviewActionResult;
    },
    async reviewApproveBulk(_ledger, reviewIds, _options?) {
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
      } as ReviewBulkActionResult;
    },
    async reviewGroup(_ledger, reviewIds, _options?) {
      return {
        items: reviewIds.map(id => ({
          reviewId: id,
          generatedAt: '2026-07-19T00:00:00Z',
          status: 'pending_review',
          description: 'Grouped review',
          totalAmount: { minorUnits: '5000', currency: 'USD' },
          itemCount: 1,
          items: [],
        })),
        homogeneous: true,
        totalAmount: { minorUnits: '10000', currency: 'USD' },
        itemCount: reviewIds.length,
      } as ReviewGroupResult;
    },
  };
}

// ---------------------------------------------------------------------------
// parseArgs — review action commands
// ---------------------------------------------------------------------------

describe('parseArgs — review actions', () => {
  it('parses reviews approve REVIEW_ID', () => {
    const result = parseArgs(['reviews', 'approve', 'rev_abc', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reviews.approve');
    expect(result.cmd.reviewId).toBe('rev_abc');
  });

  it('parses reviews correct REVIEW_ID CATEGORY_ID', () => {
    const result = parseArgs(['reviews', 'correct', 'rev_abc', 'cat_xyz']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reviews.correct');
    expect(result.cmd.reviewId).toBe('rev_abc');
    expect(result.cmd.categoryId).toBe('cat_xyz');
  });

  it('parses reviews reject REVIEW_ID', () => {
    const result = parseArgs(['reviews', 'reject', 'rev_abc']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reviews.reject');
    expect(result.cmd.reviewId).toBe('rev_abc');
  });

  it('parses reviews skip REVIEW_ID', () => {
    const result = parseArgs(['reviews', 'skip', 'rev_abc', '--json']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reviews.skip');
    expect(result.cmd.reviewId).toBe('rev_abc');
  });

  it('parses reviews undo REVIEW_ID', () => {
    const result = parseArgs(['reviews', 'undo', 'rev_abc']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reviews.undo');
    expect(result.cmd.reviewId).toBe('rev_abc');
  });

  it('parses reviews approve-bulk with multiple IDs', () => {
    const result = parseArgs(['reviews', 'approve-bulk', 'rev_a', 'rev_b', 'rev_c']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reviews.approve-bulk');
    expect(result.cmd.ids).toEqual(['rev_a', 'rev_b', 'rev_c']);
  });

  it('parses reviews group with multiple IDs', () => {
    const result = parseArgs(['reviews', 'group', 'rev_a', 'rev_b']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.command).toBe('reviews.group');
    expect(result.cmd.ids).toEqual(['rev_a', 'rev_b']);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — arity / missing arguments
// ---------------------------------------------------------------------------

describe('parseArgs — review action arity', () => {
  it('rejects reviews approve without REVIEW_ID', () => {
    const result = parseArgs(['reviews', 'approve']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_review_id');
  });

  it('rejects reviews correct without CATEGORY_ID', () => {
    const result = parseArgs(['reviews', 'correct', 'rev_abc']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_category_id');
  });

  it('rejects reviews correct with trailing extra args', () => {
    const result = parseArgs(['reviews', 'correct', 'rev_abc', 'cat_xyz', 'extra']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects reviews reject without REVIEW_ID', () => {
    const result = parseArgs(['reviews', 'reject']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_review_id');
  });

  it('rejects reviews undo with trailing args after REVIEW_ID', () => {
    const result = parseArgs(['reviews', 'undo', 'rev_abc', 'extra']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('trailing_args');
  });

  it('rejects reviews approve-bulk with non-review ID strings', () => {
    const result = parseArgs(['reviews', 'approve-bulk', 'random_string', 'rev_abc']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_review_id');
  });

  it('rejects reviews group with non-review ID strings', () => {
    const result = parseArgs(['reviews', 'group', 'foo', 'bar']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_review_id');
  });

  it('rejects reviews approve-bulk with mixed valid and invalid IDs', () => {
    const result = parseArgs(['reviews', 'approve-bulk', 'rev_abc', 'not_an_id']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_review_id');
  });

  it('accepts reviews approve-bulk with valid IDs only', () => {
    const result = parseArgs(['reviews', 'approve-bulk', 'rev_a', 'rev_b', 'rev_c']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cmd.ids).toEqual(['rev_a', 'rev_b', 'rev_c']);
  });
});

// ---------------------------------------------------------------------------
// main() — dispatch to correct handler
// ---------------------------------------------------------------------------

describe('main — review action dispatch', () => {
  it('dispatches reviews approve and returns ok envelope', async () => {
    const output = await main(['reviews', 'approve', 'rev_abc', '--json'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.action).toBe('approved');
    expect(parsed.result.reviewId).toBe('rev_abc');
    expect(parsed.result.correlationId).toBeTruthy();
  });

  it('dispatches reviews correct and returns ok envelope', async () => {
    const output = await main(['reviews', 'correct', 'rev_abc', 'cat_xyz'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.action).toBe('corrected');
    expect(parsed.result.toStatus).toBe('correcting');
  });

  it('dispatches reviews reject and returns ok envelope', async () => {
    const output = await main(['reviews', 'reject', 'rev_abc'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.action).toBe('rejected');
  });

  it('dispatches reviews skip and returns ok envelope', async () => {
    const output = await main(['reviews', 'skip', 'rev_abc'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.action).toBe('skipped');
  });

  it('dispatches reviews undo and returns ok envelope', async () => {
    const output = await main(['reviews', 'undo', 'rev_abc'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.action).toBe('undone');
  });

  it('dispatches reviews approve-bulk with multiple IDs', async () => {
    const output = await main(['reviews', 'approve-bulk', 'rev_a', 'rev_b'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.total).toBe(2);
    expect(parsed.result.succeeded).toBe(2);
  });

  it('dispatches reviews group with multiple IDs', async () => {
    const output = await main(['reviews', 'group', 'rev_a', 'rev_b'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe('ok');
    expect(parsed.result.itemCount).toBe(2);
    expect(parsed.result.homogeneous).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// main() — observe mode blocks review action writes
// ---------------------------------------------------------------------------

describe('main — observe mode blocks review actions', () => {
  const actions: Array<{ args: string[]; description: string }> = [
    { args: ['reviews', 'approve', 'rev_abc'], description: 'reviews approve' },
    { args: ['reviews', 'correct', 'rev_abc', 'cat_xyz'], description: 'reviews correct' },
    { args: ['reviews', 'reject', 'rev_abc'], description: 'reviews reject' },
    { args: ['reviews', 'skip', 'rev_abc'], description: 'reviews skip' },
    { args: ['reviews', 'undo', 'rev_abc'], description: 'reviews undo' },
    { args: ['reviews', 'approve-bulk', 'rev_a', 'rev_b'], description: 'reviews approve-bulk' },
    { args: ['reviews', 'group', 'rev_a', 'rev_b'], description: 'reviews group' },
  ];

  for (const { args, description } of actions) {
    it(`'${description}' returns error in observe mode`, async () => {
      const output = await main(args, {
        mode: 'observe',
        actorId: 'usr_test',
        ledger: { mock: true },
        analysisProtocol: noopProtocol(),
      });
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('error');
      expect(parsed.error.code).toBe('write_rejected');
    });
  }
});

// ---------------------------------------------------------------------------
// main() — stale conflict / inaccessible provider
describe('main — stale conflict error', () => {
  const cases: Array<{ args: string[] }> = [
    { args: ['reviews', 'approve', 'rev_abc'] },
    { args: ['reviews', 'correct', 'rev_abc', 'cat_xyz'] },
    { args: ['reviews', 'reject', 'rev_abc'] },
    { args: ['reviews', 'skip', 'rev_abc'] },
    { args: ['reviews', 'undo', 'rev_abc'] },
    { args: ['reviews', 'approve-bulk', 'rev_a', 'rev_b'] },
    { args: ['reviews', 'group', 'rev_a', 'rev_b'] },
  ];

  for (const { args } of cases) {
    it(`'${args.join(' ')}' returns stale_snapshot error when freshness is stale`, async () => {
      const output = await main(args, {
        mode: 'reviewAndApply',
        actorId: 'usr_test',
        ledger: { mock: true },
        freshness: {
          actualDownloadedAt: '2026-06-01T00:00:00Z',
          bankSyncedAt: null,
          pendingTransactionsIncluded: false,
          stalenessDays: 30,
          isStale: true,
        },
        analysisProtocol: noopProtocol(),
      });
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('error');
      expect(parsed.error.code).toBe('stale_snapshot');
    });
  }
});

describe('main — inaccessible provider error', () => {
  const cases: Array<{ args: string[] }> = [
    { args: ['reviews', 'approve', 'rev_abc'] },
    { args: ['reviews', 'correct', 'rev_abc', 'cat_xyz'] },
    { args: ['reviews', 'reject', 'rev_abc'] },
    { args: ['reviews', 'skip', 'rev_abc'] },
    { args: ['reviews', 'undo', 'rev_abc'] },
    { args: ['reviews', 'approve-bulk', 'rev_a', 'rev_b'] },
    { args: ['reviews', 'group', 'rev_a', 'rev_b'] },
  ];

  for (const { args } of cases) {
    it(`'${args.join(' ')}' returns error envelope when analysisProtocol is missing`, async () => {
      const output = await main(args, {
        mode: 'reviewAndApply',
        actorId: 'usr_test',
        ledger: { mock: true },
        // analysisProtocol intentionally omitted
      });
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('error');
      expect(parsed.error.code).toBe('no_analysis_protocol');
    });
  }
});

// ---------------------------------------------------------------------------
// Semantic parity — all actions produce same envelope structure
// ---------------------------------------------------------------------------

describe('main — review action semantic parity', () => {
  const actions: Array<{ args: string[]; assertResult: (r: Record<string, unknown>) => void }> = [
    { args: ['reviews', 'approve', 'rev_001'], assertResult: (r) => { expect(r.action).toBe('approved'); } },
    { args: ['reviews', 'correct', 'rev_001', 'cat_test'], assertResult: (r) => { expect(r.action).toBe('corrected'); } },
    { args: ['reviews', 'reject', 'rev_001'], assertResult: (r) => { expect(r.action).toBe('rejected'); } },
    { args: ['reviews', 'skip', 'rev_001'], assertResult: (r) => { expect(r.action).toBe('skipped'); } },
    { args: ['reviews', 'undo', 'rev_001'], assertResult: (r) => { expect(r.action).toBe('undone'); } },
    { args: ['reviews', 'approve-bulk', 'rev_a', 'rev_b'], assertResult: (r) => { expect(r.total).toBe(2); } },
    { args: ['reviews', 'group', 'rev_a', 'rev_b'], assertResult: (r) => { expect(r.itemCount).toBe(2); } },
  ];

  for (const { args, assertResult } of actions) {
    it(`'${args.join(' ')}' returns envelope with schemaVersion, status, requestId, dataFreshness`, async () => {
      const output = await main(args, {
        mode: 'reviewAndApply',
        actorId: 'usr_test',
        ledger: { mock: true },
        analysisProtocol: noopProtocol(),
      });
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('schemaVersion');
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('requestId');
      expect(parsed).toHaveProperty('dataFreshness');
      expect(parsed.status).toBe('ok');
      expect(parsed.result).toBeTruthy();
      assertResult(parsed.result);
    });
  }
});

// ---------------------------------------------------------------------------
// main() — provider failure for all review actions
// ---------------------------------------------------------------------------

function throwingProtocol(): AnalysisProtocol {
  return {
    async pendingReview() { return {} as PendingReviewResult; },
    async reviewShow() { return {} as ReviewDetailResult; },
    async budgetSummary() { return {} as BudgetSummaryResult; },
    async reviewApprove() { throw new Error('Provider unreachable'); },
    async reviewCorrect() { throw new Error('Provider unreachable'); },
    async reviewReject() { throw new Error('Provider unreachable'); },
    async reviewSkip() { throw new Error('Provider unreachable'); },
    async reviewUndo() { throw new Error('Provider unreachable'); },
    async reviewApproveBulk() { throw new Error('Provider unreachable'); },
    async reviewGroup() { throw new Error('Provider unreachable'); },
  };
}

describe('main — provider failure error', () => {
  const cases: Array<{ args: string[] }> = [
    { args: ['reviews', 'approve', 'rev_abc'] },
    { args: ['reviews', 'correct', 'rev_abc', 'cat_xyz'] },
    { args: ['reviews', 'reject', 'rev_abc'] },
    { args: ['reviews', 'skip', 'rev_abc'] },
    { args: ['reviews', 'undo', 'rev_abc'] },
    { args: ['reviews', 'approve-bulk', 'rev_a', 'rev_b'] },
    { args: ['reviews', 'group', 'rev_a', 'rev_b'] },
  ];

  for (const { args } of cases) {
    it(`'${args.join(' ')}' returns analysis_failed when protocol throws`, async () => {
      const output = await main(args, {
        mode: 'reviewAndApply',
        actorId: 'usr_test',
        ledger: { mock: true },
        analysisProtocol: throwingProtocol(),
      });
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('error');
      expect(parsed.error.code).toBe('analysis_failed');
      expect(parsed.error.message).toContain('Provider unreachable');
    });
  }
});

// ---------------------------------------------------------------------------
// main() — analysis-only protocol compatibility
// ---------------------------------------------------------------------------

describe('main — analysis-only protocol', () => {
  const analysisOnlyProtocol: AnalysisProtocol = {
    async pendingReview() { return {} as PendingReviewResult; },
    async reviewShow() { return {} as ReviewDetailResult; },
    async budgetSummary() { return {} as BudgetSummaryResult; },
  };

  const cases: Array<{ args: string[] }> = [
    { args: ['reviews', 'approve', 'rev_abc'] },
    { args: ['reviews', 'correct', 'rev_abc', 'cat_xyz'] },
    { args: ['reviews', 'reject', 'rev_abc'] },
    { args: ['reviews', 'skip', 'rev_abc'] },
    { args: ['reviews', 'undo', 'rev_abc'] },
    { args: ['reviews', 'approve-bulk', 'rev_a', 'rev_b'] },
    { args: ['reviews', 'group', 'rev_a', 'rev_b'] },
  ];

  for (const { args } of cases) {
    it(`'${args.join(' ')}' returns no_analysis_protocol when review method missing`, async () => {
      const output = await main(args, {
        mode: 'reviewAndApply',
        actorId: 'usr_test',
        ledger: { mock: true },
        analysisProtocol: analysisOnlyProtocol,
      });
      const parsed = JSON.parse(output);
      expect(parsed.status).toBe('error');
      expect(parsed.error.code).toBe('no_analysis_protocol');
    });
  }
});

// ---------------------------------------------------------------------------
// Actor / correlation propagation
// ---------------------------------------------------------------------------

describe('main — actor and correlation propagation', () => {
  it('includes actorId and correlationId in approve result', async () => {
    const output = await main(['reviews', 'approve', 'rev_abc'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.result.actorId).toBe('usr_test');
    expect(parsed.result.correlationId).toBeTruthy();
  });

  it('includes actorId in reject result', async () => {
    const output = await main(['reviews', 'reject', 'rev_abc'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.result.actorId).toBe('usr_test');
  });
});

// ---------------------------------------------------------------------------
// ApplicationError code/reason/retryability preservation
// ---------------------------------------------------------------------------

describe('main — ApplicationError preservation', () => {
  it('preserves error code, reasonCodes, and retryable in stale_snapshot error', async () => {
    const output = await main(['reviews', 'approve', 'rev_abc'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      freshness: {
        actualDownloadedAt: '2026-06-01T00:00:00Z',
        bankSyncedAt: null,
        pendingTransactionsIncluded: false,
        stalenessDays: 30,
        isStale: true,
      },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.error.code).toBe('stale_snapshot');
    expect(Array.isArray(parsed.error.reasonCodes)).toBe(true);
    expect(parsed.error.reasonCodes).toContain('stale_snapshot');
    expect(parsed.error.retryable).toBe(true);
  });

  it('preserves error code, reasonCodes, and retryable in write_rejected error', async () => {
    const output = await main(['reviews', 'approve', 'rev_abc'], {
      mode: 'observe',
      actorId: 'usr_test',
      ledger: { mock: true },
      analysisProtocol: noopProtocol(),
    });
    const parsed = JSON.parse(output);
    expect(parsed.error.code).toBe('write_rejected');
    expect(parsed.error.reasonCodes).toContain('observe_mode_write_blocked');
    expect(parsed.error.retryable).toBe(false);
  });

  it('preserves error code and retryable in no_analysis_protocol error', async () => {
    const output = await main(['reviews', 'approve', 'rev_abc'], {
      mode: 'reviewAndApply',
      actorId: 'usr_test',
      ledger: { mock: true },
      // analysisProtocol intentionally omitted
    });
    const parsed = JSON.parse(output);
    expect(parsed.error.code).toBe('no_analysis_protocol');
    expect(Array.isArray(parsed.error.reasonCodes)).toBe(true);
    expect(parsed.error.retryable).toBe(true);
  });
});
