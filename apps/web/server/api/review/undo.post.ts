/**
 * POST /api/review/undo — undo the last reversible transition on a review item.
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
  requireAuthorization,
  buildAuthorizationInfo,
} from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  const authCheck = await requireAuthorization(event, 'categorization:execute');
  if (!authCheck.ok) return authCheck.response;
  const authInfo = authCheck.info;

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

  const outcome = await performReviewAction(wf.store, reviewId, 'undo', actorId);

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
    setResponseStatus(event, status);
    return errorEnvelope(code, outcome.error ?? 'Unknown error', authInfo, false, requestId);
  }

  // Undo is workflow-only — no mutation even in reviewAndApply mode
  return okEnvelope(
    {
      itemId: outcome.itemId,
      success: true,
      error: null,
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
