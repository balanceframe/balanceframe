import { getCookie, getHeader } from 'h3';
import { getWorkflowStore, recordReadAdmission } from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';
import { humanGovernanceRoute } from '../../utils/space-governance';

/** Lists only spaces with a current membership for the canonical human session. */
export default humanGovernanceRoute(false, async ({ event, actorId, now }) => {
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) throw new Error('Governance storage failure');
  const spaces = workflow.store.governance.listSpacesForActor({ actorId, now });
  const context = event as unknown as EventWithContext;
  const sessionId = context.context.auth?.sessionId;
  if (!sessionId) throw new Error('Human session unavailable');
  for (const space of spaces) {
    const membership = workflow.store.governance.getCurrentMembership({ spaceId: space.id, actorId, now });
    if (!membership) throw new Error('Current membership unavailable');
    await recordReadAdmission(context, workflow.store, {
      actorId, spaceId: space.id, membershipId: membership.id, budgetId: space.budgetId,
      policyVersion: workflow.store.governance.getPolicy({ spaceId: space.id })?.version ?? null,
      resourceKind: 'space', resourceId: space.id, operation: 'spaces.list', phase: 'read',
      auth: { method: 'session', actorId, sessionId },
    });
  }
  if (spaces.length === 0) {
    await workflow.store.appendAuditRecord({
      classification: 'authorization_check', actorId, operation: 'spaces.list',
      requestId: context.context.requestId as string, correlationId: context.context.requestId as string,
      authorizationDisposition: { kind: 'authorized_without_approval' },
      result: JSON.stringify({ kind: 'membership_discovery_admission', spaces: [] }),
    });
  }
  const header = getHeader(event, 'x-balanceframe-space');
  const requested = header !== undefined ? header.trim() : getCookie(event, 'balanceframe_space');
  const selectedSpaceId = requested && spaces.some((space) => space.id === requested) ? requested : null;
  return {
    spaces: spaces.map(({ id, name, kind }) => ({ id, name, kind })),
    selectedSpaceId,
  };
});
