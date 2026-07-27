/**
 * Analysis orchestration — wires injected adapter/protocol analysis without
 * duplicating Rust-owned calculations.
 *
 * All analysis values flow through the Rust protocol (via node-binding or
 * injected adapter). This module never reimplements categorization, money
 * arithmetic, data-quality checks, or merchant normalization — it only
 * shapes results into CLI envelope outputs.
 */


import { ReasonCodes, ApplicationError } from './errors.js';
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
  ProposalCreateOutput,
  ProposalCreateResult,
  ProposalShowOutput,
  ProposalDetailResult,
  ProposalActionOutput,
  ProposalActionResult,
  ProposalListOutput,
  ProposalListResult,
  AuditQueryOutput,
  AuditQueryResult,
  AuditQueryOptions,
  RuleListItem,
  RuleListResult,
  RuleListOutput,
  RuleShowResult,
  RuleShowOutput,
  RuleUpdateResult,
  RuleUpdateOutput,
  PurchaseEvaluationParams,
  PurchaseEvaluationResult,
  PurchaseEvaluationOutput,
  CashFlowProjectionParams,
  CashFlowProjectionResult,
  CashFlowProjectionOutput,
  TargetHealthResult,
  TargetHealthOutput,
  SinkingFundHealthResult,
  SinkingFundHealthOutput,
  ReportGenerationParams,
  ReportGenerationResult,
  ReportGenerationOutput,
  SavedViewsListResult,
  SavedViewsListOutput,
  CreateSavedViewParams,
  CreateSavedViewResult,
  CreateSavedViewOutput,
  AttentionHomeParams,
  AttentionHomeResult,
  AttentionHomeOutput,
  FinancialStateResult,
  FinancialStateOutput,
} from './commands.js';

// ---------------------------------------------------------------------------
// Manual/no-model analysis path
// ---------------------------------------------------------------------------

/**
 * Execute a pending-review analysis using injected adapter/protocol data.
 *
 * This is the **manual/no-model** path: it never calls a model provider.
 * Analysis values come from the injected ledger (which wraps the Rust
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

// ---------------------------------------------------------------------------
// Proposal analysis handlers
// ---------------------------------------------------------------------------

/**
 * Shared guard checks for proposal action analysis.
 * Returns a tagged result — `{ ok: false, envelope }` on guard failure,
 * or `{ ok: true, ... }` to proceed.
 *
 * Deterministic guards:
 * - No ledger → not_connected
 * - Stale snapshot data → proposal_stale
 * - No analysis protocol → missing_analysis_protocol
 * - Observe mode → observe_mode_write_blocked
 */
async function guardProposalAction(
  input: CommandInput,
): Promise<
  | { ok: true; requestId: string; actorId: string; ledger: unknown; freshness: DataFreshness | null; analysisProtocol: AnalysisProtocol }
  | { ok: false; envelope: ResponseEnvelope<never> }
> {
  const { requestId, actorId, ledger, freshness, analysisProtocol } = input;

  if (!ledger) {
    const err = new ErrorInfo({
      code: 'not_connected',
      message: 'No ledger connected. Use a connect command first.',
      retryable: true,
      reasonCodes: ['missing_ledger_config'],
    });
    return { ok: false, envelope: errorResponse(requestId, err) };
  }

  if (freshness && freshness.isStale) {
    const err = new ErrorInfo({
      code: 'proposal_stale',
      message: 'Proposal data is stale. Reconnect or refresh before proceeding.',
      retryable: true,
      reasonCodes: [ReasonCodes.PROPOSAL_STALE],
    });
    return { ok: false, envelope: errorResponse(requestId, err) };
  }

  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return { ok: false, envelope: errorResponse(requestId, err) };
  }

  if (input.mode === 'observe') {
    const err = new ErrorInfo({
      code: 'write_rejected',
      message: 'Write operation is not permitted in Observe mode. Proposal mutations require a write-enabled mode.',
      retryable: false,
      reasonCodes: [ReasonCodes.OBSERVE_MODE_WRITE_BLOCKED],
    });
    return { ok: false, envelope: errorResponse(requestId, err) };
  }

  return { ok: true, requestId, actorId, ledger, freshness, analysisProtocol };
}

/**
 * Create a new proposal from CLI arguments.
 * Delegates to the Rust protocol for the actual creation.
 */
export async function proposalCreateAnalysis(
  input: CommandInput,
  options?: ReviewActionOptions,
): Promise<ProposalCreateOutput['envelope']> {
  const guarded = await guardProposalAction(input);
  if (!guarded.ok) return guarded.envelope;
  const { requestId, actorId, ledger, freshness, analysisProtocol } = guarded;

  if (!analysisProtocol.proposalCreate) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Proposal action not available: the protocol does not support proposal creation.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.proposalCreate(ledger, mergedOptions);
    return okResponse(requestId, freshness, AuthorizationContext.mutation(actorId, 'proposal.create'), result);
  } catch (err) {
    if (err instanceof ApplicationError) {
      return errorResponse(requestId, new ErrorInfo({
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        reasonCodes: err.reasonCodes,
      }));
    }
    const message = err instanceof Error ? err.message : String(err);
    const errInfo = new ErrorInfo({
      code: 'analysis_failed',
      message,
      retryable: false,
      reasonCodes: ['analysis_error'],
    });
    return errorResponse(requestId, errInfo);
  }
}

/**
 * Show a specific proposal by ID.
 * Delegates to the Rust protocol for details.
 */
export async function proposalShowAnalysis(
  input: CommandInput,
  proposalId: string,
): Promise<ProposalShowOutput['envelope']> {
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
      code: 'proposal_stale',
      message: 'Proposal data is stale. Reconnect or refresh before proceeding.',
      retryable: true,
      reasonCodes: [ReasonCodes.PROPOSAL_STALE],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol.proposalShow) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Proposal show not available: the protocol does not support proposal details.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.proposalShow(ledger, proposalId);
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
 * Approve a proposal.
 * Delegates to the Rust protocol for the actual transition.
 * The protocol enforces guard behavior: proposal not found, approval
 * expiry/consumption/supersession, payload mismatch, inactive membership,
 * capability/scope failure.
 */
export async function proposalApproveAnalysis(
  input: CommandInput,
  proposalId: string,
  options?: ReviewActionOptions,
): Promise<ProposalActionOutput['envelope']> {
  const guarded = await guardProposalAction(input);
  if (!guarded.ok) return guarded.envelope;
  const { requestId, actorId, ledger, freshness, analysisProtocol } = guarded;

  if (!analysisProtocol.proposalApprove) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Proposal action not available: the protocol does not support proposal approval.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.proposalApprove(ledger, proposalId, mergedOptions);
    return okResponse(requestId, freshness, AuthorizationContext.mutation(actorId, 'proposal.approve'), result);
  } catch (err) {
    if (err instanceof ApplicationError) {
      return errorResponse(requestId, new ErrorInfo({
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        reasonCodes: err.reasonCodes,
      }));
    }
    const message = err instanceof Error ? err.message : String(err);
    const errInfo = new ErrorInfo({
      code: 'analysis_failed',
      message,
      retryable: false,
      reasonCodes: ['analysis_error'],
    });
    return errorResponse(requestId, errInfo);
  }
}

/**
 * Execute an approved proposal.
 * Delegates to the Rust protocol for the actual execution.
 */
export async function proposalExecuteAnalysis(
  input: CommandInput,
  proposalId: string,
  options?: ReviewActionOptions,
): Promise<ProposalActionOutput['envelope']> {
  const guarded = await guardProposalAction(input);
  if (!guarded.ok) return guarded.envelope;
  const { requestId, actorId, ledger, freshness, analysisProtocol } = guarded;

  if (!analysisProtocol.proposalExecute) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Proposal action not available: the protocol does not support proposal execution.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.proposalExecute(ledger, proposalId, mergedOptions);
    return okResponse(requestId, freshness, AuthorizationContext.mutation(actorId, 'proposal.execute'), result);
  } catch (err) {
    if (err instanceof ApplicationError) {
      return errorResponse(requestId, new ErrorInfo({
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        reasonCodes: err.reasonCodes,
      }));
    }
    const message = err instanceof Error ? err.message : String(err);
    const errInfo = new ErrorInfo({
      code: 'analysis_failed',
      message,
      retryable: false,
      reasonCodes: ['analysis_error'],
    });
    return errorResponse(requestId, errInfo);
  }
}

/**
 * List proposals.
 * Uses the read-only path (no guard needed for write-blocked checks).
 */
export async function proposalListAnalysis(
  input: CommandInput,
): Promise<ProposalListOutput['envelope']> {
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
      code: 'proposal_stale',
      message: 'Proposal data is stale. Reconnect or refresh before proceeding.',
      retryable: true,
      reasonCodes: [ReasonCodes.PROPOSAL_STALE],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol.proposalList) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Proposal list not available: the protocol does not support proposal listing.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.proposalList(ledger);
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
 * Query the audit trail.
 */
export async function auditQueryAnalysis(
  input: CommandInput,
  query?: AuditQueryOptions,
): Promise<AuditQueryOutput['envelope']> {
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
      reasonCodes: [ReasonCodes.STALE_SNAPSHOT],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol.auditQuery) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Audit query not available: the protocol does not support audit trail queries.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.auditQuery(ledger, query);
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
// Rule create analysis handler
// ---------------------------------------------------------------------------

/**
 * Create a new rule proposal.
 * Delegates to the Rust protocol for the actual creation.
 */
export async function ruleCreateAnalysis(
  input: CommandInput,
  options?: ReviewActionOptions,
): Promise<RuleUpdateOutput['envelope']> {
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
      code: 'rule_create_stale',
      message: 'Snapshot data is stale. Reconnect or refresh before creating a rule.',
      retryable: true,
      reasonCodes: [ReasonCodes.PROPOSAL_STALE],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  if (input.mode === 'observe') {
    const err = new ErrorInfo({
      code: 'write_rejected',
      message: 'Write operation is not permitted in Observe mode. Rule creation requires a write-enabled mode.',
      retryable: false,
      reasonCodes: [ReasonCodes.OBSERVE_MODE_WRITE_BLOCKED],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol.ruleCreate) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Rule creation not available: the protocol does not support rule creation.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.ruleCreate(ledger, mergedOptions);
    return okResponse(requestId, freshness, AuthorizationContext.mutation(actorId, 'rule.create'), result);
  } catch (err) {
    if (err instanceof ApplicationError) {
      return errorResponse(requestId, new ErrorInfo({
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        reasonCodes: err.reasonCodes,
      }));
    }
    const message = err instanceof Error ? err.message : String(err);
    const errInfo = new ErrorInfo({
      code: 'analysis_failed',
      message,
      retryable: false,
      reasonCodes: ['analysis_error'],
    });
    return errorResponse(requestId, errInfo);
  }
}

// ---------------------------------------------------------------------------
// Rule list/show analysis handlers
// ---------------------------------------------------------------------------

/**
 * List automation rules.
 * Uses the read-only path via the ledger directly.
 */
export async function ruleListAnalysis(
  input: CommandInput,
): Promise<RuleListOutput['envelope']> {
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
      code: 'rule_stale',
      message: 'Rule data is stale. Reconnect or refresh before proceeding.',
      retryable: true,
      reasonCodes: [ReasonCodes.STALE_SNAPSHOT],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  try {
    const rules: RuleListItem[] = await (ledger as any).listRules();
    const result: RuleListResult = { items: rules };
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
 * Show a single rule by ID.
 * Lists all rules and filters by the given ID.
 */
export async function ruleShowAnalysis(
  input: CommandInput,
  ruleId: string,
): Promise<RuleShowOutput['envelope']> {
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
      code: 'rule_stale',
      message: 'Rule data is stale. Reconnect or refresh before proceeding.',
      retryable: true,
      reasonCodes: [ReasonCodes.STALE_SNAPSHOT],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  try {
    const allRules: RuleShowResult[] = await (ledger as any).listRules();
    const rule = allRules.find(r => r.id === ruleId);
    if (!rule) {
      const err = new ErrorInfo({
        code: 'rule_not_found',
        message: `Rule not found: ${ruleId}`,
        retryable: false,
        reasonCodes: ['rule_not_found'],
      });
      return errorResponse(requestId, err);
    }
    return okResponse(requestId, freshness, AuthorizationContext.observe(actorId), rule);
  } catch (err) {
    if (err instanceof ApplicationError) {
      return errorResponse(requestId, new ErrorInfo({
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        reasonCodes: err.reasonCodes,
      }));
    }
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
// Rule update analysis handler
// ---------------------------------------------------------------------------

/**
 * Update a rule via proposal.
 * Delegates to the Rust protocol for the actual update proposal.
 */
export async function ruleUpdateAnalysis(
  input: CommandInput,
  options?: ReviewActionOptions,
): Promise<RuleUpdateOutput['envelope']> {
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
      code: 'rule_update_stale',
      message: 'Snapshot data is stale. Reconnect or refresh before updating a rule.',
      retryable: true,
      reasonCodes: [ReasonCodes.PROPOSAL_STALE],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Analysis protocol is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  if (input.mode === 'observe') {
    const err = new ErrorInfo({
      code: 'write_rejected',
      message: 'Write operation is not permitted in Observe mode. Rule update requires a write-enabled mode.',
      retryable: false,
      reasonCodes: [ReasonCodes.OBSERVE_MODE_WRITE_BLOCKED],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol.ruleUpdate) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Rule update not available: the protocol does not support rule updates.',
      retryable: true,
      reasonCodes: [ReasonCodes.MISSING_ANALYSIS_PROTOCOL],
    });
    return errorResponse(requestId, err);
  }

  try {
    const mergedOptions: ReviewActionOptions = { ...options, actorId, requestId };
    const result = await analysisProtocol.ruleUpdate(ledger, mergedOptions);
    return okResponse(requestId, freshness, AuthorizationContext.mutation(actorId, 'rule.update'), result);
  } catch (err) {
    if (err instanceof ApplicationError) {
      return errorResponse(requestId, new ErrorInfo({
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        reasonCodes: err.reasonCodes,
      }));
    }
    const message = err instanceof Error ? err.message : String(err);
    const errInfo = new ErrorInfo({
      code: 'analysis_failed',
      message,
      retryable: false,
      reasonCodes: ['analysis_error'],
    });
    return errorResponse(requestId, errInfo);
  }
}

// ---------------------------------------------------------------------------
// Budget Intelligence — Purchase Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a proposed purchase against budget limits.
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips auth gates — results are always observable.
 */
export async function purchaseEvaluationAnalysis(
  input: CommandInput,
  params: PurchaseEvaluationParams,
): Promise<PurchaseEvaluationOutput['envelope']> {
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
      code: 'stale_budget_intelligence',
      message: 'Snapshot data is stale. Reconnect or re-download before evaluating a purchase.',
      retryable: true,
      reasonCodes: [ReasonCodes.STALE_BUDGET_INTELLIGENCE_DATA],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol || !analysisProtocol.purchaseEvaluation) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Purchase evaluation is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  if (!params.categoryId) {
    const err = new ErrorInfo({
      code: 'purchase_category_required',
      message: 'A category ID is required to evaluate a purchase.',
      retryable: false,
      reasonCodes: [ReasonCodes.PURCHASE_CATEGORY_REQUIRED],
    });
    return errorResponse(requestId, err);
  }

  if (!params.amount || params.amount.minorUnits === '0') {
    const err = new ErrorInfo({
      code: 'purchase_amount_required',
      message: 'A non-zero purchase amount is required.',
      retryable: false,
      reasonCodes: [ReasonCodes.PURCHASE_AMOUNT_REQUIRED],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.purchaseEvaluation(ledger, params);
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
// Budget Intelligence — Cash-Flow Projection
// ---------------------------------------------------------------------------

/**
 * Project future cash flow based on schedules and budgets.
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips auth gates — results are always observable.
 */
export async function cashFlowProjectionAnalysis(
  input: CommandInput,
  params: CashFlowProjectionParams,
): Promise<CashFlowProjectionOutput['envelope']> {
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
      code: 'stale_budget_intelligence',
      message: 'Snapshot data is stale. Reconnect or re-download before projecting cash flow.',
      retryable: true,
      reasonCodes: [ReasonCodes.STALE_BUDGET_INTELLIGENCE_DATA],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol || !analysisProtocol.cashFlowProjection) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Cash-flow projection is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  const months = params.months ?? 3;
  if (months < 1 || months > 24) {
    const err = new ErrorInfo({
      code: 'invalid_cash_flow_months',
      message: 'Projection months must be between 1 and 24.',
      retryable: false,
      reasonCodes: ['invalid_cash_flow_months'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.cashFlowProjection(ledger, params);
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
// Budget Intelligence — Target & Sinking-Fund Health
// ---------------------------------------------------------------------------

/**
 * Evaluate target and sinking-fund health.
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips auth gates — results are always observable.
 */
export async function targetHealthAnalysis(
  input: CommandInput,
): Promise<TargetHealthOutput['envelope']> {
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
      code: 'stale_budget_intelligence',
      message: 'Snapshot data is stale. Reconnect or re-download before evaluating target health.',
      retryable: true,
      reasonCodes: [ReasonCodes.STALE_BUDGET_INTELLIGENCE_DATA],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol || !analysisProtocol.targetHealth) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Target health evaluation is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.targetHealth(ledger);
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
 * Evaluate sinking fund health specifically.
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips auth gates — results are always observable.
 */
export async function sinkingFundHealthAnalysis(
  input: CommandInput,
): Promise<SinkingFundHealthOutput['envelope']> {
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
      code: 'stale_budget_intelligence',
      message: 'Snapshot data is stale. Reconnect or re-download before evaluating sinking fund health.',
      retryable: true,
      reasonCodes: [ReasonCodes.STALE_BUDGET_INTELLIGENCE_DATA],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol || !analysisProtocol.sinkingFundHealth) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Sinking fund health evaluation is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.sinkingFundHealth(ledger);
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
// Budget Intelligence — Report Generation (persisted scope/filters)
// ---------------------------------------------------------------------------

/**
 * Generate a report with persisted exact scope and filters.
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips auth gates — results are always observable.
 */
export async function reportGenerateAnalysis(
  input: CommandInput,
  params: ReportGenerationParams,
): Promise<ReportGenerationOutput['envelope']> {
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
      code: 'stale_budget_intelligence',
      message: 'Snapshot data is stale. Reconnect or re-download before generating a report.',
      retryable: true,
      reasonCodes: [ReasonCodes.STALE_BUDGET_INTELLIGENCE_DATA],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol || !analysisProtocol.generateReport) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Report generation is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  if (!params.scope || !params.scope.monthRange) {
    const err = new ErrorInfo({
      code: 'report_scope_required',
      message: 'A report scope with a month range is required.',
      retryable: false,
      reasonCodes: [ReasonCodes.REPORT_SCOPE_REQUIRED],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.generateReport(ledger, params);
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
// Budget Intelligence — Saved Views
// ---------------------------------------------------------------------------

/**
 * List saved views.
 * Read-only deterministic — no model or cloud invocation.
 * Skips auth gates.
 */
export async function savedViewsListAnalysis(
  input: CommandInput,
): Promise<SavedViewsListOutput['envelope']> {
  const { requestId, actorId, ledger, freshness, analysisProtocol, workflowStore } = input;

  // Prefer workflow persistence when the supplied store implements the
  // saved-view contract; test doubles and CLI callers may provide a partial
  // store and must continue through the protocol fallback.
  if (workflowStore && typeof workflowStore.listSavedViews === 'function') {
    try {
      const views = await workflowStore.listSavedViews(actorId);
      const result: SavedViewsListResult = {
        views: views.map(v => ({
          viewId: v.viewId,
          name: v.name,
          viewType: v.viewType,
          scope: v.scope,
          ...(v.sort != null ? { sort: v.sort } : {}),
          createdAt: v.createdAt,
        })),
        total: views.length,
      };
      return okResponse(requestId, freshness, AuthorizationContext.observe(actorId), result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errInfo = new ErrorInfo({
        code: 'store_failed',
        message,
        retryable: true,
        reasonCodes: ['store_error'],
      });
      return errorResponse(requestId, errInfo);
    }
  }

  // Fallback: protocol path (CLI/no-store environments)
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
      code: 'stale_budget_intelligence',
      message: 'Snapshot data is stale. Reconnect or re-download before listing views.',
      retryable: true,
      reasonCodes: [ReasonCodes.STALE_BUDGET_INTELLIGENCE_DATA],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol || !analysisProtocol.listSavedViews) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Saved views are not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.listSavedViews(ledger);
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
 * Create a saved view.
 * Read-only scope persistence — no model or cloud invocation.
 * Skips auth gates — view creation is a local preference operation.
 */
export async function savedViewCreateAnalysis(
  input: CommandInput,
  params: CreateSavedViewParams,
): Promise<CreateSavedViewOutput['envelope']> {
  const { requestId, actorId, ledger, freshness, analysisProtocol, workflowStore } = input;

  // Prefer workflow persistence when the supplied store implements the
  // saved-view contract; partial store doubles use the protocol fallback.
  if (workflowStore && typeof workflowStore.createSavedView === 'function') {
    if (!params.name || !params.viewType) {
      const err = new ErrorInfo({
        code: 'view_params_required',
        message: 'A view name and type are required.',
        retryable: false,
        reasonCodes: ['view_params_required'],
      });
      return errorResponse(requestId, err);
    }

    try {
      const savedView = await workflowStore.createSavedView({
        name: params.name,
        viewType: params.viewType,
        scope: params.scope,
        sort: params.sort,
        actorId,
      });
      const result: CreateSavedViewResult = {
        view: {
          viewId: savedView.viewId,
          name: savedView.name,
          viewType: savedView.viewType,
          scope: savedView.scope,
          ...(savedView.sort != null ? { sort: savedView.sort } : {}),
          createdAt: savedView.createdAt,
        },
      };
      return okResponse(requestId, freshness, AuthorizationContext.observe(actorId), result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errInfo = new ErrorInfo({
        code: 'store_failed',
        message,
        retryable: true,
        reasonCodes: ['store_error'],
      });
      return errorResponse(requestId, errInfo);
    }
  }

  // Fallback: protocol path (CLI/no-store environments)
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
      code: 'stale_budget_intelligence',
      message: 'Snapshot data is stale. Reconnect or re-download before creating a view.',
      retryable: true,
      reasonCodes: [ReasonCodes.STALE_BUDGET_INTELLIGENCE_DATA],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol || !analysisProtocol.createSavedView) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Saved view creation is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  if (!params.name || !params.viewType) {
    const err = new ErrorInfo({
      code: 'view_params_required',
      message: 'A view name and type are required.',
      retryable: false,
      reasonCodes: ['view_params_required'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.createSavedView(ledger, params);
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
// Budget Intelligence — Attention / Home Dashboard
// ---------------------------------------------------------------------------

/**
 * Get the prioritized attention/home dashboard combining blockers, alerts,
 * recurrence patterns, category risks, and target progress.
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips auth gates — results are always observable.
 */
export async function attentionHomeAnalysis(
  input: CommandInput,
  params: AttentionHomeParams,
): Promise<AttentionHomeOutput['envelope']> {
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
      code: 'stale_budget_intelligence',
      message: 'Snapshot data is stale. Reconnect or re-download before loading the attention dashboard.',
      retryable: true,
      reasonCodes: [ReasonCodes.STALE_BUDGET_INTELLIGENCE_DATA],
    });
    return errorResponse(requestId, err);
  }

  if (!analysisProtocol || !analysisProtocol.attentionHome) {
    const err = new ErrorInfo({
      code: 'no_analysis_protocol',
      message: 'Attention dashboard is not available. Ensure the Rust protocol bindings are loaded.',
      retryable: true,
      reasonCodes: ['missing_analysis_protocol'],
    });
    return errorResponse(requestId, err);
  }

  try {
    const result = await analysisProtocol.attentionHome(ledger, params);
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
