import { defineEventHandler, readBody, setResponseStatus } from 'h3';
import { z } from 'zod';
import { getHumanControlAuth, hasTrustedRequestOrigin } from '../../utils/reauthentication';
import type { ReauthenticationEvent } from '../../utils/reauthentication';
import { requireSelectedSpace } from '../../utils/space-context';
import {
  errorEnvelope,
  getWorkflowStore,
  okEnvelope,
} from '../../utils/workflow-store';
import type { EventWithContext } from '../../utils/workflow-store';
import type { ActionProposal, ReviewItem } from '@balanceframe/workflow-store';

const BulkApprovalBody = z.object({
  ids: z.array(z.string().trim().min(1).max(200)).min(1),
  payloadHashes: z.record(
    z.string().min(1).max(200),
    z.string().regex(/^[a-f0-9]{64}$/i),
  ),
}).strict();
const StoredSetCategoryPayload = z.object({
  kind: z.literal('set_category'),
  transactionId: z.string().min(1),
  categoryId: z.string().min(1),
}).passthrough();

const StoredReviewPreconditions = z.object({
  reviewId: z.string().min(1),
}).passthrough();


export default defineEventHandler(async (event) => {
  const requestId = crypto.randomUUID();
  const deny = (status: number, code: string) => {
    setResponseStatus(event, status);
    return errorEnvelope(code, 'Bulk approval could not be created.', null, false, requestId);
  };

  if (!hasTrustedRequestOrigin(event as ReauthenticationEvent))
    return deny(403, 'FORBIDDEN');

  const selected = await requireSelectedSpace(event as unknown as EventWithContext);
  if (!selected.ok) return selected.response;
  if (!selected.space.budgetId || selected.auth.method !== 'session')
    return deny(403, 'FORBIDDEN');

  let rawBody: unknown;
  try {
    rawBody = await readBody(event);
  } catch {
    return deny(400, 'INVALID_REQUEST');
  }
  const parsed = BulkApprovalBody.safeParse(rawBody);
  if (!parsed.success) return deny(400, 'INVALID_REQUEST');
  const { ids, payloadHashes } = parsed.data;
  if (new Set(ids).size !== ids.length ||
      Object.keys(payloadHashes).length !== ids.length ||
      ids.some((id) => !Object.hasOwn(payloadHashes, id)))
    return deny(400, 'INVALID_REQUEST');


  const workflow = getWorkflowStore(event as unknown as EventWithContext);
  if ('error' in workflow) return deny(503, 'STORE_UNAVAILABLE');

  const controlAuth = await getHumanControlAuth(event as ReauthenticationEvent);
  if (!controlAuth || controlAuth.actorId !== selected.auth.actorId)
    return deny(403, 'REAUTHENTICATION_REQUIRED');

  try {
    const now = new Date().toISOString();
    const candidates: { review: ReviewItem; proposal: ActionProposal }[] = [];
    for (const reviewId of ids) {
      const review = await workflow.store.getReviewItem(reviewId);
      if (!review || review.budgetId !== selected.space.budgetId)
        return deny(409, 'REVIEW_UNAVAILABLE');

      const proposal = await workflow.store.findActiveProposal(
        review.budgetId,
        review.transactionId,
        'set_category',
      );
      if (!proposal) return deny(409, 'REVIEW_UNAVAILABLE');
      const summary = await workflow.store.getProposalApprovalSummary({
        proposalId: proposal.id,
        spaceId: selected.space.id,
        actorId: selected.auth.actorId,
        auth: selected.auth,
        now,
        requestId,
      }).catch(() => null);
      if (!summary?.approvalAuthorized || !summary.canApprove)
        return deny(409, 'REVIEW_UNAVAILABLE');
      candidates.push({ review, proposal });
    }

    const approvals: { reviewId: string; proposalId: string; payloadHash: string }[] = [];
    for (const { review, proposal } of candidates) {
      if (
        review.status !== 'pending_review' ||
        proposal.operation !== 'set_category' ||
        proposal.spaceId !== selected.space.id ||
        proposal.budgetId !== selected.space.budgetId ||
        proposal.supersededAt !== null ||
        proposal.payloadHash !== payloadHashes[review.id]
      ) return deny(409, 'REVIEW_UNAVAILABLE');

      const payload = StoredSetCategoryPayload.safeParse(proposal.payload);
      let preconditions: unknown;
      try {
        preconditions = JSON.parse(proposal.preconditions);
      } catch {
        return deny(409, 'REVIEW_UNAVAILABLE');
      }
      const parsedPreconditions = StoredReviewPreconditions.safeParse(preconditions);
      if (
        !payload.success || payload.data.transactionId !== review.transactionId ||
        !parsedPreconditions.success || parsedPreconditions.data.reviewId !== review.id
      ) return deny(409, 'REVIEW_UNAVAILABLE');

      approvals.push({ reviewId: review.id, proposalId: proposal.id, payloadHash: proposal.payloadHash });
    }

    const created = await workflow.store.createApprovals({
      spaceId: selected.space.id,
      approvals: approvals.map(({ proposalId, payloadHash }) => ({ proposalId, payloadHash })),
      auth: controlAuth,
      now,
      requestId,
      correlationId: requestId,
    });
    return okEnvelope({
      items: approvals.map((item, index) => ({
        reviewId: item.reviewId,
        proposalId: item.proposalId,
        approvalId: created[index]!.id,
        status: created[index]!.status,
        expiresAt: created[index]!.expiresAt,
      })),
    }, null, requestId);
  } catch {
    return deny(409, 'APPROVAL_CONFLICT');
  }
});
