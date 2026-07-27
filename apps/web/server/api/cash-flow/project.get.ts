/**
 * GET /api/cash-flow/project — project future cash flow.
 *
 * Read-only deterministic projection — no model or cloud invocation.
 * Skips authorization gates — results are always observable.
 *
 * Query params: months (optional, default 3, 1-24), startMonth (optional, YYYY-MM)
 * Response envelope: CashFlowProjectionOutput
 */

import {
  createDefaultConnectionManager,
  createNativeAnalysisProtocol,
  cashFlowProjectionAnalysis,
} from '@balanceframe/application';
import type { CommandInput, CashFlowProjectionParams } from '@balanceframe/application';
import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo, getActorId, sanitizeError } from '../../utils/workflow-store';

/** Map an analysis error code to an HTTP status. */
function httpStatusForCode(code: string): number {
  if (
    code.includes('not_connected') ||
    code.includes('no_analysis') ||
    code.startsWith('stale_')
  ) {
    return 503;
  }
  if (
    code.endsWith('_REQUIRED') ||
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

  const monthsRaw = typeof query.months === 'string' ? query.months : '';
  const months = monthsRaw ? parseInt(monthsRaw, 10) : 3;
  if (monthsRaw && (!Number.isFinite(months) || months < 1 || months > 24)) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_MONTHS', 'months must be an integer between 1 and 24.', authInfo, false, requestId);
  }

  const startMonth = typeof query.startMonth === 'string' ? query.startMonth.trim() : undefined;

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const connected = await manager.restore();
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

    const params: CashFlowProjectionParams = {
      months,
      ...(startMonth ? { startMonth } : {}),
    };

    const envelope = await cashFlowProjectionAnalysis(input, params);

    if (envelope.status === 'ok') {
      return okEnvelope(envelope.result, authInfo, envelope.requestId);
    }

    const status = httpStatusForCode(envelope.error.code);
    setResponseStatus(event, status);
    return errorEnvelope(envelope.error.code, envelope.error.message, authInfo, envelope.error.retryable, envelope.requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'ANALYSIS_FAILED', true);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
