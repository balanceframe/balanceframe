/**
 * GET /api/scenarios — compare what-if scenarios.
 *
 * Read-only with respect to ledger data (scenario analysis never mutates).
 * Skips authorization gates — results are always observable.
 */

import {
  createDefaultConnectionManager,
  createNativeAnalysisProtocol,
  scenarioComparisonAnalysis,
} from '@balanceframe/application';
import type { CommandInput, ScenarioComparisonParams } from '@balanceframe/application';
import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo, getActorId, sanitizeError, envelopeMetadata } from '../../utils/workflow-store';

function httpStatusForCode(code: string): number {
  if (code.includes('not_connected') || code.includes('no_analysis') || code.startsWith('stale_')) return 503;
  if (code.endsWith('_REQUIRED') || code.startsWith('invalid') || code.startsWith('missing') || code.includes('MISSING')) return 400;
  return 500;
}

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  // Parse scenario payloads from query params (JSON-encoded)
  let baseline: Record<string, unknown> = {};
  let comparison: Record<string, unknown> = {};
  try {
    if (typeof query.baseline === 'string') baseline = JSON.parse(query.baseline) as Record<string, unknown>;
    if (typeof query.comparison === 'string') comparison = JSON.parse(query.comparison) as Record<string, unknown>;
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_SCENARIO_PARAMS', 'Baseline and comparison must be valid JSON.', authInfo, false, requestId);
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const manager = createDefaultConnectionManager({ configPath: process.env.BALANCEFRAME_CONFIG_PATH });
    const connected = await manager.restore();
    const protocol = await createNativeAnalysisProtocol();

    const input: CommandInput = {
      args: [], mode: 'observe',
      actorId: getActorId(event), requestId,
      ledger: connected.connector, freshness: null,
      analysisProtocol: protocol,
    };

    const params: ScenarioComparisonParams = { baseline, comparison };
    const envelope = await scenarioComparisonAnalysis(input, params);

    if (envelope.status === 'ok') return okEnvelope(envelope.result, authInfo, envelope.requestId, envelopeMetadata(envelope));

    const status = httpStatusForCode(envelope.error.code);
    setResponseStatus(event, status);
    return errorEnvelope(envelope.error.code, envelope.error.message, authInfo, envelope.error.retryable, envelope.requestId, envelopeMetadata(envelope));
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'ANALYSIS_FAILED', true);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
