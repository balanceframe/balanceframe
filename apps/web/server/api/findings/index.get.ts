/**
 * GET /api/findings — list findings.
 *
 * Read-only with respect to ledger data (finding state is separate).
 * Query params: status, budgetId, classification, severity, limit, offset
 * Response envelope: Finding[]
 */

import type { FindingStatus } from '@balanceframe/workflow-store';
import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo, sanitizeError } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  const statusRaw = typeof query.status === 'string' ? query.status.trim() : undefined;
  if (statusRaw !== undefined && !['open', 'acknowledged', 'corrected', 'dismissed', 'reopened', 'superseded', 'expired'].includes(statusRaw)) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_STATUS', `Invalid status "${statusRaw}". Allowed: open, acknowledged, corrected, dismissed, reopened, superseded, expired.`, authInfo, false, requestId);
  }

  const severityRaw = typeof query.severity === 'string' ? query.severity.trim() : undefined;
  if (severityRaw !== undefined && !['low', 'medium', 'high', 'critical'].includes(severityRaw)) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_SEVERITY', `Invalid severity "${severityRaw}". Allowed: low, medium, high, critical.`, authInfo, false, requestId);
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const status = statusRaw as unknown as FindingStatus | undefined;
    const severity = severityRaw as unknown as 'low' | 'medium' | 'high' | 'critical' | undefined;
    const findings = await wf.store.listFindings({
      status,
      budgetId: typeof query.budgetId === 'string' ? query.budgetId.trim() : undefined,
      classification: typeof query.classification === 'string' ? query.classification.trim() : undefined,
      severity,
      limit: typeof query.limit === 'string' ? parseInt(query.limit, 10) || undefined : undefined,
      offset: typeof query.offset === 'string' ? parseInt(query.offset, 10) || undefined : undefined,
    });
    return okEnvelope(findings, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'LIST_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
