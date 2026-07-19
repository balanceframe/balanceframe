/**
 * Zod schemas for provider output validation and suggestion data.
 *
 * Provider output is validated before it is accepted into a Suggestion.
 * Malformed output produces an error-bearing Suggestion rather than
 * propagating an exception.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Provider output schema
// ---------------------------------------------------------------------------

export const alternativeSchema = z.object({
  categoryId: z.string().min(1),
  reason: z.string().min(1),
});

export const classificationResultSchema = z.object({
  categoryId: z.string().min(1),
  confidence: z.number().nullable(),
  alternatives: z.array(alternativeSchema),
  rationale: z.string().min(1),
  model: z.string().min(1),
});

export type ClassificationResultParsed = z.infer<typeof classificationResultSchema>;

// ---------------------------------------------------------------------------
// Suggestion schema
// ---------------------------------------------------------------------------

export const provenanceSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  policyVersion: z.string().min(1),
});

export const suggestionSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  connectionId: z.string().min(1),
  budgetId: z.string().min(1),
  transactionId: z.string().min(1),
  transactionVersion: z.string().min(1),
  rawMerchant: z.string().nullable(),
  normalizedMerchant: z.string().nullable(),
  researchSummary: z.string().nullable(),
  categoryId: z.string().min(1),
  alternatives: z.array(alternativeSchema),
  rationale: z.string(),
  provenance: provenanceSchema,
  createdAt: z.string().min(1),
  hash: z.string().min(1),
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
