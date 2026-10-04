import { createDefaultConnectionManager } from '@balanceframe/application';
import { selectedLiquidityActor } from '../../utils/liquidity-service';
import { projectReviewQueueItem, ReviewSynchronization } from '../../utils/review-projection';
import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { requireSelectedSpace } from '../../utils/space-context';
import type { EventWithContext } from '../../utils/workflow-store';
/**
 * GET /api/review — list pending review items in the explicitly selected space.
 */
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  requireAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';
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
  const authInfo = authorization.info;
  const wf = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, true, requestId);
  }

  const actor = selectedLiquidityActor(wf.store, selected);
  if (!actor) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Current selected-space authorization is unavailable.', authInfo, false, requestId);
  }

  try {
    const budgetId = selected.space.budgetId;
    const items = await wf.store.listReviewItems({ budgetId, status: 'pending_review' });
    const correctingItems = await wf.store.listReviewItems({ budgetId, status: 'correcting' });
    const allItems = [...items, ...correctingItems].sort((a, b) => b.priority - a.priority);
    if (allItems.length === 0) return okEnvelope({ items: [], total: 0 }, authInfo, requestId);

    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const config = await manager.loadConfig();
    if (!config || config.budgetId !== budgetId) {
      setResponseStatus(event, 409);
      return errorEnvelope(
        'SPACE_CONNECTION_MISMATCH',
        'The configured budget does not match the selected space.',
        authInfo,
        false,
        requestId,
      );
    }
    const queueItems = await manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId)
        throw new Error('Selected budget changed');
      const snapshot = ReviewSynchronization.parse(connected.synchronization).financialSnapshot.legacySnapshot;
      return allItems.flatMap((item) => {
        const projected = projectReviewQueueItem(wf.store, actor, item, snapshot);
        return projected ? [projected] : [];
      });
    }, { expectedBudgetId: budgetId, dispose: true });
    return okEnvelope({ items: queueItems, total: queueItems.length }, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'LIST_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, false, requestId);
  }
});
