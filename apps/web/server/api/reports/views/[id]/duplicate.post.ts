/**
 * POST /api/reports/views/:id/duplicate — duplicate a saved view.
 *
 * Reads view ID from URL param, new name from JSON body.
 * Read-only scope persistence — no model or cloud invocation.
 *
 * Request body: { name: string }
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
} from '../../../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const sourceViewId = getRouterParam(event, 'id') ?? '';

  if (!sourceViewId) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'MISSING_VIEW_ID',
      'Source view ID is required.',
      authInfo,
      false,
      requestId,
    );
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

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'MISSING_NAME',
      'Duplicate view name is required.',
      authInfo,
      false,
      requestId,
    );
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const duplicated = await wf.store.duplicateSavedView({
      sourceViewId,
      name,
      actorId: getActorId(event),
    });
    return okEnvelope(duplicated, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'DUPLICATE_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
