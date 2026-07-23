/**
 * POST /api/review/approve — approve a review item.
 *
 * Accepts JSON body: { reviewId }.
 * actorId is derived from the authenticated event context — never from the
 * request body (prevents spoofing).
 */

import { readBody, defineEventHandler, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  getActorId,
  performReviewAction,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
  reviewAndApplyEnabled,
  getReviewMutationExecutorFromEvent,
  applyReviewMutationWithTransition,
  sanitizeError,
  sanitizeErrorMessage,
} from '../../utils/workflow-store';
import type { ReviewStatus } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'categorization:execute');
  const requestId = crypto.randomUUID();

  // Parse and validate body
  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_JSON', 'Request body must be valid JSON', authInfo, false, requestId);
  }

  const reviewId = typeof body.reviewId === 'string' ? body.reviewId.trim() : '';
  if (!reviewId) {
    setResponseStatus(event, 422);
    return errorEnvelope(
      'MISSING_REVIEW_ID',
      'reviewId is required and must be a non-empty string',
      authInfo,
      false,
      requestId,
    );
  }

  // Derive actor from auth context — never from body
  const actorId = getActorId(event);

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  const outcome = await performReviewAction(wf.store, reviewId, 'approve', actorId);

  if (!outcome.success) {
    let status = 500;
    let code = 'ACTION_FAILED';
    if (outcome.error === 'Review item not found') {
      status = 404;
      code = 'NOT_FOUND';
    } else if (outcome.error?.startsWith('Version conflict')) {
      status = 409;
      code = 'VERSION_CONFLICT';
    }
    console.error(`[${requestId}] ${code}: ${outcome.error ?? 'Unknown error'}`);
    setResponseStatus(event, status);
    return errorEnvelope(code, sanitizeErrorMessage(outcome.error ?? 'Unknown error'), authInfo, false, requestId);
  }

  // Only invoke mutation when the item has reached full 'approved' status
  // (quorum met).  Partial approvals are successful transitions but must
  // NOT trigger external ledger writes.
  if (reviewAndApplyEnabled(event) && outcome.status === 'approved') {
    const executor = getReviewMutationExecutorFromEvent(event);
    if (executor) {
      try {
        const { mutationResult, finalStatus } = await applyReviewMutationWithTransition(
          wf.store,
          reviewId,
          actorId,
          executor,
          requestId,
        );

        return okEnvelope(
          {
            itemId: outcome.itemId,
            success: mutationResult.success,
            error: mutationResult.error,
            status: outcome.status,
            categorizationExecuted: true,
            mutationStatus: mutationResult.mutationStatus,
            applied: mutationResult.applied,
            verified: mutationResult.verified,
            stale: mutationResult.stale,
            transactionId: mutationResult.transactionId,
            previousCategoryId: mutationResult.previousCategoryId,
            newCategoryId: mutationResult.newCategoryId,
            finalStatus,
          },
          authInfo,
          requestId,
        );
      } catch (e) {
        const safe = sanitizeError(e, requestId, 'MUTATION_FAILED', false);
        setResponseStatus(event, 500);
        return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
      }
    }

    // Review-and-apply must fail closed if the secure application service was
    // not injected; never report a successful workflow-only approval.
    setResponseStatus(event, 501);
    return errorEnvelope(
      'NOT_IMPLEMENTED',
      'Review-and-apply requires a secure mutation service composition.',
      authInfo,
      false,
      requestId,
    );
  }

  // Not quorate or observe mode — workflow transition only, no mutation
  return okEnvelope(
    {
      itemId: outcome.itemId,
      success: true,
      error: null,
      status: outcome.status,
      categorizationExecuted: false,
      mutationStatus: 'noop',
      applied: false,
      verified: false,
      stale: false,
      transactionId: null,
      previousCategoryId: null,
      newCategoryId: null,
    },
    authInfo,
    requestId,
  );
});
