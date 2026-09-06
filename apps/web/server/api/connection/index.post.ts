import { requireRegisteredOwner } from '../../utils/legacy-financial-read';
import { defineEventHandler, readBody, setResponseStatus } from 'h3';
import { createDefaultConnectionManager } from '@balanceframe/application';
import { errorEnvelope, okEnvelope, sanitizeError } from '../../utils/workflow-store';
import { updateReviewCategoryCatalog } from '../../utils/review-category-catalog';

interface SelectBudgetBody {
  budgetId?: unknown;
}

/** Select, synchronize, and persist an Actual budget connection. */
export default defineEventHandler(async (event) => {
  const owner = await requireRegisteredOwner(event);
  if (!owner.ok) return owner.response;
  const auth = owner.info;
  const requestId = crypto.randomUUID();
  const body = await readBody<SelectBudgetBody>(event);
  const budgetId = typeof body?.budgetId === 'string' ? body.budgetId.trim() : '';

  if (!budgetId) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'BUDGET_ID_REQUIRED',
      'Select an Actual budget before connecting.',
      auth,
      false,
      requestId,
    );
  }

  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const connected = await manager.connect({ budgetId });
    updateReviewCategoryCatalog(connected.config, connected.synchronization);
    return okEnvelope(
      {
        connected: true,
        budget: {
          id: connected.budget.id,
          groupId: connected.budget.groupId,
          name: connected.budget.name,
          encrypted: connected.budget.encrypted,
        },
      },
      auth,
      requestId,
    );
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'ACTUAL_BUDGET_CONNECT_FAILED', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, auth, safe.retryable, requestId);
  }
});
