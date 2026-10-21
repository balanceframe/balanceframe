import { z } from 'zod';
const id = z.string().trim().min(1).max(256);
/** Immutable server-selected human review provenance over exact normalized line identity. */
export const evidenceItemCategoryDecisionSchema = z
  .object({
    documentId: id,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    parserVersion: id,
    receiptId: id,
    lineId: id,
    accountId: id,
    categoryId: id.nullable(),
    policyVersion: id,
    membershipId: id,
    actorId: id,
    reviewedAt: z.string().datetime(),
  })
  .strict();
export type EvidenceItemCategoryDecision = z.infer<typeof evidenceItemCategoryDecisionSchema>;
