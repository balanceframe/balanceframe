/**
 * Executes governed set-category proposals through atomic approval acquisition,
 * fresh native planning, Actual writes, and postcondition verification.
 *
 * @module mutation
 */

import {
  GENERIC_MUTATION_POLICY_VERSION,
  ProposalAcquisitionError,
  canonicalProposalJson,
} from '@balanceframe/workflow-store';
import type {
  WorkflowStore,
  ActionProposal,
  IdempotencyRecord,
  AuditRecord,
  AuthorizationDisposition,
  ProposalExecutionAcquisition,
  OperationalAuth,
} from '@balanceframe/workflow-store';

import type {
  BudgetLedger,
  SetCategoryResult,
  LedgerSnapshotResult,
} from '@balanceframe/actual-adapter';

import type { Transaction, Category, ProtocolSnapshot } from '@balanceframe/protocol-generated';
import { moneySchema } from '@balanceframe/protocol-generated/validators';
import { z } from 'zod';

const categoryPreconditionsSchema = z.object({
  transactionId: z.string().optional(),
  accountId: z.string().optional(),
  currentCategoryId: z.string().nullable().optional(),
  amount: moneySchema.optional(),
  actualVersion: z.string().optional(),
  snapshotSchemaVersion: z.string().optional(),
  reviewId: z.string().min(1).optional(),
  reviewProvenance: z.object({
    budgetId: z.string().min(1),
    transactionId: z.string().min(1),
    categoryId: z.string(),
    status: z.enum(['pending_review', 'correcting']),
    version: z.number().int().positive(),
  }).strict().optional(),
  transaction: z.object({
    id: z.string().min(1).optional(),
    accountId: z.string().min(1),
    categoryId: z.string().nullable().optional(),
    direction: z.enum(['incoming', 'outgoing']),
    amount: moneySchema,
  }).passthrough().optional(),
}).passthrough();

const verifiedCategorizationResultSchema = z.object({
  verified: z.literal(true),
  transactionId: z.string().min(1),
  previousCategoryId: z.string().min(1).nullable(),
  newCategoryId: z.string().min(1),
  planId: z.string().min(1),
}).strict();

const replayEffectSchema = z.object({
  operation: z.literal('set_category'),
  payload: z.object({
    transactionId: z.string().min(1),
    categoryId: z.string().min(1),
  }).passthrough(),
  preconditions: categoryPreconditionsSchema,
}).strict();

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

  /** Verify the written target category and postconditions against a fresh snapshot. */
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
  /** Optional selected approval hint; store checks the complete threshold. */
  approvalId?: string;
  /** Trusted server-supplied execution identity. */
  auth: OperationalAuth;
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
    private readonly ledger: BudgetLedger | null,
    private readonly rust: RustMutationProtocol | null,
    options?: MutationServiceOptions,
  ) {
    this.requireBackupVerification = options?.requireBackupVerification ?? false;
  }

  /** Acquires the proposal's complete approval set before planning or writing. */

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

    if (proposal.operation !== 'set_category') {
      return this.fail(
        baseResult,
        'unsupported_operation',
        'Unsupported proposal operation',
        input,
      );
    }
    let priorIdempotency: IdempotencyRecord | null;
    try {
      priorIdempotency = await this.store.getIdempotencyRecord(input.idempotencyKey);
    } catch {
      return this.fail(baseResult, 'idempotency_record_unavailable', 'Execution record is unavailable', input);
    }
    const terminalReplay = priorIdempotency?.status === 'succeeded' ||
      priorIdempotency?.status === 'terminal_failed';
    if (!terminalReplay && (!this.ledger || !this.rust))
      return this.fail(baseResult, 'dependencies_unavailable', 'Fresh execution requires ledger and Native verification dependencies', input);


    if (!terminalReplay && proposal.policyVersion !== GENERIC_MUTATION_POLICY_VERSION) {
      await this.appendFailureAudit(input, proposal, null, 'policy_version_mismatch');
      return this.fail(baseResult, 'policy_version_mismatch', 'The approved mutation algorithm is no longer current', input);
    }

    if (!terminalReplay && proposal.supersededAt) {
      await this.appendFailureAudit(input, proposal, null, 'proposal_superseded');
      return this.fail(baseResult, 'proposal_superseded', 'Proposal has been superseded', input);
    }

    // Check proposal expiry
    if (!terminalReplay && new Date(proposal.expiresAt).getTime() <= Date.now()) {
      await this.appendFailureAudit(input, proposal, null, 'proposal_expired');
      return this.fail(baseResult, 'proposal_expired', 'Proposal has expired', input);
    }

    // =====================================================================
    // 2. Backup verification — require recent successful backup_verification
    //    audit record with matching budgetId
    // =====================================================================

    if (!terminalReplay && this.requireBackupVerification) {
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

    let parsedPreconditions: unknown;
    const composite = proposal.payload.composite;
    if (
      !terminalReplay &&
      composite &&
      ((composite.operations.length > 0 &&
        (composite.operations.length !== 1 ||
          composite.operations[0]?.operation !== 'set_category' ||
          composite.operations[0]?.transactionId !== proposal.payload.transactionId ||
          composite.operations[0]?.categoryId !== proposal.payload.categoryId)) ||
        composite.reallocations.length > 0 ||
        composite.transferRecommendations.length > 0 ||
        composite.ledgerProjections.length > 0)
    )
      return this.fail(baseResult, 'unsupported_composite', 'Mutation cannot apply composite proposal operations', input);

    let serialisedEffect: string;
    try {
      parsedPreconditions = JSON.parse(proposal.preconditions) as unknown;
      serialisedEffect = JSON.stringify({
        operation: proposal.operation,
        payload: proposal.payload,
        preconditions: parsedPreconditions,
      });
    } catch {
      return this.fail(baseResult, 'payload_hash_mismatch', 'Proposal envelope is invalid', input);
    }
    const parsed = categoryPreconditionsSchema.safeParse(parsedPreconditions);
    if (!parsed.success)
      return this.fail(baseResult, 'payload_hash_mismatch', 'Proposal preconditions are invalid', input);
    const reviewId = parsed.data.reviewId ?? null;
    const hasReviewReference = reviewId !== null || parsed.data.reviewProvenance !== undefined;
    if (!terminalReplay && hasReviewReference) {
      let reviewCurrent = false;
      try {
        reviewCurrent = await this.store.isProposalReviewProvenanceCurrent(input.proposalId);
      } catch {
        return this.fail(baseResult, 'review_reference_unavailable', 'Review provenance is unavailable', input);
      }
      if (!reviewCurrent)
        return this.fail(baseResult, 'review_reference_mismatch', 'Review provenance no longer matches', input);
    }


    if (!proposal.governancePolicyVersion)
      return this.fail(baseResult, 'authorization_denied', 'Governed proposal provenance unavailable', input);
    let acquisition: ProposalExecutionAcquisition;
    try {
      acquisition = await this.store.acquireProposalExecution({
        actorId: input.actorId,
        proposalId: input.proposalId,
        payloadHash: proposal.payloadHash,
        governancePolicyVersion: proposal.governancePolicyVersion,
        idempotencyKey: input.idempotencyKey,
        serialisedEffect,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        auth: input.auth,
        requestId: input.requestId,
        correlationId: input.correlationId,
      });
    } catch (err) {
      const code = err instanceof ProposalAcquisitionError ? err.reasonCode : 'execution_acquisition_failed';
      const message = err instanceof ProposalAcquisitionError
        ? err.message
        : 'Execution authorization could not be acquired';
      return this.fail(baseResult, code, message, input);
    }

    if (!acquisition.claim.isOwner) {
      if (acquisition.claim.record.status !== 'in_progress') {
        const replay = this.replayResult(acquisition.claim.record, input, baseResult);
        if (!replay.success || !hasReviewReference) return replay;
        try {
          const completed = await this.store.completeVerifiedCategorizationReview(input.idempotencyKey);
          if (completed === null) throw new Error('Linked review was not finalized');
        } catch {
          return this.fail(
            baseResult,
            'review_completion_failed',
            'Verified execution could not complete its linked review',
            input,
          );
        }
        return replay;
      }
      return this.fail(
        baseResult,
        'idempotency_in_progress',
        'Execution with this idempotency key is already in progress',
        input,
      );
    }
    if (!this.ledger || !this.rust)
      return this.fail(baseResult, 'dependencies_unavailable', 'Fresh execution requires ledger and Native verification dependencies', input);
    const auditStarted = acquisition.auditRecord;
    if (!auditStarted) {
      await this.store.completeIdempotencyRecord(
        input.idempotencyKey,
        'Acquisition did not return its durable audit record',
        false,
      );
      return this.fail(baseResult, 'execution_audit_missing', 'Execution audit record is unavailable', input);
    }
    const authorizationDisposition = auditStarted.authorizationDisposition;
    if (!authorizationDisposition) {
      await this.store.completeIdempotencyRecord(
        input.idempotencyKey,
        'Acquisition audit record omitted authorization disposition',
        false,
      );
      return this.fail(baseResult, 'execution_audit_invalid', 'Execution audit record is invalid', input);
    }
    const consumedApprovalId =
      input.approvalId ?? acquisition.approvals[0]?.id ?? null;
    // =====================================================================
    // 8. Latest snapshot via ledger.synchronize()
    // =====================================================================

    let snapshotResult: LedgerSnapshotResult;
    try {
      snapshotResult = await this.ledger.synchronize();
    } catch (err) {
      await this.recordFailure(input, err);
      await this.appendFailureAudit(
        input,
        proposal,
        authorizationDisposition,
        err instanceof Error ? err.message : 'sync_failed',
      );
      return this.fail(
        baseResult,
        'sync_failed',
        err instanceof Error ? err.message : 'Synchronization failed',
        input,
      );
    }

    const { snapshot } = snapshotResult;

    // Staleness check
    if (Date.now() - new Date(snapshot.snapshotDate).getTime() > STALE_SNAPSHOT_MS) {
      await this.recordFailure(input, new Error('Snapshot data is stale'));
      await this.appendFailureAudit(input, proposal, authorizationDisposition, 'stale_snapshot');
      return this.fail(baseResult, 'stale_snapshot', 'Snapshot data is stale', input);
    }

    // Find transaction in snapshot
    const tx = snapshot.transactions.find((t) => t.id === proposal.payload.transactionId);
    if (!tx) {
      await this.recordFailure(input, new Error('Transaction not found in latest snapshot'));
      await this.appendFailureAudit(input, proposal, authorizationDisposition, 'transaction_not_found');
      return this.fail(
        baseResult,
        'transaction_not_found',
        'Transaction not found in latest snapshot',
        input,
      );
    }

    // Find category in snapshot
    const cat = snapshot.categories.find((c) => c.id === proposal.payload.categoryId);
    if (!cat || cat.deleted) {
      await this.recordFailure(input, new Error('Category not found in latest snapshot'));
      await this.appendFailureAudit(input, proposal, authorizationDisposition, 'category_not_found');
      return this.fail(
        baseResult,
        'category_not_found',
        'Category not found in latest snapshot',
        input,
      );
    }

    // =====================================================================
    // 9. Plan via Rust planSetCategory
    // =====================================================================

    let plan: MutationPlan;
    try {
      plan = this.rust.planSetCategory(tx, cat);
    } catch (err) {
      await this.recordFailure(input, err);
      await this.appendFailureAudit(
        input,
        proposal,
        authorizationDisposition,
        err instanceof Error ? err.message : 'plan_failed',
      );
      return this.fail(
        baseResult,
        'plan_failed',
        err instanceof Error ? err.message : 'Mutation planning failed',
        input,
      );
    }

    // =====================================================================
    // 10. Stale precondition check
    // =====================================================================

    const preconditionCheck = this.checkPreconditions(proposal, plan, tx, snapshot);
    if (!preconditionCheck.ok) {
      await this.recordFailure(input, new Error(preconditionCheck.reason));
      await this.appendFailureAudit(input, proposal, authorizationDisposition, 'precondition_mismatch');
      return this.fail(baseResult, 'precondition_mismatch', preconditionCheck.reason, input);
    }

    // =====================================================================
    // 11. Write via ledger.setTransactionCategory
    // =====================================================================

    let writeResult: SetCategoryResult;
    try {
      writeResult = await this.ledger.setTransactionCategory(
        proposal.payload.transactionId,
        proposal.payload.categoryId,
        plan.currentCategoryId,
      );
    } catch (err) {
      await this.recordFailure(input, err);
      await this.auditFailure(input, proposal, authorizationDisposition, err);
      return this.fail(
        baseResult,
        'write_failed',
        err instanceof Error ? err.message : 'Write operation failed',
        input,
      );
    }
    if (!writeResult.success) {
      await this.recordFailure(input, new Error(writeResult.error));
      await this.auditFailure(input, proposal, authorizationDisposition, new Error(writeResult.error));
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
      await this.appendFailureAudit(input, proposal, authorizationDisposition, 'reread_failed');
      return this.fail(
        baseResult,
        'reread_failed',
        err instanceof Error ? err.message : 'Post-write reread failed',
        input,
      );
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

    if (verified && (
      writeResult.transactionId !== plan.transactionId ||
      writeResult.transactionId !== proposal.payload.transactionId ||
      writeResult.previousCategoryId !== plan.currentCategoryId ||
      writeResult.newCategoryId !== plan.proposedCategoryId ||
      writeResult.newCategoryId !== proposal.payload.categoryId
    )) {
      verified = false;
      verifyReasonCodes.push('write_result_mismatch');
      verifyMessage = 'Verified mutation result does not match the approved plan';
    }

    let completed = false;
    if (!verified) {
      try {
        await this.store.completeIdempotencyRecord(
          input.idempotencyKey,
          verifyMessage ?? 'Postcondition verification failed',
          false,
        );
      } catch {
        // Preserve the unverified result even if bookkeeping is unavailable.
      }
    } else {
      const serialisedResult = JSON.stringify({
        verified: true,
        transactionId: writeResult.transactionId,
        previousCategoryId: writeResult.previousCategoryId,
        newCategoryId: writeResult.newCategoryId,
        planId: plan.planId,
      });
      try {
        const record = await this.store.completeIdempotencyRecord(
          input.idempotencyKey,
          null,
          undefined,
          serialisedResult,
        );
        if (
          record.status !== 'succeeded' ||
          (reviewId === null && record.serialisedResult !== serialisedResult)
        )
          throw new Error('Verified result was not durably stored');
        completed = true;
      } catch {
        verifyReasonCodes.push('idempotency_result_unavailable');
        verifyMessage = 'Verified result could not be durably stored';
      }
    }

    if (completed && reviewId !== null) {
      try {
        const finalized = await this.store.completeVerifiedCategorizationReview(input.idempotencyKey);
        if (finalized === null) throw new Error('Linked review was not finalized');
      } catch {
        completed = false;
        verifyReasonCodes.push('review_completion_failed');
        verifyMessage = 'Verified execution could not complete its linked review';
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
      workflowCompleted: completed,
    });

    let auditCompleted: AuditRecord | null = null;
    try {
      auditCompleted = await this.store.appendAuditRecord({
        classification: completed ? 'execution_completed' : 'execution_failed',
        actorId: input.actorId,
        operation: proposal.operation,
        proposalId: input.proposalId,
        payloadHash: proposal.payloadHash,
        budgetId: proposal.budgetId,
        backendIds: '',
        policyVersion: proposal.policyVersion,
        authorizationDisposition,
        idempotencyKey: input.idempotencyKey,
        expectedPriorState: proposal.preconditions,
        observedResultState: obsState,
        providerModel: proposal.providerModel ?? undefined,
        correlationId: input.correlationId ?? null,
        requestId: input.requestId,
        result: completed ? 'completed' : verified ? 'bookkeeping_failed' : 'verification_failed',
        isError: !completed,
      });
    } catch {
      // Non-fatal: audit failure doesn't change execution outcome
    }

    // =====================================================================
    // 15. Return result — success requires verified postconditions
    // =====================================================================

    return {
      success: completed,
      transactionId: writeResult.transactionId ?? null,
      previousCategoryId: writeResult.previousCategoryId ?? null,
      newCategoryId: writeResult.newCategoryId ?? null,
      verified,
      planId: plan.planId,
      idempotencyKey: input.idempotencyKey,
      approvalId: consumedApprovalId,
      auditRecordId: auditCompleted?.id ?? auditStarted?.id ?? null,
      reasonCodes: allReasonCodes,
      message: completed ? undefined : (verifyMessage ?? 'Postcondition verification failed'),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Check approved transaction facts against the fresh ledger and native plan.
   */
  private checkPreconditions(
    proposal: Extract<ActionProposal, { operation: 'set_category' }>,
    plan: MutationPlan,
    transaction: Transaction,
    snapshot: ProtocolSnapshot,
  ): { ok: true } | { ok: false; reason: string } {
    try {
      const parsed = categoryPreconditionsSchema.safeParse(JSON.parse(proposal.preconditions) as unknown);
      if (!parsed.success)
        return { ok: false, reason: 'Invalid preconditions JSON in proposal' };
      const expected = parsed.data;
      if (
        !expected.nativePlan ||
        proposal.payload.composite?.nativePayloadHash !== plan.hash ||
        canonicalProposalJson(expected.nativePlan) !== canonicalProposalJson(plan)
      )
        return { ok: false, reason: 'Approved native plan no longer matches the current algorithm' };
      const expectedTransaction = expected.transaction;
      const currentAmount = BigInt(transaction.amount.minorUnits);
      const expectedCategory = expectedTransaction?.categoryId !== undefined
        ? expectedTransaction.categoryId
        : expected.currentCategoryId ?? null;
      if (
        expectedCategory !== plan.currentCategoryId ||
        transaction.categoryId !== plan.currentCategoryId ||
        (expected.transactionId !== undefined && expected.transactionId !== transaction.id) ||
        (expected.accountId !== undefined && expected.accountId !== transaction.accountId) ||
        expected.actualVersion !== snapshot.actualVersion ||
        expected.snapshotSchemaVersion !== snapshot.schemaVersion ||
        (expected.amount !== undefined && (
          expected.amount.currency !== transaction.amount.currency ||
          BigInt(expected.amount.minorUnits) !== BigInt(transaction.amount.minorUnits)
        )) ||
        (expectedTransaction !== undefined && (
          (expectedTransaction.id !== undefined && expectedTransaction.id !== transaction.id) ||
          expectedTransaction.accountId !== transaction.accountId ||
          expectedTransaction.direction !== (currentAmount < 0n ? 'outgoing' : 'incoming') ||
          expectedTransaction.amount.currency !== transaction.amount.currency ||
          BigInt(expectedTransaction.amount.minorUnits) !== (currentAmount < 0n ? -currentAmount : currentAmount)
        ))
      )
        return { ok: false, reason: 'Approved transaction facts no longer match the current ledger' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'Invalid preconditions JSON in proposal' };
    }
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
      if (Date.now() - new Date(record.timestamp).getTime() > BACKUP_VERIFICATION_FRESHNESS_MS)
        continue;
      return true;
    }
    return false;
  }

  private async recordFailure(input: ExecuteCategorizationInput, err: unknown): Promise<void> {
    try {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Acquired proposal authority is never returned to the approval pool.
      await this.store.completeIdempotencyRecord(input.idempotencyKey, errMsg, false);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Append an execution_failed audit record after a write error (best-effort).
   */
  private async auditFailure(
    input: ExecuteCategorizationInput,
    proposal: ActionProposal,
    authorizationDisposition: AuthorizationDisposition,
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
        authorizationDisposition,
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
    proposal: ActionProposal | null,
    authorizationDisposition: AuthorizationDisposition | null,
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
        authorizationDisposition,
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
    baseResult: ExecuteCategorizationResult,
  ): ExecuteCategorizationResult {
    if (idem.status !== 'succeeded')
      return this.fail(
        baseResult,
        'idempotency_replay',
        idem.errorMessage ?? 'The previous execution did not succeed',
        input,
      );
    if (!idem.serialisedResult)
      return this.fail(
        baseResult,
        'idempotency_result_unavailable',
        'The previous execution has no stored verified result',
        input,
      );

    let storedEffect: unknown;
    let storedResult: unknown;
    try {
      storedEffect = JSON.parse(idem.serialisedEffect) as unknown;
      storedResult = JSON.parse(idem.serialisedResult) as unknown;
    } catch {
      return this.fail(baseResult, 'idempotency_result_invalid', 'Stored execution result is malformed', input);
    }
    const effect = replayEffectSchema.safeParse(storedEffect);
    const result = verifiedCategorizationResultSchema.safeParse(storedResult);
    if (!effect.success || !result.success)
      return this.fail(baseResult, 'idempotency_result_invalid', 'Stored execution result is malformed', input);
    const plan = z.object({
      planId: z.string().min(1),
      transactionId: z.string().min(1),
      currentCategoryId: z.string().min(1).nullable(),
      proposedCategoryId: z.string().min(1),
    }).passthrough().safeParse(effect.data.preconditions.nativePlan);
    if (!plan.success)
      return this.fail(baseResult, 'idempotency_result_invalid', 'Stored execution plan is malformed', input);
    if (
      result.data.transactionId !== effect.data.payload.transactionId ||
      result.data.newCategoryId !== effect.data.payload.categoryId ||
      result.data.planId !== plan.data.planId ||
      result.data.transactionId !== plan.data.transactionId ||
      result.data.previousCategoryId !== plan.data.currentCategoryId ||
      result.data.newCategoryId !== plan.data.proposedCategoryId
    )
      return this.fail(
        baseResult,
        'idempotency_result_mismatch',
        'Stored verified result does not match its acquired proposal',
        input,
      );

    return {
      ...baseResult,
      success: true,
      transactionId: result.data.transactionId,
      previousCategoryId: result.data.previousCategoryId,
      newCategoryId: result.data.newCategoryId,
      verified: true,
      planId: result.data.planId,
      reasonCodes: ['idempotency_replay'],
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
