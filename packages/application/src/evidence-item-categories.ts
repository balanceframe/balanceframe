import { z } from 'zod';
import type { EvidenceItemCategoryDecision, LiquidityActor } from '@balanceframe/workflow-store';
import type {
  FinancialSnapshot,
  TransactionEvidenceRequest,
  TransactionEvidenceResult,
} from '@balanceframe/protocol-generated';
const id = z.string().trim().min(1).max(256);
/** Only the human's explicit line and account/category choice crosses the client boundary. */
export const itemCategoryReviewInputSchema = z
  .object({ receiptId: id, lineId: id, accountId: id, categoryId: id.nullable() })
  .strict();
export type ItemCategoryReviewInput = z.infer<typeof itemCategoryReviewInputSchema>;
type Authority = (kind: 'account' | 'category', id: string, capability: string) => boolean;
/** Bind an explicit outcome to a conserved immutable receipt and server-selected review provenance. */
export function prepareItemCategoryDecisions(
  input: ItemCategoryReviewInput[],
  request: TransactionEvidenceRequest,
  result: TransactionEvidenceResult,
  snapshot: FinancialSnapshot | null,
  actor: LiquidityActor,
  now: string,
  authorized: Authority,
): EvidenceItemCategoryDecision[] {
  const seen = new Set<string>();
  return input.map((entry) => {
    const key = JSON.stringify([entry.receiptId, entry.lineId]);
    if (seen.has(key)) throw new Error('Duplicate item category decision');
    seen.add(key);
    const receipt = request.receipts.find((receipt) => receipt.id === entry.receiptId);
    const line = receipt?.lines.find((line) => line.id === entry.lineId);
    const observation = request.observations.find(
      (observation) => observation.id === receipt?.observationId,
    );
    if (
      !line ||
      !observation ||
      !result.receipts.some((receipt) => receipt.receiptId === entry.receiptId && receipt.valid)
    )
      throw new Error('Conserved current receipt item required');
    if (
      !actor.membershipId ||
      !actor.governancePolicyVersion ||
      !snapshot ||
      !authorized('account', entry.accountId, 'existence') ||
      !authorized('account', entry.accountId, 'transaction') ||
      (entry.categoryId !== null &&
        (!snapshot.legacySnapshot.accounts.some(
          (account) => account.id === entry.accountId && !account.isClosed,
        ) ||
          !snapshot.legacySnapshot.categories.some(
            (category) => category.id === entry.categoryId && !category.deleted,
          ) ||
          !authorized('category', entry.categoryId, 'category')))
    )
      throw new Error('Current item category account and category authority required');
    return {
      ...entry,
      documentId: observation.provenance.documentId,
      contentHash: observation.provenance.contentHash,
      parserVersion: observation.provenance.parserVersion,
      actorId: actor.actorId,
      membershipId: actor.membershipId,
      policyVersion: actor.governancePolicyVersion,
      reviewedAt: now,
    };
  });
}
/** Old proof never renews: mismatched source, policy, membership or grants abstain. */
export function applyReviewedItemCategories(
  request: TransactionEvidenceRequest,
  entries: EvidenceItemCategoryDecision[],
  actor: LiquidityActor,
  authorized: Authority,
): EvidenceItemCategoryDecision[] {
  return entries.filter((entry) => {
    if (
      entry.actorId !== actor.actorId ||
      entry.policyVersion !== actor.governancePolicyVersion ||
      entry.policyVersion !== request.policyVersion ||
      entry.membershipId !== actor.membershipId ||
      !authorized('account', entry.accountId, 'existence') ||
      !authorized('account', entry.accountId, 'transaction') ||
      (entry.categoryId !== null && !authorized('category', entry.categoryId, 'category'))
    )
      return false;
    const receipt = request.receipts.find((receipt) => receipt.id === entry.receiptId);
    const line = receipt?.lines.find((line) => line.id === entry.lineId);
    const observation = request.observations.find(
      (observation) => observation.id === receipt?.observationId,
    );
    if (
      !line ||
      !observation ||
      observation.provenance.documentId !== entry.documentId ||
      observation.provenance.contentHash !== entry.contentHash ||
      observation.provenance.parserVersion !== entry.parserVersion
    )
      return false;
    line.categoryId = entry.categoryId;
    return true;
  });
}
