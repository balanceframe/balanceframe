import { createDefaultConnectionManager } from '@balanceframe/application';
import { defineEventHandler, getQuery, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import {
  projectFinancialFinding,
  selectedLiquidityActor,
} from '../../utils/liquidity-service';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';

const FindingsQuery = z.object({
  status: z.enum(['open', 'acknowledged', 'corrected', 'dismissed', 'reopened', 'superseded', 'expired']).optional(),
  budgetId: z.string().trim().min(1).max(200).optional(),
  classification: z.string().trim().min(1).max(120).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  limit: z.coerce.number().int().min(0).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict();

export default defineEventHandler(async (event) => {
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
    'observe',
    `budget:${selected.space.budgetId}`,
  );
  if (!authorization.ok) return authorization.response;
  const query = FindingsQuery.safeParse(getQuery(event));
  if (!query.success || (query.data.budgetId !== undefined && query.data.budgetId !== selected.space.budgetId)) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_FINDINGS_QUERY', 'Use valid filters for the selected budget.', authorization.info, false, requestId);
  }
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', workflow.error, authorization.info, true, requestId);
  }

  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const config = await manager.loadConfig();
    if (!config || config.budgetId !== selected.space.budgetId) {
      setResponseStatus(event, 409);
      return errorEnvelope(
        'SPACE_CONNECTION_MISMATCH',
        'The configured budget does not match the selected space.',
        authorization.info,
        false,
        requestId,
      );
    }
    const actor = selectedLiquidityActor(workflow.store, selected);
    if (!actor) {
      setResponseStatus(event, 403);
      return errorEnvelope('FORBIDDEN', 'The selected space is unavailable.', authorization.info, false, requestId);
    }
    const visible = [];
    let visibleIndex = 0;
    for (let storeOffset = 0; visible.length < query.data.limit; storeOffset += 500) {
      const findings = await workflow.store.listFindings({
        budgetId: selected.space.budgetId,
        ...(query.data.status ? { status: query.data.status } : {}),
        limit: 500,
        offset: storeOffset,
      });
      for (const finding of findings) {
        const projected = projectFinancialFinding(workflow.store, actor, finding);
        if (
          !projected ||
          (query.data.classification && projected.classification !== query.data.classification) ||
          (query.data.severity && projected.severity !== query.data.severity)
        )
          continue;
        if (visibleIndex++ < query.data.offset) continue;
        visible.push(projected);
        if (visible.length === query.data.limit) break;
      }
      if (findings.length < 500) break;
    }
    return okEnvelope(visible, authorization.info, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'LIST_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
});
