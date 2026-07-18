/**
 * Analysis orchestration — wires injected adapter/protocol analysis without
 * duplicating Rust-owned calculations.
 *
 * All analysis values flow through the Rust protocol (via node-binding or
 * injected adapter). This module never reimplements categorization, money
 * arithmetic, data-quality checks, or merchant normalization — it only
 * shapes results into CLI envelope outputs.
 */

import {
  okResponse,
  errorResponse,
  AuthorizationContext,
  ErrorInfo,
} from './envelope.js';
import type {
  CommandInput,
  PendingReviewOutput,
  PendingReviewResult,
  ReviewShowOutput,
  ReviewDetailResult,
  BudgetSummaryOutput,
  BudgetSummaryResult,
  AnalysisProtocol,
} from './commands.js';

// ---------------------------------------------------------------------------
// Manual/no-model analysis path
// ---------------------------------------------------------------------------

/**
 * Execute a pending-review analysis using injected adapter/protocol data.
 *
 * This is the **manual/no-model** path: it never calls a model provider.
 * Analysis values come from the injected ledger (which wraps the Rust
 * protocol via node-binding or direct TypeScript adapter calls).
 *
 * Returns a full response envelope. On error (stale data, no connection),
 * returns an error envelope.
 */
export async function pendingReviewAnalysis(
  input: CommandInput,
): Promise<PendingReviewOutput['envelope']> {
  const { requestId, actorId, ledger, freshness, analysisProtocol } = input;

  if (!ledger) {
    const err = new ErrorInfo({
      code: 'not_connected',
      message: 'No ledger connected. Use a connect command first.',
      retryable: true,
      reasonCodes: ['missing_ledger_config'],
    });
    return errorResponse(requestId, err);
  }

  if (freshness && freshness.isStale) {
    const err = new ErrorInfo({
      code: 'stale_snapshot',
      message: 'Snapshot data is stale. Reconnect or re-download before analysis.',
      retryable: true,
      reasonCodes: ['stale_snapshot'],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.pendingReview(ledger, freshness);
    return okResponse(requestId, freshness, AuthorizationContext.observe(actorId), result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errInfo = new ErrorInfo({
      code: 'analysis_failed',
      message,
      retryable: true,
      reasonCodes: ['analysis_error'],
    });
    return errorResponse(requestId, errInfo);
  }
}

/**
 * Show a specific review by ID.
 * Delegates to the Rust protocol for evidence details.
 */
export async function reviewShowAnalysis(
  input: CommandInput,
  reviewId: string,
): Promise<ReviewShowOutput['envelope']> {
  const { requestId, actorId, ledger, freshness, analysisProtocol } = input;

  if (!ledger) {
    const err = new ErrorInfo({
      code: 'not_connected',
      message: 'No ledger connected.',
      retryable: true,
      reasonCodes: ['missing_ledger_config'],
    });
    return errorResponse(requestId, err);
  }

  if (freshness && freshness.isStale) {
    const err = new ErrorInfo({
      code: 'stale_snapshot',
      message: 'Snapshot data is stale. Reconnect or re-download before analysis.',
      retryable: true,
      reasonCodes: ['stale_snapshot'],
    });
    return errorResponse(requestId, err);
  }


  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.reviewShow(ledger, reviewId);
    return okResponse(requestId, freshness, AuthorizationContext.observe(actorId), result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errInfo = new ErrorInfo({
      code: 'analysis_failed',
      message,
      retryable: true,
      reasonCodes: ['analysis_error'],
    });
    return errorResponse(requestId, errInfo);
  }
}

export async function budgetSummaryAnalysis(
  input: CommandInput,
): Promise<BudgetSummaryOutput['envelope']> {
  const { requestId, actorId, ledger, freshness, analysisProtocol } = input;

  if (!ledger) {
    const err = new ErrorInfo({
      code: 'not_connected',
      message: 'No ledger connected.',
      retryable: true,
      reasonCodes: ['missing_ledger_config'],
    });
    return errorResponse(requestId, err);
  }

  if (freshness && freshness.isStale) {
    const err = new ErrorInfo({
      code: 'stale_snapshot',
      message: 'Snapshot data is stale. Reconnect or re-download before analysis.',
      retryable: true,
      reasonCodes: ['stale_snapshot'],
    });
    return errorResponse(requestId, err);
  }


  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.budgetSummary(ledger);
    return okResponse(requestId, freshness, AuthorizationContext.observe(actorId), result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errInfo = new ErrorInfo({
      code: 'analysis_failed',
      message,
      retryable: true,
      reasonCodes: ['analysis_error'],
    });
    return errorResponse(requestId, errInfo);
  }
}
