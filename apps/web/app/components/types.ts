/** Shared type for monetary amounts used by components. */
export interface Amount {
  minorUnits: string;
  currency: string;
}

/** Presentation state for a monetary value. */
export type SemanticAmountState = 'known' | 'unknown' | 'unavailable' | 'redacted';

/** Semantic classifications exposed by financial decision contracts. */
export type { FinancialSemanticClass } from '@balanceframe/protocol-generated';

/** Human labels keyed by opaque decision-scope identifiers. */
export type DecisionScopeLabelMap = Readonly<Record<string, string>>;

/** Freshness metadata. */
export interface Freshness {
  isStale: boolean;
  lastSync: string | null;
  label: string;
}

/** Freshness state for one account in a multi-account result. */
export type AccountFreshnessState = 'current' | 'stale' | 'unavailable' | 'unknown';

/** Freshness metadata for one account. */
export interface AccountFreshness {
  accountId: string;
  label: string;
  state: AccountFreshnessState;
  observedAt: string | null;
}

/** Generic envelope-based analysis result. */
export interface Envelope<T> {
  schemaVersion: string;
  requestId: string;
  status: 'ok' | 'error';
  dataFreshness: Freshness | null;
  authorization: unknown;
  result: T | null;
  error: { code: string; message: string; retryable: boolean } | null;
}
