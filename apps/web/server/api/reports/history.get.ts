/**
 * GET /api/reports/history — get time-ordered report history.
 *
 * Read-only with respect to ledger data (only reads report metadata).
 * Query params: budgetId (optional), limit (default 50), offset (default 0)
 *
 * Response envelope: { entries: ReportHistoryEntry[], total: number }
 */

import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo, sanitizeError } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  const budgetId = typeof query.budgetId === 'string' ? query.budgetId.trim() : undefined;
  const limit = typeof query.limit === 'string' ? Math.min(parseInt(query.limit, 10) || 50, 200) : 50;
  const offset = typeof query.offset === 'string' ? parseInt(query.offset, 10) || 0 : 0;

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const [entries, total] = await Promise.all([
      wf.store.getReportHistory(budgetId, limit, offset),
      wf.store.countReportRecords(budgetId),
    ]);
    return okEnvelope({ entries, total }, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'HISTORY_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
