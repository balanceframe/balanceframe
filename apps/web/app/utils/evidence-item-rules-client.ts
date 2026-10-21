import { z } from 'zod';
import {
  EvidenceRuleProposalSchema,
  EvidenceItemRuleCandidateSchema,
  EvidenceRuleSimulationResultSchema,
  moneySchema,
} from '@balanceframe/protocol-generated/validators';
const reviewedOutcome = z.object({
  documentId: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  parserVersion: z.string(),
  receiptId: z.string(),
  lineId: z.string(),
  accountId: z.string(),
  categoryId: z.string().nullable(),
  policyVersion: z.string(),
  membershipId: z.string(),
  actorId: z.string(),
  reviewedAt: z.string().datetime(),
});
/** Validate only public review data; native schemas retain exact financial contracts. */
export const evidenceItemRuleViewSchema = z.object({
  id: z.string(),
  state: z.enum(['proposed', 'approved', 'revoked', 'expired']),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  connectorId: z.string(),
  accountId: z.string(),
  policyVersion: z.string(),
  expiresAt: z.string(),
  rule: z.unknown().transform((value) => EvidenceRuleProposalSchema.parse(value)),
  learning: z.object({ candidateHash: z.string(), outcomes: z.array(reviewedOutcome) }).optional(),
  simulation: z.unknown().transform((value) => EvidenceRuleSimulationResultSchema.parse(value)),
  examples: z.array(
    z.object({
      documentId: z.string(),
      receiptId: z.string(),
      lineId: z.string(),
      rawDescription: z.string(),
      normalizedDescription: z.string(),
      sku: z.string().nullable(),
      amount: z.unknown().transform((value) => moneySchema.parse(value)),
      currentCategoryId: z.string().nullable(),
    }),
  ),
  actualInteraction: z.object({
    kind: z.literal('local_item_suggestion_only'),
    reasonCode: z.literal('actual_item_predicate_unavailable'),
    actualRuleIds: z.array(z.string()),
  }),
  approvals: z.array(
    z.object({ actorId: z.string(), action: z.enum(['approved', 'revoked']), at: z.string() }),
  ),
});
export const evidenceItemRulesViewSchema = z.array(evidenceItemRuleViewSchema);
export const evidenceItemSuggestionsViewSchema = z.array(
  z.object({
    proposalId: z.string(),
    payloadHash: z.string(),
    accountId: z.string(),
    receiptId: z.string(),
    lineId: z.string(),
    categoryId: z.string(),
    sourceDocumentId: z.string(),
    simulationHash: z.string(),
    state: z.enum(['suggested', 'conflicting_rules']),
    reasonCodes: z.array(z.string()),
  }),
);

/** Current native learning results retain exact witnesses and never claim automatic approval. */
export const evidenceItemCandidatesViewSchema = z.object({
  contractVersion: z.literal('1'),
  resolutionHash: z.string().regex(/^[a-f0-9]{64}$/),
  connectorId: z.string(),
  accountId: z.string(),
  generatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  reviewedOutcomes: z.array(reviewedOutcome).default([]),
  candidates: z.array(
    z.unknown().transform((value) => EvidenceItemRuleCandidateSchema.parse(value)),
  ),
  conflicts: z.array(z.string()),
});
