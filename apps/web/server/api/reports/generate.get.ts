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

import {
  createDefaultConnectionManager,
  createNativeAnalysisProtocol,
  reportGenerateAnalysis,
} from '@balanceframe/application';
import type { CommandInput, ReportGenerationParams } from '@balanceframe/application';
import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
  getActorId,
  sanitizeError,
} from '../../utils/workflow-store';

const VALID_REPORT_TYPES = ['spending', 'income', 'net_worth', 'category_breakdown', 'cash_flow'];

/** Map an analysis error code to an HTTP status. */
function httpStatusForCode(code: string): number {
  if (code.includes('not_connected') || code.includes('no_analysis') || code.startsWith('stale_')) {
    return 503;
  }
  if (
    code.toUpperCase().endsWith('_REQUIRED') ||
    code.startsWith('invalid') ||
    code.startsWith('missing') ||
    code.includes('MISSING')
  ) {
    return 400;
  }
  return 500;
}

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  const reportType = typeof query.reportType === 'string' ? query.reportType.trim() : '';
  if (!reportType || !VALID_REPORT_TYPES.includes(reportType)) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_REPORT_TYPE',
      `reportType must be one of: ${VALID_REPORT_TYPES.join(', ')}`,
      authInfo,
      false,
      requestId,
    );
  }

  const monthRange = typeof query.monthRange === 'string' ? query.monthRange.trim() : '';
  if (!monthRange || !/^\d{4}-\d{2}(:\d{4}-\d{2})?$/.test(monthRange)) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_MONTH_RANGE',
      'monthRange must be YYYY-MM or YYYY-MM:YYYY-MM inclusive.',
      authInfo,
      false,
      requestId,
    );
  }

  const label = typeof query.label === 'string' ? query.label.trim() : undefined;
  const tag = typeof query.tag === 'string' ? query.tag.trim() : undefined;

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    return await manager.withConnection(async (connected) => {
      const protocol = await createNativeAnalysisProtocol();

      const input: CommandInput = {
        args: [],
        mode: 'observe',
        actorId: getActorId(event),
        requestId,
        ledger: connected.connector,
        freshness: null,
        analysisProtocol: protocol,
      };

      const params: ReportGenerationParams = {
        reportType,
        scope: {
          monthRange,
          includePending: true,
        },
        ...(label ? { label } : {}),
        ...(tag ? { tags: [tag] } : {}),
      };

      const envelope = await reportGenerateAnalysis(input, params);

      if (envelope.status === 'ok') {
        return okEnvelope(envelope.result, authInfo, envelope.requestId);
      }

      const status = httpStatusForCode(envelope.error.code);
      setResponseStatus(event, status);
      return errorEnvelope(
        envelope.error.code,
        envelope.error.message,
        authInfo,
        envelope.error.retryable,
        envelope.requestId,
      );
    });
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'ANALYSIS_FAILED', true);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
