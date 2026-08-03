/**
 * POST /api/notifications/suppress — suppress a pending notification.
 *
 * Read-only with respect to ledger data (only changes notification state).
 * Prevents future delivery attempts without mutating any other data.
 *
 * Request body: { outboxId: string, reason: string }
 * Response envelope: { outboxId, status: 'suppressed' }
 */

import { defineEventHandler, readBody, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo, sanitizeError } from '../../utils/workflow-store';
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
      { classifications: ['budget_alert', 'review_complete', 'security_alert'], minSeverity: 'normal' as const, requiredCapability: 'notification:receive' },
    ],
    recipients: [],
    channels: [{ type: 'in_app' as const, enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' }],
    redaction: { sensitive: { visibleFields: ['title', 'summary'] }, public: { visibleFields: ['title', 'summary', 'amount', 'account'] }, restricted: { visibleFields: ['title'] } },
    maxRetries: 3,
    defaultRedactionClass: 'public',
  };
  const adapter = new InAppChannelAdapter();
  runtime = new NotificationRuntime(result.store, policy, [adapter]);
  return runtime;
}

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_BODY', 'Request body must be valid JSON.', authInfo, false, requestId);
  }

  const outboxId = typeof body.outboxId === 'string' ? body.outboxId.trim() : '';
  if (!outboxId) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_OUTBOX_ID', 'outboxId is required.', authInfo, false, requestId);
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_REASON', 'reason is required.', authInfo, false, requestId);
  }

  try {
    const rt = getRuntime(event as { context: Record<string, unknown> });
    const record = await rt.suppress(outboxId, reason);
    return okEnvelope({ outboxId: record.id, status: record.status }, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'SUPPRESS_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
