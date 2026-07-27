/**
 * GET /api/notifications/status — runtime health and activity summary.
 *
 * Returns notification runtime status.  No auth gates — skip-gates contract.
 * Only reports status when the workflow store has been initialised.
 */

import { defineEventHandler, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope } from '../../utils/workflow-store';
import { NotificationRuntime, InAppChannelAdapter } from '@balanceframe/application';

// Module-level singleton (lazy-initialised)
let runtime: NotificationRuntime | null = null;

function getNotificationRuntime(
  event: { context: Record<string, unknown> },
): NotificationRuntime {
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
  try {
    const rt = getNotificationRuntime(event as { context: Record<string, unknown> });
    const status = await rt.getStatus();
    return okEnvelope(status, null);
  } catch {
    setResponseStatus(event, 503);
    return errorEnvelope('RUNTIME_UNAVAILABLE', 'Notification runtime not available', null);
  }
});
