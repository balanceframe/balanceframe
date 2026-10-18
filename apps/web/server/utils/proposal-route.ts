import type { ConsequentialActionExecution, ConsequentialActionProposal } from '@balanceframe/application';
import type { ProposalApprovalSummary } from '@balanceframe/workflow-store';

export type ActionProposalApproval = Pick<
  ProposalApprovalSummary,
  'requesterMembershipCurrent' | 'requiredApprovers' | 'approvers' | 'canApprove' | 'canExecute'
> & { readonly disposition: ProposalApprovalSummary['disposition']['kind'] };

export function projectConsequentialActionProposal(
  proposal: ConsequentialActionProposal,
  approval: ActionProposalApproval,
  currentAssistanceMaximum: string,
) {
  const plan = proposal.payload.plan;
  const decisionContext = proposal.decisionContext;
  return {
    id: proposal.id,
    operation: proposal.operation,
    budgetId: proposal.budgetId,
    spaceId: proposal.spaceId,
    policyVersion: proposal.policyVersion,
    requesterActorId: proposal.requesterActorId,
    requesterMembershipCurrent: approval.requesterMembershipCurrent,
    governancePolicyVersion: proposal.governancePolicyVersion,
    currentGovernancePolicyVersion: proposal.currentGovernancePolicyVersion,
    payloadHash: proposal.payloadHash,
    financialPolicyVersion: proposal.financialPolicyVersion,
    currentFinancialPolicyVersion: proposal.currentFinancialPolicyVersion,
    requiredApprovers: approval.requiredApprovers,
    approvers: approval.approvers.map(({ actorId, issuedAt, expiresAt }) => ({ actorId, issuedAt, expiresAt })),
    disposition: approval.disposition,
    canApprove: approval.canApprove,
    canExecute: approval.canExecute,
    currentAssistanceMaximum,
    decisionContext: decisionContext === null ? null : {
      horizon: { startsAt: decisionContext.horizon.startsAt, endsAt: decisionContext.horizon.endsAt },
      validUntil: decisionContext.validUntil,
      items: decisionContext.items.map((item) => ({
        id: item.id,
        categoryId: item.categoryId,
        accountId: item.accountId,
        amount: { minorUnits: item.amount.minorUnits, currency: item.amount.currency },
        purchaseAt: item.purchaseAt,
        requiredBy: item.requiredBy,
        priority: item.priority,
        ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
        ...(item.categoryAllocations === undefined ? {} : {
          categoryAllocations: item.categoryAllocations.map(({ categoryId, amount }) => ({
            categoryId,
            amount: { minorUnits: amount.minorUnits, currency: amount.currency },
          })),
        }),
      })),
      ...(decisionContext.adjustments === undefined ? {} : {
        adjustments: decisionContext.adjustments.map(({ kind, categoryId, amount }) => ({
          kind,
          categoryId,
          amount: { minorUnits: amount.minorUnits, currency: amount.currency },
        })),
      }),
      ...(decisionContext.warningThresholds === undefined ? {} : {
        warningThresholds: decisionContext.warningThresholds.map((threshold) => ({
          id: threshold.id,
          basis: threshold.basis,
          ...(threshold.basis === 'cart_total' ? {} : { categoryId: threshold.categoryId }),
          maximum: { minorUnits: threshold.maximum.minorUnits, currency: threshold.maximum.currency },
        })),
      }),
    },
    payload: {
      kind: 'consequential_action' as const,
      plan: {
        version: plan.version,
        action: projectActionIntent(plan.action),
        source: {
          snapshotReference: plan.source.snapshotReference,
          policyVersion: plan.source.policyVersion,
          financialPolicyVersion: plan.source.financialPolicyVersion,
          claimSetRevision: plan.source.claimSetRevision,
        },
        evidenceReferences: plan.evidenceReferences.map(({ evidenceId, subjectId, state }) => ({
          evidenceId,
          subjectId,
          state,
        })),
        expiresAt: plan.expiresAt,
        reasonCodes: plan.reasonCodes,
        impacts: plan.impacts,
        expectedPostconditions: plan.expectedPostconditions,
      },
    },
    expiresAt: proposal.expiresAt,
    supersededAt: proposal.supersededAt,
    createdAt: proposal.createdAt,
    version: proposal.version,
    state: { phase: proposal.state.phase, outcome: proposal.state.outcome },
  };
}

export function projectConsequentialActionExecution(execution: ConsequentialActionExecution) {
  return { id: execution.id, phase: execution.phase, outcome: execution.outcome };
}
type AtomicAction = Exclude<
  ConsequentialActionProposal['payload']['plan']['action'],
  { readonly kind: 'composite' }
>;

function projectActionIntent(action: ConsequentialActionProposal['payload']['plan']['action']) {
  return action.kind === 'composite'
    ? { kind: 'composite' as const, actions: action.actions.map(projectAtomicAction) }
    : projectAtomicAction(action);
}

function projectAtomicAction(action: AtomicAction) {
  switch (action.kind) {
    case 'reallocation':
      return {
        kind: action.kind,
        assignments: action.assignments.map((assignment) => ({
          sourceCategoryId: assignment.sourceCategoryId,
          sourceAsOfMonth: assignment.sourceAsOfMonth,
          destinationCategoryId: assignment.destinationCategoryId,
          destinationAsOfMonth: assignment.destinationAsOfMonth,
          amount: { minorUnits: assignment.amount.minorUnits, currency: assignment.amount.currency },
        })),
      };
    case 'manual_transaction':
      return { kind: action.kind, transaction: projectManualTransaction(action.transaction) };
    case 'evidence_projection':
      return {
        kind: action.kind,
        transaction: projectManualTransaction(action.transaction),
        evidenceIds: [...action.evidenceIds],
      };
    case 'wallet_materialization':
      return {
        kind: action.kind,
        walletId: action.walletId,
        accountName: action.accountName,
        currency: action.currency,
      };
    case 'transfer':
      return {
        kind: action.kind,
        transferId: action.transferId,
        correlationId: action.correlationId,
        sourceAccountId: action.sourceAccountId,
        destinationAccountId: action.destinationAccountId,
        amount: { minorUnits: action.amount.minorUnits, currency: action.amount.currency },
        date: action.date,
      };
    default:
      throw new Error('Unsupported consequential action intent');
  }
}

function projectManualTransaction(
  transaction: Extract<AtomicAction, { readonly kind: 'manual_transaction' }>['transaction'],
) {
  return {
    parentId: transaction.parentId,
    correlationId: transaction.correlationId,
    accountId: transaction.accountId,
    amount: { minorUnits: transaction.amount.minorUnits, currency: transaction.amount.currency },
    date: transaction.date,
    categoryId: transaction.categoryId,
    payeeName: transaction.payeeName,
    notes: transaction.notes,
    splits: transaction.splits.map(({ categoryId, amount }) => ({
      categoryId,
      amount: { minorUnits: amount.minorUnits, currency: amount.currency },
    })),
  };
}
