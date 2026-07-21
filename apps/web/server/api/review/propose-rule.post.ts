/**
 * POST /api/review/propose-rule — create a rule proposal from a review item.
 *
 * Accepts JSON body: { reviewId, merchant, categoryId }.
 * Creates a 'create_rule' proposal in the workflow store, linked to the
 * current review item context.  The proposal can then be approved and
 * executed through the standard proposal pipeline.
 */

import { readBody } from 'h3';
import {
  getWorkflowStore,
  getActorId,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
} from '../../utils/workflow-store';

export default defineEventHandler(async (event) => {
  const authInfo = buildAuthorizationInfo(event, 'rule.create');
  const requestId = crypto.randomUUID();

  // Parse and validate body
  let body: Record<string, unknown>;
  try {
    body = (await readBody(event)) ?? {};
  } catch {
    setResponseStatus(event, 400);
    return errorEnvelope('INVALID_JSON', 'Request body must be valid JSON', authInfo, false, requestId);
  }

  const reviewId = typeof body.reviewId === 'string' ? body.reviewId.trim() : '';
  const merchant = typeof body.merchant === 'string' ? body.merchant.trim() : '';
  const categoryId = typeof body.categoryId === 'string' ? body.categoryId.trim() : '';

  if (!reviewId || !merchant || !categoryId) {
    setResponseStatus(event, 422);
    return errorEnvelope(
      'MISSING_FIELDS',
      'reviewId, merchant, and categoryId are required',
      authInfo,
      false,
      requestId,
    );
  }

  const actorId = getActorId(event);

  const wf = getWorkflowStore(event);
  if ('error' in wf) {
    setResponseStatus(event, 503);
    return errorEnvelope('STORE_UNAVAILABLE', wf.error, authInfo, false, requestId);
  }

  try {
    const proposal = await wf.store.createProposal({
      operation: 'create_rule',
      budgetId: '',
      transactionId: reviewId,
      categoryId,
      payloadHash: crypto.randomUUID(),
      policyVersion: '1.0',
      preconditions: JSON.stringify({
        merchant,
        source: 'review',
        reviewId,
      }),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      actorId,
      provenance: 'review-action',
      providerModel: null,
      correlationId: requestId,
    });

    return okEnvelope(
      {
        proposalId: proposal.id,
        operation: 'create_rule',
        merchant,
        categoryId,
        message: 'Rule proposal created. Use proposals.approve to authorize and proposals.execute to create the rule.',
      },
      authInfo,
      requestId,
    );
  } catch (e) {
    setResponseStatus(event, 500);
    return errorEnvelope(
      'PROPOSAL_FAILED',
      e instanceof Error ? e.message : 'Failed to create rule proposal',
      authInfo,
      false,
      requestId,
    );
  }
});
