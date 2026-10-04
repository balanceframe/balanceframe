import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { getHumanControlAuth, type ReauthenticationEvent } from '../../utils/reauthentication';
import { requireSelectedSpace } from '../../utils/space-context';
import type { EventWithContext } from '../../utils/workflow-store';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
} from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');

  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;

  const authorization = await requireAuthorization(
    event as unknown as EventWithContext,
    'membership:manage',
    `space:${selected.space.id}`,
  );
  if (!authorization.ok) return authorization.response;

  const auth = await getHumanControlAuth(event as ReauthenticationEvent);
  if (!auth || auth.actorId !== selected.auth.actorId) {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'HUMAN_CONTROL_REQUIRED',
      'Recent human reauthentication is required.',
      authorization.info,
      false,
      requestId,
    );
  }

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', workflow.error, authorization.info, false, requestId);
  }

  try {
    const result = await workflow.store.createInvitation({
      spaceId: selected.space.id,
      auth,
      requestId,
      correlationId: requestId,
    });
    return okEnvelope(
      {
        invitation: {
          id: result.invitation.id,
          status: result.invitation.status,
          expiresAt: result.invitation.expiresAt,
        },
        inviteUrl: result.inviteUrl,
      },
      authorization.info,
      requestId,
    );
  } catch {
    setResponseStatus(event, 409);
    return errorEnvelope(
      'INVITATION_CREATE_FAILED',
      'Invitation could not be created for the selected space.',
      authorization.info,
      false,
      requestId,
    );
  }
});
