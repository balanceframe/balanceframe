/**
 * GET /api/notifications/status — runtime health and activity summary.
 *
 * Returns notification runtime status.  Auth gate: requires notification:receive.
 * Policy version and recipient status are resolved from the persistent store.
 * No module-level singleton — runtime is constructed per-request from the
 * active WorkflowStore and its persisted per-space policy.
 */

import { defineEventHandler, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
  requireAuthorization,
} from '../../utils/workflow-store';
import {
  NotificationRuntime,
  InAppChannelAdapter,
  type NotificationPolicy,
} from '@balanceframe/application';
import type { WorkflowStore } from '@balanceframe/workflow-store';

/**
 * Build a NotificationRuntime from the active workflow store.
 * Loads the persisted per-space policy and wires store-backed
 * re-authorization using the store's membership data.
 */
function buildRuntime(wfStore: WorkflowStore, spaceId: string): NotificationRuntime {
  const defaultPolicy: NotificationPolicy = {
    policyVersion: 'v1',
    eligibility: [
      {
        classifications: [
          'budget_alert',
          'review_complete',
          'security_alert',
          'data_quality',
          'alert',
          'recurrence',
          'target_risk',
          'proposal_transition',
          'workflow_result',
        ],
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
  const runtime = new NotificationRuntime(wfStore, defaultPolicy, [adapter]);

  // Wire store-backed re-authorization using the store's membership data.
  runtime.setReAuthorizationHook(async (actorId: string, capability: string, _scope: string) => {
    try {
      const membership = await wfStore.getActorMembership(actorId);
      return membership?.capabilities.includes(capability) ?? false;
    } catch {
      return false;
    }
  });

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

    // Build runtime per-request from the active store (no singleton)
    const rt = buildRuntime(wf.store, 'default');

    // Load persisted per-space policy from the store
    let activePolicyVersion = 'v1';
    try {
      const storedPolicy = await rt.loadPersistedPolicy('default');
      activePolicyVersion = storedPolicy.policyVersion;
    } catch {
      // Use default version when store lookup fails
    }

    const status = await rt.getStatus();

    // Count recipients from persisted policy
    const policy = await rt.loadPersistedPolicy('default');
    const recipientCount = policy.recipients.length;

    return okEnvelope(
      {
        ...status,
        policyVersion: activePolicyVersion,
        recipientCount,
      },
      auth.info,
      requestId,
    );
  } catch (err) {
    setResponseStatus(event, 503);
    return errorEnvelope(
      'RUNTIME_UNAVAILABLE',
      'Notification runtime not available',
      authInfo,
      false,
      requestId,
    );
  }
});
