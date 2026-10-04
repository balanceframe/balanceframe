import { createLifecycleCallbacks } from '@balanceframe/application';
import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
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

const Body = z.object({
  scope: z.enum(['connection', 'space', 'user', 'provider', 'workflow', 'notification']),
}).strict();

const capabilityByScope = {
  connection: 'connection:manage',
  space: 'space:manage',
  user: 'identity:manage',
  provider: 'connection:manage',
  workflow: 'connection:manage',
  notification: 'policy:manage',
} as const;

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const reauthEvent = event as ReauthenticationEvent;
  if (!hasTrustedRequestOrigin(reauthEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Data deletion is not authorized.', null, false, requestId);
  }
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;

  const body = Body.safeParse(await readBody<unknown>(event).catch(() => null));
  if (!body.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_SCOPE', 'A valid lifecycle data scope is required.', null, false, requestId);
  }
  const scope = body.data.scope;
  const authorization = await requireAuthorization(
    event as unknown as EventWithContext,
    capabilityByScope[scope],
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
    const callbacks = createLifecycleCallbacks(() => null, {
      workflowStore: workflow.store,
      scope: { spaceId: selected.space.id, budgetId, actorId: selected.auth.actorId },
    });
    const result = await callbacks.doDeleteData(null, scope);
    return okEnvelope(result, authorization.info, requestId, {
      scope: { spaceId: selected.space.id, budgetId, dataScope: scope },
    });
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'DATA_DELETION_FAILED', false);
    setResponseStatus(event, 409);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
});
