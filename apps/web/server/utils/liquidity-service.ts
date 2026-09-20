import {
  createDefaultConnectionManager,
  createLiquidityService,
  LiquidityProjector,
} from '@balanceframe/application';
import type { LiquidityService } from '@balanceframe/application';
import type { Finding, LiquidityActor, WorkflowStore } from '@balanceframe/workflow-store';
import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import type { H3Event } from 'h3';
import {
  getActorId,
  getWorkflowStore,
  requireAuthorization,
  okEnvelope,
  errorEnvelope,
} from './workflow-store';

import { hasLegacyFullRead } from './legacy-financial-read';

/** Linked financial evidence uses source/audit grants; other whole-budget findings require full-read. */
export async function canReadFinancialFinding(
  store: WorkflowStore,
  actorId: string,
  finding: Finding,
): Promise<boolean> {
  if (
    finding.classification === 'transfer_needs_attention' &&
    typeof finding.evidence.transferId === 'string'
  )
    return LiquidityProjector.canReadFinding(store, actorId, finding);
  return hasLegacyFullRead(store, actorId, finding.budgetId);
}

/** Durable notification references retain the same current resource check as their underlying finding. */
export async function canReadFinancialNotification(
  store: WorkflowStore,
  actorId: string,
  notification: { classification: string; correlationId?: string | null; budgetId: string },
): Promise<boolean> {
  if (notification.classification !== 'transfer_needs_attention') return true;
  if (!notification.correlationId?.startsWith('liquidity-finding:'))
    return hasLegacyFullRead(store, actorId, notification.budgetId);
  const finding = await store.getFinding(
    notification.correlationId.slice('liquidity-finding:'.length),
  );
  return (
    !!finding &&
    finding.budgetId === notification.budgetId &&
    LiquidityProjector.canReadFinding(store, actorId, finding)
  );
}
/** Authentication and public error boundary shared by every liquidity intent route. */
export function liquidityRoute<T>(
  operation: (event: H3Event, service: LiquidityService, actor: LiquidityActor) => Promise<T>,
  purchaseQuery = false,
) {
  return defineEventHandler(async (event) => {
    if (!event.context.auth?.authenticated) {
      setResponseStatus(event, 403);
      return errorEnvelope('AUTHORIZATION_REQUIRED', 'Authentication is required.', null);
    }
    let authInfo: Parameters<typeof errorEnvelope>[2] = null;
    const requestId = crypto.randomUUID();
    try {
      if (!purchaseQuery && Object.keys(getQuery(event)).length) throw new Error('Invalid input');
      const workflow = getWorkflowStore(event);
      if ('error' in workflow) {
        setResponseStatus(event, 503);
        return errorEnvelope(
          'STORE_UNAVAILABLE',
          'Workflow store unavailable.',
          authInfo,
          true,
          requestId,
        );
      }
      const connectionManager = createDefaultConnectionManager({
        configPath: process.env.BALANCEFRAME_CONFIG_PATH,
      });
      const config = await connectionManager.loadConfig();
      if (!config) {
        setResponseStatus(event, 503);
        return errorEnvelope(
          'not_connected',
          'Configure an Actual budget first.',
          authInfo,
          true,
          requestId,
        );
      }
      const auth = await requireAuthorization(event, 'observe', `budget:${config.budgetId}`);
      if (!auth.ok) return auth.response;
      authInfo = auth.info;
      const service = await createLiquidityService({ connectionManager, store: workflow.store });
      return okEnvelope(
        await operation(event, service, { actorId: getActorId(event), budgetId: config.budgetId }),
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
