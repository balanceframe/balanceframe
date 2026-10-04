import type {
  GenericActionProposal,
  GovernanceDisposition,
  OperationalAuth,
  ProposalApprovalSummary,
  WorkflowStore,
} from '@balanceframe/workflow-store';

export type ProposalApprovalDisposition = GovernanceDisposition['kind'];

/** Safe client view of the exact persisted proposal and current human approvals. */
export interface ProposalApprovalView {
  readonly id: string;
  readonly operation: GenericActionProposal['operation'];
  readonly spaceId: string;
  readonly budgetId: string;
  readonly requesterActorId: string;
  readonly requesterMembershipId: string;
  readonly governancePolicyVersion: string;
  readonly currentGovernancePolicyVersion: string;
  readonly requesterMembershipCurrent: boolean;
  readonly policyVersion: string;
  readonly payloadHash: string;
  readonly privateEnvelopeVisible: boolean;
  readonly payload: GenericActionProposal['payload'] | null;
  readonly preconditions: Readonly<Record<string, unknown>> | null;
  readonly expiresAt: string;
  readonly requiredApprovers: number;
  readonly approvers: ProposalApprovalSummary['approvers'];
  readonly disposition: ProposalApprovalDisposition;
  readonly canApprove: boolean;
  readonly canExecute: boolean;
}

/** Build the exact view only after the store admits current selected-space read authority. */
export async function buildProposalApprovalView(input: {
  readonly store: WorkflowStore;
  readonly proposal: GenericActionProposal;
  readonly actorId: string;
  readonly auth: OperationalAuth;
  readonly now: string;
  readonly requestId?: string;
}): Promise<ProposalApprovalView | null> {
  const { proposal } = input;
  if (!proposal.spaceId || !proposal.requesterMembershipId || !proposal.governancePolicyVersion)
    return null;

  let preconditions: unknown;
  try {
    preconditions = JSON.parse(proposal.preconditions) as unknown;
  } catch {
    return null;
  }
  if (!preconditions || typeof preconditions !== 'object' || Array.isArray(preconditions))
    return null;

  const summary = await input.store.getProposalApprovalSummary({
    proposalId: proposal.id,
    spaceId: proposal.spaceId,
    actorId: input.actorId,
    auth: input.auth,
    now: input.now,
    requestId: input.requestId,
  });
  return {
    id: proposal.id,
    operation: proposal.operation,
    spaceId: proposal.spaceId,
    budgetId: proposal.budgetId,
    requesterActorId: proposal.actorId,
    requesterMembershipId: proposal.requesterMembershipId,
    governancePolicyVersion: proposal.governancePolicyVersion,
    currentGovernancePolicyVersion: summary.currentGovernancePolicyVersion,
    requesterMembershipCurrent: summary.requesterMembershipCurrent,
    policyVersion: proposal.policyVersion,
    payloadHash: proposal.payloadHash,
    privateEnvelopeVisible: summary.privateEnvelopeVisible,
    payload: summary.privateEnvelopeVisible ? proposal.payload : null,
    preconditions: summary.privateEnvelopeVisible ? preconditions as Readonly<Record<string, unknown>> : null,
    expiresAt: proposal.expiresAt,
    requiredApprovers: summary.requiredApprovers,
    approvers: summary.approvers,
    disposition: summary.disposition.kind,
    canApprove: summary.canApprove && summary.privateEnvelopeVisible,
    canExecute: summary.canExecute,
  };
}
