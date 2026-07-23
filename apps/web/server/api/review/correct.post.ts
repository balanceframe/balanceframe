/**
 * POST /api/review/correct — correct a review item to a given category.
 *
 * Accepts JSON body: { reviewId, categoryId }.
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
} from '../../utils/workflow-store';
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

  const categoryId = typeof body.categoryId === 'string' ? body.categoryId.trim() : '';
  if (!categoryId) {
    setResponseStatus(event, 422);
    return errorEnvelope(
      'MISSING_CATEGORY_ID',
      'categoryId is required and must be a non-empty string for correction',
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

  const outcome = await performReviewAction(wf.store, reviewId, 'correct', actorId, categoryId);

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

  // Check if reviewAndApply mode is enabled and an executor is available
  if (reviewAndApplyEnabled(event)) {
    const executor = getReviewMutationExecutorFromEvent(event);
    if (executor) {
      try {
        const { mutationResult, finalStatus } = await applyReviewMutationWithTransition(
          wf.store,
          reviewId,
          actorId,
          executor,
          requestId,
          categoryId,
        );

        return okEnvelope(
          {
            itemId: outcome.itemId,
            categoryId,
            success: mutationResult.success,
            error: mutationResult.error,
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
        setResponseStatus(event, 500);
        return errorEnvelope(
          'MUTATION_FAILED',
          e instanceof Error ? e.message : String(e),
          authInfo,
          false,
          requestId,
        );
      }
    }

    // reviewAndApply configured but no executor wired
    return okEnvelope(
      {
        itemId: outcome.itemId,
        categoryId,
        success: true,
        error: 'Mutation executor not available',
        categorizationExecuted: false,
        mutationStatus: 'denied',
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
  }

  // Observe mode — workflow transition only, no mutation
  return okEnvelope(
    {
      itemId: outcome.itemId,
      categoryId,
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
