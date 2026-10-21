import {
  WalletStatementProofSchema,
  WalletStatementCoverageSchema,
  WalletStatementBalanceAnchorSchema,
} from './wallet-statement.ts';
import { EvidenceAllocationReviewSchema } from './evidence-allocation.ts';
import { z } from 'zod';
import type { EconomicEventLedgerEffect, SourceObservation } from './index.js';
import { economicEventLedgerEffectSchema, sourceObservationSchema } from './validators.ts';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (v) =>
      Array.from(v).every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && (code < 127 || code > 159);
      }) && new TextEncoder().encode(v).length <= 256,
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const money = z
  .object({
    minorUnits: z
      .string()
      .max(19)
      .regex(/^(0|[1-9][0-9]*)$/)
      .refine(
        (v) => /^(0|[1-9][0-9]*)$/.test(v) && v.length <= 19 && BigInt(v) <= 9223372036854775807n,
      ),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const instant = z.string().datetime({ offset: true });
export const EvidenceProvenanceSchema = z
  .object({
    documentId: id,
    contentHash: hash,
    parserVersion: id,
    sourceTimestamp: instant,
    receivedAt: instant,
  })
  .strict();
export const EvidenceObservationSchema = z
  .object({
    reviewedLedgerEffect: z.boolean().optional(),
    ledgerAccountId: id.optional(),
    id,
    kind: z.enum([
      'ledger_transaction',
      'wallet_payment',
      'wallet_transfer',
      'wallet_fee',
      'wallet_refund',
      'wallet_request',
      'receipt',
      'order',
      'spend_session_item',
      'user_correction',
    ]),
    sourceId: id,
    externalEventId: id.nullable(),
    date,
    amount: money,
    direction: z.enum(['inflow', 'outflow']),
    status: z.enum(['pending', 'completed', 'reversed', 'superseded']),
    eventType: z.enum([
      'purchase',
      'p2p_payment',
      'transfer',
      'reimbursement',
      'refund',
      'fee',
      'mixed',
      'unknown',
      'repayment',
      'rent_contribution',
      'gift',
      'business_income',
      'income',
      'self_transfer',
    ]),
    counterparty: id.nullable(),
    fundingInstrumentId: id.nullable(),
    walletId: id.nullable(),
    ledgerTransactionId: id.nullable(),
    ledgerEffect: z
      .lazy(() => economicEventLedgerEffectSchema)
      .nullable() as z.ZodType<EconomicEventLedgerEffect | null>,
    reliability: z.number().int().min(0).max(100),
    provenance: EvidenceProvenanceSchema,
  })
  .strict();
export const EvidenceRelationshipSchema = z
  .object({
    id,
    fromId: id,
    toId: id,
    kind: z.enum([
      'same_event',
      'funding',
      'partial_funding',
      'settlement',
      'transfer',
      'reimbursement',
      'refund',
      'reversal',
      'supersession',
      'containment',
      'corroboration',
    ]),
    state: z.enum(['candidate', 'confirmed', 'rejected', 'superseded']),
    allocatedAmount: money.nullable(),
    partial: z.boolean(),
    score: z.number().int().min(0).max(100),
    reasonCodes: z.array(id),
    evidenceIds: z.array(id),
  })
  .strict();
export const WalletEvidenceSchema = z
  .object({
    walletId: id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    openingBalance: money.nullable(),
    closingBalance: money.nullable(),
    completeActivity: z.boolean(),
    materializedAccountId: id.nullable(),
    requiresStoredValue: z.boolean(),
  })
  .strict();
export const ReceiptLineSchema = z
  .object({
    id,
    rawDescription: z.string().max(4096),
    normalizedDescription: z.string().max(4096),
    sku: id.nullable(),
    department: id.nullable(),
    productFamily: id.nullable(),
    quantityMicros: z.number().int().positive().max(4294967295),
    unitGross: money,
    gross: money,
    discount: money,
    tax: money,
    net: money,
    categoryId: id.nullable(),
    memberId: id.nullable(),
    evidenceStrength: z.number().int().min(0).max(100),
    reasonCodes: z.array(id),
    returnOfLineId: id.nullable(),
  })
  .strict();
export const ReceiptEvidenceSchema = z
  .object({
    id,
    observationId: id,
    version: z.number().int().positive().max(4294967295),
    supersedesId: id.nullable(),
    fulfillmentGroupId: id.nullable(),
    total: money,
    discount: money,
    tax: money,
    lines: z.array(ReceiptLineSchema).max(1000),
    tenders: z
      .array(
        z
          .object({
            id,
            kind: z.enum(['card', 'bank', 'gift_card', 'reward', 'wallet', 'cash']),
            partial: z.boolean().optional(),
            amount: money,
            observationId: id.nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const TransactionEvidenceRequestSchema = z
  .object({
    allocationReview: z
      .lazy(() => EvidenceAllocationReviewSchema)
      .nullable()
      .optional(),
    statementProofs: z.array(WalletStatementProofSchema).max(100).optional(),
    contractVersion: z.literal('1'),
    policyVersion: id,
    maxSettlementDays: z.number().int().min(0).max(90),
    observations: z.array(EvidenceObservationSchema).max(10000),
    relationships: z.array(EvidenceRelationshipSchema).max(20000),
    wallets: z.array(WalletEvidenceSchema).max(1000),
    receipts: z.array(ReceiptEvidenceSchema).max(1000),
  })
  .strict();
/** Pure native preview inputs; admitting or reviewing a statement remains a server operation. */
export const DeriveWalletStatementPreviewRequestSchema = z
  .object({
    contractVersion: z.literal('1'),
    evidence: TransactionEvidenceRequestSchema,
    walletId: id,
    startDate: date,
    endDate: date,
  })
  .strict()
  .refine((r) => r.startDate <= r.endDate);
export type DeriveWalletStatementPreviewRequest = z.infer<
  typeof DeriveWalletStatementPreviewRequestSchema
>;
export const EvidenceBlockerSchema = z
  .object({ code: id, subjectId: id, evidenceIds: z.array(id) })
  .strict();
export const ResolvedEconomicEventSchema = z
  .object({
    projectionObservations: z.array(z.lazy(() => sourceObservationSchema)).optional(),
    allocationSetHash: hash.optional(),
    id,
    version: z.literal('1'),
    eventType: EvidenceObservationSchema.shape.eventType,
    state: z.enum(['resolved', 'ambiguous', 'unmatched', 'blocked']),
    amount: money,
    observationIds: z.array(id),
    evidenceIds: z.array(id),
    reasonCodes: z.array(id),
    projectionObservation: z
      .lazy(() => sourceObservationSchema)
      .nullable() as z.ZodType<SourceObservation | null>,
  })
  .strict();
export const TransactionEvidenceResultSchema = z
  .object({
    contractVersion: z.literal('1'),
    policyVersion: id,
    resolutionHash: hash,
    events: z.array(ResolvedEconomicEventSchema),
    relationships: z.array(EvidenceRelationshipSchema),
    wallets: z.array(
      z
        .object({
          coverage: WalletStatementCoverageSchema.optional(),
          balanceAnchors: z.array(WalletStatementBalanceAnchorSchema).optional(),
          anchorObservations: z.array(z.lazy(() => sourceObservationSchema)).optional(),
          walletId: id,
          openingBalance: money.nullable(),
          closingBalance: money.nullable(),
          balanceState: z.enum(['known', 'balance_unknown', 'discontinuous']),
          projection: z.enum(['collapsed', 'materialize', 'materialized', 'unresolved']),
          reasonCodes: z.array(id),
        })
        .strict(),
    ),
    receipts: z.array(
      z
        .object({
          receiptId: id,
          valid: z.boolean(),
          allocatedDiscount: z.array(money),
          allocatedTax: z.array(money),
          reasonCodes: z.array(id),
        })
        .strict(),
    ),
    blockers: z.array(EvidenceBlockerSchema),
  })
  .strict();
export type EvidenceProvenance = z.infer<typeof EvidenceProvenanceSchema>;
export type EvidenceObservation = z.infer<typeof EvidenceObservationSchema>;
export type EvidenceRelationship = z.infer<typeof EvidenceRelationshipSchema>;
export type WalletEvidence = z.infer<typeof WalletEvidenceSchema>;
export type ReceiptLine = z.infer<typeof ReceiptLineSchema>;
export type ReceiptEvidence = z.infer<typeof ReceiptEvidenceSchema>;
export type TransactionEvidenceRequest = z.infer<typeof TransactionEvidenceRequestSchema>;
export type EvidenceBlocker = z.infer<typeof EvidenceBlockerSchema>;
export type ResolvedEconomicEvent = z.infer<typeof ResolvedEconomicEventSchema>;
export type TransactionEvidenceResult = z.infer<typeof TransactionEvidenceResultSchema>;

/** Reviewed contextual predicates never authorize sources or ledger writes. */
export const EvidenceRuleCriterionSchema = z
  .object({
    kind: z.enum(['retailer_mapping', 'department', 'product_family', 'historical_similarity']),
    value: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          new TextEncoder().encode(value).length <= 256 &&
          !/\p{Cc}/u.test(value),
      ),
  })
  .strict()
  .refine(
    (criterion) =>
      criterion.kind !== 'historical_similarity' ||
      new Set(
        criterion.value
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter(Boolean),
      ).size >= 2,
  );
export type EvidenceRuleCriterion = z.infer<typeof EvidenceRuleCriterionSchema>;
/** Item rules remain reviewable proposals until separately approved. */
export const EvidenceRuleProposalSchema = z
  .object({
    id,
    sourceId: id,
    counterparty: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim().length > 0 && !/\p{Cc}/u.test(value)),
    fundingInstrumentId: id,
    sku: id.nullable(),
    normalizedDescription: id.nullable(),
    criterion: EvidenceRuleCriterionSchema.optional(),
    categoryId: id,
  })
  .strict()
  .refine((r) =>
    r.criterion
      ? r.sku === null && r.normalizedDescription === null
      : r.sku !== null || r.normalizedDescription !== null,
  );
export const EvidenceRuleSimulationRequestSchema = z
  .object({
    contractVersion: z.literal('1'),
    rule: EvidenceRuleProposalSchema,
    evidence: TransactionEvidenceRequestSchema,
    actualRuleCategories: z.array(id),
  })
  .strict();
export const EvidenceRuleSimulationResultSchema = z
  .object({
    ruleId: id,
    resolutionHash: hash,
    matches: z.array(
      z
        .object({
          receiptId: id,
          lineId: id,
          currentCategoryId: id.nullable(),
          proposedCategoryId: id,
          conflict: z.boolean(),
        })
        .strict(),
    ),
    conflicts: z.array(id),
    falsePositiveRisk: z.enum([
      'conflicting_history',
      'no_history',
      'review_required',
      'broader_scope_review_required',
    ]),
    requiresApproval: z.literal(true),
  })
  .strict();
export type EvidenceRuleProposal = z.infer<typeof EvidenceRuleProposalSchema>;
export type EvidenceRuleSimulationRequest = z.infer<typeof EvidenceRuleSimulationRequestSchema>;
export type EvidenceRuleSimulationResult = z.infer<typeof EvidenceRuleSimulationResultSchema>;

/** Explicit human outcomes retain source identity; imported category hints are never outcomes. */
export const EvidenceItemCategoryOutcomeSchema = z
  .object({
    sourceIdentity: hash,
    documentId: id,
    contentHash: hash,
    parserVersion: id,
    receiptId: id,
    lineId: id,
    accountId: id,
    categoryId: id.nullable(),
    policyVersion: id,
  })
  .strict();
export const EvidenceItemRuleExampleSchema = z
  .object({ receiptId: id, lineId: id, documentId: id, categoryId: id })
  .strict();
export const EvidenceItemRuleCandidateSchema = z
  .object({
    candidateHash: hash,
    rule: EvidenceRuleProposalSchema,
    accountId: id,
    sourceIdentities: z.array(hash).min(2).max(10000),
    documentIds: z.array(id).min(2).max(10000),
    examples: z.array(EvidenceItemRuleExampleSchema).min(2).max(10000),
    reviewCount: z.number().int().min(2).max(10000),
    requiresApproval: z.literal(true),
  })
  .strict();
export const EvidenceItemRuleLearningRequestSchema = z
  .object({
    contractVersion: z.literal('1'),
    includeBroaderCriteria: z.boolean().optional(),
    policyVersion: id,
    accountId: id,
    evidence: TransactionEvidenceRequestSchema,
    outcomes: z.array(EvidenceItemCategoryOutcomeSchema).max(10000),
  })
  .strict();
export const EvidenceItemRuleLearningResultSchema = z
  .object({
    contractVersion: z.literal('1'),
    resolutionHash: hash,
    candidates: z.array(EvidenceItemRuleCandidateSchema).max(10000),
    conflicts: z.array(id).max(10000),
  })
  .strict();
export type EvidenceItemCategoryOutcome = z.infer<typeof EvidenceItemCategoryOutcomeSchema>;
export type EvidenceItemRuleCandidate = z.infer<typeof EvidenceItemRuleCandidateSchema>;
export type EvidenceItemRuleLearningRequest = z.infer<typeof EvidenceItemRuleLearningRequestSchema>;
export type EvidenceItemRuleLearningResult = z.infer<typeof EvidenceItemRuleLearningResultSchema>;
