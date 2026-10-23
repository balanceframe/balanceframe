import { z } from 'zod';
import { moneySchema } from '@balanceframe/protocol-generated/validators';
const money = z.unknown().transform((value) => moneySchema.parse(value));
const target = z.object({
  id: z.string(),
  date: z.string(),
  amount: money,
  payeeName: z.string().nullable(),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  splits: z.array(
    z.object({
      id: z.string(),
      categoryId: z.string().nullable(),
      categoryName: z.string().nullable(),
      amount: money,
    }),
  ),
});
export const evidenceSettlementTargetsSchema = z.object({ transactions: z.array(target) });
export type EvidenceSettlementTarget = z.infer<typeof target>;
export interface EvidenceSettlementMatch {
  eventId: string;
  relationshipId: string;
  accountId: string;
  transaction: EvidenceSettlementTarget;
}
