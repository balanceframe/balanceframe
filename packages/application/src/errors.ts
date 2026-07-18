/**
 * Error types and canonical reason codes for the application layer.
 *
 * Reason codes mirror the Rust `ReasonCode` enum from
 * `crates/financial-core/src/blockers.rs`.
 */

// ---------------------------------------------------------------------------
// Canonical reason codes
// ---------------------------------------------------------------------------

export const ReasonCodes = {
  /** Snapshot data is older than the staleness threshold. */
  STALE_SNAPSHOT: 'stale_snapshot',
  /** A required account is missing from the snapshot. */
  MISSING_ACCOUNT: 'missing_account',
  /** Bank sync has not run recently. */
  STALE_BANK_SYNC: 'stale_bank_sync',
  /** Pending transactions policy is not yet resolved. */
  PENDING_POLICY: 'pending_policy',
  /** Duplicate transactions were detected. */
  DUPLICATE_DETECTED: 'duplicate_detected',
  /** A metadata reference (e.g. category) could not be resolved. */
  UNRESOLVED_METADATA_REF: 'unresolved_metadata_ref',
  /** The schema version is not supported. */
  UNSUPPORTED_SCHEMA_VERSION: 'unsupported_schema_version',
  /** Arithmetic overflow during checked-money operations. */
  AMOUNT_OVERFLOW: 'amount_overflow',
  /** Uncategorized transactions exceed the warning threshold. */
  UNCATEGORIZED_EXPOSURE: 'uncategorized_exposure',
  /** A deleted category is still referenced by transactions. */
  DELETED_CATEGORY_REFERENCED: 'deleted_category_referenced',
  /** Ledger configuration is missing or incomplete. */
  MISSING_LEDGER_CONFIG: 'missing_ledger_config',
  /** The connection health check failed. */
  CONNECTION_UNHEALTHY: 'connection_unhealthy',
  /** Write blocked in Observe mode. */
  OBSERVE_MODE_WRITE_BLOCKED: 'observe_mode_write_blocked',
  /** Unknown or unsupported CLI command. */
  UNSUPPORTED_RAW_QUERY: 'unsupported_raw_query',
  /** Review not found. */
  REVIEW_NOT_FOUND: 'review_not_found',
} as const;

// ---------------------------------------------------------------------------
// ApplicationError
// ---------------------------------------------------------------------------

export class ApplicationError extends Error {
  public readonly code: string;
  public readonly reasonCodes: string[];
  public readonly retryable: boolean;

  constructor(opts: {
    code: string;
    message: string;
    reasonCodes?: string[];
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = 'ApplicationError';
    this.code = opts.code;
    this.reasonCodes = opts.reasonCodes ?? [];
    this.retryable = opts.retryable ?? false;
  }
}

// ---------------------------------------------------------------------------
// ObserveWriteError
// ---------------------------------------------------------------------------

/**
 * Thrown when a write operation is attempted in Observe mode.
 * The CLI layer catches this and produces an error envelope.
 */
export class ObserveWriteError extends ApplicationError {
  constructor(capability: string) {
    super({
      code: 'write_rejected',
      message: `Write operation "${capability}" is not permitted in Observe mode. ` +
        'Switch to a mode that permits writes, or disconnect.',
      reasonCodes: [ReasonCodes.OBSERVE_MODE_WRITE_BLOCKED],
      retryable: false,
    });
    this.name = 'ObserveWriteError';
  }
}
