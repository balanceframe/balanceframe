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
    const invitations = await workflow.store.listInvitations({
      spaceId: selected.space.id,
      auth,
      requestId,
    });
    const items = invitations.map((invitation) => ({
      id: invitation.id,
      status: invitation.status,
      spaceId: invitation.spaceId,
      expiresAt: invitation.expiresAt,
      claimedEmail: invitation.claimedEmail,
      redeemedUserId: invitation.redeemedUserId,
      createdAt: invitation.createdAt,
      claimedAt: invitation.claimedAt,
      redeemedAt: invitation.redeemedAt,
    }));
    return okEnvelope({ items, count: items.length }, authorization.info, requestId);
  } catch {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'INVITATION_LIST_FAILED',
      'Invitations could not be loaded.',
      authorization.info,
      false,
      requestId,
    );
  }
});
