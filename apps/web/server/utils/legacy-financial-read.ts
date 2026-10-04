import { createDefaultConnectionManager } from '@balanceframe/application';
import type { LiquidityActor, WorkflowStore } from '@balanceframe/workflow-store';
import { setResponseStatus } from 'h3';
import type { H3Event } from 'h3';
import { errorEnvelope, getActorId, getWorkflowStore, recordReadAdmission } from './workflow-store';
import type { ApiEnvelope, AuthorizationInfo, EventWithContext } from './workflow-store';
import { requireSelectedSpace } from './space-context';

export type LegacyFinancialReadGuard =
  | { ok: true; info: AuthorizationInfo; budgetId: string; spaceId: string; actor: LiquidityActor }
  | { ok: false; response: ApiEnvelope<null> };


/** Whole-budget legacy responses have no safe per-account projection. Observe alone never authorizes them. */
export async function hasLegacyFullRead(
  store: WorkflowStore,
  actor: LiquidityActor,
): Promise<boolean> {
  if (!actor.spaceId || !actor.auth || !actor.governancePolicyVersion) return false;
  const { governance, liquidity } = store;
  const auth = actor.auth;
  const delegation = auth.method === 'api-key' && auth.principalType === 'agent'
    ? governance.listDelegations({ spaceId: actor.spaceId, agentId: actor.actorId }).find((entry) =>
        entry.id === auth.delegationId && entry.version === auth.delegationVersion && !entry.revokedAt)
    : undefined;
  const grantActorId = delegation?.issuerActorId ?? actor.actorId;
  const membershipId = delegation?.issuerMembershipId ?? actor.membershipId;
  const grants = governance.listResourceGrants({ spaceId: actor.spaceId, actorId: grantActorId });
  return ['observe', 'full-read'].every((capability) => {
    if (!liquidity.isAuthorized({ ...actor, capability, phase: 'read', visibility: 'resource',
      resourceKind: 'budget', resourceId: actor.budgetId })) return false;
    const grant = grants.find((entry) => entry.granted && !entry.revokedAt &&
      entry.membershipId === membershipId && entry.budgetId === actor.budgetId &&
      entry.resourceKind === 'budget' && entry.resourceId === actor.budgetId && entry.capability === capability);
    const restrictions = grant?.restrictions;
    if (!grant || restrictions?.aggregateOnly || restrictions?.accountIds || restrictions?.categoryIds) return false;
    const delegated = delegation?.rights.find((right) => right.capability === capability &&
      right.resourceKind === 'budget' && right.resourceId === actor.budgetId)?.restrictions;
    return !delegated?.aggregateOnly && !delegated?.accountIds && !delegated?.categoryIds;
  });
}

/** Derives selected-budget metadata before restoring a connection or reading private financial records. */
export async function requireFullRead(event: EventWithContext): Promise<LegacyFinancialReadGuard> {
  const selected = await requireSelectedSpace(event);
  if (!selected.ok) return selected;
  const workflow = getWorkflowStore(event);
  if ('error' in workflow) {
    setResponseStatus(event as H3Event, 503);
    return { ok: false, response: errorEnvelope('STORE_UNAVAILABLE', 'Financial data is unavailable.', null, true) };
  }
  const budgetId = selected.space.budgetId;
  const policy = workflow.store.governance.getPolicy({ spaceId: selected.space.id });
  const actor: LiquidityActor = {
    actorId: selected.auth.actorId, budgetId: budgetId ?? '', spaceId: selected.space.id,
    membershipId: selected.membership.id, governancePolicyVersion: policy?.version,
    auth: selected.auth, now: new Date().toISOString(),
  };
  if (!budgetId || !(await hasLegacyFullRead(workflow.store, actor))) {
    setResponseStatus(event as H3Event, 403);
    return { ok: false, response: errorEnvelope('FORBIDDEN', 'Full financial read is not authorized.', null) };
  }
  try {
    const manager = createDefaultConnectionManager({ configPath: process.env.BALANCEFRAME_CONFIG_PATH });
    const config = await manager.loadConfig();
    if (config?.budgetId !== budgetId) throw new Error('Selected space connection mismatch');
    await recordReadAdmission(event, workflow.store, {
      actorId: actor.actorId, spaceId: selected.space.id, membershipId: selected.membership.id,
      budgetId, policyVersion: policy!.version, capability: 'full-read', resourceKind: 'budget',
      resourceId: budgetId, operation: 'full-read', phase: 'read', auth: selected.auth,
    });
    return {
      ok: true,
      info: { actorId: actor.actorId, capability: 'full-read', allowed: true },
      budgetId,
      spaceId: selected.space.id,
      actor,
    };
  } catch {
    setResponseStatus(event as H3Event, 503);
    return {
      ok: false,
      response: errorEnvelope(
        'FINANCIAL_READ_UNAVAILABLE',
        'Financial data is unavailable.',
        null,
        true,
      ),
    };
  }
}

/** Server-wide budget discovery crosses budgets and is restricted to the actual active registered owner, including first setup. */
export async function requireRegisteredOwner(
  event: EventWithContext,
): Promise<{ ok: true; info: AuthorizationInfo } | { ok: false; response: ApiEnvelope<null> }> {
  const auth = event.context.auth;
  if (
    auth?.authenticated &&
    ((typeof auth.user?.id === 'string' && auth.user.id.length > 0) ||
      (typeof auth.actorId === 'string' && auth.actorId.length > 0))
  ) {
    try {
      const workflow = getWorkflowStore(event);
      if (!('error' in workflow)) {
        const actorId = getActorId(event);
        const [registration, membership] = await Promise.all([
          workflow.store.getRegistrationState(),
          workflow.store.getActorMembership(actorId),
        ]);
        if (registration.ownerUserId === actorId && membership?.status === 'active')
          return {
            ok: true,
            info: { actorId, capability: 'owner:financial-discovery', allowed: true },
          };
      }
    } catch {
      // The same public denial covers absent or unreadable authorization state.
    }
  }
  setResponseStatus(event as H3Event, 403);
  return {
    ok: false,
    response: errorEnvelope('FORBIDDEN', 'Budget discovery is not authorized.', null),
  };
}
