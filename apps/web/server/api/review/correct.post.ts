import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { hasTrustedRequestOrigin } from '../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../utils/reauthentication';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  applyReviewMutationWithTransition,
  errorEnvelope,
  getReviewMutationExecutorFromEvent,
  getWorkflowStore,
  okEnvelope,
  requireProposalAuthorization,
  sanitizeError,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';
import { buildProposalApprovalView } from '../../utils/proposal-approval-view';
import { hasReviewScopeAdmission } from '../../utils/review-scope-admission';

const Body = z.object({
  reviewId: z.string().trim().min(1).max(200),
  categoryId: z.string().trim().min(1).max(200),
}).strict();

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as unknown as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Review proposal is unavailable.', null, false, requestId);
  }
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  if (!selected.space.budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }
  const authorization = await requireProposalAuthorization(
    event as unknown as EventWithContext,
    'categorization:propose',
    `budget:${selected.space.budgetId}`,
    'set_category',
  );
  if (!authorization.ok) return authorization.response;

  const parsed = Body.safeParse(await readBody<unknown>(event).catch(() => null));
  if (!parsed.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_REVIEW_CORRECTION', 'Review ID and category ID are required.', authorization.info, false, requestId);
  }
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Review proposal is unavailable.', authorization.info, false, requestId);
  }
  const item = await workflow.store.getReviewItem(parsed.data.reviewId);
  if (!item || item.budgetId !== selected.space.budgetId) {
    setResponseStatus(event, 404);
    return errorEnvelope('NOT_FOUND', 'Review item not found.', authorization.info, false, requestId);
  }
  const policy = workflow.store.governance.getPolicy({ spaceId: selected.space.id });
  if (!policy || !hasReviewScopeAdmission({
    store: workflow.store,
    selected,
    item,
    capability: 'categorization:propose',
    phase: 'propose',
    operation: 'set_category',
    policyVersion: policy.version,
    targetCategoryId: parsed.data.categoryId,
  })) {
    setResponseStatus(event, 404);
    return errorEnvelope('NOT_FOUND', 'Review item not found.', authorization.info, false, requestId);
  }
  if (item.status !== 'pending_review') {
    setResponseStatus(event, 404);
    return errorEnvelope('NOT_FOUND', 'Review item not found.', authorization.info, false, requestId);
  }
  const executor = getReviewMutationExecutorFromEvent(event as unknown as EventWithContext);
  if (!executor) {
    setResponseStatus(event, 503);
    return errorEnvelope('NATIVE_UNAVAILABLE', 'Native proposal service is unavailable.', authorization.info, false, requestId);
  }

  try {
    const pending = await applyReviewMutationWithTransition(
      workflow.store,
      item.id,
      selected.auth.actorId,
      executor,
      requestId,
      parsed.data.categoryId,
    );
    const result = pending.mutationResult;
    if (pending.disposition !== 'approval_required') {
      if (result.disposition === 'denied') {
        setResponseStatus(event, 404);
        return errorEnvelope('NOT_FOUND', 'Review item not found.', authorization.info, false, requestId);
      }
      setResponseStatus(event, result.disposition === 'native_unavailable' ? 503 : 409);
      return errorEnvelope(
        result.disposition === 'native_unavailable' ? 'NATIVE_UNAVAILABLE' : 'PROPOSAL_DENIED',
        result.error ?? 'Native proposal was not admitted.',
        authorization.info,
        false,
        requestId,
      );
    }
    if (!result.proposalId) {
      setResponseStatus(event, 409);
      return errorEnvelope('PROPOSAL_UNAVAILABLE', 'The exact proposal is unavailable.', authorization.info, false, requestId);
    }
    const proposal = await workflow.store.getProposal(result.proposalId);
    if (
      !proposal ||
      proposal.spaceId !== selected.space.id ||
      proposal.budgetId !== selected.space.budgetId ||
      proposal.operation !== 'set_category'
    ) {
      setResponseStatus(event, 409);
      return errorEnvelope('PROPOSAL_UNAVAILABLE', 'The exact proposal is unavailable.', authorization.info, false, requestId);
    }
    const proposalView = buildProposalApprovalView({
      store: workflow.store,
      proposal,
      actorId: selected.auth.actorId,
      auth: selected.auth,
      now: new Date().toISOString(),
      requestId,
    });
    if (!proposalView) {
      setResponseStatus(event, 409);
      return errorEnvelope('PROPOSAL_UNAVAILABLE', 'The exact proposal is unavailable.', authorization.info, false, requestId);
    }
    return okEnvelope({
      itemId: item.id,
      categoryId: parsed.data.categoryId,
      success: false,
      error: null,
      status: pending.finalStatus,
      mutationStatus: 'approval_required',
      disposition: 'approval_required',
      approvalRequired: true,
      categorizationExecuted: false,
      applied: false,
      verified: false,
      stale: false,
      proposal: proposalView,
    }, authorization.info, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'PROPOSAL_FAILED', false);
    setResponseStatus(event, safe.code === 'not_connected' ? 503 : 409);
    return errorEnvelope(safe.code, safe.message, authorization.info, safe.retryable, requestId);
  }
});
