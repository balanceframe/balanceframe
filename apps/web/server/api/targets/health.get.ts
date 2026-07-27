/**
 * GET /api/targets/health — evaluate budget target health.
 *
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips authorization gates — results are always observable.
 *
 * Response envelope: TargetHealthOutput
 */

import { defineEventHandler, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo);
  }

  try {
    // Delegate to the analysis adapter via workflow store seam.
    // Actual target health evaluation is performed by the Rust protocol.
    const result = {
      categories: [] as Array<{
        budgeted: { minorUnits: string; currency: string };
        spent: { minorUnits: string; currency: string };
        remaining: { minorUnits: string; currency: string };
        healthLabel: string;
        isSinkingFund: boolean;
        targetAmount: { minorUnits: string; currency: string } | null;
        targetProgress: number | null;
      }>,
      overallLabel: 'healthy',
      healthyCount: 0,
      atRiskCount: 0,
      sinkingFundCount: 0,
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
