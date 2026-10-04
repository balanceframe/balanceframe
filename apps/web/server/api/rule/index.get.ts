import type { BudgetLedger } from '@balanceframe/actual-adapter';
import { setHeader } from 'h3';
import { requireFullRead } from '../../utils/legacy-financial-read';
import { requireSelectedSpace } from '../../utils/space-context';
import type { EventWithContext } from '../../utils/workflow-store';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  classifyConnectionError,
  sanitizeError,
} from '../../utils/workflow-store';
import { createMutationConnectionManager } from '../../utils/mutation-executor';

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const context = event as unknown as EventWithContext;
  const selected = await requireSelectedSpace(context);
  if (!selected.ok) return selected.response;
  const fullRead = await requireFullRead(context);
  if (!fullRead.ok) return fullRead.response;
  const authInfo = fullRead.info;
  const requestId = crypto.randomUUID();

  if (selected.space.budgetId !== fullRead.budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_CONNECTION_MISMATCH', 'The selected space connection is unavailable.', authInfo, false, requestId);
  }
  const workflow = getWorkflowStore(context);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Rule data is unavailable.', authInfo, false, requestId);
  }

  try {
    const manager = createMutationConnectionManager();
    return await manager.withConnection(async ({ connector, budget }) => {
      if (budget.id !== fullRead.budgetId) throw new Error('Selected budget changed');
      const rules = await (connector as unknown as BudgetLedger).listRules();
      const overrides = await workflow.store.getRuleOverrides({
        spaceId: selected.space.id,
        budgetId: fullRead.budgetId,
      });
      const items = rules.map((rule) => {
        const override = overrides.get(rule.id);
        const inactive = override?.inactive;
        return {
          ...rule,
          inactive: typeof inactive === 'boolean' ? inactive : rule.inactive,
          ...(typeof inactive === 'boolean' ? { _localOverride: true } : {}),
        };
      });
      return okEnvelope({ items, total: items.length }, authInfo, requestId);
    }, { expectedBudgetId: fullRead.budgetId, dispose: true });
  } catch (err) {
    const connectionError = classifyConnectionError(err);
    if (connectionError) {
      setResponseStatus(event, 503);
      return errorEnvelope(connectionError.code, connectionError.message, authInfo, connectionError.retryable, requestId);
    }
    const safe = sanitizeError(err, requestId, 'LEDGER_UNAVAILABLE', true);
    setResponseStatus(event, 503);
    return errorEnvelope(
      safe.code,
      `Failed to connect to Actual: ${safe.message}`,
      authInfo,
      safe.retryable,
      requestId,
    );
  }
});
