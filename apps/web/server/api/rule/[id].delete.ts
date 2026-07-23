/**
 * DELETE /api/rule/[id] — delete an automation rule from the Actual ledger.
 *
 * Checks the structured connector result rather than a bare boolean, then
 * synchronises and re-reads rule state to verify the rule is truly absent.
 * The local override (if any) is removed only after confirmed deletion.
 *
 * Returns a structured error when the ledger is unreachable, the rule
 * cannot be deleted (e.g. referenced by a schedule), or the post-delete
 * verification fails.
 */

import { setResponseStatus } from 'h3';
import type { LedgerHandle, RuleOperationResult, RuleListItem } from '../../utils/rule-types';
import { createMutationConnectionManager } from '../../utils/mutation-executor';
import {
  getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo, sanitizeError,
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

  let ledger: LedgerHandle;
  try {
    const manager = createMutationConnectionManager();
    const connected = await manager.restore();
    ledger = connected.connector as unknown as LedgerHandle;
  } catch (err) {
    const safe = sanitizeError(err, requestId, 'LEDGER_UNAVAILABLE', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }

  // Attempt the deletion on the ledger
  let mutateResult: RuleOperationResult;
  try {
    mutateResult = await ledger.deleteRule(ruleId);
  } catch (err) {
    const safe = sanitizeError(err, requestId, 'RULE_DELETE_FAILED', true);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }

  if (!mutateResult.success) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      mutateResult.code || 'RULE_DELETE_FAILED',
      mutateResult.error || 'Ledger reported that the rule was not deleted.',
      authInfo,
      mutateResult.code === 'RULE_HAS_SCHEDULE' ? false : true,
      requestId,
    );
  }

  // Synchronise and re-read to verify the rule is actually gone
  try {
    await ledger.synchronize();
  } catch {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'SYNC_FAILED',
      'Delete succeeded but post-delete synchronisation failed — the rule may still exist.',
      authInfo,
      true,
      requestId,
    );
  }

  let remaining: RuleListItem[];
  try {
    remaining = await ledger.listRules();
  } catch {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'VERIFICATION_FAILED',
      'Delete succeeded but re-read verification could not confirm absence.',
      authInfo,
      true,
      requestId,
    );
  }

  const stillPresent = remaining.find((r) => r.id === ruleId);
  if (stillPresent) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'VERIFICATION_FAILED',
      'Rule still present after delete — the ledger may have experienced a conflict.',
      authInfo,
      true,
      requestId,
    );
  }

  // Remove local override only after verified deletion
  try {
    await wf.store.removeRuleOverride(ruleId);
  } catch {
    // Non-fatal: stale override will be cleaned up on next read
  }

  return okEnvelope({ deleted: true, id: ruleId }, authInfo, requestId);
});
