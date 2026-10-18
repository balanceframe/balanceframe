import { defineEventHandler, getRouterParam, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import type { ConsequentialActionProposal } from '@balanceframe/application';
import { buildProposalApprovalView } from '../../utils/proposal-approval-view';
import type { ProposalApprovalView } from '../../utils/proposal-approval-view';
import { createWebConsequentialActionService, selectedLiquidityActor } from '../../utils/liquidity-service';
import { projectConsequentialActionProposal } from '../../utils/proposal-route';
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
        proposal.operation !== 'update_rule' && proposal.operation !== 'delete_rule' &&
        proposal.operation !== 'consequential_action')
    ) {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Proposal is unavailable in the selected space.', null, false, requestId);
    }

    let view: ProposalApprovalView | null;
    try {
      view = buildProposalApprovalView({
        store: workflow.store,
        proposal,
        actorId: selected.auth.actorId,
        auth: selected.auth,
        now: new Date().toISOString(),
        requestId,
        privateProjection: 'detail',
      });
    } catch {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Proposal is unavailable in the selected space.', null, false, requestId);
    }
    if (!view) {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Proposal is unavailable in the selected space.', null, false, requestId);
    }
    let actionProjection: ConsequentialActionProposal | null = null;
    let currentAssistanceMaximum = 'analysis_only';
    if (proposal.operation === 'consequential_action') {
      const actor = selectedLiquidityActor(workflow.store, selected);
      if (!actor) {
        setResponseStatus(event, 403);
        return errorEnvelope('FORBIDDEN', 'The selected space is unavailable.', null, false, requestId);
      }
      try {
        const service = await createWebConsequentialActionService(workflow.store);
        actionProjection = await service.getProposal(actor, proposal.id);
      } catch {
        setResponseStatus(event, 503);
        return errorEnvelope('ACTION_SOURCE_UNAVAILABLE', 'The current scoped action view is unavailable.', null, true, requestId);
      }
      if (!actionProjection) {
        setResponseStatus(event, 404);
        return errorEnvelope('NOT_FOUND', 'Proposal is unavailable in the selected space.', null, false, requestId);
      }
      currentAssistanceMaximum =
        workflow.store.governance.getPolicy({ spaceId: selected.space.id })?.assistanceMaximum ?? 'analysis_only';
    }
    const publicView = actionProjection
      ? projectConsequentialActionProposal(actionProjection, view, currentAssistanceMaximum)
      : view;

    const expiredAt = Date.parse(publicView.expiresAt);
    const stale =
      !Number.isFinite(expiredAt) ||
      expiredAt <= Date.now() ||
      ('supersededAt' in publicView ? publicView.supersededAt !== null : proposal.supersededAt !== null) ||
      publicView.governancePolicyVersion !== publicView.currentGovernancePolicyVersion ||
      !publicView.requesterMembershipCurrent;
    const simulation = 'preconditions' in publicView && publicView.preconditions
      ? (publicView.operation === 'create_rule'
        ? publicView.preconditions.reviewedSimulation ?? publicView.preconditions.simulation
        : publicView.preconditions.simulation) ?? null
      : null;
    const simulationStatus = simulation === null ? 'missing' : stale ? 'stale' : 'present';



    return okEnvelope(
      {
        proposal: publicView,
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
