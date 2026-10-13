import { createDefaultConnectionManager, indexCanonicalTransactions } from '@balanceframe/application';
import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { projectReviewQueueItems, ReviewSynchronization } from '../../utils/review-projection';
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
import type { GovernanceOperation, ReviewItem } from '@balanceframe/workflow-store';
import { hasCurrentReviewNamespace, hasReviewProjectionAdmission, refreshReviewItems, reviewConnectionScope } from '../../utils/review-scope-admission';

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
    const selectedItems = body.data.ids.map((id) => reviewItems.get(id)!);
    const captured = await manager.withConnection(async (connected) => {
      const scope = reviewConnectionScope(selected.space.id, connected.config);
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId ||
          !selectedItems.every((item) => hasCurrentReviewNamespace(workflow.store, item, scope)))
        throw new Error('Selected Review namespace changed');
      const synchronized = await connected.connector.synchronize();
      return { scope, snapshot: ReviewSynchronization.parse(synchronized).financialSnapshot.legacySnapshot };
    }, { expectedBudgetId: budgetId, dispose: true, synchronize: false });
    const currentItems = await refreshReviewItems(workflow.store, selectedItems);
    if (currentItems.length !== selectedItems.length) throw new Error('Captured Review generation changed');
    for (const item of currentItems) reviewItems.set(item.id, item);
    const finalConfig = await manager.loadConfig();
    if (!finalConfig || finalConfig.budgetId !== budgetId ||
        reviewConnectionScope(selected.space.id, finalConfig).connectionId !== captured.scope.connectionId)
      throw new Error('Selected Review namespace changed');
    const snapshot = captured.snapshot;
    const transactions = indexCanonicalTransactions(snapshot.transactions);
    const projectedItems = projectReviewQueueItems(workflow.store, actor, currentItems, snapshot, undefined, undefined, 'observe', captured.scope);
    if (projectedItems.length !== selectedItems.length)
      throw new Error('Current review facts are not authorized in the selected space');
    const projectedById = new Map(projectedItems.map((item) => [item.reviewItem.id, item]));
    const items: ReviewGroupEntry[] = [];
    let totalMinorUnits = 0n;
    let currency: string | null = null;
    const generatedAt = new Date().toISOString();

    for (const id of body.data.ids) {
      const review = reviewItems.get(id);
      if (!review) throw new Error('Review item unavailable in selected space');
      const transaction = transactions.get(review.transactionId);
      const projected = projectedById.get(review.id);
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
        suggestedCategoryId: projected.reviewItem.categoryId,
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
    const representativeCategory = projectedById.get(representative.id)?.reviewItem.categoryId;
    const homogeneous = body.data.ids.every((id) => {
      const item = reviewItems.get(id);
      return !!item &&
        item.status === representative.status &&
        projectedById.get(id)?.reviewItem.categoryId === representativeCategory &&
        item.classifier === representative.classifier;
    });
    if (currency === null) throw new Error('Review group has no current transactions');
    const result = {
      items,
      homogeneous,
      totalAmount: { minorUnits: totalMinorUnits.toString(), currency },
      itemCount: items.length,
    };
    const outbound: (GovernanceOperation & { readonly id?: string })[] = [];
    for (const entry of result.items) {
      for (const item of entry.items) {
        const transaction = transactions.get(item.transactionId);
        if (!transaction) throw new Error('Review group disclosure source unavailable');
        const signed = BigInt(item.amount.minorUnits);
        outbound.push({ operation: 'history', id: transaction.id, accountId: transaction.accountId,
          ...(transaction.categoryId ? { categoryId: transaction.categoryId } : {}),
          direction: BigInt(transaction.amount.minorUnits) < 0n ? 'outgoing' : 'incoming',
          amount: { currency: item.amount.currency, minorUnits: (signed < 0n ? -signed : signed).toString() } });
      }
      // A subtotal is derived even when its one item happens to have identical Money.
      const subtotal = BigInt(entry.totalAmount.minorUnits);
      outbound.push({ operation: 'history', amount: {
        currency: entry.totalAmount.currency, minorUnits: (subtotal < 0n ? -subtotal : subtotal).toString(),
      } });
    }
    outbound.push({ operation: 'history', amount: {
      currency, minorUnits: (totalMinorUnits < 0n ? -totalMinorUnits : totalMinorUnits).toString(),
    } });
    if (projectReviewQueueItems(workflow.store, actor, currentItems, snapshot, undefined, undefined,
      'observe', captured.scope, outbound).length !== currentItems.length)
      throw new Error('Complete Review group disclosure is unavailable');
    return okEnvelope(result, authorization.info, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'REVIEW_GROUP_FAILED', false);
    setResponseStatus(event, 409);
    return errorEnvelope(safe.code, safe.message, authorization.info, false, requestId);
  }
});
