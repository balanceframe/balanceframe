/**
 * GET /api/rule — list all automation rules from the connected ledger.
 *
 * Lists rules from the active ledger connection.  The store guard verifies
 * the workflow DB is initialised; actual rule data comes from the ledger
 * adapter injected into the event context by the lifecycle plugin.
 *
 * When no ledger is connected the route returns LEDGER_UNAVAILABLE so the
 * UI can surface a clear connection-needed state.
 *
 * Response envelope:
 *   { items: RuleListItem[], total: number }
 */

import type { RuleListItem, LedgerHandle } from '../../utils/rule-types';
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

    const rules: RuleListItem[] = await ledger.listRules();

    // Merge local rule overrides (inactive toggle state) on top of Actual's
    // data.  The Actual sync protocol does not support updating rule fields,
    // so we store toggle state in the workflow DB.
    const overrides = await wf.store.getRuleOverrides();
    if (overrides.size > 0) {
      for (const rule of rules) {
        const overrideInactive = overrides.get(rule.id);
        if (overrideInactive !== undefined) {
          (rule as unknown as Record<string, unknown>).inactive = overrideInactive;
        }
      }
    }

    return okEnvelope(
      { items: rules, total: rules.length },
      authInfo,
      requestId,
    );
  } catch (err) {
    setResponseStatus(event, 503);
    return errorEnvelope(
      'LEDGER_UNAVAILABLE',
      `Failed to connect to Actual: ${err instanceof Error ? err.message : String(err)}`,
      authInfo,
      true,
      requestId,
    );
  }

});
