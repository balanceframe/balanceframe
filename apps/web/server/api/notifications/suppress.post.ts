/**
 * POST /api/notifications/suppress — suppress a pending notification.
 *
 * Read-only with respect to ledger data (only changes notification state).
 * Prevents future delivery attempts without mutating any other data.
 *
 * Request body: { outboxId: string, reason: string }
 * Response envelope: { outboxId, status: 'suppressed' }
 */

import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { canReadFinancialNotification, selectedLiquidityActor } from '../../utils/liquidity-service';
import { createNotificationRuntime } from '../../utils/notification-runtime';
import { getHumanControlAuth, hasTrustedRequestOrigin } from '../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../utils/reauthentication';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
} from '../../utils/workflow-store';
import type { AuthorizationInfo, EventWithContext } from '../../utils/workflow-store';

const SuppressBody = z.object({
  outboxId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(500),
}).strict();

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Notification action is unavailable.', null, false, requestId);
  }
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  if (!budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }

  const receiver = await requireAuthorization(
    event as unknown as EventWithContext,
    'notification:receive',
    `budget:${budgetId}`,
  );
  const administrator = receiver.ok ? null : await requireAuthorization(
    event as unknown as EventWithContext,
    'policy:manage',
    `space:${selected.space.id}`,
  );
  let authInfo: AuthorizationInfo;
  if (receiver.ok) authInfo = receiver.info;
  else if (administrator?.ok) authInfo = administrator.info;
  else if (administrator && !administrator.ok) return administrator.response;
  else return receiver.response;
  if (!receiver.ok) {
    const controlAuth = await getHumanControlAuth(event as ReauthenticationEvent);
    if (!controlAuth || controlAuth.actorId !== selected.auth.actorId) {
      setResponseStatus(event, 403);
      return errorEnvelope('HUMAN_CONTROL_REQUIRED', 'A recently reauthenticated human session is required.', authInfo, false, requestId);
    }
  }

  const parsed = SuppressBody.safeParse(await readBody<unknown>(event).catch(() => null));
  if (!parsed.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_BODY', 'A valid outboxId and reason are required.', authInfo, false, requestId);
  }
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Notification state is unavailable.', authInfo, false, requestId);
  }
  const actor = selectedLiquidityActor(workflow.store, selected);
  if (!actor) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Current selected-space authorization is unavailable.', authInfo, false, requestId);
  }

  try {
    const { runtime } = await createNotificationRuntime(workflow.store, selected.space.id);
    if (receiver.ok) {
      const detail = await runtime.getOutboxDetail(parsed.data.outboxId, selected.auth.actorId);
      if (!detail || detail.event.spaceId !== selected.space.id || detail.event.budgetId !== budgetId ||
          detail.event.recipientId !== selected.auth.actorId ||
          detail.event.recipientMembershipId !== selected.membership.id ||
          (detail.event.classification === 'transfer_needs_attention' &&
            !(await canReadFinancialNotification(workflow.store, actor, detail.event)))) {
        setResponseStatus(event, 404);
        return errorEnvelope('NOT_FOUND', 'Notification not found or access denied.', authInfo, false, requestId);
      }
    } else {
      const outbox = await workflow.store.getOutboxRecord(parsed.data.outboxId);
      const notification = outbox ? await workflow.store.getNotificationEvent(outbox.eventId) : null;
      if (!notification || notification.spaceId !== selected.space.id || notification.budgetId !== budgetId ||
          (notification.classification === 'transfer_needs_attention' &&
            !(await canReadFinancialNotification(workflow.store, actor, notification)))) {
        setResponseStatus(event, 404);
        return errorEnvelope('NOT_FOUND', 'Notification not found or access denied.', authInfo, false, requestId);
      }
    }

    const record = await runtime.suppress(parsed.data.outboxId, parsed.data.reason);
    return okEnvelope({ outboxId: record.id, status: record.status }, authInfo, requestId);
  } catch {
    setResponseStatus(event, 503);
    return errorEnvelope('SUPPRESS_FAILED', 'Notification could not be suppressed.', authInfo, false, requestId);
  }
});
