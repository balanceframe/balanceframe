import { createDefaultConnectionManager, createLifecycleCallbacks } from '@balanceframe/application';
import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { requireFullRead } from '../../utils/legacy-financial-read';
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
    return errorEnvelope('FORBIDDEN', 'Export is not authorized.', null, false, requestId);
  }

  const fullRead = await requireFullRead(event as unknown as EventWithContext);
  if (!fullRead.ok) return fullRead.response;
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  if (!budgetId || budgetId !== fullRead.budgetId || selected.space.id !== fullRead.spaceId) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Export is not authorized.', null, false, requestId);
  }
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
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Lifecycle storage is unavailable.', authorization.info, true, requestId);
  }

  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const result = await manager.withConnection(
      async (connected) => {
        const callbacks = createLifecycleCallbacks(() => connected.connector, {
          workflowStore: workflow.store,
          scope: {
            spaceId: selected.space.id,
            budgetId,
            actorId: selected.auth.actorId,
          },
          budgetName: connected.budget.name,
          synchronization: connected.synchronization,
        });
        return callbacks.doExport(connected.connector);
      },
      { expectedBudgetId: budgetId, dispose: true },
    );
    return okEnvelope(result, authorization.info, requestId, {
      scope: { spaceId: selected.space.id, budgetId },
    });
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'EXPORT_FAILED', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
});
