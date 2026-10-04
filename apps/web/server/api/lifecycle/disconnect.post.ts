import { createDefaultConnectionManager, createLifecycleCallbacks } from '@balanceframe/application';
import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  getHumanControlAuth,
  hasTrustedRequestOrigin,
  type ReauthenticationEvent,
} from '../../utils/reauthentication';
import type { EventWithContext } from '../../utils/workflow-store';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const reauthEvent = event as ReauthenticationEvent;
  if (!hasTrustedRequestOrigin(reauthEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Disconnect is not authorized.', null, false, requestId);
  }

  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  const authorization = await requireAuthorization(
    event as unknown as EventWithContext,
    'connection:manage',
    `space:${selected.space.id}`,
  );
  if (!authorization.ok) return authorization.response;
  const proof = await getHumanControlAuth(reauthEvent);
  if (!proof || proof.actorId !== selected.auth.actorId) {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'REAUTHENTICATION_REQUIRED',
      'A recently reauthenticated human session is required.',
      authorization.info,
      false,
      requestId,
    );
  }
  const budgetId = selected.space.budgetId;
  if (!budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_CONNECTION_REQUIRED', 'The selected space has no connected budget.', authorization.info, false, requestId);
  }
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Lifecycle storage is unavailable.', authorization.info, true, requestId);
  }

  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const callbacks = createLifecycleCallbacks(() => null, {
      workflowStore: workflow.store,
      scope: { spaceId: selected.space.id, budgetId, actorId: selected.auth.actorId },
      disconnectConnection: () => manager.disconnect(budgetId),
    });
    const result = await callbacks.doDisconnect(null);
    return okEnvelope(result, authorization.info, requestId, {
      scope: { spaceId: selected.space.id, budgetId },
    });
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'DISCONNECT_FAILED', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
});
