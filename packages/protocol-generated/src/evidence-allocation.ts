/** Explicit reviewed funding matrices do not authenticate input sources or authorize ledger writes. */
import { z } from 'zod';
import {
  TransactionEvidenceRequestSchema,
  EvidenceObservationSchema,
  EvidenceProvenanceSchema,
  EvidenceRelationshipSchema,
} from './transaction-evidence.ts';
import { EvidenceSettlementLineCategorySchema } from './evidence-settlement.ts';
import { economicEventLedgerEffectSchema } from './validators.ts';
import type { EconomicEventLedgerEffect } from './index.js';
const id = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (v) => v.trim().length > 0 && new TextEncoder().encode(v).length <= 256 && !/\p{Cc}/u.test(v),
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const amount = z.lazy(() => EvidenceObservationSchema.shape.amount);
export const EvidenceAllocationCellSchema = z
  .object({ receiptId: id, lineId: id, targetObservationId: id, amount })
  .strict();
const selection = {
  receiptIds: z.array(id).min(1).max(100),
  targetObservationIds: z.array(id).min(1).max(100),
  lineCategories: z.array(z.lazy(() => EvidenceSettlementLineCategorySchema)).max(10000),
  cells: z.array(EvidenceAllocationCellSchema).max(10000),
};
export const EvidenceAllocationReviewSchema = z
  .object({
    contractVersion: z.literal('1'),
    sourceHash: hash,
    allocationSetHash: hash,
    ...selection,
  })
  .strict();
export const DeriveEvidenceAllocationPlanRequestSchema = z
  .object({
    contractVersion: z.literal('1'),
    evidence: z.lazy(() => TransactionEvidenceRequestSchema),
    deriveFundingRelationships: z.boolean().optional(),
    ...selection,
  })
  .strict();
export const EvidenceAllocationProjectionSchema = z
  .object({
    eventId: id,
    targetObservationId: id,
    ledgerTransactionId: id,
    evidenceIds: z.array(id),
    sources: z.array(z.lazy(() => EvidenceProvenanceSchema)),
    ledgerEffect: z.lazy(
      () => economicEventLedgerEffectSchema,
    ) as z.ZodType<EconomicEventLedgerEffect>,
  })
  .strict();
export const EvidenceAllocationRemainderSchema = z
  .object({ receiptId: id, lineId: id, amount })
  .strict();
export const EvidenceAllocationTargetRemainderSchema = z
  .object({ targetObservationId: id, amount })
  .strict();
export const EvidenceAllocationPlanSchema = z
  .object({
    contractVersion: z.literal('1'),
    sourceHash: hash,
    allocationSetHash: hash,
    review: EvidenceAllocationReviewSchema,
    projections: z.array(EvidenceAllocationProjectionSchema),
    remainders: z.array(EvidenceAllocationRemainderSchema),
    targetRemainders: z.array(EvidenceAllocationTargetRemainderSchema),
    fundingRelationships: z.array(z.lazy(() => EvidenceRelationshipSchema)).optional(),
  })
  .strict();
export type EvidenceAllocationCell = z.infer<typeof EvidenceAllocationCellSchema>;
export type EvidenceAllocationReview = z.infer<typeof EvidenceAllocationReviewSchema>;
export type DeriveEvidenceAllocationPlanRequest = z.infer<
  typeof DeriveEvidenceAllocationPlanRequestSchema
>;
export type EvidenceAllocationProjection = z.infer<typeof EvidenceAllocationProjectionSchema>;
export type EvidenceAllocationRemainder = z.infer<typeof EvidenceAllocationRemainderSchema>;
export type EvidenceAllocationTargetRemainder = z.infer<
  typeof EvidenceAllocationTargetRemainderSchema
>;
export type EvidenceAllocationPlan = z.infer<typeof EvidenceAllocationPlanSchema>;
