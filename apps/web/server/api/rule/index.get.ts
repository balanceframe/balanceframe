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

import type { RuleListItem } from '../../utils/rule-types';
import { getLedgerFromEvent } from '../../utils/rule-types';
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

  const ledger = getLedgerFromEvent(event);
  if (!ledger) {
    setResponseStatus(event, 503);
    return errorEnvelope(
      'LEDGER_UNAVAILABLE',
      'No ledger connection available. Connect to a budget before listing rules.',
      authInfo,
      true,
      requestId,
    );
  }

  try {
    const rules: RuleListItem[] = await ledger.listRules();

    return okEnvelope(
      { items: rules, total: rules.length },
      authInfo,
      requestId,
    );
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'RULE_LIST_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
      true,
      requestId,
    );
  }
});
