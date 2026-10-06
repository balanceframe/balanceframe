import {
  ConnectionManager,
  createNativeCategorizationMutationProtocol,
  indexCanonicalTransactions,
} from '@balanceframe/application';
import type { RustMutationProtocol } from '@balanceframe/application';
import type { BudgetLedger } from '@balanceframe/actual-adapter';
import {
  ActualConnector,
  createDefaultActualClient,
  EnvCredentialStore,
} from '@balanceframe/actual-adapter';
import {
  GENERIC_MUTATION_POLICY_VERSION,
  deriveProposalAuthorizationFacts,
  requiredProposalApprovers,
} from '@balanceframe/workflow-store';
import type { EventWithContext, ReviewMutationExecutor, ReviewMutationExecutorFactory, ReviewMutationResult } from './workflow-store';
import { classifyConnectionError, requireProposalAuthorization, reviewAndApplyEnabled } from './workflow-store';
import { requireSelectedSpace } from './space-context';
import { buildCategorizationProposalIntent } from './categorization-proposal';
import type { ReviewItem } from '@balanceframe/workflow-store';
import { hasCurrentReviewNamespace, hasReviewScopeAdmission, matchesReviewTransaction, reviewConnectionScope } from './review-scope-admission';

export function createMutationConnectionManager(options?: { configPath?: string }): ConnectionManager {
  return new ConnectionManager({
    configPath: options?.configPath ?? process.env.BALANCEFRAME_CONFIG_PATH,
    credentialStore: new EnvCredentialStore(),
    connectorFactory: async () =>
      new ActualConnector({
        client: await createDefaultActualClient(),
        credentialStore: new EnvCredentialStore(),
        mode: 'reviewAndApply',
      }),
  });
}


function deniedResult(
  item: ReviewItem,
  disposition: Exclude<ReviewMutationResult['disposition'], 'approval_required'>,
  error: string,
): ReviewMutationResult {
  return {
    disposition,
    mutationStatus: disposition === 'stale' ? 'stale' : 'denied',
    success: false,
    applied: false,
    verified: false,
    stale: disposition === 'stale',
    transactionId: item.transactionId,
    previousCategoryId: item.categoryId,
    newCategoryId: null,
    proposalId: null,
    payloadHash: null,
    governancePolicyVersion: null,
    requiredApprovers: null,
    error,
  };
}

/** Creates an exact native proposal only; approval and execution use separate routes. */
export function createDefaultExecutorFactory(
  connectionManager?: ConnectionManager,
): ReviewMutationExecutorFactory {
  const manager = connectionManager ?? createMutationConnectionManager();

  return (event: EventWithContext): ReviewMutationExecutor | null => {
    if (!reviewAndApplyEnabled(event)) return null;

    return async (input, store, item) => {
      const selected = await requireSelectedSpace(event);
      if (!selected.ok) return deniedResult(item, 'denied', 'Selected space authorization failed');
      if (
        !selected.space.budgetId ||
        selected.space.budgetId !== item.budgetId ||
        input.actorId !== selected.auth.actorId
      ) {
        return deniedResult(item, 'denied', 'Review item is outside the selected space');
      }

      const policy = store.governance.getPolicy({ spaceId: selected.space.id });
      if (!policy || !hasReviewScopeAdmission({
        store,
        selected,
        item,
        capability: 'categorization:propose',
        phase: 'propose',
        operation: 'set_category',
        policyVersion: policy.version,
        targetCategoryId: input.categoryId ?? item.categoryId,
      }))
        return deniedResult(item, 'denied', 'Exact review source authorization is unavailable');

      const budgetAuthorization = await requireProposalAuthorization(
        event,
        'categorization:propose',
        `budget:${selected.space.budgetId}`,
        'set_category',
      );
      if (!budgetAuthorization.ok)
        return deniedResult(item, 'denied', 'Selected budget authorization is unavailable');
      for (const scope of [
        `transaction:${item.transactionId}`,
        `category:${input.categoryId ?? item.categoryId}`,
      ]) {
        const resourceAuthorization = await requireProposalAuthorization(
          event, 'categorization:propose', scope, 'set_category',
        );
        if (!resourceAuthorization.ok)
          return deniedResult(item, 'denied', 'Exact review resource authorization is unavailable');
      }

      let rust: RustMutationProtocol | null;
      try {
        rust = await createNativeCategorizationMutationProtocol();
      } catch {
        rust = null;
      }
      if (!rust) return deniedResult(item, 'native_unavailable', 'Native mutation planning is unavailable');

      const config = await manager.loadConfig();
      if (!config || config.budgetId !== selected.space.budgetId)
        return deniedResult(item, 'denied', 'Configured budget does not match the selected space');

      try {
        const captured = await manager.withConnection(async (connected) => {
          const scope = reviewConnectionScope(selected.space.id, connected.config);
          if (connected.config.budgetId !== selected.space.budgetId || connected.budget.id !== selected.space.budgetId ||
              !hasReviewScopeAdmission({
                store, selected, item, capability: 'categorization:propose', phase: 'propose',
                operation: 'set_category', policyVersion: policy.version,
                targetCategoryId: input.categoryId ?? item.categoryId, connectionId: scope.connectionId,
              }))
            throw new Error('Connected Review namespace or authority is unavailable');
          const ledger = connected.connector as unknown as BudgetLedger;
          const synchronized = await ledger.synchronize();
          const transaction = indexCanonicalTransactions(synchronized.snapshot.transactions).get(item.transactionId);
          const categoryId = input.categoryId ?? item.categoryId;
          const category = synchronized.snapshot.categories.find((row) => row.id === categoryId);
          if (!transaction || !category || category.deleted || !matchesReviewTransaction(item, transaction))
            throw new Error('Current native Review transaction or category is unavailable');
          return { scope, intent: buildCategorizationProposalIntent({
            protocol: rust,
            snapshot: synchronized.snapshot,
            transaction,
            category,
            review: item,
          }) };
        }, { expectedBudgetId: selected.space.budgetId, dispose: true, synchronize: false });
        const current = await store.getReviewItem(item.id);
        const finalConfig = await manager.loadConfig();
        if (!current || current.version !== item.version || current.evidence.sourceRevision !== item.evidence.sourceRevision ||
            !finalConfig || reviewConnectionScope(selected.space.id, finalConfig).connectionId !== captured.scope.connectionId ||
            finalConfig.budgetId !== captured.scope.budgetId ||
            !hasReviewScopeAdmission({
              store, selected, item: current, capability: 'categorization:propose', phase: 'propose',
              operation: 'set_category', policyVersion: policy.version,
              targetCategoryId: input.categoryId ?? item.categoryId, connectionId: captured.scope.connectionId,
            }))
          return deniedResult(item, 'denied', 'Current Review namespace or authority is unavailable');
        const { payload, preconditions: nativeFacts, nativePlan: plan } = captured.intent;
          const facts = deriveProposalAuthorizationFacts('set_category', payload, nativeFacts);

          const required = [
            { resourceKind: 'budget' as const, resourceId: selected.space.budgetId, capability: 'categorization:propose' },
            ...facts.resources.map((resource) => ({ ...resource, capability: 'categorization:propose' })),
          ];
          const agent = selected.auth.method === 'api-key' && selected.auth.principalType === 'agent'
            ? selected.auth
            : null;
          const authorize = () => store.governance.authorize({
            actorId: selected.auth.actorId,
            spaceId: selected.space.id,
            membershipId: selected.membership.id,
            expectedPolicyVersion: policy.version,
            phase: 'propose',
            operation: 'set_category',
            required,
            payload: { operations: facts.operations, proposal: payload },
            now: new Date().toISOString(),
            auth: selected.auth,
            ...(agent ? {
              agentId: agent.actorId,
              delegationId: agent.delegationId,
              delegationVersion: agent.delegationVersion,
            } : {}),
          });
          let authorization = authorize();
          if (!authorization.allowed)
            return deniedResult(item, 'denied', 'Current proposal authorization is unavailable');
          const proposal = await store.createProposal({
            operation: 'set_category',
            budgetId: selected.space.budgetId,
            spaceId: selected.space.id,
            payload,
            policyVersion: GENERIC_MUTATION_POLICY_VERSION,
            preconditions: JSON.stringify(nativeFacts),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            actorId: selected.auth.actorId,
            auth: selected.auth,
            provenance: 'review-and-apply-proposal',
            providerModel: null,
            correlationId: input.correlationId ?? null,
          });
          if (!proposal.governancePolicyVersion)
            return deniedResult(item, 'failed', 'Proposal has no captured governance policy version');
          const publishedConfig = await manager.loadConfig();
          authorization = authorize();
          if (!publishedConfig || publishedConfig.budgetId !== captured.scope.budgetId ||
              reviewConnectionScope(selected.space.id, publishedConfig).connectionId !== captured.scope.connectionId ||
              !hasCurrentReviewNamespace(store, item, captured.scope) || !authorization.allowed)
            return deniedResult(item, 'denied', 'Current proposal publication authority is unavailable');

          return {
            disposition: 'approval_required',
            mutationStatus: 'approval_required',
            success: false,
            applied: false,
            verified: false,
            stale: false,
            transactionId: plan.transactionId,
            previousCategoryId: plan.currentCategoryId,
            newCategoryId: plan.proposedCategoryId,
            proposalId: proposal.id,
            payloadHash: proposal.payloadHash,
            governancePolicyVersion: proposal.governancePolicyVersion,
            requiredApprovers: requiredProposalApprovers(authorization),
            error: null,
          };
      } catch (error) {
        if (classifyConnectionError(error)) throw error;
        return deniedResult(item, 'failed', 'Native proposal could not be created');
      }
    };
  };
}
