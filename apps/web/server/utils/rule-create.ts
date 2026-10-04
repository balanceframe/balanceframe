import type { RuleMutationPlan } from '@balanceframe/application';
import {
  canonicalProposalJson,
  GENERIC_MUTATION_POLICY_VERSION,
} from '@balanceframe/workflow-store';
import type {
  GenericActionProposal,
  OperationalAuth,
  WorkflowStore,
} from '@balanceframe/workflow-store';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';

type RuleCreateTransaction = Pick<
  ProtocolSnapshot['transactions'][number],
  'id' | 'accountId' | 'payeeName' | 'categoryId' | 'amount'
>;

type RuleCreateProposalInput = {
  readonly store: WorkflowStore;
  readonly spaceId: string;
  readonly budgetId: string;
  readonly actorId: string;
  readonly auth: OperationalAuth;
  readonly correlationId: string;
  readonly expiresAt: string;
  readonly actualVersion: string;
  readonly snapshotSchemaVersion: string;
  readonly name: string;
  readonly payee: string;
  readonly categoryId: string;
  readonly nativePlan: RuleMutationPlan;
} & (
  | {
      readonly origin: { readonly kind: 'rule-route'; readonly transactionId?: string };
      readonly transaction?: RuleCreateTransaction;
    }
  | {
      readonly origin: { readonly kind: 'review'; readonly reviewId: string };
      readonly transaction: RuleCreateTransaction;
    }
);

/** Persist the same immutable Actual rule intent for direct and review proposals. */
export async function createRuleProposal(input: RuleCreateProposalInput): Promise<GenericActionProposal> {
  if (input.origin.kind === 'review' && !input.transaction)
    throw new Error('Review rule proposals require source transaction facts');
  const rule = {
    name: input.name,
    stage: 'post' as const,
    conditionsOp: 'and' as const,
    conditions: [{ field: 'payee_name', op: 'is', value: input.payee }],
    actions: [{ type: 'set-category', field: 'category', value: input.categoryId }],
  };
  const transactionId = input.origin.kind === 'rule-route'
    ? input.origin.transactionId ?? null
    : input.transaction?.id ?? null;
  const preconditions = {
    source: input.origin.kind === 'review' ? 'review' : 'rule-route',
    ...(input.origin.kind === 'review' ? { reviewId: input.origin.reviewId } : {}),
    actualVersion: input.actualVersion,
    snapshotSchemaVersion: input.snapshotSchemaVersion,
    nativeRule: rule,
    nativePlan: input.nativePlan,
    ...(input.transaction ? {
      transaction: {
        id: input.transaction.id,
        accountId: input.transaction.accountId,
        categoryId: input.transaction.categoryId,
        payeeName: input.transaction.payeeName,
        amount: input.transaction.amount,
      },
    } : {}),
  };

  return input.store.createProposal({
    operation: 'create_rule',
    budgetId: input.budgetId,
    spaceId: input.spaceId,
    payload: {
      kind: 'create_rule',
      transactionId,
      categoryId: input.categoryId,
      rule,
      composite: {
        operations: [],
        reallocations: [],
        transferRecommendations: [],
        ledgerProjections: [],
        evidenceReferences: [],
        nativePayloadHash: input.nativePlan.hash,
      },
    },
    policyVersion: GENERIC_MUTATION_POLICY_VERSION,
    preconditions: canonicalProposalJson(preconditions),
    expiresAt: input.expiresAt,
    actorId: input.actorId,
    auth: input.auth,
    provenance: input.origin.kind === 'review' ? 'review-action' : 'rule-route',
    correlationId: input.correlationId,
  });
}
