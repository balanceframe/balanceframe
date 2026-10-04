import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import { createDefaultConnectionManager } from '@balanceframe/application';
import { requireRegisteredOwner } from '../../utils/legacy-financial-read';
import { requireSelectedSpace } from '../../utils/space-context';
import { getHumanControlAuth, type ReauthenticationEvent } from '../../utils/reauthentication';
import {
  errorEnvelope,
  okEnvelope,
  sanitizeError,
  requireAuthorization,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';

/** Discover Actual budgets only for a reauthenticated instance owner with selected-space control. */
export default defineEventHandler(async (event) => {
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
    );
  }
  if (proof.actorId !== selected.auth.actorId) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Budget discovery is not authorized.', authorization.info);
  }
  const owner = await requireRegisteredOwner(event as unknown as EventWithContext);
  if (!owner.ok) return owner.response;
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
      authorization.info,
      requestId,
    );
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'ACTUAL_BUDGET_LIST_FAILED', true);
    setResponseStatus(event, 503);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
});
