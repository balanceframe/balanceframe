import { createDefaultConnectionManager } from '@balanceframe/application';
import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { projectReviewQueueItem, ReviewSynchronization } from '../../utils/review-projection';
import { selectedLiquidityActor } from '../../utils/liquidity-service';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';
import type { ReviewItem } from '@balanceframe/workflow-store';
import { hasReviewProjectionAdmission } from '../../utils/review-scope-admission';

const Body = z.object({
  ids: z.array(z.string().trim().min(1).max(200)).min(1).max(100).refine(
    (ids) => new Set(ids).size === ids.length,
    'Review IDs must be unique',
  ),
}).strict();
type ReviewGroupEntry = {
  reviewId: string;
  generatedAt: string;
  status: ReviewItem['status'];
  description: string;
  totalAmount: { minorUnits: string; currency: string };
  itemCount: number;
  items: readonly {
    transactionId: string;
    amount: { minorUnits: string; currency: string };
    payeeName: string | null;
    date: string | null;
    categoryName: string;
    suggestedCategoryId: string;
    suggestedCategoryName: string;
  }[];
};


export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const requestId = crypto.randomUUID();
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  if (!budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget', null, false, requestId);
  }
  const authorization = await requireAuthorization(
    event as unknown as EventWithContext,
    'observe',
    `budget:${budgetId}`,
  );
  if (!authorization.ok) return authorization.response;
  const body = Body.safeParse(await readBody<unknown>(event).catch(() => null));
  if (!body.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_REVIEW_GROUP', 'Provide unique review IDs to group.', authorization.info, false, requestId);
  }

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', workflow.error, authorization.info, true, requestId);
  }
  const actor = selectedLiquidityActor(workflow.store, selected);
  if (!actor) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Current selected-space authorization is unavailable.', authorization.info, false, requestId);
  }
  try {
    const reviewItems = new Map<string, ReviewItem>();
    const selectedIds = new Set(body.data.ids);
    for (let offset = 0; reviewItems.size < selectedIds.size; offset += 500) {
      const page = await workflow.store.listReviewItems({
        budgetId,
        limit: 500,
        offset,
      });
      for (const item of page) {
        if (item.budgetId === budgetId && selectedIds.has(item.id)) reviewItems.set(item.id, item);
      }
      if (page.length < 500) break;
    }
    if (
      reviewItems.size !== selectedIds.size ||
      body.data.ids.some((id) => {
        const item = reviewItems.get(id);
        return !item || !hasReviewProjectionAdmission({
          store: workflow.store,
          actor,
          item,
        });
      })
    ) {
      setResponseStatus(event, 404);
      return errorEnvelope('REVIEW_ITEM_NOT_FOUND', 'One or more review items are unavailable.', authorization.info, false, requestId);
    }

    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const config = await manager.loadConfig();
    if (!config || config.budgetId !== budgetId) {
      setResponseStatus(event, 409);
      return errorEnvelope('SPACE_CONNECTION_MISMATCH', 'The configured budget does not match the selected space.', authorization.info, false, requestId);
    }
    const result = await manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId)
        throw new Error('Selected budget changed');
      const snapshot = ReviewSynchronization.parse(connected.synchronization).financialSnapshot.legacySnapshot;
      const items: ReviewGroupEntry[] = [];
      let totalMinorUnits = 0n;
      let currency: string | null = null;
      const generatedAt = new Date().toISOString();

      for (const id of body.data.ids) {
        const review = reviewItems.get(id);
        if (!review) throw new Error('Review item unavailable in selected space');
        const transaction = snapshot.transactions.find((row) => row.id === review.transactionId);
        const projected = projectReviewQueueItem(workflow.store, actor, review, snapshot);
        if (!transaction || !projected)
          throw new Error('Current review facts are not authorized in the selected space');
        if (currency !== null && currency !== transaction.amount.currency)
          throw new Error('Review group contains transactions in different currencies');
        currency = transaction.amount.currency;
        totalMinorUnits += BigInt(transaction.amount.minorUnits);
        const detailItem = {
          transactionId: transaction.id,
          amount: transaction.amount,
          payeeName: transaction.payeeName,
          date: transaction.date ?? null,
          categoryName: projected.evidence.currentCategory,
          suggestedCategoryId: review.categoryId,
          suggestedCategoryName: projected.evidence.suggestedCategory,
        };
        items.push({
          reviewId: review.id,
          generatedAt,
          status: review.status,
          description: `Review for ${projected.evidence.normalizedMerchant || transaction.id}`,
          totalAmount: transaction.amount,
          itemCount: 1,
          items: [detailItem],
        });
      }
      const representative = reviewItems.get(body.data.ids[0]!);
      if (!representative) throw new Error('Review group has no current items');
      const homogeneous = body.data.ids.every((id) => {
        const item = reviewItems.get(id);
        return !!item &&
          item.status === representative.status &&
          item.categoryId === representative.categoryId &&
          item.classifier === representative.classifier;
      });
      if (currency === null) throw new Error('Review group has no current transactions');
      return {
        items,
        homogeneous,
        totalAmount: { minorUnits: totalMinorUnits.toString(), currency },
        itemCount: items.length,
      };
    }, { expectedBudgetId: budgetId, dispose: true });
    return okEnvelope(result, authorization.info, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'REVIEW_GROUP_FAILED', false);
    setResponseStatus(event, 409);
    return errorEnvelope(safe.code, safe.message, authorization.info, false, requestId);
  }
});
