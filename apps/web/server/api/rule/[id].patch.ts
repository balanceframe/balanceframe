/** PATCH /api/rule/[id] — toggle a rule's inactive state in local store. */
import { setResponseStatus } from 'h3';
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

  if (body.inactive === undefined) {
    setResponseStatus(event, 422);
    return errorEnvelope('INVALID_FIELD', 'inactive field is required.', authInfo, false, requestId);
  }
  if (typeof body.inactive !== 'boolean') {
    setResponseStatus(event, 422);
    return errorEnvelope('INVALID_FIELD', 'inactive must be a boolean.', authInfo, false, requestId);
  }

  try {
    await wf.store.setRuleOverride(ruleId, body.inactive);
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
