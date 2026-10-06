import { createDefaultConnectionManager, createMerchantIntelligenceService, indexCanonicalTransactions } from '@balanceframe/application';
import type { MerchantAnalysisView, CanonicalReviewSource } from '@balanceframe/application';
import { selectedLiquidityActor } from '../../utils/liquidity-service';
import { projectReviewQueueItems, reviewDisclosureOperations, ReviewSynchronization } from '../../utils/review-projection';
import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { requireSelectedSpace } from '../../utils/space-context';
import type { EventWithContext } from '../../utils/workflow-store';
import { merchantAnalysisAuthorized } from '../../utils/merchant-service';
import { hasCurrentReviewNamespace, refreshReviewItems, reviewConnectionScope } from '../../utils/review-scope-admission';
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
    const allItems = [...items, ...correctingItems].filter((item) => hasCurrentReviewNamespace(wf.store, item, {
      spaceId: selected.space.id, budgetId,
    })).sort((a, b) => b.priority - a.priority);
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
    const merchantActor = actor.auth && actor.spaceId ? { ...actor, auth: actor.auth, spaceId: actor.spaceId } : null;
    const merchantEnabled = merchantActor !== null && merchantAnalysisAuthorized(wf.store, merchantActor);
    const captured = await manager.withConnection(async (connected) => {
      const scope = reviewConnectionScope(selected.space.id, connected.config);
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId)
        throw new Error('Selected budget changed');
      if (!allItems.some((item) => hasCurrentReviewNamespace(wf.store, item, scope))) return { scope, snapshot: null };
      const synchronized = await connected.connector.synchronize();
      return { scope, snapshot: ReviewSynchronization.parse(synchronized).financialSnapshot.legacySnapshot };
    }, { expectedBudgetId: budgetId, dispose: true, synchronize: false });
    const finalConfig = await manager.loadConfig();
    if (!captured.snapshot || !finalConfig || finalConfig.budgetId !== budgetId ||
        reviewConnectionScope(selected.space.id, finalConfig).connectionId !== captured.scope.connectionId)
      return okEnvelope({ items: [], total: 0 }, authInfo, requestId);
    const snapshot = captured.snapshot;
    const project = async (merchant?: MerchantAnalysisView, source?: CanonicalReviewSource) => {
      const current = await refreshReviewItems(wf.store, allItems);
      const config = await manager.loadConfig();
      if (!config || config.budgetId !== budgetId ||
          reviewConnectionScope(selected.space.id, config).connectionId !== captured.scope.connectionId) return [];
      return projectReviewQueueItems(wf.store, actor, current, snapshot, merchant, source, 'observe', captured.scope);
    };
    const queueItems = merchantEnabled && merchantActor
      ? await (await (await createMerchantIntelligenceService({ store: wf.store, connectionManager: manager }))
        .withAnalysis(merchantActor, { transactionIds: allItems.map((item) => item.transactionId), limit: 1000 },
          async (view, source, authorize) => {
            const transactions = indexCanonicalTransactions(source.transactions);
            const disclose = async () => {
              const projected = await project(view, source);
              if (authorize(reviewDisclosureOperations(projected, transactions))) return projected;
              authorize([]);
              return [];
            };
            await disclose();
            return disclose;
          }))()
      : await project();
    return okEnvelope({ items: queueItems, total: queueItems.length }, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'LIST_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, false, requestId);
  }
});
