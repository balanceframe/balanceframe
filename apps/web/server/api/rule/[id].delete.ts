/** DELETE /api/rule/[id] — delete an automation rule. */
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

  try {
    const manager = createMutationConnectionManager();
    const connected = await manager.restore();
    const ledger = connected.connector as unknown as LedgerHandle;
    await ledger.deleteRule(ruleId);
    return okEnvelope({ deleted: true }, authInfo, requestId);
  } catch (err) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'RULE_DELETE_FAILED',
      err instanceof Error ? err.message : String(err),
      authInfo,
      true,
      requestId,
    );
  }
});
