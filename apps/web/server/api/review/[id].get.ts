import { createDefaultConnectionManager } from '@balanceframe/application';
import { defineEventHandler, getRouterParam, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { projectReviewQueueItem, ReviewSynchronization } from '../../utils/review-projection';
import { selectedLiquidityActor } from '../../utils/liquidity-service';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';
import type { ReviewItem } from '@balanceframe/workflow-store';

const ReviewId = z.string().trim().min(1).max(200);
export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
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
  const parsedId = ReviewId.safeParse(getRouterParam(event, 'id'));
  if (!parsedId.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_REVIEW_ID', 'Review ID is invalid.', authorization.info, false, requestId);
  }

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Review data is unavailable.', authorization.info, true, requestId);
  }

  try {
    let review: ReviewItem | undefined;
    for (let offset = 0; !review; offset += 500) {
      const items = await workflow.store.listReviewItems({
        budgetId: selected.space.budgetId,
        limit: 500,
        offset,
      });
      review = items.find((item) =>
        item.id === parsedId.data && item.budgetId === selected.space.budgetId,
      );
      if (review || items.length < 500) break;
    }
    if (!review) {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Review item not found.', authorization.info, false, requestId);
    }

    const actor = selectedLiquidityActor(workflow.store, selected);
    if (!actor) {
      setResponseStatus(event, 403);
      return errorEnvelope('FORBIDDEN', 'Current selected-space authorization is unavailable.', authorization.info, false, requestId);
    }
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
    const projected = await manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== selected.space.budgetId ||
          connected.budget.id !== selected.space.budgetId)
        throw new Error('Selected budget changed');
      const snapshot = ReviewSynchronization.parse(connected.synchronization).financialSnapshot.legacySnapshot;
      return projectReviewQueueItem(workflow.store, actor, review, snapshot);
    }, { expectedBudgetId: selected.space.budgetId, dispose: true });
    if (!projected) {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Review item not found.', authorization.info, false, requestId);
    }
    return okEnvelope(projected, authorization.info, requestId);
  } catch {
    setResponseStatus(event, 500);
    return errorEnvelope('REVIEW_FETCH_FAILED', 'Review item could not be loaded.', authorization.info, false, requestId);
  }
});
