/**
 * CategorizationMutationService — orchestrates the proposal-driven
 * set-category lifecycle with full idempotency, authorization, approval,
 * snapshot planning, write enforcement via BudgetLedger, post-write
 * verification via Rust, and append-only audit trail persistence.
 *
 * ## Dependencies (injected)
 * - {@link WorkflowStore} — proposals, approvals, idempotency, audit, authorization
 * - {@link BudgetLedger} — synchronize (latest snapshot), setTransactionCategory
 * - {@link RustMutationProtocol} — planSetCategory, verifyMutation
 *
 * ## Lifecycle
 * 1. Load proposal — verify existence, not superseded, hash integrity
 * 2. Authorization — evaluate actor membership, capability, scope
 * 3. Approval — verify active, not expired/consumed/superseded, hash match
 * 4. Idempotency — check for past completion (replay) or crash recovery
 * 5. Snapshot — latest `synchronize()` from ledger
 * 6. Plan — Rust `planSetCategory` produces a MutationPlan
 * 7. Precondition — verify plan state matches proposal expectations
 * 8. Write — `setTransactionCategory` through ledger only
 * 9. Reread — fresh `synchronize()` for postcondition verification
 * 10. Verify — Rust `verifyMutation` checks postconditions
 * 11. Consume — mark approval as consumed (one-time)
 * 12. Idempotency — mark record completed (or record failure)
 * 13. Audit — append execution result with observed state
 *
 * The service NEVER repeats a committed write — idempotency replay returns
 * the cached result without touching the ledger or approval store.
 */

import type {
  WorkflowStore,
  CategorizationProposal,
  IdempotencyRecord,
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

/**
 * Synchronous protocol interface for Rust-backed set-category operations.
 * The actual node-binding may serialize/deserialize JSON internally;
 * this interface works with native objects.
 */
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
// Staleness threshold
// ---------------------------------------------------------------------------

/** Snapshots older than this threshold (ms) are rejected as stale. */
const STALE_SNAPSHOT_MS = 3_600_000; // 1 hour

// ---------------------------------------------------------------------------
// CategorizationMutationService
// ---------------------------------------------------------------------------

export class CategorizationMutationService {
  constructor(
    private readonly store: WorkflowStore,
    private readonly ledger: BudgetLedger,
    private readonly rust: RustMutationProtocol,
  ) {}

  /**
   * Execute a categorization proposal end-to-end.
   *
   * @returns An {@link ExecuteCategorizationResult} describing the outcome.
   *          The caller MUST check `.success` and `.verified` for the
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
    // 1. Load proposal — verify existence, supersession, hash binding
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
      return this.fail(baseResult, 'proposal_superseded', 'Proposal has been superseded', input);
    }

    // =====================================================================
    // 2. Authorization — membership, capability, scope
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
      return this.fail(baseResult, code, reasonMsg, input);
    }

    // =====================================================================
    // 3. Load approval — verify active, not expired/consumed/superseded,
    //    payload hash matches proposal
    // =====================================================================

    const approval = await this.store.getApproval(input.approvalId);
    if (!approval) {
      return this.fail(baseResult, 'approval_not_found', 'Approval not found', input);
    }

    if (approval.payloadHash !== proposal.payloadHash) {
      return this.fail(baseResult, 'payload_hash_mismatch',
        'Approval payload hash does not match proposal', input);
    }

    if (approval.status === 'consumed') {
      return this.fail(baseResult, 'approval_consumed', 'Approval has already been consumed', input);
    }

    if (approval.status === 'expired' || new Date(approval.expiresAt).getTime() <= Date.now()) {
      return this.fail(baseResult, 'approval_expired', 'Approval has expired', input);
    }

    if (approval.status === 'superseded') {
      return this.fail(baseResult, 'approval_superseded', 'Approval has been superseded', input);
    }

    // =====================================================================
    // 4. Idempotency check — completed → replay cached result
    // =====================================================================

    const existingIdem = await this.store.getIdempotencyRecord(input.idempotencyKey);
    if (existingIdem) {
      if (existingIdem.completed) {
        // Replay: return the cached result without touching ledger
        return this.replayResult(existingIdem, input);
      }
      // Crash recovery: record exists but wasn't completed — resume execution
    }

    // Reserve the idempotency key
    const serialisedEffect = JSON.stringify({
      transactionId: proposal.transactionId,
      newCategoryId: proposal.categoryId,
    });

    try {
      await this.store.createIdempotencyRecord({
        idempotencyKey: input.idempotencyKey,
        proposalId: input.proposalId,
        operation: 'set_category',
        serialisedEffect,
      });
    } catch (err) {
      return this.fail(baseResult, 'idempotency_replay_mismatch',
        err instanceof Error ? err.message : 'Idempotency record creation failed',
        input);
    }

    // =====================================================================
    // 5. Audit: execution started
    // =====================================================================

    let auditStarted: AuditRecord | null = null;
    try {
      auditStarted = await this.store.appendAuditRecord({
        classification: 'execution_started',
        actorId: input.actorId,
        operation: 'set_category',
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
    // 6. Latest snapshot via ledger.synchronize()
    // =====================================================================

    let snapshotResult: LedgerSnapshotResult;
    try {
      snapshotResult = await this.ledger.synchronize();
    } catch (err) {
      await this.recordFailure(input, err);
      return this.fail(baseResult, 'sync_failed',
        err instanceof Error ? err.message : 'Synchronization failed', input);
    }

    const { snapshot } = snapshotResult;

    // Staleness check
    if (Date.now() - new Date(snapshot.snapshotDate).getTime() > STALE_SNAPSHOT_MS) {
      await this.recordFailure(input, new Error('Snapshot data is stale'));
      return this.fail(baseResult, 'stale_snapshot', 'Snapshot data is stale', input);
    }

    // Find transaction in snapshot
    const tx = snapshot.transactions.find(t => t.id === proposal.transactionId);
    if (!tx) {
      await this.recordFailure(input, new Error('Transaction not found in latest snapshot'));
      return this.fail(baseResult, 'transaction_not_found',
        'Transaction not found in latest snapshot', input);
    }

    // Find category in snapshot
    const cat = snapshot.categories.find(c => c.id === proposal.categoryId);
    if (!cat) {
      await this.recordFailure(input, new Error('Category not found in latest snapshot'));
      return this.fail(baseResult, 'category_not_found',
        'Category not found in latest snapshot', input);
    }

    // =====================================================================
    // 7. Plan via Rust planSetCategory
    // =====================================================================

    let plan: MutationPlan;
    try {
      plan = this.rust.planSetCategory(tx, cat);
    } catch (err) {
      await this.recordFailure(input, err);
      return this.fail(baseResult, 'plan_failed',
        err instanceof Error ? err.message : 'Mutation planning failed', input);
    }

    // =====================================================================
    // 8. Stale precondition check
    // =====================================================================

    const preconditionCheck = this.checkPreconditions(proposal, plan);
    if (!preconditionCheck.ok) {
      await this.recordFailure(input, new Error(preconditionCheck.reason));
      return this.fail(baseResult, 'precondition_mismatch', preconditionCheck.reason, input);
    }

    // =====================================================================
    // 9. Write via ledger.setTransactionCategory
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

    // =====================================================================
    // 10. Reread via fresh synchronize + Rust verifyMutation
    // =====================================================================

    let rereadSnapshot: ProtocolSnapshot;
    try {
      const rereadResult = await this.ledger.synchronize();
      rereadSnapshot = rereadResult.snapshot;
    } catch (err) {
      // Write happened but we can't verify — still need to record outcome
      await this.recordFailure(input, err);
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
    // 11. Consume approval
    // =====================================================================

    try {
      await this.store.consumeApproval(input.approvalId);
    } catch {
      // Non-fatal: approval already consumed or expired — execution still valid
      verifyReasonCodes.push('approval_consumption_failed');
    }

    // =====================================================================
    // 12. Complete idempotency record
    // =====================================================================

    if (!verified) {
      const errMsg = verifyMessage ?? 'Postcondition verification failed';
      try {
        await this.store.completeIdempotencyRecord(input.idempotencyKey, errMsg);
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
    // 13. Append completion audit
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
        operation: 'set_category',
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
    // Return result
    // =====================================================================

    return {
      success: true,
      transactionId: writeResult.transactionId,
      previousCategoryId: writeResult.previousCategoryId,
      newCategoryId: writeResult.newCategoryId,
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
   * Record a failure idempotency outcome (best-effort).
   */
  private async recordFailure(input: ExecuteCategorizationInput, err: unknown): Promise<void> {
    try {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.store.completeIdempotencyRecord(input.idempotencyKey, errMsg);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Append an execution_failed audit record (best-effort).
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
        operation: 'set_category',
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

    return {
      success: idem.completed && !idem.errorMessage,
      transactionId: txId,
      previousCategoryId: null,
      newCategoryId: catId,
      verified: !idem.errorMessage,
      planId: null,
      idempotencyKey: input.idempotencyKey,
      approvalId: null,
      auditRecordId: null,
      reasonCodes: ['idempotency_replay'],
      message: idem.errorMessage ?? undefined,
    };
  }
}
