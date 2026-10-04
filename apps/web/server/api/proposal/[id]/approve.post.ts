import { defineEventHandler, getRouterParam, readBody, setHeader, setResponseStatus } from 'h3';
import { z } from 'zod';
import { getHumanControlAuth, hasTrustedRequestOrigin } from '../../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../../utils/reauthentication';
import { requireSelectedSpace } from '../../../utils/space-context';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
} from '../../../utils/workflow-store';
import type { AuthorizationInfo, EventWithContext } from '../../../utils/workflow-store';
const ProposalId = z.string().trim().min(1).max(200);
const ApprovalBody = z.object({
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  let authInfo: AuthorizationInfo | null = null;
  const deny = () => {
    setResponseStatus(event, 403);
    return errorEnvelope('FORBIDDEN', 'Approval is not authorized.', authInfo, false, requestId);
  };
  setHeader(event, 'Cache-Control', 'private, no-store');
  if (!hasTrustedRequestOrigin(event as ReauthenticationEvent)) return deny();
  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  if (!selected.space.budgetId) return deny();

  const parsedId = ProposalId.safeParse(getRouterParam(event, 'id'));
  if (!parsedId.success) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_PROPOSAL_ID', 'Proposal ID is required.', null, false, requestId);
  }
  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', 'Approval store is unavailable.', authInfo, true, requestId);
  }

  try {
    const proposal = await workflow.store.getProposal(parsedId.data);
    if (!proposal || proposal.spaceId !== selected.space.id || proposal.budgetId !== selected.space.budgetId)
      return deny();
    const capability = proposal.operation === 'set_category'
      ? 'categorization:approve'
      : proposal.operation === 'create_rule' || proposal.operation === 'update_rule' || proposal.operation === 'delete_rule'
        ? 'rule:approve'
        : null;
    if (!capability) return deny();
    const admission = await workflow.store.getProposalApprovalSummary({
      proposalId: proposal.id, spaceId: selected.space.id,
      actorId: selected.auth.actorId, auth: selected.auth, now: new Date().toISOString(),
      requestId,
    }).catch(() => null);
    if (!admission?.approvalAuthorized) return deny();
    authInfo = { actorId: selected.auth.actorId, capability, allowed: true };
    const body = ApprovalBody.safeParse(await readBody<unknown>(event).catch(() => null));
    if (!body.success) {
      setResponseStatus(event, 400);
      return errorEnvelope('DISPLAYED_PAYLOAD_HASH_REQUIRED', 'The displayed proposal hash is required.', authInfo, false, requestId);
    }

    if (proposal.payloadHash !== body.data.payloadHash) {
      setResponseStatus(event, 409);
      return errorEnvelope('PAYLOAD_HASH_MISMATCH', 'Review the current exact proposal before approving.', authInfo, false, requestId);
    }
    const policy = workflow.store.governance.getPolicy({ spaceId: selected.space.id });
    const expiryTime = Date.parse(proposal.expiresAt);
    if (!policy || proposal.governancePolicyVersion !== policy.version || proposal.supersededAt ||
        !Number.isFinite(expiryTime) || expiryTime <= Date.now()) {
      setResponseStatus(event, 409);
      return errorEnvelope('APPROVAL_CONFLICT', 'The proposal or current approval policy changed.', authInfo, false, requestId);
    }
    const controlAuth = await getHumanControlAuth(event as ReauthenticationEvent);
    if (!controlAuth || controlAuth.actorId !== selected.auth.actorId) {
      setResponseStatus(event, 403);
      return errorEnvelope('REAUTHENTICATION_REQUIRED', 'A recently reauthenticated human session is required.', authInfo, false, requestId);
    }
    const approval = await workflow.store.createApproval({
      proposalId: proposal.id,
      payloadHash: body.data.payloadHash,
      actorId: controlAuth.actorId,
      expiresAt: proposal.expiresAt,
      auth: controlAuth,
      now: new Date().toISOString(),
    });
    return okEnvelope(
      { approvalId: approval.id, proposalId: proposal.id, status: approval.status },
      authInfo,
      requestId,
    );
  } catch (error) {
    const conflict = error instanceof Error && /expired|supersed|mismatch|consumed|policy|hash/i.test(error.message);
    setResponseStatus(event, conflict ? 409 : 403);
    return errorEnvelope(
      conflict ? 'APPROVAL_CONFLICT' : 'FORBIDDEN',
      conflict ? 'The proposal or current approval policy changed.' : 'Approval is not authorized.',
      authInfo,
      false,
      requestId,
    );
  }
});
