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
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo, sanitizeError } from '../../../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
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

  try {
    const existing = await wf.store.getSavedView(viewId);
    if (!existing) {
      setResponseStatus(event, 404);
      return errorEnvelope('VIEW_NOT_FOUND', `Saved view "${viewId}" not found.`, authInfo, false, requestId);
    }

    const updated = await wf.store.recordSavedViewUsage(viewId);
    return okEnvelope(updated, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'UPDATE_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
