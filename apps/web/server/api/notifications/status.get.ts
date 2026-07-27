/**
 * GET /api/notifications/status — runtime health and activity summary.
 *
 * Returns notification runtime status.  Auth gate: requires notification:receive.
 * Policy version and recipient status are resolved from the persistent store.
 */

import { defineEventHandler, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo, requireAuthorization } from '../../utils/workflow-store';
import { NotificationRuntime, InAppChannelAdapter, type NotificationPolicy } from '@balanceframe/application';

// Module-level singleton (lazy-initialised)
let runtime: NotificationRuntime | null = null;

function getNotificationRuntime(
  store: ReturnType<typeof getWorkflowStore> extends { store: infer S } ? S : never,
): NotificationRuntime {
  if (runtime) return runtime;
  if ('error' in store) {
    throw new Error('Workflow store not available');
  }
  const defaultPolicy: NotificationPolicy = {
    policyVersion: 'v1',
    eligibility: [
      {
        classifications: ['budget_alert', 'review_complete', 'security_alert'],
        minSeverity: 'normal',
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
  runtime = new NotificationRuntime(store.store, defaultPolicy, [adapter]);
  return runtime;
}

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  // Authorization gate
  const auth = await requireAuthorization(event, 'notification:receive');
  if (!auth.ok) {
    setResponseStatus(event, 403);
    return auth.response;
  }

  try {
    const wf = getWorkflowStore(event);
    if ('error' in wf) {
      setResponseStatus(event, 503);
      return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
    }

    const rt = getNotificationRuntime(wf);

    // Resolve policy version from store for the relevant space
    let activePolicyVersion = 'v1';
    try {
      const storedPolicy = await rt.getStoredPolicyVersion('default');
      if (storedPolicy) {
        activePolicyVersion = storedPolicy;
      }
    } catch {
      // Use default version when store lookup fails
    }

    const status = await rt.getStatus();

    // Count recipients from policy
    const policy = await rt.getStoredPolicy('default');
    const recipientCount = policy.recipients.length;

    return okEnvelope({
      ...status,
      policyVersion: activePolicyVersion,
      recipientCount,
    }, auth.info, requestId);
  } catch (err) {
    setResponseStatus(event, 503);
    return errorEnvelope('RUNTIME_UNAVAILABLE', 'Notification runtime not available', authInfo, false, requestId);
  }
});
