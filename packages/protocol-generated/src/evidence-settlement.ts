/** Pure native receipt allocation planning does not authenticate sources or authorize ledger writes. */
import { z } from 'zod';
import type { EconomicEventLedgerEffect } from './index.js';
import {
  EvidenceObservationSchema,
  EvidenceProvenanceSchema,
  TransactionEvidenceRequestSchema,
} from './transaction-evidence.ts';
import { economicEventLedgerEffectSchema } from './validators.ts';
const id = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      new TextEncoder().encode(value).length <= 256 &&
      !/\p{Cc}/u.test(value),
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const EvidenceSettlementLineCategorySchema = z
  .object({ receiptId: id, lineId: id, categoryId: id })
  .strict();
export const DeriveEvidenceSettlementPlanRequestSchema = z
  .object({
    contractVersion: z.literal('1'),
    evidence: z.lazy(() => TransactionEvidenceRequestSchema),
    targetObservationId: id,
    receiptIds: z.array(id).min(1).max(100),
    lineCategories: z.array(EvidenceSettlementLineCategorySchema).max(10000),
  })
  .strict();
export const EvidenceSettlementContributionSchema = z
  .object({
    receiptId: id,
    lineId: id,
    categoryId: id,
    amount: z.lazy(() => EvidenceObservationSchema.shape.amount),
  })
  .strict();
export const EvidenceSettlementPlanSchema = z
  .object({
    contractVersion: z.literal('1'),
    resolutionHash: hash,
    allocationHash: hash,
    eventId: id,
    targetObservationId: id,
    ledgerTransactionId: id,
    evidenceIds: z.array(id),
    sources: z.array(z.lazy(() => EvidenceProvenanceSchema)),
    contributions: z.array(EvidenceSettlementContributionSchema),
    ledgerEffect: z.lazy(
      () => economicEventLedgerEffectSchema,
    ) as z.ZodType<EconomicEventLedgerEffect>,
  })
  .strict();
export type EvidenceSettlementLineCategory = z.infer<typeof EvidenceSettlementLineCategorySchema>;
export type DeriveEvidenceSettlementPlanRequest = z.infer<
  typeof DeriveEvidenceSettlementPlanRequestSchema
>;
export type EvidenceSettlementContribution = z.infer<typeof EvidenceSettlementContributionSchema>;
export type EvidenceSettlementPlan = z.infer<typeof EvidenceSettlementPlanSchema>;
