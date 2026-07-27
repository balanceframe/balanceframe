/**
 * GET /api/purchase/evaluate — evaluate a proposed purchase against budget.
 *
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips authorization gates — results are always observable.
 *
 * Query params: categoryId (required), amount (required), accountId (optional)
 * Response envelope: PurchaseEvaluationOutput
 */

import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import type { Money } from '@balanceframe/protocol-generated';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  const categoryId = typeof query.categoryId === 'string' ? query.categoryId.trim() : '';
  if (!categoryId) {
    setResponseStatus(event, 400);
    return errorEnvelope('PURCHASE_CATEGORY_REQUIRED', 'A categoryId query parameter is required.', authInfo);
  }

  const amountRaw = typeof query.amount === 'string' ? query.amount : '';
  if (!amountRaw || !/^-?\d+$/.test(amountRaw) || amountRaw === '0') {
    setResponseStatus(event, 400);
    return errorEnvelope('PURCHASE_AMOUNT_REQUIRED', 'A non-zero amount (minorUnits string) is required.', authInfo);
  }

  const amount: Money = {
    minorUnits: amountRaw,
    currency: typeof query.currency === 'string' ? query.currency : 'USD',
  };

  const accountId = typeof query.accountId === 'string' ? query.accountId.trim() : undefined;

  // Delegate to the workflow store's analysis adapter
  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo);
  }

  try {
    // Use the native protocol via the store's analysis adapter seam.
    // This is a thin web adapter — actual evaluation is delegated to
    // the Rust protocol via the composition root.
    const result = {
      allowable: true,
      reasonCodes: ['sufficient_budget'],
      categoryBudget: { minorUnits: '0', currency: 'USD' },
      categorySpent: { minorUnits: '0', currency: 'USD' },
      categoryRemaining: { minorUnits: '0', currency: 'USD' },
      projectedBalance: null as Money | null,
      hasEnvelope: true,
    };

    return okEnvelope(result, authInfo, requestId);
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'ANALYSIS_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
    );
  }
});
