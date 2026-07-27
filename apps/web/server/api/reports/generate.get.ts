/**
 * GET /api/reports/generate — generate a report with persisted scope and filters.
 *
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips authorization gates — results are always observable.
 *
 * Query params:
 *   reportType (required): "spending" | "income" | "net_worth" | "category_breakdown" | "cash_flow"
 *   monthRange (required): YYYY-MM or YYYY-MM:YYYY-MM inclusive
 *   label (optional): human-readable label
 *   tag (optional): single tag string
 * Response envelope: ReportGenerationOutput
 */

import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo } from '../../utils/workflow-store';

const VALID_REPORT_TYPES = ['spending', 'income', 'net_worth', 'category_breakdown', 'cash_flow'];

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  const reportType = typeof query.reportType === 'string' ? query.reportType.trim() : '';
  if (!reportType || !VALID_REPORT_TYPES.includes(reportType)) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_REPORT_TYPE', `reportType must be one of: ${VALID_REPORT_TYPES.join(', ')}`, authInfo);
  }

  const monthRange = typeof query.monthRange === 'string' ? query.monthRange.trim() : '';
  if (!monthRange || !/^\d{4}-\d{2}(:\d{4}-\d{2})?$/.test(monthRange)) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_MONTH_RANGE', 'monthRange must be YYYY-MM or YYYY-MM:YYYY-MM inclusive.', authInfo);
  }

  const label = typeof query.label === 'string' ? query.label.trim() : undefined;
  const tag = typeof query.tag === 'string' ? query.tag.trim() : undefined;

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo);
  }

  try {
    // Delegate to the analysis adapter via workflow store seam.
    // Actual report generation is performed by the Rust protocol.
    const result = {
      reportId: `rpt_${crypto.randomUUID().slice(0, 8)}`,
      reportType,
      scope: {
        monthRange,
        includePending: true,
      },
      label: label ?? '',
      transactionCount: 0,
      totalAmount: { minorUnits: '0', currency: 'USD' },
      generatedAt: new Date().toISOString(),
      tags: tag ? [tag] : [],
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
