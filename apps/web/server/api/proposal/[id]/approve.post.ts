/**
 * POST /api/proposal/[id]/approve — approve an exact categorization or rule proposal.
 * The authenticated issuer must currently hold the operation's execution
 * capability in the proposal's budget. The store repeats that check atomically
 * at issuance and consumption; response metadata is never authorization.
 */
import { setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  getActorId,
  okEnvelope,
  errorEnvelope,
} from '../../../utils/workflow-store';
import type { AuthorizationInfo } from '../../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  let authInfo: AuthorizationInfo | null = null;
  const denied = () => {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Approval is not authorized.', null, false, requestId);
  };

  const auth = event.context.auth;
  const hasIdentity =
    (typeof auth?.user?.id === 'string' && auth.user.id.length > 0) ||
    (typeof auth?.actorId === 'string' && auth.actorId.length > 0);
  if (!auth?.authenticated || !hasIdentity) return denied();

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope(
      'STORE_UNAVAILABLE',
      'Approval store is unavailable.',
      null,
      false,
      requestId,
    );
  }

  const proposalId = event.context.params?.id;
  if (!proposalId) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_PROPOSAL_ID', 'Proposal ID is required.', null, false, requestId);
  }

  try {
    // Load only for internal authorization. Missing and inaccessible resources
    // have the same public denial, including their lifecycle state.
    const proposal = await wf.store.getProposal(proposalId);
    if (!proposal) return denied();
    const capability =
      proposal.operation === 'set_category'
        ? 'categorization:execute'
        : proposal.operation === 'create_rule'
          ? 'rule:execute'
          : null;
    if (!capability) return denied();
    const actorId = getActorId(event);
    const authorization = await wf.store.evaluateAuthorization(
      actorId,
      capability,
      `budget:${proposal.budgetId}`,
      proposal.policyVersion,
    );
    if (!authorization.allowed) return denied();
    authInfo = { actorId, capability, allowed: authorization.allowed };

    if (proposal.supersededAt) {
      setResponseStatus(event, 409);
      return errorEnvelope(
        'PROPOSAL_SUPERSEDED',
        'This proposal has been superseded.',
        authInfo,
        false,
        requestId,
      );
    }
    const expiryTime = new Date(proposal.expiresAt).getTime();
    if (!Number.isFinite(expiryTime) || expiryTime <= Date.now()) {
      setResponseStatus(event, 409);
      return errorEnvelope(
        'PROPOSAL_EXPIRED',
        'This proposal has expired.',
        authInfo,
        false,
        requestId,
      );
    }

    const approval = await wf.store.createApproval({
      proposalId,
      payloadHash: proposal.payloadHash,
      actorId,
      expiresAt: proposal.expiresAt,
    });
    return okEnvelope(
      { approvalId: approval.id, proposalId, status: approval.status },
      authInfo,
      requestId,
    );
  } catch {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'APPROVAL_FAILED',
      'Approval could not be issued.',
      null,
      false,
      requestId,
    );
  }
});
