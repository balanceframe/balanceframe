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
  type DataFreshness,
  type ResponseEnvelope,
} from './envelope.js';
import type {
  CommandInput,
  PendingReviewOutput,
  PendingReviewResult,
  ReviewShowOutput,
  ReviewDetailResult,
  BudgetSummaryOutput,
  BudgetSummaryResult,
  ReviewActionOutput,
  ReviewBulkActionOutput,
  ReviewGroupOutput,
  ReviewActionResult,
  ReviewBulkActionResult,
  ReviewGroupResult,
  ReviewActionOptions,
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
// ---------------------------------------------------------------------------
// Review action analysis handlers
// ---------------------------------------------------------------------------

/**
 * Shared guard checks for review action analysis.
 * Returns a tagged result — `{ ok: false, envelope }` on guard failure,
 * or `{ ok: true, ... }` to proceed.
 */
async function guardReviewAction(
  input: CommandInput,
): Promise<
  | { ok: true; requestId: string; actorId: string; ledger: unknown; freshness: DataFreshness | null; analysisProtocol: AnalysisProtocol }
  | { ok: false; envelope: ResponseEnvelope<never> }
> {
  const { requestId, actorId, ledger, freshness, analysisProtocol } = input;

  if (!ledger) {
    const err = new ErrorInfo({
      code: 'not_connected',
      message: 'No ledger connected.',
      retryable: true,
      reasonCodes: ['missing_ledger_config'],
    });
    return { ok: false, envelope: errorResponse(requestId, err) };
  }

  if (freshness && freshness.isStale) {
    const err = new ErrorInfo({
      code: 'stale_snapshot',
      message: 'Snapshot data is stale. Reconnect or re-download before action.',
      retryable: true,
      reasonCodes: ['stale_snapshot'],
    });
    return { ok: false, envelope: errorResponse(requestId, err) };
  }

  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return { ok: false, envelope: errorResponse(requestId, err) };
  }

  if (input.mode === 'observe') {
    const err = new ErrorInfo({
      code: 'write_rejected',
      message: 'Write operation is not permitted in Observe mode. Switch to a mode that permits writes, or disconnect.',
      retryable: false,
      reasonCodes: ['observe_mode_write_blocked'],
    });
    return { ok: false, envelope: errorResponse(requestId, err) };
  }

  return { ok: true, requestId, actorId, ledger, freshness, analysisProtocol };
}

/**
 * Approve a pending review suggestion.
 * Delegates to the Rust protocol for the actual transition.
 */
export async function reviewApproveAnalysis(
  input: CommandInput,
  reviewId: string,
  options?: ReviewActionOptions,
): Promise<ReviewActionOutput['envelope']> {
  const guarded = await guardReviewAction(input);
  if (!guarded.ok) return guarded.envelope;
  const { requestId, actorId, ledger, freshness, analysisProtocol } = guarded;

  if (!analysisProtocol.reviewApprove) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Review action not available: the protocol does not support approve.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.reviewApprove(ledger, reviewId, mergedOptions);
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
 * Correct a review item with a specific category.
 * Delegates to the Rust protocol for the transition.
 */
export async function reviewCorrectAnalysis(
  input: CommandInput,
  reviewId: string,
  categoryId: string,
  options?: ReviewActionOptions,
): Promise<ReviewActionOutput['envelope']> {
  const guarded = await guardReviewAction(input);
  if (!guarded.ok) return guarded.envelope;
  const { requestId, actorId, ledger, freshness, analysisProtocol } = guarded;

  if (!analysisProtocol.reviewCorrect) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Review action not available: the protocol does not support correct.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.reviewCorrect(ledger, reviewId, categoryId, mergedOptions);
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
 * Reject a pending review suggestion.
 */
export async function reviewRejectAnalysis(
  input: CommandInput,
  reviewId: string,
  options?: ReviewActionOptions,
): Promise<ReviewActionOutput['envelope']> {
  const guarded = await guardReviewAction(input);
  if (!guarded.ok) return guarded.envelope;
  const { requestId, actorId, ledger, freshness, analysisProtocol } = guarded;

  if (!analysisProtocol.reviewReject) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Review action not available: the protocol does not support reject.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.reviewReject(ledger, reviewId, mergedOptions);
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
 * Skip a review item for later.
 */
export async function reviewSkipAnalysis(
  input: CommandInput,
  reviewId: string,
  options?: ReviewActionOptions,
): Promise<ReviewActionOutput['envelope']> {
  const guarded = await guardReviewAction(input);
  if (!guarded.ok) return guarded.envelope;
  const { requestId, actorId, ledger, freshness, analysisProtocol } = guarded;

  if (!analysisProtocol.reviewSkip) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Review action not available: the protocol does not support skip.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.reviewSkip(ledger, reviewId, mergedOptions);
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
 * Undo the last transition on a review item.
 */
export async function reviewUndoAnalysis(
  input: CommandInput,
  reviewId: string,
  options?: ReviewActionOptions,
): Promise<ReviewActionOutput['envelope']> {
  const guarded = await guardReviewAction(input);
  if (!guarded.ok) return guarded.envelope;
  const { requestId, actorId, ledger, freshness, analysisProtocol } = guarded;

  if (!analysisProtocol.reviewUndo) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Review action not available: the protocol does not support undo.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.reviewUndo(ledger, reviewId, mergedOptions);
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
 * Bulk-approve multiple review items.
 */
export async function reviewApproveBulkAnalysis(
  input: CommandInput,
  reviewIds: string[],
  options?: ReviewActionOptions,
): Promise<ReviewBulkActionOutput['envelope']> {
  const guarded = await guardReviewAction(input);
  if (!guarded.ok) return guarded.envelope;
  const { requestId, actorId, ledger, freshness, analysisProtocol } = guarded;

  if (!analysisProtocol.reviewApproveBulk) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Review action not available: the protocol does not support approve-bulk.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.reviewApproveBulk(ledger, reviewIds, mergedOptions);
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
 * Group review items with homogeneous evidence for batch review.
 */
export async function reviewGroupAnalysis(
  input: CommandInput,
  reviewIds: string[],
  options?: ReviewActionOptions,
): Promise<ReviewGroupOutput['envelope']> {
  const guarded = await guardReviewAction(input);
  if (!guarded.ok) return guarded.envelope;
  const { requestId, actorId, ledger, freshness, analysisProtocol } = guarded;

  if (!analysisProtocol.reviewGroup) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Review action not available: the protocol does not support group.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.reviewGroup(ledger, reviewIds, mergedOptions);
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
