/** Contract tests for rule proposal acquisition, native planning, and verified writes. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';

// ---------------------------------------------------------------------------
// Import service under test
// ---------------------------------------------------------------------------
import {
  RuleMutationService,
  createNativeRuleMutationProtocol,
  requireCompleteRulePlanningSource,
  type ExecuteRuleInput,
  type ExecuteRuleResult,
  type RuleMutationPlan,
  type RuleSimulationResult,
  type RuleReviewContext,
  type ResolveCurrentRuleReviewContext,
} from '../src/rule-mutation';
import {
  SqliteWorkflowStore,
  canonicalProposalHash,
  canonicalProposalJson,
  deriveProposalAuthorizationFacts,
  GENERIC_MUTATION_POLICY_VERSION,
  ProposalAcquisitionError,
} from '@balanceframe/workflow-store';
import { ActualConnector } from '../../actual-adapter/src/connector';
import { NullCredentialStore } from '../../actual-adapter/src/credentials';
import type { ActualClient } from '../../actual-adapter/src/connector';
vi.mock('@balanceframe/workflow-store', async () =>
  await import('../../workflow-store/src/index'));
import type {
  ActionProposal,
  CreateProposalInput,
  GovernanceResourceRef,
  HumanControlContext,
  ProposalApproval,
  IdempotencyRecord,
  RuleOverride,
  WorkflowStore,
  AuditRecord,
} from '@balanceframe/workflow-store';

import type { BudgetLedger, MutationResult, LedgerSnapshotResult, RuleCreatePrecondition, RuleProposal } from '@balanceframe/actual-adapter';

import type { ProtocolSnapshot, Rule } from '@balanceframe/protocol-generated';


// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_ACTOR = 'usr_rule_mutator';
const TEST_REQUEST = 'req_rule_exec_001';
const TEST_PROPOSAL_ID = 'prop_rule_001';
const TEST_APPROVAL_ID = 'appr_rule_001';
const TEST_RULE_NAME = 'Auto-categorize groceries';
const TEST_NONCE = 'idem_nonce_rule_001';
const TEST_BUDGET_ID = 'budget_main';
const TEST_PLAN_ID = 'plan_rule_a1b2c3';
const TEST_RULE_ID = 'rule_abc123';
interface RuleSnapshotFixture {
  id: string;
  name: string;
  order: number;
  trigger: unknown;
  actions: unknown;
  inactive: boolean;
  stage: 'pre' | 'post' | null;
  conditionsOp: 'and' | 'or';
}
const TEST_RULE_BEFORE = {
  id: TEST_RULE_ID,
  name: TEST_RULE_NAME,
  order: 7,
  trigger: [
    { field: 'account', op: 'is', value: 'acct-rule-before' },
    { field: 'category', op: 'is', value: 'cat-rule-before' },
  ],
  actions: [{ op: 'set', field: 'category', value: 'cat-rule-after' }],
  inactive: false,
  stage: 'pre' as const,
  conditionsOp: 'or' as const,
};
const TEST_RULE_SCOPE = { spaceId: 'space_main', budgetId: TEST_BUDGET_ID };
const TEST_RULE_ACTUAL_VERSION = 'actual-rule-v1';
const TEST_REVIEW_CONTEXT: RuleReviewContext = {
  scope: { ...TEST_RULE_SCOPE, connectionId: 'connection-rule-current' },
  sourceFactsHash: 'rule-source-facts-v1',
  evidenceKey: null,
  evidenceRevision: 'merchant-evidence-v1',
  merchantPolicyVersion: 'merchant-policy-v1',
  visibilityHash: 'executor-visibility-v1',
  expiresAt: '2099-12-31T23:59:59Z',
};
// Independently admitted current facts, not a replay of the reviewed body.
const TEST_CURRENT_CONTEXT: RuleReviewContext = {
  scope: { spaceId: 'space_main', budgetId: TEST_BUDGET_ID, connectionId: 'connection-rule-current' },
  sourceFactsHash: 'rule-source-facts-v1',
  evidenceKey: null,
  evidenceRevision: 'merchant-evidence-v1',
  merchantPolicyVersion: 'merchant-policy-v1',
  visibilityHash: 'executor-visibility-v1',
  expiresAt: '2099-12-31T23:59:59Z',
};
const resolveTrustedCurrentContext: ResolveCurrentRuleReviewContext = async () => structuredClone(TEST_CURRENT_CONTEXT);
const unavailableCurrentContext: ResolveCurrentRuleReviewContext = async () => {
  throw new Error('Current Actual source and authority are unavailable');
};
const TEST_RULE = {
  stage: 'post' as const,
  conditionsOp: 'and' as const,
  conditions: [{ field: 'payee' as const, op: 'is' as const, value: 'payee_groceries' }],
  actions: [{ op: 'set' as const, field: 'category' as const, value: 'cat_groceries' }],
};
const TEST_NATIVE_PLAN: RuleMutationPlan = {
  planId: TEST_PLAN_ID,
  ruleName: TEST_RULE_NAME,
  trigger: { stage: TEST_RULE.stage, conditionsOp: TEST_RULE.conditionsOp, conditions: TEST_RULE.conditions },
  actions: TEST_RULE.actions,
  hash: 'native-rule-plan-hash',
  conditions: [{ field: 'payee', operation: 'is', value: 'payee_groceries' }],
};
const TEST_RULE_PAYLOAD = {
  kind: 'create_rule' as const,
  transactionId: null,
  categoryId: 'cat_groceries',
  rule: TEST_RULE,
  composite: {
    operations: [],
    reallocations: [],
    transferRecommendations: [],
    ledgerProjections: [],
    evidenceReferences: [],
    nativePayloadHash: TEST_NATIVE_PLAN.hash,
  },
};
const TEST_RULE_PRECONDITIONS = {
  actualVersion: TEST_RULE_ACTUAL_VERSION,
  merchant: 'Grocery Store',
  source: 'review',
  reviewId: 'review_001',
  nativeRule: TEST_RULE,
  nativePlan: TEST_NATIVE_PLAN,
  ruleName: TEST_RULE_NAME,
  reviewContext: TEST_REVIEW_CONTEXT,
  reviewedSimulation: mockRuleSimulationResult(),
  sourceAccounts: [{ accountId: 'account_rule_source' }],
  sourceTransactions: [
    { transactionId: 'tx_001', accountId: 'account_rule_source', categoryId: null },
    { transactionId: 'tx_002', accountId: 'account_rule_source', categoryId: 'cat_dining' },
    { transactionId: 'tx_003', accountId: 'account_rule_source', categoryId: null },
  ],
};
const TEST_PAYLOAD_HASH = canonicalProposalHash({
  operation: 'create_rule',
  budgetId: TEST_BUDGET_ID,
  payload: TEST_RULE_PAYLOAD,
  preconditions: TEST_RULE_PRECONDITIONS,
  actorId: TEST_ACTOR,
  policyVersion: '1.0',
  expiresAt: '2099-12-31T23:59:59Z',
});


function mockRuleMutationPlan(overrides: Partial<RuleMutationPlan> = {}): RuleMutationPlan {
  return {
    ...TEST_NATIVE_PLAN,
    ...overrides,
  };
}

function mockRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: TEST_RULE_ID,
    name: TEST_RULE_NAME,
    order: 0,
    trigger: { stage: TEST_RULE.stage, conditionsOp: TEST_RULE.conditionsOp, conditions: TEST_RULE.conditions },
    actions: TEST_RULE.actions,
    inactive: false,
    ...overrides,
  };
}

function mockProposal(
  overrides: Partial<Extract<ActionProposal, { operation: 'create_rule' }>> = {},
): Extract<ActionProposal, { operation: 'create_rule' }> {
  const proposal = {
    id: TEST_PROPOSAL_ID,
    version: 1,
    state: {
      phase: 'proposed',
      sourceObserved: false,
      destinationObserved: false,
      reconciled: false,
      outcome: null,
    },
    operation: 'create_rule',
    budgetId: TEST_BUDGET_ID,
    spaceId: 'space_main',
    payload: TEST_RULE_PAYLOAD,
    policyVersion: '1.0',
    governancePolicyVersion: 'space-policy-1',
    requesterMembershipId: 'membership-proposer',
    preconditions: JSON.stringify(TEST_RULE_PRECONDITIONS),
    expiresAt: '2099-12-31T23:59:59Z',
    actorId: TEST_ACTOR,
    provenance: 'manual',
    providerModel: null,
    correlationId: 'corr_rule_001',
    supersededAt: null,
    createdAt: '2026-07-20T10:00:00Z',
    ...overrides,
  } as Extract<ActionProposal, { operation: 'create_rule' }>;
  return {
    ...proposal,
    payloadHash:
      overrides.payloadHash ??
      canonicalProposalHash({
        operation: proposal.operation,
        budgetId: proposal.budgetId,
        payload: proposal.payload,
        preconditions: JSON.parse(proposal.preconditions),
        actorId: proposal.actorId,
        policyVersion: proposal.policyVersion,
        expiresAt: proposal.expiresAt,
      }),
  };
}
function mockUpdateRuleProposal(
  override: RuleOverride | null = null,
  inactive = true,
  rule: RuleSnapshotFixture = TEST_RULE_BEFORE,
  categoryGroupMembers?: Readonly<Record<string, readonly string[]>>,
): Extract<ActionProposal, { operation: 'update_rule' }> {
  const payload = { kind: 'update_rule' as const, ruleId: TEST_RULE_ID, inactive };
  const preconditions = {
    rule,
    override,
    actualVersion: TEST_RULE_ACTUAL_VERSION,
    ...(categoryGroupMembers === undefined ? {} : { categoryGroupMembers }),
  };
  const base = mockProposal();
  return {
    ...base,
    operation: 'update_rule',
    payload,
    preconditions: canonicalProposalJson(preconditions),
    payloadHash: canonicalProposalHash({
      operation: 'update_rule',
      budgetId: TEST_BUDGET_ID,
      payload,
      preconditions,
      actorId: TEST_ACTOR,
      policyVersion: base.policyVersion,
      expiresAt: base.expiresAt,
    }),
  } satisfies Extract<ActionProposal, { operation: 'update_rule' }>;
}

function mockDeleteRuleProposal(
  override: RuleOverride | null = null,
  rule: RuleSnapshotFixture = TEST_RULE_BEFORE,
  categoryGroupMembers?: Readonly<Record<string, readonly string[]>>,
): Extract<ActionProposal, { operation: 'delete_rule' }> {
  const payload = { kind: 'delete_rule' as const, ruleId: TEST_RULE_ID };
  const preconditions = {
    rule,
    override,
    actualVersion: TEST_RULE_ACTUAL_VERSION,
    ...(categoryGroupMembers === undefined ? {} : { categoryGroupMembers }),
  };
  const base = mockProposal();
  return {
    ...base,
    operation: 'delete_rule',
    payload,
    preconditions: canonicalProposalJson(preconditions),
    payloadHash: canonicalProposalHash({
      operation: 'delete_rule',
      budgetId: TEST_BUDGET_ID,
      payload,
      preconditions,
      actorId: TEST_ACTOR,
      policyVersion: base.policyVersion,
      expiresAt: base.expiresAt,
    }),
  } satisfies Extract<ActionProposal, { operation: 'delete_rule' }>;
}

function mockApproval(overrides: Partial<ProposalApproval> = {}): ProposalApproval {
  return {
    id: TEST_APPROVAL_ID,
    proposalId: TEST_PROPOSAL_ID,
    payloadHash: TEST_PAYLOAD_HASH,
    actorId: TEST_ACTOR,
    membershipId: 'membership-approver',
    governancePolicyVersion: 'space-policy-1',
    reauthenticatedSessionId: 'session-approver',
    reauthenticatedAt: '2026-07-20T10:29:00Z',
    status: 'active',
    expiresAt: '2099-12-31T23:59:59Z',
    consumedAt: null,
    supersededAt: null,
    createdAt: '2026-07-20T10:30:00Z',
    ...overrides,
  };
}

function mockIdempotencyRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    idempotencyKey: TEST_NONCE,
    proposalId: TEST_PROPOSAL_ID,
    operation: 'create_rule',
    executedAt: '2026-07-20T11:00:00Z',
    completed: false,
    status: 'in_progress',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    serialisedEffect: JSON.stringify({
      operation: 'create_rule',
      payload: TEST_RULE_PAYLOAD,
      preconditions: TEST_RULE_PRECONDITIONS,
    }),
    serialisedResult: null,
    errorMessage: null,
    updatedAt: '2026-07-20T11:00:00Z',
    ...overrides,
  };
}

function mockExecutionAcquisition() {
  return {
    claim: { record: mockIdempotencyRecord(), isOwner: true },
    approvals: [mockApproval()],
    auditRecord: {
      id: 'audit_started_001',
      classification: 'execution_started',
      authorizationDisposition: { kind: 'authorized_without_approval' },
    } as AuditRecord,
  };
}

const canonicalSourceSnapshot = canonicalProtocolSnapshotSchema.parse(JSON.parse(readFileSync(
  new URL('../../../protocol/fixtures/representative.json', import.meta.url), 'utf8',
)));

function completeRuleSource(accounts: ProtocolSnapshot['accounts']): NonNullable<LedgerSnapshotResult['rulePlanningSourceAvailability']> {
  return {
    accounts: 'complete', payees: 'complete', categories: 'complete', categoryGroups: 'complete', rules: 'complete',
    history: accounts.map(({ id }) => ({ accountId: id, state: 'complete', startDate: '0001-01-01', endDate: '9999-12-31' })),
  };
}

function mockProtocolSnapshot(overrides: Partial<ProtocolSnapshot> = {}): ProtocolSnapshot {
  return {
    schemaVersion: '1.0',
    actualVersion: '2026.07.01',
    snapshotDate: new Date().toISOString(),
    accounts: [{ ...canonicalSourceSnapshot.accounts[0]!, id: 'account_rule_source' }],
    transactions: ['tx_001', 'tx_002', 'tx_003'].map((id, index) => ({
      ...canonicalSourceSnapshot.transactions[0]!,
      id, accountId: 'account_rule_source', payeeId: 'payee_groceries', payeeName: 'Grocery Store',
      amount: { minorUnits: index === 1 ? '1230' : '4500', currency: 'USD' },
      categoryId: index === 1 ? 'cat_dining' : null,
      categoryName: index === 1 ? 'Dining' : null,
    })),
    categories: [
      { ...canonicalSourceSnapshot.categories[0]!, id: 'cat_groceries', name: 'Groceries' },
      { ...canonicalSourceSnapshot.categories[0]!, id: 'cat_dining', name: 'Dining' },
    ],
    payees: [{ id: 'payee_groceries', name: 'Grocery Store', transferAccountId: null, mtid: null }],
    rules: [mockRule()],
    schedules: [],
    budgets: [],
    tags: [],
    ...overrides,
  };
}

function mockMutationResult(overrides: Partial<MutationResult> = {}): MutationResult {
  return {
    success: true,
    id: TEST_RULE_ID,
    ...overrides,
  } as MutationResult;
}

function mockRuleSimulationResult(
  overrides: Partial<RuleSimulationResult> = {},
): RuleSimulationResult {
  return {
    ruleId: '',
    name: TEST_RULE_NAME,
    transactionsMatched: 3,
    transactionsAffected: ['tx_001', 'tx_002', 'tx_003'],
    categoryDistribution: { cat_groceries: 3 },
    conflicts: [],
    examples: [
      {
        txId: 'tx_001',
        payee: 'Grocery Store',
        amount: { minorUnits: '4500', currency: 'USD' },
        currentCategory: null,
        wouldChange: true,
      },
      {
        txId: 'tx_002',
        payee: 'Grocery Store',
        amount: { minorUnits: '1230', currency: 'USD' },
        currentCategory: 'cat_dining',
        wouldChange: true,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Input builder
// ---------------------------------------------------------------------------

function defaultInput(overrides: Partial<ExecuteRuleInput> = {}): ExecuteRuleInput {
  return {
    proposalId: TEST_PROPOSAL_ID,
    approvalId: TEST_APPROVAL_ID,
    auth: { method: 'session', actorId: TEST_ACTOR, sessionId: 'session-executor' },
    actorId: TEST_ACTOR,
    requestId: TEST_REQUEST,
    idempotencyKey: TEST_NONCE,
    correlationId: 'corr_rule_001',
    ...overrides,
  };
}


// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

interface StoreMock extends WorkflowStore {
  getProposal: Mock;
  completeIdempotencyRecord: Mock;
  appendAuditRecord: Mock;
  acquireProposalExecution: Mock;
  validateAcquiredProposalExecution: Mock;
  getRuleOverrides: Mock;
  getRuleOverride: Mock;
  setRuleOverride: Mock;
  removeRuleOverride: Mock;
}

function createStoreMock(): StoreMock {
  return {
    getProposal: vi.fn(),
    acquireProposalExecution: vi.fn(),
    validateAcquiredProposalExecution: vi.fn(),
    completeIdempotencyRecord: vi.fn(),
    appendAuditRecord: vi.fn(),
    getRuleOverrides: vi.fn(),
    getRuleOverride: vi.fn(),
    setRuleOverride: vi.fn(),
    removeRuleOverride: vi.fn(),
  } as StoreMock;
}

interface LedgerMock extends BudgetLedger {
  synchronize: Mock;
  createRule: Mock;
  deleteRule: Mock;
  listRules: Mock;
  getRuleCategoryGroupMembers: Mock;
}

function createLedgerMock(): LedgerMock {
  return {
    synchronize: vi.fn(),
    createRule: vi.fn(),
    deleteRule: vi.fn(),
    listRules: vi.fn(),
    getRuleCategoryGroupMembers: vi.fn(),
  } as LedgerMock;
}

interface RustProtocolMock {
  planCreateRule: Mock;
  simulateCreateRulePlan: Mock;
  verifyRuleMutation: Mock;
}
function createRustMock(): RustProtocolMock {
  return {
    planCreateRule: vi.fn(),
    simulateCreateRulePlan: vi.fn(),
    verifyRuleMutation: vi.fn(),
  };
}

const ruleSourceAccounts: ProtocolSnapshot['accounts'] = [
  { ...canonicalSourceSnapshot.accounts[0]!, id: 'account_rule_source', isClosed: false },
  { ...canonicalSourceSnapshot.accounts[0]!, id: 'account_closed_source', isClosed: true },
];
const completeRulePlanningSource = completeRuleSource(ruleSourceAccounts);
const incompleteRulePlanningSources: Array<{ label: string; availability: unknown }> = [
  { label: 'omitted trusted availability', availability: undefined },
  { label: 'empty metadata', availability: {} },
  ...(['accounts', 'payees', 'categories', 'categoryGroups', 'rules'] as const).flatMap((namespace) => {
    const missing = { ...completeRulePlanningSource };
    delete (missing as Partial<typeof missing>)[namespace];
    return [
      { label: `failed ${namespace} SDK read`, availability: { ...completeRulePlanningSource, [namespace]: 'unavailable' } },
      { label: `missing ${namespace} namespace`, availability: missing },
    ];
  }),
  { label: 'unknown namespace status', availability: { ...completeRulePlanningSource, rules: 'partial' } },
  { label: 'unknown metadata field', availability: { ...completeRulePlanningSource, inferredComplete: true } },
  { label: 'missing full account history', availability: { ...completeRulePlanningSource, history: [] } },
  { label: 'missing closed account history', availability: { ...completeRulePlanningSource, history: completeRulePlanningSource.history.slice(0, 1) } },
  { label: 'failed closed account SDK read', availability: { ...completeRulePlanningSource, history: completeRulePlanningSource.history.map((history) => history.accountId === 'account_closed_source' ? { ...history, state: 'unavailable' } : history) } },
  { label: 'duplicate account history', availability: { ...completeRulePlanningSource, history: [completeRulePlanningSource.history[0], completeRulePlanningSource.history[0]] } },
  { label: 'unrelated account history', availability: { ...completeRulePlanningSource, history: [...completeRulePlanningSource.history, { ...completeRulePlanningSource.history[0], accountId: 'other-account' }] } },
  { label: 'truncated start date', availability: { ...completeRulePlanningSource, history: completeRulePlanningSource.history.map((history) => ({ ...history, startDate: '1970-01-01' })) } },
  { label: 'truncated end date', availability: { ...completeRulePlanningSource, history: completeRulePlanningSource.history.map((history) => ({ ...history, endDate: '2099-12-31' })) } },
  { label: 'unknown history field', availability: { ...completeRulePlanningSource, history: completeRulePlanningSource.history.map((history) => ({ ...history, assumedEmpty: true })) } },
];

describe('requireCompleteRulePlanningSource', () => {
  it('admits explicit complete full-ledger history, including closed accounts', () => {
    expect(() => requireCompleteRulePlanningSource({ accounts: ruleSourceAccounts }, completeRulePlanningSource)).not.toThrow();
  });
  it('admits an explicitly read empty account collection without inventing history', () => {
    expect(() => requireCompleteRulePlanningSource({ accounts: [] }, completeRuleSource([]))).not.toThrow();
  });
  it.each(incompleteRulePlanningSources)('rejects $label', ({ availability }) => {
    expect(() => requireCompleteRulePlanningSource({ accounts: ruleSourceAccounts }, availability))
      .toThrow('Current rule planning source is incomplete');
  });
  it('rejects duplicate snapshot account IDs even with an apparently matching history count', () => {
    const accounts = [ruleSourceAccounts[0]!, ruleSourceAccounts[0]!];
    expect(() => requireCompleteRulePlanningSource({ accounts }, completeRuleSource(accounts)))
      .toThrow('Current rule planning source is incomplete');
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuleMutationService', () => {
  let store: StoreMock;
  let ledger: LedgerMock;
  let rust: RustProtocolMock;
  let service: RuleMutationService;
  let resolveCurrentContext: Mock<ResolveCurrentRuleReviewContext>;

  beforeEach(() => {
    store = createStoreMock();
    ledger = createLedgerMock();
    rust = createRustMock();
    resolveCurrentContext = vi.fn(resolveTrustedCurrentContext);
    service = new RuleMutationService(store, ledger, rust, resolveCurrentContext);
    store.getProposal.mockResolvedValue(mockProposal());
    store.acquireProposalExecution.mockResolvedValue(mockExecutionAcquisition());
    store.completeIdempotencyRecord.mockResolvedValue(
      mockIdempotencyRecord({ completed: true, status: 'succeeded' }),
    );
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_completed_001' } as AuditRecord);
    ledger.synchronize.mockResolvedValueOnce({
      snapshot: mockProtocolSnapshot({ actualVersion: TEST_RULE_ACTUAL_VERSION, rules: [] }),
      rulePlanningSourceAvailability: completeRuleSource(mockProtocolSnapshot().accounts),
    } as LedgerSnapshotResult).mockResolvedValue({
      snapshot: mockProtocolSnapshot({ actualVersion: TEST_RULE_ACTUAL_VERSION }),
      rulePlanningSourceAvailability: completeRuleSource(mockProtocolSnapshot().accounts),
    } as LedgerSnapshotResult);
    ledger.createRule.mockImplementation(async (_proposal: RuleProposal, precondition: RuleCreatePrecondition) => {
      precondition.assertExecutionCurrent();
      return mockMutationResult();
    });
    store.getRuleOverride.mockResolvedValue(null);
    store.setRuleOverride.mockResolvedValue({
      ruleId: TEST_RULE_ID,
      inactive: true,
      version: 1,
    });
    store.removeRuleOverride.mockResolvedValue(undefined);
    ledger.listRules.mockResolvedValue([TEST_RULE_BEFORE]);
    ledger.getRuleCategoryGroupMembers.mockResolvedValue({});
    ledger.deleteRule.mockResolvedValue(undefined);
    rust.planCreateRule.mockReturnValue(mockRuleMutationPlan());
    rust.simulateCreateRulePlan.mockReturnValue(mockRuleSimulationResult());
    rust.verifyRuleMutation.mockReturnValue({ verified: true, reasonCodes: [], message: null });
  });

  it('writes and verifies the stable-ID rule while ignoring the transient native plan ID', async () => {
    rust.planCreateRule.mockReturnValue(mockRuleMutationPlan({ planId: 'new-plan-id' }));
    const result = await service.execute(defaultInput());

    expect(result).toMatchObject({
      success: true,
      verified: true,
      ruleId: TEST_RULE_ID,
      approvalId: TEST_APPROVAL_ID,
      auditRecordId: 'audit_completed_001',
    });
    expect(ledger.createRule).toHaveBeenCalledWith({
      conditions: [{ field: 'payee', op: 'is', value: 'payee_groceries' }],
      actions: [{ op: 'set', field: 'category', value: 'cat_groceries' }],
      conditionsOp: 'and',
      stage: 'post',
    }, { assertExecutionCurrent: expect.any(Function) });
    expect(rust.verifyRuleMutation).toHaveBeenCalled();
    expect(ledger.createRule).toHaveBeenCalledTimes(1);
    expect(resolveCurrentContext).toHaveBeenCalledTimes(2);
    expect(resolveCurrentContext).toHaveBeenCalledWith({
      spaceId: TEST_RULE_SCOPE.spaceId,
      budgetId: TEST_BUDGET_ID,
      evidenceKey: TEST_CURRENT_CONTEXT.evidenceKey,
      actorId: TEST_ACTOR,
      auth: defaultInput().auth,
      snapshot: expect.objectContaining({ actualVersion: TEST_RULE_ACTUAL_VERSION }),
      sourceAvailability: completeRuleSource(mockProtocolSnapshot().accounts),
    });
    expect(rust.planCreateRule).toHaveBeenCalledWith(
      expect.objectContaining({ name: TEST_RULE_NAME, reviewContext: TEST_CURRENT_CONTEXT }),
      expect.any(Object),
    );
  });

  it.each(incompleteRulePlanningSources)(
    'never plans or writes a create-rule from $label even when its trusted resolver accepts the context',
    async ({ availability }) => {
      const snapshot = mockProtocolSnapshot({
        actualVersion: TEST_RULE_ACTUAL_VERSION, rules: [], accounts: ruleSourceAccounts,
      });
      ledger.synchronize.mockReset().mockResolvedValue({
        snapshot, rulePlanningSourceAvailability: availability,
      });
      const result = await service.execute(defaultInput());
      expect(result.success).toBe(false);
      expect(result.message).toContain('Current rule planning source is incomplete');
      expect(resolveCurrentContext).not.toHaveBeenCalled();
      expect(rust.planCreateRule).not.toHaveBeenCalled();
      expect(ledger.createRule).not.toHaveBeenCalled();
      expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(TEST_NONCE, expect.any(String), false);
      expect(store.appendAuditRecord).toHaveBeenCalledWith(expect.objectContaining({
        classification: 'execution_failed', proposalId: TEST_PROPOSAL_ID, isError: true,
      }));
    },
  );

  it('allows a newly admitted current expiry without treating capture clocks as source drift', async () => {
    resolveCurrentContext.mockResolvedValue({ ...TEST_CURRENT_CONTEXT, expiresAt: '2099-11-30T23:59:59Z' });
    const result = await service.execute(defaultInput());
    expect(result).toMatchObject({ success: true, verified: true });
    expect(rust.planCreateRule).toHaveBeenCalledWith(
      expect.objectContaining({ reviewContext: { ...TEST_CURRENT_CONTEXT, expiresAt: '2099-11-30T23:59:59Z' } }),
      expect.any(Object),
    );
  });

  it.each([
    ['sourceFactsHash', 'source-changed'],
    ['evidenceRevision', 'evidence-changed'],
    ['merchantPolicyVersion', 'policy-changed'],
    ['visibilityHash', 'visibility-changed'],
    ['expiresAt', '2000-01-01T00:00:00Z'],
  ] as const)('rejects trusted current %s drift before planning or writing', async (field, value) => {
    resolveCurrentContext.mockResolvedValue({ ...TEST_CURRENT_CONTEXT, [field]: value });
    const result = await service.execute(defaultInput());
    expect(result.reasonCodes).toContain('invalid_preconditions');
    expect(rust.planCreateRule).not.toHaveBeenCalled();
    expect(ledger.createRule).not.toHaveBeenCalled();
    expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(TEST_NONCE, expect.any(String), false);
  });

  it('rejects an expired reviewed context even if trusted current evidence is live', async () => {
    store.getProposal.mockResolvedValue(mockProposal({
      preconditions: JSON.stringify({
        ...TEST_RULE_PRECONDITIONS,
        reviewContext: { ...TEST_REVIEW_CONTEXT, expiresAt: '2000-01-01T00:00:00Z' },
      }),
    }));
    const result = await service.execute(defaultInput());
    expect(result.reasonCodes).toContain('invalid_preconditions');
    expect(resolveCurrentContext).not.toHaveBeenCalled();
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it('rejects trusted authority revoked after simulation before the SDK write', async () => {
    resolveCurrentContext.mockResolvedValueOnce(structuredClone(TEST_CURRENT_CONTEXT))
      .mockRejectedValueOnce(new Error('Current source authorization revoked'));
    const result = await service.execute(defaultInput());
    expect(result.reasonCodes).toContain('write_failed');
    expect(rust.simulateCreateRulePlan).toHaveBeenCalled();
    expect(ledger.createRule).not.toHaveBeenCalled();
    expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(TEST_NONCE, expect.any(String), false);
  });

  it.each([
    { transactionsAffected: ['tx_001', 'tx_002', 'tx_unreviewed'] },
    { transactionsMatched: 4 },
    { categoryDistribution: { cat_groceries: 2, cat_other: 1 } },
    { conflicts: ['existing-rule-unreviewed'] },
    { examples: [{ ...mockRuleSimulationResult().examples[0]!, wouldChange: false }] },
  ] satisfies Partial<RuleSimulationResult>[])('refuses exact reviewed simulation drift despite the same plan hash: %j', async (changed) => {
    rust.simulateCreateRulePlan.mockReturnValue(mockRuleSimulationResult(changed));
    const result = await service.execute(defaultInput());
    expect(result.reasonCodes).toContain('simulation_failed');
    expect(ledger.createRule).not.toHaveBeenCalled();
    expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(TEST_NONCE, expect.any(String), false);
  });

  it('rejects a legacy proposal without its space before acquiring execution or loading Actual', async () => {
    store.getProposal.mockResolvedValue(mockProposal({ spaceId: null }));
    const result = await service.execute(defaultInput());
    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('authorization_denied');
    expect(store.acquireProposalExecution).not.toHaveBeenCalled();
    expect(ledger.synchronize).not.toHaveBeenCalled();
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it.each(['trigger', 'actions'] as const)('rejects a lifecycle baseline missing %s before reading Actual rules', async (field) => {
    const incomplete: Partial<RuleSnapshotFixture> = { ...TEST_RULE_BEFORE };
    delete incomplete[field];
    const proposal = mockUpdateRuleProposal();
    proposal.preconditions = JSON.stringify({
      rule: incomplete, override: null, actualVersion: TEST_RULE_ACTUAL_VERSION,
    });
    store.getProposal.mockResolvedValue(proposal);
    const result = await service.execute(defaultInput());
    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('invalid_preconditions');
    expect(ledger.listRules).not.toHaveBeenCalled();
    expect(store.setRuleOverride).not.toHaveBeenCalled();
    expect(ledger.deleteRule).not.toHaveBeenCalled();
  });

  it('does not verify another matching rule when the returned created ID has different content', async () => {
    const canonical = canonicalProtocolSnapshotSchema.parse(JSON.parse(readFileSync(
      new URL('../../../protocol/fixtures/representative.json', import.meta.url), 'utf8',
    )));
    vi.useFakeTimers();
    vi.setSystemTime(new Date(canonical.snapshotDate));
    try {
      const categoryId = canonical.categories[0]!.id;
      const payeeId = canonical.transactions[0]!.payeeId!;
      const before: ProtocolSnapshot = {
        ...canonical, rules: [],
        transactions: [{
          ...canonical.transactions[0]!, categoryId: null, categoryName: null,
        }],
      };
      const terms = {
        ...TEST_RULE,
        conditions: [{ field: 'payee' as const, op: 'is' as const, value: payeeId }],
        actions: [{ op: 'set' as const, field: 'category' as const, value: categoryId }],
      };
      const native = await createNativeRuleMutationProtocol();
      const nativePlan = native.planCreateRule({
        name: TEST_RULE_NAME,
        conditions: [terms.conditions[0]!],
        actions: [terms.actions[0]!],
        budgetId: TEST_BUDGET_ID,
        stage: 'post',
        conditionsOp: 'and',
        reviewContext: TEST_REVIEW_CONTEXT,
      }, before);
      store.getProposal.mockResolvedValue(mockProposal({
        payload: {
          ...TEST_RULE_PAYLOAD,
          categoryId,
          rule: terms,
          composite: { ...TEST_RULE_PAYLOAD.composite, nativePayloadHash: nativePlan.hash },
        },
        preconditions: JSON.stringify({
          ...TEST_RULE_PRECONDITIONS,
          actualVersion: before.actualVersion,
          nativeRule: terms,
          nativePlan,
          reviewedSimulation: native.simulateCreateRulePlan(nativePlan, before),
          sourceAccounts: before.accounts.map(({ id }) => ({ accountId: id })),
          sourceTransactions: before.transactions.map(({ id, accountId, categoryId: currentCategoryId }) => ({
            transactionId: id, accountId, categoryId: currentCategoryId,
          })),
        }),
      }));
      const matching: Rule = {
        id: 'another-existing-rule', name: 'Display label only', order: 0, inactive: false,
        trigger: { stage: 'post', conditionsOp: 'and', conditions: terms.conditions },
        actions: terms.actions,
      };
      const returned: Rule = { ...matching, id: TEST_RULE_ID, actions: [{ op: 'set', field: 'category', value: 'wrong-category' }] };
      ledger.synchronize.mockReset().mockResolvedValueOnce({
        snapshot: before, rulePlanningSourceAvailability: completeRuleSource(before.accounts),
      }).mockResolvedValueOnce({
        snapshot: { ...before, rules: [matching, returned] },
        rulePlanningSourceAvailability: completeRuleSource(before.accounts),
      });
      service = new RuleMutationService(store, ledger, native, resolveCurrentContext);
      const result = await service.execute(defaultInput());
      expect(result.success).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.reasonCodes).toContain('rule_creation_not_verified');
      expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(
        TEST_NONCE, expect.any(String), false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not plan or write when current proposal acquisition denies execution', async () => {
    store.acquireProposalExecution.mockRejectedValue(
      new ProposalAcquisitionError('approval_required', 'Additional human approval required'),
    );

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('approval_required');
    expect(ledger.synchronize).not.toHaveBeenCalled();
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it('does not execute composite operations the native rule writer cannot apply', async () => {
    store.getProposal.mockResolvedValue(mockProposal({
      payload: {
        ...TEST_RULE_PAYLOAD,
        composite: {
          operations: [{ operation: 'set_category' }],
          reallocations: [],
          transferRecommendations: [],
          ledgerProjections: [],
          evidenceReferences: [],
        },
      },
    }));

    const result = await service.execute(defaultInput());

    expect(result.reasonCodes).toContain('unsupported_composite');
    expect(store.acquireProposalExecution).not.toHaveBeenCalled();
    expect(ledger.createRule).not.toHaveBeenCalled();
  });


  it('rejects an invalid executable rule before writing', async () => {
    store.getProposal.mockResolvedValue(mockProposal({
      payload: {
        ...TEST_RULE_PAYLOAD,
        rule: { ...TEST_RULE, actions: [] },
      },
    }));

    const result = await service.execute(defaultInput());

    expect(result.reasonCodes).toContain('invalid_preconditions');
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it('rejects a native plan that changes the approved category action before writing', async () => {
    rust.planCreateRule.mockReturnValue(
      mockRuleMutationPlan({ actions: [{ op: 'set', field: 'category', value: 'cat_other' }] }),
    );

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('plan_mismatch');
    expect(ledger.createRule).not.toHaveBeenCalled();
    expect(rust.simulateCreateRulePlan).not.toHaveBeenCalled();
    expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(
      TEST_NONCE,
      expect.any(String),
      false,
    );
  });
  it('rejects a stale captured Native plan before writing', async () => {
    const preconditions = {
      ...TEST_RULE_PRECONDITIONS,
      nativePlan: { ...TEST_NATIVE_PLAN, hash: 'old-native-hash' },
    };
    const payload = {
      ...TEST_RULE_PAYLOAD,
      composite: { ...TEST_RULE_PAYLOAD.composite, nativePayloadHash: 'old-native-hash' },
    };
    store.getProposal.mockResolvedValue(mockProposal({
      payload,
      preconditions: JSON.stringify(preconditions),
    }));

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('plan_mismatch');
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it('rejects a tampered captured Native plan even when its hash field is unchanged', async () => {
    const preconditions = {
      ...TEST_RULE_PRECONDITIONS,
      nativePlan: {
        ...TEST_NATIVE_PLAN,
        trigger: { ...TEST_NATIVE_PLAN.trigger, conditions: [{ field: 'payee', op: 'is', value: 'tampered-payee-id' }] },
      },
    };
    store.getProposal.mockResolvedValue(mockProposal({
      preconditions: JSON.stringify(preconditions),
    }));

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('plan_mismatch');
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it('rejects an approved Native payload hash that differs from the captured plan', async () => {
    const payload = {
      ...TEST_RULE_PAYLOAD,
      composite: { ...TEST_RULE_PAYLOAD.composite, nativePayloadHash: 'tampered-approved-hash' },
    };
    store.getProposal.mockResolvedValue(mockProposal({ payload }));

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it('rejects a proposal from a stale generic mutation algorithm before acquisition', async () => {
    store.getProposal.mockResolvedValue(mockProposal({ policyVersion: '0.9' }));

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('policy_version_mismatch');
    expect(store.acquireProposalExecution).not.toHaveBeenCalled();
    expect(ledger.synchronize).not.toHaveBeenCalled();
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined, 'invalid_preconditions'],
    ['malformed', 7, 'invalid_preconditions'],
    ['changed', 'previous-actual-version', 'precondition_mismatch'],
  ] as const)('rejects %s approved Actual version before creating a rule', async (_case, actualVersion, reason) => {
    const preconditions = { ...TEST_RULE_PRECONDITIONS, actualVersion };
    store.getProposal.mockResolvedValue(mockProposal({ preconditions: JSON.stringify(preconditions) }));
    const result = await service.execute(defaultInput());
    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain(reason);
    expect(ledger.createRule).not.toHaveBeenCalled();
    expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(TEST_NONCE, expect.any(String), false);
  });

  it('does not write when simulation matches no transactions', async () => {
    const reviewedSimulation = mockRuleSimulationResult({
      transactionsMatched: 0, transactionsAffected: [], categoryDistribution: {}, examples: [],
    });
    store.getProposal.mockResolvedValue(mockProposal({
      preconditions: JSON.stringify({ ...TEST_RULE_PRECONDITIONS, reviewedSimulation }),
    }));
    rust.simulateCreateRulePlan.mockReturnValue(reviewedSimulation);

    const result = await service.execute(defaultInput());

    expect(result.reasonCodes).toContain('simulation_no_matches');
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it('does not write when simulation finds conflicts', async () => {
    const reviewedSimulation = mockRuleSimulationResult({ conflicts: ['existing-rule-overlap'] });
    store.getProposal.mockResolvedValue(mockProposal({
      preconditions: JSON.stringify({ ...TEST_RULE_PRECONDITIONS, reviewedSimulation }),
    }));
    rust.simulateCreateRulePlan.mockReturnValue(reviewedSimulation);
    const result = await service.execute(defaultInput());

    expect(result.reasonCodes).toContain('simulation_conflicts');
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  it('reports a write as unverified and terminal when the native postcondition fails', async () => {
    rust.verifyRuleMutation.mockReturnValue({
      verified: false,
      reasonCodes: ['postcondition_failed'],
      message: 'Rule not visible after write',
    });

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reasonCodes).toContain('postcondition_failed');
    expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(
      TEST_NONCE,
      'Rule not visible after write',
      false,
    );
  });
  it.each([
    {
      current: null,
      inactive: true,
      expectedVersion: null,
      result: { ruleId: TEST_RULE_ID, inactive: true, version: 1 },
    },
    {
      current: { ruleId: TEST_RULE_ID, inactive: true, version: 4 },
      inactive: false,
      expectedVersion: 4,
      result: { ruleId: TEST_RULE_ID, inactive: false, version: 5 },
    },
    {
      current: { ruleId: TEST_RULE_ID, inactive: null, version: 6 },
      inactive: true,
      expectedVersion: 6,
      result: { ruleId: TEST_RULE_ID, inactive: true, version: 7 },
    },
  ])('executes update_rule as scoped BalanceFrame classification ($inactive)', async ({
    current,
    inactive,
    expectedVersion,
    result: updated,
  }) => {
    const proposal = mockUpdateRuleProposal(current, inactive);
    store.getProposal.mockResolvedValue(proposal);
    store.getRuleOverride.mockResolvedValueOnce(current).mockResolvedValueOnce(updated);
    store.setRuleOverride.mockResolvedValue(updated);

    const result = await service.execute(defaultInput());

    expect(result).toMatchObject({
      success: true,
      verified: true,
      ruleId: TEST_RULE_ID,
      approvalId: TEST_APPROVAL_ID,
      auditRecordId: 'audit_completed_001',
    });
    expect(store.setRuleOverride).toHaveBeenCalledWith({
      ...TEST_RULE_SCOPE,
      ruleId: TEST_RULE_ID,
      inactive,
      expectedVersion,
    });
    expect(ledger.deleteRule).not.toHaveBeenCalled();
    expect(ledger.createRule).not.toHaveBeenCalled();
    expect(rust.planCreateRule).not.toHaveBeenCalled();
    expect(rust.simulateCreateRulePlan).not.toHaveBeenCalled();
    expect(rust.verifyRuleMutation).not.toHaveBeenCalled();
    expect(store.appendAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: 'execution_completed',
        actorId: TEST_ACTOR,
        operation: 'update_rule',
        payloadHash: proposal.payloadHash,
        expectedPriorState: proposal.preconditions,
        result: 'completed',
        isError: false,
      }),
    );
  });

  it('deletes the exact Actual rule, verifies absence, then clears only its scoped override', async () => {
    const override: RuleOverride = { ruleId: TEST_RULE_ID, inactive: true, version: 4 };
    const proposal = mockDeleteRuleProposal(override);
    store.getProposal.mockResolvedValue(proposal);
    store.getRuleOverride.mockResolvedValue(override);
    ledger.listRules
      .mockResolvedValueOnce([TEST_RULE_BEFORE])
      .mockResolvedValueOnce([]);
    store.removeRuleOverride.mockResolvedValue(undefined);

    const result = await service.execute(defaultInput());

    expect(result).toMatchObject({
      success: true,
      verified: true,
      ruleId: TEST_RULE_ID,
      auditRecordId: 'audit_completed_001',
    });
    expect(ledger.deleteRule).toHaveBeenCalledWith(
      TEST_RULE_ID,
      expect.objectContaining({
        rule: TEST_RULE_BEFORE,
        actualVersion: TEST_RULE_ACTUAL_VERSION,
      }),
    );
    expect(ledger.synchronize).toHaveBeenCalledTimes(2);
    expect(ledger.listRules).toHaveBeenCalledTimes(2);
    expect(store.removeRuleOverride).toHaveBeenCalledWith({
      ...TEST_RULE_SCOPE,
      ruleId: TEST_RULE_ID,
      expectedVersion: override.version,
    });
    expect(
      Math.max(...ledger.listRules.mock.invocationCallOrder),
    ).toBeLessThan(store.removeRuleOverride.mock.invocationCallOrder[0] ?? 0);
    expect(store.appendAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        classification: 'execution_completed',
        actorId: TEST_ACTOR,
        operation: 'delete_rule',
        payloadHash: proposal.payloadHash,
        result: 'completed',
        isError: false,
      }),
    );
  });

  it('denies a changed rule condition operator before any lifecycle write and terminalizes execution', async () => {
    const proposal = mockUpdateRuleProposal();
    store.getProposal.mockResolvedValue(proposal);
    ledger.listRules.mockResolvedValue([
      { ...TEST_RULE_BEFORE, conditionsOp: 'and' },
    ]);

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(store.setRuleOverride).not.toHaveBeenCalled();
    expect(ledger.deleteRule).not.toHaveBeenCalled();
    expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(
      TEST_NONCE,
      expect.any(String),
      false,
    );
  });

  it('denies when a referenced category group’s current members differ from the captured set', async () => {
    const rule: RuleSnapshotFixture = {
      ...TEST_RULE_BEFORE,
      trigger: [{ field: 'category_group', op: 'is', value: 'group-food' }],
    };
    const proposal = mockUpdateRuleProposal(
      null,
      true,
      rule,
      { 'group-food': ['category-a', 'category-b'] },
    );
    store.getProposal.mockResolvedValue(proposal);
    ledger.listRules.mockResolvedValue([rule]);
    ledger.getRuleCategoryGroupMembers.mockResolvedValue({
      'group-food': ['category-a', 'category-c'],
    });

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(ledger.getRuleCategoryGroupMembers).toHaveBeenCalledTimes(1);
    expect(store.setRuleOverride).not.toHaveBeenCalled();
    expect(ledger.deleteRule).not.toHaveBeenCalled();
    expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(
      TEST_NONCE,
      expect.any(String),
      false,
    );
  });

  it('denies a category group that gains a member after an empty closure was captured', async () => {
    const rule: RuleSnapshotFixture = {
      ...TEST_RULE_BEFORE,
      trigger: [{ field: 'category_group', op: 'is', value: 'group-empty' }],
    };
    const proposal = mockUpdateRuleProposal(null, true, rule, { 'group-empty': [] });
    store.getProposal.mockResolvedValue(proposal);
    ledger.listRules.mockResolvedValue([rule]);
    ledger.getRuleCategoryGroupMembers.mockResolvedValue({
      'group-empty': ['category-new'],
    });

    const result = await service.execute(defaultInput());

    expect(result.reasonCodes).toContain('precondition_mismatch');
    expect(store.setRuleOverride).not.toHaveBeenCalled();
    expect(ledger.deleteRule).not.toHaveBeenCalled();
  });

  it.each([
    ['oneOf', true],
    ['oneOf', false],
    ['notOneOf', true],
    ['notOneOf', false],
  ] as const)(
    'executes the exact %s category-group rule with complete membership when inactive=%s',
    async (op, inactive) => {
      const rule: RuleSnapshotFixture = {
        ...TEST_RULE_BEFORE,
        trigger: [{ field: 'category_group', op, value: ['group-food', 'group-home'] }],
      };
      const members = {
        'group-food': ['category-a', 'category-b'],
        'group-home': ['category-c'],
      };
      const updated: RuleOverride = { ruleId: TEST_RULE_ID, inactive, version: 1 };
      const proposal = mockUpdateRuleProposal(null, inactive, rule, members);
      store.getProposal.mockResolvedValue(proposal);
      store.getRuleOverride.mockResolvedValueOnce(null).mockResolvedValueOnce(updated);
      store.setRuleOverride.mockResolvedValue(updated);
      ledger.listRules.mockResolvedValue([rule]);
      ledger.getRuleCategoryGroupMembers.mockResolvedValue(members);

      const result = await service.execute(defaultInput());

      expect(result).toMatchObject({ success: true, verified: true, ruleId: TEST_RULE_ID });
      expect(ledger.getRuleCategoryGroupMembers).toHaveBeenCalledTimes(1);
      expect(store.setRuleOverride).toHaveBeenCalledWith({
        ...TEST_RULE_SCOPE,
        ruleId: TEST_RULE_ID,
        inactive,
        expectedVersion: null,
      });
      expect(ledger.deleteRule).not.toHaveBeenCalled();
    },
  );

  it.each(['oneOf', 'notOneOf'] as const)(
    'deletes the exact category-group %s rule under its captured membership closure',
    async (op) => {
      const rule: RuleSnapshotFixture = {
        ...TEST_RULE_BEFORE,
        trigger: [{ field: 'category_group', op, value: ['group-food', 'group-home'] }],
      };
      const members = {
        'group-food': ['category-a', 'category-b'],
        'group-home': ['category-c'],
      };
      const proposal = mockDeleteRuleProposal(null, rule, members);
      store.getProposal.mockResolvedValue(proposal);
      ledger.listRules.mockResolvedValueOnce([rule]).mockResolvedValueOnce([]);
      ledger.getRuleCategoryGroupMembers.mockResolvedValue(members);

      const result = await service.execute(defaultInput());

      expect(result).toMatchObject({ success: true, verified: true, ruleId: TEST_RULE_ID });
    },
  );

  it.each(['oneOf', 'notOneOf'] as const)(
    'denies changed current membership for category-group %s before lifecycle effects',
    async (op) => {
      const rule: RuleSnapshotFixture = {
        ...TEST_RULE_BEFORE,
        trigger: [{ field: 'category_group', op, value: ['group-food', 'group-home'] }],
      };
      const captured = {
        'group-food': ['category-a', 'category-b'],
        'group-home': ['category-c'],
      };
      const proposal = mockUpdateRuleProposal(null, true, rule, captured);
      store.getProposal.mockResolvedValue(proposal);
      ledger.listRules.mockResolvedValue([rule]);
      ledger.getRuleCategoryGroupMembers.mockResolvedValue({
        'group-food': ['category-a', 'category-b'],
        'group-home': ['category-d'],
      });

      const result = await service.execute(defaultInput());

      expect(result.reasonCodes).toContain('precondition_mismatch');
      expect(ledger.getRuleCategoryGroupMembers).toHaveBeenCalledTimes(1);
      expect(store.setRuleOverride).not.toHaveBeenCalled();
      expect(ledger.deleteRule).not.toHaveBeenCalled();
    },
  );

  it.each(['contains', 'doesNotContain', 'matches'] as const)(
    'does not treat category-group %s name patterns as group IDs',
    async (op) => {
      const rule: RuleSnapshotFixture = {
        ...TEST_RULE_BEFORE,
        trigger: [{ field: 'category_group', op, value: 'Household' }],
      };
      const updated: RuleOverride = { ruleId: TEST_RULE_ID, inactive: true, version: 1 };
      const proposal = mockUpdateRuleProposal(null, true, rule);
      store.getProposal.mockResolvedValue(proposal);
      store.getRuleOverride.mockResolvedValueOnce(null).mockResolvedValueOnce(updated);
      store.setRuleOverride.mockResolvedValue(updated);
      ledger.listRules.mockResolvedValue([rule]);

      const result = await service.execute(defaultInput());

      expect(result).toMatchObject({ success: true, verified: true, ruleId: TEST_RULE_ID });
      expect(ledger.getRuleCategoryGroupMembers).not.toHaveBeenCalled();
    },
  );

  it('does not apply an override against a newer local revision than the displayed one', async () => {
    const proposal = mockUpdateRuleProposal();
    store.getProposal.mockResolvedValue(proposal);
    store.getRuleOverride.mockResolvedValue({
      ruleId: TEST_RULE_ID,
      inactive: null,
      version: 2,
    });

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(store.setRuleOverride).not.toHaveBeenCalled();
    expect(ledger.deleteRule).not.toHaveBeenCalled();
    expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(
      TEST_NONCE,
      expect.any(String),
      false,
    );
  });
});

describe('RuleMutationService with a Native SQLite replay', () => {
  let nativeStore: SqliteWorkflowStore | undefined;
  const now = '2098-01-01T12:00:00.000Z';
  const expiresAt = '2099-01-01T00:00:00.000Z';
  const budgetId = 'budget-native-rule-replay';
  const ruleId = 'rule-native-replay';
  const human = (actorId: string, reauthenticatedAt = now): HumanControlContext => ({
    method: 'human-session',
    actorId,
    sessionId: `session:${actorId}:${reauthenticatedAt}`,
    reauthenticatedAt,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  });
  afterEach(() => {
    nativeStore?.close();
    nativeStore = undefined;
    vi.useRealTimers();
  });

  it.each([
    ['verified', JSON.stringify({ verified: true, ruleId }), true],
    ['legacy missing output', null, false],
    ['malformed output', '{', false],
    ['different rule output', JSON.stringify({ verified: true, ruleId: 'another-rule' }), false],
    ['unverified output', JSON.stringify({ verified: false, ruleId }), false],
  ] as const)('replays only exact verified stored output after the scoped override changes: %s', async (_case, serialisedResult, verified) => {
    nativeStore = new SqliteWorkflowStore(':memory:');
    const claimId = 'native-rule-replay-bootstrap';
    await nativeStore.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId });
    await nativeStore.finalizeBootstrap({ claimId, ownerUserId: 'owner' });
    const actors = ['proposer', 'approver', 'executor'] as const;
    for (const actorId of actors)
      await nativeStore.upsertActorMembership(actorId, 'active', [], 'native-rule-replay');

    const governance = nativeStore.governance;
    const unboundSpace = governance.createSpace({
      actorId: 'owner',
      name: 'Native rule replay',
      kind: 'shared',
      now,
      auth: human('owner'),
    });
    const space = governance.bindBudget({
      spaceId: unboundSpace.id,
      budgetId,
      now,
      auth: human('owner'),
    });
    const ownerMembership = governance.getCurrentMembership({
      spaceId: space.id,
      actorId: 'owner',
      now,
    });
    if (!ownerMembership) throw new Error('Native replay fixture owner membership is missing');
    const memberships: Record<(typeof actors)[number], string> = {
      proposer: '',
      approver: '',
      executor: '',
    };
    for (const actorId of actors) {
      memberships[actorId] = governance.addMembership({
        spaceId: space.id,
        actorId,
        validFrom: now,
        now,
        auth: human('owner'),
      }).id;
    }
    const initialPolicy = governance.getPolicy({ spaceId: space.id });
    if (!initialPolicy) throw new Error('Native replay fixture has no initial policy');
    governance.setPolicy({
      spaceId: space.id,
      expectedVersion: initialPolicy.version,
      policy: { minimumApprovers: 1, approvalThresholds: [], operationApprovers: { update_rule: 1 } },
      now,
      auth: human('owner'),
    });

    const rule = {
      id: ruleId,
      name: 'Native replay rule',
      order: 1,
      trigger: [{ field: 'account', op: 'is', value: `acct-${ruleId}` }],
      actions: [{ op: 'set', field: 'category', value: `cat-after-${ruleId}` }],
      inactive: false,
      stage: 'pre' as const,
      conditionsOp: 'or' as const,
    };
    const payload = { kind: 'update_rule' as const, ruleId, inactive: true };
    const preconditions = { rule, override: null, actualVersion: TEST_RULE_ACTUAL_VERSION };
    const resources: GovernanceResourceRef[] = [
      { resourceKind: 'budget', resourceId: budgetId },
      { resourceKind: 'rule', resourceId: ruleId },
      { resourceKind: 'account', resourceId: `acct-${ruleId}` },
      { resourceKind: 'category', resourceId: `cat-after-${ruleId}` },
    ];
    for (const [actorId, capability] of [
      ['proposer', 'rule:propose'],
      ['approver', 'rule:approve'],
      ['executor', 'rule:execute'],
    ] as const) {
      for (const resource of resources)
        governance.setResourceGrant({
          spaceId: space.id,
          actorId,
          membershipId: memberships[actorId],
          budgetId,
          capability,
          ...resource,
          granted: true,
          now,
          auth: human('owner'),
        });
    }
    const proposalInput: CreateProposalInput = {
      spaceId: space.id,
      operation: 'update_rule',
      budgetId,
      payload,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      preconditions: JSON.stringify(preconditions),
      expiresAt,
      actorId: 'proposer',
      auth: human('proposer'),
      provenance: 'manual',
    };
    const proposal = await nativeStore.createProposal(proposalInput);
    if (!proposal.governancePolicyVersion)
      throw new Error('Native replay fixture proposal has no governance policy version');
    const approval = await nativeStore.createApproval({
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      actorId: 'approver',
      expiresAt,
      auth: human('approver'),
      now,
    });
    const unavailableKey = 'native-rule-replay-no-transport';
    const acquisition = vi.spyOn(nativeStore, 'acquireProposalExecution');
    const resolveUnavailable = vi.fn(unavailableCurrentContext);
    const unavailable = await new RuleMutationService(nativeStore, null, null, resolveUnavailable).execute({
      actorId: 'executor',
      proposalId: proposal.id,
      approvalId: approval.id,
      auth: human('executor'),
      requestId: 'native-rule-replay-no-transport',
      idempotencyKey: unavailableKey,
    });
    expect(unavailable.reasonCodes).toContain('dependencies_unavailable');
    expect(acquisition).not.toHaveBeenCalled();
    expect(await nativeStore.getIdempotencyRecord(unavailableKey)).toBeNull();
    const approvalSummary = await nativeStore.getProposalApprovalSummary({
      proposalId: proposal.id,
      spaceId: space.id,
      actorId: 'executor',
      auth: human('executor'),
      now,
    });
    expect(approvalSummary.approvers.some(({ actorId }) => actorId === 'approver')).toBe(true);
    acquisition.mockRestore();
    const idempotencyKey = 'native-rule-replay-complete';
    const serialisedEffect = JSON.stringify({
      operation: proposal.operation,
      payload: proposal.payload,
      preconditions: JSON.parse(proposal.preconditions) as unknown,
    });
    await nativeStore.acquireProposalExecution({
      actorId: 'executor',
      proposalId: proposal.id,
      payloadHash: proposal.payloadHash,
      governancePolicyVersion: proposal.governancePolicyVersion,
      idempotencyKey,
      serialisedEffect,
      auth: human('executor'),
      now,
      requestId: 'native-rule-replay-request',
    });
    await nativeStore.setRuleOverride({
      spaceId: space.id,
      budgetId,
      ruleId,
      inactive: true,
      expectedVersion: null,
    });
    await nativeStore.completeIdempotencyRecord(
      idempotencyKey, null, undefined, serialisedResult,
    );
    const applyOverrideAgain = vi.spyOn(nativeStore, 'setRuleOverride');
    const ledger = createLedgerMock();
    const service = verified
      ? new RuleMutationService(nativeStore, null, null, resolveUnavailable)
      : new RuleMutationService(nativeStore, ledger, createRustMock(), resolveUnavailable);
    const result = await service.execute({
      actorId: 'executor',
      proposalId: proposal.id,
      auth: human('executor'),
      requestId: 'native-rule-replay-request-again',
      idempotencyKey,
    });
    expect(result.success).toBe(verified);
    expect(result.verified).toBe(verified);
    expect(result.ruleId).toBe(verified ? ruleId : null);
    expect(result.reasonCodes).toContain(verified ? 'idempotency_replay' : 'idempotency_result_mismatch');
    expect(ledger.synchronize).not.toHaveBeenCalled();
    expect(applyOverrideAgain).not.toHaveBeenCalled();
    await nativeStore.supersedeProposal(proposal.id);
    const terminalReplay = await new RuleMutationService(nativeStore, ledger, createRustMock(), resolveUnavailable).execute({
      actorId: 'executor', proposalId: proposal.id, auth: human('executor'),
      requestId: 'native-rule-replay-after-supersession', idempotencyKey,
    });
    expect(terminalReplay).toMatchObject({
      success: verified, verified, ruleId: verified ? ruleId : null,
    });
    expect(ledger.synchronize).not.toHaveBeenCalled();
    expect(applyOverrideAgain).not.toHaveBeenCalled();
    expect(resolveUnavailable).not.toHaveBeenCalled();
  });
  it.each(['oneOf', 'notOneOf'] as const)(
    'rechecks category-group member grants through Native SQLite for %s rules',
    async (op) => {
      nativeStore = new SqliteWorkflowStore(':memory:');
      await nativeStore.claimBootstrap({
        name: 'Owner',
        email: 'owner@example.test',
        claimId: 'native-group-rule-bootstrap',
      });
      await nativeStore.finalizeBootstrap({
        claimId: 'native-group-rule-bootstrap',
        ownerUserId: 'owner',
      });

      const actors = ['proposer', 'approver', 'executor'] as const;
      for (const actorId of actors)
        await nativeStore.upsertActorMembership(actorId, 'active', [], 'native-group-rule');
      const governance = nativeStore.governance;
      const space = governance.bindBudget({
        spaceId: governance.createSpace({
          actorId: 'owner',
          name: 'Native category-group rule',
          kind: 'shared',
          now,
          auth: human('owner'),
        }).id,
        budgetId,
        now,
        auth: human('owner'),
      });
      const memberships = Object.fromEntries(actors.map((actorId) => [
        actorId,
        governance.addMembership({
          spaceId: space.id,
          actorId,
          validFrom: now,
          now,
          auth: human('owner'),
        }).id,
      ])) as Record<(typeof actors)[number], string>;
      const currentPolicy = governance.getPolicy({ spaceId: space.id });
      if (!currentPolicy) throw new Error('Native group rule fixture has no governance policy');
      governance.setPolicy({
        spaceId: space.id,
        expectedVersion: currentPolicy.version,
        policy: { minimumApprovers: 1, approvalThresholds: [], operationApprovers: { update_rule: 1 } },
        now,
        auth: human('owner'),
      });

      const categoryGroupMembers = {
        'group-food': ['category-a', 'category-b'],
        'group-home': ['category-c'],
      };
      const rule = {
        id: ruleId,
        name: 'Native category-group rule',
        order: 1,
        trigger: [{ field: 'category_group', op, value: ['group-food', 'group-home'] }],
        actions: [{ op: 'set', field: 'category', value: 'category-target' }],
        inactive: false,
        stage: 'pre' as const,
        conditionsOp: 'or' as const,
      };
      const resources: GovernanceResourceRef[] = [
        { resourceKind: 'budget', resourceId: budgetId },
        { resourceKind: 'rule', resourceId: ruleId },
        { resourceKind: 'category', resourceId: 'category-a' },
        { resourceKind: 'category', resourceId: 'category-b' },
        { resourceKind: 'category', resourceId: 'category-c' },
        { resourceKind: 'category', resourceId: 'category-target' },
      ];
      for (const [actorId, capability] of [
        ['proposer', 'rule:propose'],
        ['approver', 'rule:approve'],
        ['executor', 'rule:execute'],
      ] as const) {
        for (const resource of resources)
          governance.setResourceGrant({
            spaceId: space.id,
            actorId,
            membershipId: memberships[actorId],
            budgetId,
            capability,
            ...resource,
            granted: true,
            now,
            auth: human('owner'),
          });
      }

      const payload = {
        kind: 'update_rule' as const,
        ruleId,
        inactive: true,
        composite: {
          operations: [],
          reallocations: [],
          transferRecommendations: [],
          ledgerProjections: [],
          evidenceReferences: [],
        },
      };
      const proposal = await nativeStore.createProposal({
        spaceId: space.id,
        operation: 'update_rule',
        budgetId,
        payload,
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        preconditions: JSON.stringify({
          rule,
          override: null,
          actualVersion: TEST_RULE_ACTUAL_VERSION,
          categoryGroupMembers,
        }),
        expiresAt,
        actorId: 'proposer',
        auth: human('proposer'),
        provenance: 'native-group-rule-test',
      });
      const approval = await nativeStore.createApproval({
        proposalId: proposal.id,
        payloadHash: proposal.payloadHash,
        actorId: 'approver',
        expiresAt,
        auth: human('approver'),
        now,
      });
      governance.setResourceGrant({
        spaceId: space.id,
        actorId: 'executor',
        membershipId: memberships.executor,
        budgetId,
        capability: 'rule:execute',
        resourceKind: 'category',
        resourceId: 'category-b',
        granted: false,
        now,
        auth: human('owner'),
      });

      const ledger = createLedgerMock();
      const result = await new RuleMutationService(nativeStore, ledger, createRustMock(), unavailableCurrentContext).execute({
        actorId: 'executor',
        proposalId: proposal.id,
        approvalId: approval.id,
        auth: human('executor'),
        requestId: 'native-group-rule-execution',
        idempotencyKey: `native-group-rule-${op}`,
      });

      expect(result.reasonCodes).toContain('authorization_denied');
      expect(ledger.synchronize).not.toHaveBeenCalled();
      expect(ledger.deleteRule).not.toHaveBeenCalled();
      expect(await nativeStore.getRuleOverride({
        spaceId: space.id,
        budgetId,
        ruleId,
      })).toBeNull();
    },
  );

  it.each((['update_rule', 'delete_rule'] as const).flatMap((operation) =>
    (operation === 'delete_rule'
      ? ['source', 'rule', 'override', 'category groups', 'adapter final rules', 'delete verification']
      : ['source', 'rule', 'override', 'category groups']
    ).flatMap((boundary) => [
      'unchanged', 'executor revoked', 'origin revoked', 'approver revoked', 'approval expired',
      'consumed approval invalidated', 'superseded', 'policy changed', 'credential revoked',
      'credential expired', 'credential check failed', 'executor changed',
    ].map((change) => ({ operation, boundary, change }))),
  ))('fences acquired lifecycle $operation at awaited $boundary after $change', async ({
    operation, boundary, change,
  }) => {
    nativeStore = new SqliteWorkflowStore(':memory:');
    await nativeStore.claimBootstrap({
      name: 'Owner', email: 'owner@example.test', claimId: 'native-lifecycle-fence',
    });
    await nativeStore.finalizeBootstrap({ claimId: 'native-lifecycle-fence', ownerUserId: 'owner' });
    const governance = nativeStore.governance;
    const space = governance.bindBudget({
      spaceId: governance.createSpace({
        actorId: 'owner', name: 'Native lifecycle fence', kind: 'shared', now, auth: human('owner'),
      }).id,
      budgetId, now, auth: human('owner'),
    });
    const memberships: Record<string, string> = {};
    for (const actorId of ['proposer', 'approver', 'executor']) {
      await nativeStore.upsertActorMembership(actorId, 'active', [], 'native-lifecycle-fence');
      memberships[actorId] = governance.addMembership({
        spaceId: space.id, actorId, validFrom: now, now, auth: human('owner'),
      }).id;
    }
    governance.setPolicy({
      spaceId: space.id, expectedVersion: governance.getPolicy({ spaceId: space.id })!.version,
      policy: { minimumApprovers: 1, approvalThresholds: [], operationApprovers: { [operation]: 1 } },
      now, auth: human('owner'),
    });
    const rule = {
      ...TEST_RULE_BEFORE, id: ruleId, order: 0,
      name: boundary === 'adapter final rules' ? '' : TEST_RULE_NAME,
      trigger: [{ field: 'category_group', op: 'is', value: 'group-food' }],
      actions: [{ op: 'set', field: 'category', value: 'cat_groceries' }],
    };
    const scope = { spaceId: space.id, budgetId, ruleId };
    const originalOverride = await nativeStore.setRuleOverride({
      ...scope, inactive: true, expectedVersion: null,
    });
    const categoryGroupMembers = { 'group-food': ['cat_dining', 'cat_groceries'] };
    const payload = operation === 'update_rule'
      ? { kind: 'update_rule' as const, ruleId, inactive: false }
      : { kind: 'delete_rule' as const, ruleId };
    const preconditions = {
      rule, override: originalOverride, actualVersion: '26.7.0', categoryGroupMembers,
    };
    const resources = [
      { resourceKind: 'budget' as const, resourceId: budgetId },
      ...deriveProposalAuthorizationFacts(operation, payload, preconditions).resources,
    ];
    const grant = (actorId: string, capability: string, granted = true) => {
      for (const resource of resources) governance.setResourceGrant({
        spaceId: space.id, budgetId, actorId, membershipId: memberships[actorId]!,
        capability, ...resource, granted, now, auth: human('owner'),
      });
    };
    grant('proposer', 'rule:propose');
    grant('approver', 'rule:approve');
    grant('executor', 'rule:execute');
    // Changing the executor must invalidate this acquisition even if the new actor is authorized.
    grant('approver', 'rule:execute');
    const shortly = '2098-01-01T12:00:30.000Z';
    const proposal = await nativeStore.createProposal({
      spaceId: space.id, operation, budgetId, payload,
      preconditions: JSON.stringify(preconditions), policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt, actorId: 'proposer', auth: human('proposer'), provenance: 'manual',
    });
    const approval = await nativeStore.createApproval({
      proposalId: proposal.id, payloadHash: proposal.payloadHash, actorId: 'approver',
      expiresAt: change === 'approval expired' ? shortly : expiresAt, now, auth: human('approver'),
    });
    let reached!: () => void;
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let didPause = false;
    const pause = async (currentBoundary: string) => {
      if (boundary === currentBoundary && !didPause) {
        didPause = true;
        reached();
        await resume;
      }
    };
    const snapshot = mockProtocolSnapshot({ snapshotDate: now, actualVersion: '26.7.0' });
    const ledger = createLedgerMock();
    let deleted = false;
    ledger.synchronize.mockImplementation(async () => {
      await pause(deleted ? 'delete verification' : 'source');
      return { snapshot, warnings: [] };
    });
    ledger.listRules.mockImplementation(async () => {
      await pause('rule');
      return deleted ? [] : [rule];
    });
    ledger.getRuleCategoryGroupMembers.mockImplementation(async () => {
      await pause('category groups');
      return categoryGroupMembers;
    });
    const readOverride = nativeStore.getRuleOverride.bind(nativeStore);
    const getOverride = vi.spyOn(nativeStore, 'getRuleOverride').mockImplementation(async (input) => {
      const result = await readOverride(input);
      await pause('override');
      return result;
    });
    const writeOverride = vi.spyOn(nativeStore, 'setRuleOverride');
    const removeOverride = vi.spyOn(nativeStore, 'removeRuleOverride');
    ledger.deleteRule.mockImplementation(async () => { deleted = true; });
    let connector: ActualConnector | undefined;
    let sdk: ActualClient | undefined;
    if (boundary === 'adapter final rules') {
      const sdkRule = {
        id: ruleId, stage: rule.stage, conditionsOp: rule.conditionsOp,
        conditions: rule.trigger, actions: rule.actions, tombstone: false,
      };
      sdk = {
        init: vi.fn().mockResolvedValue(undefined), shutdown: vi.fn().mockResolvedValue(undefined),
        getBudgets: vi.fn().mockResolvedValue([{
          id: budgetId, groupId: budgetId, name: 'Native lifecycle fence',
        }]),
        downloadBudget: vi.fn().mockResolvedValue(undefined),
        getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
        getRules: vi.fn(async () => {
          await pause('adapter final rules');
          return deleted ? [] : [sdkRule];
        }),
        deleteRule: vi.fn(async () => { deleted = true; return true; }),
        sync: vi.fn().mockResolvedValue(undefined),
      } as unknown as ActualClient;
      connector = new ActualConnector({
        client: sdk, credentialStore: new NullCredentialStore(), mode: 'reviewAndApply',
        cacheDir: '/tmp/bf-native-lifecycle-fence',
      });
      await connector.connect({ serverUrl: 'http://test:5006', secretKey: 'test' });
      await connector.selectBudget(budgetId);
      // Use the real adapter delete path, not a mock invoking a prospective fence.
      ledger.deleteRule.mockImplementation(connector.deleteRule.bind(connector));
    }
    let credentialCurrent = true;
    const executionInput: ExecuteRuleInput = {
      actorId: 'executor', proposalId: proposal.id, approvalId: approval.id,
      requestId: 'native-lifecycle-fence', idempotencyKey: 'native-lifecycle-fence',
      auth: {
        ...human('executor'),
        credentialExpiresAt: change === 'credential expired' ? shortly : expiresAt,
        isCredentialValid: () => {
          if (!credentialCurrent && change === 'credential check failed')
            throw new Error('Session lookup failed');
          return credentialCurrent;
        },
      },
    };
    const execution = new RuleMutationService(
      nativeStore, ledger, createRustMock(), unavailableCurrentContext,
    ).execute(executionInput);
    try {
      await Promise.race([
        paused,
        execution.then((result) => {
          throw new Error(`Lifecycle stopped before ${boundary}: ${JSON.stringify(result)}`);
        }),
      ]);
      expect((await nativeStore.getApproval(approval.id))?.status).toBe('consumed');
      if (change === 'executor revoked') grant('executor', 'rule:execute', false);
      if (change === 'origin revoked') grant('proposer', 'rule:propose', false);
      if (change === 'approver revoked') grant('approver', 'rule:approve', false);
      if (change === 'superseded') await nativeStore.supersedeProposal(proposal.id);
      if (change === 'policy changed') governance.setPolicy({
        spaceId: space.id, expectedVersion: governance.getPolicy({ spaceId: space.id })!.version,
        policy: { minimumApprovers: 2, approvalThresholds: [], operationApprovers: { [operation]: 2 } },
        now, auth: human('owner'),
      });
      if (change === 'credential revoked' || change === 'credential check failed')
        credentialCurrent = false;
      if (change.endsWith('expired')) vi.setSystemTime(new Date(shortly));
      if (change === 'consumed approval invalidated') {
        const internals = nativeStore as unknown as {
          db: { prepare(sql: string): { run(id: string): unknown } };
        };
        internals.db.prepare(
          "UPDATE proposal_approvals SET status='active', consumed_at=NULL WHERE id=?",
        ).run(approval.id);
      }
      if (change === 'executor changed') {
        executionInput.actorId = 'approver';
        executionInput.auth = human('approver');
      }
      release();
      const result = await execution;
      const unchanged = change === 'unchanged';
      expect(result.success, JSON.stringify({ operation, boundary, change, result })).toBe(unchanged);
      expect(result.verified).toBe(unchanged);
      if (!unchanged) expect(result.reasonCodes).toContain(
        change === 'policy changed' ? 'policy_version_mismatch'
          : change === 'superseded' ? 'proposal_superseded'
          : ['approval expired', 'consumed approval invalidated', 'approver revoked'].includes(change)
            ? 'approval_required' : 'authorization_denied',
      );
      expect(writeOverride).toHaveBeenCalledTimes(operation === 'update_rule' && unchanged ? 1 : 0);
      expect(ledger.deleteRule).toHaveBeenCalledTimes(
        operation === 'delete_rule' &&
          (unchanged || boundary === 'delete verification' || boundary === 'adapter final rules') ? 1 : 0,
      );
      if (sdk) expect(sdk.deleteRule).toHaveBeenCalledTimes(unchanged ? 1 : 0);
      expect(removeOverride).toHaveBeenCalledTimes(operation === 'delete_rule' && unchanged ? 1 : 0);
      if (!unchanged) expect(await readOverride(scope)).toEqual(originalOverride);
      expect((await nativeStore.getIdempotencyRecord('native-lifecycle-fence'))?.status)
        .toBe(unchanged ? 'succeeded' : 'terminal_failed');
      const audits = await nativeStore.queryAuditRecordsByProposal(proposal.id);
      expect(audits.filter((audit) => audit.classification === 'execution_started')).toHaveLength(1);
      expect(audits.some((audit) => audit.classification ===
        (unchanged ? 'execution_completed' : 'execution_failed'))).toBe(true);
      expect(ledger.createRule).not.toHaveBeenCalled();
    } finally {
      release();
      await execution;
      getOverride.mockRestore();
      await connector?.disconnect();
    }
  });
});
