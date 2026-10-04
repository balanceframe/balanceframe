import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { createDefaultConnectionManager } from '@balanceframe/application';
import { requireRegisteredOwner } from '../../utils/legacy-financial-read';
import { requireSelectedSpace } from '../../utils/space-context';
import { getHumanControlAuth, type ReauthenticationEvent } from '../../utils/reauthentication';
import { updateReviewCategoryCatalog } from '../../utils/review-category-catalog';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';

const SelectBudgetBody = z.object({
  budgetId: z.string().trim().min(1).max(200),
  spaceId: z.string().trim().min(1).max(200).optional(),
}).strict();

/** Bind and connect only the selected space after scoped human control authorization. */
export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  const authorization = await requireAuthorization(
    event as unknown as EventWithContext,
    'connection:manage',
  );
  if (!authorization.ok) return authorization.response;
  const proof = await getHumanControlAuth(event as ReauthenticationEvent);
  if (!proof) {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'REAUTHENTICATION_REQUIRED',
      'A recently reauthenticated human session is required.',
      authorization.info,
      false,
      requestId,
    );
  }
  if (proof.actorId !== selected.auth.actorId) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Budget connection is not authorized.', authorization.info, false, requestId);
  }
  const owner = await requireRegisteredOwner(event as unknown as EventWithContext);
  if (!owner.ok) return owner.response;
  const body = SelectBudgetBody.safeParse(await readBody<unknown>(event).catch(() => null));
  if (!body.success) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'BUDGET_ID_REQUIRED',
      'Select an Actual budget before connecting.',
      authorization.info,
      false,
      requestId,
    );
  }
  const { budgetId, spaceId } = body.data;
  if (
    (spaceId !== undefined && spaceId !== selected.space.id) ||
    (selected.space.budgetId !== null && selected.space.budgetId !== budgetId)
  ) {
    setResponseStatus(event, 409);
    return errorEnvelope(
      'SPACE_CONNECTION_MISMATCH',
      'The requested budget does not match the selected space binding.',
      authorization.info,
      false,
      requestId,
    );
  }

  const wf = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Workflow store unavailable.', authorization.info, true, requestId);
  }
  try {
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    if (selected.space.budgetId === null) {
      const binding = wf.store.governance.getSpaceForBudget({ budgetId });
      if (binding && binding.id !== selected.space.id) throw new Error('Budget is already bound to a space');
      const budgets = await manager.listBudgets();
      if (!budgets.some((budget) => budget.id === budgetId)) throw new Error('Requested budget is unavailable');
      wf.store.governance.bindBudget({
        spaceId: selected.space.id,
        budgetId,
        now: new Date().toISOString(),
        auth: proof,
      });
    }
    const connected = await manager.connect({ budgetId });
    if (connected.budget.id !== budgetId || connected.config.budgetId !== budgetId)
      throw new Error('Connected budget mismatch');
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
      authorization.info,
      requestId,
    );
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'ACTUAL_BUDGET_CONNECT_FAILED', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
});
