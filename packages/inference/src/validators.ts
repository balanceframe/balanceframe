/**
 * Zod schemas for provider output validation and suggestion data.
 *
 * Provider output is validated before it is accepted into a Suggestion.
 * Malformed output produces an error-bearing Suggestion rather than
 * propagating an exception.
 *
 * Suggestion schema is a superset of the protocol-generated Suggestion:
 * all protocol fields are present plus inference-specific metadata.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Provider output schema
// ---------------------------------------------------------------------------

export const alternativeSchema = z.object({
  categoryId: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
});

export const classificationResultSchema = z.object({
  categoryId: z.string().min(1).max(200),
  confidence: z.number().min(0).max(1).nullable(),
  alternatives: z.array(alternativeSchema).max(10),
  rationale: z.string().min(1).max(5000),
  model: z.string().min(1).max(200),
});

export type ClassificationResultParsed = z.infer<typeof classificationResultSchema>;

// ---------------------------------------------------------------------------
// Provenance schema (inference-specific)
// ---------------------------------------------------------------------------

export const provenanceSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  policyVersion: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Suggestion schema — superset of protocol-generated Suggestion
// ---------------------------------------------------------------------------

export const suggestionSchema = z.object({
  // ---- Canonical protocol fields ----
  transactionId: z.string().min(1),
  proposedCategoryId: z.string(), // empty string = error/uncategorize
  categoryName: z.string(),
  confidence: z.number(),
  reasonCodes: z.array(z.string()),
  evidence: z.array(z.string()),

  // ---- Phase 2 fields ----
  spaceId: z.string(),
  connectionId: z.string(),
  budgetId: z.string(),
  transactionVersion: z.string(),
  rawMerchant: z.string().nullable(),
  normalizedMerchant: z.string().nullable(),
  researchSummary: z.string().nullable(),
  alternativeCategoryIds: z.array(z.string()),
  rationale: z.string(),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  inferencePolicyVersion: z.string(),
  createdAt: z.string().min(1),
  payloadHash: z.string().min(1),
  provenance: provenanceSchema,

  // ---- Inference-specific extras ----
  id: z.string().min(1),
  alternatives: z.array(alternativeSchema),
  errors: z.array(z.string()),
  deterministicEvidence: z.record(z.unknown()),
});

export type SuggestionParsed = z.infer<typeof suggestionSchema>;

// ---------------------------------------------------------------------------
// ProviderInfo schema for external config validation
// ---------------------------------------------------------------------------

export const providerInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  locality: z.enum(['local', 'external']),
  supportedCapabilities: z.array(z.enum(['classification', 'merchantResearch', 'conversation', 'telemetry'])),
  endpoint: z.string().nullable(),
  authType: z.enum(['none', 'api-key', 'oauth']).nullable(),
  model: z.string().nullable(),
});
