/** Shared type for monetary amounts used by components. */
export interface Amount {
  minorUnits: string;
  currency: string;
}

/** Freshness metadata. */
export interface Freshness {
  isStale: boolean;
  lastSync: string | null;
  label: string;
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
