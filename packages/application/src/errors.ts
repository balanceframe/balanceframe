/**
 * Error types and canonical reason codes for the application layer.
 *
 * Reason codes mirror the Rust `ReasonCode` enum from
 * `crates/financial-core/src/blockers.rs`.
 */

// ---------------------------------------------------------------------------
// Rust-canonical reason codes — every variant from
// `crates/financial-core/src/blockers.rs` `ReasonCode`.
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
  /** Encryption is required and the data could not be decrypted. */
  ENCRYPTION_LOCKED: 'encryption_locked',
  /** Freshness metadata is missing or unreliable. */
  STALE_METADATA: 'stale_metadata',
  /** Transactions were excluded by the current policy filter. */
  EXCLUDED_BY_POLICY: 'excluded_by_policy',

  // -----------------------------------------------------------------------
  // Application-layer only (no Rust `ReasonCode` variant)
  // -----------------------------------------------------------------------

  /** Write blocked in Observe mode. */
  OBSERVE_MODE_WRITE_BLOCKED: 'observe_mode_write_blocked',
  /** Unknown or unsupported CLI command. */
  UNSUPPORTED_RAW_QUERY: 'unsupported_raw_query',
  /** Review not found. */
  REVIEW_NOT_FOUND: 'review_not_found',
  /** Analysis protocol (Rust bindings) is not available. */
  MISSING_ANALYSIS_PROTOCOL: 'missing_analysis_protocol',

  // -----------------------------------------------------------------------
  // Proposal/approval reason codes
  // -----------------------------------------------------------------------

  /** Proposal was not found. */
  PROPOSAL_NOT_FOUND: 'proposal_not_found',
  /** Proposal has expired (expiresAt is in the past). */
  PROPOSAL_EXPIRED: 'proposal_expired',
  /** Proposal was superseded. */
  PROPOSAL_SUPERSEDED: 'proposal_superseded',
  /** Proposal data is stale (freshness threshold exceeded). */
  PROPOSAL_STALE: 'proposal_stale',
  /** Approval has expired. */
  APPROVAL_EXPIRED: 'approval_expired',
  /** Approval has already been consumed. */
  APPROVAL_CONSUMED: 'approval_consumed',
  /** Approval was superseded. */
  APPROVAL_SUPERSEDED: 'approval_superseded',
  /** Approval was not found. */
  APPROVAL_NOT_FOUND: 'approval_not_found',
  /** Approval proposal ID does not match the input proposal. */
  APPROVAL_PROPOSAL_MISMATCH: 'approval_proposal_mismatch',
  /** Approval consumption failed (already consumed or store error). */
  APPROVAL_CONSUMPTION_FAILED: 'approval_consumption_failed',
  /** Unsupported proposal operation. */
  UNSUPPORTED_OPERATION: 'unsupported_operation',
  /** Payload hash does not match expected value. */
  PAYLOAD_HASH_MISMATCH: 'payload_hash_mismatch',
  /** Idempotency replay mismatch (different proposalId/operation/effect). */
  IDEMPOTENCY_REPLAY_MISMATCH: 'idempotency_replay_mismatch',
  /** Idempotency key is already in use by an in-progress execution. */
  IDEMPOTENCY_IN_PROGRESS: 'idempotency_in_progress',
  /** Member is not active. */
  MEMBER_INACTIVE: 'member_inactive',
  /** Member lacks the required capability. */
  INSUFFICIENT_CAPABILITY: 'insufficient_capability',
  /** Member scope does not cover the required scope. */
  INSUFFICIENT_SCOPE: 'insufficient_scope',
  /** Backup must be verified before first mutation. */
  BACKUP_NOT_VERIFIED: 'backup_not_verified',
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
