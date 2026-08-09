/**
 * POST /api/reports/views — create a saved view.
 *
 * Provider-neutral — no model or cloud invocation.
 * Read-only with respect to ledger data (persists view scope only).
 * Skips authorization gates — results are always observable.
 *
 * Body schema:
 *   name     (required) string — human-readable view name
 *   viewType (required) string — view type identifier
 *   scope    (optional) object — filter/scope configuration (defaults to {})
 *   sort     (optional) string — user-defined sort expression
 *
 * Response envelope: CreateSavedViewOutput
 */

import { savedViewCreateAnalysis } from '@balanceframe/application';
import type { CommandInput, CreateSavedViewParams } from '@balanceframe/application';
import { readBody, defineEventHandler, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
  getActorId,
  sanitizeError,
} from '../../utils/workflow-store';

/** Map an analysis error code to an HTTP status. */
function httpStatusForCode(code: string): number {
  if (code.includes('not_connected') || code.includes('no_analysis') || code.startsWith('stale_')) {
    return 503;
  }
  if (
    code.toUpperCase().endsWith('_REQUIRED') ||
    code.startsWith('invalid') ||
    code.startsWith('missing') ||
    code.includes('MISSING')
  ) {
    return 400;
  }
  return 500;
}

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  // Parse and validate body
  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_JSON',
      'Request body must be valid JSON',
      authInfo,
      false,
      requestId,
    );
  }

  // Validate name
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    setResponseStatus(event, 422);
    return errorEnvelope(
      'MISSING_NAME',
      'name is required and must be a non-empty string',
      authInfo,
      false,
      requestId,
    );
  }

  // Validate viewType
  const viewType = typeof body.viewType === 'string' ? body.viewType.trim() : '';
  if (!viewType) {
    setResponseStatus(event, 422);
    return errorEnvelope(
      'MISSING_VIEW_TYPE',
      'viewType is required and must be a non-empty string',
      authInfo,
      false,
      requestId,
    );
  }

  // Validate scope — must be a plain object, default to {}
  const scope: Record<string, unknown> =
    typeof body.scope === 'object' && body.scope !== null && !Array.isArray(body.scope)
      ? (body.scope as Record<string, unknown>)
      : {};

  // Validate sort — optional string
  const sort = typeof body.sort === 'string' ? body.sort.trim() : undefined;

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const input: CommandInput = {
      args: [],
      mode: 'observe',
      actorId: getActorId(event),
      requestId,
      ledger: null,
      freshness: null,
      workflowStore: wf.store,
    };

    const params: CreateSavedViewParams = {
      name,
      viewType,
      scope,
      ...(sort !== undefined ? { sort } : {}),
    };

    const envelope = await savedViewCreateAnalysis(input, params);

    if (envelope.status === 'ok') {
      return okEnvelope(envelope.result, authInfo, envelope.requestId);
    }

    const status = httpStatusForCode(envelope.error.code);
    setResponseStatus(event, status);
    return errorEnvelope(
      envelope.error.code,
      envelope.error.message,
      authInfo,
      envelope.error.retryable,
      envelope.requestId,
    );
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'ANALYSIS_FAILED', true);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
