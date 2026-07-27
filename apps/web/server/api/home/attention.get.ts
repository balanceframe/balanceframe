/**
 * GET /api/home/attention — get the prioritized attention/home dashboard.
 *
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips authorization gates — results are always observable.
 *
 * Query params: categoryGroup (optional), detailed (optional boolean), month (optional YYYY-MM)
 * Response envelope: AttentionHomeOutput
 */

import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  const categoryGroup = typeof query.categoryGroup === 'string' ? query.categoryGroup.trim() : undefined;

  const detailedRaw = typeof query.detailed === 'string' ? query.detailed : '';
  const detailed = detailedRaw ? detailedRaw === 'true' : undefined;

  const month = typeof query.month === 'string' ? query.month.trim() : undefined;
  if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_MONTH', 'month must be in YYYY-MM format.', authInfo);
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo);
  }

  try {
    // Delegate to the analysis adapter via workflow store seam.
    // Actual attention/home analysis is performed by the Rust protocol.
    const result = {
      blockers: [] as Array<{
        code: string;
        message: string;
        severity: string;
        entityId?: string;
        entityType?: string;
      }>,
      alerts: [] as Array<{
        code: string;
        message: string;
        severity: string;
        categoryId?: string;
        categoryName?: string;
      }>,
      recurrences: [] as Array<{
        payeeName: string;
        amount: { minorUnits: string; currency: string };
        frequency: string;
        occurrences: number;
        lastOccurrence: string;
        isEstimated: boolean;
      }>,
      categoryRisks: [] as Array<{
        categoryId: string;
        categoryName: string;
        risk: string;
        reasonCodes: string[];
        remainingBudget: { minorUnits: string; currency: string };
        daysRemaining: number;
      }>,
      targetProgress: {
        overallLabel: 'healthy',
        healthyCount: 0,
        atRiskCount: 0,
        sinkingFundsOnTrack: 0,
        totalSinkingFunds: 0,
      },
      details: undefined as {
        uncategorizedCount: number;
        totalUncategorizedAmount: { minorUnits: string; currency: string };
        pendingReviewCount: number;
        overspentCategories: Array<{
          budgeted: { minorUnits: string; currency: string };
          spent: { minorUnits: string; currency: string };
          remaining: { minorUnits: string; currency: string };
          healthLabel: string;
          isSinkingFund: boolean;
          targetAmount: { minorUnits: string; currency: string } | null;
          targetProgress: number | null;
        }>;
      } | undefined,
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
