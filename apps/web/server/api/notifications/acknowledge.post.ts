/**
 * POST /api/notifications/acknowledge — acknowledge a delivered notification.
 *
 * Untrusted callback: only changes notification state, never mutates ledger.
 * Reads outbox ID from JSON body.
 *
 * Request body: { outboxId: string }
 * Response envelope: { outboxId, status: 'acknowledged' }
 */

import { defineEventHandler, readBody, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
  getActorId,
  sanitizeError,
} from '../../utils/workflow-store';
import { NotificationRuntime, InAppChannelAdapter } from '@balanceframe/application';

/** Module-level singleton — lazy-initialised from workflow store. */
let runtime: NotificationRuntime | null = null;

function getRuntime(event: { context: Record<string, unknown> }): NotificationRuntime {
  if (runtime) return runtime;
  const result = getWorkflowStore(event as any);
  if ('error' in result) {
    throw new Error('Workflow store not available');
  }
  const policy = {
    policyVersion: 'v1',
    eligibility: [
      {
        classifications: ['budget_alert', 'review_complete', 'security_alert'],
        minSeverity: 'normal' as const,
        requiredCapability: 'notification:receive',
      },
    ],
    recipients: [],
    channels: [
      { type: 'in_app' as const, enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' },
    ],
    redaction: {
      sensitive: { visibleFields: ['title', 'summary'] },
      public: { visibleFields: ['title', 'summary', 'amount', 'account'] },
      restricted: { visibleFields: ['title'] },
    },
    maxRetries: 3,
    defaultRedactionClass: 'public',
  };
  const adapter = new InAppChannelAdapter();
  runtime = new NotificationRuntime(result.store, policy, [adapter]);
  return runtime;
}

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  const auth = await requireAuthorization(event, 'notification:receive');
  if (!auth.ok) return auth.response;
  const authInfo = auth.info;

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

  const outboxId = typeof body.outboxId === 'string' ? body.outboxId.trim() : '';
  if (!outboxId) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_OUTBOX_ID', 'outboxId is required.', authInfo, false, requestId);
  }

  try {
    const rt = getRuntime(event as { context: Record<string, unknown> });
    const actorId = getActorId(event);
    const detail = await rt.getOutboxDetail(outboxId, actorId);

    if (!detail) {
      setResponseStatus(event, 404);
      return errorEnvelope(
        'NOT_FOUND',
        'Notification not found or access denied.',
        authInfo,
        false,
        requestId,
      );
    }

    if (detail.event.recipientId !== actorId) {
      const scope = typeof detail.event.scope === 'string' ? detail.event.scope.trim() : '';
      if (!scope) {
        setResponseStatus(event, 404);
        return errorEnvelope(
          'NOT_FOUND',
          'Notification not found or access denied.',
          authInfo,
          false,
          requestId,
        );
      }

      const adminAuth = await requireAuthorization(event, 'notification:admin', scope);
      if (!adminAuth.ok) {
        setResponseStatus(event, 404);
        return errorEnvelope(
          'NOT_FOUND',
          'Notification not found or access denied.',
          authInfo,
          false,
          requestId,
        );
      }
    }

    const record = await rt.acknowledgeFromCallback(outboxId, body);
    return okEnvelope({ outboxId: record.id, status: record.status }, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'ACKNOWLEDGE_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
