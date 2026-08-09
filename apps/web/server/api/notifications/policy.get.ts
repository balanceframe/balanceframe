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
  buildAuthorizationInfo,
  sanitizeError,
} from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
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

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const policy = await wf.store.getNotificationPolicy(spaceId, policyKey);
    if (!policy) {
      setResponseStatus(event, 404);
      return errorEnvelope(
        'POLICY_NOT_FOUND',
        `No notification policy found for space "${spaceId}" with key "${policyKey}".`,
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
