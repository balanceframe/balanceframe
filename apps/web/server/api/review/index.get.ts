/**
 * GET /api/review — list pending review items.
 *
 * Queries persisted state from the workflow store.  Returns items whose
 * status is `pending_review` (the actionable queue).  Each item carries
 * the complete ReviewEvidence shape populated from persisted classifier
 * payload data via buildReviewQueueItem(), with deterministic safe
 * defaults where enrichment is absent.
 *
 * Response envelope matches ReviewListResult:
 *   { items: ReviewQueueItem[], total: number }
 */

import type { ReviewItem } from '@balanceframe/workflow-store';
import {
  getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo,
  buildReviewQueueItem,
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
    const correctingItems = await wf.store.listReviewItems({ status: 'correcting' });
    const allItems = [...items, ...correctingItems].sort((a, b) => b.priority - a.priority);
    const queueItems: ReviewQueueItem[] = allItems.map(buildReviewQueueItem);

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
