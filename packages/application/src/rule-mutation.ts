/**
 * Executes governed rule proposals through atomic approval acquisition, fresh
 * native planning, Actual writes, and postcondition verification.
 */

import { createRequire } from 'node:module';
import {
  canonicalProposalJson,
  deriveActualRuleCategoryGroupReferences,
  GENERIC_MUTATION_POLICY_VERSION,
  ProposalAcquisitionError,
} from '@balanceframe/workflow-store';
import type {
  WorkflowStore,
  ActionProposal,
  IdempotencyRecord,
  AuditRecord,
  AuthorizationDisposition,
  ProposalExecutionAcquisition,
  OperationalAuth,
  RuleOverride,
  RuleOverrideScope,
} from '@balanceframe/workflow-store';

import type {
  BudgetLedger,
  MutationResult,
  LedgerSnapshotResult,
  RuleProposal,
} from '@balanceframe/actual-adapter';

import type {
  AutomationRule,
  RuleDeletePrecondition,
} from '@balanceframe/actual-adapter';
import { z } from 'zod';
import type { ProtocolSnapshot } from '@balanceframe/protocol-generated';

import type { VerificationResult } from './mutation.js';

// ---------------------------------------------------------------------------
// Rule proposal input / plan types
// ---------------------------------------------------------------------------

/** Input to plan the one supported Actual categorization-rule form. */
export interface RuleProposalInput {
  name: string;
  conditions: unknown[];
  actions: unknown[];
  budgetId: string;
  stage?: 'pre' | 'post' | null;
  conditionsOp?: 'and' | 'or';
}

export interface RuleMutationCondition {
  field: string;
  operation: string;
  value: string;
}

/** Exact CreateRulePlan JSON produced by the compiled native binding. */
export interface RuleMutationPlan {
  planId: string;
  ruleName: string;
  trigger: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  hash: string;
  conditions: RuleMutationCondition[];
}

const ruleMutationPlanSchema = z
  .object({
    planId: z.string().min(1),
    ruleName: z.string(),
    trigger: z.record(z.unknown()),
    actions: z.array(z.record(z.unknown())),
    hash: z.string().min(1),
    conditions: z
      .array(
        z
          .object({
            field: z.string(),
            operation: z.string(),
            value: z.string(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

function rulePlanIntent(plan: RuleMutationPlan): Omit<RuleMutationPlan, 'planId'> {
  return {
    ruleName: plan.ruleName,
    trigger: plan.trigger,
    actions: plan.actions,
    hash: plan.hash,
    conditions: plan.conditions,
  };
}

const ruleSimulationResultSchema = z
  .object({
    ruleId: z.string(),
    name: z.string(),
    transactionsMatched: z.number().int().nonnegative(),
    transactionsAffected: z.array(z.string()),
    categoryDistribution: z.record(z.number().int().nonnegative()),
    conflicts: z.array(z.string()),
    examples: z.array(
      z
        .object({
          txId: z.string(),
          payee: z.string().nullable(),
          amount: z.object({ minorUnits: z.string(), currency: z.string() }).strict(),
          currentCategory: z.string().nullable(),
          wouldChange: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

const verificationResultSchema = z
  .object({
    verified: z.boolean(),
    reasonCodes: z.array(z.string()),
    message: z.string().nullable(),
  })
  .strict();

interface RuleLifecycleSnapshot extends AutomationRule {
  stage: 'pre' | 'post' | null;
  conditionsOp: 'and' | 'or';
}

const ruleLifecycleSnapshotSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    order: z.number().int().nonnegative(),
    trigger: z.array(z.unknown()),
    actions: z.array(z.unknown()),
    inactive: z.boolean(),
    stage: z.enum(['pre', 'post']).nullable(),
    conditionsOp: z.enum(['and', 'or']),
  })
  .strict();

const ruleOverrideStateSchema = z
  .object({
    ruleId: z.string().min(1),
    inactive: z.boolean().nullable(),
    version: z.number().int().nonnegative(),
  })
  .strict();

const ruleLifecyclePreconditionsSchema = z
  .object({
    rule: ruleLifecycleSnapshotSchema,
    override: ruleOverrideStateSchema.nullable(),
    actualVersion: z.string().min(1),
    categoryGroupMembers: z.record(z.array(z.string())).optional(),
  })
  .strict();

type RuleLifecyclePreconditions = z.infer<typeof ruleLifecyclePreconditionsSchema>;

function toRuleLifecycleSnapshot(rule: AutomationRule): RuleLifecycleSnapshot {
  return {
    id: rule.id,
    name: rule.name,
    order: rule.order,
    trigger: rule.trigger,
    actions: rule.actions,
    inactive: rule.inactive,
    stage: rule.stage,
    conditionsOp: rule.conditionsOp,
  };
}

function assertCategoryGroupBaseline(
  groups: readonly string[],
  captured: Readonly<Record<string, readonly string[]>> | undefined,
  current: Readonly<Record<string, readonly string[]>>,
): void {
  const capturedGroupIds = captured ? Object.keys(captured).sort() : [];
  if (canonicalProposalJson(capturedGroupIds) !== canonicalProposalJson(groups))
    throw new Error('Category-group preconditions do not match the displayed rule');

  for (const groupId of groups) {
    const expected = captured?.[groupId];
    const observed = current[groupId];
    if (!expected || !observed)
      throw new Error(`Current category-group membership is unavailable: ${groupId}`);
    const expectedSorted = [...expected].sort();
    const observedSorted = [...observed].sort();
    if (
      canonicalProposalJson(expected) !== canonicalProposalJson(expectedSorted) ||
      new Set(expected).size !== expected.length ||
      canonicalProposalJson(expected) !== canonicalProposalJson(observedSorted)
    )
      throw new Error(`Category-group membership changed: ${groupId}`);
  }
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
  planCreateRule(input: RuleProposalInput, snapshot: ProtocolSnapshot): RuleMutationPlan;
  simulateCreateRulePlan(plan: RuleMutationPlan, snapshot: ProtocolSnapshot): RuleSimulationResult;
  verifyRuleMutation(plan: RuleMutationPlan, snapshot: ProtocolSnapshot): VerificationResult;
}

// Native implementation (calls @balanceframe/native N-API bindings at runtime)
// The native addon is not available in all environments (CI, test runners).
// We use runtime dynamic import so callers provide their own resolution.

// @balanceframe/native is a napi-rs addon built from crates/node-binding.
// The NativeBindings interface provides the type contract locally.
// We avoid a static import because the package does not ship standard
// TypeScript declarations — load the binary at runtime via createRequire.

interface NativeBindings {
  planCreateRule(input: string): string;
  simulateCreateRulePlan(input: string): string;
  verifyRuleMutation(input: string): string;
}

let nativeBin: NativeBindings | null = null;

async function getNative(): Promise<NativeBindings> {
  if (!nativeBin) {
    const require = createRequire(import.meta.url);
    nativeBin = require('@balanceframe/native') as NativeBindings;
  }
  return nativeBin;
}

const supportedConditionSchema = z
  .object({
    field: z.literal('payee_name'),
    op: z.literal('is'),
    value: z.string().min(1).refine((value) => value.trim() === value),
  })
  .passthrough();

const supportedActionSchema = z
  .object({
    type: z.literal('set-category'),
    field: z.literal('category'),
    value: z.string().min(1).refine((value) => value.trim() === value),
  })
  .passthrough();

function supportedRuleTerms(input: RuleProposalInput) {
  if (input.conditions.length !== 1 || input.actions.length !== 1)
    throw new Error('Native rule planning supports one merchant condition and one category action');
  return {
    condition: supportedConditionSchema.parse(input.conditions[0]),
    action: supportedActionSchema.parse(input.actions[0]),
  };
}

function parseNativeResult<T extends z.ZodTypeAny>(json: string, schema: T): z.infer<T> {
  const result: unknown = JSON.parse(json);
  return schema.parse(result);
}

function assertPlanMatchesApprovedTerms(
  plan: RuleMutationPlan,
  ruleName: string,
  condition: z.infer<typeof supportedConditionSchema>,
  action: z.infer<typeof supportedActionSchema>,
): void {
  const planCondition = plan.conditions[0];
  const planAction = plan.actions[0];
  if (
    plan.conditions.length !== 1 ||
    !planCondition ||
    plan.ruleName !== ruleName ||
    planCondition.field !== 'payee' ||
    planCondition.operation !== condition.op ||
    planCondition.value !== condition.value ||
    plan.trigger.type !== 'payee_is' ||
    plan.trigger.value !== condition.value.trim().toLowerCase() ||
    plan.actions.length !== 1 ||
    !planAction ||
    planAction.type !== 'set_category' ||
    planAction.value !== action.value
  )
    throw new Error('Native rule plan does not preserve the approved condition and action');
}

/**
 * Create a RustRuleMutationProtocol backed by the compiled native addon.
 * Load the optional N-API binary only when the protocol is requested.
 */
export async function createNativeRuleMutationProtocol(): Promise<RustRuleMutationProtocol> {
  const native = await getNative();
  return {
    planCreateRule(input, snapshot) {
      const { condition, action } = supportedRuleTerms(input);
      const plan = parseNativeResult(
        native.planCreateRule(
          JSON.stringify({
            ruleName: input.name,
            payeeName: condition.value,
            categoryId: action.value,
            snapshot,
          }),
        ),
        ruleMutationPlanSchema,
      );
      assertPlanMatchesApprovedTerms(plan, input.name, condition, action);
      return plan;
    },
    simulateCreateRulePlan(plan, snapshot) {
      return parseNativeResult(
        native.simulateCreateRulePlan(JSON.stringify({ plan, snapshot })),
        ruleSimulationResultSchema,
      );
    },
    verifyRuleMutation(plan, snapshot) {
      return parseNativeResult(
        native.verifyRuleMutation(JSON.stringify({ plan, snapshot })),
        verificationResultSchema,
      );
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
  /** Optional selected approval hint; the store checks the full threshold. */
  approvalId?: string;
  /** Actor performing the execution. */
  actorId: string;
  /** Trusted server-supplied operational identity. */
  auth: OperationalAuth;
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
 * Flow: load proposal -> acquire its current approval-bound write intent ->
 * synchronize -> plan/simulate -> write -> verify -> audit.
 */
export class RuleMutationService {
  constructor(
    private readonly store: WorkflowStore,
    private readonly ledger: BudgetLedger | null,
    private readonly rust: RustRuleMutationProtocol | null,
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
    const executionDependencies =
      this.ledger && this.rust ? { ledger: this.ledger, rust: this.rust } : null;
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

    if (
      proposal.operation !== 'create_rule' &&
      proposal.operation !== 'update_rule' &&
      proposal.operation !== 'delete_rule'
    )
      return this.fail(baseResult, 'unsupported_operation', 'Unsupported proposal operation', input);

    if (proposal.policyVersion !== GENERIC_MUTATION_POLICY_VERSION) {
      await this.appendFailureAudit(input, proposal, null, 'policy_version_mismatch');
      return this.fail(
        baseResult,
        'policy_version_mismatch',
        'Generic mutation algorithm version changed',
        input,
      );
    }

    const composite = proposal.payload.composite;
    if (
      composite &&
      (composite.operations.length > 0 ||
        composite.reallocations.length > 0 ||
        composite.transferRecommendations.length > 0 ||
        composite.ledgerProjections.length > 0)
    )
      return this.fail(baseResult, 'unsupported_composite', 'Mutation cannot apply composite proposal operations', input);

    let serialisedEffect: string;
    try {
      serialisedEffect = JSON.stringify({
        operation: proposal.operation,
        payload: proposal.payload,
        preconditions: JSON.parse(proposal.preconditions) as unknown,
      });
    } catch {
      return this.fail(baseResult, 'payload_hash_mismatch', 'Proposal envelope is invalid', input);
    }

    if (!proposal.spaceId || !proposal.governancePolicyVersion)
      return this.fail(baseResult, 'authorization_denied', 'Governed proposal provenance unavailable', input);

    if (!executionDependencies) {
      let existing: IdempotencyRecord | null;
      try {
        existing = await this.store.getIdempotencyRecord(input.idempotencyKey);
      } catch {
        return this.fail(
          baseResult,
          'idempotency_lookup_failed',
          'Prior rule execution could not be verified',
          input,
        );
      }
      if (
        !existing ||
        !existing.completed ||
        (existing.status !== 'succeeded' && existing.status !== 'terminal_failed')
      )
        return this.fail(
          baseResult,
          'dependencies_unavailable',
          'Actual rule execution dependencies are unavailable',
          input,
        );
    }
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
      if (acquisition.claim.record.status !== 'in_progress')
        return this.replayResult(acquisition.claim.record, input, proposal);
      return this.fail(
        baseResult,
        'idempotency_in_progress',
        'Execution with this idempotency key is already in progress',
        input,
      );
    }

    if (!executionDependencies) {
      await this.store.completeIdempotencyRecord(
        input.idempotencyKey,
        'Rule execution dependencies are unavailable',
        false,
      );
      return this.fail(
        baseResult,
        'dependencies_unavailable',
        'Actual rule execution dependencies are unavailable',
        input,
      );
    }
    const { ledger, rust } = executionDependencies;
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
    // 7. Latest snapshot via ledger.synchronize()
    // =====================================================================

    let snapshotResult: LedgerSnapshotResult;
    try {
      snapshotResult = await ledger.synchronize();
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

    if (proposal.operation === 'update_rule' || proposal.operation === 'delete_rule') {
      return this.executeRuleLifecycle(
        input,
        proposal,
        snapshotResult,
        baseResult,
        consumedApprovalId,
        auditStarted,
        authorizationDisposition,
        ledger,
      );
    }

    // =====================================================================
    // 9. Plan via Rust planCreateRule (planning step 8 logically follows
    //    snapshot, but precondition check happens before write)
    // =====================================================================

    let ruleInput: RuleProposalInput;
    let approvedActualVersion: string;
    let approvedNativePlan: RuleMutationPlan;
    try {
      ruleInput = this.extractRuleInput(proposal);
      const preconditions = JSON.parse(proposal.preconditions) as Record<string, unknown>;
      approvedActualVersion = ruleLifecyclePreconditionsSchema.shape.actualVersion.parse(preconditions.actualVersion);
      approvedNativePlan = ruleMutationPlanSchema.parse(preconditions.nativePlan);
      const approvedNativePayloadHash = proposal.payload.composite?.nativePayloadHash;
      if (typeof approvedNativePayloadHash !== 'string' || approvedNativePayloadHash !== approvedNativePlan.hash)
        throw new Error('Native rule payload hash does not match its captured plan');
      const approvedRule = z.record(z.unknown()).parse(preconditions.nativeRule);
      if (canonicalProposalJson(approvedRule) !== canonicalProposalJson(proposal.payload.rule))
        throw new Error('Native rule facts do not match the executable rule payload');
    } catch (e) {
      await this.recordFailure(input, e);
      await this.appendFailureAudit(
        input,
        proposal,
        authorizationDisposition,
        e instanceof Error ? e.message : 'invalid_preconditions',
      );
      return this.fail(
        baseResult,
        'invalid_preconditions',
        e instanceof Error ? e.message : 'Proposal preconditions are invalid',
        input,
      );
    }
    if (approvedActualVersion !== snapshot.actualVersion) {
      await this.recordFailure(input, new Error('Displayed Actual version is stale'));
      await this.appendFailureAudit(input, proposal, authorizationDisposition, 'precondition_mismatch');
      return this.fail(baseResult, 'precondition_mismatch', 'Displayed Actual version is stale', input);
    }

    let plan: RuleMutationPlan;
    try {
      plan = rust.planCreateRule(ruleInput, snapshot);
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
        err instanceof Error ? err.message : 'Rule mutation planning failed',
        input,
      );
    }

    let writeProposal: RuleProposal;
    try {
      if (
        canonicalProposalJson(rulePlanIntent(plan)) !==
        canonicalProposalJson(rulePlanIntent(approvedNativePlan))
      )
        throw new Error('Native rule plan differs from the captured approved intent');
      writeProposal = this.buildRuleProposal(ruleInput, plan);
    } catch (error) {
      await this.recordFailure(input, error);
      await this.appendFailureAudit(
        input,
        proposal,
        authorizationDisposition,
        error instanceof Error ? error.message : 'plan_mismatch',
      );
      return this.fail(
        baseResult,
        'plan_mismatch',
        error instanceof Error ? error.message : 'Native rule plan changed the approved terms',
        input,
      );
    }
    // =====================================================================
    // 11. Simulate the planned rule — must produce evidence, no conflicts
    // =====================================================================

    let simulation: RuleSimulationResult;
    try {
      simulation = rust.simulateCreateRulePlan(plan, snapshot);
    } catch (err) {
      await this.recordFailure(input, err);
      await this.appendFailureAudit(
        input,
        proposal,
        authorizationDisposition,
        err instanceof Error ? err.message : 'simulation_failed',
      );
      return this.fail(
        baseResult,
        'simulation_failed',
        err instanceof Error ? err.message : 'Rule simulation failed',
        input,
      );
    }

    // Proposals cannot execute without simulation evidence
    if (simulation.transactionsMatched === 0) {
      baseResult.simulation = simulation;
      await this.recordFailure(input, new Error('Rule would match zero transactions'));
      await this.appendFailureAudit(input, proposal, authorizationDisposition, 'simulation_no_matches');
      return this.fail(
        baseResult,
        'simulation_no_matches',
        'Rule simulation matched zero transactions — no evidence for execution',
        input,
      );
    }

    // Surface conflicts from overlapping rules
    if (simulation.conflicts.length > 0) {
      baseResult.simulation = simulation;
      await this.recordFailure(input, new Error('Simulation revealed conflicts'));
      await this.appendFailureAudit(input, proposal, authorizationDisposition, 'simulation_conflicts');
      return this.fail(
        baseResult,
        'simulation_conflicts',
        `Rule simulation revealed conflicts: ${simulation.conflicts.join('; ')}`,
        input,
      );
    }

    // =====================================================================
    // 12. Write via ledger.createRule
    // =====================================================================

    let writeResult: MutationResult;
    try {
      writeResult = await ledger.createRule(writeProposal);
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

    const ruleId = writeResult.id;

    // =====================================================================
    // 12. Reread via fresh synchronize + Rust verifyRuleMutation
    // =====================================================================

    let rereadSnapshot: ProtocolSnapshot;
    try {
      const rereadResult = await ledger.synchronize();
      rereadSnapshot = rereadResult.snapshot;
    } catch (err) {
      // Write happened but we can't verify
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
      const createdRules = rereadSnapshot.rules.filter((rule) => rule.id === ruleId);
      const verification = rust.verifyRuleMutation(plan, {
        ...rereadSnapshot,
        rules: createdRules.length === 1 ? createdRules : [],
      });
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
    // Acquired approvals remain consumed on every failure. Post-write failures
    // are terminal because the external write may already have happened.
    // =====================================================================

    if (!verified) {
      const errMsg = verifyMessage ?? 'Postcondition verification failed';
      try {
        // Terminal — external write may have occurred; do not retry
        await this.store.completeIdempotencyRecord(input.idempotencyKey, errMsg, false);
      } catch {
        // Non-fatal
      }
    } else {
      try {
        await this.store.completeIdempotencyRecord(
          input.idempotencyKey, null, false, JSON.stringify({ verified: true, ruleId }),
        );
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
        authorizationDisposition,
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

    return {
      success: verified,
      ruleId,
      verified,
      idempotencyKey: input.idempotencyKey,
      approvalId: consumedApprovalId,
      auditRecordId: auditCompleted?.id ?? auditStarted?.id ?? null,
      reasonCodes: allReasonCodes,
      message: verified ? undefined : (verifyMessage ?? 'Postcondition verification failed'),
      simulation,
    };
  }

  private async executeRuleLifecycle(
    input: ExecuteRuleInput,
    proposal: Extract<ActionProposal, { operation: 'update_rule' | 'delete_rule' }>,
    snapshotResult: LedgerSnapshotResult,
    baseResult: ExecuteRuleResult,
    consumedApprovalId: string | null,
    auditStarted: AuditRecord,
    authorizationDisposition: AuthorizationDisposition,
    ledger: BudgetLedger,
  ): Promise<ExecuteRuleResult> {
    const terminalFailure = async (code: string, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailure(input, new Error(message));
      await this.appendFailureAudit(input, proposal, authorizationDisposition, message);
      return this.fail(baseResult, code, message, input);
    };
    if (!proposal.spaceId)
      return terminalFailure('authorization_denied', new Error('Governed space unavailable'));


    let preconditions: RuleLifecyclePreconditions;
    try {
      const parsed: unknown = JSON.parse(proposal.preconditions);
      preconditions = ruleLifecyclePreconditionsSchema.parse(parsed);
      if (
        preconditions.rule.id !== proposal.payload.ruleId ||
        (preconditions.override && preconditions.override.ruleId !== proposal.payload.ruleId)
      )
        throw new Error('Rule preconditions identify a different rule');
    } catch (error) {
      return terminalFailure('invalid_preconditions', error);
    }

    const scope: RuleOverrideScope = {
      spaceId: proposal.spaceId,
      budgetId: proposal.budgetId,
    };
    let actualRule: RuleLifecycleSnapshot;
    let currentOverride: RuleOverride | null;
    try {
      if (
        !scope.spaceId.trim() ||
        !scope.budgetId.trim() ||
        snapshotResult.snapshot.actualVersion !== preconditions.actualVersion
      )
        throw new Error('Displayed Actual version is stale');

      const currentRule = (await ledger.listRules()).find(
        (rule) => rule.id === proposal.payload.ruleId,
      );
      if (!currentRule)
        throw new Error('Displayed Actual rule is no longer present');
      actualRule = ruleLifecycleSnapshotSchema.parse(toRuleLifecycleSnapshot(currentRule));
      if (canonicalProposalJson(actualRule) !== canonicalProposalJson(preconditions.rule))
        throw new Error('Displayed Actual rule has changed');

      currentOverride = await this.store.getRuleOverride({
        ...scope,
        ruleId: proposal.payload.ruleId,
      });
      if (canonicalProposalJson(currentOverride) !== canonicalProposalJson(preconditions.override))
        throw new Error('Displayed BalanceFrame rule state has changed');

      const groupIds = deriveActualRuleCategoryGroupReferences(preconditions.rule.trigger);
      const categoryGroupMembers = groupIds.length
        ? await ledger.getRuleCategoryGroupMembers()
        : {};
      assertCategoryGroupBaseline(
        groupIds,
        preconditions.categoryGroupMembers,
        categoryGroupMembers,
      );
    } catch (error) {
      return terminalFailure('precondition_mismatch', error);
    }

    if (proposal.operation === 'update_rule') {
      let writtenOverride: RuleOverride;
      try {
        writtenOverride = await this.store.setRuleOverride({
          ...scope,
          ruleId: proposal.payload.ruleId,
          inactive: proposal.payload.inactive,
          expectedVersion: currentOverride?.version ?? null,
        });
        const expectedOverride: RuleOverride = {
          ruleId: proposal.payload.ruleId,
          inactive: proposal.payload.inactive,
          version: (currentOverride?.version ?? 0) + 1,
        };
        if (canonicalProposalJson(writtenOverride) !== canonicalProposalJson(expectedOverride))
          throw new Error('BalanceFrame rule state write did not match the approved change');

        const observedOverride = await this.store.getRuleOverride({
          ...scope,
          ruleId: proposal.payload.ruleId,
        });
        if (canonicalProposalJson(observedOverride) !== canonicalProposalJson(expectedOverride))
          throw new Error('BalanceFrame rule state could not be verified');
      } catch (error) {
        return terminalFailure('rule_override_failed', error);
      }
    } else {
      try {
        const deletePrecondition: RuleDeletePrecondition = {
          rule: actualRule,
          actualVersion: preconditions.actualVersion,
        };
        await ledger.deleteRule(proposal.payload.ruleId, deletePrecondition);
        await ledger.synchronize();
        const remainingRules = await ledger.listRules();
        if (remainingRules.some((rule) => rule.id === proposal.payload.ruleId))
          throw new Error('Deleted Actual rule is still present after synchronization');
        if (currentOverride && currentOverride.inactive !== null) {
          await this.store.removeRuleOverride({
            ...scope,
            ruleId: proposal.payload.ruleId,
            expectedVersion: currentOverride.version,
          });
        }
      } catch (error) {
        return terminalFailure('rule_delete_failed', error);
      }
    }

    try {
      await this.store.completeIdempotencyRecord(
        input.idempotencyKey, null, false,
        JSON.stringify({ verified: true, ruleId: proposal.payload.ruleId }),
      );
    } catch {
      // The Actual/local postcondition is already verified; the audit remains authoritative.
    }

    const ruleId = proposal.payload.ruleId;
    const observedResultState = canonicalProposalJson({
      ruleId,
      ...(proposal.operation === 'update_rule'
        ? { inactive: proposal.payload.inactive }
        : { deleted: true }),
    });
    let auditCompleted: AuditRecord | null = null;
    try {
      auditCompleted = await this.store.appendAuditRecord({
        classification: 'execution_completed',
        actorId: input.actorId,
        operation: proposal.operation,
        proposalId: input.proposalId,
        payloadHash: proposal.payloadHash,
        budgetId: proposal.budgetId,
        backendIds: proposal.operation === 'delete_rule' ? ruleId : '',
        policyVersion: proposal.policyVersion,
        authorizationDisposition,
        idempotencyKey: input.idempotencyKey,
        expectedPriorState: proposal.preconditions,
        observedResultState,
        providerModel: proposal.providerModel ?? undefined,
        correlationId: input.correlationId ?? null,
        requestId: input.requestId,
        result: 'completed',
        isError: false,
      });
    } catch {
      // Non-fatal
    }

    return {
      ...baseResult,
      success: true,
      ruleId,
      verified: true,
      approvalId: consumedApprovalId,
      auditRecordId: auditCompleted?.id ?? auditStarted.id,
    };
  }

  private ruleData(proposal: ActionProposal): Record<string, unknown> {
    if (proposal.operation !== 'create_rule')
      throw new Error('Unsupported proposal operation');
    return proposal.payload.rule;
  }

  private extractRuleInput(proposal: ActionProposal): RuleProposalInput {
    const rule = this.ruleData(proposal);
    const name = rule.name;
    if (typeof name !== 'string' || !name.trim() || name !== name.trim())
      throw new Error('Rule name must be non-empty and normalized');
    if (!Array.isArray(rule.conditions) || !Array.isArray(rule.actions))
      throw new Error('Rule conditions and actions must be arrays');

    const stage = z.enum(['pre', 'post']).nullable().optional().parse(rule.stage);
    const conditionsOp = z.enum(['and', 'or']).optional().parse(rule.conditionsOp);
    const terms = supportedRuleTerms({
      name,
      conditions: rule.conditions,
      actions: rule.actions,
      budgetId: proposal.budgetId,
    });
    return {
      name,
      conditions: [terms.condition],
      actions: [terms.action],
      budgetId: proposal.budgetId,
      ...(stage === undefined ? {} : { stage }),
      ...(conditionsOp === undefined ? {} : { conditionsOp }),
    };
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
    input: ExecuteRuleInput,
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
   * Append an execution_failed audit record for early rejections (best-effort).
   */
  private async appendFailureAudit(
    input: ExecuteRuleInput,
    proposal: ActionProposal | null,
    authorizationDisposition: AuthorizationDisposition | null,
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

  private replayResult(
    idem: IdempotencyRecord,
    input: ExecuteRuleInput,
    proposal: ActionProposal,
  ): ExecuteRuleResult {
    let ruleId: string | null = null;
    if (idem.status === 'succeeded') {
      try {
        const parsed = z.object({
          verified: z.literal(true),
          ruleId: z.string().min(1),
        }).strict().safeParse(JSON.parse(idem.serialisedResult ?? 'null') as unknown);
        if (
          parsed.success &&
          (proposal.operation === 'create_rule' ||
            ((proposal.operation === 'update_rule' || proposal.operation === 'delete_rule') &&
              parsed.data.ruleId === proposal.payload.ruleId))
        )
          ruleId = parsed.data.ruleId;
      } catch {
        // An absent or invalid durable result cannot prove an external write.
      }
    }
    const succeeded = ruleId !== null;
    return {
      success: succeeded,
      ruleId,
      verified: succeeded,
      idempotencyKey: input.idempotencyKey,
      approvalId: null,
      auditRecordId: null,
      reasonCodes: [idem.status === 'succeeded' && !succeeded
        ? 'idempotency_result_mismatch' : 'idempotency_replay'],
      message: idem.errorMessage ?? undefined,
      simulation: null,
    };
  }

  private buildRuleProposal(input: RuleProposalInput, plan: RuleMutationPlan): RuleProposal {
    const { condition, action } = supportedRuleTerms(input);
    assertPlanMatchesApprovedTerms(plan, input.name, condition, action);
    return {
      name: plan.ruleName,
      ...(input.stage === undefined ? {} : { stage: input.stage }),
      ...(input.conditionsOp === undefined ? {} : { conditionsOp: input.conditionsOp }),
      conditions: [{ field: condition.field, op: condition.op, value: condition.value }],
      actions: [{ op: 'set', field: 'category', value: action.value }],
    };
  }
}
