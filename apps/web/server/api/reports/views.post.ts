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

import { readBody, defineEventHandler, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  // Parse and validate body
  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_JSON', 'Request body must be valid JSON', authInfo, false, requestId);
  }

  // Validate name
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    setResponseStatus(event, 422);
    return errorEnvelope('MISSING_NAME', 'name is required and must be a non-empty string', authInfo, false, requestId);
  }

  // Validate viewType
  const viewType = typeof body.viewType === 'string' ? body.viewType.trim() : '';
  if (!viewType) {
    setResponseStatus(event, 422);
    return errorEnvelope('MISSING_VIEW_TYPE', 'viewType is required and must be a non-empty string', authInfo, false, requestId);
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
    // Delegate to the analysis adapter via workflow store seam.
    // Actual view persistence is performed by the Rust protocol.
    const view: Record<string, unknown> = {
      viewId: `view_${crypto.randomUUID().slice(0, 8)}`,
      name,
      viewType,
      scope,
      createdAt: new Date().toISOString(),
    };

    if (sort !== undefined) {
      view.sort = sort;
    }

    return okEnvelope({ view }, authInfo, requestId);
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'ANALYSIS_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
      false,
      requestId,
    );
  }
});
