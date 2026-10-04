import { defineEventHandler, getRouterParam, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import {
  findFindingInBudget,
  projectFinancialFinding,
  selectedLiquidityActor,
} from '../../utils/liquidity-service';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';

const FindingId = z.string().trim().min(1).max(200);

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

  const parsedId = FindingId.safeParse(getRouterParam(event, 'id'));
  if (!parsedId.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_FINDING_ID', 'Finding ID is invalid.', authorization.info, false, requestId);
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
    const finding = await findFindingInBudget(
      workflow.store,
      selected.space.budgetId,
      parsedId.data,
    );
    const projected = finding && projectFinancialFinding(workflow.store, actor, finding);
    if (!projected) {
      setResponseStatus(event, 404);
      return errorEnvelope('FINDING_NOT_FOUND', 'Finding not found.', authorization.info, false, requestId);
    }
    return okEnvelope(projected, authorization.info, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'FETCH_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authorization.info, false, requestId);
  }
});
