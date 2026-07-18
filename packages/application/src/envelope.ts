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
export const SCHEMA_VERSION = '1.0';

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
  constructor(opts: {
    code: string;
    message: string;
    retryable: boolean;
    reasonCodes?: string[];
  }) {
    this.code = opts.code;
    this.message = opts.message;
    this.retryable = opts.retryable;
    this.reasonCodes = opts.reasonCodes ?? [];
  }
}

// ---------------------------------------------------------------------------
// ResponseEnvelope
// ---------------------------------------------------------------------------

/**
 * Versioned JSON envelope type for CLI results.
 * Generic in the success-result type `T`. The `status` discriminant
 * distinguishes success (`result: T`, `error: null`) from error
 * (`result: null`, `error: ErrorInfo`).
 */
export type ResponseEnvelope<T = unknown> = {
  schemaVersion: string;
  requestId: string;
  dataFreshness: DataFreshness | null;
  authorization: AuthorizationContext | null;
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
 * Build a successful response envelope.
 * Matches the Rust `ResponseEnvelope::ok` constructor.
 */
export function okResponse<T>(
  requestId: string,
  dataFreshness: DataFreshness | null,
  authorization: AuthorizationContext | null,
  result: T,
): ResponseEnvelope<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    status: 'ok',
    dataFreshness,
    authorization,
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
): ResponseEnvelope<never> {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error,
  };
}
