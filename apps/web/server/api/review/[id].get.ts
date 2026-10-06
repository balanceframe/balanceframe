import { createDefaultConnectionManager, createMerchantIntelligenceService, indexCanonicalTransactions } from '@balanceframe/application';
import type { CanonicalReviewSource, MerchantAnalysisView } from '@balanceframe/application';
import { defineEventHandler, getRouterParam, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { projectReviewQueueItem, reviewDisclosureOperations, ReviewSynchronization } from '../../utils/review-projection';
import { selectedLiquidityActor } from '../../utils/liquidity-service';
import { requireSelectedSpace } from '../../utils/space-context';
import { merchantAnalysisAuthorized } from '../../utils/merchant-service';
import { composeScenarioResearch } from '../../utils/scenario-research';
import { hasCurrentReviewNamespace, refreshReviewItems, reviewConnectionScope } from '../../utils/review-scope-admission';
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
    if (!review || !hasCurrentReviewNamespace(workflow.store, review, { spaceId: selected.space.id, budgetId: selected.space.budgetId })) {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Review item not found.', authorization.info, false, requestId);
    }
    const item = review;

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
    const merchantActor = actor.auth && actor.spaceId ? { ...actor, auth: actor.auth, spaceId: actor.spaceId } : null;
    const merchantEnabled = merchantActor !== null && merchantAnalysisAuthorized(workflow.store, merchantActor);
    const captured = await manager.withConnection(async (connected) => {
      const scope = reviewConnectionScope(selected.space.id, connected.config);
      if (connected.config.budgetId !== selected.space.budgetId || connected.budget.id !== selected.space.budgetId)
        throw new Error('Selected budget changed');
      if (!hasCurrentReviewNamespace(workflow.store, item, scope)) return { scope, snapshot: null };
      const synchronized = await connected.connector.synchronize();
      return { scope, snapshot: ReviewSynchronization.parse(synchronized).financialSnapshot.legacySnapshot };
    }, { expectedBudgetId: selected.space.budgetId, dispose: true, synchronize: false });
    const finalConfig = await manager.loadConfig();
    const snapshot = captured.snapshot;
    const currentNamespace = finalConfig && finalConfig.budgetId === selected.space.budgetId &&
      reviewConnectionScope(selected.space.id, finalConfig).connectionId === captured.scope.connectionId;
    const project = async (view?: MerchantAnalysisView, source?: CanonicalReviewSource) => {
      if (!snapshot) return null;
      const current = (await refreshReviewItems(workflow.store, [item]))[0];
      const config = await manager.loadConfig();
      if (!current || !config || config.budgetId !== selected.space.budgetId ||
          reviewConnectionScope(selected.space.id, config).connectionId !== captured.scope.connectionId) return null;
      return projectReviewQueueItem(workflow.store, actor, current, snapshot, view, source, 'observe', captured.scope);
    };
    const projected = !snapshot || !currentNamespace ? null : merchantEnabled && merchantActor
      ? await (await (await createMerchantIntelligenceService({ store: workflow.store, connectionManager: manager, research: composeScenarioResearch(event, selected.space.id) }))
        .withAnalysis(merchantActor, { transactionIds: [review.transactionId], limit: 1 },
          async (view, source, authorize) => {
            const transactions = indexCanonicalTransactions(source.transactions);
            const disclose = async () => {
              const projected = await project(view, source);
              if (authorize(reviewDisclosureOperations(projected ? [projected] : [], transactions))) return projected;
              authorize([]);
              return null;
            };
            await disclose();
            return disclose;
          }))()
      : await project();
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
