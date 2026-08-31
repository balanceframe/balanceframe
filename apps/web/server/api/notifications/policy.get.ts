/**
 * GET /api/notifications/policy — get notification delivery policy.
 *
 * Reads active policy for the request's space/actor.
 * Read-only with respect to ledger data (policy state is separate).
 *
 * Query params: spaceId, policyKey
 * Response envelope: NotificationPolicyRecord
 */

import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';

function getAuthorizedSpaceId(event: {
  context: {
    auth?: {
      spaceId?: unknown;
      user?: { spaceId?: unknown; space_id?: unknown };
    };
  };
}): string {
  const auth = event.context.auth;
  if (typeof auth?.spaceId === 'string') {
    const spaceId = auth.spaceId.trim();
    if (spaceId) return spaceId;
  }
  if (typeof auth?.user?.spaceId === 'string') {
    const spaceId = auth.user.spaceId.trim();
    if (spaceId) return spaceId;
  }
  if (typeof auth?.user?.space_id === 'string') {
    const spaceId = auth.user.space_id.trim();
    if (spaceId) return spaceId;
  }
  return '';
}

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  const authorizedSpaceId = getAuthorizedSpaceId(event);
  const auth = await requireAuthorization(event, 'notification:admin', authorizedSpaceId);
  if (!auth.ok) return auth.response;
  const authInfo = auth.info;

  if (!authorizedSpaceId) {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'SPACE_SCOPE_REQUIRED',
      'An authorized notification space is required.',
      authInfo,
      false,
      requestId,
    );
  }

  const query = getQuery(event);
  const spaceId = typeof query.spaceId === 'string' ? query.spaceId.trim() : '';
  const policyKey = typeof query.policyKey === 'string' ? query.policyKey.trim() : 'delivery';

  if (!spaceId) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'MISSING_SPACE_ID',
      'spaceId query parameter is required.',
      authInfo,
      false,
      requestId,
    );
  }

  if (spaceId !== authorizedSpaceId) {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'SPACE_SCOPE_MISMATCH',
      'The requested space is outside the authorized scope.',
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
    const policy = await wf.store.getNotificationPolicy(authorizedSpaceId, policyKey);
    if (!policy) {
      setResponseStatus(event, 404);
      return errorEnvelope(
        'POLICY_NOT_FOUND',
        `No notification policy found for space "${authorizedSpaceId}" with key "${policyKey}".`,
        authInfo,
        false,
        requestId,
      );
    }
    return okEnvelope(policy, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'FETCH_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
