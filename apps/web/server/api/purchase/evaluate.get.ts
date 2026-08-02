/**
 * GET /api/purchase/evaluate — evaluate a proposed purchase against budget.
 *
 * Requires the observe capability before parsing or restoring any ledger connection.
 *
 * Query params: categoryId (required), amount (required), accountId (optional)
 * Response envelope: PurchaseEvaluationOutput
 */

import {
  createDefaultConnectionManager,
  createNativeAnalysisProtocol,
  purchaseEvaluationAnalysis,
} from '@balanceframe/application';
import type { CommandInput, PurchaseEvaluationParams } from '@balanceframe/application';
import type { Money } from '@balanceframe/protocol-generated';
import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, requireAuthorization, getActorId, sanitizeError } from '../../utils/workflow-store';

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
  const authCheck = await requireAuthorization(event, 'observe');
  if (!authCheck.ok) return authCheck.response;
  const authInfo = authCheck.info;
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  const categoryId = typeof query.categoryId === 'string' ? query.categoryId.trim() : '';
  if (!categoryId) {
    setResponseStatus(event, 400);
    return errorEnvelope('PURCHASE_CATEGORY_REQUIRED', 'A categoryId query parameter is required.', authInfo, false, requestId);
  }

  const amountRaw = typeof query.amount === 'string' ? query.amount : '';
  if (!amountRaw || !/^-?\d+$/.test(amountRaw) || amountRaw === '0') {
    setResponseStatus(event, 400);
    return errorEnvelope('PURCHASE_AMOUNT_REQUIRED', 'A non-zero amount (minorUnits string) is required.', authInfo, false, requestId);
  }

  const amount: Money = {
    minorUnits: amountRaw,
    currency: typeof query.currency === 'string' ? query.currency : 'USD',
  };

  const accountId = typeof query.accountId === 'string' ? query.accountId.trim() : undefined;

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

    const params: PurchaseEvaluationParams = {
      categoryId,
      amount,
      ...(accountId ? { accountId } : {}),
    };

    const envelope = await purchaseEvaluationAnalysis(input, params);

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
