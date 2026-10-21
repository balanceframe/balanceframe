import { z } from 'zod';
import { EvidenceAllocationCellSchema } from '@balanceframe/protocol-generated/validators';
const id = z.string().trim().min(1).max(256);
/** Humans select exact matrix cells; Rust derives pair totals, remainders and ledger consequences. */
export const evidenceAllocationPreviewSchema = z
  .object({
    resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
    targetTransactionIds: z.array(id).min(1).max(100),
    receiptIds: z.array(id).min(1).max(100),
    lineCategories: z
      .array(z.object({ receiptId: id, lineId: id, accountId: id, categoryId: id }).strict())
      .min(1)
      .max(10000),
    cells: z
      .array(
        EvidenceAllocationCellSchema.omit({ targetObservationId: true })
          .extend({ targetTransactionId: id })
          .strict(),
      )
      .max(10000),
  })
  .strict();
/** Saving reconfirms the exact recomputed native manifest under fresh human authority. */
export const evidenceAllocationSaveSchema = evidenceAllocationPreviewSchema
  .extend({ allocationSetHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
