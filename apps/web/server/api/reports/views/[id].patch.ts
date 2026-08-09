/**
 * PATCH /api/reports/views/:id — update a saved view's name/scope/sort.
 *
 * Reads view ID from URL param, body fields are optional.
 * Fails with VIEW_NOT_FOUND when the view does not exist.
 *
 * Response envelope: SavedViewResult
 */

import { defineEventHandler, readBody, getRouterParam, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
  getActorId,
  sanitizeError,
} from '../../../utils/workflow-store';

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

  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_BODY',
      'Request body must be valid JSON.',
      authInfo,
      false,
      requestId,
    );
  }

  try {
    const existing = await wf.store.getSavedView(viewId);
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

    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    const scope =
      typeof body.scope === 'object' && body.scope !== null && !Array.isArray(body.scope)
        ? (body.scope as Record<string, unknown>)
        : undefined;
    const sort =
      body.sort !== undefined
        ? typeof body.sort === 'string'
          ? body.sort.trim()
          : null
        : undefined;

    const updated = await wf.store.updateSavedView(viewId, { name, scope, sort });
    return okEnvelope(updated, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'UPDATE_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
