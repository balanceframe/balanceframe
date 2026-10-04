/**
 * GET /api/notifications/policy — get notification delivery policy.
 *
 * Reads active policy for the request's space/actor.
 * Read-only with respect to ledger data (policy state is separate).
 *
 * Query params: spaceId, policyKey
 * Response envelope: NotificationPolicyRecord
 */

import { defineEventHandler, getQuery, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';

const PolicyQuery = z.object({
  spaceId: z.string().trim().min(1).optional(),
  policyKey: z.string().trim().min(1).optional(),
}).strict();

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;

  const parsed = PolicyQuery.safeParse(getQuery(event));
  if (!parsed.success || parsed.data.spaceId && parsed.data.spaceId !== selected.space.id ||
      parsed.data.policyKey && parsed.data.policyKey !== 'notification') {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_POLICY_QUERY', 'Notification policy query is invalid.', null, false, requestId);
  }
  const policyKey = 'notification';
  const authorization = await requireAuthorization(
    event as unknown as EventWithContext,
    'policy:manage',
    `space:${selected.space.id}`,
  );
  if (!authorization.ok) return authorization.response;
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Notification policy is unavailable.', authorization.info, false, requestId);
  }

  try {
    const policy = await workflow.store.getNotificationPolicy(selected.space.id, policyKey);
    if (!policy || policy.spaceId !== selected.space.id || policy.policyKey !== policyKey) {
      setResponseStatus(event, 404);
      return errorEnvelope('POLICY_NOT_FOUND', 'Notification policy not found.', authorization.info, false, requestId);
    }
    return okEnvelope(policy, authorization.info, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'FETCH_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
});
