/** POST /api/proposal/[id]/discard — supersede an active proposal without executing it. */

import { setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
} from '../../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'rule.execute');
  const requestId = crypto.randomUUID();
  const proposalId = event.context.params?.id;

  if (!proposalId) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_PROPOSAL_ID', 'Proposal ID is required.', authInfo, false, requestId);
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const proposal = await wf.store.getProposal(proposalId);
    if (!proposal) {
      setResponseStatus(event, 404);
      return errorEnvelope('PROPOSAL_NOT_FOUND', 'Proposal not found.', authInfo, false, requestId);
    }

    const superseded = await wf.store.supersedeProposal(proposalId);
    return okEnvelope(
      { proposalId: superseded.id, discarded: true },
      authInfo,
      requestId,
    );
  } catch (error) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'DISCARD_FAILED',
      error instanceof Error ? error.message : String(error),
      authInfo,
      false,
      requestId,
    );
  }
});
