/**
 * Versioned JSON envelope types for CLI results.
 *
 * Mirrors the Rust `ResponseEnvelope` from `crates/financial-core/src/envelope.rs`
 * so that both sides produce identical camelCase JSON.
 */

// ---------------------------------------------------------------------------
// Schema version constant
// ---------------------------------------------------------------------------

/** Current envelope schema version. */
export const SCHEMA_VERSION = '1';

// ---------------------------------------------------------------------------
// RequestEnvelope
// ---------------------------------------------------------------------------

export interface RequestEnvelope {
  schemaVersion: string;
  requestId: string;
  timestamp: string;
}

export function createRequestEnvelope(requestId: string): RequestEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// AuthorizationContext
// ---------------------------------------------------------------------------

export interface AuthorizationContext {
  actorId: string;
  capability: string;
  allowed: boolean;
}

export const AuthorizationContext = {
  observe(actorId: string): AuthorizationContext {
    return { actorId, capability: 'observe', allowed: true };
  },

  mutation(actorId: string, capability: string): AuthorizationContext {
    return { actorId, capability, allowed: true };
  },

  denied(actorId: string, capability: string): AuthorizationContext {
    return { actorId, capability, allowed: false };
  },
};

// ---------------------------------------------------------------------------
// DataFreshness
// ---------------------------------------------------------------------------

export interface DataFreshness {
  actualDownloadedAt: string | null;
  bankSyncedAt: string | null;
  pendingTransactionsIncluded: boolean;
  stalenessDays: number;
  isStale: boolean;
}

// ---------------------------------------------------------------------------
// ErrorInfo
// ---------------------------------------------------------------------------

export interface ErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  reasonCodes: string[];
}

export class ErrorInfo {
  constructor(opts: { code: string; message: string; retryable: boolean; reasonCodes?: string[] }) {
    this.code = opts.code;
    this.message = opts.message;
    this.retryable = opts.retryable;
    this.reasonCodes = opts.reasonCodes ?? [];
  }
}

/**
 * Reference to a piece of evidence supporting the analysis result.
 */
export interface EvidenceReference {
  /** Source of the evidence (e.g. 'transaction', 'rule', 'classification'). */
  source: string;
  /** Identifier of the evidence item within the source. */
  id: string;
  /** Confidence weight 0.0–1.0. */
  weight: number;
}

/**
 * Scope definition attached to analysis results that operate on a
 * bounded slice of data (reports, saved views, projections).
 */
export interface EnvelopeScope {
  monthRange?: string;
  includePending?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// ResponseEnvelope
// ---------------------------------------------------------------------------

/**
 * Versioned JSON envelope type for CLI results.
 * Generic in the success-result type `T`. The `status` discriminant
 * distinguishes success (`result: T`, `error: null`) from error
 * (`result: null`, `error: ErrorInfo`).
 *
 * Optional metadata fields (scope, semanticClasses, evidence, policyVersion)
 * are additive — they carry application-level context through the envelope
 * without changing the core shape.  Default paths MUST NOT fabricate them.
 */
export type ResponseEnvelope<T = unknown> = {
  schemaVersion: string;
  requestId: string;
  dataFreshness: DataFreshness | null;
  authorization: AuthorizationContext | null;
  /** Analysis scope (reports, saved views, projections). */
  scope?: EnvelopeScope;
  /** Semantic classification tags. */
  semanticClasses?: string[];
  /** Evidence references supporting the result. */
  evidence?: EvidenceReference[];
  /** Policy version that produced this result. */
  policyVersion?: string;
} & (
  | {
      status: 'ok';
      result: T;
      error: null;
    }
  | {
      status: 'error';
      result: null;
      error: ErrorInfo;
    }
);

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Optional metadata to attach to a response envelope.
 */
export interface EnvelopeMetadata {
  scope?: EnvelopeScope;
  semanticClasses?: string[];
  evidence?: EvidenceReference[];
  policyVersion?: string;
}

/**
 * Build a successful response envelope.
 * Matches the Rust `ResponseEnvelope::ok` constructor.
 */
export function okResponse<T>(
  requestId: string,
  dataFreshness: DataFreshness | null,
  authorization: AuthorizationContext | null,
  result: T,
  metadata?: EnvelopeMetadata,
): ResponseEnvelope<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    status: 'ok',
    dataFreshness,
    authorization,
    ...(metadata?.scope !== undefined ? { scope: metadata.scope } : {}),
    ...(metadata?.semanticClasses !== undefined
      ? { semanticClasses: metadata.semanticClasses }
      : {}),
    ...(metadata?.evidence !== undefined ? { evidence: metadata.evidence } : {}),
    ...(metadata?.policyVersion !== undefined ? { policyVersion: metadata.policyVersion } : {}),
    result,
    error: null,
  };
}

/**
 * Build an error response envelope.
 * Matches the Rust `ResponseEnvelope::error` constructor.
 */
export function errorResponse(
  requestId: string,
  error: ErrorInfo,
  metadata?: EnvelopeMetadata,
  authorization?: AuthorizationContext | null,
): ResponseEnvelope<never> {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    status: 'error',
    dataFreshness: null,
    authorization: authorization ?? null,
    ...(metadata?.scope !== undefined ? { scope: metadata.scope } : {}),
    ...(metadata?.semanticClasses !== undefined
      ? { semanticClasses: metadata.semanticClasses }
      : {}),
    ...(metadata?.evidence !== undefined ? { evidence: metadata.evidence } : {}),
    ...(metadata?.policyVersion !== undefined ? { policyVersion: metadata.policyVersion } : {}),
    result: null,
    error,
  };
}
