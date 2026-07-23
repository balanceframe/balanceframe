/**
 * TDD: passing tests for RuleMutationService.
 *
 * Follows the same test pattern as CategorizationMutationService tests
 * but for rule creation flow.
 *
 * Focus areas:
 *  - Happy path: proposal loaded, authorized, idempotency claimed,
 *    approval consumed, rule created in ledger, verified.
 *  - Key error paths: proposal not found, expired, superseded,
 *    authorization denied, idempotency replay, approval errors,
 *    plan failure, write failure, verification failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Import service under test
// ---------------------------------------------------------------------------
import {
  RuleMutationService,
  planRuleMutation,
  type ExecuteRuleInput,
  type ExecuteRuleResult,
  type RuleProposalInput,
  type RuleMutationPlan,
  type RuleSimulationResult,
  type RustRuleMutationProtocol,
} from '../src/rule-mutation';
import type {
  CategorizationProposal,
  ProposalApproval,
  IdempotencyRecord,
  WorkflowStore,
  AuditRecord,
  AuthorizationResult,
  AuthorizationDisposition,
  CreateProposalInput,
  CreateApprovalInput,
  CreateIdempotencyInput,
  AppendAuditInput,
} from '@balanceframe/workflow-store';

import type {
  BudgetLedger,
  MutationResult,
  LedgerSnapshotResult,
} from '@balanceframe/actual-adapter';

import type {
  ProtocolSnapshot,
  Rule,
} from '@balanceframe/protocol-generated';

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
const TEST_PAYLOAD_HASH = 'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';

function mockRuleProposalInput(overrides: Partial<RuleProposalInput> = {}): RuleProposalInput {
  return {
    name: TEST_RULE_NAME,
    conditions: [{ field: 'payee_name', op: 'is', value: 'Grocery Store' }],
    actions: [{ type: 'set_category', value: 'cat_groceries' }],
    budgetId: TEST_BUDGET_ID,
    ...overrides,
  };
}

function mockRuleMutationPlan(overrides: Partial<RuleMutationPlan> = {}): RuleMutationPlan {
  return {
    planId: TEST_PLAN_ID,
    ruleName: TEST_RULE_NAME,
    preconditions: { ruleNameAvailable: true },
    expectedOutcome: {
      name: TEST_RULE_NAME,
      trigger: { type: 'transaction_added', conditions: [{ field: 'payee_name', op: 'is', value: 'Grocery Store' }] },
      actions: [{ type: 'set_category', value: 'cat_groceries' }],
    },
    ...overrides,
  };
}

function mockRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: TEST_RULE_ID,
    name: TEST_RULE_NAME,
    order: 0,
    trigger: { type: 'transaction_added' },
    actions: [{ type: 'set_category' }],
    inactive: false,
    ...overrides,
  };
}

function mockProposal(overrides: Partial<CategorizationProposal> = {}): CategorizationProposal {
  return {
    id: TEST_PROPOSAL_ID,
    operation: 'create_rule',
    budgetId: TEST_BUDGET_ID,
    transactionId: '__rule__',
    categoryId: '__rule__',
    payloadHash: TEST_PAYLOAD_HASH,
    policyVersion: '1.0',
    preconditions: JSON.stringify({
      name: TEST_RULE_NAME,
      conditions: [{ field: 'payee_name', op: 'is', value: 'Grocery Store' }],
      actions: [{ type: 'set_category', value: 'cat_groceries' }],
    }),
    expiresAt: '2099-12-31T23:59:59Z',
    actorId: TEST_ACTOR,
    provenance: 'manual',
    providerModel: null,
    correlationId: 'corr_rule_001',
    supersededAt: null,
    createdAt: '2026-07-20T10:00:00Z',
    ...overrides,
  };
}

function mockApproval(overrides: Partial<ProposalApproval> = {}): ProposalApproval {
  return {
    id: TEST_APPROVAL_ID,
    proposalId: TEST_PROPOSAL_ID,
    payloadHash: TEST_PAYLOAD_HASH,
    actorId: TEST_ACTOR,
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
    serialisedEffect: JSON.stringify({ ruleName: TEST_RULE_NAME }),
    errorMessage: null,
    updatedAt: '2026-07-20T11:00:00Z',
    ...overrides,
  };
}

function mockProtocolSnapshot(overrides: Partial<ProtocolSnapshot> = {}): ProtocolSnapshot {
  return {
    schemaVersion: '1.0',
    actualVersion: '2026.07.01',
    snapshotDate: new Date().toISOString(),
    accounts: [],
    transactions: [],
    categories: [],
    payees: [],
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

function mockRuleSimulationResult(overrides: Partial<RuleSimulationResult> = {}): RuleSimulationResult {
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
    actorId: TEST_ACTOR,
    requestId: TEST_REQUEST,
    idempotencyKey: TEST_NONCE,
    correlationId: 'corr_rule_001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

function allowedAuth(): AuthorizationResult {
  return {
    allowed: true,
    membershipStatus: 'active',
    disposition: { kind: 'authorized_without_approval' },
  };
}

function deniedAuth(reason = 'Missing capability rule:execute'): AuthorizationResult {
  return {
    allowed: false,
    membershipStatus: 'active',
    disposition: { kind: 'denied', reason },
  };
}

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

interface StoreMock extends WorkflowStore {
  getProposal: Mock;
  getApproval: Mock;
  findActiveApprovals: Mock;
  consumeApproval: Mock;
  verifyApprovalForExecution: Mock;
  createIdempotencyRecord: Mock;
  getIdempotencyRecord: Mock;
  completeIdempotencyRecord: Mock;
  appendAuditRecord: Mock;
  evaluateAuthorization: Mock;
  queryAuditRecords: Mock;
}

function createStoreMock(): StoreMock {
  return {
    // Proposal lifecycle
    getProposal: vi.fn(),
    createProposal: vi.fn(),
    findActiveProposal: vi.fn(),
    supersedeProposal: vi.fn() as Mock,

    // Approval lifecycle
    getApproval: vi.fn(),
    createApproval: vi.fn(),
    findActiveApprovals: vi.fn(),
    consumeApproval: vi.fn(),
    verifyApprovalForExecution: vi.fn(),

    // Idempotency
    createIdempotencyRecord: vi.fn(),
    getIdempotencyRecord: vi.fn(),
    completeIdempotencyRecord: vi.fn(),

    // Audit
    appendAuditRecord: vi.fn(),
    queryAuditRecords: vi.fn() as Mock,
    queryAuditRecordsByProposal: vi.fn() as Mock,

    // Authorization
    evaluateAuthorization: vi.fn(),
    upsertActorMembership: vi.fn() as Mock,
    getActorMembership: vi.fn() as Mock,

    // Suggestion lifecycle (required by interface)
    saveSuggestion: vi.fn() as Mock,
    getActiveSuggestion: vi.fn() as Mock,
    getSuggestion: vi.fn() as Mock,
    getTransactionSuggestions: vi.fn() as Mock,
    supersedeSuggestions: vi.fn() as Mock,

    // Job lifecycle
    enqueueJob: vi.fn() as Mock,
    claimJob: vi.fn() as Mock,
    completeJob: vi.fn() as Mock,
    failJob: vi.fn() as Mock,
    getPendingJobs: vi.fn() as Mock,
    getJobByCandidateId: vi.fn() as Mock,

    // Review lifecycle
    createReviewItem: vi.fn() as Mock,
    getReviewItem: vi.fn() as Mock,
    findReviewByIssue: vi.fn() as Mock,
    listReviewItems: vi.fn() as Mock,
    listReviewItemsByCorrelation: vi.fn() as Mock,
    transitionReviewItem: vi.fn() as Mock,
    transitionReviewItems: vi.fn() as Mock,
    undoReviewTransition: vi.fn() as Mock,
    getReviewActions: vi.fn() as Mock,
  } as StoreMock;
}

interface LedgerMock extends BudgetLedger {
  synchronize: Mock;
  setTransactionCategory: Mock;
  createRule: Mock;
  capabilities: Mock;
  listAccounts: Mock;
  listTransactions: Mock;
  listCategories: Mock;
  listPayees: Mock;
  listRules: Mock;
  listSchedules: Mock;
  importTransactions: Mock;
  updateTransaction: Mock;
  setBudgetAmount: Mock;
  disconnect: Mock;
}

function createLedgerMock(): LedgerMock {
  return {
    synchronize: vi.fn(),
    setTransactionCategory: vi.fn(),
    createRule: vi.fn(),
    capabilities: vi.fn() as Mock,
    listAccounts: vi.fn() as Mock,
    listTransactions: vi.fn() as Mock,
    listCategories: vi.fn() as Mock,
    listPayees: vi.fn() as Mock,
    listRules: vi.fn() as Mock,
    listSchedules: vi.fn() as Mock,
    importTransactions: vi.fn() as Mock,
    updateTransaction: vi.fn() as Mock,
    setBudgetAmount: vi.fn() as Mock,
    disconnect: vi.fn() as Mock,
  } as LedgerMock;
}

interface RustProtocolMock {
  planCreateRule: Mock;
  verifyRuleMutation: Mock;
  simulateRule: Mock;
}
function createRustMock(): RustProtocolMock {
  return {
    planCreateRule: vi.fn(),
    verifyRuleMutation: vi.fn(),
    simulateRule: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuleMutationService', () => {
  let store: StoreMock;
  let ledger: LedgerMock;
  let rust: RustProtocolMock;
  let service: RuleMutationService;

  beforeEach(() => {
    store = createStoreMock();
    ledger = createLedgerMock();
    rust = createRustMock();
    service = new RuleMutationService(store, ledger, rust);
  });

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  it('should execute a rule creation proposal end-to-end successfully', async () => {
    const proposal = mockProposal();
    store.getProposal.mockResolvedValue(proposal);
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_001' } as AuditRecord);

    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);

    const plan = mockRuleMutationPlan();
    rust.planCreateRule.mockReturnValue(plan);
    rust.verifyRuleMutation.mockReturnValue({
      verified: true,
      reasonCodes: [],
      message: null,
    });
    rust.simulateRule.mockReturnValue(mockRuleSimulationResult());

    ledger.createRule.mockResolvedValue(mockMutationResult());

    // Second synchronize (reread after write)
    ledger.synchronize.mockResolvedValue({ snapshot: { ...snapshot, rules: [mockRule()] } } as LedgerSnapshotResult);

    // Completion audit
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_completed_001' } as AuditRecord);

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(true);
    expect(result.ruleId).toBe(TEST_RULE_ID);
    expect(result.verified).toBe(true);
    expect(result.approvalId).toBe(TEST_APPROVAL_ID);
    expect(result.auditRecordId).toBe('audit_completed_001');
    expect(result.reasonCodes).toEqual([]);

    // Verify the flow calls
    expect(store.getProposal).toHaveBeenCalledWith(TEST_PROPOSAL_ID);
    expect(store.evaluateAuthorization).toHaveBeenCalledWith(
      TEST_ACTOR, 'rule:execute', 'budget:' + TEST_BUDGET_ID, '1.0',
    );
    expect(store.createIdempotencyRecord).toHaveBeenCalledWith({
      idempotencyKey: TEST_NONCE,
      proposalId: TEST_PROPOSAL_ID,
      operation: 'create_rule',
      serialisedEffect: JSON.stringify({ ruleName: TEST_RULE_NAME }),
    });
    expect(store.getApproval).toHaveBeenCalledWith(TEST_APPROVAL_ID);
    expect(store.consumeApproval).toHaveBeenCalledWith(TEST_APPROVAL_ID);
    expect(ledger.synchronize).toHaveBeenCalledTimes(2);
    expect(rust.simulateRule).toHaveBeenCalled();
    expect(result.simulation).not.toBeNull();
    expect(result.simulation!.transactionsMatched).toBe(3);
    expect(result.simulation!.conflicts).toEqual([]);
    expect(rust.planCreateRule).toHaveBeenCalled();
    expect(ledger.createRule).toHaveBeenCalledWith({
      name: TEST_RULE_NAME,
      conditions: [{ field: 'payee_name', op: 'is', value: 'Grocery Store' }],
      actions: [{ type: 'set_category', value: 'cat_groceries' }],
      conditionsOp: 'and',
    });
    expect(rust.verifyRuleMutation).toHaveBeenCalled();
    expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(TEST_NONCE, null);
  });

  // -----------------------------------------------------------------------
  // Error: proposal not found
  // -----------------------------------------------------------------------

  it('should fail when proposal is not found', async () => {
    store.getProposal.mockResolvedValue(null);

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('proposal_not_found');
    expect(result.ruleId).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Error: proposal superseded
  // -----------------------------------------------------------------------

  it('should fail when proposal is superseded', async () => {
    store.getProposal.mockResolvedValue(
      mockProposal({ supersededAt: '2026-07-21T10:00:00Z' }),
    );

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('proposal_superseded');
  });

  // -----------------------------------------------------------------------
  // Error: proposal expired
  // -----------------------------------------------------------------------

  it('should fail when proposal has expired', async () => {
    store.getProposal.mockResolvedValue(
      mockProposal({ expiresAt: '2020-01-01T00:00:00Z' }),
    );

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('proposal_expired');
  });

  // -----------------------------------------------------------------------
  // Error: authorization denied
  // -----------------------------------------------------------------------

  it('should fail when authorization is denied', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(deniedAuth());

    const result = await service.execute(defaultInput());
    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('insufficient_capability');
  });

  // -----------------------------------------------------------------------
  // Error: member inactive
  // -----------------------------------------------------------------------

  it('should fail when member is inactive', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue({
      allowed: false,
      membershipStatus: 'inactive',
      disposition: { kind: 'denied', reason: 'Member inactive' },
    });

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('member_inactive');
  });

  // -----------------------------------------------------------------------
  // Idempotency replay
  // -----------------------------------------------------------------------

  it('should replay a completed idempotency record', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());

    const completedRecord = mockIdempotencyRecord({ completed: true, errorMessage: null });
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: false,
      record: completedRecord,
    });

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(true);
    expect(result.reasonCodes).toContain('idempotency_replay');
    // Should not proceed to further steps
    expect(store.getApproval).not.toHaveBeenCalled();
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Idempotency in progress
  // -----------------------------------------------------------------------

  it('should fail when idempotency key is in use by another execution', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());

    const inFlightRecord = mockIdempotencyRecord({ completed: false });
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: false,
      record: inFlightRecord,
    });

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('idempotency_in_progress');
  });

  // -----------------------------------------------------------------------
  // Error: approval not found
  // -----------------------------------------------------------------------

  it('should fail when approval is not found', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(null);

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('approval_not_found');
  });

  // -----------------------------------------------------------------------
  // Error: approval proposal mismatch
  // -----------------------------------------------------------------------

  it('should fail when approval proposal ID does not match', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(
      mockApproval({ proposalId: 'prop_wrong' }),
    );

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('approval_proposal_mismatch');
  });

  // -----------------------------------------------------------------------
  // Error: payload hash mismatch
  // -----------------------------------------------------------------------

  it('should fail when approval payload hash does not match proposal', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(
      mockApproval({ payloadHash: 'wrong_hash' }),
    );

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('payload_hash_mismatch');
  });

  // -----------------------------------------------------------------------
  // Error: wrong operation
  // -----------------------------------------------------------------------

  it('should fail when proposal operation is not create_rule', async () => {
    store.getProposal.mockResolvedValue(
      mockProposal({ operation: 'set_category' }),
    );
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('unsupported_operation');
  });

  // -----------------------------------------------------------------------
  // Error: approval already consumed
  // -----------------------------------------------------------------------

  it('should fail when approval is already consumed', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(
      mockApproval({ status: 'consumed' }),
    );

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('approval_consumed');
  });

  // -----------------------------------------------------------------------
  // Rule shape validation — no degenerate defaults
  // -----------------------------------------------------------------------

  it('should fail when rule name is empty string', async () => {
    store.getProposal.mockResolvedValue(
      mockProposal({
        preconditions: JSON.stringify({
          name: '',
          conditions: [{ field: 'payee_name', op: 'is', value: 'Grocery Store' }],
          actions: [{ type: 'set_category', value: 'cat_groceries' }],
        }),
      }),
    );
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('invalid_preconditions');
  });

  it('should fail when rule name is missing', async () => {
    store.getProposal.mockResolvedValue(
      mockProposal({
        preconditions: JSON.stringify({
          conditions: [{ field: 'payee_name', op: 'is', value: 'Grocery Store' }],
          actions: [{ type: 'set_category', value: 'cat_groceries' }],
        }),
      }),
    );
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('invalid_preconditions');
  });

  it('should fail when rule conditions are missing', async () => {
    store.getProposal.mockResolvedValue(
      mockProposal({
        preconditions: JSON.stringify({
          name: 'Test Rule',
          actions: [{ type: 'set_category', value: 'cat_groceries' }],
        }),
      }),
    );
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_001' } as AuditRecord);
    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('invalid_preconditions');
  });

  it('should fail when rule conditions is empty array', async () => {
    store.getProposal.mockResolvedValue(
      mockProposal({
        preconditions: JSON.stringify({
          name: 'Test Rule',
          conditions: [],
          actions: [{ type: 'set_category', value: 'cat_groceries' }],
        }),
      }),
    );
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_001' } as AuditRecord);
    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('invalid_preconditions');
  });

  it('should fail when rule actions are missing', async () => {
    store.getProposal.mockResolvedValue(
      mockProposal({
        preconditions: JSON.stringify({
          name: 'Test Rule',
          conditions: [{ field: 'payee_name', op: 'is', value: 'Grocery Store' }],
        }),
      }),
    );
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_001' } as AuditRecord);
    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('invalid_preconditions');
  });

  it('should fail when rule actions is empty array', async () => {
    store.getProposal.mockResolvedValue(
      mockProposal({
        preconditions: JSON.stringify({
          name: 'Test Rule',
          conditions: [{ field: 'payee_name', op: 'is', value: 'Grocery Store' }],
          actions: [],
        }),
      }),
    );
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_001' } as AuditRecord);
    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('invalid_preconditions');
  });


  it('should accept nativeRule-nested format and hash matches execution side', async () => {
    const ruleName = 'Nested Format Rule';
    const conditions = [{ field: 'payee_name', op: 'is', value: 'Some Store' }];
    const actions = [{ type: 'set_category', value: 'cat_stuff' }];

    // Build the normalized shape exactly as the propose-rule endpoint would
    const normalizedRule = {
      name: ruleName,
      conditions,
      actions,
      conditionsOp: 'and' as const,
    };
    const expectedHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(normalizedRule))
      .digest('hex');

    const proposal = mockProposal({
      payloadHash: expectedHash,
      preconditions: JSON.stringify({
        merchant: 'Some Store',
        source: 'review',
        reviewId: 'review_nested_001',
        nativeRule: normalizedRule,
      }),
    });
    store.getProposal.mockResolvedValue(proposal);
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(
      mockApproval({ payloadHash: expectedHash }),
    );
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_001' } as AuditRecord);

    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);

    const plan = mockRuleMutationPlan({
      ruleName,
      expectedOutcome: {
        name: ruleName,
        trigger: conditions,
        actions,
      },
    });
    rust.planCreateRule.mockReturnValue(plan);
    rust.verifyRuleMutation.mockReturnValue({
      verified: true,
      reasonCodes: [],
      message: null,
    });
    rust.simulateRule.mockReturnValue(mockRuleSimulationResult({
      name: ruleName,
    }));

    ledger.createRule.mockResolvedValue(mockMutationResult());
    ledger.synchronize.mockResolvedValue({
      snapshot: {
        ...snapshot,
        rules: [mockRule({ name: ruleName })],
      },
    } as LedgerSnapshotResult);

    // Completion audit
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_completed_001' } as AuditRecord);

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(true);
    expect(result.ruleId).toBe(TEST_RULE_ID);

    // Verify the hash stored in proposal matches what was passed to ledger.createRule
    expect(ledger.createRule).toHaveBeenCalledWith({
      name: ruleName,
      conditions,
      actions,
      conditionsOp: 'and',
    });
  });

  // -----------------------------------------------------------------------
  // Error: rule name conflict (precondition fails)
  // -----------------------------------------------------------------------

  it('should fail when plan indicates rule name is not available', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));

    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);

    rust.planCreateRule.mockReturnValue(
      mockRuleMutationPlan({
        preconditions: { ruleNameAvailable: false },
      }),
    );

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('rule_name_conflict');
  });

  // -----------------------------------------------------------------------
  // Error: ledger createRule fails
  // -----------------------------------------------------------------------

  it('should fail when ledger.createRule returns failure', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));

    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);
    rust.planCreateRule.mockReturnValue(mockRuleMutationPlan());
    rust.simulateRule.mockReturnValue(mockRuleSimulationResult());

    ledger.createRule.mockResolvedValue({
      success: false,
      error: 'Rule name already exists',
      code: 'CONFLICT',
    });

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('write_failed');
  });

  // -----------------------------------------------------------------------
  // Error: verification fails after write
  // -----------------------------------------------------------------------

  it('should report success=false when post-write verification fails', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));

    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);
    rust.planCreateRule.mockReturnValue(mockRuleMutationPlan());
    rust.simulateRule.mockReturnValue(mockRuleSimulationResult());
    ledger.createRule.mockResolvedValue(mockMutationResult());

    // Reread returns a snapshot where the rule is missing
    ledger.synchronize.mockResolvedValue({
      snapshot: mockProtocolSnapshot({ rules: [] }),
    } as LedgerSnapshotResult);

    rust.verifyRuleMutation.mockReturnValue({
      verified: false,
      reasonCodes: ['rule_not_found_in_snapshot'],
      message: 'Created rule was not found in the post-write snapshot',
    });

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.ruleId).toBe(TEST_RULE_ID); // Rule was created, just not verified
    expect(result.reasonCodes).toContain('rule_not_found_in_snapshot');
  });

  // -----------------------------------------------------------------------
  // planRuleMutation static delegation
  // -----------------------------------------------------------------------

  it('planRuleMutation should delegate to rust.planCreateRule', () => {
    const input = mockRuleProposalInput();
    const snapshot = mockProtocolSnapshot();
    const expectedPlan = mockRuleMutationPlan();
    rust.planCreateRule.mockReturnValue(expectedPlan);

    const plan = planRuleMutation(rust, input, snapshot);
    expect(plan).toEqual(expectedPlan);
  });

  // -----------------------------------------------------------------------
  // Error: approval expired
  // -----------------------------------------------------------------------

  it('should fail when approval has expired status', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(
      mockApproval({ status: 'expired' }),
    );

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('approval_expired');
    expect(result.approvalId).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Error: approval superseded
  // -----------------------------------------------------------------------

  it('should fail when approval has superseded status', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(
      mockApproval({ status: 'superseded' }),
    );

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('approval_superseded');
    expect(result.approvalId).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Error: stale snapshot from synchronize
  // -----------------------------------------------------------------------

  it('should fail when synchronize returns a stale snapshot', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_002' } as AuditRecord);

    const snapshot = mockProtocolSnapshot({
      snapshotDate: '2020-01-01T00:00:00Z',
    });
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);
    rust.planCreateRule.mockReturnValue(mockRuleMutationPlan());

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('stale_snapshot');
  });

  // -----------------------------------------------------------------------
  // Error: plan creation failure (Rust throws)
  // -----------------------------------------------------------------------

  it('should fail when Rust planCreateRule throws', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_003' } as AuditRecord);

    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);
    rust.planCreateRule.mockImplementation(() => {
      throw new Error('Rust protocol unavailable');
    });

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('plan_failed');
  });

  // -----------------------------------------------------------------------
  // Error: approval consumption failure
  // -----------------------------------------------------------------------

  it('should fail when store.consumeApproval throws', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockRejectedValue(new Error('Consumption conflict'));

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('approval_consumption_failed');
  });

  // -----------------------------------------------------------------------
  // Simulation: should call simulateRule before rule creation
  // -----------------------------------------------------------------------

  it('should fail when simulateRule throws', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_004' } as AuditRecord);

    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);
    rust.planCreateRule.mockReturnValue(mockRuleMutationPlan());
    rust.simulateRule.mockImplementation(() => {
      throw new Error('Simulation engine unavailable');
    });

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('simulation_failed');
    expect(result.ruleId).toBeNull();
    expect(result.simulation).toBeNull();
    // Should not proceed to write
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Simulation: zero matching transactions
  // -----------------------------------------------------------------------

  it('should fail when simulation matches zero transactions', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_005' } as AuditRecord);

    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);
    rust.planCreateRule.mockReturnValue(mockRuleMutationPlan());
    rust.simulateRule.mockReturnValue(mockRuleSimulationResult({ transactionsMatched: 0, transactionsAffected: [], examples: [] }));

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('simulation_no_matches');
    expect(result.ruleId).toBeNull();
    expect(result.simulation!.transactionsMatched).toBe(0);
    // Should not proceed to write
    expect(ledger.createRule).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Simulation: conflicts surfaced
  // -----------------------------------------------------------------------

  it('should fail when simulation reveals conflicts', async () => {
    store.getProposal.mockResolvedValue(mockProposal());
    store.evaluateAuthorization.mockResolvedValue(allowedAuth());
    store.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: mockIdempotencyRecord(),
    });
    store.getApproval.mockResolvedValue(mockApproval());
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed' }));
    store.appendAuditRecord.mockResolvedValue({ id: 'audit_started_006' } as AuditRecord);

    const snapshot = mockProtocolSnapshot();
    ledger.synchronize.mockResolvedValue({ snapshot } as LedgerSnapshotResult);
    rust.planCreateRule.mockReturnValue(mockRuleMutationPlan());
    rust.simulateRule.mockReturnValue(mockRuleSimulationResult({
      conflicts: ['Overlaps with existing rule "Auto-categorize dining"'],
    }));

    const result = await service.execute(defaultInput());

    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('simulation_conflicts');
    expect(result.ruleId).toBeNull();
    expect(result.simulation!.conflicts.length).toBeGreaterThan(0);
    // Should not proceed to write
    expect(ledger.createRule).not.toHaveBeenCalled();
  });
});
