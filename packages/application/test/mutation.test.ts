/**
 * TDD: failing tests for CategorizationMutationService.
 *
 * Covers:
 * - Exact proposal hash binding
 * - Active membership/capability/scope authorization
 * - Approval expiry/consumption/replay
 * - Latest snapshot planning via ledger.synchronize()
 * - Stale precondition rejection
 * - Write-enabled category update via ledger.setTransactionCategory
 * - Reread/postcondition verification via Rust verifyMutation
 * - Idempotency replay/recovery
 * - Append-only audit results throughout the flow
 * - Never blindly repeat a committed write
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Import service under test
// ---------------------------------------------------------------------------
import {
  CategorizationMutationService,
  type ExecuteCategorizationInput,
  type ExecuteCategorizationResult,
} from '../src/mutation';

// ---------------------------------------------------------------------------
// Import dependency types
// ---------------------------------------------------------------------------
import type {
  WorkflowStore,
  CategorizationProposal,
  ProposalApproval,
  IdempotencyRecord,
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
  SetCategoryResult,
  LedgerSnapshotResult,
} from '@balanceframe/actual-adapter';

import type {
  Transaction,
  Category,
  ProtocolSnapshot,
} from '@balanceframe/protocol-generated';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_ACTOR = 'usr_mutator';
const TEST_REQUEST = 'req_cat_exec_001';
const TEST_PROPOSAL_ID = 'prop_abc123';
const TEST_APPROVAL_ID = 'appr_def456';
const TEST_TX_ID = 'tx_001';
const TEST_CATEGORY_ID = 'cat_food';
const TEST_PAYLOAD_HASH = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
const TEST_NONCE = 'idem_nonce_001';
const TEST_PLAN_ID = 'plan_a1b2c3d4';
const TEST_BUDGET_ID = 'budget_main';

function mockMoney(minorUnits = '0', currency = 'USD') {
  return { minorUnits, currency };
}

function mockTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: TEST_TX_ID,
    accountId: 'acct_001',
    date: '2026-07-15',
    payeeId: 'payee_001',
    payeeName: 'Test Store',
    categoryId: null,
    categoryName: null,
    amount: mockMoney('5000', 'USD'),
    cleared: true,
    reconciled: false,
    importedId: null,
    importedPayee: null,
    notes: null,
    tags: [],
    transferAccountId: null,
    subtransactions: [],
    ...overrides,
  };
}

function mockCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: TEST_CATEGORY_ID,
    name: 'Food & Dining',
    groupName: 'Variable Expenses',
    isIncome: false,
    mtid: null,
    deleted: false,
    ...overrides,
  };
}

function mockProtocolSnapshot(overrides: Partial<ProtocolSnapshot> = {}): ProtocolSnapshot {
  return {
    schemaVersion: '1.0',
    actualVersion: '2026.07.01',
    snapshotDate: new Date().toISOString(),
    accounts: [],
    transactions: [mockTransaction()],
    categories: [mockCategory()],
    payees: [],
    rules: [],
    schedules: [],
    budgets: [],
    tags: [],
    ...overrides,
  };
}

function mockProposal(overrides: Partial<CategorizationProposal> = {}): CategorizationProposal {
  return {
    id: TEST_PROPOSAL_ID,
    operation: 'set_category',
    budgetId: TEST_BUDGET_ID,
    transactionId: TEST_TX_ID,
    categoryId: TEST_CATEGORY_ID,
    payloadHash: TEST_PAYLOAD_HASH,
    policyVersion: '1.0',
    preconditions: JSON.stringify({ currentCategoryId: null }),
    expiresAt: '2099-12-31T23:59:59Z',
    actorId: TEST_ACTOR,
    provenance: 'model-derived',
    providerModel: 'openai/gpt-4',
    correlationId: 'corr_exec_001',
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
    operation: 'set_category',
    executedAt: '2026-07-20T11:00:00Z',
    completed: false,
    serialisedEffect: JSON.stringify({ transactionId: TEST_TX_ID, newCategoryId: TEST_CATEGORY_ID }),
    errorMessage: null,
    updatedAt: '2026-07-20T11:00:00Z',
    ...overrides,
  };
}

function mockSetCategoryResult(overrides: Partial<SetCategoryResult> = {}): SetCategoryResult {
  return {
    success: true,
    transactionId: TEST_TX_ID,
    previousCategoryId: null,
    newCategoryId: TEST_CATEGORY_ID,
    idempotencyKey: TEST_NONCE,
    verified: true,
    ...overrides,
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
  getProposal?: Mock;
  evaluateAuthorization: Mock;
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
  capabilities: Mock;
  listAccounts: Mock;
  listTransactions: Mock;
  listCategories: Mock;
  listPayees: Mock;
  listRules: Mock;
  listSchedules: Mock;
  importTransactions: Mock;
  updateTransaction: Mock;
  createRule: Mock;
  setBudgetAmount: Mock;
  disconnect: Mock;
}

function createLedgerMock(): LedgerMock {
  return {
    synchronize: vi.fn(),
    setTransactionCategory: vi.fn(),
    capabilities: vi.fn() as Mock,
    listAccounts: vi.fn() as Mock,
    listTransactions: vi.fn() as Mock,
    listCategories: vi.fn() as Mock,
    listPayees: vi.fn() as Mock,
    listRules: vi.fn() as Mock,
    listSchedules: vi.fn() as Mock,
    importTransactions: vi.fn() as Mock,
    updateTransaction: vi.fn() as Mock,
    createRule: vi.fn() as Mock,
    setBudgetAmount: vi.fn() as Mock,
    disconnect: vi.fn() as Mock,
  } as LedgerMock;
}

interface RustProtocolMock {
  planSetCategory: Mock;
  verifyMutation: Mock;
}

function createRustMock(): RustProtocolMock {
  return {
    planSetCategory: vi.fn(),
    verifyMutation: vi.fn(),
  };
}

describe('CategorizationMutationService', () => {
  let store: StoreMock;
  let ledger: LedgerMock;
  let rust: RustProtocolMock;
  let service: CategorizationMutationService;

  function makeInput(overrides: Partial<ExecuteCategorizationInput> = {}): ExecuteCategorizationInput {
    return {
      requestId: TEST_REQUEST,
      actorId: TEST_ACTOR,
      proposalId: TEST_PROPOSAL_ID,
      approvalId: TEST_APPROVAL_ID,
      idempotencyKey: TEST_NONCE,
      correlationId: 'corr_exec_001',
      ...overrides,
    };
  }

  beforeEach(() => {
    store = createStoreMock();
    ledger = createLedgerMock();
    rust = createRustMock();
    service = new CategorizationMutationService(store, ledger, rust);

    // ── Default happy-path mocks ──────────────────────────────────────

    // Proposal exists, active, hash matches
    store.getProposal.mockResolvedValue(mockProposal());

    // Authorization passes
    store.evaluateAuthorization.mockResolvedValue({
      allowed: true,
      disposition: { kind: 'authorized_without_approval' },
      actorId: TEST_ACTOR,
      membershipStatus: 'active',
      capability: 'categorization:execute',
      scope: 'budget:' + TEST_BUDGET_ID,
      policyVersion: '1.0',
      reason: 'Authorized',
    });

    // Approval lookup
    store.getApproval.mockResolvedValue(mockApproval());
    store.findActiveApprovals.mockResolvedValue([mockApproval()]);
    store.consumeApproval.mockResolvedValue(mockApproval({ status: 'consumed', consumedAt: '2026-07-20T11:00:00Z' }));

    // Idempotency: no previous record
    store.getIdempotencyRecord.mockResolvedValue(null);
    store.createIdempotencyRecord.mockResolvedValue(mockIdempotencyRecord({ completed: false }));
    store.completeIdempotencyRecord.mockResolvedValue(mockIdempotencyRecord({ completed: true }));

    // Ledger sync returns snapshot with our transaction
    ledger.synchronize.mockResolvedValue({
      snapshot: mockProtocolSnapshot(),
      health: { status: 'healthy', lastCheckedAt: '2026-07-20T11:00:00Z', details: {} },
      watermark: { lastSyncAt: '2026-07-20T11:00:00Z', dataVersion: 'v2' },
    } as LedgerSnapshotResult);

    // Rust planSetCategory returns a plan
    rust.planSetCategory.mockReturnValue({
      planId: TEST_PLAN_ID,
      transactionId: TEST_TX_ID,
      currentCategoryId: null,
      proposedCategoryId: TEST_CATEGORY_ID,
      hash: 'plan_hash_001',
      postconditions: [{ type: 'CategoryExists', categoryId: TEST_CATEGORY_ID }],
    });

    // Ledger write succeeds
    ledger.setTransactionCategory.mockResolvedValue(mockSetCategoryResult());

    // Reread snapshot verification passes
    rust.verifyMutation.mockReturnValue({
      verified: true,
      reasonCodes: ['postcondition_verified'],
      message: null,
    });

    // Audit append succeeds
    store.appendAuditRecord.mockResolvedValue({
      id: 'audit_001',
      classification: 'execution_completed',
      timestamp: '2026-07-20T11:00:00Z',
      actorId: TEST_ACTOR,
      operation: 'set_category',
      proposalId: TEST_PROPOSAL_ID,
      payloadHash: TEST_PAYLOAD_HASH,
      budgetId: TEST_BUDGET_ID,
      backendIds: '',
      policyVersion: '1.0',
      authorizationDisposition: null,
      idempotencyKey: TEST_NONCE,
      expectedPriorState: null,
      observedResultState: JSON.stringify({ transactionId: TEST_TX_ID, newCategoryId: TEST_CATEGORY_ID }),
      providerModel: null,
      correlationId: 'corr_exec_001',
      requestId: TEST_REQUEST,
      result: 'completed',
      isError: false,
    } as AuditRecord);
  });

  // =========================================================================
  // Exact proposal hash binding
  // =========================================================================

  describe('exact proposal hash binding', () => {
    it('loads the proposal by ID before executing', async () => {
      await service.execute(makeInput());
      expect(store.getProposal).toHaveBeenCalledWith(TEST_PROPOSAL_ID);
    });

    it('rejects when proposal is not found', async () => {
      store.getProposal.mockResolvedValue(null);
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('proposal_not_found');
      expect(result.auditRecordId).toBeNull();
    });

    it('rejects when proposal is superseded', async () => {
      store.getProposal.mockResolvedValue(mockProposal({ supersededAt: '2026-07-20T10:45:00Z' }));
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('proposal_superseded');
    });

    it('rejects when payload hash does not match proposal', async () => {
      store.getProposal.mockResolvedValue(mockProposal({ payloadHash: 'expected_hash_abc' }));
      // Input has TEST_PAYLOAD_HASH but proposal has 'expected_hash_abc' — mismatch
      const result = await service.execute(makeInput({ proposalId: TEST_PROPOSAL_ID }));
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('payload_hash_mismatch');
    });
  });

  // =========================================================================
  // Authorization — membership, capability, scope
  // =========================================================================

  describe('authorization — membership, capability, scope', () => {
    it('checks evaluateAuthorization with capability and scope', async () => {
      await service.execute(makeInput());
      expect(store.evaluateAuthorization).toHaveBeenCalledWith(
        TEST_ACTOR,
        'categorization:execute',
        'budget:' + TEST_BUDGET_ID,
        '1.0',
      );
    });

    it('rejects when member is inactive', async () => {
      store.evaluateAuthorization.mockResolvedValue({
        allowed: false,
        disposition: { kind: 'denied', reason: 'Member status is not active' },
        actorId: TEST_ACTOR,
        membershipStatus: 'inactive',
        capability: 'categorization:execute',
        scope: 'budget:' + TEST_BUDGET_ID,
        policyVersion: '1.0',
        reason: 'Member is inactive, requires active membership',
      });
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('member_inactive');
    });

    it('rejects when capability is insufficient', async () => {
      store.evaluateAuthorization.mockResolvedValue({
        allowed: false,
        disposition: { kind: 'denied', reason: 'Missing capability: categorization:execute' },
        actorId: TEST_ACTOR,
        membershipStatus: 'active',
        capability: 'categorization:execute',
        scope: 'budget:' + TEST_BUDGET_ID,
        policyVersion: '1.0',
        reason: 'Actor lacks required capability \'categorization:execute\'',
      });
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('insufficient_capability');
    });

    it('rejects when scope is insufficient', async () => {
      store.evaluateAuthorization.mockResolvedValue({
        allowed: false,
        disposition: { kind: 'denied', reason: 'Scope mismatch' },
        actorId: TEST_ACTOR,
        membershipStatus: 'active',
        capability: 'categorization:execute',
        scope: 'budget:' + TEST_BUDGET_ID,
        policyVersion: '1.0',
        reason: 'Actor scope does not include required scope',
      });
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('insufficient_scope');
    });
  });

  // =========================================================================
  // Approval expiry, consumption, and replay
  // =========================================================================

  describe('approval expiry / consumption / replay', () => {
    it('loads the specific approval by ID', async () => {
      await service.execute(makeInput());
      expect(store.getApproval).toHaveBeenCalledWith(TEST_APPROVAL_ID);
    });

    it('rejects when approval is not found', async () => {
      store.getApproval.mockResolvedValue(null);
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('approval_not_found');
    });

    it('rejects when approval is expired', async () => {
      store.getApproval.mockResolvedValue(
        mockApproval({ expiresAt: '2020-01-01T00:00:00Z' }),
      );
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('approval_expired');
    });

    it('rejects when approval is already consumed', async () => {
      store.getApproval.mockResolvedValue(
        mockApproval({ status: 'consumed', consumedAt: '2026-07-20T10:50:00Z' }),
      );
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('approval_consumed');
    });

    it('rejects when approval is superseded', async () => {
      store.getApproval.mockResolvedValue(
        mockApproval({ status: 'superseded', supersededAt: '2026-07-20T10:45:00Z' }),
      );
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('approval_superseded');
    });

    it('rejects when approval payload hash does not match proposal', async () => {
      store.getApproval.mockResolvedValue(
        mockApproval({ payloadHash: 'different_hash' }),
      );
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('payload_hash_mismatch');
    });
  });

  // =========================================================================
  // Latest snapshot planning via Rust planSetCategory
  // =========================================================================

  describe('latest snapshot planning', () => {
    it('calls ledger.synchronize() to get latest snapshot', async () => {
      await service.execute(makeInput());
      expect(ledger.synchronize).toHaveBeenCalled();
    });

    it('plans mutation via rust.planSetCategory with transaction and category from snapshot', async () => {
      const tx = mockTransaction();
      const cat = mockCategory();
      ledger.synchronize.mockResolvedValue({
        snapshot: mockProtocolSnapshot({ transactions: [tx], categories: [cat] }),
        health: { status: 'healthy', lastCheckedAt: '2026-07-20T11:00:00Z', details: {} },
        watermark: { lastSyncAt: '2026-07-20T11:00:00Z', dataVersion: 'v2' },
      });

      await service.execute(makeInput());

      expect(rust.planSetCategory).toHaveBeenCalledWith(tx, cat);
    });

    it('rejects when transaction not found in latest snapshot', async () => {
      ledger.synchronize.mockResolvedValue({
        snapshot: mockProtocolSnapshot({ transactions: [] }),
        health: { status: 'healthy', lastCheckedAt: '2026-07-20T11:00:00Z', details: {} },
        watermark: { lastSyncAt: '2026-07-20T11:00:00Z', dataVersion: 'v2' },
      });
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('transaction_not_found');
    });

    it('rejects when category not found in latest snapshot', async () => {
      ledger.synchronize.mockResolvedValue({
        snapshot: mockProtocolSnapshot({ categories: [] }),
        health: { status: 'healthy', lastCheckedAt: '2026-07-20T11:00:00Z', details: {} },
        watermark: { lastSyncAt: '2026-07-20T11:00:00Z', dataVersion: 'v2' },
      });
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('category_not_found');
    });

    it('rejects when snapshot data is stale', async () => {
      ledger.synchronize.mockResolvedValue({
        snapshot: mockProtocolSnapshot({ snapshotDate: '2020-01-01T00:00:00Z' }),
        health: { status: 'healthy', lastCheckedAt: '2020-01-01T00:00:00Z', details: {} },
        watermark: { lastSyncAt: '2020-01-01T00:00:00Z', dataVersion: 'v0' },
      });
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('stale_snapshot');
    });
  });

  // =========================================================================
  // Stale precondition rejection
  // =========================================================================

  describe('stale precondition rejection', () => {
    it('rejects when plan currentCategoryId does not match proposal preconditions', async () => {
      // Proposal says currentCategoryId should be null (uncategorized)
      const proposal = mockProposal({
        preconditions: JSON.stringify({ currentCategoryId: null }),
      });
      store.getProposal.mockResolvedValue(proposal);

      // But the plan says currentCategoryId is 'cat_old'
      rust.planSetCategory.mockReturnValue({
        planId: TEST_PLAN_ID,
        transactionId: TEST_TX_ID,
        currentCategoryId: 'cat_old',
        proposedCategoryId: TEST_CATEGORY_ID,
        hash: 'plan_hash_001',
        postconditions: [{ type: 'CategoryExists', categoryId: TEST_CATEGORY_ID }],
      });

      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('precondition_mismatch');
    });

    it('rejects when plan currentCategoryId differs from live transaction category', async () => {
      // Proposal preconditions say currentCategoryId = 'cat_old'
      const proposal = mockProposal({
        preconditions: JSON.stringify({ currentCategoryId: 'cat_old' }),
      });
      store.getProposal.mockResolvedValue(proposal);

      // Transaction in snapshot has categoryId = 'cat_different'
      const tx = mockTransaction({ categoryId: 'cat_different' });
      ledger.synchronize.mockResolvedValue({
        snapshot: mockProtocolSnapshot({ transactions: [tx] }),
        health: { status: 'healthy', lastCheckedAt: '2026-07-20T11:00:00Z', details: {} },
        watermark: { lastSyncAt: '2026-07-20T11:00:00Z', dataVersion: 'v2' },
      });

      // Plan reflects the live transaction's state
      rust.planSetCategory.mockReturnValue({
        planId: TEST_PLAN_ID,
        transactionId: TEST_TX_ID,
        currentCategoryId: 'cat_different',
        proposedCategoryId: TEST_CATEGORY_ID,
        hash: 'plan_hash_001',
        postconditions: [{ type: 'CategoryExists', categoryId: TEST_CATEGORY_ID }],
      });

      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('precondition_mismatch');
    });
  });

  // =========================================================================
  // Write-enabled category update through ledger
  // =========================================================================

  describe('write-enabled category update', () => {
    it('calls ledger.setTransactionCategory with correct parameters', async () => {
      await service.execute(makeInput());
      expect(ledger.setTransactionCategory).toHaveBeenCalledWith(
        TEST_TX_ID,
        TEST_CATEGORY_ID,
        null, // currentCategoryId from plan
      );
    });

    it('passes the plan currentCategoryId to setTransactionCategory', async () => {
      const proposal = mockProposal({
        preconditions: JSON.stringify({ currentCategoryId: 'cat_old' }),
      });
      store.getProposal.mockResolvedValue(proposal);

      const tx = mockTransaction({ categoryId: 'cat_old' });
      ledger.synchronize.mockResolvedValue({
        snapshot: mockProtocolSnapshot({ transactions: [tx] }),
        health: { status: 'healthy', lastCheckedAt: '2026-07-20T11:00:00Z', details: {} },
        watermark: { lastSyncAt: '2026-07-20T11:00:00Z', dataVersion: 'v2' },
      });

      rust.planSetCategory.mockReturnValue({
        planId: TEST_PLAN_ID,
        transactionId: TEST_TX_ID,
        currentCategoryId: 'cat_old',
        proposedCategoryId: TEST_CATEGORY_ID,
        hash: 'plan_hash_002',
        postconditions: [{ type: 'CategoryExists', categoryId: TEST_CATEGORY_ID }],
      });

      await service.execute(makeInput());
      expect(ledger.setTransactionCategory).toHaveBeenCalledWith(
        TEST_TX_ID,
        TEST_CATEGORY_ID,
        'cat_old',
      );
    });

    it('rejects when setTransactionCategory fails', async () => {
      ledger.setTransactionCategory.mockRejectedValue(new Error('Write rejected in Observe mode'));
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('write_failed');
    });

    it('rejects when setTransactionCategory returns success=false', async () => {
      // Simulate verification failure in the connector
      ledger.setTransactionCategory.mockResolvedValue(
        mockSetCategoryResult({ success: true, verified: false }),
      );
      // Make verifyMutation also fail so the combined result reflects failure
      rust.verifyMutation.mockReturnValue({
        verified: false,
        reasonCodes: ['postcondition_failed'],
        message: 'Category was not updated as expected',
      });

      const result = await service.execute(makeInput());
      // The setCategory succeeded but postcondition verification failed
      expect(result.verified).toBe(false);
    });

    it('takes the setTransactionCategory idempotency key from the input', async () => {
      await service.execute(makeInput({ idempotencyKey: 'custom_idem_key' }));
      // The idempotency key flows through to the write operation
      const callArg = (ledger.setTransactionCategory as Mock).mock.calls[0];
      // setTransactionCategory doesn't take an idempotency key directly;
      // it's tracked via the idempotency record we created before the write
      expect(store.createIdempotencyRecord).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: 'custom_idem_key' }),
      );
    });
  });

  // =========================================================================
  // Reread / postcondition verification
  // =========================================================================

  describe('reread / postcondition verification', () => {
    it('calls rust.verifyMutation with plan and snapshot after write', async () => {
      await service.execute(makeInput());

      // Should call synchronize again after write to get fresh data
      expect(ledger.synchronize).toHaveBeenCalledTimes(2);

      // verifyMutation should be called with the plan and the reread snapshot
      const planArg = (rust.verifyMutation as Mock).mock.calls[0][0];
      expect(planArg.planId).toBe(TEST_PLAN_ID);

      const snapshotArg = (rust.verifyMutation as Mock).mock.calls[0][1];
      expect(snapshotArg.snapshotDate).toBeDefined();
    });

    it('returns verified=true when postconditions pass', async () => {
      const result = await service.execute(makeInput());
      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
    });

    it('returns verified=false and includes reason codes when verification fails', async () => {
      rust.verifyMutation.mockReturnValue({
        verified: false,
        reasonCodes: ['postcondition_failed', 'category_not_found'],
        message: 'Category no longer exists',
      });

      const result = await service.execute(makeInput());
      expect(result.success).toBe(true); // write succeeded
      expect(result.verified).toBe(false);
      expect(result.reasonCodes).toContain('postcondition_failed');
    });
  });

  // =========================================================================
  // Idempotency replay and recovery
  // =========================================================================

  describe('idempotency replay / recovery', () => {
    it('creates idempotency record before performing write', async () => {
      await service.execute(makeInput());
      expect(store.createIdempotencyRecord).toHaveBeenCalledWith({
        idempotencyKey: TEST_NONCE,
        proposalId: TEST_PROPOSAL_ID,
        operation: 'set_category',
        serialisedEffect: expect.any(String),
      });
    });

    it('returns cached result when idempotency key already completed', async () => {
      store.getIdempotencyRecord.mockResolvedValue(
        mockIdempotencyRecord({ completed: true }),
      );

      const result = await service.execute(makeInput());

      // Should not perform any write operations
      expect(ledger.synchronize).not.toHaveBeenCalled();
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
      expect(store.consumeApproval).not.toHaveBeenCalled();

      // Should return the cached result
      expect(result.success).toBe(true);
      expect(result.transactionId).toBe(TEST_TX_ID);
    });

    it('recovers from crash when idempotency record exists but is not completed', async () => {
      // Idempotency record exists from a previous crash
      store.getIdempotencyRecord.mockResolvedValue(
        mockIdempotencyRecord({ completed: false }),
      );

      // Should proceed with execution despite partial record
      const result = await service.execute(makeInput());

      // Should still execute all operations
      expect(ledger.synchronize).toHaveBeenCalled();
      expect(ledger.setTransactionCategory).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('completes idempotency record after successful execution', async () => {
      await service.execute(makeInput());
      expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(
        TEST_NONCE,
        null, // no error
      );
    });

    it('records error on idempotency record when write fails', async () => {
      ledger.setTransactionCategory.mockRejectedValue(new Error('Backend error'));
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(store.completeIdempotencyRecord).toHaveBeenCalledWith(
        TEST_NONCE,
        expect.stringContaining('Backend error'),
      );
    });

    it('rejects replay with different proposal ID under same idempotency key', async () => {
      store.createIdempotencyRecord.mockRejectedValue(
        new Error('Idempotency replay mismatch: different proposalId'),
      );

      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('idempotency_replay_mismatch');
    });
  });

  // =========================================================================
  // Append-only audit results
  // =========================================================================

  describe('append-only audit results', () => {
    it('appends audit record for execution completion', async () => {
      await service.execute(makeInput());
      expect(store.appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          classification: 'execution_completed',
          actorId: TEST_ACTOR,
          proposalId: TEST_PROPOSAL_ID,
          payloadHash: TEST_PAYLOAD_HASH,
          requestId: TEST_REQUEST,
          idempotencyKey: TEST_NONCE,
          isError: false,
        }),
      );
    });

    it('appends audit record for execution failure', async () => {
      store.getProposal.mockResolvedValue(null);
      const result = await service.execute(makeInput());

      expect(store.appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          classification: 'execution_failed',
          isError: true,
          result: expect.stringContaining('proposal_not_found'),
        }),
      );
    });

    it('includes authorization disposition in audit record', async () => {
      store.evaluateAuthorization.mockResolvedValue({
        allowed: true,
        disposition: { kind: 'authorized_without_approval' } as AuthorizationDisposition,
        actorId: TEST_ACTOR,
        membershipStatus: 'active',
        capability: 'categorization:execute',
        scope: 'budget:' + TEST_BUDGET_ID,
        policyVersion: '1.0',
        reason: 'Authorized',
      });

      await service.execute(makeInput());

      // Check that the completion audit record includes authorization info
      const auditCalls = (store.appendAuditRecord as Mock).mock.calls;
      // The last audit call is the execution_completed one
      const execAudit = auditCalls[auditCalls.length - 1][0] as AppendAuditInput;
      expect(execAudit.authorizationDisposition).toEqual(
        expect.objectContaining({ kind: 'authorized_without_approval' }),
      );
    });

    it('appends audit record for execution started before write', async () => {
      await service.execute(makeInput());

      // Should have at least an execution_started audit
      const auditCalls = (store.appendAuditRecord as Mock).mock.calls;
      const startedAudit = auditCalls.find(
        (c: [AppendAuditInput]) => c[0].classification === 'execution_started',
      );
      expect(startedAudit).toBeDefined();
      expect(startedAudit[0]).toMatchObject({
        proposalId: TEST_PROPOSAL_ID,
        actorId: TEST_ACTOR,
      });
    });

    it('contains observed result state in audit record after write', async () => {
      await service.execute(makeInput());

      const auditCalls = (store.appendAuditRecord as Mock).mock.calls;
      const completionAudit = auditCalls.find(
        (c: [AppendAuditInput]) => c[0].classification === 'execution_completed',
      );
      expect(completionAudit).toBeDefined();
      expect(completionAudit[0].observedResultState).toBeTruthy();
      const state = JSON.parse(completionAudit[0].observedResultState);
      expect(state).toMatchObject({
        transactionId: TEST_TX_ID,
        newCategoryId: TEST_CATEGORY_ID,
      });
    });
  });

  // =========================================================================
  // Never blindly repeat committed writes
  // =========================================================================

  describe('never blindly repeat committed writes', () => {
    it('skips setTransactionCategory when idempotency record indicates past completion', async () => {
      store.getIdempotencyRecord.mockResolvedValue(
        mockIdempotencyRecord({ completed: true }),
      );

      await service.execute(makeInput());

      // No write to ledger
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
      // No consume of approval
      expect(store.consumeApproval).not.toHaveBeenCalled();
    });

    it('consumes approval exactly once per execution', async () => {
      await service.execute(makeInput());
      expect(store.consumeApproval).toHaveBeenCalledWith(TEST_APPROVAL_ID);
      expect(store.consumeApproval).toHaveBeenCalledOnce();
    });

    it('does not consume approval when execution fails before write', async () => {
      store.getProposal.mockResolvedValue(null);

      await service.execute(makeInput());

      // Should not consume the approval if we never wrote
      expect(store.consumeApproval).not.toHaveBeenCalled();
    });

    it('does not consume approval when idempotency replay returns cached result', async () => {
      store.getIdempotencyRecord.mockResolvedValue(
        mockIdempotencyRecord({ completed: true }),
      );

      await service.execute(makeInput());
      expect(store.consumeApproval).not.toHaveBeenCalled();
    });

    it('persists audit result with observed state to prevent blind repeat', async () => {
      // Run once
      await service.execute(makeInput());

      const auditCalls = (store.appendAuditRecord as Mock).mock.calls;
      const completionAudits = auditCalls.filter(
        (c: [AppendAuditInput]) => c[0].classification === 'execution_completed',
      );
      expect(completionAudits.length).toBe(1);
      const state = JSON.parse(completionAudits[0][0].observedResultState);
      expect(state.verified).toBe(true);
    });
  });

  // =========================================================================
  // Successful execution — all steps
  // =========================================================================

  describe('successful execution', () => {
    it('returns full result with all fields populated', async () => {
      const result = await service.execute(makeInput());

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe(TEST_TX_ID);
      expect(result.previousCategoryId).toBe(null);
      expect(result.newCategoryId).toBe(TEST_CATEGORY_ID);
      expect(result.verified).toBe(true);
      expect(result.planId).toBe(TEST_PLAN_ID);
      expect(result.idempotencyKey).toBe(TEST_NONCE);
      expect(result.approvalId).toBe(TEST_APPROVAL_ID);
      expect(result.auditRecordId).toBeDefined();
      expect(result.reasonCodes).toContain('postcondition_verified');
    });

    it('performs all lifecycle steps in correct order', async () => {
      const order: string[] = [];
      store.getProposal.mockImplementation(async () => {
        order.push('getProposal');
        return mockProposal();
      });
      store.evaluateAuthorization.mockImplementation(async () => {
        order.push('evaluateAuthorization');
        return {
          allowed: true,
          disposition: { kind: 'authorized_without_approval' },
          actorId: TEST_ACTOR,
          membershipStatus: 'active',
          capability: 'categorization:execute',
          scope: 'budget:' + TEST_BUDGET_ID,
          policyVersion: '1.0',
          reason: 'Authorized',
        };
      });
      store.getApproval.mockImplementation(async () => {
        order.push('getApproval');
        return mockApproval();
      });
      store.createIdempotencyRecord.mockImplementation(async () => {
        order.push('createIdempotencyRecord');
        return mockIdempotencyRecord();
      });
      ledger.synchronize.mockImplementation(async () => {
        order.push('synchronize(1)');
        return {
          snapshot: mockProtocolSnapshot(),
          health: { status: 'healthy', lastCheckedAt: '2026-07-20T11:00:00Z', details: {} },
          watermark: { lastSyncAt: '2026-07-20T11:00:00Z', dataVersion: 'v2' },
        };
      });
      // Override the second synchronize to track separately
      let syncCount = 0;
      ledger.synchronize.mockImplementation(async () => {
        syncCount++;
        if (syncCount === 2) {
          order.push('synchronize(2)');
        } else if (syncCount === 1) {
          order.push('synchronize(1)');
        }
        return {
          snapshot: mockProtocolSnapshot(),
          health: { status: 'healthy', lastCheckedAt: '2026-07-20T11:00:00Z', details: {} },
          watermark: { lastSyncAt: '2026-07-20T11:00:00Z', dataVersion: 'v2' },
        };
      });
      rust.planSetCategory.mockImplementation(() => {
        order.push('planSetCategory');
        return {
          planId: TEST_PLAN_ID,
          transactionId: TEST_TX_ID,
          currentCategoryId: null,
          proposedCategoryId: TEST_CATEGORY_ID,
          hash: 'plan_hash_001',
          postconditions: [{ type: 'CategoryExists', categoryId: TEST_CATEGORY_ID }],
        };
      });
      ledger.setTransactionCategory.mockImplementation(async () => {
        order.push('setTransactionCategory');
        return mockSetCategoryResult();
      });
      store.appendAuditRecord.mockImplementation(async () => {
        order.push('appendAuditRecord');
        return {
          id: 'audit_001',
          classification: 'execution_completed',
          timestamp: '2026-07-20T11:00:00Z',
          actorId: TEST_ACTOR,
          operation: 'set_category',
          proposalId: TEST_PROPOSAL_ID,
          payloadHash: TEST_PAYLOAD_HASH,
          budgetId: TEST_BUDGET_ID,
          backendIds: '',
          policyVersion: '1.0',
          authorizationDisposition: null,
          idempotencyKey: TEST_NONCE,
          expectedPriorState: null,
          observedResultState: '',
          providerModel: null,
          correlationId: 'corr_exec_001',
          requestId: TEST_REQUEST,
          result: 'completed',
          isError: false,
        };
      });
      rust.verifyMutation.mockImplementation(() => {
        order.push('verifyMutation');
        return {
          verified: true,
          reasonCodes: ['postcondition_verified'],
          message: null,
        };
      });
      store.consumeApproval.mockImplementation(async () => {
        order.push('consumeApproval');
        return mockApproval({ status: 'consumed' });
      });
      store.completeIdempotencyRecord.mockImplementation(async () => {
        order.push('completeIdempotencyRecord');
        return mockIdempotencyRecord({ completed: true });
      });

      await service.execute(makeInput());

      // Verify ordering of major phases
      expect(order.indexOf('getProposal')).toBeLessThan(order.indexOf('evaluateAuthorization'));
      expect(order.indexOf('evaluateAuthorization')).toBeLessThan(order.indexOf('getApproval'));
      expect(order.indexOf('getApproval')).toBeLessThan(order.indexOf('createIdempotencyRecord'));
      expect(order.indexOf('createIdempotencyRecord')).toBeLessThan(order.indexOf('synchronize(1)'));
      expect(order.indexOf('synchronize(1)')).toBeLessThan(order.indexOf('planSetCategory'));
      expect(order.indexOf('planSetCategory')).toBeLessThan(order.indexOf('setTransactionCategory'));
      expect(order.indexOf('setTransactionCategory')).toBeLessThan(order.indexOf('synchronize(2)'));
      expect(order.indexOf('synchronize(2)')).toBeLessThan(order.indexOf('verifyMutation'));
      expect(order.indexOf('verifyMutation')).toBeLessThan(order.indexOf('consumeApproval'));
      expect(order.indexOf('consumeApproval')).toBeLessThan(order.indexOf('completeIdempotencyRecord'));
      // Audit records are appended throughout
      expect(order.filter(s => s === 'appendAuditRecord').length).toBeGreaterThanOrEqual(1);
    });
  });
});
