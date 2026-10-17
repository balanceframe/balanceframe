import { defineEventHandler, setHeader, setResponseStatus } from 'h3';
import type { ConsequentialActionProposal, ConsequentialActionService } from '@balanceframe/application';
import type { ActionProposal, ListProposalsOptions } from '@balanceframe/workflow-store';
import { createWebConsequentialActionService, selectedLiquidityActor } from '../../utils/liquidity-service';
import { requireSelectedSpace } from '../../utils/space-context';
import type { EventWithContext } from '../../utils/workflow-store';
import { errorEnvelope, getWorkflowStore, okEnvelope, sanitizeError } from '../../utils/workflow-store';
import { projectConsequentialActionProposal } from '../../utils/proposal-route';


export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  if (!selected.space.budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }

  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Proposals are unavailable.', null, true, requestId);
  }

  try {
    const listOptions: ListProposalsOptions = {
      budgetId: selected.space.budgetId,
      superseded: false,
      operations: ['set_category', 'create_rule', 'update_rule', 'delete_rule', 'consequential_action'],
      limit: -1,
    };
    const proposals = await workflow.store.listProposals(listOptions);
    const now = new Date().toISOString();
    const reads = workflow.store.getProposalApprovalReads({
      proposalIds: proposals
        .filter((proposal) => proposal.spaceId === selected.space.id)
        .map((proposal) => proposal.id),
      spaceId: selected.space.id,
      actorId: selected.auth.actorId,
      auth: selected.auth,
      now,
      requestId,
      privateProjection: 'preconditions',
    });
    const actionActor = selectedLiquidityActor(workflow.store, selected);
    let actionService: ConsequentialActionService | null = null;
    const actionCaptureAttempted = !!actionActor && reads.some(({ proposal }) => proposal.operation === 'consequential_action');
    if (actionCaptureAttempted) {
      try {
        actionService = await createWebConsequentialActionService(workflow.store);
      } catch {
        // No action metadata is published without a current scoped projection.
      }
    }
    const actionProjections = new Map<string, ConsequentialActionProposal>();
    if (actionService && actionActor) {
      try {
        const projections = await actionService.getProposals(
          actionActor,
          reads.filter(({ proposal }) => proposal.operation === 'consequential_action')
            .map(({ proposal }) => proposal.id),
        );
        for (const projection of projections) actionProjections.set(projection.id, projection);
      } catch {
        // Never fall back to persisted native plans or private preconditions.
      }
    }
    let publicationReads = reads;
    const actionDetails = new Map<string, (typeof reads)[number]>();
    if (actionCaptureAttempted) {
      const currentProposals = await workflow.store.listProposals(listOptions);
      const current = requireSelectedSpace(event as unknown as EventWithContext);
      if (!current.ok) return current.response;
      if (current.space.id !== selected.space.id ||
          current.space.budgetId !== selected.space.budgetId ||
          current.auth.actorId !== selected.auth.actorId) {
        setResponseStatus(event, 403);
        return errorEnvelope('FORBIDDEN', 'The selected proposal scope changed.', null, false, requestId);
      }
      const publication = {
        proposalIds: currentProposals.filter((proposal) => proposal.spaceId === current.space.id)
          .map((proposal) => proposal.id),
        spaceId: current.space.id,
        actorId: current.auth.actorId,
        auth: current.auth,
        now: new Date().toISOString(),
        requestId,
      };
      publicationReads = workflow.store.getProposalApprovalReads({
        ...publication, privateProjection: 'preconditions',
      });
      if (actionProjections.size)
        for (const read of workflow.store.getProposalApprovalReads({
          ...publication, privateProjection: 'detail',
        })) actionDetails.set(read.proposal.id, read);
    }
    const currentAssistanceMaximum =
      workflow.store.governance.getPolicy({ spaceId: selected.space.id })?.assistanceMaximum ?? 'analysis_only';
    const items = publicationReads.flatMap<Record<string, unknown>>(({ proposal, summary, preconditions }) => {
      if (proposal.operation === 'consequential_action') {
        const projection = actionProjections.get(proposal.id);
        const detail = actionDetails.get(proposal.id);
        return projection && detail?.summary.privateEnvelopeVisible &&
          detail.proposal.payloadHash === projection.payloadHash
          ? [projectConsequentialActionProposal(
              projection,
              { ...detail.summary, disposition: detail.summary.disposition.kind },
              currentAssistanceMaximum,
            )]
          : [];
      }
      const payload = summary.privateEnvelopeVisible ? proposal.payload : null;
      return [{
        id: proposal.id,
        operation: proposal.operation,
        budgetId: proposal.budgetId,
        transactionId: payload && 'transactionId' in payload ? payload.transactionId : null,
        categoryId: payload && 'categoryId' in payload ? payload.categoryId : null,
        ruleId: payload && 'ruleId' in payload ? payload.ruleId : null,
        preconditions: JSON.stringify(preconditions),
        expiresAt: proposal.expiresAt,
        actorId: proposal.actorId,
        provenance: proposal.provenance,
        providerModel: proposal.providerModel,
        correlationId: proposal.correlationId,
        supersededAt: proposal.supersededAt,
        createdAt: proposal.createdAt,
        simulationStatus: computeSimulationStatus(proposal, preconditions),
        requiredApprovers: summary.requiredApprovers,
        approverCount: summary.approvers.length,
        canApprove: summary.canApprove && summary.privateEnvelopeVisible,
        canExecute: summary.canExecute,
      }];
    });
    return okEnvelope({ proposals: items, total: items.length }, null, requestId);
  } catch (error) {
    const safe = sanitizeError(error, requestId, 'LIST_FAILED', false);
    setResponseStatus(event, 500);
    return errorEnvelope(safe.code, safe.message, null, false, requestId);
  }
});

function computeSimulationStatus(
  proposal: ActionProposal,
  preconditions: Readonly<Record<string, unknown>> | null,
): 'present' | 'missing' | 'stale' {
  const simulation = preconditions && (proposal.operation === 'create_rule'
    ? preconditions.reviewedSimulation ?? preconditions.simulation
    : preconditions.simulation);
  if (!simulation || typeof simulation !== 'object' || Array.isArray(simulation))
    return 'missing';
  const expiry = Date.parse(proposal.expiresAt);
  return !Number.isFinite(expiry) || expiry <= Date.now() ? 'stale' : 'present';
}
