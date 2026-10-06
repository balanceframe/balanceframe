import type { MerchantActor, MerchantIntelligenceService } from '@balanceframe/application';
import type { WorkflowStore } from '@balanceframe/workflow-store';
import type { H3Event } from 'h3';
import type { ReauthenticationEvent } from './reauthentication';
import type { AuthorizationInfo, EventWithContext } from './workflow-store';
import { createDefaultConnectionManager, createMerchantIntelligenceService } from '@balanceframe/application';
import { defineEventHandler, getQuery, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { requireSelectedSpace } from './space-context';
import { selectedLiquidityActor } from './liquidity-service';
import { getHumanControlAuth, hasTrustedRequestOrigin } from './reauthentication';
import { errorEnvelope, getWorkflowStore, okEnvelope, requireAuthorization } from './workflow-store';

const queryId = z.string().min(1).max(512);
/** Query fields select evidence; none confer source or management authority. */
export const merchantAnalyzeQuery = z.object({ transactionId: queryId.optional(), cursor: queryId.optional(), limit: z.coerce.number().int().min(1).max(1000).optional(), factsHash: queryId.optional() }).strict();
/** Calendar reads resolve only the account's stored explicit selection. */
export const merchantCalendarQuery = z.object({ accountId: queryId, year: z.coerce.number().int().min(1).max(9999) }).strict();

/** Optional Review integration requires a live exact merchant grant, not ambient ownership. */
export function merchantAnalysisAuthorized(store: WorkflowStore, actor: MerchantActor): boolean {
  const auth = actor.auth;
  const result = store.governance.authorize({
    actorId: actor.actorId, spaceId: actor.spaceId, membershipId: actor.membershipId,
    expectedPolicyVersion: actor.governancePolicyVersion, phase: 'read', operation: 'merchant:analyze',
    required: [
      { resourceKind: 'budget', resourceId: actor.budgetId, capability: 'observe', visibility: 'resource' },
      { resourceKind: 'budget', resourceId: actor.budgetId, capability: 'merchant:analyze', visibility: 'resource' },
    ], payload: { operations: [] }, now: new Date().toISOString(), auth,
    ...(auth.method === 'api-key' && auth.principalType === 'agent' ? { agentId: auth.actorId, delegationId: auth.delegationId, delegationVersion: auth.delegationVersion } : {}),
  });
  return result.allowed && result.disposition.kind === 'authorized_without_approval';
}

/** Reuse selected-space admission and human proof; the service rechecks the complete operation. */
export function merchantRoute<T>(
  operation: (event: H3Event, service: MerchantIntelligenceService, actor: MerchantActor) => Promise<T>,
  options: { capability?: string; human?: boolean; query?: boolean; spaceControl?: boolean; origin?: boolean } = {},
) {
  return defineEventHandler(async (event) => {
    setHeader(event, 'Cache-Control', 'private, no-store');
    const requestId = crypto.randomUUID();
    let authInfo: AuthorizationInfo | null = null;
    try {
      if (options.origin && (!event.node.req.headers.origin || !hasTrustedRequestOrigin(event as ReauthenticationEvent))) {
        setResponseStatus(event, 403);
        return errorEnvelope('FORBIDDEN', 'Merchant control requires a trusted request origin.', null, false, requestId);
      }
      const selected = await requireSelectedSpace(event as unknown as EventWithContext);
      if (!selected.ok) return selected.response;
      if (!selected.space.budgetId) {
        setResponseStatus(event, 409);
        return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
      }
      const capability = options.capability ?? 'merchant:analyze';
      const authorization = await requireAuthorization(event as unknown as EventWithContext, capability,
        options.spaceControl ? `space:${selected.space.id}` : `budget:${selected.space.budgetId}`);
      if (!authorization.ok) return authorization.response;
      authInfo = authorization.info;
      const workflow = getWorkflowStore(event as unknown as EventWithContext);
      if ('error' in workflow) {
        setResponseStatus(event, 503);
        return errorEnvelope('STORE_UNAVAILABLE', 'Merchant evidence is unavailable.', authInfo, true, requestId);
      }
      const actor = selectedLiquidityActor(workflow.store, selected);
      if (!actor?.auth || !actor.spaceId) {
        setResponseStatus(event, 403);
        return errorEnvelope('FORBIDDEN', 'Merchant evidence is unavailable.', authInfo, false, requestId);
      }
      let trusted: MerchantActor = { ...actor, auth: actor.auth, spaceId: actor.spaceId };
      if (options.human) {
        const proof = hasTrustedRequestOrigin(event as ReauthenticationEvent) ? await getHumanControlAuth(event as ReauthenticationEvent) : null;
        if (!proof || proof.actorId !== actor.actorId || selected.auth.method !== 'session' || proof.sessionId !== selected.auth.sessionId) {
          setResponseStatus(event, 403);
          return errorEnvelope('REAUTHENTICATION_REQUIRED', 'Confirm your current human session before merchant control.', authInfo, false, requestId);
        }
        trusted = { ...trusted, auth: { ...selected.auth, ...proof } };
      }
      if (!options.query) z.object({}).strict().parse(getQuery(event));
      const connectionManager = createDefaultConnectionManager({ configPath: process.env.BALANCEFRAME_CONFIG_PATH });
      const service = await createMerchantIntelligenceService({ store: workflow.store, connectionManager });
      const result = await operation(event, service, trusted);
      return okEnvelope(result, authInfo, requestId);
    } catch (error) {
      // No raw connector/provider errors or merchant queries enter responses or logs.
      const invalid = error instanceof z.ZodError;
      setResponseStatus(event, invalid ? 400 : authInfo ? 409 : 503);
      return errorEnvelope(invalid ? 'INVALID_MERCHANT_REQUEST' : 'MERCHANT_OPERATION_UNAVAILABLE', invalid ? 'Provide a valid merchant request.' : 'Merchant evidence or authorization changed. Refresh before retrying.', authInfo, false, requestId);
    }
  });
}
