import { readBody, defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { auth } from '../../../lib/auth';
import { getWorkflowStore, okEnvelope } from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';
import { invitationError, normalizeEmail } from '../../utils/registration';
import {
  authenticateInvitationHuman,
  hasTrustedRequestOrigin,
} from '../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../utils/reauthentication';

const RedemptionBody = z.object({
  token: z.string().trim().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).transform(normalizeEmail),
  password: z.string().min(8).max(128),
}).strict();

const failureMessage = 'Invitation could not be redeemed.';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'cache-control', 'no-store');

  if (!hasTrustedRequestOrigin(event as unknown as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return invitationError(failureMessage, requestId, 'origin.untrusted');
  }

  const body = RedemptionBody.safeParse(await readBody<unknown>(event).catch(() => null));
  if (!body.success) {
    setResponseStatus(event, 400);
    return invitationError(failureMessage, requestId, 'validation.invalid');
  }

  const currentAuth = (event as unknown as EventWithContext).context.auth;
  const priorActorId = currentAuth?.authenticated
    ? currentAuth.actorId ?? (typeof currentAuth.user?.id === 'string' ? currentAuth.user.id : undefined)
    : undefined;
  const priorEmail = currentAuth?.authenticated && typeof currentAuth.user?.email === 'string'
    ? normalizeEmail(currentAuth.user.email)
    : undefined;

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return invitationError(failureMessage, requestId, 'store.unavailable');
  }

  let claim: Awaited<ReturnType<typeof workflow.store.claimInvitation>>;
  try {
    claim = await workflow.store.claimInvitation({
      token: body.data.token,
      email: body.data.email,
      requestId,
      correlationId: requestId,
    });
  } catch {
    setResponseStatus(event, 400);
    return invitationError(failureMessage, requestId, 'invitation.invalid');
  }
  if (currentAuth?.authenticated &&
      (currentAuth.method !== 'session' || currentAuth.principalType !== 'human' || currentAuth.impersonatedBy)) {
    setResponseStatus(event, 400);
    return invitationError(failureMessage, requestId, 'identity.mismatch');
  }
  if (priorActorId && priorEmail !== claim.email) {
    setResponseStatus(event, 400);
    return invitationError(failureMessage, requestId, 'identity.mismatch');
  }

  let identity = await authenticateInvitationHuman(
    event as unknown as ReauthenticationEvent,
    claim.email,
    body.data.password,
  );
  if (identity && (identity.email !== claim.email || (priorActorId && identity.auth.actorId !== priorActorId))) {
    setResponseStatus(event, 400);
    return invitationError(failureMessage, requestId, 'identity.mismatch');
  }

  if (!identity) {
    if (priorActorId) {
      setResponseStatus(event, 400);
      return invitationError(failureMessage, requestId, 'identity.mismatch');
    }

    try {
      const created = await auth.api.createUser({
        body: {
          name: body.data.name,
          email: claim.email,
          password: body.data.password,
        },
      });
      const user = created.user;
      if (!user || typeof user.id !== 'string' || !user.id ||
          (typeof user.email === 'string' && normalizeEmail(user.email) !== claim.email)) {
        throw new Error('Invitation account creation returned an invalid identity');
      }

      identity = await authenticateInvitationHuman(
        event as unknown as ReauthenticationEvent,
        claim.email,
        body.data.password,
      );
      if (!identity || identity.email !== claim.email || identity.auth.actorId !== user.id) {
        throw new Error('Invitation account could not establish its verified session');
      }
    } catch {
      setResponseStatus(event, 400);
      return invitationError(failureMessage, requestId, 'identity.invalid');
    }
  }
  if (!identity) {
    setResponseStatus(event, 400);
    return invitationError(failureMessage, requestId, 'identity.invalid');
  }

  try {
    await workflow.store.completeInvitationRedemption(claim.claimId, identity.auth.actorId, {
      auth: identity.auth,
      email: claim.email,
      requestId,
    });
  } catch {
    setResponseStatus(event, 400);
    return invitationError(failureMessage, requestId, 'invitation.invalid');
  }

  return okEnvelope({ redeemed: true, spaceId: claim.spaceId }, null, requestId);
});
