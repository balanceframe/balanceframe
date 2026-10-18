import { defineEventHandler, getRouterParam, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { createWebConsequentialActionService, selectedLiquidityActor } from '../../../utils/liquidity-service';
import { projectConsequentialActionExecution } from '../../../utils/proposal-route';
import { hasTrustedRequestOrigin } from '../../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../../utils/reauthentication';
import { requireSelectedSpace } from '../../../utils/space-context';
import { errorEnvelope, getWorkflowStore, okEnvelope } from '../../../utils/workflow-store';
import type { EventWithContext } from '../../../utils/workflow-store';

const ProposalId = z.string().trim().min(1).max(200);

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as unknown as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Proposal reconciliation is unavailable.', null, false, requestId);
  }
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  if (!selected.space.budgetId) {
    setResponseStatus(event, 409);
    return errorEnvelope('SPACE_BUDGET_REQUIRED', 'The selected space has no bound budget.', null, false, requestId);
  }
  const parsedId = ProposalId.safeParse(getRouterParam(event, 'id'));
  if (!parsedId.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_PROPOSAL_ID', 'Proposal ID is required.', null, false, requestId);
  }
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Proposal reconciliation is unavailable.', null, false, requestId);
  }
  try {
    const proposal = await workflow.store.getProposal(parsedId.data);
    if (!proposal || proposal.operation !== 'consequential_action' ||
        proposal.spaceId !== selected.space.id || proposal.budgetId !== selected.space.budgetId) {
      setResponseStatus(event, 404);
      return errorEnvelope('NOT_FOUND', 'Proposal is unavailable in the selected space.', null, false, requestId);
    }
    const actor = selectedLiquidityActor(workflow.store, selected);
    if (!actor) {
      setResponseStatus(event, 403);
      return errorEnvelope('FORBIDDEN', 'The selected space is unavailable.', null, false, requestId);
    }
    const service = await createWebConsequentialActionService(workflow.store);
    const result = await service.reconcile(actor, proposal.id);
    return okEnvelope(projectConsequentialActionExecution(result), null, requestId);
  } catch {
    setResponseStatus(event, 409);
    return errorEnvelope('RECONCILIATION_UNAVAILABLE', 'The action outcome could not be reconciled. No financial action was dispatched.', null, false, requestId);
  }
});
