import type { RuleMutationPlan, RuleReviewContext, RuleSimulationResult } from '@balanceframe/application';
import { indexCanonicalTransactions } from '@balanceframe/application';
import { canonicalProposalJson, GENERIC_MUTATION_POLICY_VERSION } from '@balanceframe/workflow-store';
import type { CreateProposalInput, GenericActionProposal, LiquidityActor, OperationalAuth, ReviewItem, WorkflowStore } from '@balanceframe/workflow-store';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { hasLegacyFullRead } from './legacy-financial-read';
import { hasCurrentReviewNamespace, matchesReviewTransaction } from './review-scope-admission';

/** Native planning reads the complete SDK population and creates a GLOBAL future rule. */
export async function hasNativeRuleSourceAdmission(store: WorkflowStore, actor: LiquidityActor, capability: 'rule:propose'|'rule:execute'): Promise<boolean> {
  if (!actor.spaceId || !actor.auth || !actor.governancePolicyVersion || !hasLegacyFullRead(store,actor)) return false;
  const auth = actor.auth;
  const result = store.governance.authorize({
    actorId:actor.actorId,spaceId:actor.spaceId,membershipId:actor.membershipId,
    expectedPolicyVersion:actor.governancePolicyVersion,auth,phase:'read',operation:'create_rule',
    required:['observe','full-read','source'].map((right) => ({resourceKind:'budget' as const,resourceId:actor.budgetId,capability:right,visibility:'resource' as const})),
    payload:{operations:[{operation:'create_rule',accountScope:{kind:'global'}}]},now:new Date().toISOString(),
    ...(auth.method === 'api-key' && auth.principalType === 'agent' ? {agentId:auth.actorId,delegationId:auth.delegationId,delegationVersion:auth.delegationVersion} : {}),
  });
  if (!result.allowed || result.disposition.kind !== 'authorized_without_approval') return false;
  // Proposal-only mutation grants authorize planning, not source reads or execution.
  return store.governance.authorize({
    actorId:actor.actorId,spaceId:actor.spaceId,membershipId:actor.membershipId,
    expectedPolicyVersion:actor.governancePolicyVersion,auth,
    phase:capability === 'rule:propose' ? 'propose' : 'read',operation:'create_rule',
    required:[{resourceKind:'budget',resourceId:actor.budgetId,capability,visibility:'resource'}],
    payload:{operations:[{operation:'create_rule',accountScope:{kind:'global'}}]},now:new Date().toISOString(),
    ...(auth.method === 'api-key' && auth.principalType === 'agent' ? {agentId:auth.actorId,delegationId:auth.delegationId,delegationVersion:auth.delegationVersion} : {}),
  }).allowed;
}

/** Resolve an exact transaction ID through recursive split trees; ambiguous IDs fail closed. */
export function findRuleSourceTransaction(snapshot: ProtocolSnapshot, id: string): ProtocolSnapshot['transactions'][number] | undefined {
  return indexCanonicalTransactions(snapshot.transactions).get(id);
}

type RuleCreateProposalInput = {
  readonly store: WorkflowStore;
  readonly spaceId: string;
  readonly budgetId: string;
  readonly actorId: string;
  readonly auth: OperationalAuth;
  readonly correlationId: string;
  readonly expiresAt: string;
  readonly name: string;
  readonly payeeId: string;
  readonly categoryId: string;
  readonly nativePlan: RuleMutationPlan;
  readonly currentContext: RuleReviewContext;
  readonly reviewedSimulation: RuleSimulationResult;
  readonly snapshot: ProtocolSnapshot;
} & (
  | { readonly origin: { readonly kind: 'rule-route'; readonly transactionId?: string }; readonly transaction?: ProtocolSnapshot['transactions'][number] }
  | { readonly origin: { readonly kind: 'review'; readonly review: ReviewItem }; readonly transaction: ProtocolSnapshot['transactions'][number]; readonly assertPublicationCurrent: () => void }
);

/** Persist the exact standalone Actual intent and complete source-bound simulation for approval. */
export async function createRuleProposal(input: RuleCreateProposalInput): Promise<GenericActionProposal> {
  if (input.origin.kind === 'review' && (!('assertPublicationCurrent' in input) || typeof input.assertPublicationCurrent !== 'function'))
    throw new Error('Review rule proposals require live publication authority');
  if (input.origin.kind === 'review' && !input.transaction) throw new Error('Review rule proposals require source transaction facts');
  if (input.currentContext.scope.spaceId !== input.spaceId || input.currentContext.scope.budgetId !== input.budgetId ||
      Date.parse(input.currentContext.expiresAt) <= Date.now() || input.transaction && input.transaction.payeeId !== input.payeeId)
    throw new Error('Current source scope or stable payee differs from the rule intent');
  const review = input.origin.kind === 'review' ? input.origin.review : null;
  if (input.origin.kind === 'review' && !review) throw new Error('Captured Review is required');
  if (review) {
    const current = await input.store.getReviewItem(review.id);
    if ('assertPublicationCurrent' in input) input.assertPublicationCurrent();
    if (!current || !Number.isSafeInteger(review.version) || current.version !== review.version ||
        current.evidence.sourceRevision !== review.evidence.sourceRevision ||
        current.budgetId !== input.budgetId || !input.transaction || !matchesReviewTransaction(current, input.transaction) ||
        !hasCurrentReviewNamespace(input.store, current, input.currentContext.scope))
      throw new Error('Captured Review generation or namespace is unavailable');
  }
  const rule = {
    stage:'post' as const,conditionsOp:'and' as const,
    conditions:[{field:'payee',op:'is',value:input.payeeId}],
    actions:[{op:'set',field:'category',value:input.categoryId}],
  };
  const transactionId = input.origin.kind === 'rule-route' ? input.origin.transactionId ?? null : input.transaction?.id ?? null;
  const sourceDependencies = [
    ...input.snapshot.accounts.map((row) => ({resourceKind:'account',resourceId:row.id})),
    ...input.snapshot.categories.map((row) => ({resourceKind:'category',resourceId:row.id})),
    ...input.snapshot.rules.map((row) => ({resourceKind:'rule',resourceId:row.id})),
  ];
  const visit = (rows: ProtocolSnapshot['transactions']) => {
    for (const row of rows) {
      sourceDependencies.push({resourceKind:'transaction',resourceId:row.id});
      visit(row.subtransactions);
    }
  };
  visit(input.snapshot.transactions);
  const preconditions = {
    source:input.origin.kind === 'review' ? 'review' : 'rule-route',
    ...(review ? {
      reviewId: review.id,
      reviewProvenance: { budgetId: review.budgetId, transactionId: review.transactionId,
        categoryId: review.categoryId, status: review.status, version: review.version },
      ...(typeof review.evidence.sourceRevision === 'string' ? { reviewSourceRevision: review.evidence.sourceRevision } : {}),
    } : {}),
    ruleName:input.name,actualVersion:input.snapshot.actualVersion,snapshotSchemaVersion:input.snapshot.schemaVersion,
    nativeRule:rule,nativePlan:input.nativePlan,reviewContext:input.currentContext,reviewedSimulation:input.reviewedSimulation,
    sourceAccounts:input.snapshot.accounts,sourceTransactions:input.snapshot.transactions,
    nativeImpact:{payees:input.snapshot.payees,categories:input.snapshot.categories,rules:input.snapshot.rules},
    sourceDependencies,
    ...(input.transaction ? {transaction:input.transaction} : {}),
  };
  const proposalInput: CreateProposalInput = {
    operation:'create_rule',budgetId:input.budgetId,spaceId:input.spaceId,
    payload:{kind:'create_rule',transactionId,categoryId:input.categoryId,rule,
      composite:{operations:[],reallocations:[],transferRecommendations:[],ledgerProjections:[],evidenceReferences:[],nativePayloadHash:input.nativePlan.hash}},
    policyVersion:GENERIC_MUTATION_POLICY_VERSION,preconditions:canonicalProposalJson(preconditions),
    expiresAt:input.expiresAt,actorId:input.actorId,auth:input.auth,
    provenance:input.origin.kind === 'review' ? 'review-action' : 'rule-route',correlationId:input.correlationId,
  };
  if ('assertPublicationCurrent' in input) input.assertPublicationCurrent();
  return input.store.createProposal(proposalInput);
}
