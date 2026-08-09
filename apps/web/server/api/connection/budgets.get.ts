import { defineEventHandler, setResponseStatus } from 'h3';
import { createDefaultConnectionManager } from '@balanceframe/application';
import {
  buildAuthorizationInfo,
  errorEnvelope,
  okEnvelope,
  sanitizeError,
} from '../../utils/workflow-store';

/** List Actual budgets available to the authenticated BalanceFrame user. */
export default defineEventHandler(async (event) => {
  const auth = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const budgets = await manager.listBudgets();
    return okEnvelope(
      {
        budgets: budgets.map((budget) => ({
          id: budget.id,
          groupId: budget.groupId,
          name: budget.name,
          encrypted: budget.encrypted,
        })),
      },
      auth,
      requestId,
    );
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'ACTUAL_BUDGET_LIST_FAILED', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, auth, safe.retryable, requestId);
  }
});
