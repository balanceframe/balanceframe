/** POST /api/proposal/[id]/discard — supersede an active proposal without executing it. */

import { defineEventHandler, getRouterParam, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { getHumanControlAuth, hasTrustedRequestOrigin } from '../../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../../utils/reauthentication';
import { requireSelectedSpace } from '../../../utils/space-context';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
} from '../../../utils/workflow-store';
import type { EventWithContext } from '../../../utils/workflow-store';

const ProposalId = z.string().trim().min(1).max(200);

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as ReauthenticationEvent)) {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Proposal discard is not authorized.', null, false, requestId);
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
    return errorEnvelope('MISSING_PROPOSAL_ID', 'Proposal ID is required.', null, false, requestId);
  }
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Proposal store is unavailable.', null, false, requestId);
  }

  try {
    const controlAuth = await getHumanControlAuth(event as ReauthenticationEvent);
    if (!controlAuth || controlAuth.actorId !== selected.auth.actorId) {
      setResponseStatus(event, 403);
      return errorEnvelope('HUMAN_CONTROL_REQUIRED', 'A recently reauthenticated human session is required.', null, false, requestId);
    }

    const now = new Date().toISOString();
    const summary = await workflow.store.getProposalApprovalSummary({
      proposalId: parsedId.data,
      spaceId: selected.space.id,
      actorId: selected.auth.actorId,
      auth: selected.auth,
      now,
      requestId,
    }).catch(() => null);
    if (!summary?.executionAuthorized) {
      setResponseStatus(event, 404);
      return errorEnvelope('PROPOSAL_NOT_FOUND', 'Proposal not found.', null, false, requestId);
    }

    const proposal = await workflow.store.getProposal(parsedId.data);
    if (!proposal || proposal.spaceId !== selected.space.id || proposal.budgetId !== selected.space.budgetId) {
      setResponseStatus(event, 404);
      return errorEnvelope('PROPOSAL_NOT_FOUND', 'Proposal not found.', null, false, requestId);
    }
    const capability = proposal.operation === 'set_category'
      ? 'categorization:execute'
      : proposal.operation === 'create_rule' || proposal.operation === 'update_rule' || proposal.operation === 'delete_rule'
        ? 'rule:execute'
        : null;
    if (!capability) {
      setResponseStatus(event, 404);
      return errorEnvelope('PROPOSAL_NOT_FOUND', 'Proposal not found.', null, false, requestId);
    }

    const policy = workflow.store.governance.getPolicy({ spaceId: selected.space.id });
    if (!policy) {
      setResponseStatus(event, 409);
      return errorEnvelope('DISCARD_CONFLICT', 'Proposal could not be discarded.', null, false, requestId);
    }
    const superseded = await workflow.store.discardProposal(parsedId.data, controlAuth.actorId, {
      spaceId: selected.space.id, governancePolicyVersion: policy.version,
      now, auth: controlAuth,
    });
    if (!superseded) {
      setResponseStatus(event, 409);
      return errorEnvelope('DISCARD_CONFLICT', 'Proposal could not be discarded.', null, false, requestId);
    }
    return okEnvelope(
      { proposalId: superseded.id, discarded: true },
      null,
      requestId,
    );
  } catch {
    setResponseStatus(event, 409);
    return errorEnvelope('DISCARD_CONFLICT', 'Proposal could not be discarded.', null, false, requestId);
  }
});
