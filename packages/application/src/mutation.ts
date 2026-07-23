/**
 * CategorizationMutationService — orchestrates the proposal-driven
 * lifecycle for set-category mutations.
 *
 * Implements at-most-once execution with idempotency gating, approval
 * consumption before the Actual write, and post-write verification.
 * A mutation is reported as successful ONLY when the write completes
 * AND postcondition verification confirms the change.
 *
 * Flow summary:
 *   1. Load proposal — verifies existence, not superseded, not expired
 *   2. Backup verification (optional) — recent successful backup_verification
 *      audit record with matching budgetId
 *   3. Authorization — membership, capability, scope
 *   4. Load approval — exact proposalId + payloadHash binding,
 *      operation check, status checks (active, not consumed/expired/superseded)
 *   5. Consume approval — one-time lock preventing concurrent execution
 *   6. Idempotency claim — create record; completed → replay;
 *      in-flight → conflict; else proceed
 *   7. Audit: execution started
 *   8. Latest snapshot via ledger.synchronize()
 *   9. Plan via Rust planSetCategory
 *  10. Stale precondition check
 *  11. Write via ledger.setTransactionCategory
 *  12. Reread + Rust verifyMutation
 *  13. Complete idempotency record (error if verification failed)
 *  14. Append completion/failure audit
 *  15. Return result — success = verified
 *
 * @module mutation
 */

import type {
  WorkflowStore,
  CategorizationProposal,
  IdempotencyRecord,
  IdempotencyClaim,
  AuditRecord,
  AuthorizationResult,
} from '@balanceframe/workflow-store';

import type {
  BudgetLedger,
  SetCategoryResult,
  LedgerSnapshotResult,
} from '@balanceframe/actual-adapter';

import type {
  Transaction,
  Category,
  ProtocolSnapshot,
} from '@balanceframe/protocol-generated';

// ---------------------------------------------------------------------------
// Rust protocol types (match the Rust core-protocol JSON wire format)
// ---------------------------------------------------------------------------

export interface Postcondition {
  type: 'CategoryExists' | (string & {});
  categoryId: string;
}

export interface MutationPlan {
  planId: string;
  transactionId: string;
  currentCategoryId: string | null;
  proposedCategoryId: string;
  hash: string;
  postconditions: Postcondition[];
}

export interface VerificationResult {
  verified: boolean;
  reasonCodes: string[];
  message: string | null;
}

// ---------------------------------------------------------------------------
// Rust protocol surface — the two functions the service needs
// ---------------------------------------------------------------------------

export interface RustMutationProtocol {
  /** Plan a set-category mutation from a transaction + category. */
  planSetCategory(transaction: Transaction, category: Category): MutationPlan;

  /** Verify that a mutation plan still holds against a snapshot. */
  verifyMutation(plan: MutationPlan, snapshot: ProtocolSnapshot): VerificationResult;
}

// ---------------------------------------------------------------------------
// Service input / result types
// ---------------------------------------------------------------------------

/** Input to execute a single categorization proposal. */
export interface ExecuteCategorizationInput {
  /** Upstream request tracking ID. */
  requestId: string;
  /** The actor requesting execution. */
  actorId: string;
  /** The proposal to execute. */
  proposalId: string;
  /** The one-time approval granting authorization. */
  approvalId: string;
  /** Idempotency key for at-most-once execution. */
  idempotencyKey: string;
  /** Optional correlation ID for grouping related operations. */
  correlationId?: string;
}

/** Result of executing a categorization proposal. */
export interface ExecuteCategorizationResult {
  /** Whether the overall execution succeeded (write + verification). */
  success: boolean;
  /** The transaction that was (or would have been) updated. */
  transactionId: string | null;
  /** Category the transaction had before the change. */
  previousCategoryId: string | null;
  /** The category the transaction now holds. */
  newCategoryId: string | null;
  /** Whether post-write verification confirmed the change. */
  verified: boolean;
  /** The mutation plan ID from the Rust protocol. */
  planId: string | null;
  /** The idempotency key used. */
  idempotencyKey: string;
  /** The approval ID consumed (or null on pre-write failure). */
  approvalId: string | null;
  /** The final audit record ID (or null if audit append failed). */
  auditRecordId: string | null;
  /** Reason codes from verification, authorization, or error conditions. */
  reasonCodes: string[];
  /** Human-readable message on failure. */
  message?: string;
}

// ---------------------------------------------------------------------------
// Default capability / scope values
// ---------------------------------------------------------------------------

const CAPABILITY_EXECUTE = 'categorization:execute';

// ---------------------------------------------------------------------------
// Staleness / freshness thresholds (ms)
// ---------------------------------------------------------------------------

/** Snapshots older than this threshold are rejected as stale. */
const STALE_SNAPSHOT_MS = 3_600_000; // 1 hour

/** Max age for a backup-verification audit record to be considered recent. */
const BACKUP_VERIFICATION_FRESHNESS_MS = 86_400_000; // 24 hours

// ---------------------------------------------------------------------------
// Service options
// ---------------------------------------------------------------------------

export interface MutationServiceOptions {
  /** When true, require a recent successful backup-verification audit record
   *  with matching budgetId before executing. */
  requireBackupVerification?: boolean;
}

export class CategorizationMutationService {
  private readonly requireBackupVerification: boolean;

  constructor(
    private readonly store: WorkflowStore,
    private readonly ledger: BudgetLedger,
    private readonly rust: RustMutationProtocol,
    options?: MutationServiceOptions,
  ) {
    this.requireBackupVerification = options?.requireBackupVerification ?? false;
  }

/**
   * Execute a categorization proposal end-to-end.
   *
   * Flow summary:
   *   1. Load proposal — verifies existence, not superseded, not expired
   *   2. Backup verification (optional) — recent successful backup_verification
   *      audit record with matching budgetId
   *   3. Authorization — membership, capability, scope
   *   4. Load approval — exact proposalId + payloadHash binding,
   *      operation check, status checks (active, not consumed/expired/superseded)
   *   5. Idempotency claim — create record; completed → replay;
   *      in-flight → conflict; else proceed
   *   6. Consume approval — one-time lock preventing concurrent execution
   *   7. Audit: execution started
   *   8. Latest snapshot via ledger.synchronize()
   *   9. Plan via Rust planSetCategory
   *  10. Stale precondition check
   *  11. Write via ledger.setTransactionCategory
   *  12. Reread + Rust verifyMutation
   *  13. Complete idempotency record (error if verification failed)
   *  14. Append completion/failure audit
   *  15. Return result — success = verified
   *
   * @returns An {@link ExecuteCategorizationResult} describing the outcome.
   *          The caller MUST check both `.success` and `.verified` for the
   *          full picture — a write may succeed but postcondition
   *          verification may fail.
   */

  async execute(input: ExecuteCategorizationInput): Promise<ExecuteCategorizationResult> {
    const baseResult: ExecuteCategorizationResult = {
      success: false,
      transactionId: null,
      previousCategoryId: null,
      newCategoryId: null,
      verified: false,
      planId: null,
      idempotencyKey: input.idempotencyKey,
      approvalId: null,
      auditRecordId: null,
      reasonCodes: [],
    };

    // =====================================================================
    // 1. Load proposal — verify existence, supersession, expiry
    // =====================================================================

    const proposal = await this.store.getProposal(input.proposalId);
    if (!proposal) {
      try {
        await this.store.appendAuditRecord({
          classification: 'execution_failed',
          actorId: input.actorId,
          operation: 'set_category',
          proposalId: input.proposalId,
          payloadHash: null,
          budgetId: null,
          policyVersion: null,
          result: 'proposal_not_found',
          idempotencyKey: input.idempotencyKey,
          correlationId: input.correlationId ?? null,
          requestId: input.requestId,
          isError: true,
        });
      } catch {
        // Non-fatal: audit failure should not change execution outcome
      }
      return this.fail(baseResult, 'proposal_not_found', 'Proposal not found', input);
    }

    if (proposal.supersededAt) {
      await this.appendFailureAudit(input, proposal, null, 'proposal_superseded');
      return this.fail(baseResult, 'proposal_superseded', 'Proposal has been superseded', input);
    }

    // Check proposal expiry
    if (new Date(proposal.expiresAt).getTime() <= Date.now()) {
      await this.appendFailureAudit(input, proposal, null, 'proposal_expired');
      return this.fail(baseResult, 'proposal_expired', 'Proposal has expired', input);
    }

    // =====================================================================
    // 2. Backup verification — require recent successful backup_verification
    //    audit record with matching budgetId
    // =====================================================================

    if (this.requireBackupVerification) {
      const backupOk = await this.checkBackupVerified(proposal.budgetId);
      if (!backupOk) {
        await this.appendFailureAudit(input, proposal, null, 'backup_not_verified');
        return this.fail(
          baseResult,
          'backup_not_verified',
          'Backup must be verified before the first mutation. Run a backup verification command first.',
          input,
        );
      }
    }

    // =====================================================================
    // 3. Authorization — membership, capability, scope
    // =====================================================================

    const auth = await this.store.evaluateAuthorization(
      input.actorId,
      CAPABILITY_EXECUTE,
      'budget:' + proposal.budgetId,
      proposal.policyVersion,
    );

    if (!auth.allowed) {
      const code = this.deniedReasonCode(auth);
      let reasonMsg = 'Authorization denied';
      if (auth.disposition.kind === 'denied') {
        reasonMsg = auth.disposition.reason;
      }
      await this.appendFailureAudit(input, proposal, auth, code);
      return this.fail(baseResult, code, reasonMsg, input);
    }

    // =====================================================================
    // 4. Idempotency claim (atomic check-and-create) — completed → replay;
    //    in-flight → conflict; owner → proceed to approval
    // =====================================================================
    const serialisedEffect = JSON.stringify({
      transactionId: proposal.transactionId,
      newCategoryId: proposal.categoryId,
    });

    let idemClaim: IdempotencyClaim;
    try {
      idemClaim = await this.store.createIdempotencyRecord({
        idempotencyKey: input.idempotencyKey,
        proposalId: input.proposalId,
        operation: proposal.operation,
        serialisedEffect,
      });
    } catch (err) {
      await this.appendFailureAudit(input, proposal, auth, 'idempotency_replay_mismatch');
      return this.fail(baseResult, 'idempotency_replay_mismatch',
        err instanceof Error ? err.message : 'Idempotency record creation failed',
        input);
    }

    if (!idemClaim.isOwner) {
      // Replay if the record is already in a terminal state
      if (idemClaim.record.status !== 'in_progress') {
        return this.replayResult(idemClaim.record, input);
      }
      // In-flight: another execution is using this key — or previous run crashed
      // and the lease hasn't expired yet. The caller should retry later.
      await this.appendFailureAudit(input, proposal, auth, 'idempotency_in_progress');
      return this.fail(baseResult, 'idempotency_in_progress',
        'Execution with this idempotency key is already in progress', input);
    }


    // We own the claim — proceed with execution

    // =====================================================================
    // 5. Load approval — verify active, exact proposal ID binding,
    //    payload hash match, operation supported, status checks
    // =====================================================================

    const approval = await this.store.getApproval(input.approvalId);
    if (!approval) {
      await this.appendFailureAudit(input, proposal, auth, 'approval_not_found');
      return this.fail(baseResult, 'approval_not_found', 'Approval not found', input);
    }

    // Bind approval to the exact proposal ID
    if (approval.proposalId !== input.proposalId) {
      await this.appendFailureAudit(input, proposal, auth, 'approval_proposal_mismatch');
      return this.fail(baseResult, 'approval_proposal_mismatch',
        'Approval proposal ID does not match the input proposal', input);
    }

    // Bind approval payload hash to proposal payload hash
    if (approval.payloadHash !== proposal.payloadHash) {
      await this.appendFailureAudit(input, proposal, auth, 'payload_hash_mismatch');
      return this.fail(baseResult, 'payload_hash_mismatch',
        'Approval payload hash does not match proposal', input);
    }

    // Verify operation is supported
    if (proposal.operation !== 'set_category') {
      await this.appendFailureAudit(input, proposal, auth, 'unsupported_operation');
      return this.fail(baseResult, 'unsupported_operation',
        `Proposal operation "${proposal.operation}" is not supported`, input);
    }

    if (approval.status === 'consumed') {
      await this.appendFailureAudit(input, proposal, auth, 'approval_consumed');
      return this.fail(baseResult, 'approval_consumed', 'Approval has already been consumed', input);
    }

    if (approval.status === 'expired' || new Date(approval.expiresAt).getTime() <= Date.now()) {
      await this.appendFailureAudit(input, proposal, auth, 'approval_expired');
      return this.fail(baseResult, 'approval_expired', 'Approval has expired', input);
    }

    if (approval.status === 'superseded') {
      await this.appendFailureAudit(input, proposal, auth, 'approval_superseded');
      return this.fail(baseResult, 'approval_superseded', 'Approval has been superseded', input);
    }

    // =====================================================================
    // 6. Consume approval BEFORE mutation — one-time lock preventing
    //    concurrent execution from both writing with the same approval
    // =====================================================================

    try {
      await this.store.consumeApproval(input.approvalId);
    } catch (err) {
      await this.recordFailure(input, err);
      await this.appendFailureAudit(input, proposal, auth, 'approval_consumption_failed');
      return this.fail(baseResult, 'approval_consumption_failed',
        err instanceof Error ? err.message : 'Failed to consume approval', input);
    }
    // =====================================================================

    let auditStarted: AuditRecord | null = null;
    try {
      auditStarted = await this.store.appendAuditRecord({
        classification: 'execution_started',
        actorId: input.actorId,
        operation: proposal.operation,
        proposalId: input.proposalId,
        payloadHash: proposal.payloadHash,
        budgetId: proposal.budgetId,
        policyVersion: proposal.policyVersion,
        idempotencyKey: input.idempotencyKey,
        authorizationDisposition: auth.disposition,
        correlationId: input.correlationId ?? null,
        requestId: input.requestId,
        result: 'started',
        isError: false,
      });
    } catch {
      // Non-fatal: audit append failure should not block execution
    }

    // =====================================================================
    // 8. Latest snapshot via ledger.synchronize()
    // =====================================================================

    let snapshotResult: LedgerSnapshotResult;
    try {
      snapshotResult = await this.ledger.synchronize();
    } catch (err) {
      await this.recordFailure(input, err);
      await this.appendFailureAudit(input, proposal, auth,
        err instanceof Error ? err.message : 'sync_failed');
      return this.fail(baseResult, 'sync_failed',
        err instanceof Error ? err.message : 'Synchronization failed', input);
    }

    const { snapshot } = snapshotResult;

    // Staleness check
    if (Date.now() - new Date(snapshot.snapshotDate).getTime() > STALE_SNAPSHOT_MS) {
      await this.recordFailure(input, new Error('Snapshot data is stale'));
      await this.appendFailureAudit(input, proposal, auth, 'stale_snapshot');
      return this.fail(baseResult, 'stale_snapshot', 'Snapshot data is stale', input);
    }

    // Find transaction in snapshot
    const tx = snapshot.transactions.find(t => t.id === proposal.transactionId);
    if (!tx) {
      await this.recordFailure(input, new Error('Transaction not found in latest snapshot'));
      await this.appendFailureAudit(input, proposal, auth, 'transaction_not_found');
      return this.fail(baseResult, 'transaction_not_found',
        'Transaction not found in latest snapshot', input);
    }

    // Find category in snapshot
    const cat = snapshot.categories.find(c => c.id === proposal.categoryId);
    if (!cat) {
      await this.recordFailure(input, new Error('Category not found in latest snapshot'));
      await this.appendFailureAudit(input, proposal, auth, 'category_not_found');
      return this.fail(baseResult, 'category_not_found',
        'Category not found in latest snapshot', input);
    }

    // =====================================================================
    // 9. Plan via Rust planSetCategory
    // =====================================================================

    let plan: MutationPlan;
    try {
      plan = this.rust.planSetCategory(tx, cat);
    } catch (err) {
      await this.recordFailure(input, err);
      await this.appendFailureAudit(input, proposal, auth,
        err instanceof Error ? err.message : 'plan_failed');
      return this.fail(baseResult, 'plan_failed',
        err instanceof Error ? err.message : 'Mutation planning failed', input);
    }

    // =====================================================================
    // 10. Stale precondition check
    // =====================================================================

    const preconditionCheck = this.checkPreconditions(proposal, plan);
    if (!preconditionCheck.ok) {
      await this.recordFailure(input, new Error(preconditionCheck.reason));
      await this.appendFailureAudit(input, proposal, auth, 'precondition_mismatch');
      return this.fail(baseResult, 'precondition_mismatch', preconditionCheck.reason, input);
    }

    // =====================================================================
    // 11. Write via ledger.setTransactionCategory
    // =====================================================================

    let writeResult: SetCategoryResult;
    try {
      writeResult = await this.ledger.setTransactionCategory(
        proposal.transactionId,
        proposal.categoryId,
        plan.currentCategoryId,
      );
    } catch (err) {
      await this.recordFailure(input, err);
      await this.auditFailure(input, proposal, auth, err);
      return this.fail(baseResult, 'write_failed',
        err instanceof Error ? err.message : 'Write operation failed', input);
    }
    if (!writeResult.success) {
      await this.recordFailure(input, new Error(writeResult.error));
      await this.auditFailure(input, proposal, auth, new Error(writeResult.error));
      return this.fail(baseResult, 'write_failed', writeResult.error, input);
    }


    // =====================================================================
    // 12. Reread via fresh synchronize + Rust verifyMutation
    // =====================================================================

    let rereadSnapshot: ProtocolSnapshot;
    try {
      const rereadResult = await this.ledger.synchronize();
      rereadSnapshot = rereadResult.snapshot;
    } catch (err) {
      // Write happened but we can't verify — still need to record outcome
      await this.recordFailure(input, err);
      await this.appendFailureAudit(input, proposal, auth, 'reread_failed');
      return this.fail(baseResult, 'reread_failed',
        err instanceof Error ? err.message : 'Post-write reread failed', input);
    }

    let verified = false;
    let verifyReasonCodes: string[] = [];
    let verifyMessage: string | null = null;

    try {
      const verification = this.rust.verifyMutation(plan, rereadSnapshot);
      verified = verification.verified;
      verifyReasonCodes = verification.reasonCodes;
      verifyMessage = verification.message;
    } catch (err) {
      verifyReasonCodes = ['verify_failed'];
      verifyMessage = err instanceof Error ? err.message : 'Verification threw';
    }

    // =====================================================================
    // 13. Complete idempotency record
    //
    // Post-write failures are terminal (the write may have happened externally
    // even if verification failed).  Pre-write failures are handled above via
    // recordFailure (retryable).
    // =====================================================================

    if (!verified) {
      const errMsg = verifyMessage ?? 'Postcondition verification failed';
      try {
        await this.store.completeIdempotencyRecord(input.idempotencyKey, errMsg, false);
      } catch {
        // Non-fatal
      }
    } else {
      try {
        await this.store.completeIdempotencyRecord(input.idempotencyKey, null);
      } catch {
        // Non-fatal
      }
    }


    // =====================================================================
    // 14. Append completion or failure audit
    // =====================================================================

    const allReasonCodes = [...verifyReasonCodes];
    const obsState = JSON.stringify({
      transactionId: writeResult.transactionId,
      previousCategoryId: writeResult.previousCategoryId,
      newCategoryId: writeResult.newCategoryId,
      verified,
    });

    let auditCompleted: AuditRecord | null = null;
    try {
      auditCompleted = await this.store.appendAuditRecord({
        classification: verified ? 'execution_completed' : 'execution_failed',
        actorId: input.actorId,
        operation: proposal.operation,
        proposalId: input.proposalId,
        payloadHash: proposal.payloadHash,
        budgetId: proposal.budgetId,
        backendIds: '',
        policyVersion: proposal.policyVersion,
        authorizationDisposition: auth.disposition,
        idempotencyKey: input.idempotencyKey,
        expectedPriorState: proposal.preconditions,
        observedResultState: obsState,
        providerModel: proposal.providerModel ?? undefined,
        correlationId: input.correlationId ?? null,
        requestId: input.requestId,
        result: verified ? 'completed' : 'verification_failed',
        isError: !verified,
      });
    } catch {
      // Non-fatal: audit failure doesn't change execution outcome
    }

    // =====================================================================
    // 15. Return result — success requires verified postconditions
    // =====================================================================

    return {
      success: verified,
      transactionId: writeResult.transactionId ?? null,
      previousCategoryId: writeResult.previousCategoryId ?? null,
      newCategoryId: writeResult.newCategoryId ?? null,
      verified,
      planId: plan.planId,
      idempotencyKey: input.idempotencyKey,
      approvalId: input.approvalId,
      auditRecordId: auditCompleted?.id ?? auditStarted?.id ?? null,
      reasonCodes: allReasonCodes,
      message: verified ? undefined : (verifyMessage ?? 'Postcondition verification failed'),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Check that the proposal's preconditions match the plan's current state.
   */
  private checkPreconditions(
    proposal: CategorizationProposal,
    plan: MutationPlan,
  ): { ok: true } | { ok: false; reason: string } {
    if (proposal.operation !== 'set_category') {
      return { ok: true }; // No precondition check for unknown operations
    }

    let expectedCurrentCategoryId: string | null = null;
    try {
      const parsed = JSON.parse(proposal.preconditions);
      expectedCurrentCategoryId = parsed.currentCategoryId ?? null;
    } catch {
      return { ok: false, reason: 'Invalid preconditions JSON in proposal' };
    }

    if (expectedCurrentCategoryId !== plan.currentCategoryId) {
      return {
        ok: false,
        reason: `Expected currentCategoryId "${expectedCurrentCategoryId}", got "${plan.currentCategoryId}"`,
      };
    }

    return { ok: true };
  }

  /**
   * Map an authorization disposition to a reason code.
   */
  private deniedReasonCode(auth: AuthorizationResult): string {
    if (auth.membershipStatus !== 'active') return 'member_inactive';
    // Membership is active, so denial is due to capability or scope
    if (auth.disposition.kind === 'denied') {
      if (auth.disposition.reason.startsWith('Missing capability')) return 'insufficient_capability';
      if (auth.disposition.reason.startsWith('Scope')) return 'insufficient_scope';
    }
    return 'authorization_denied';
  }

  /**
   * Build a failure result with the given reason code and message.
   */
  private fail(
    base: ExecuteCategorizationResult,
    code: string,
    message: string,
    _input: ExecuteCategorizationInput,
  ): ExecuteCategorizationResult {
    return {
      ...base,
      success: false,
      reasonCodes: [code],
      message,
    };
  }

  /**
   * Check whether a recent, successful backup-verification audit record
   * exists for the given budgetId. The record must:
   *   - Have classification 'backup_verification'
   *   - Have result 'verified' or 'completed'
   *   - Have budgetId matching the proposal's budget
   *   - Be within the freshness window (BACKUP_VERIFICATION_FRESHNESS_MS)
   *
   * @returns `true` if at least one matching record exists, `false` otherwise.
   */
  private async checkBackupVerified(budgetId: string): Promise<boolean> {
    const records = await this.store.queryAuditRecords('backup_verification', 10);
    for (const record of records) {
      // Must be a successful verification
      if (record.result !== 'verified' && record.result !== 'completed') continue;
      // Must match the budget being mutated
      if (record.budgetId !== budgetId) continue;
      // Must be recent
      if (Date.now() - new Date(record.timestamp).getTime() > BACKUP_VERIFICATION_FRESHNESS_MS) continue;
      return true;
    }
    return false;
  }

  private async recordFailure(input: ExecuteCategorizationInput, err: unknown): Promise<void> {
    try {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Transient errors before the write are retryable
      await this.store.completeIdempotencyRecord(input.idempotencyKey, errMsg, true);
    } catch {
      // Non-fatal
    }
  }


  /**
   * Append an execution_failed audit record after a write error (best-effort).
   */
  private async auditFailure(
    input: ExecuteCategorizationInput,
    proposal: CategorizationProposal,
    auth: AuthorizationResult,
    err: unknown,
  ): Promise<void> {
    try {
      await this.store.appendAuditRecord({
        classification: 'execution_failed',
        actorId: input.actorId,
        operation: proposal.operation,
        proposalId: input.proposalId,
        payloadHash: proposal.payloadHash,
        budgetId: proposal.budgetId,
        policyVersion: proposal.policyVersion,
        authorizationDisposition: auth.disposition,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId ?? null,
        requestId: input.requestId,
        result: err instanceof Error ? err.message : String(err),
        isError: true,
      });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Append an execution_failed audit record for early rejections where
   * auth or even the full proposal may not be available (best-effort).
   */
  private async appendFailureAudit(
    input: ExecuteCategorizationInput,
    proposal: CategorizationProposal | null,
    auth: AuthorizationResult | null,
    result: string,
  ): Promise<void> {
    try {
      await this.store.appendAuditRecord({
        classification: 'execution_failed',
        actorId: input.actorId,
        operation: proposal?.operation ?? 'set_category',
        proposalId: input.proposalId,
        payloadHash: proposal?.payloadHash ?? null,
        budgetId: proposal?.budgetId ?? null,
        policyVersion: proposal?.policyVersion ?? null,
        authorizationDisposition: auth?.disposition ?? null,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId ?? null,
        requestId: input.requestId,
        result,
        isError: true,
      });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Build a replay result from a previously completed idempotency record
   * without touching the ledger or approval store.
   */
  private replayResult(
    idem: IdempotencyRecord,
    input: ExecuteCategorizationInput,
  ): ExecuteCategorizationResult {
    let txId: string | null = null;
    let catId: string | null = null;
    try {
      const effect = JSON.parse(idem.serialisedEffect);
      txId = effect.transactionId ?? null;
      catId = effect.newCategoryId ?? null;
    } catch {
      // Ignore parse failures
    }

    const succeeded = idem.status === 'succeeded';
    return {
      success: succeeded,
      transactionId: txId,
      previousCategoryId: null,
      newCategoryId: catId,
      verified: succeeded,
      planId: null,
      idempotencyKey: input.idempotencyKey,
      approvalId: null,
      auditRecordId: null,
      reasonCodes: ['idempotency_replay'],
      message: idem.errorMessage ?? undefined,
    };
  }

}

// ---------------------------------------------------------------------------
// Native Rust mutation protocol factory
// ---------------------------------------------------------------------------

/** Shape of the @balanceframe/native module used at runtime. */
interface CategorizationNativeBindings {
  planSetCategory(input: string): string;
  verifyMutation(input: string): string;
}

let nativeBin: CategorizationNativeBindings | null = null;

async function getCategorizationNative(): Promise<CategorizationNativeBindings> {
  if (!nativeBin) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    nativeBin = require('@balanceframe/native') as CategorizationNativeBindings;
  }
  return nativeBin;
}

/**
 * Create a RustMutationProtocol backed by the native @balanceframe/native addon.
 * Uses lazy dynamic import so it can be stubbed in non-native environments.
 * Throws if the native addon is not available.
 */
export async function createNativeCategorizationMutationProtocol(): Promise<RustMutationProtocol> {
  const native = await getCategorizationNative();
  return {
    planSetCategory(transaction, category) {
      const json = native.planSetCategory(JSON.stringify({ transaction, category }));
      return JSON.parse(json) as MutationPlan;
    },
    verifyMutation(plan, snapshot) {
      const json = native.verifyMutation(JSON.stringify({ plan, snapshot }));
      return JSON.parse(json) as VerificationResult;
    },
  };
}
