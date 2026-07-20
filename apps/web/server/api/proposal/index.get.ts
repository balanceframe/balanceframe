/**
 * GET /api/proposal — list categorization proposals.
 *
 * Queries persisted proposals from the workflow store.
 * Returns non-superseded proposals ordered by creation time descending.
 *
 * Response envelope:
 *   { proposals: CategorizationProposal[], total: number }
 */

import type { CategorizationProposal } from '@balanceframe/workflow-store';
import { getWorkflowStore, okEnvelope, errorEnvelope, buildAuthorizationInfo } from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'observe');
  const requestId = crypto.randomUUID();

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const proposals = await wf.store.listProposals({ superseded: false });

    return okEnvelope(
      { proposals, total: proposals.length },
      authInfo,
      requestId,
    );
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'LIST_FAILED',
      e instanceof Error ? e.message : String(e),
      authInfo,
      false,
      requestId,
    );
  }
});
