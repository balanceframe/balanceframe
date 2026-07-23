/**
 * GET /api/rule/[id] — show a single automation rule by ID.
 *
 * Looks up the rule from the connected ledger.  The store guard verifies
 * the workflow DB is initialised; the rule is fetched from the ledger
 * adapter injected into the event context by the lifecycle plugin.
 *
 * Response envelope carries the full RuleShowResult shape including
 * trigger and action configuration.
 */

import type { RuleShowResult, LedgerHandle } from '../../utils/rule-types';
import { createMutationConnectionManager } from '../../utils/mutation-executor';
import {
  getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo,
} from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const manager = createMutationConnectionManager();
    const connected = await manager.restore();
    const ledger = connected.connector as unknown as LedgerHandle;

    const allRules = (await ledger.listRules()) as RuleShowResult[];
    const routeId = event.context.params?.id;
    if (!routeId) {
      setResponseStatus(event, 400);
      return errorEnvelope('MISSING_RULE_ID', 'Rule ID is required.', authInfo, false, requestId);
    }

    const rule: RuleShowResult | undefined = allRules.find((r) => r.id === routeId);

    if (!rule) {
      setResponseStatus(event, 404);
      return errorEnvelope('RULE_NOT_FOUND', `Rule not found: ${routeId}`, authInfo, false, requestId);
    }

    return okEnvelope(rule, authInfo, requestId);
  } catch (e) {
    if (event.node.res.headersSent) throw e;
    setResponseStatus(event, 500);
    return errorEnvelope(
      'RULE_SHOW_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
      true,
      requestId,
    );
  }
});
