import {
  createDefaultConnectionManager,
  createLiquidityService,
  LiquidityProjector,
} from '@balanceframe/application';
import type { PublicLiquidityFinding, LiquidityService } from '@balanceframe/application';
import type { Finding, LiquidityActor, WorkflowStore } from '@balanceframe/workflow-store';
import type { EventWithContext } from './workflow-store';
import type { SelectedSpaceResult } from './space-context';
import {
  defineEventHandler,
  getQuery,
  getRouterParam,
  readBody,
  setHeader,
  setResponseStatus,
} from 'h3';
import type { H3Event } from 'h3';
import {
  getWorkflowStore,
  requireAuthorization,
  requireAggregateAuthorization,
  requireProposalAuthorization,
  okEnvelope,
  errorEnvelope,
  sanitizeError,
} from './workflow-store';
import { requireSelectedSpace } from './space-context';
import { getHumanControlAuth, type ReauthenticationEvent } from './reauthentication';
import { reviewAndApplyEnabled } from './workflow-store';

import { hasLegacyFullRead } from './legacy-financial-read';
import { createMutationConnectionManager } from './mutation-executor';
import { z } from 'zod';

export function findingTransitionRoute<T extends z.ZodType>(
  schema: T,
  operation: (
    input: {
      readonly store: WorkflowStore;
      readonly actor: LiquidityActor;
      readonly finding: Finding;
      readonly body: z.infer<T>;
    },
  ) => Promise<Finding>,
  failureCode: string,
) {
  return defineEventHandler(async (event) => {
    setHeader(event, 'Cache-Control', 'private, no-store');
    const requestId = crypto.randomUUID();
    const selected = await requireSelectedSpace(event as unknown as EventWithContext);
    if (!selected.ok) return selected.response;
    if (!selected.space.budgetId) {
      setResponseStatus(event, 409);
      return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget', null, false, requestId);
    }
    const authorization = await requireAuthorization(
      event as unknown as EventWithContext,
      'finding:transition',
      `budget:${selected.space.budgetId}`,
    );
    if (!authorization.ok) return authorization.response;
    const findingId = z.string().trim().min(1).max(200).safeParse(getRouterParam(event, 'id'));
    const body = schema.safeParse(await readBody<unknown>(event).catch(() => null));
    if (!findingId.success || !body.success) {
      setResponseStatus(event, 400);
      return errorEnvelope('INVALID_FINDING_REQUEST', 'Provide a valid finding ID and transition body.', authorization.info, false, requestId);
    }
    const workflow = getWorkflowStore(event as unknown as EventWithContext);
    if ('error' in workflow) {
      setResponseStatus(event, 503);
      return errorEnvelope('STORE_UNAVAILABLE', workflow.error, authorization.info, true, requestId);
    }
    try {
      const actor = selectedLiquidityActor(workflow.store, selected);
      if (!actor) {
        setResponseStatus(event, 403);
        return errorEnvelope('FORBIDDEN', 'The selected space is unavailable.', authorization.info, false, requestId);
      }
      const current = await findFindingInBudget(
        workflow.store,
        selected.space.budgetId,
        findingId.data,
      );
      if (!current || !projectFinancialFinding(workflow.store, actor, current)) {
        setResponseStatus(event, 404);
        return errorEnvelope('FINDING_NOT_FOUND', 'Finding not found.', authorization.info, false, requestId);
      }
      const updated = await operation({
        store: workflow.store,
        actor,
        finding: current,
        body: body.data,
      });
      if (updated.budgetId !== selected.space.budgetId) {
        setResponseStatus(event, 409);
        return errorEnvelope('SPACE_SCOPE_CHANGED', 'The selected finding changed scope.', authorization.info, false, requestId);
      }
      const projected = projectFinancialFinding(workflow.store, actor, updated);
      if (!projected) {
        setResponseStatus(event, 404);
        return errorEnvelope('FINDING_NOT_FOUND', 'Finding not found.', authorization.info, false, requestId);
      }
      return okEnvelope(projected, authorization.info, requestId);
    } catch (error) {
      const safe = sanitizeError(error, requestId, failureCode, false);
      setResponseStatus(event, 409);
      return errorEnvelope(safe.code, safe.message, authorization.info, false, requestId);
    }
  });
}

export interface LiquidityRouteOptions {
  capability?: string;
  purchaseQuery?: boolean;
  mutation?: boolean;
  humanControl?: boolean;
  aggregate?: boolean;
  proposalOperation?: 'transfer' | 'reallocation' | 'session_completion';
}
/** Build a projection actor from the request's live selected-space authority. */
export function selectedLiquidityActor(
  store: WorkflowStore,
  selected: Extract<SelectedSpaceResult, { readonly ok: true }>,
): LiquidityActor | null {
  const budgetId = selected.space.budgetId;
  const policy = store.governance.getPolicy({ spaceId: selected.space.id });
  if (!budgetId || !policy) return null;
  return {
    actorId: selected.auth.actorId,
    budgetId,
    spaceId: selected.space.id,
    membershipId: selected.membership.id,
    auth: selected.auth,
    governancePolicyVersion: policy.version,
    now: new Date().toISOString(),
  };
}

/** Resolve a finding only from rows already constrained to the selected budget. */
export async function findFindingInBudget(
  store: WorkflowStore,
  budgetId: string,
  findingId: string,
): Promise<Finding | null> {
  for (let offset = 0; ; offset += 500) {
    const findings = await store.listFindings({ budgetId, limit: 500, offset });
    const found = findings.find((finding) => finding.id === findingId);
    if (found) return found;
    if (findings.length < 500) return null;
  }
}

/** Return only the exact grant-filtered fields approved by the liquidity projector. */
export function projectFinancialFinding(
  store: WorkflowStore,
  actor: LiquidityActor,
  finding: Finding,
): PublicLiquidityFinding | null {
  return LiquidityProjector.projectFinding(store, actor, finding);
}

/** Linked financial evidence uses the current actor projection; legacy totals require exact full-read. */
export async function canReadFinancialFinding(
  store: WorkflowStore,
  actor: LiquidityActor,
  finding: Finding,
): Promise<boolean> {
  if (
    finding.classification === 'transfer_needs_attention' &&
    Object.prototype.hasOwnProperty.call(finding.evidence, 'transferId')
  )
    return projectFinancialFinding(store, actor, finding) !== null;
  return hasLegacyFullRead(store, actor);
}

/** Resolve linked findings only from the selected budget's current scoped list. */
export async function canReadFinancialNotification(
  store: WorkflowStore,
  actor: LiquidityActor,
  notification: { classification: string; correlationId?: string | null; budgetId: string },
): Promise<boolean> {
  if (notification.budgetId !== actor.budgetId) return false;
  if (notification.classification !== 'transfer_needs_attention')
    return hasLegacyFullRead(store, actor);
  const prefix = 'liquidity-finding:';
  const correlationId = notification.correlationId;
  if (!correlationId?.startsWith(prefix)) return hasLegacyFullRead(store, actor);
  const finding = await findFindingInBudget(
    store,
    actor.budgetId,
    correlationId.slice(prefix.length),
  );
  return !!finding && projectFinancialFinding(store, actor, finding) !== null;
}

/** Resolves space and permissions before loading config or restoring its private Actual budget. */
export function liquidityRoute<T>(
  operation: (event: H3Event, service: LiquidityService, actor: LiquidityActor) => Promise<T>,
  options: LiquidityRouteOptions = {},
) {
  const {
    capability = 'observe',
    purchaseQuery = false,
    mutation = false,
    humanControl = false,
    aggregate = false,
    proposalOperation,
  } = options;
  return defineEventHandler(async (event) => {
    if (!event.context.auth?.authenticated) {
      setResponseStatus(event, 403);
      return errorEnvelope('AUTHORIZATION_REQUIRED', 'Authentication is required.', null);
    }
    const requestId = crypto.randomUUID();
    let authInfo: Parameters<typeof errorEnvelope>[2] = null;
    try {
      if (!purchaseQuery && Object.keys(getQuery(event)).length) throw new Error('Invalid input');
      const selected = await requireSelectedSpace(event as unknown as EventWithContext);
      if (!selected.ok) return selected.response;
      const { space, membership } = selected;
      if (!space.budgetId) {
        setResponseStatus(event, 409);
        return errorEnvelope(
          'SPACE_BUDGET_REQUIRED',
          'Connect a budget to this space before accessing liquidity.',
          null,
          false,
          requestId,
        );
      }
      const scope = capability === 'grant:manage' || capability === 'policy:manage'
        ? `space:${space.id}`
        : `budget:${space.budgetId}`;
      const auth = proposalOperation
        ? await requireProposalAuthorization(
            event as unknown as EventWithContext, capability, scope, proposalOperation,
          )
        : await (aggregate ? requireAggregateAuthorization : requireAuthorization)(
            event as unknown as EventWithContext, capability, scope,
          );
      if (!auth.ok) return auth.response;
      authInfo = auth.info;
      const controlAuth = humanControl
        ? await getHumanControlAuth(event as ReauthenticationEvent)
        : null;
      if (humanControl && !controlAuth) {
        setResponseStatus(event, 403);
        return errorEnvelope(
          'REAUTHENTICATION_REQUIRED',
          'A recently reauthenticated human session is required.',
          authInfo,
          false,
          requestId,
        );
      }
      if (mutation && !reviewAndApplyEnabled(event as unknown as EventWithContext)) {
        setResponseStatus(event, 403);
        return errorEnvelope(
          'MUTATION_MODE_DISABLED',
          'Ledger writes require review-and-apply mode.',
          authInfo,
          false,
          requestId,
        );
      }
      const workflow = getWorkflowStore(event as unknown as EventWithContext);
      if ('error' in workflow) {
        setResponseStatus(event, 503);
        return errorEnvelope('STORE_UNAVAILABLE', 'Workflow store unavailable.', authInfo, true, requestId);
      }
      const governancePolicy = workflow.store.governance.getPolicy({ spaceId: space.id });
      if (!governancePolicy) {
        setResponseStatus(event, 403);
        return errorEnvelope(
          'AUTHORIZATION_REQUIRED',
          'Current space policy is unavailable.',
          authInfo,
          false,
          requestId,
        );
      }
      const connectionManager = createDefaultConnectionManager({
        configPath: process.env.BALANCEFRAME_CONFIG_PATH,
      });
      const config = await connectionManager.loadConfig();
      if (!config || config.budgetId !== space.budgetId) {
        setResponseStatus(event, 409);
        return errorEnvelope(
          'SPACE_CONNECTION_MISMATCH',
          'The configured budget does not match the selected space.',
          authInfo,
          false,
          requestId,
        );
      }
      const service = await createLiquidityService({
        connectionManager,
        store: workflow.store,
        ...(mutation
          ? {
              mutationConnectionManager: createMutationConnectionManager({
                configPath: process.env.BALANCEFRAME_CONFIG_PATH,
              }),
            }
          : {}),
      });
      const actor: LiquidityActor = {
        actorId: selected.auth.actorId,
        budgetId: space.budgetId,
        spaceId: space.id,
        membershipId: membership.id,
        auth: controlAuth ?? selected.auth,
        governancePolicyVersion: governancePolicy.version,
        now: new Date().toISOString(),
      };
      return okEnvelope(
        await operation(event, service, actor),
        auth.info,
        requestId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const invalid =
        (error instanceof Error && error.name === 'ZodError') ||
        /Invalid input|Invalid expiry|Duplicate|Amount must/.test(message);
      const denied = /authoriz|membership/i.test(message);
      const conflict =
        /conflict|changed|hash|replay|supersed|expir|insufficient|precondition|unavailable|match account ledger|evidence/i.test(
          message,
        );
      setResponseStatus(event, invalid ? 400 : denied ? 403 : conflict ? 409 : 503);
      return errorEnvelope(
        invalid
          ? 'INVALID_LIQUIDITY_INPUT'
          : denied
            ? 'LIQUIDITY_DENIED'
            : conflict
              ? 'LIQUIDITY_REFRESH_REQUIRED'
              : 'LIQUIDITY_UNAVAILABLE',
        invalid
          ? 'Provide valid liquidity intent fields and a future expiry.'
          : denied
            ? 'This action or resource is not authorized.'
            : conflict
              ? 'The current state, authorization or evidence changed. Refresh and review the plan; reconfirm current ledger observations when needed.'
              : 'Liquidity evaluation is unavailable. Check the connection and required evidence.',
        authInfo,
        !invalid && !denied,
        requestId,
      );
    }
  });
}
