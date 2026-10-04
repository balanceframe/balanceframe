import { createDefaultConnectionManager, createNativeRuleMutationProtocol } from '@balanceframe/application';
import type { RustRuleMutationProtocol } from '@balanceframe/application';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { projectReviewQueueItem, ReviewSynchronization } from '../../utils/review-projection';
import { selectedLiquidityActor } from '../../utils/liquidity-service';
import { hasTrustedRequestOrigin } from '../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../utils/reauthentication';
import { createRuleProposal } from '../../utils/rule-create';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireProposalAuthorization,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';
import { buildProposalApprovalView } from '../../utils/proposal-approval-view';
import { hasReviewProjectionAdmission, hasReviewScopeAdmission } from '../../utils/review-scope-admission';

const ProposeRuleBody = z.object({
  reviewId: z.string().trim().min(1).max(200),
  categoryId: z.string().trim().min(1).max(200),
}).strict();
export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as unknown as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Rule proposal is unavailable.', null, false, requestId);
  }
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  const budgetId = selected.space.budgetId;
  if (!budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }
  const authorization = await requireProposalAuthorization(
    event as unknown as EventWithContext,
    'rule:propose',
    `budget:${budgetId}`,
    'create_rule',
  );
  if (!authorization.ok) return authorization.response;
  const body = ProposeRuleBody.safeParse(await readBody<unknown>(event).catch(() => null));
  if (!body.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_RULE_PROPOSAL', 'Review ID and category ID are required.', authorization.info, false, requestId);
  }
  const categoryAuthorization = await requireProposalAuthorization(
    event as unknown as EventWithContext,
    'rule:propose',
    `category:${body.data.categoryId}`,
    'create_rule',
  );
  if (!categoryAuthorization.ok) return categoryAuthorization.response;

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Rule proposal is unavailable.', authorization.info, false, requestId);
  }
  try {
    const review = await workflow.store.getReviewItem(body.data.reviewId);
    if (!review || review.budgetId !== budgetId ||
        (review.status !== 'pending_review' && review.status !== 'correcting')) {
      setResponseStatus(event, 404);
      return errorEnvelope('REVIEW_NOT_FOUND', 'Review item not found.', authorization.info, false, requestId);
    }
    const actor = selectedLiquidityActor(workflow.store, selected);
    if (!actor) {
      setResponseStatus(event, 403);
      return errorEnvelope('FORBIDDEN', 'Current selected-space authorization is unavailable.', authorization.info, false, requestId);
    }

    const policy = workflow.store.governance.getPolicy({ spaceId: selected.space.id });
    if (
      !policy ||
      !hasReviewScopeAdmission({
        store: workflow.store,
        selected,
        item: review,
        capability: 'rule:propose',
        phase: 'propose',
        operation: 'create_rule',
        policyVersion: policy.version,
        targetCategoryId: body.data.categoryId,
      }) ||
      !hasReviewProjectionAdmission({
        store: workflow.store,
        actor,
        item: review,
        targetCategoryId: body.data.categoryId,
      })
    ) {
      setResponseStatus(event, 404);
      return errorEnvelope('REVIEW_NOT_FOUND', 'Review item not found.', authorization.info, false, requestId);
    }
    const manager = createDefaultConnectionManager({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    const config = await manager.loadConfig();
    if (!config || config.budgetId !== budgetId) {
      setResponseStatus(event, 409);
      return errorEnvelope('SPACE_CONNECTION_MISMATCH', 'The configured budget does not match the selected space.', authorization.info, false, requestId);
    }

    let native: RustRuleMutationProtocol;
    try {
      native = await createNativeRuleMutationProtocol();
    } catch {
      setResponseStatus(event, 501);
      return errorEnvelope('NATIVE_UNAVAILABLE', 'Native rule planning is unavailable.', authorization.info, false, requestId);
    }

    const proposal = await manager.withConnection(async (connected) => {
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId)
        throw new Error('Selected budget changed');
      const synchronization = ReviewSynchronization.parse(connected.synchronization);
      const snapshot = synchronization.financialSnapshot.legacySnapshot;
      const current = projectReviewQueueItem(workflow.store, actor, review, snapshot);
      const category = snapshot.categories.find((row) => row.id === body.data.categoryId);
      if (!current || !category ||
          !workflow.store.liquidity.isAuthorized({
            ...actor,
            resourceKind: 'category',
            resourceId: category.id,
            capability: 'existence',
          }))
        throw new Error('Current review facts are unavailable');

      const merchant = current.evidence.normalizedMerchant.trim();
      if (!merchant) throw new Error('Review has no current merchant');
      const { snapshot: snapshotValue } = z.object({
        snapshot: z.unknown(),
      }).passthrough().parse(connected.synchronization);
      const canonicalSnapshot = canonicalProtocolSnapshotSchema.parse(snapshotValue);
      const transaction = canonicalSnapshot.transactions.find((row) => row.id === review.transactionId);
      if (!transaction) throw new Error('Current review transaction is unavailable');
      const name = `Auto-rule for ${merchant}`;
      const nativePlan = native.planCreateRule({
        name,
        conditions: [{ field: 'payee_name', op: 'is', value: merchant }],
        actions: [{ type: 'set-category', field: 'category', value: category.id }],
        budgetId,
        stage: 'post',
        conditionsOp: 'and',
      }, canonicalSnapshot);
      return createRuleProposal({
        store: workflow.store,
        spaceId: selected.space.id,
        budgetId,
        actorId: selected.auth.actorId,
        auth: selected.auth,
        origin: { kind: 'review', reviewId: review.id },
        correlationId: requestId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        actualVersion: canonicalSnapshot.actualVersion,
        snapshotSchemaVersion: canonicalSnapshot.schemaVersion,
        name,
        payee: merchant,
        categoryId: category.id,
        nativePlan,
        transaction,
      });
    }, { expectedBudgetId: budgetId, dispose: true });

    const proposalView = await buildProposalApprovalView({
      store: workflow.store,
      proposal,
      actorId: selected.auth.actorId,
      auth: selected.auth,
      now: new Date().toISOString(),
      requestId,
    });
    if (!proposalView) {
      setResponseStatus(event, 409);
      return errorEnvelope('PROPOSAL_UNAVAILABLE', 'A current rule proposal could not be read.', authorization.info, false, requestId);
    }
    return okEnvelope({
      proposal: proposalView,
      simulationStatus: 'missing',
      simulationWarning: null,
    }, authorization.info, requestId);
  } catch {
    setResponseStatus(event, 409);
    return errorEnvelope('PROPOSAL_UNAVAILABLE', 'A current rule proposal could not be created.', authorization.info, false, requestId);
  }
});
