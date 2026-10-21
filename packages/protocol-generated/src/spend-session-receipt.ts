/** Pure comparison inputs do not authenticate source origin or authorize any financial action. */
import { z } from 'zod';
import {
  EvidenceObservationSchema,
  TransactionEvidenceRequestSchema,
} from './transaction-evidence.ts';
import {
  decisionCardItemSchema,
  decisionCardAdjustmentSchema,
  decisionCardWarningThresholdSchema,
  decisionCardPriceProvenanceSchema,
} from './validators.ts';
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
const money = z.lazy(() => EvidenceObservationSchema.shape.amount);
// Lazy shared-cart schemas avoid eager initialization through the public validator barrel.
export const SavedSessionReceiptItemSchema = z.lazy(() =>
  decisionCardItemSchema
    .omit({ routeSelection: true, priority: true, priceProvenance: true })
    .extend({
      accountId: id.nullable(),
      priority: z.enum(['required', 'planned', 'optional']).optional(),
      priceProvenance: decisionCardPriceProvenanceSchema.nullable(),
    })
    .strict(),
);
export const SavedSessionReceiptIntentSchema = z
  .object({
    kind: z.literal('session_completion_intent_v1'),
    id,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    accountId: id.nullable(),
    items: z.array(SavedSessionReceiptItemSchema).max(100),
    adjustments: z.array(z.lazy(() => decisionCardAdjustmentSchema)).max(100),
    warningThresholds: z.array(z.lazy(() => decisionCardWarningThresholdSchema)).max(100),
  })
  .strict();
export const SessionReceiptSnapshotSchema = z
  .object({
    documentId: id,
    contentHash: hash,
    parserVersion: id,
    intentHash: hash,
    intent: SavedSessionReceiptIntentSchema,
  })
  .strict();
export const SessionReceiptSelectionSchema = z.object({ documentId: id, receiptId: id }).strict();
export const SessionReceiptPairSchema = z
  .object({ sessionItemId: id, receiptLineId: id, kind: z.enum(['same_item', 'substitution']) })
  .strict();
export const SessionReceiptReviewSchema = z
  .object({
    coverage: z.enum(['complete_purchase', 'partial_purchase', 'unknown']),
    pairs: z.array(SessionReceiptPairSchema).max(100),
    omittedItemIds: z.array(id).max(100),
    newLineIds: z.array(id).max(1000),
  })
  .strict();
export const CompareSpendSessionReceiptRequestSchema = z
  .object({
    contractVersion: z.literal('1'),
    sessionSnapshot: SessionReceiptSnapshotSchema,
    evidence: TransactionEvidenceRequestSchema,
    receipt: SessionReceiptSelectionSchema,
    review: SessionReceiptReviewSchema,
  })
  .strict();
export const SessionReceiptRowSchema = z
  .object({
    sessionItemId: id.nullable(),
    receiptLineId: id.nullable(),
    status: z.enum(['matched', 'substituted', 'new', 'omitted', 'unresolved']),
    changes: z.array(
      z.enum(['quantity_changed', 'reference_price_changed', 'line_amount_changed']),
    ),
    quantityComparison: z.enum(['unknown', 'same', 'changed']),
    priceComparison: z.enum(['unknown', 'same', 'changed', 'currency_mismatch']),
    priceBasis: z.enum(['unit_amount_vs_unit_gross', 'line_amount_vs_line_gross']).nullable(),
    plannedQuantityMicros: z.number().int().min(1).max(4294967295000000).nullable(),
    observedQuantityMicros: z.number().int().min(1).max(4294967295).nullable(),
    plannedReference: money.nullable(),
    observedReference: money.nullable(),
    reasonCodes: z.array(z.enum(['currency_mismatch', 'estimated_reference_price'])),
  })
  .strict();
export const SessionReceiptCandidateSchema = z
  .object({
    sessionItemId: id,
    receiptLineId: id,
    reasonCodes: z.array(z.enum(['identifier_text_match', 'ambiguous_identifier'])),
  })
  .strict();
export const CompareSpendSessionReceiptResultSchema = z
  .object({
    contractVersion: z.literal('1'),
    authority: z.literal('comparison_only'),
    comparisonHash: hash,
    sessionDocumentId: id,
    sessionId: id,
    sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    intentHash: hash,
    receiptDocumentId: id,
    receiptId: id,
    resolutionHash: hash,
    state: z.enum(['complete', 'review_required', 'blocked']),
    receiptTotal: money,
    rows: z.array(SessionReceiptRowSchema),
    candidates: z.array(SessionReceiptCandidateSchema),
    reasonCodes: z.array(
      z.enum(['receipt_not_valid_current_purchase', 'purchase_coverage_incomplete']),
    ),
  })
  .strict();
export type SavedSessionReceiptItem = z.infer<typeof SavedSessionReceiptItemSchema>;
export type SavedSessionReceiptIntent = z.infer<typeof SavedSessionReceiptIntentSchema>;
export type SessionReceiptSnapshot = z.infer<typeof SessionReceiptSnapshotSchema>;
export type SessionReceiptSelection = z.infer<typeof SessionReceiptSelectionSchema>;
export type SessionReceiptPair = z.infer<typeof SessionReceiptPairSchema>;
export type SessionReceiptReview = z.infer<typeof SessionReceiptReviewSchema>;
export type CompareSpendSessionReceiptRequest = z.infer<
  typeof CompareSpendSessionReceiptRequestSchema
>;
export type SessionReceiptRow = z.infer<typeof SessionReceiptRowSchema>;
export type SessionReceiptCandidate = z.infer<typeof SessionReceiptCandidateSchema>;
export type CompareSpendSessionReceiptResult = z.infer<
  typeof CompareSpendSessionReceiptResultSchema
>;
