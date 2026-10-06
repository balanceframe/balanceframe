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
export function buildProposalApprovalView(input: {
  readonly store: WorkflowStore;
  readonly proposal: GenericActionProposal;
  readonly actorId: string;
  readonly auth: OperationalAuth;
  readonly now: string;
  readonly requestId?: string;
  readonly privateProjection?: 'envelope' | 'detail';
}): ProposalApprovalView | null {
  if (!input.proposal.spaceId) return null;
  const read = input.store.getProposalApprovalReads({
    proposalIds: [input.proposal.id],
    spaceId: input.proposal.spaceId,
    actorId: input.actorId,
    auth: input.auth,
    now: input.now,
    requestId: input.requestId,
    privateProjection: input.privateProjection ?? 'envelope',
  })[0];
  if (!read) return null;
  const { proposal, summary, preconditions } = read;
  if (!proposal.spaceId || !proposal.requesterMembershipId || !proposal.governancePolicyVersion)
    return null;
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
    preconditions,
    expiresAt: proposal.expiresAt,
    requiredApprovers: summary.requiredApprovers,
    approvers: summary.approvers,
    disposition: summary.disposition.kind,
    canApprove: summary.canApprove && summary.privateEnvelopeVisible,
    canExecute: summary.canExecute,
  };
}
