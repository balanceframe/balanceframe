import type { ProviderInfo } from './types.js';
import { z } from 'zod';

/** Explicit human-reviewed public-business request, distinct from classification. */
export interface MerchantResearchRequest {
  merchant: string;
  locale: string | null;
  signal?: AbortSignal;
}

/** Bounded attributed public source, rendered as text rather than HTML. */
export interface MerchantResearchSource { url: string; title: string; snippet: string }

/** Content-free research failure categories. */
export type MerchantResearchFailureCode = 'invalid_request' | 'unavailable' | 'timeout' | 'cancelled' | 'http_error' | 'invalid_response' | 'response_too_large' | 'redirect_refused';

/** Semantic observations only; never financial facts or permission. */
export type MerchantResearchResult =
  | { status: 'ok'; providerId: string; providerVersion: string; retrievedAt: string; sources: MerchantResearchSource[]; confidence: 'uncalibrated' }
  | { status: 'failed'; providerId: string; providerVersion: string; retrievedAt: string; code: MerchantResearchFailureCode; billing: 'not_dispatched' | 'uncertain' };

/** Dedicated public-business research boundary, independent of classification. */
export interface MerchantEnrichmentProvider {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly providerInfo: ProviderInfo;
  /** Retrieve semantic public-business evidence without classifying or authorizing financial facts. */
  research(request: MerchantResearchRequest): Promise<MerchantResearchResult>;
}

const merchantSchema = z.string()
  .refine((value) => !/\p{C}/u.test(value))
  .transform((value) => value.trim().normalize('NFKC'))
  .refine((value) => {
    const characters = Array.from(value).length;
    return characters >= 1 && characters <= 120
      && new TextEncoder().encode(value).length <= 480
      && /^[\p{L}\p{M}\p{N} .&'’()-]+$/u.test(value)
      && /\p{L}/u.test(value)
      && !/\p{N}(?:[ .()-]*\p{N}){3}/u.test(value)
      && !/\b[\p{L}\p{N}-]+\.[\p{L}]{2,}\b/u.test(value)
      && !/\b(?:pos|ach|acct|account|iban|swift|routing|reference|ref|id|ssn|passport|purchase|payment|transfer|transaction|txn)\b/iu.test(value)
      && !/\b(?:USD|CAD|GBP|EUR)\s*\p{N}|\p{N}\s*(?:USD|CAD|GBP|EUR)\b|\p{N}[.,]\p{N}/iu.test(value)
      && !/\b(?:OR|AND|NOT|NEAR|AROUND)\b/.test(value)
      && !/[\s(]-\p{L}|\b(?:ignore|instructions|curl|wget|sudo|exec|eval)\b/iu.test(value);
  });

/** Strict standalone input schema, excluding transport and financial context. */
export const merchantResearchRequestSchema = z.object({
  merchant: merchantSchema,
  locale: z.enum(['US', 'CA', 'GB']).nullable().default(null),
}).strict();

/** Validate a credential-free absolute HTTP(S) evidence link. */
export function isSafeMerchantResearchUrl(value: string): boolean {
  if (value.length > 2048 || /\p{C}/u.test(value) || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Strict bounded public-source schema. */
export const merchantResearchSourceSchema = z.object({
  url: z.string().max(2048).refine(isSafeMerchantResearchUrl),
  title: z.string().max(256),
  snippet: z.string().max(1000),
}).strict();

const provenance = {
  providerId: z.string().min(1).max(200),
  providerVersion: z.string().min(1).max(200),
  retrievedAt: z.string().datetime().refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  }),
};

/** Strict semantic evidence and content-free failure schema. */
export const merchantResearchResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'), ...provenance,
    sources: z.array(merchantResearchSourceSchema).max(10),
    confidence: z.literal('uncalibrated'),
  }).strict(),
  z.object({
    status: z.literal('failed'), ...provenance,
    code: z.enum(['invalid_request', 'unavailable', 'timeout', 'cancelled', 'http_error', 'invalid_response', 'response_too_large', 'redirect_refused']),
    billing: z.enum(['not_dispatched', 'uncertain']),
  }).strict(),
]);

/** Validate explicit public-business input; callers separately authorize human egress consent. */
export function createMerchantResearchRequest(input: unknown, signal?: AbortSignal): MerchantResearchRequest {
  try {
    const parsed = merchantResearchRequestSchema.safeParse(input);
    if (!parsed.success || (signal !== undefined && !(signal instanceof AbortSignal))) {
      throw new Error('Invalid merchant research request');
    }
    return signal === undefined ? parsed.data : { ...parsed.data, signal };
  } catch {
    throw new Error('Invalid merchant research request');
  }
}
