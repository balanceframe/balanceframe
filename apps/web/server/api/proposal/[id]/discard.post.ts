/** POST /api/proposal/[id]/discard — supersede an active proposal without executing it. */

import { setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  getActorId,
} from '../../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const auth = event.context.auth;
  const requestId = crypto.randomUUID();
  const denied = () => {
    setResponseStatus(event, 403);
    return errorEnvelope(
      'FORBIDDEN',
      'Proposal discard is not authorized.',
      null,
      false,
      requestId,
    );
  };
  const hasIdentity =
    (typeof auth?.user?.id === 'string' && auth.user.id.length > 0) ||
    (typeof auth?.actorId === 'string' && auth.actorId.length > 0);
  if (!auth?.authenticated || !hasIdentity) return denied();
  const proposalId = event.context.params?.id;

  if (!proposalId) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_PROPOSAL_ID', 'Proposal ID is required.', null, false, requestId);
  }

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope(
      'STORE_UNAVAILABLE',
      'Proposal store is unavailable.',
      null,
      false,
      requestId,
    );
  }

  try {
    const actorId = getActorId(event);
    const superseded = await wf.store.discardProposal(proposalId, actorId);
    if (!superseded) return denied();
    const capability =
      superseded.operation === 'set_category' ? 'categorization:execute' : 'rule:execute';
    return okEnvelope(
      { proposalId: superseded.id, discarded: true },
      { actorId, capability, allowed: true },
      requestId,
    );
  } catch {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'DISCARD_FAILED',
      'Proposal could not be discarded.',
      null,
      false,
      requestId,
    );
  }
});
