/**
 * GET /api/review — list pending review items.
 *
 * Queries persisted state from the workflow store.  Returns items whose
 * status is `pending_review` (the actionable queue).  Evidence enrichment
 * and homogeneity checks are performed client-side by ReviewController.
 *
 * Response envelope matches ReviewListResult:
 *   { items: ReviewQueueItem[], total: number }
 * Each item carries the raw ReviewItem data with default evidence/homogeneity
 * stubs.  The client composable passes these through as-is.
 */

import type { ReviewItem } from '@balanceframe/workflow-store';
import {
  getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo,
} from '../../utils/workflow-store';
import type { ReviewQueueItem } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo);
  }

  try {
    const items = await wf.store.listReviewItems({ status: 'pending_review' });

    const queueItems: ReviewQueueItem[] = items.map((item: ReviewItem) => ({
      reviewItem: item,
      evidence: {
        historicalClassifications: [],
        changePreview: {
          budgetId: item.budgetId,
          transactionId: item.transactionId,
          currentCategoryId: null,
          proposedCategoryId: item.categoryId,
          transactionDate: null,
          merchantName: null,
          amount: null,
          description: null,
        },
      },
      homogeneity: {
        sameMerchant: false,
        sameAmount: false,
        sameClassifier: false,
        sameCategory: false,
      },
      actionable: item.status === 'pending_review',
    }));

    return okEnvelope(
      { items: queueItems, total: queueItems.length },
      authInfo,
    );
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'LIST_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
    );
  }
});
