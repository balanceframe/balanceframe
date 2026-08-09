/**
 * GET /api/calendar — budget calendar / timeline of financial events.
 *
 * Read-only deterministic analysis — no model or cloud invocation.
 * Skips authorization gates — results are always observable.
 */

import {
  createDefaultConnectionManager,
  createNativeAnalysisProtocol,
  billCalendarAnalysis,
} from '@balanceframe/application';
import type { CommandInput } from '@balanceframe/application';
import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
  getActorId,
  sanitizeError,
  envelopeMetadata,
} from '../utils/workflow-store';

function httpStatusForCode(code: string): number {
  if (code.includes('not_connected') || code.includes('no_analysis') || code.startsWith('stale_'))
    return 503;
  if (
    code.toUpperCase().endsWith('_REQUIRED') ||
    code.startsWith('invalid') ||
    code.startsWith('missing') ||
    code.includes('MISSING')
  )
    return 400;
  return 500;
}

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);
  const referenceDate = typeof query.referenceDate === 'string' ? query.referenceDate.trim() : '';

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

      const envelope = await billCalendarAnalysis(input, referenceDate);
      if (envelope.status === 'ok')
        return okEnvelope(
          envelope.result,
          authInfo,
          envelope.requestId,
          envelopeMetadata(envelope),
        );

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
    });
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'ANALYSIS_FAILED', true);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
