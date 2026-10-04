import {
  ConnectionManager,
  createNativeCategorizationMutationProtocol,
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
import { hasReviewScopeAdmission } from './review-scope-admission';

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
        return await manager.withConnection(async (connected) => {
          if (
            connected.config.budgetId !== selected.space.budgetId ||
            connected.budget.id !== selected.space.budgetId
          ) {
            return deniedResult(item, 'denied', 'Connected budget does not match the selected space');
          }

          const ledger = connected.connector as unknown as BudgetLedger;
          const synchronized = await ledger.synchronize();
          const transaction = synchronized.snapshot.transactions.find((row) => row.id === item.transactionId);
          const categoryId = input.categoryId ?? item.categoryId;
          const category = synchronized.snapshot.categories.find((row) => row.id === categoryId);
          if (!transaction || !category)
            return deniedResult(item, 'stale', 'Native transaction or category is unavailable');

          const intent = buildCategorizationProposalIntent({
            protocol: rust,
            snapshot: synchronized.snapshot,
            transaction,
            category,
            review: item,
          });
          const { payload, preconditions: nativeFacts, nativePlan: plan } = intent;
          const facts = deriveProposalAuthorizationFacts('set_category', payload, nativeFacts);
          const now = new Date().toISOString();
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

          const required = [
            { resourceKind: 'budget' as const, resourceId: selected.space.budgetId, capability: 'categorization:propose' },
            ...facts.resources.map((resource) => ({ ...resource, capability: 'categorization:propose' })),
          ];
          const agent = selected.auth.method === 'api-key' && selected.auth.principalType === 'agent'
            ? selected.auth
            : null;
          const authorization = store.governance.authorize({
            actorId: selected.auth.actorId,
            spaceId: selected.space.id,
            expectedPolicyVersion: proposal.governancePolicyVersion,
            phase: 'propose',
            operation: 'set_category',
            required,
            payload: { operations: facts.operations, proposal: payload },
            now,
            auth: selected.auth,
            ...(agent ? {
              agentId: agent.actorId,
              delegationId: agent.delegationId,
              delegationVersion: agent.delegationVersion,
            } : {}),
          });
          if (!authorization.allowed)
            return deniedResult(item, 'denied', 'Current proposal authorization is unavailable');

          return {
            disposition: 'approval_required',
            mutationStatus: 'approval_required',
            success: false,
            applied: false,
            verified: false,
            stale: false,
            transactionId: transaction.id,
            previousCategoryId: plan.currentCategoryId,
            newCategoryId: category.id,
            proposalId: proposal.id,
            payloadHash: proposal.payloadHash,
            governancePolicyVersion: proposal.governancePolicyVersion,
            requiredApprovers: requiredProposalApprovers(authorization),
            error: null,
          };
        }, { expectedBudgetId: selected.space.budgetId, dispose: true });
      } catch (error) {
        if (classifyConnectionError(error)) throw error;
        return deniedResult(item, 'failed', 'Native proposal could not be created');
      }
    };
  };
}
