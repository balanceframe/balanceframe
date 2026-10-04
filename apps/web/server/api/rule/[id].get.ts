import type { BudgetLedger } from '@balanceframe/actual-adapter';
import { setHeader } from 'h3';
import { z } from 'zod';
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

const RuleId = z.string().trim().min(1).max(200);

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store');
  const context = event as unknown as EventWithContext;
  const selected = await requireSelectedSpace(context);
  if (!selected.ok) return selected.response;
  const fullRead = await requireFullRead(context);
  if (!fullRead.ok) return fullRead.response;
  const authInfo = fullRead.info;
  const requestId = crypto.randomUUID();

  const rawParams = event.context.params as Record<string, unknown> | undefined;
  const parsedId = RuleId.safeParse(rawParams?.id);
  if (!parsedId.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_RULE_ID', 'Rule ID is required.', authInfo, false, requestId);
  }
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
      const current = rules.find((rule) => rule.id === parsedId.data);
      if (!current) {
        setResponseStatus(event, 404);
        return errorEnvelope('RULE_NOT_FOUND', 'Rule not found.', authInfo, false, requestId);
      }
      const override = await workflow.store.getRuleOverride({
        spaceId: selected.space.id,
        budgetId: fullRead.budgetId,
        ruleId: current.id,
      });
      const inactive = override?.inactive;
      return okEnvelope({
        ...current,
        inactive: typeof inactive === 'boolean' ? inactive : current.inactive,
        ...(typeof inactive === 'boolean' ? { _localOverride: true } : {}),
      }, authInfo, requestId);
    }, { expectedBudgetId: fullRead.budgetId, dispose: true });
  } catch (error) {
    if (event.node.res.headersSent) throw error;
    const connectionError = classifyConnectionError(error);
    if (connectionError) {
      setResponseStatus(event, 503);
      return errorEnvelope(connectionError.code, connectionError.message, authInfo, connectionError.retryable, requestId);
    }
    const safe = sanitizeError(error, requestId, 'RULE_SHOW_FAILED', true);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, authInfo, safe.retryable, requestId);
  }
});
