import { createDefaultConnectionManager } from '@balanceframe/application';
import type { WorkflowStore } from '@balanceframe/workflow-store';
import { setResponseStatus } from 'h3';
import type { H3Event } from 'h3';
import { errorEnvelope, getActorId, getWorkflowStore } from './workflow-store';
import type { ApiEnvelope, AuthorizationInfo, EventWithContext } from './workflow-store';

export type LegacyFinancialReadGuard =
  | { ok: true; info: AuthorizationInfo; budgetId: string }
  | { ok: false; response: ApiEnvelope<null> };

/** Whole-budget legacy responses have no safe per-account projection. Observe alone never authorizes them. */
export async function hasLegacyFullRead(
  store: WorkflowStore,
  actorId: string,
  budgetId: string,
): Promise<boolean> {
  if (store.liquidity.isOwner({ actorId, budgetId })) return true;
  const observe = await store.evaluateAuthorization(
    actorId,
    'observe',
    `budget:${budgetId}`,
    '1.0',
  );
  return (
    observe.allowed &&
    store.liquidity.isAuthorized({
      actorId,
      budgetId,
      capability: 'full-read',
      resourceKind: 'budget',
      resourceId: budgetId,
    })
  );
}

/** Derives selected-budget metadata before restoring a connection or reading private financial records. */
export async function requireFullRead(event: EventWithContext): Promise<LegacyFinancialReadGuard> {
  const auth = event.context.auth;
  if (
    !auth?.authenticated ||
    !(
      (typeof auth.user?.id === 'string' && auth.user.id.length > 0) ||
      (typeof auth.actorId === 'string' && auth.actorId.length > 0)
    )
  ) {
    setResponseStatus(event as H3Event, 403);
    return {
      ok: false,
      response: errorEnvelope('FORBIDDEN', 'Full financial read is not authorized.', null),
    };
  }
  try {
    const workflow = getWorkflowStore(event);
    if ('error' in workflow) throw new Error('Workflow unavailable');
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const config = await manager.loadConfig();
    if (!config?.budgetId) throw new Error('Selected budget unavailable');
    const actorId = getActorId(event);
    if (!(await hasLegacyFullRead(workflow.store, actorId, config.budgetId))) {
      setResponseStatus(event as H3Event, 403);
      return {
        ok: false,
        response: errorEnvelope('FORBIDDEN', 'Full financial read is not authorized.', null),
      };
    }
    return {
      ok: true,
      info: { actorId, capability: 'liquidity:full-read', allowed: true },
      budgetId: config.budgetId,
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
