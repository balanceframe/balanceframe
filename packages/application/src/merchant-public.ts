import { z } from 'zod';
import { merchantPolicyValueSchema, merchantEnrichmentSchema } from '@balanceframe/workflow-store';

const id = z.string().min(1).max(512).refine((value) => value.trim() === value && !/\p{C}/u.test(value));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const scope = z.object({ spaceId: id, budgetId: id, connectionId: id }).strict();
const mode = z.enum(['disabled', 'local-only', 'external-allowed']);
const code = z.enum(['invalid_request', 'unavailable', 'timeout', 'cancelled', 'http_error', 'invalid_response',
  'response_too_large', 'redirect_refused', 'configuration', 'policy', 'unauthorized', 'consent_required',
  'stale_source', 'daily_cap', 'monthly_cap', 'unknown_pricing', 'stale_generation', 'restore_pending', 'restore_billing_hold']);
const failure = z.object({ status: z.literal('failed'), code, billing: z.enum(['not_dispatched', 'uncertain']) }).strict();
const success = z.object({ status: z.literal('succeeded'), enrichment: merchantEnrichmentSchema }).strict();

/** Validate a complete independently versioned merchant policy response. */
export const merchantPolicyViewSchema = z.object({ scope, value: merchantPolicyValueSchema, version: count, generation: count }).strict();
/** Validate exact standalone public-business disclosure before consent. */
export const merchantResearchPreviewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), previewToken: z.string().regex(/^[a-f0-9]{32,128}$/),
    merchant: z.string().min(1).max(256), locale: z.enum(['US', 'CA', 'GB']).nullable(),
    providerId: id, providerVersion: id, evidenceKey: id, evidenceRevision: hash,
    expiresAt: z.string().datetime({ offset: true }), fieldsSent: z.tuple([z.literal('merchant'), z.literal('locale')]),
    disclosure: z.string().min(1).max(4096), maxCostAtoms: z.string().max(128).regex(/^[1-9]\d*$/), billingCurrency: currency }).strict(),
  z.object({ status: z.literal('denied'), code }).strict(),
]);
/** Validate attributed semantic outcomes without promoting financial authority. */
export const merchantResearchOutcomeSchema = z.discriminatedUnion('status', [
  success, success.extend({ status: z.literal('cached') }),
  z.object({ status: z.literal('pending'), attemptId: id }).strict(),
  failure, failure.extend({ status: z.literal('denied') }),
]);
/** Validate an authorized historical-cache response, including unavailable cache. */
export const merchantResearchCacheSchema = z.object({ enrichment: merchantEnrichmentSchema.nullable() }).strict();
/** Validate separately versioned installation, space and budget policy provenance. */
export const merchantResearchPolicyViewSchema = z.object({
  installation: z.object({ value: merchantPolicyValueSchema, version: id }).strict(),
  space: merchantPolicyViewSchema, budget: merchantPolicyViewSchema,
  resolved: z.object({ mode, allowedProviderIds: z.array(id).max(100), billingCurrency: currency.nullable(),
    cacheTtlHours: z.number().int().min(1).max(720), maxSearchesPerDay: count, maxSpendMinorUnitsPerMonth: count,
    layers: z.array(z.object({ kind: z.enum(['installation', 'space', 'budget']), version: id, mode, reason: id }).strict())
      .length(3).refine((layers) => new Set(layers.map((layer) => layer.kind)).size === 3) }).strict(),
}).strict();
