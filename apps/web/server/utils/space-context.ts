import { getCookie, getHeader, setResponseStatus } from 'h3';
import type { H3Event } from 'h3';
import type { OperationalAuth, Space, SpaceMembership } from '@balanceframe/workflow-store';
import type { ApiEnvelope, EventWithContext } from './workflow-store';
import { errorEnvelope, getActorId, getWorkflowStore } from './workflow-store';

export type SelectedSpaceResult =
  | { readonly ok: true; readonly space: Space; readonly membership: SpaceMembership; readonly auth: OperationalAuth }
  | { readonly ok: false; readonly response: ApiEnvelope<null> };

/** Resolves only explicit selection using current, server-verified membership or delegation. */
export async function requireSelectedSpace(event: EventWithContext): Promise<SelectedSpaceResult> {
  const request = event as unknown as H3Event;
  const deny = (code = 'FORBIDDEN', status = 403): SelectedSpaceResult => {
    setResponseStatus(request, status);
    return { ok: false, response: errorEnvelope(code, 'The selected space is unavailable', null) };
  };
  const identity = event.context.auth;
  const actorId = getActorId(event);
  if (!identity?.authenticated || actorId === 'anonymous' || identity.impersonatedBy)
    return deny('AUTHORIZATION_REQUIRED', 401);
  const header = getHeader(request, 'x-balanceframe-space');
  const spaceId = header !== undefined ? header.trim() : getCookie(request, 'balanceframe_space');
  if (!spaceId) return deny('SPACE_SELECTION_REQUIRED', 400);
  const wf = getWorkflowStore(event);
  if ('error' in wf) return deny('STORE_UNAVAILABLE', 503);
  try {
    const governance = wf.store.governance;
    const space = governance.getSpace({ spaceId });
    if (!space) return deny();
    const now = new Date().toISOString();
    let auth: OperationalAuth;
    let membershipActorId = actorId;
    let issuerMembershipId: string | undefined;
    if (identity.method === 'session' && identity.principalType !== 'agent' && identity.sessionId) {
      auth = { method: 'session', actorId, sessionId: identity.sessionId };
    } else if (identity.method === 'api-key' && identity.credentialId && identity.credentialOwnerId) {
      const principal = governance.resolveCredentialPrincipal({
        credentialId: identity.credentialId,
        referenceId: identity.credentialOwnerId,
        spaceId,
        now,
      });
      if (!principal || principal.actorId !== actorId || principal.principalType !== identity.principalType)
        return deny();
      auth = { method: 'api-key', ...principal };
      if (principal.principalType === 'agent') {
        if (identity.delegationId !== principal.delegationId || identity.delegationVersion !== principal.delegationVersion)
          return deny();
        const delegation = governance.listDelegations({ spaceId, agentId: actorId }).find((item) =>
          item.id === principal.delegationId && item.version === principal.delegationVersion && item.revokedAt === null);
        if (!delegation) return deny();
        membershipActorId = delegation.issuerActorId;
        issuerMembershipId = delegation.issuerMembershipId;
      }
    } else {
      return deny('AUTHORIZATION_REQUIRED', 401);
    }
    const membership = governance.getCurrentMembership({ spaceId, actorId: membershipActorId, now });
    if (!membership || (issuerMembershipId !== undefined && membership.id !== issuerMembershipId)) return deny();
    return { ok: true, space, membership, auth };
  } catch {
    return deny('AUTHORIZATION_CHECK_FAILED', 503);
  }
}
