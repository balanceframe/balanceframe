import type { BudgetLedger } from '@balanceframe/actual-adapter';
import type { ReviewActionAuthorization } from '@balanceframe/workflow-store';
import { createMutationConnectionManager } from './mutation-executor';
import { readBody, setHeader, setResponseStatus } from 'h3';
import { hasTrustedRequestOrigin } from './reauthentication';
import type { ReauthenticationEvent } from './reauthentication';
import { z } from 'zod';
import { requireSelectedSpace } from './space-context';
import { hasReviewScopeAdmission } from './review-scope-admission';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  performReviewAction,
} from './workflow-store';

const ReviewActionBody = z.object({ reviewId: z.string().trim().min(1).max(200) }).strict();

export async function handleReviewWorkflowAction(
  event: ReauthenticationEvent,
  action: 'reject' | 'skip' | 'undo',
) {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Review action is unavailable.', null, false, requestId);
  }

  const selected = await requireSelectedSpace(event);
  if (!selected.ok) return selected.response;
  if (
    selected.auth.method !== 'session' &&
    selected.auth.method !== 'human-session' &&
    !(selected.auth.method === 'api-key' && selected.auth.principalType === 'human')
  ) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Review action is unavailable.', null, false, requestId);
  }
  if (!selected.space.budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope(
      'SPACE_BUDGET_REQUIRED',
      'The selected space has no bound budget.',
      null,
      false,
      requestId,
    );
  }

  const parsedBody = ReviewActionBody.safeParse(await readBody(event));
  if (!parsedBody.success) {
    setResponseStatus(event, 400);
    return errorEnvelope(
      'INVALID_REVIEW_ACTION',
      'A valid reviewId is required.',
      null,
      false,
      requestId,
    );
  }

  const workflow = getWorkflowStore(event);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', workflow.error, null, false, requestId);
  }

  try {
    const item = await workflow.store.getReviewItem(parsedBody.data.reviewId);
    if (!item || item.budgetId !== selected.space.budgetId) {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Review item not found.', null, false, requestId);
    }
    const policy = workflow.store.governance.getPolicy({ spaceId: selected.space.id });
    const operation = action === 'reject' ? 'reject_review' : action === 'skip' ? 'skip_review' : 'undo_review';
    if (
      !policy || !hasReviewScopeAdmission({
        store: workflow.store,
        selected,
        item,
        capability: 'categorization:execute',
        phase: 'read',
        operation,
        policyVersion: policy.version,
      })
    ) {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Review item not found.', null, false, requestId);
    }

    const manager = createMutationConnectionManager({ configPath: process.env.BALANCEFRAME_CONFIG_PATH });
    const config = await manager.loadConfig();
    if (!config || config.budgetId !== selected.space.budgetId) {
      setResponseStatus(event, 409);
      return errorEnvelope('SPACE_CONNECTION_MISMATCH', 'The configured budget does not match the selected space.', null, false, requestId);
    }

    const outcome = await manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== selected.space.budgetId || connected.budget.id !== selected.space.budgetId)
        throw new Error('Selected space connection changed');
      const synchronized = await (connected.connector as unknown as BudgetLedger).synchronize();
      const transaction = synchronized.snapshot.transactions.find((row) => row.id === item.transactionId);
      if (!transaction) throw new Error('Current review transaction unavailable');
      const amount = BigInt(transaction.amount.minorUnits);
      const context: ReviewActionAuthorization = {
        spaceId: selected.space.id,
        policyVersion: policy.version,
        auth: selected.auth,
        transaction: {
          id: transaction.id,
          accountId: transaction.accountId,
          categoryId: transaction.categoryId ?? null,
          direction: amount < 0n ? 'outgoing' : 'incoming',
          amount: { minorUnits: (amount < 0n ? -amount : amount).toString(), currency: transaction.amount.currency },
        },
      };
      return performReviewAction(workflow.store, item.id, action, selected.auth.actorId, context);
    }, { expectedBudgetId: selected.space.budgetId, dispose: true });
    if (!outcome.success) {
      const notFound = outcome.error === 'Review item not found';
      const conflict = outcome.error?.startsWith('Version conflict') ?? false;
      setResponseStatus(event, notFound ? 404 : conflict ? 409 : 500);
      return errorEnvelope(
        notFound ? 'NOT_FOUND' : conflict ? 'VERSION_CONFLICT' : 'ACTION_FAILED',
        outcome.error ?? 'Review action failed.',
        null,
        false,
        requestId,
      );
    }

    return okEnvelope(
      {
        itemId: outcome.itemId,
        success: true,
        error: null,
        categorizationExecuted: false,
        mutationStatus: 'noop',
        applied: false,
        verified: false,
        stale: false,
        transactionId: null,
        previousCategoryId: null,
        newCategoryId: null,
      },
      null,
      requestId,
    );
  } catch (error) {
    if (error instanceof Error && error.cause === 'authorization_denied') {
      setResponseStatus(event, 403);
      return errorEnvelope('FORBIDDEN', 'Current exact review authority is unavailable.', null, false, requestId);
    }
    setResponseStatus(event, 500);
    return errorEnvelope(
      'REVIEW_ACTION_FAILED',
      'Review action could not be completed.',
      null,
      false,
      requestId,
    );
  }
}
