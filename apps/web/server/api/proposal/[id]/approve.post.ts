/**
 * POST /api/proposal/[id]/approve — explicitly approve a rule proposal.
 *
 * Creates an active approval record bound to the proposal's payload hash.
 * The subsequent execute step will verify and consume this approval before
 * creating the Actual rule.
 *
 * Error codes:
 *   400 — MISSING_PROPOSAL_ID
 *   404 — PROPOSAL_NOT_FOUND
 *   409 — PROPOSAL_SUPERSEDED / PROPOSAL_EXPIRED
 *   503 — STORE_UNAVAILABLE
 *   500 — APPROVAL_FAILED
 */

import { setResponseStatus } from 'h3';
import {
  getWorkflowStore,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
} from '../../../utils/workflow-store';
import type { CreateApprovalInput } from '@balanceframe/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'rule.execute');
  const requestId = crypto.randomUUID();

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  const proposalId = event.context.params?.id;
  if (!proposalId) {
    setResponseStatus(event, 400);
    return errorEnvelope('MISSING_PROPOSAL_ID', 'Proposal ID is required.', authInfo, false, requestId);
  }

  try {
    // Load the proposal to verify it exists and is not superseded/expired
    const proposal = await wf.store.getProposal(proposalId);
    if (!proposal) {
      setResponseStatus(event, 404);
      return errorEnvelope('PROPOSAL_NOT_FOUND', 'Proposal not found.', authInfo, false, requestId);
    }

    if (proposal.supersededAt) {
      setResponseStatus(event, 409);
      return errorEnvelope(
        'PROPOSAL_SUPERSEDED',
        'This proposal has already been superseded.',
        authInfo,
        false,
        requestId,
      );
    }

    const expiryTime = new Date(proposal.expiresAt).getTime();
    if (expiryTime <= Date.now()) {
      setResponseStatus(event, 409);
      return errorEnvelope(
        'PROPOSAL_EXPIRED',
        'This proposal has expired.',
        authInfo,
        false,
        requestId,
      );
    }

    const actorId = authInfo?.actorId ?? 'anonymous';
    const approvalInput: CreateApprovalInput = {
      proposalId,
      payloadHash: proposal.payloadHash,
      actorId,
      expiresAt: proposal.expiresAt,
    };

    const approval = await wf.store.createApproval(approvalInput);

    return okEnvelope(
      {
        approvalId: approval.id,
        proposalId,
        status: 'active',
      },
      authInfo,
      requestId,
    );
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'APPROVAL_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
      false,
      requestId,
    );
  }
});
