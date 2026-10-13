import { createDefaultConnectionManager, createMerchantIntelligenceService, createNativeRuleMutationProtocol, indexCanonicalTransactions, merchantReviewProofSchema } from '@balanceframe/application';
import type { RustRuleMutationProtocol } from '@balanceframe/application';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { defineEventHandler, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { projectReviewQueueItem, ReviewSynchronization } from '../../utils/review-projection';
import { selectedLiquidityActor } from '../../utils/liquidity-service';
import { hasTrustedRequestOrigin } from '../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../utils/reauthentication';
import { createRuleProposal, hasNativeRuleSourceAdmission } from '../../utils/rule-create';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
  requireProposalAuthorization,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';
import { buildProposalApprovalView } from '../../utils/proposal-approval-view';
import { composeScenarioResearch } from '../../utils/scenario-research';
import { hasReviewProjectionAdmission, hasReviewScopeAdmission, matchesReviewTransaction, reviewConnectionScope } from '../../utils/review-scope-admission';

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
  let committedProposalId: string | null = null;
  let publicationAuthority: (() => boolean) | null = null;
  const assertPublicationCurrent = () => {
    if (!publicationAuthority || !publicationAuthority())
      throw new Error('Current rule publication authority is unavailable');
  };
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
    if (!await hasNativeRuleSourceAdmission(workflow.store,actor,'rule:propose')) {
      setResponseStatus(event,403);
      return errorEnvelope('FORBIDDEN','Complete global rule and source authority is unavailable.',authorization.info,false,requestId);
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

    const sourceService = await createMerchantIntelligenceService({ store:workflow.store,connectionManager:manager,research:composeScenarioResearch(event,selected.space.id) });
    const captured = await manager.withConnection(async (connected) => {
      const scope = reviewConnectionScope(selected.space.id, connected.config);
      if (connected.config.budgetId !== budgetId || connected.budget.id !== budgetId ||
          !hasReviewScopeAdmission({
            store: workflow.store, selected, item: review, capability: 'rule:propose', phase: 'propose',
            operation: 'create_rule', policyVersion: policy.version, targetCategoryId: body.data.categoryId,
            connectionId: scope.connectionId,
          }))
        throw new Error('Selected Review namespace or authority changed');
      const captured = await connected.connector.synchronize({ refresh:true });
      const synchronization = ReviewSynchronization.parse(captured);
      const sdkCapture = z.object({
        snapshot:z.unknown(),rulePlanningSourceAvailability:z.unknown().optional(),
      }).passthrough().parse(captured);
      const canonicalSnapshot = canonicalProtocolSnapshotSchema.parse(sdkCapture.snapshot);
      const transaction = indexCanonicalTransactions(canonicalSnapshot.transactions).get(review.transactionId);
      const category = canonicalSnapshot.categories.find((row) => row.id === body.data.categoryId && !row.deleted);
      const payee = transaction?.payeeId && canonicalSnapshot.payees.find((row) => row.id === transaction.payeeId);
      if (!transaction || !category || !payee || !matchesReviewTransaction(review, transaction))
        throw new Error('Current native rule source identities are unavailable');
      const current = projectReviewQueueItem(workflow.store,actor,review,{
        ...synchronization.financialSnapshot.legacySnapshot,transactions:[transaction],
      }, undefined, undefined, undefined, scope);
      if (!current || !workflow.store.liquidity.isAuthorized({
        ...actor,now:new Date().toISOString(),resourceKind:'category',resourceId:category.id,capability:'existence',
      })) throw new Error('Current review facts are unavailable');
      const merchantProof = review.evidence.merchantProof === undefined ? null
        : merchantReviewProofSchema.parse(review.evidence.merchantProof);
      if ((review.classifier === 'merchant') !== (merchantProof !== null) ||
          (review.evidence.merchantEvidence !== undefined && merchantProof === null) ||
          (merchantProof && (merchantProof.evidenceKey !== `merchant:transaction:${transaction.id}` ||
            merchantProof.transactionId !== transaction.id || merchantProof.accountId !== transaction.accountId ||
            merchantProof.categoryId !== review.categoryId)))
        throw new Error('Current merchant Review evidence is unavailable');
      const currentContext = await sourceService.getCurrentRuleReviewContext({ ...actor,spaceId:selected.space.id,auth:selected.auth },{
        evidenceKey:merchantProof?.evidenceKey ?? null,connected,snapshot:canonicalSnapshot,
        sourceAvailability:sdkCapture.rulePlanningSourceAvailability,
        capturePublicationAuthority: (authorize) => {
          if (publicationAuthority || typeof authorize !== 'function')
            throw new Error('Current rule publication authority is unavailable');
          publicationAuthority = authorize;
        },
      });
      assertPublicationCurrent();
      if (merchantProof && (currentContext.scope.spaceId !== merchantProof.reviewContext.scope.spaceId ||
          currentContext.scope.budgetId !== merchantProof.reviewContext.scope.budgetId ||
          currentContext.scope.connectionId !== merchantProof.reviewContext.scope.connectionId ||
          currentContext.sourceFactsHash !== merchantProof.reviewContext.sourceFactsHash ||
          currentContext.evidenceKey !== merchantProof.evidenceKey ||
          currentContext.evidenceRevision !== merchantProof.evidenceRevision ||
          currentContext.merchantPolicyVersion !== merchantProof.reviewContext.merchantPolicyVersion ||
          currentContext.visibilityHash !== merchantProof.reviewContext.visibilityHash))
        throw new Error('Current merchant Review evidence changed');
      const name = `Auto-rule for ${payee.name}`;
      const nativePlan = native.planCreateRule({
        name,conditions:[{field:'payee',op:'is',value:payee.id}],
        actions:[{op:'set',field:'category',value:category.id}],
        budgetId,stage:'post',conditionsOp:'and',reviewContext:currentContext,
      },canonicalSnapshot);
      const reviewedSimulation = native.simulateCreateRulePlan(nativePlan,canonicalSnapshot);
      return { scope, input: {
        store: workflow.store,
        spaceId: selected.space.id,
        budgetId,
        actorId: selected.auth.actorId,
        auth: selected.auth,
        origin: { kind: 'review' as const, review },
        correlationId: requestId,
        expiresAt: currentContext.expiresAt,
        currentContext,reviewedSimulation,snapshot:canonicalSnapshot,
        name,
        payeeId: payee.id,
        categoryId: category.id,
        nativePlan,
        transaction,
        assertPublicationCurrent,
      } };
    }, { expectedBudgetId: budgetId, dispose: true, synchronize:false });
    assertPublicationCurrent();
    const current = await workflow.store.getReviewItem(review.id);
    assertPublicationCurrent();
    if (!await hasNativeRuleSourceAdmission(workflow.store, actor, 'rule:propose'))
      throw new Error('Current complete native source authority is unavailable');
    assertPublicationCurrent();
    const finalConfig = await manager.loadConfig();
    assertPublicationCurrent();
    if (!current || current.version !== review.version || current.evidence.sourceRevision !== review.evidence.sourceRevision ||
        !finalConfig || finalConfig.budgetId !== budgetId ||
        reviewConnectionScope(selected.space.id, finalConfig).connectionId !== captured.scope.connectionId ||
        !hasReviewScopeAdmission({
          store: workflow.store, selected, item: current, capability: 'rule:propose', phase: 'propose',
          operation: 'create_rule', policyVersion: policy.version, targetCategoryId: body.data.categoryId,
          connectionId: captured.scope.connectionId,
        }))
      throw new Error('Current Review namespace or authority is unavailable');
    const proposal = await createRuleProposal(captured.input);
    committedProposalId = proposal.id;
    assertPublicationCurrent();

    const publishedReview = await workflow.store.getReviewItem(review.id);
    assertPublicationCurrent();
    const publishedConfig = await manager.loadConfig();
    assertPublicationCurrent();
    if (!publishedReview || publishedReview.version !== review.version ||
        publishedReview.evidence.sourceRevision !== review.evidence.sourceRevision ||
        !publishedConfig || publishedConfig.budgetId !== budgetId ||
        reviewConnectionScope(selected.space.id, publishedConfig).connectionId !== captured.scope.connectionId ||
        !hasReviewScopeAdmission({
          store: workflow.store, selected, item: publishedReview, capability: 'rule:propose', phase: 'propose',
          operation: 'create_rule', policyVersion: policy.version, targetCategoryId: body.data.categoryId,
          connectionId: captured.scope.connectionId,
        }))
      throw new Error('Current Review publication authority is unavailable');
    // Private projection is synchronous and follows every awaited current-state check.
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
      return errorEnvelope('PROPOSAL_UNAVAILABLE', 'A current rule proposal could not be read.', authorization.info, false, requestId);
    }
    return okEnvelope({
      proposal: proposalView,
      simulationStatus: 'present',
      simulationWarning: null,
    }, authorization.info, requestId);
  } catch {
    if (committedProposalId) {
      try { await workflow.store.supersedeProposal(committedProposalId); }
      catch { /* Invalidation failure must never expose the stale private result. */ }
    }
    setResponseStatus(event, 409);
    return errorEnvelope('PROPOSAL_UNAVAILABLE', 'A current rule proposal could not be created.', authorization.info, false, requestId);
  }
});
