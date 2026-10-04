import { requireFullRead } from '../../../../utils/legacy-financial-read';
/**
 * PATCH /api/reports/views/:id/last-used — record last-used timestamp.
 *
 * Reads view ID from URL param. Fails with VIEW_NOT_FOUND when
 * the view does not exist.
 *
 * No-mutation contract: only updates lastUsedAt metadata.
 *
 * Response envelope: SavedViewResult
 */

import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  sanitizeError,
} from '../../../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const fullRead = await requireFullRead(event);
  if (!fullRead.ok) return fullRead.response;
  const authInfo = fullRead.info;
  const requestId = crypto.randomUUID();
  const viewId = getRouterParam(event, 'id') ?? '';

  if (!viewId) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_VIEW_ID', 'View ID is required.', authInfo, false, requestId);
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  const authority = {
    actorId: fullRead.info.actorId,
    spaceId: fullRead.spaceId,
    budgetId: fullRead.budgetId,
    membershipId: fullRead.actor.membershipId!,
  };
  try {
    const existing = await wf.store.getSavedView(viewId, authority);
    if (!existing) {
      setResponseStatus(event, 404);
      return errorEnvelope(
        'VIEW_NOT_FOUND',
        `Saved view "${viewId}" not found.`,
        authInfo,
        false,
        requestId,
      );
    }

    const updated = await wf.store.recordSavedViewUsage(viewId, authority);
    return okEnvelope(updated, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'UPDATE_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
