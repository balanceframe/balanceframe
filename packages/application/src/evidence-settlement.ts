import { z } from 'zod';
const id = z.string().trim().min(1).max(256);
/** Client selectors contain no money, graph authority, policy or source proof. */
export const evidenceSettlementPreviewSchema = z
  .object({
    resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
    targetTransactionId: id,
    receiptIds: z.array(id).min(1).max(100),
    lineCategories: z
      .array(z.object({ receiptId: id, lineId: id, categoryId: id }).strict())
      .min(1)
      .max(10000),
  })
  .strict();
/** A fresh human saves only the recomputed exact native allocation preview. */
export const evidenceSettlementSaveSchema = evidenceSettlementPreviewSchema
  .extend({
    allocationHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** Partial discovery broadens amount matching only; current source and transaction permissions still apply. */
export const evidenceSettlementTargetsInputSchema = z
  .object({
    resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
    eventId: id,
    accountId: id,
    matchMode: z.enum(['exact', 'partial']).optional(),
  })
  .strict();
