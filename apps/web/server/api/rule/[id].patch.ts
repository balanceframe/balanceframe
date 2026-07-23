/** PATCH /api/rule/[id] — update a rule (toggle inactive, rename, etc). */
import { setResponseStatus } from 'h3';
import type { LedgerHandle } from '../../utils/rule-types';
import { createMutationConnectionManager } from '../../utils/mutation-executor';
import {
  getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo,
} from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'rule.execute');
  const requestId = crypto.randomUUID();

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  const ruleId = event.context.params?.id;
  if (!ruleId) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_RULE_ID', 'Rule ID is required.', authInfo, false, requestId);
  }

  let body: Record<string, unknown>;
  try {
    body = await readBody(event);
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_BODY', 'Request body must be valid JSON.', authInfo, false, requestId);
  }

  if (body.inactive !== undefined && typeof body.inactive !== 'boolean') {
    setResponseStatus(event, 422);
    return errorEnvelope('INVALID_FIELD', 'inactive must be a boolean.', authInfo, false, requestId);
  }

  try {
    const manager = createMutationConnectionManager();
    const connected = await manager.restore();
    const ledger = connected.connector as unknown as LedgerHandle;
    const result = await ledger.updateRule(ruleId, body);
    // Check for silent failure (MutationResult with success: false)
    if (typeof result === 'object' && result !== null && 'success' in result && !result.success) {
      const msg = (result as { error?: string }).error ?? 'Update failed without message';
      setResponseStatus(event, 500);
      return errorEnvelope('RULE_UPDATE_FAILED', msg, authInfo, true, requestId);
    }
    return okEnvelope({ updated: true }, authInfo, requestId);
  } catch (err) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'RULE_UPDATE_FAILED',
      err instanceof Error ? err.message : String(err),
      authInfo,
      true,
      requestId,
    );
  }
});
