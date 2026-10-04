/**
 * GET /api/notifications/status — runtime health and activity summary.
 *
 * Returns notification runtime status.  Auth gate: requires notification:receive.
 * Policy version and recipient status are resolved from the persistent store.
 * No module-level singleton — runtime is constructed per-request from the
 * active WorkflowStore and its persisted per-space policy.
 */

import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { createNotificationRuntime } from '../../utils/notification-runtime';
import { canReadFinancialNotification, selectedLiquidityActor } from '../../utils/liquidity-service';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';


export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  if (!budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }
  const authorization = await requireAuthorization(
    event as unknown as EventWithContext,
    'notification:receive',
    `budget:${budgetId}`,
  );
  if (!authorization.ok) return authorization.response;
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Notification runtime is unavailable.', authorization.info, false, requestId);
  }
  const actor = selectedLiquidityActor(workflow.store, selected);
  if (!actor) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Current selected-space authorization is unavailable.', authorization.info, false, requestId);
  }

  try {
    const { runtime, policy } = await createNotificationRuntime(workflow.store, selected.space.id);
    const status = await runtime.getStatus({
      actorId: selected.auth.actorId,
      budgetId,
      canReadEvent: async (notification) => {
        if (notification.spaceId !== selected.space.id || notification.budgetId !== budgetId ||
            notification.recipientId !== selected.auth.actorId ||
            notification.recipientMembershipId !== selected.membership.id)
          return false;
        return notification.classification !== 'transfer_needs_attention' ||
          canReadFinancialNotification(workflow.store, actor, notification);
      },
    });
    const recipientCount = policy.recipients.filter(
      (recipient) => recipient.actorId === selected.auth.actorId,
    ).length;
    return okEnvelope({
      ...status,
      policyVersion: policy.policyVersion,
      recipientCount,
    }, authorization.info, requestId);
  } catch {
    setResponseStatus(event, 503);
    return errorEnvelope('RUNTIME_UNAVAILABLE', 'Notification runtime not available.', authorization.info, false, requestId);
  }
});
