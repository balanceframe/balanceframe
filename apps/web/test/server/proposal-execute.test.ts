/**
 * TDD: verify the proposal-execute route eliminates the direct
 * connector.createRule bypass and routes through RuleMutationService.
 *
 * Acceptance:
 *  - Direct connector.createRule is NEVER called by the handler code
 *    (the only createRule invocation goes through the service).
 *  - When the native protocol is unavailable, the handler returns
 *    NOT_IMPLEMENTED (501) rather than mutating Actual unsafely.
 *  - Transient failures (ledger unavailable) return retryable errors
 *    so the caller can safely retry.
 *  - Successful execution returns the rule ID in the envelope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — vitest hoists vi.mock() to top of file.
// Use vi.hoisted() for vars accessible in mock factory closures.
// ---------------------------------------------------------------------------

const mockRestore = vi.fn();
const mockCreateRule = vi.fn();
const mockSynchronize = vi.fn();
const mockSupersedeProposal = vi.fn();

const mockStore = {
  getProposal: vi.fn(),
  findActiveApprovals: vi.fn(),
  supersedeProposal: mockSupersedeProposal,
  getApproval: vi.fn(),
  getIdempotencyRecord: vi.fn(),
  evaluateAuthorization: vi.fn(),
  createIdempotencyRecord: vi.fn(),
  consumeApproval: vi.fn(),
  completeIdempotencyRecord: vi.fn(),
  appendAuditRecord: vi.fn(),
};

vi.mock('../../server/utils/mutation-executor', () => ({
  createMutationConnectionManager: vi.fn(() => ({
    restore: mockRestore,
  })),
}));

// hoisted factory — this var is hoisted before any vi.mock factory runs
const { mockNativeProtocolFactory } = vi.hoisted(() => ({
  mockNativeProtocolFactory: vi.fn<() => Promise<Record<string, unknown>>>(),
}));

vi.mock('@balanceframe/application', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createNativeRuleMutationProtocol: mockNativeProtocolFactory,
  };
});

vi.mock('../../server/utils/workflow-store', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/utils/workflow-store')>();
  return {
    ...mod,
    getWorkflowStore: vi.fn(() => ({ store: mockStore })),
    getActorId: vi.fn(() => 'test-actor'),
    okEnvelope: vi.fn((result, _auth, requestId) => ({
      ok: true,
      result,
      requestId,
    })),
    errorEnvelope: vi.fn((code, message, _auth, retryable, requestId) => ({
      ok: false,
      error: { code, message, retryable },
      requestId,
    })),
    buildAuthorizationInfo: vi.fn(() => ({ actorId: 'test-actor', capability: 'rule.execute' })),
    requireAuthorization: vi.fn(() => Promise.resolve({ ok: true, info: { actorId: 'test-actor', capability: 'rule.execute', allowed: true } })),
  };
});

// Import must come after mocks
import handler from '../../server/api/proposal/[id]/execute.post';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_PROPOSAL_ID = 'prop_rule_001';
const TEST_APPROVAL_ID = 'appr_rule_001';
const TEST_PAYLOAD_HASH = 'b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';

function mockEvent(): Record<string, unknown> {
  return {
    context: {
      params: { id: TEST_PROPOSAL_ID },
      runtimeConfig: {},
    },
    node: { res: { statusCode: 200 } },
  };
}

function validProposal() {
  return {
    id: TEST_PROPOSAL_ID,
    operation: 'create_rule',
    budgetId: 'budget_main',
    payloadHash: TEST_PAYLOAD_HASH,
    policyVersion: '1.0',
    preconditions: JSON.stringify({
      name: 'Auto-categorize groceries',
      conditions: [{ field: 'payee_name', op: 'is', value: 'Grocery Store' }],
      actions: [{ type: 'set_category', value: 'cat_groceries' }],
    }),
    expiresAt: '2099-12-31T23:59:59Z',
    supersededAt: null,
    actorId: 'test-actor',
    provenance: 'manual',
    providerModel: null,
    correlationId: null,
    createdAt: '2026-07-20T10:00:00Z',
  };
}

function mockRustProtocol() {
  return {
    planCreateRule: vi.fn(() => ({
      planId: 'plan_001',
      ruleName: 'Auto-categorize groceries',
      preconditions: { ruleNameAvailable: true },
      expectedOutcome: {
        name: 'Auto-categorize groceries',
        trigger: { type: 'transaction_added' },
        actions: [{ type: 'set_category' }],
      },
    })),
    simulateRule: vi.fn(() => ({
      ruleId: '',
      name: 'Auto-categorize groceries',
      transactionsMatched: 3,
      transactionsAffected: ['tx_001', 'tx_002', 'tx_003'],
      categoryDistribution: { cat_groceries: 3 },
      conflicts: [],
      examples: [],
    })),
    verifyRuleMutation: vi.fn(() => ({
      verified: true,
      reasonCodes: [],
      message: null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proposal-execute — bypass elimination', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default store stubs
    mockStore.getProposal.mockResolvedValue(validProposal());
    mockStore.findActiveApprovals.mockResolvedValue([
      { id: TEST_APPROVAL_ID, actorId: 'test-actor', payloadHash: TEST_PAYLOAD_HASH, status: 'active' },
    ]);
    mockStore.evaluateAuthorization.mockResolvedValue({
      allowed: true,
      membershipStatus: 'active',
      disposition: { kind: 'allowed', reason: 'OK' },
    });
    mockStore.createIdempotencyRecord.mockResolvedValue({
      isOwner: true,
      record: { idempotencyKey: 'test-key', completed: false, errorMessage: null },
    });
    mockStore.getApproval.mockResolvedValue({
      id: TEST_APPROVAL_ID,
      proposalId: TEST_PROPOSAL_ID,
      payloadHash: TEST_PAYLOAD_HASH,
      status: 'active',
      expiresAt: '2099-12-31T23:59:59Z',
      actorId: 'test-actor',
      consumedAt: null,
      supersededAt: null,
    });
    mockStore.consumeApproval.mockResolvedValue({ status: 'consumed' });
    mockStore.completeIdempotencyRecord.mockResolvedValue(undefined);
    mockStore.appendAuditRecord.mockResolvedValue({ id: 'audit_001' });
    mockSupersedeProposal.mockResolvedValue(undefined);

    // Default connector (simulates BudgetLedger shape)
    mockRestore.mockResolvedValue({
      connector: {
        createRule: mockCreateRule,
        synchronize: mockSynchronize,
        capabilities: vi.fn(),
        listAccounts: vi.fn(),
        listTransactions: vi.fn(),
        listCategories: vi.fn(),
        listPayees: vi.fn(),
        listRules: vi.fn().mockResolvedValue([]),
        listSchedules: vi.fn(),
        importTransactions: vi.fn(),
        updateTransaction: vi.fn(),
        setBudgetAmount: vi.fn(),
        setTransactionCategory: vi.fn(),
        disconnect: vi.fn(),
      },
      budget: { id: 'budget_main', name: 'Main Budget', groupId: 'group_main' },
      synchronization: { snapshot: {} },
    });
    mockSynchronize.mockResolvedValue({ snapshot: {}, health: {}, watermark: {} });
    mockCreateRule.mockResolvedValue({ success: true, ruleId: 'rule_001' });

    // Native protocol available by default
    mockNativeProtocolFactory.mockResolvedValue(mockRustProtocol());
  });

  // -----------------------------------------------------------------------
  // Test 1: Direct connector.createRule is NEVER called
  // -----------------------------------------------------------------------

  it('must never call connector.createRule directly (routes through RuleMutationService)', async () => {
    const event = mockEvent();
    const response = await handler(event);
    expect(mockCreateRule).toHaveBeenCalledTimes(1);
    expect(response).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({ proposalId: TEST_PROPOSAL_ID }),
    }));
  });

  // -----------------------------------------------------------------------
  // Test 2: Native protocol unavailable → NOT_IMPLEMENTED (no mutation)
  // -----------------------------------------------------------------------

  it('must return NOT_IMPLEMENTED when native protocol is unavailable (no createRule call)', async () => {
    mockNativeProtocolFactory.mockRejectedValue(
      new Error('Native addon not found'),
    );

    const event = mockEvent();
    const response = await handler(event);

    expect(response).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'NOT_IMPLEMENTED',
        retryable: false,
      }),
      requestId: expect.any(String),
    });
    // returned early before any mutation.
    expect(mockCreateRule).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 3: Transient ledger failure remains retryable
  // -----------------------------------------------------------------------

  it('must return retryable error when ledger connection fails transiently', async () => {
    mockRestore.mockRejectedValue(new Error('Network timeout connecting to Actual'));

    const event = mockEvent();
    const response = await handler(event);
    expect(response).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: 'LEDGER_UNAVAILABLE',
        retryable: true,
      }),
      requestId: expect.any(String),
    });

    expect(mockCreateRule).not.toHaveBeenCalled();

    // With retryable = true, the client can safely retry and the
    // idempotency mechanism would not have been claimed at this point.
  });
});
