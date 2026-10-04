import { defineEventHandler, getRouterParam, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { getHumanControlAuth, type ReauthenticationEvent } from '../../../utils/reauthentication';
import { requireSelectedSpace } from '../../../utils/space-context';
import type { EventWithContext } from '../../../utils/workflow-store';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
} from '../../../utils/workflow-store';

const InvitationId = z.string().trim().min(1).max(200);

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

  const parsedId = InvitationId.safeParse(getRouterParam(event, 'id'));
  if (!parsedId.success) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_INVITATION_ID',
      'Invitation ID is invalid.',
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
    await workflow.store.revokeInvitation({
      spaceId: selected.space.id,
      invitationId: parsedId.data,
      auth,
      requestId,
      correlationId: requestId,
    });
    return okEnvelope({ invitationId: parsedId.data, revoked: true }, authorization.info, requestId);
  } catch {
    setResponseStatus(event, 409);
    return errorEnvelope(
      'INVITATION_REVOKE_FAILED',
      'Invitation could not be revoked in the selected space.',
      authorization.info,
      false,
      requestId,
    );
  }
});
