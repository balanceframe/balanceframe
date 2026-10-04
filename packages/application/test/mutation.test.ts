/** Contract tests for proposal-bound categorization execution and verified ledger writes. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { SqliteWorkflowStore, canonicalProposalHash, ProposalAcquisitionError } from '@balanceframe/workflow-store';

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
  ActionProposal,
  ProposalApproval,
  IdempotencyRecord,
  AuditRecord,
  AppendAuditInput,
} from '@balanceframe/workflow-store';

import type {
  BudgetLedger,
  SetCategoryResult,
  LedgerSnapshotResult,
} from '@balanceframe/actual-adapter';

import type { Transaction, Category, ProtocolSnapshot } from '@balanceframe/protocol-generated';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_ACTOR = 'usr_mutator';
const TEST_REQUEST = 'req_cat_exec_001';
const TEST_PROPOSAL_ID = 'prop_abc123';
const TEST_APPROVAL_ID = 'appr_def456';
const TEST_TX_ID = 'tx_001';
const TEST_CATEGORY_ID = 'cat_food';
const TEST_NONCE = 'idem_nonce_001';
const TEST_PLAN_ID = 'plan_a1b2c3d4';
const TEST_BUDGET_ID = 'budget_main';
const TEST_REVIEW_ID = 'review_linked';
const REVIEW_PROVENANCE = {
  budgetId: TEST_BUDGET_ID,
  transactionId: TEST_TX_ID,
  categoryId: 'cat_previous',
  status: 'pending_review',
  version: 3,
};

const TEST_NATIVE_PLAN = {
  planId: TEST_PLAN_ID,
  transactionId: TEST_TX_ID,
  currentCategoryId: null,
  proposedCategoryId: TEST_CATEGORY_ID,
  hash: 'plan_hash_001',
  postconditions: [{ type: 'CategoryExists', categoryId: TEST_CATEGORY_ID }],
};

const TEST_COMPOSITE = {
  operations: [],
  reallocations: [],
  transferRecommendations: [],
  ledgerProjections: [],
  evidenceReferences: [],
  nativePayloadHash: TEST_NATIVE_PLAN.hash,
};
const TEST_PRECONDITIONS = {
  transactionId: TEST_TX_ID,
  accountId: 'acct_001',
  amount: { minorUnits: '5000', currency: 'USD' },
  currentCategoryId: null,
  actualVersion: '2026.07.01',
  nativePlan: TEST_NATIVE_PLAN,
  snapshotSchemaVersion: '1.0',
};
const TEST_PAYLOAD_HASH = canonicalProposalHash({
  operation: 'set_category',
  budgetId: TEST_BUDGET_ID,
  payload: {
    kind: 'set_category',
    transactionId: TEST_TX_ID,
    categoryId: TEST_CATEGORY_ID,
    composite: TEST_COMPOSITE,
  },
  preconditions: TEST_PRECONDITIONS,
  actorId: TEST_ACTOR,
  policyVersion: '1.0',
  expiresAt: '2099-12-31T23:59:59Z',
});

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

function mockProposal(
  overrides: Partial<ActionProposal> = {},
): Extract<ActionProposal, { operation: 'set_category' }> {
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
    operation: 'set_category',
    budgetId: TEST_BUDGET_ID,
    spaceId: 'space_main',
    payload: {
      kind: 'set_category',
      transactionId: TEST_TX_ID,
      categoryId: TEST_CATEGORY_ID,
      composite: TEST_COMPOSITE,
    },
    policyVersion: '1.0',
    governancePolicyVersion: 'space-policy-1',
    requesterMembershipId: 'membership-proposer',
    preconditions: JSON.stringify(TEST_PRECONDITIONS),
    expiresAt: '2099-12-31T23:59:59Z',
    actorId: TEST_ACTOR,
    provenance: 'model-derived',
    providerModel: 'openai/gpt-4',
    correlationId: 'corr_exec_001',
    supersededAt: null,
    createdAt: '2026-07-20T10:00:00Z',
    ...overrides,
  } as Extract<ActionProposal, { operation: 'set_category' }>;
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
function mockLinkedProposal(
  overrides: Partial<ActionProposal> = {},
): Extract<ActionProposal, { operation: 'set_category' }> {
  return mockProposal({
    ...overrides,
    preconditions: JSON.stringify({
      ...TEST_PRECONDITIONS,
      reviewId: TEST_REVIEW_ID,
      reviewProvenance: REVIEW_PROVENANCE,
    }),
  });
}


function mockApproval(overrides: Partial<ProposalApproval> = {}): ProposalApproval {
  return {
    id: TEST_APPROVAL_ID,
    proposalId: TEST_PROPOSAL_ID,
    payloadHash: TEST_PAYLOAD_HASH,
    actorId: 'usr_approver',
    reauthenticatedSessionId: 'session-approver',
    reauthenticatedAt: '2026-07-20T10:29:00Z',
    membershipId: 'membership-approver',
    governancePolicyVersion: 'space-policy-1',
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
    status: 'in_progress',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    serialisedEffect: JSON.stringify({
      operation: 'set_category',
      payload: {
        kind: 'set_category',
        transactionId: TEST_TX_ID,
        categoryId: TEST_CATEGORY_ID,
        composite: TEST_COMPOSITE,
      },
      preconditions: TEST_PRECONDITIONS,
    }),
    serialisedResult: null,
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
  } as SetCategoryResult;
}

/** Helper to build a backup-verification audit record for testing. */
function mockBackupVerification(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'audit_backup_001',
    classification: 'backup_verification',
    timestamp: new Date().toISOString(),
    actorId: TEST_ACTOR,
    operation: null,
    proposalId: null,
    payloadHash: TEST_PAYLOAD_HASH,
    budgetId: TEST_BUDGET_ID,
    backendIds: '',
    policyVersion: '1.0',
    authorizationDisposition: null,
    idempotencyKey: null,
    expectedPriorState: null,
    observedResultState: null,
    providerModel: null,
    correlationId: null,
    requestId: TEST_REQUEST,
    result: 'verified',
    isError: false,
    ...overrides,
  } as AuditRecord;
}

function mockExecutionAcquisition() {
  return {
    claim: { record: mockIdempotencyRecord(), isOwner: true },
    approvals: [mockApproval()],
    auditRecord: mockBackupVerification({
      classification: 'execution_started',
      result: 'started',
      authorizationDisposition: { kind: 'authorized_without_approval' },
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

interface StoreMock extends WorkflowStore {
  isProposalReviewProvenanceCurrent: Mock;
  completeVerifiedCategorizationReview: Mock;
  getProposal: Mock;
  getIdempotencyRecord: Mock;
  completeIdempotencyRecord: Mock;
  appendAuditRecord: Mock;
  queryAuditRecords: Mock;
  acquireProposalExecution: Mock;
}

function createStoreMock(): StoreMock {
  return {
    getProposal: vi.fn(),
    getIdempotencyRecord: vi.fn(),
    isProposalReviewProvenanceCurrent: vi.fn(),
    completeVerifiedCategorizationReview: vi.fn(),
    acquireProposalExecution: vi.fn(),
    completeIdempotencyRecord: vi.fn(),
    appendAuditRecord: vi.fn(),
    queryAuditRecords: vi.fn(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CategorizationMutationService', () => {
  let store: StoreMock;
  let ledger: LedgerMock;
  let rust: RustProtocolMock;
  let service: CategorizationMutationService;

  function makeInput(
    overrides: Partial<ExecuteCategorizationInput> = {},
  ): ExecuteCategorizationInput {
    return {
      requestId: TEST_REQUEST,
      actorId: TEST_ACTOR,
      auth: { method: 'session', actorId: TEST_ACTOR, sessionId: 'session-executor' },
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

    store.acquireProposalExecution.mockResolvedValue(mockExecutionAcquisition());
    // ── Default happy-path mocks ──────────────────────────────────────

    // Proposal exists, active, hash matches
    store.getProposal.mockResolvedValue(mockProposal());
    store.getIdempotencyRecord.mockResolvedValue(null);

    store.isProposalReviewProvenanceCurrent.mockResolvedValue(true);

    store.completeIdempotencyRecord.mockImplementation(async (
      _key,
      errorMessage,
      isRetryable,
      serialisedResult,
    ) => mockIdempotencyRecord({
      completed: true,
      status: errorMessage ? (isRetryable ? 'retryable_failed' : 'terminal_failed') : 'succeeded',
      serialisedResult: errorMessage ? null : (serialisedResult ?? null),
      errorMessage: errorMessage ?? null,
    }));

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
      observedResultState: JSON.stringify({
        transactionId: TEST_TX_ID,
        newCategoryId: TEST_CATEGORY_ID,
      }),
      providerModel: null,
      correlationId: 'corr_exec_001',
      requestId: TEST_REQUEST,
      result: 'completed',
      isError: false,
    } as AuditRecord);
  });

  it('executes the exact singleton base operation emitted by Review', async () => {
    store.getProposal.mockResolvedValue(mockProposal({
      payload: {
        kind: 'set_category',
        transactionId: TEST_TX_ID,
        categoryId: TEST_CATEGORY_ID,
        composite: {
          ...TEST_COMPOSITE,
          operations: [{
            operation: 'set_category',
            transactionId: TEST_TX_ID,
            accountId: 'acct_001',
            categoryId: TEST_CATEGORY_ID,
            direction: 'incoming',
            amount: mockMoney('5000', 'USD'),
          }],
        },
      },
      preconditions: JSON.stringify({
        ...TEST_PRECONDITIONS,
        actualVersion: '2026.07.01',
        transaction: {
          id: TEST_TX_ID,
          accountId: 'acct_001',
          categoryId: null,
          direction: 'incoming',
          amount: mockMoney('5000', 'USD'),
        },
      }),
    }));

    const result = await service.execute(makeInput());

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(ledger.setTransactionCategory).toHaveBeenCalledOnce();
  });

  it.each([
    { changed: 'account', transaction: mockTransaction({ accountId: 'acct_private' }) },
    { changed: 'amount', transaction: mockTransaction({ amount: mockMoney('5001') }) },
    { changed: 'direction', transaction: mockTransaction({ amount: mockMoney('-5000') }) },
    { changed: 'currency', transaction: mockTransaction({ amount: mockMoney('5000', 'EUR') }) },
    { changed: 'transaction identity', transaction: mockTransaction(), id: 'tx_different' },
  ])('refuses a write when the nested approved $changed changes', async ({ transaction, id }) => {
    store.getProposal.mockResolvedValue(mockProposal({
      preconditions: JSON.stringify({
        ...TEST_PRECONDITIONS,
        actualVersion: '2026.07.01',
        transaction: {
          id: id ?? TEST_TX_ID,
          accountId: 'acct_001',
          categoryId: null,
          direction: 'incoming',
          amount: mockMoney('5000', 'USD'),
        },
      }),
    }));
    ledger.synchronize.mockResolvedValue({
      snapshot: mockProtocolSnapshot({ transactions: [transaction] }),
    } as LedgerSnapshotResult);

    const result = await service.execute(makeInput());

    expect(result.success).toBe(false);
    expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
  });

  it('recategorizes an already categorized transaction using nested prior-category facts', async () => {
    store.getProposal.mockResolvedValue(mockProposal({
      preconditions: JSON.stringify({
        ...TEST_PRECONDITIONS,
        amount: mockMoney('-5000'),
        currentCategoryId: 'cat_old',
        nativePlan: { ...TEST_NATIVE_PLAN, currentCategoryId: 'cat_old' },
        transaction: {
          id: TEST_TX_ID,
          accountId: 'acct_001',
          categoryId: 'cat_old',
          direction: 'outgoing',
          amount: mockMoney('5000'),
        },
      }),
    }));
    ledger.synchronize.mockResolvedValue({
      snapshot: mockProtocolSnapshot({
        transactions: [mockTransaction({ categoryId: 'cat_old', amount: mockMoney('-5000') })],
      }),
    } as LedgerSnapshotResult);
    rust.planSetCategory.mockReturnValue({
      planId: TEST_PLAN_ID,
      transactionId: TEST_TX_ID,
      currentCategoryId: 'cat_old',
      proposedCategoryId: TEST_CATEGORY_ID,
      hash: 'plan_hash_001',
      postconditions: [{ type: 'CategoryExists', categoryId: TEST_CATEGORY_ID }],
    });

    ledger.setTransactionCategory.mockResolvedValue(
      mockSetCategoryResult({ previousCategoryId: 'cat_old' }),
    );
    const result = await service.execute(makeInput());

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(ledger.setTransactionCategory).toHaveBeenCalledOnce();
    expect(ledger.setTransactionCategory).toHaveBeenCalledWith(TEST_TX_ID, TEST_CATEGORY_ID, 'cat_old');


  });
  it('does not write when proposal execution acquisition cannot persist its audit', async () => {
    store.acquireProposalExecution.mockRejectedValue(new Error('Acquisition audit write failed'));

    const result = await service.execute(makeInput());

    expect(result.success).toBe(false);
    expect(store.acquireProposalExecution).toHaveBeenCalledOnce();
    expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
  });

  it('denies a revoked executor before any ledger write', async () => {
    store.acquireProposalExecution.mockRejectedValue(
      new ProposalAcquisitionError('authorization_denied', 'Execution authorization denied'),
    );

    const result = await service.execute(makeInput());
    expect(result.success).toBe(false);
    expect(result.reasonCodes).toContain('authorization_denied');
    expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
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
  });

  // =========================================================================
  // Proposal expiry
  // =========================================================================

  describe('proposal expiry', () => {
    it('rejects when proposal is expired', async () => {
      store.getProposal.mockResolvedValue(mockProposal({ expiresAt: '2020-01-01T00:00:00Z' }));
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('proposal_expired');
      // Expired proposals never acquire execution authority.
      expect(store.acquireProposalExecution).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Backup verification (strengthened)
  // =========================================================================

  describe('backup verification', () => {
    it('proceeds normally when requireBackupVerification is false (default)', async () => {
      const result = await service.execute(makeInput());
      expect(result.success).toBe(true);
      expect(store.queryAuditRecords).not.toHaveBeenCalled();
    });

    it('rejects execution when no backup audit record exists', async () => {
      store.queryAuditRecords.mockResolvedValue([]);
      const svc = new CategorizationMutationService(store, ledger, rust, {
        requireBackupVerification: true,
      });
      const result = await svc.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toEqual(['backup_not_verified']);
    });

    it('rejects when backup record has wrong budgetId', async () => {
      store.queryAuditRecords.mockResolvedValue([
        mockBackupVerification({ budgetId: 'budget_other' }),
      ]);
      const svc = new CategorizationMutationService(store, ledger, rust, {
        requireBackupVerification: true,
      });
      const result = await svc.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('backup_not_verified');
    });

    it('rejects when backup record result is not verified/completed', async () => {
      store.queryAuditRecords.mockResolvedValue([mockBackupVerification({ result: 'failed' })]);
      const svc = new CategorizationMutationService(store, ledger, rust, {
        requireBackupVerification: true,
      });
      const result = await svc.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('backup_not_verified');
    });

    it('rejects when backup record is stale (too old)', async () => {
      const oldTimestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days
      store.queryAuditRecords.mockResolvedValue([
        mockBackupVerification({ timestamp: oldTimestamp }),
      ]);
      const svc = new CategorizationMutationService(store, ledger, rust, {
        requireBackupVerification: true,
      });
      const result = await svc.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('backup_not_verified');
    });

    it('proceeds when matching backup record is fresh, verified, and has correct budget', async () => {
      store.queryAuditRecords.mockResolvedValue([mockBackupVerification()]);
      const svc = new CategorizationMutationService(store, ledger, rust, {
        requireBackupVerification: true,
      });
      const result = await svc.execute(makeInput());
      expect(result.success).toBe(true);
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

    it('does not report verification or write when native planning is unavailable', async () => {
      rust.planSetCategory.mockImplementation(() => {
        throw new Error('Native planner unavailable');
      });

      const result = await service.execute(makeInput());

      expect(result.success).toBe(false);
      expect(result.verified).toBe(false);
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
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
    it.each([
      { case: 'missing plan', nativePlan: undefined, nativePayloadHash: TEST_NATIVE_PLAN.hash },
      { case: 'changed native algorithm hash', nativePlan: { ...TEST_NATIVE_PLAN, hash: 'old-algorithm' }, nativePayloadHash: 'old-algorithm' },
      { case: 'tampered postconditions', nativePlan: { ...TEST_NATIVE_PLAN, postconditions: [] }, nativePayloadHash: TEST_NATIVE_PLAN.hash },
      { case: 'different approved payload hash', nativePlan: TEST_NATIVE_PLAN, nativePayloadHash: 'other-hash' },
    ])('denies $case before a ledger write', async ({ nativePlan, nativePayloadHash }) => {
      store.getProposal.mockResolvedValue(mockProposal({
        preconditions: JSON.stringify({ ...TEST_PRECONDITIONS, nativePlan }),
        payload: {
          kind: 'set_category',
          transactionId: TEST_TX_ID,
          categoryId: TEST_CATEGORY_ID,
          composite: { ...TEST_COMPOSITE, nativePayloadHash },
        },
      }));
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('precondition_mismatch');
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    });

    it('denies a stale mutation algorithm without acquiring execution', async () => {
      store.getProposal.mockResolvedValue(mockProposal({ policyVersion: 'obsolete' }));
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('policy_version_mismatch');
      expect(store.acquireProposalExecution).not.toHaveBeenCalled();
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    });

    it.each(['actualVersion', 'snapshotSchemaVersion'] as const)('denies missing captured %s before writing', async (field) => {
      store.getProposal.mockResolvedValue(mockProposal({
        preconditions: JSON.stringify({ ...TEST_PRECONDITIONS, [field]: undefined }),
      }));
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('precondition_mismatch');
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    });

    it('denies a changed snapshot schema before writing', async () => {
      ledger.synchronize.mockResolvedValue({
        snapshot: mockProtocolSnapshot({ schemaVersion: 'changed' }),
      } as LedgerSnapshotResult);
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('precondition_mismatch');
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    });

    it('denies a deleted category before writing', async () => {
      ledger.synchronize.mockResolvedValue({
        snapshot: mockProtocolSnapshot({ categories: [mockCategory({ deleted: true })] }),
      } as LedgerSnapshotResult);
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('category_not_found');
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    });

    it('rejects when plan currentCategoryId does not match proposal preconditions', async () => {
      const proposal = mockProposal({
        preconditions: JSON.stringify({ currentCategoryId: null }),
      });
      store.getProposal.mockResolvedValue(proposal);

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
      const proposal = mockProposal({
        preconditions: JSON.stringify({ currentCategoryId: 'cat_old' }),
      });
      store.getProposal.mockResolvedValue(proposal);

      const tx = mockTransaction({ categoryId: 'cat_different' });
      ledger.synchronize.mockResolvedValue({
        snapshot: mockProtocolSnapshot({ transactions: [tx] }),
        health: { status: 'healthy', lastCheckedAt: '2026-07-20T11:00:00Z', details: {} },
        watermark: { lastSyncAt: '2026-07-20T11:00:00Z', dataVersion: 'v2' },
      });

      rust.planSetCategory.mockReturnValue({
        planId: TEST_PLAN_ID,
        transactionId: TEST_TX_ID,
        currentCategoryId: 'cat_different',
        proposedCategoryId: TEST_CATEGORY_ID,
        hash: 'plan_hash_002',
        postconditions: [{ type: 'CategoryExists', categoryId: TEST_CATEGORY_ID }],
      });

      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('precondition_mismatch');
    });
    it.each([
      {
        fact: 'accountId',
        actualVersion: '2026.07.01',
        transaction: mockTransaction({ accountId: 'acct_changed' }),
      },
      {
        fact: 'amount',
        actualVersion: '2026.07.01',
        transaction: mockTransaction({ amount: mockMoney('5001', 'USD') }),
      },
      {
        fact: 'actualVersion',
        actualVersion: '2026.07.02',
        transaction: mockTransaction(),
      },
    ])('rejects execution when approved $fact changes with category unchanged', async ({
      actualVersion,
      transaction,
    }) => {
      store.getProposal.mockResolvedValue(mockProposal());
      ledger.synchronize.mockResolvedValue({
        snapshot: mockProtocolSnapshot({ actualVersion, transactions: [transaction] }),
      } as LedgerSnapshotResult);

      const result = await service.execute(makeInput());

      expect(result.success).toBe(false);
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Write-enabled category update through ledger
  // =========================================================================

  describe('write-enabled category update', () => {
    it('rejects when setTransactionCategory fails', async () => {
      ledger.setTransactionCategory.mockRejectedValue(new Error('Write rejected in Observe mode'));
      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('write_failed');
    });

  });

  // =========================================================================
  // Reread / postcondition verification - success requires verification
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

    it('returns success=true when postconditions pass', async () => {
      const result = await service.execute(makeInput());
      expect(result.success).toBe(true);
      expect(result.verified).toBe(true);
    });

    it('returns success=false when verification fails after write', async () => {
      rust.verifyMutation.mockReturnValue({
        verified: false,
        reasonCodes: ['postcondition_failed', 'category_not_found'],
        message: 'Category no longer exists',
      });

      const result = await service.execute(makeInput());
      // Write occurred but postcondition verification failed -> overall failure
      expect(result.success).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.reasonCodes).toContain('postcondition_failed');
    });

    it('returns success=false when verfication throws after write', async () => {
      rust.verifyMutation.mockImplementation(() => {
        throw new Error('Verification crashed');
      });

      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.reasonCodes).toContain('verify_failed');
    });

    it('returns success=false when post-write reread fails', async () => {
      // Second synchronize call fails
      ledger.synchronize
        .mockResolvedValueOnce({
          snapshot: mockProtocolSnapshot(),
          health: { status: 'healthy', lastCheckedAt: '2026-07-20T11:00:00Z', details: {} },
          watermark: { lastSyncAt: '2026-07-20T11:00:00Z', dataVersion: 'v2' },
        })
        .mockRejectedValueOnce(new Error('Connection lost'));

      const result = await service.execute(makeInput());
      expect(result.success).toBe(false);
      expect(result.reasonCodes).toContain('reread_failed');
    });
  });

  // =========================================================================
  // Append-only audit results - failure audit on every rejection
  // =========================================================================

  describe('append-only audit results', () => {
    it('appends execution_completed audit for successful mutation', async () => {
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
          result: 'completed',
        }),
      );
    });

    it('appends execution_failed audit when postcondition verification fails', async () => {
      rust.verifyMutation.mockReturnValue({
        verified: false,
        reasonCodes: ['postcondition_failed'],
        message: 'Verification failed',
      });
      await service.execute(makeInput());
      // Should have an execution_failed classification
      const auditCalls = (store.appendAuditRecord as Mock).mock.calls;
      const failureAudit = auditCalls.find(
        (c: [AppendAuditInput]) => c[0].classification === 'execution_failed',
      );
      expect(failureAudit).toBeDefined();
      expect(failureAudit[0]).toMatchObject({
        isError: true,
        result: 'verification_failed',
      });
    });

    it('appends execution_failed audit when proposal not found', async () => {
      store.getProposal.mockResolvedValue(null);
      await service.execute(makeInput());
      const auditCalls = (store.appendAuditRecord as Mock).mock.calls;
      const failureAudit = auditCalls.find(
        (c: [AppendAuditInput]) => c[0].classification === 'execution_failed',
      );
      expect(failureAudit).toBeDefined();
      expect(failureAudit[0].result).toContain('proposal_not_found');
    });





    it('contains observed result state in completion audit', async () => {
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
  // Never blindly repeat committed writes + write call count assertions
  // =========================================================================

  describe('never blindly repeat committed writes', () => {
    it('does not repeat a ledger write for an exact-key replay', async () => {
      const record = mockIdempotencyRecord({
        completed: true,
        status: 'succeeded',
        serialisedResult: JSON.stringify({
          verified: true,
          transactionId: TEST_TX_ID,
          previousCategoryId: null,
          newCategoryId: TEST_CATEGORY_ID,
          planId: TEST_PLAN_ID,
        }),
      });
      store.getIdempotencyRecord.mockResolvedValue(record);
      store.acquireProposalExecution.mockResolvedValue({
        claim: { record, isOwner: false },
        approvals: [],
        auditRecord: null,
      });

      await service.execute(makeInput());
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    });

    it('calls setTransactionCategory exactly once on successful execution', async () => {
      await service.execute(makeInput());
      expect(ledger.setTransactionCategory).toHaveBeenCalledTimes(1);
    });

    it('calls synchronize exactly twice on successful execution', async () => {
      await service.execute(makeInput());
      // Once before planning, once after write for verification
      expect(ledger.synchronize).toHaveBeenCalledTimes(2);
    });

    it('persists audit result with observed state to prevent blind repeat', async () => {
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
  // Successful execution - all steps in correct order
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
      expect(store.acquireProposalExecution).toHaveBeenCalledOnce();
      expect(result.auditRecordId).toBeDefined();
      expect(result.reasonCodes).toContain('postcondition_verified');
    });

    it('acquires proposal execution before planning and writing', async () => {
      const order: string[] = [];
      store.getProposal.mockImplementation(async () => {
        order.push('getProposal');
        return mockProposal();
      });
      store.acquireProposalExecution.mockImplementation(async () => {
        order.push('acquireProposalExecution');
        return mockExecutionAcquisition();
      });

      let syncCount = 0;
      ledger.synchronize.mockImplementation(async () => {
        syncCount++;
        order.push(`synchronize(${syncCount})`);
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
      rust.verifyMutation.mockImplementation(() => {
        order.push('verifyMutation');
        return { verified: true, reasonCodes: ['postcondition_verified'], message: null };
      });
      store.appendAuditRecord.mockImplementation(async (input: AppendAuditInput) => {
        order.push(input.classification);
        return mockBackupVerification({
          id: 'audit_001',
          classification: input.classification,
          result: 'completed',
        });
      });
      store.completeIdempotencyRecord.mockImplementation(async (
        _key,
        errorMessage,
        _isRetryable,
        serialisedResult,
      ) => {
        order.push('completeIdempotencyRecord');
        return mockIdempotencyRecord({
          completed: true,
          status: errorMessage ? 'terminal_failed' : 'succeeded',
          serialisedResult: errorMessage ? null : (serialisedResult ?? null),
          errorMessage: errorMessage ?? null,
        });
      });

      await service.execute(makeInput());

      expect(order.indexOf('getProposal')).toBeLessThan(order.indexOf('acquireProposalExecution'));
      expect(order.indexOf('acquireProposalExecution')).toBeLessThan(order.indexOf('synchronize(1)'));
      expect(order.indexOf('synchronize(1)')).toBeLessThan(order.indexOf('planSetCategory'));
      expect(order.indexOf('planSetCategory')).toBeLessThan(order.indexOf('setTransactionCategory'));
      expect(order.indexOf('setTransactionCategory')).toBeLessThan(order.indexOf('synchronize(2)'));
      expect(order.indexOf('synchronize(2)')).toBeLessThan(order.indexOf('verifyMutation'));
      expect(order.indexOf('verifyMutation')).toBeLessThan(order.indexOf('execution_completed'));
    });
  });

  describe('verified review-linked categorization', () => {

    it.each(['reread', 'verification'] as const)(
      'keeps a linked review pending when post-write %s is uncertain',
      async (failure) => {
        store.getProposal.mockResolvedValue(mockLinkedProposal());
        if (failure === 'reread') {
          ledger.synchronize
            .mockResolvedValueOnce({
              snapshot: mockProtocolSnapshot(),
              health: { status: 'healthy', lastCheckedAt: '', details: {} },
              watermark: { lastSyncAt: '', dataVersion: '' },
            } as LedgerSnapshotResult)
            .mockRejectedValueOnce(new Error('reread unavailable'));
        } else {
          rust.verifyMutation.mockReturnValue({
            verified: false,
            reasonCodes: ['target_category_unverified'],
            message: 'Target category was not observed',
          });
        }

        const result = await service.execute(makeInput());

        expect(result.verified).toBe(false);
        expect(store.completeVerifiedCategorizationReview).not.toHaveBeenCalled();
        expect(store.isProposalReviewProvenanceCurrent).toHaveBeenCalledWith(TEST_PROPOSAL_ID);
        expect(ledger.setTransactionCategory).toHaveBeenCalledOnce();
      },
    );

    it('rejects stale review provenance before acquisition or SDK write', async () => {
      store.getProposal.mockResolvedValue(mockLinkedProposal());
      store.isProposalReviewProvenanceCurrent.mockResolvedValue(false);
      const result = await service.execute(makeInput());

      expect(result.reasonCodes).toContain('review_reference_mismatch');
      expect(store.isProposalReviewProvenanceCurrent).toHaveBeenCalledWith(TEST_PROPOSAL_ID);
      expect(store.acquireProposalExecution).not.toHaveBeenCalled();
      expect(ledger.synchronize).not.toHaveBeenCalled();
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
      expect(store.completeVerifiedCategorizationReview).not.toHaveBeenCalled();
    });

    it('recovers the stored verified result without another SDK write', async () => {
      const serialisedResult = JSON.stringify({
        verified: true,
        transactionId: TEST_TX_ID,
        previousCategoryId: null,
        newCategoryId: TEST_CATEGORY_ID,
        planId: TEST_PLAN_ID,
      });
      store.getIdempotencyRecord.mockResolvedValue(mockIdempotencyRecord({
        status: 'succeeded',
        completed: true,
        serialisedResult,
      }));
      store.getProposal.mockResolvedValue(mockLinkedProposal({
        supersededAt: '2026-07-20T12:00:00Z',
      }));
      store.isProposalReviewProvenanceCurrent.mockResolvedValue(false);
      store.acquireProposalExecution.mockResolvedValue({
        claim: {
          record: mockIdempotencyRecord({
            status: 'succeeded',
            completed: true,
            serialisedResult,
          }),
          isOwner: false,
        },
        approvals: [],
        auditRecord: null,
      });

      const result = await service.execute(makeInput());

      expect(result).toMatchObject({
        success: true,
        verified: true,
        transactionId: TEST_TX_ID,
        previousCategoryId: null,
        newCategoryId: TEST_CATEGORY_ID,
        planId: TEST_PLAN_ID,
        reasonCodes: ['idempotency_replay'],
      });
      expect(store.isProposalReviewProvenanceCurrent).not.toHaveBeenCalled();
      expect(store.completeVerifiedCategorizationReview).toHaveBeenCalledWith(TEST_NONCE);
      expect(ledger.synchronize).not.toHaveBeenCalled();
      expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
    });

    it.each(['missing', 'malformed', 'mismatch'] as const)(
      'does not replay or finalize a successful record with %s stored result',
      async (caseName) => {
        const serialisedResult = caseName === 'missing' ? null
          : caseName === 'malformed' ? '{'
            : JSON.stringify({
              verified: true,
              transactionId: TEST_TX_ID,
              previousCategoryId: null,
              newCategoryId: 'different-category',
              planId: TEST_PLAN_ID,
            });
        store.getIdempotencyRecord.mockResolvedValue(mockIdempotencyRecord({
          status: 'succeeded',
          completed: true,
          serialisedResult,
        }));
        store.getProposal.mockResolvedValue(mockLinkedProposal({
          supersededAt: '2026-07-20T12:00:00Z',
        }));
        store.acquireProposalExecution.mockResolvedValue({
          claim: {
            record: mockIdempotencyRecord({
              status: 'succeeded',
              completed: true,
              serialisedResult,
            }),
            isOwner: false,
          },
          approvals: [],
          auditRecord: null,
        });

        const result = await service.execute(makeInput());

        expect(result.success).toBe(false);
        expect(result.verified).toBe(false);
        const resultCode = caseName === 'missing' ? 'idempotency_result_unavailable'
          : caseName === 'malformed' ? 'idempotency_result_invalid'
            : 'idempotency_result_mismatch';
        expect(result.reasonCodes).toContain(resultCode);
        expect(result.reasonCodes).not.toContain('idempotency_replay');
        expect(store.completeVerifiedCategorizationReview).not.toHaveBeenCalled();
        expect(ledger.synchronize).not.toHaveBeenCalled();
        expect(ledger.setTransactionCategory).not.toHaveBeenCalled();
      },
    );
  });
});
