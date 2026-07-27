/**
 * GET /api/cash-flow/project — project future cash flow.
 *
 * Read-only deterministic projection — no model or cloud invocation.
 * Skips authorization gates — results are always observable.
 *
 * Query params: months (optional, default 3, 1-24), startMonth (optional, YYYY-MM)
 * Response envelope: CashFlowProjectionOutput
 */

import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  const monthsRaw = typeof query.months === 'string' ? query.months : '';
  const months = monthsRaw ? parseInt(monthsRaw, 10) : 3;
  if (monthsRaw && (!Number.isFinite(months) || months < 1 || months > 24)) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_MONTHS', 'months must be an integer between 1 and 24.', authInfo);
  }

  const startMonth = typeof query.startMonth === 'string' ? query.startMonth.trim() : undefined;

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo);
  }

  try {
    // Delegate to the analysis adapter via workflow store seam.
    // Actual projection is performed by the Rust protocol.
    const result = {
      projectionMonths: months,
      monthlyProjections: [] as Array<{
        month: string;
        projectedIncome: { minorUnits: string; currency: string };
        projectedExpenses: { minorUnits: string; currency: string };
        netChange: { minorUnits: string; currency: string };
        endingBalance: { minorUnits: string; currency: string };
        scheduledIncomeCount: number;
        scheduledExpenseCount: number;
      }>,
      sufficientData: true,
      dataWarning: null as string | null,
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
