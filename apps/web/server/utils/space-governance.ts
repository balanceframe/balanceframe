import { defineEventHandler, getRouterParam, readBody, setCookie, setHeader, setResponseStatus } from 'h3';
import type { H3Event } from 'h3';
import { z } from 'zod';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { getActorId, getWorkflowStore, errorEnvelope, okEnvelope, requireAuthorization, recordReadAdmission } from './workflow-store';
import type { AuthorizationInfo, EventWithContext } from './workflow-store';
import { getHumanControlAuth, type HumanControlAuth, type ReauthenticationEvent } from './reauthentication';
import { requireSelectedSpace } from './space-context';
import type { SelectedSpaceResult } from './space-context';
const SpaceKind = z.enum(['personal', 'shared']);
const ResourceKind = z.enum([
  'space', 'budget', 'account', 'category', 'transaction', 'rule', 'evidence', 'wallet', 'receipt',
  'commitment', 'scenario', 'reservation', 'purchase', 'transfer', 'ledger_effect', 'session', 'proposal',
]);
const ResourceId = z.string().min(1).max(256).refine((value) => value !== '*', 'Exact resources only');
const Capability = z.string().min(1).max(128).refine((value) => value !== '*', 'Exact capabilities only');
const IsoTime = z.string().datetime({ offset: true });
const Restrictions = z.object({
  aggregateOnly: z.boolean().optional(),
  accountIds: z.array(ResourceId).optional(),
  categoryIds: z.array(ResourceId).optional(),
  operations: z.array(z.string().min(1).max(128)).optional(),
  proposalOnly: z.boolean().optional(),
  maxGrossOutgoing: z.array(z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    minorUnits: z.string().regex(/^\d+$/),
  }).strict()).optional(),
  maxOperationCount: z.number().int().nonnegative().optional(),
}).strict();

interface RouteContext {
  readonly event: H3Event;
  readonly selected: Extract<SelectedSpaceResult, { ok: true }>;
  readonly authorization: AuthorizationInfo | null;
  readonly proof: HumanControlAuth | null;
  readonly now: string;
  readonly store: SqliteWorkflowStore;
}

interface RouteOptions {
  readonly capability?: string;
  readonly freshProof?: boolean;
}
/** Creates a private, no-store route scoped to current selected-space membership and explicit control grants. */
export function spaceGovernanceRoute(
  options: RouteOptions,
  handler: (context: RouteContext) => unknown | Promise<unknown>,
) {
  return defineEventHandler(async (event) => {
    setHeader(event, 'Cache-Control', 'private, no-store');
    const eventContext = event as unknown as EventWithContext;
    const requestId = typeof eventContext.context.requestId === 'string' ? eventContext.context.requestId : crypto.randomUUID();
    eventContext.context.requestId = requestId;
    setHeader(event, 'X-BalanceFrame-Request-ID', requestId);
    const selected = await requireSelectedSpace(eventContext);
    if (!selected.ok) return selected.response;
    if (getRouterParam(event, 'id') !== selected.space.id) {
      setResponseStatus(event, 403);
      return errorEnvelope('FORBIDDEN', 'The selected space is unavailable.', null);
    }

    let authorization: AuthorizationInfo | null = null;
    if (options.capability) {
      const access = await requireAuthorization(eventContext, options.capability);
      if (!access.ok) return access.response;
      authorization = access.info;
    }

    let proof: HumanControlAuth | null = null;
    if (options.freshProof) {
      proof = await getHumanControlAuth(event as ReauthenticationEvent);
      if (!proof || selected.auth.method !== 'session' || proof.actorId !== selected.auth.actorId) {
        setResponseStatus(event, 403);
        return errorEnvelope(
          proof ? 'FORBIDDEN' : 'REAUTHENTICATION_REQUIRED',
          'A recently reauthenticated human session is required.',
          authorization,
        );
      }
    }

    const workflow = getWorkflowStore(eventContext);
    if ('error' in workflow) {
      setResponseStatus(event, 503);
      return errorEnvelope('STORE_UNAVAILABLE', 'Governance storage is unavailable.', authorization, true);
    }
    const context: RouteContext = {
      event,
      selected,
      authorization,
      proof,
      now: new Date().toISOString(),
      store: workflow.store,
    };
    try {
      if (!options.capability) {
        await recordReadAdmission(eventContext, workflow.store, {
          actorId: selected.auth.actorId, spaceId: selected.space.id,
          membershipId: selected.membership.id, budgetId: selected.space.budgetId,
          policyVersion: workflow.store.governance.getPolicy({ spaceId: selected.space.id })?.version ?? null,
          resourceKind: 'space', resourceId: selected.space.id, operation: 'space.read', phase: 'read',
          auth: selected.auth,
        });
      }
      return okEnvelope(await handler(context), authorization, requestId);
    } catch (error) {
      const versionConflict = error instanceof Error && /version conflict/i.test(error.message);
      const policyConflict = versionConflict && options.capability === 'policy:manage';
      const forbidden = error instanceof Error && /authorization denied/i.test(error.message);
      const invalid = error instanceof z.ZodError ||
        (error instanceof Error && /invalid|overlap|required|unavailable|mismatch/i.test(error.message));
      const status = versionConflict ? 409 : forbidden ? 403 : invalid ? 400 : 503;
      setResponseStatus(event, status);
      return errorEnvelope(
        policyConflict ? 'POLICY_VERSION_CONFLICT' : versionConflict ? 'VERSION_CONFLICT' :
          forbidden ? 'FORBIDDEN' : invalid ? 'INVALID_GOVERNANCE_REQUEST' : 'GOVERNANCE_UNAVAILABLE',
        versionConflict ? 'The governance version changed. Reload the current state and retry.' :
          forbidden ? 'The selected governance operation is not authorized.' :
            invalid ? 'The governance request is invalid or unavailable.' : 'Governance is temporarily unavailable.',
        authorization,
        status === 503,
      );
    }
  });
}

/** Creates a private no-store handler for an authenticated human API not bound to a selected space. */
export function humanGovernanceRoute(
  freshProof: boolean,
  handler: (context: { readonly event: H3Event; readonly actorId: string; readonly proof: HumanControlAuth | null; readonly now: string }) => unknown | Promise<unknown>,
) {
  return defineEventHandler(async (event) => {
    setHeader(event, 'Cache-Control', 'private, no-store');
    const eventContext = event as unknown as EventWithContext;
    const requestId = typeof eventContext.context.requestId === 'string' ? eventContext.context.requestId : crypto.randomUUID();
    eventContext.context.requestId = requestId;
    setHeader(event, 'X-BalanceFrame-Request-ID', requestId);
    const identity = eventContext.context.auth;
    const actorId = getActorId(eventContext);
    const isSessionHuman =
      identity?.authenticated && identity.method === 'session' && identity.principalType === 'human' &&
      identity.user?.id === actorId;
    if (!isSessionHuman || actorId === 'anonymous' || identity?.impersonatedBy) {
      setResponseStatus(event, 401);
      return errorEnvelope('AUTHORIZATION_REQUIRED', 'An independently authenticated human session is required.', null);
    }
    let proof: HumanControlAuth | null = null;
    if (freshProof) {
      proof = await getHumanControlAuth(event as ReauthenticationEvent);
      if (!proof || proof.actorId !== actorId) {
        setResponseStatus(event, 403);
        return errorEnvelope('REAUTHENTICATION_REQUIRED', 'A recently reauthenticated human session is required.', null);
      }
    }
    try {
      return okEnvelope(await handler({ event, actorId, proof, now: new Date().toISOString() }), null, requestId);
    } catch (error) {
      const invalid = error instanceof z.ZodError || (error instanceof Error && /invalid|unavailable|exists|conflict|required/i.test(error.message));
      const conflict = error instanceof Error && /conflict/i.test(error.message);
      setResponseStatus(event, conflict ? 409 : invalid ? 400 : 503);
      return errorEnvelope(
        conflict ? 'GOVERNANCE_CONFLICT' : invalid ? 'INVALID_GOVERNANCE_REQUEST' : 'GOVERNANCE_UNAVAILABLE',
        conflict ? 'The governance state changed. Reload and retry.' :
          invalid ? 'The governance request is invalid or unavailable.' : 'Governance is temporarily unavailable.',
        null,
        !invalid && !conflict,
      );
    }
  });
}

/** Parses a request body against a strict public governance schema. */
export async function readGovernanceBody<T extends z.ZodType>(event: H3Event, schema: T): Promise<z.infer<T>> {
  return schema.parse(await readBody<unknown>(event));
}

/** Sets an explicit selected-space cookie after membership has been verified. */
export function selectSpaceCookie(event: H3Event, spaceId: string): void {
  setCookie(event, 'balanceframe_space', spaceId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 31_536_000,
  });
}

/** Reusable exact-value schemas shared by space-governance route handlers. */
export { Capability, IsoTime, Restrictions, ResourceId, ResourceKind, SpaceKind };
