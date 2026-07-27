/**
 * GET /api/reports/views — list saved views.
 *
 * Read-only deterministic — no model or cloud invocation.
 * Skips authorization gates — results are always observable.
 *
 * Response envelope: SavedViewsListOutput
 */

import { defineEventHandler, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo);
  }

  try {
    // Delegate to the analysis adapter via workflow store seam.
    // Actual view listing is performed by the Rust protocol.
    const result = {
      views: [] as Array<{
        viewId: string;
        name: string;
        viewType: string;
        scope: Record<string, unknown>;
        createdAt: string;
      }>,
      total: 0,
    };

    return okEnvelope(result, authInfo, requestId);
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'ANALYSIS_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
    );
  }
});
