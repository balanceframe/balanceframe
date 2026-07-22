/**
 * RuleMutationService — orchestrates the proposal-driven rule creation flow.
 *
 * Follows the same pattern as CategorizationMutationService but for
 * rule creation via ledger.createRule().
 *
 * Flow summary:
 *   1. Load proposal — verifies existence, not superseded, not expired
 *   2. Authorization — membership, capability, scope
 *   3. Idempotency claim — create record; completed -> replay;
 *      in-flight -> conflict; else proceed
 *   4. Load approval — exact proposalId + payloadHash binding,
 *      operation check, status checks (active, not consumed/expired/superseded)
 *   5. Consume approval — one-time lock preventing concurrent execution
 *   6. Audit: execution started
 *   7. Latest snapshot via ledger.synchronize()
 *   8. Plan via Rust planCreateRule
 *   9. Stale precondition check
 *  10. Write via ledger.createRule
 *  11. Reread + Rust verifyRuleMutation
 *  12. Complete idempotency record (error if verification failed)
 *  13. Append completion/failure audit
 *  14. Return result — success = verified
 */

import type {
  WorkflowStore,
  CategorizationProposal,
  IdempotencyClaim,
  IdempotencyRecord,
  AuditRecord,
  AuthorizationResult,
} from '@balanceframe/workflow-store';

import type {
  BudgetLedger,
  MutationResult,
  LedgerSnapshotResult,
} from '@balanceframe/actual-adapter';

import type {
  ProtocolSnapshot,
} from '@balanceframe/protocol-generated';

import { VerificationResult } from './mutation.js';

// ---------------------------------------------------------------------------
// Rule proposal input / plan types
// ---------------------------------------------------------------------------

/** Input to plan a rule mutation (pre-execution planning). */
export interface RuleProposalInput {
  /** Human-readable rule name. */
  name: string;
  /** Rule trigger conditions. */
  conditions: unknown[];
  /** Rule actions to execute when triggered. */
  actions: unknown[];
  /** Budget this rule belongs to. */
  budgetId: string;
}

/** Plan produced by the Rust protocol for a rule mutation. */
export interface RuleMutationPlan {
  /** Stable plan identifier. */
  planId: string;
  /** Name of the rule to create. */
  ruleName: string;
  /** Preconditions that must hold for safe execution. */
  preconditions: {
    /** Whether the rule name is available (no collision). */
    ruleNameAvailable: boolean;
  };
  /** Expected outcome of the mutation. */
  expectedOutcome: {
    name: string;
    trigger: unknown;
    actions: unknown;
  };
}

// ---------------------------------------------------------------------------
// Simulation types
// ---------------------------------------------------------------------------

/** An example transaction that a rule would match during simulation. */
export interface SimulationExample {
  /** Transaction ID. */
  txId: string;
  /** Payee name, if available. */
  payee: string | null;
  /** Transaction amount with minor units and currency. */
  amount: { minorUnits: string; currency: string };
  /** Current category name, if any. */
  currentCategory: string | null;
  /** Whether the rule would change the category. */
  wouldChange: boolean;
}

/** Simulation evidence produced by the Rust simulateRule function. */
export interface RuleSimulationResult {
  /** Rule ID (empty for planned rules). */
  ruleId: string;
  /** Rule name. */
  name: string;
  /** Number of transactions that would be matched. */
  transactionsMatched: number;
  /** IDs of transactions that would be affected. */
  transactionsAffected: string[];
  /** Distribution of target categories. */
  categoryDistribution: Record<string, number>;
  /** Conflict messages when a rule overlaps with other rules. */
  conflicts: string[];
  /** Example transactions that would be affected. */
  examples: SimulationExample[];
}

// ---------------------------------------------------------------------------
// Rust protocol surface — rule-specific planning and verification
// ---------------------------------------------------------------------------

export interface RustRuleMutationProtocol {
  /** Plan a rule creation mutation against the current snapshot. */
  planCreateRule(
    input: RuleProposalInput,
    snapshot: ProtocolSnapshot,
  ): RuleMutationPlan;

  /** Verify that a rule mutation was applied correctly. */
  verifyRuleMutation(
    plan: RuleMutationPlan,
    snapshot: ProtocolSnapshot,
  ): VerificationResult;

  /** Simulate a rule against snapshot transactions and return evidence. */
  simulateRule(
    rule: { name: string; trigger: unknown; actions: unknown },
    snapshot: ProtocolSnapshot,
  ): RuleSimulationResult;
}

// Native implementation (calls @balanceframe/native N-API bindings at runtime)
// The native addon is not available in all environments (CI, test runners).
// We use runtime dynamic import so callers provide their own resolution.

// @balanceframe/native is a napi-rs addon built from crates/node-binding.
// The NativeBindings interface provides the type contract locally.
// We avoid a static import because the package does not ship standard
// TypeScript declarations — load the binary at runtime via createRequire.

/** Shape of the @balanceframe/native module used at runtime. */
interface NativeBindings {
  planCreateRule(input: string): string;
  verifyRuleMutation(input: string): string;
  planSetCategory(input: string): string;
  verifyMutation(input: string): string;
  simulateRule(input: string): string;
}

let nativeBin: NativeBindings | null = null;

async function getNative(): Promise<NativeBindings> {
  if (!nativeBin) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    nativeBin = require('@balanceframe/native') as NativeBindings;
  }
  return nativeBin;
}

function getConditionValue(conditions: unknown[] | undefined): string {
  const c = conditions?.[0];
  if (c && typeof c === 'object' && 'value' in c) {
    const v = (c as Record<string, unknown>).value;
    return typeof v === 'string' ? v : '';
  }
  return '';
}

function getActionValue(actions: unknown[] | undefined): string {
  const a = actions?.[0];
  if (a && typeof a === 'object' && 'value' in a) {
    const v = (a as Record<string, unknown>).value;
    return typeof v === 'string' ? v : '';
  }
  return '';
}

/**
 * Create a RustRuleMutationProtocol backed by the native @balanceframe/native addon.
 * Uses lazy dynamic import so it can be stubbed in non-native environments.
 * Throws if the native addon is not available.
 */
export async function createNativeRuleMutationProtocol(): Promise<RustRuleMutationProtocol> {
  const native = await getNative();
  return {
    planCreateRule(input, snapshot) {
      const payeeName = getConditionValue(input.conditions) || input.name;
      const categoryId = getActionValue(input.actions);
      const json = native.planCreateRule(JSON.stringify({
        ruleName: input.name,
        payeeName,
        categoryId,
        snapshot,
      }));
      return JSON.parse(json) as RuleMutationPlan;
    },
    verifyRuleMutation(plan, snapshot) {
      const json = native.verifyRuleMutation(JSON.stringify({ plan, snapshot }));
      return JSON.parse(json) as VerificationResult;
    },
    simulateRule(rule, snapshot) {
      const json = native.simulateRule(JSON.stringify({
        rule: {
          id: '',
          name: rule.name,
          order: 0,
          trigger: rule.trigger,
          actions: rule.actions,
          inactive: false,
        },
        transactions: snapshot.transactions,
      }));
      return JSON.parse(json) as RuleSimulationResult;
     },
  };
}

// ---------------------------------------------------------------------------
// Service input / result types
// ---------------------------------------------------------------------------

/** Input to execute a single rule-creation proposal. */
export interface ExecuteRuleInput {
  /** The proposal to execute. */
  proposalId: string;
  /** The approval granting authorization for this execution. */
  approvalId: string;
  /** Actor performing the execution. */
  actorId: string;
  /** Unique request identifier for idempotency. */
  requestId: string;
  /** Idempotency key for at-most-once execution. */
  idempotencyKey: string;
  /** Optional correlation ID for audit trail grouping. */
  correlationId?: string;
}

/** Result of executing a rule-creation proposal. */
export interface ExecuteRuleResult {
  /** Whether the execution completed without errors (write + verification). */
  success: boolean;
  /** The ID of the created rule, or null on failure. */
  ruleId: string | null;
  /** Whether postcondition verification passed. */
  verified: boolean;
  /** Idempotency key used for this execution. */
  idempotencyKey: string;
  /** Approval ID used, or null on early rejection. */
  approvalId: string | null;
  /** ID of the final audit record, or null. */
  auditRecordId: string | null;
  /** Reason codes describing the outcome. */
  reasonCodes: string[];
  /** Human-readable message for failures or verification issues. */
  message?: string;
  /** Simulation evidence from the Rust simulateRule call, or null on early rejection. */
  simulation: RuleSimulationResult | null;
}

// ---------------------------------------------------------------------------
// Default capability / scope values
// ---------------------------------------------------------------------------

const CAPABILITY_EXECUTE = 'rule:execute';

// ---------------------------------------------------------------------------
// Staleness / freshness thresholds (ms)
// ---------------------------------------------------------------------------

/** Snapshots older than this threshold are rejected as stale. */
const STALE_SNAPSHOT_MS = 3_600_000; // 1 hour

// ---------------------------------------------------------------------------
// planRuleMutation — delegates to the Rust protocol
// ---------------------------------------------------------------------------

/**
 * Plan a rule mutation using the Rust protocol.
 *
 * @param rust The Rust protocol bridge.
 * @param input Rule proposal input (name, conditions, actions).
 * @param snapshot Current protocol snapshot for precondition evaluation.
 * @returns A RuleMutationPlan describing the intended mutation.
 */
export function planRuleMutation(
  rust: RustRuleMutationProtocol,
  input: RuleProposalInput,
  snapshot: ProtocolSnapshot,
): RuleMutationPlan {
  return rust.planCreateRule(input, snapshot);
}

// ---------------------------------------------------------------------------
// RuleMutationService
// ---------------------------------------------------------------------------

/**
 * RuleMutationService — orchestrates the proposal-driven rule mutation flow.
 *
 * Flow: load-proposal -> auth -> idempotency -> approval -> consume ->
 * execute (ledger.createRule) -> verify -> audit.
 */
export class RuleMutationService {
  constructor(
    private readonly store: WorkflowStore,
    private readonly ledger: BudgetLedger,
    private readonly rust: RustRuleMutationProtocol,
  ) {}

  /**
   * Execute a rule-creation proposal end-to-end.
   *
   * @returns An {@link ExecuteRuleResult} describing the outcome.
   *          The caller MUST check both `.success` and `.verified` for the
   *          full picture — a write may succeed but postcondition
   *          verification may fail.
   */
  async execute(input: ExecuteRuleInput): Promise<ExecuteRuleResult> {
    const baseResult: ExecuteRuleResult = {
      success: false,
      ruleId: null,
      verified: false,
      idempotencyKey: input.idempotencyKey,
      approvalId: null,
      auditRecordId: null,
      reasonCodes: [],
      simulation: null,
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
          operation: 'create_rule',
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
        // Non-fatal
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
      await this.appendFailureAudit(input, proposal, auth, code);
      return this.fail(baseResult, code, reasonMsg, input);
    }

    // =====================================================================
    // 3. Idempotency claim (atomic check-and-create)
    // =====================================================================

    const serialisedEffect = JSON.stringify({
      ruleName: this.extractRuleName(proposal),
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
      if (idemClaim.record.completed) {
        // Replay: return the cached result without touching ledger or approval
        return this.replayResult(idemClaim.record, input);
      }
      // In-flight: another execution is using this key
      await this.appendFailureAudit(input, proposal, auth, 'idempotency_in_progress');
      return this.fail(baseResult, 'idempotency_in_progress',
        'Execution with this idempotency key is already in progress', input);
    }

    // We own the claim — proceed with execution

    // =====================================================================
    // 4. Load approval — verify binding, payload hash, operation, status
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
    if (proposal.operation !== 'create_rule') {
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
    // 5. Consume approval BEFORE mutation — one-time lock
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
    // 6. Audit: execution started
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
      // Non-fatal
    }

    // =====================================================================
    // 7. Latest snapshot via ledger.synchronize()
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

    // =====================================================================
    // 9. Plan via Rust planCreateRule (planning step 8 logically follows
    //    snapshot, but precondition check happens before write)
    // =====================================================================

    const ruleInput = this.extractRuleInput(proposal);
    let plan: RuleMutationPlan;
    try {
      plan = this.rust.planCreateRule(ruleInput, snapshot);
    } catch (err) {
      await this.recordFailure(input, err);
      await this.appendFailureAudit(input, proposal, auth,
        err instanceof Error ? err.message : 'plan_failed');
      return this.fail(baseResult, 'plan_failed',
        err instanceof Error ? err.message : 'Rule mutation planning failed', input);
    }

    // =====================================================================
    // 10. Precondition check — verify rule name availability
    // =====================================================================

    if (!plan.preconditions.ruleNameAvailable) {
      await this.recordFailure(input, new Error('Rule name is not available'));
      await this.appendFailureAudit(input, proposal, auth, 'rule_name_conflict');
      return this.fail(baseResult, 'rule_name_conflict',
        `A rule with the name "${plan.ruleName}" already exists`, input);
    }

    // =====================================================================
    // 11. Simulate the planned rule — must produce evidence, no conflicts
    // =====================================================================

    let simulation: RuleSimulationResult;
    try {
      simulation = this.rust.simulateRule(
        {
          name: plan.ruleName,
          trigger: plan.expectedOutcome.trigger,
          actions: plan.expectedOutcome.actions,
        },
        snapshot,
      );
    } catch (err) {
      await this.recordFailure(input, err);
      await this.appendFailureAudit(input, proposal, auth,
        err instanceof Error ? err.message : 'simulation_failed');
      return this.fail(baseResult, 'simulation_failed',
        err instanceof Error ? err.message : 'Rule simulation failed', input);
    }

    // Proposals cannot execute without simulation evidence
    if (simulation.transactionsMatched === 0) {
      baseResult.simulation = simulation;
      await this.recordFailure(input, new Error('Rule would match zero transactions'));
      await this.appendFailureAudit(input, proposal, auth, 'simulation_no_matches');
      return this.fail(baseResult, 'simulation_no_matches',
        'Rule simulation matched zero transactions — no evidence for execution', input);
    }

    // Surface conflicts from overlapping rules
    if (simulation.conflicts.length > 0) {
      baseResult.simulation = simulation;
      await this.recordFailure(input, new Error('Simulation revealed conflicts'));
      await this.appendFailureAudit(input, proposal, auth, 'simulation_conflicts');
      return this.fail(baseResult, 'simulation_conflicts',
        `Rule simulation revealed conflicts: ${simulation.conflicts.join('; ')}`, input);
    }

    // =====================================================================
    // 12. Write via ledger.createRule
    // =====================================================================


    let writeResult: MutationResult;
    try {
      writeResult = await this.ledger.createRule({
        name: ruleInput.name,
        conditions: ruleInput.conditions,
        actions: ruleInput.actions,
      });
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

    const ruleId = writeResult.id;

    // =====================================================================
    // 12. Reread via fresh synchronize + Rust verifyRuleMutation
    // =====================================================================

    let rereadSnapshot: ProtocolSnapshot;
    try {
      const rereadResult = await this.ledger.synchronize();
      rereadSnapshot = rereadResult.snapshot;
    } catch (err) {
      // Write happened but we can't verify
      await this.recordFailure(input, err);
      await this.appendFailureAudit(input, proposal, auth, 'reread_failed');
      return this.fail(baseResult, 'reread_failed',
        err instanceof Error ? err.message : 'Post-write reread failed', input);
    }

    let verified = false;
    let verifyReasonCodes: string[] = [];
    let verifyMessage: string | null = null;

    try {
      const verification = this.rust.verifyRuleMutation(plan, rereadSnapshot);
      verified = verification.verified;
      verifyReasonCodes = verification.reasonCodes;
      verifyMessage = verification.message;
    } catch (err) {
      verifyReasonCodes = ['verify_failed'];
      verifyMessage = err instanceof Error ? err.message : 'Verification threw';
    }

    // =====================================================================
    // 13. Complete idempotency record
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
    // 14. Append completion or failure audit
    // =====================================================================

    const allReasonCodes = [...verifyReasonCodes];
    const obsState = JSON.stringify({
      ruleId,
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
      // Non-fatal
    }

    // =====================================================================
    // 15. Return result
    // =====================================================================

    return {
      success: verified,
      ruleId,
      verified,
      idempotencyKey: input.idempotencyKey,
      approvalId: input.approvalId,
      auditRecordId: auditCompleted?.id ?? auditStarted?.id ?? null,
      reasonCodes: allReasonCodes,
      message: verified ? undefined : (verifyMessage ?? 'Postcondition verification failed'),
      simulation,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Extract the rule name from proposal preconditions.
   */
  private extractRuleName(proposal: CategorizationProposal): string {
    try {
      const parsed = JSON.parse(proposal.preconditions);
      return parsed.name ?? 'unnamed_rule';
    } catch {
      return 'unnamed_rule';
    }
  }

  /**
   * Extract rule input from proposal preconditions.
   */
  private extractRuleInput(proposal: CategorizationProposal): RuleProposalInput {
    try {
      const parsed = JSON.parse(proposal.preconditions);
      return {
        name: parsed.name ?? 'unnamed_rule',
        conditions: parsed.conditions ?? [],
        actions: parsed.actions ?? [],
        budgetId: proposal.budgetId,
      };
    } catch {
      return {
        name: 'unnamed_rule',
        conditions: [],
        actions: [],
        budgetId: proposal.budgetId,
      };
    }
  }

  /**
   * Map an authorization disposition to a reason code.
   */
  private deniedReasonCode(auth: AuthorizationResult): string {
    if (auth.membershipStatus !== 'active') return 'member_inactive';
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
    base: ExecuteRuleResult,
    code: string,
    message: string,
    _input: ExecuteRuleInput,
  ): ExecuteRuleResult {
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
  private async recordFailure(input: ExecuteRuleInput, err: unknown): Promise<void> {
    try {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.store.completeIdempotencyRecord(input.idempotencyKey, errMsg);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Append an execution_failed audit record after a write error (best-effort).
   */
  private async auditFailure(
    input: ExecuteRuleInput,
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
   * Append an execution_failed audit record for early rejections (best-effort).
   */
  private async appendFailureAudit(
    input: ExecuteRuleInput,
    proposal: CategorizationProposal | null,
    auth: AuthorizationResult | null,
    result: string,
  ): Promise<void> {
    try {
      await this.store.appendAuditRecord({
        classification: 'execution_failed',
        actorId: input.actorId,
        operation: proposal?.operation ?? 'create_rule',
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
   * Build a replay result from a previously completed idempotency record.
   */
  private replayResult(
    idem: IdempotencyRecord,
    input: ExecuteRuleInput,
  ): ExecuteRuleResult {
    let ruleId: string | null = null;
    try {
      const effect = JSON.parse(idem.serialisedEffect);
      ruleId = effect.ruleId ?? effect.ruleName ?? null;
    } catch {
      // Ignore parse failures
    }

    return {
      success: idem.completed && !idem.errorMessage,
      ruleId,
      verified: !idem.errorMessage,
      idempotencyKey: input.idempotencyKey,
      approvalId: null,
      auditRecordId: null,
      reasonCodes: ['idempotency_replay'],
      message: idem.errorMessage ?? undefined,
    };
  }
}
