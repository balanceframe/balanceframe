/**
 * POST /api/notifications/policy — save or update notification delivery policy.
 *
 * No-mutation with respect to ledger data (only changes policy state).
 * Request body: { spaceId, policyKey?, policyVersion?, policy }
 *
 * Response envelope: NotificationPolicyRecord
 */

import { defineEventHandler, readBody, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();

  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_BODY',
      'Request body must be valid JSON.',
      null,
      false,
      requestId,
    );
  }

  const spaceId = typeof body.spaceId === 'string' ? body.spaceId.trim() : '';
  if (!spaceId) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'MISSING_SPACE_ID',
      'spaceId is required.',
      null,
      false,
      requestId,
    );
  }

  const authCheck = await requireAuthorization(event, 'notification:admin', spaceId);
  if (!authCheck.ok) return authCheck.response;
  const authInfo = authCheck.info;

  const policyKey = typeof body.policyKey === 'string' ? body.policyKey.trim() : 'delivery';
  const policyVersion = typeof body.policyVersion === 'string' ? body.policyVersion.trim() : 'v1';
  const policy =
    typeof body.policy === 'object' && body.policy !== null && !Array.isArray(body.policy)
      ? (body.policy as Record<string, unknown>)
      : {};

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const saved = await wf.store.saveNotificationPolicy({
      spaceId,
      policyKey,
      policyVersion,
      policy,
    });
    return okEnvelope(saved, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'SAVE_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
