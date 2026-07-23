/**
 * PATCH /api/rule/[id] — update a rule's inactive state in the Actual ledger.
 *
 * Uses the ledger's updateRule method to persist the change, then
 * synchronises and re-reads the rule to verify the new state took effect.
 * On success the local override (if any) is cleared since the Actual state
 * now matches the desired value.
 *
 * Returns a structured error when the ledger is unreachable, the rule is
 * not found, or the write verification fails.
 */

import { readBody, setResponseStatus } from 'h3';
import type { LedgerHandle, RuleOperationResult, RuleShowResult } from '../../utils/rule-types';
import { createMutationConnectionManager } from '../../utils/mutation-executor';
import {
  getWorkflowStore, okEnvelope, errorEnvelope, requireAuthorization, buildAuthorizationInfo, sanitizeError,
} from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  const authCheck = await requireAuthorization(event, 'rule.execute');
  if (!authCheck.ok) return authCheck.response;
  const authInfo = authCheck.info;

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

  // Verify the rule exists before attempting the update
  let allRules: RuleShowResult[];
  try {
    allRules = (await ledger.listRules()) as RuleShowResult[];
  } catch (err) {
    const safe = sanitizeError(err, requestId, 'LEDGER_READ_FAILED', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }

  const existing = allRules.find((r) => r.id === ruleId);
  if (!existing) {
    setResponseStatus(event, 404);
    return errorEnvelope('RULE_NOT_FOUND', `Rule not found: ${ruleId}`, authInfo, false, requestId);
  }

  // Persist the change to the Actual ledger
  let mutateResult: RuleOperationResult;
  try {
    mutateResult = await ledger.updateRule(ruleId, { inactive: body.inactive });
  } catch (err) {
    const safe = sanitizeError(err, requestId, 'RULE_UPDATE_FAILED', true);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }

  if (!mutateResult.success) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      mutateResult.code || 'RULE_UPDATE_FAILED',
      mutateResult.error || 'Ledger reported that the rule was not updated.',
      authInfo,
      true,
      requestId,
    );
  }

  // Synchronise and re-read to verify the change took effect
  try {
    await ledger.synchronize();
  } catch {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'SYNC_FAILED',
      'Write succeeded but post-write synchronisation failed — the change may not be reflected.',
      authInfo,
      true,
      requestId,
    );
  }

  try {
    allRules = (await ledger.listRules()) as RuleShowResult[];
  } catch {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'VERIFICATION_FAILED',
      'Write succeeded but re-read verification could not confirm the new state.',
      authInfo,
      true,
      requestId,
    );
  }

  const verified = allRules.find((r) => r.id === ruleId);
  if (!verified) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'VERIFICATION_FAILED',
      'Rule disappeared after update — possible concurrent deletion.',
      authInfo,
      false,
      requestId,
    );
  }

  // Verify the postcondition: the ledger-reported inactive field must match
  if (verified.inactive !== body.inactive) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'RULE_UPDATE_FAILED',
      `Update appeared to succeed but verification shows inactive=${verified.inactive} instead of requested ${body.inactive}.`,
      authInfo,
      true,
      requestId,
    );
  }

  // Clear any stale local override since Actual state now matches
  try {
    await wf.store.removeRuleOverride(ruleId);
  } catch {
    // Non-fatal: the override will be cleaned up on next read
  }

  return okEnvelope({
    id: ruleId,
    inactive: verified.inactive,
    verified: true,
  }, authInfo, requestId);
});
