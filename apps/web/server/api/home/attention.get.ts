/**
 * GET /api/home/attention — get the prioritized attention/home dashboard.
 *
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips authorization gates — results are always observable.
 *
 * Query params: categoryGroup (optional), detailed (optional boolean), month (optional YYYY-MM)
 * Response envelope: AttentionHomeOutput
 */

import {
  createDefaultConnectionManager,
  createNativeAnalysisProtocol,
  attentionHomeAnalysis,
} from '@balanceframe/application';
import type { CommandInput, AttentionHomeParams } from '@balanceframe/application';
import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
  getActorId,
  sanitizeError,
  envelopeMetadata,
} from '../../utils/workflow-store';

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

/** Return whether an unknown failure carries the requested application error code. */
function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  const categoryGroup =
    typeof query.categoryGroup === 'string' ? query.categoryGroup.trim() : undefined;

  const detailedRaw = typeof query.detailed === 'string' ? query.detailed : '';
  const detailed = detailedRaw ? detailedRaw === 'true' : undefined;

  const month = typeof query.month === 'string' ? query.month.trim() : undefined;
  if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_MONTH',
      'month must be in YYYY-MM format.',
      authInfo,
      false,
      requestId,
    );
  }

  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const config = await manager.loadConfig();
    if (!config) {
      setResponseStatus(event, 503);
      return errorEnvelope(
        'not_connected',
        'No ledger connected. Configure an Actual budget first.',
        authInfo,
        true,
        requestId,
      );
    }
    const wf = getWorkflowStore(event);
    if ('error' in wf) {
      setResponseStatus(event, 503);
      return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
    }

    const context: AttentionHomeParams['context'] = {};
    if (categoryGroup !== undefined) context.categoryGroup = categoryGroup;
    if (detailed !== undefined) context.detailed = detailed;
    if (month !== undefined) context.month = month;

    const params: AttentionHomeParams = {
      ...(Object.keys(context).length > 0 ? { context } : {}),
    };

    const envelope = await manager.withConnection(async (connected) => {
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
      return attentionHomeAnalysis(input, params);
    });

    if (envelope.status === 'ok') {
      return okEnvelope(envelope.result, authInfo, envelope.requestId, envelopeMetadata(envelope));
    }

    const status = httpStatusForCode(envelope.error.code);
    setResponseStatus(event, status);
    return errorEnvelope(
      envelope.error.code,
      envelope.error.message,
      authInfo,
      envelope.error.retryable,
      envelope.requestId,
      envelopeMetadata(envelope),
    );
  } catch (error) {
    if (errorHasCode(error, 'not_connected')) {
      setResponseStatus(event, 503);
      return errorEnvelope(
        'not_connected',
        'No ledger connected. Configure an Actual budget first.',
        authInfo,
        true,
        requestId,
      );
    }
    const safe = sanitizeError(error, requestId, 'ANALYSIS_FAILED', true);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
