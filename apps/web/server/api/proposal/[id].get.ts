import { defineEventHandler, getRouterParam, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { buildProposalApprovalView } from '../../utils/proposal-approval-view';
import type { ProposalApprovalView } from '../../utils/proposal-approval-view';
import { requireSelectedSpace } from '../../utils/space-context';
import type { EventWithContext } from '../../utils/workflow-store';
import { errorEnvelope, getWorkflowStore, okEnvelope, sanitizeError } from '../../utils/workflow-store';

const ProposalId = z.string().trim().min(1).max(200);


export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;

  const proposalId = ProposalId.safeParse(getRouterParam(event, 'id'));
  if (!proposalId.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_PROPOSAL_ID', 'Proposal ID is invalid.', null, false, requestId);
  }

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Proposal is unavailable.', null, true, requestId);
  }

  try {
    const proposal = await workflow.store.getProposal(proposalId.data);
    if (
      !proposal ||
      proposal.spaceId !== selected.space.id ||
      proposal.budgetId !== selected.space.budgetId ||
      (proposal.operation !== 'set_category' && proposal.operation !== 'create_rule' &&
        proposal.operation !== 'update_rule' && proposal.operation !== 'delete_rule')
    ) {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Proposal is unavailable in the selected space.', null, false, requestId);
    }

    let view: ProposalApprovalView | null;
    try {
      view = await buildProposalApprovalView({
        store: workflow.store,
        proposal,
        actorId: selected.auth.actorId,
        auth: selected.auth,
        now: new Date().toISOString(),
        requestId,
      });
    } catch {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Proposal is unavailable in the selected space.', null, false, requestId);
    }
    if (!view) {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Proposal is unavailable in the selected space.', null, false, requestId);
    }


    const expiredAt = Date.parse(view.expiresAt);
    const stale =
      !Number.isFinite(expiredAt) ||
      expiredAt <= Date.now() ||
      proposal.supersededAt !== null ||
      view.governancePolicyVersion !== view.currentGovernancePolicyVersion ||
      !view.requesterMembershipCurrent;
    const simulation = view.preconditions !== null &&
      Object.prototype.hasOwnProperty.call(view.preconditions, 'simulation')
      ? view.preconditions.simulation ?? null
      : null;
    const simulationStatus = simulation === null ? 'missing' : stale ? 'stale' : 'present';

    return okEnvelope(
      {
        proposal: view,
        simulation,
        stale: stale || simulationStatus === 'stale',
        simulationStatus,
      },
      null,
      requestId,
    );
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'PROPOSAL_SHOW_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, null, false, requestId);
  }
});
