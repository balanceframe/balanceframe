/**
 * GET /api/findings/:id — get a single finding by ID.
 *
 * Read-only with respect to ledger data (finding state is separate).
 * Fails with FINDING_NOT_FOUND when the finding does not exist.
 *
 * Response envelope: Finding
 */

import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo, sanitizeError } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const findingId = getRouterParam(event, 'id') ?? '';

  if (!findingId) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_FINDING_ID', 'Finding ID is required.', authInfo, false, requestId);
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const finding = await wf.store.getFinding(findingId);
    if (!finding) {
      setResponseStatus(event, 404);
      return errorEnvelope('FINDING_NOT_FOUND', `Finding "${findingId}" not found.`, authInfo, false, requestId);
    }
    return okEnvelope(finding, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'FETCH_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
