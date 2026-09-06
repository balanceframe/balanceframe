/**
 * GET /api/findings — list findings.
 *
 * Read-only with respect to ledger data (finding state is separate).
 * Query params: status, budgetId, classification, severity, limit, offset
 * Response envelope: Finding[]
 */

import type { FindingStatus } from '@balanceframe/workflow-store';
import { createDefaultConnectionManager } from '@balanceframe/application';
import { canReadFinancialFinding } from '../../utils/liquidity-service';
import { defineEventHandler, getQuery, setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
  sanitizeError,
  getActorId,
  requireAuthorization,
} from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();
  const query = getQuery(event);

  const statusRaw = typeof query.status === 'string' ? query.status.trim() : undefined;
  if (
    statusRaw !== undefined &&
    ![
      'open',
      'acknowledged',
      'corrected',
      'dismissed',
      'reopened',
      'superseded',
      'expired',
    ].includes(statusRaw)
  ) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_STATUS',
      `Invalid status "${statusRaw}". Allowed: open, acknowledged, corrected, dismissed, reopened, superseded, expired.`,
      authInfo,
      false,
      requestId,
    );
  }

  const severityRaw = typeof query.severity === 'string' ? query.severity.trim() : undefined;
  if (severityRaw !== undefined && !['low', 'medium', 'high', 'critical'].includes(severityRaw)) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_SEVERITY',
      `Invalid severity "${severityRaw}". Allowed: low, medium, high, critical.`,
      authInfo,
      false,
      requestId,
    );
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const config = await manager.loadConfig();
    if (!config?.budgetId) throw new Error('Selected budget unavailable');
    const auth = await requireAuthorization(event, 'observe', `budget:${config.budgetId}`);
    if (!auth.ok) return auth.response;
    if (typeof query.budgetId === 'string' && query.budgetId.trim() !== config.budgetId) {
      setResponseStatus(event, 400);
      return errorEnvelope(
        'INVALID_BUDGET_SCOPE',
        'Use the selected budget.',
        auth.info,
        false,
        requestId,
      );
    }
    const status = statusRaw as unknown as FindingStatus | undefined;
    const severity = severityRaw as unknown as 'low' | 'medium' | 'high' | 'critical' | undefined;
    const limit = Math.max(
      0,
      typeof query.limit === 'string' ? parseInt(query.limit, 10) || 50 : 50,
    );
    const offset = Math.max(
      0,
      typeof query.offset === 'string' ? parseInt(query.offset, 10) || 0 : 0,
    );
    const classification =
      typeof query.classification === 'string' ? query.classification.trim() : undefined;
    const visible = [];
    let visibleIndex = 0;
    for (let storeOffset = 0; visible.length < limit; storeOffset += 500) {
      const findings = await wf.store.listFindings({
        status,
        budgetId: config.budgetId,
        limit: 500,
        offset: storeOffset,
      });
      for (const finding of findings) {
        if (
          (classification && finding.classification !== classification) ||
          (severity && finding.severity !== severity)
        )
          continue;
        if (!(await canReadFinancialFinding(wf.store, getActorId(event), finding))) continue;
        if (visibleIndex++ < offset) continue;
        visible.push(finding);
        if (visible.length === limit) break;
      }
      if (findings.length < 500) break;
    }
    return okEnvelope(visible, authInfo, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'LIST_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
