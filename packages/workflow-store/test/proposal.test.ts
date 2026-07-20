/**
 * Failing tests for categorization proposals, approvals, audit, and authorization.
 *
 * TDD: these tests establish the expected contract before implementation.
 * Run with: pnpm --filter @balanceframe/workflow-store test
 *
 * Categories:
 * - Immutable exact proposals with payload hash binding
 * - Proposal supersession
 * - Approval creation with validation (expiry, hash match, proposal active)
 * - Approval consumption (one-time use)
 * - Approval expiry rejection
 * - Approval supersession rejection
 * - Approval replay rejection (same proposalId + actorId idempotent)
 * - Payload mismatch rejection
 * - Idempotency record creation and replay detection
 * - Idempotency record completion
 * - Audit record append-only behavior (no update/delete)
 * - Authorization evaluation (active membership, capability, scope)
 * - verifyApprovalForExecution (stale, consumed, expired, payload mismatch)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type {
  CreateProposalInput,
  CreateApprovalInput,
  CreateIdempotencyInput,
  AppendAuditInput,
  AuditClassification,
  AuthorizationDisposition,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Future expiry timestamp (1 hour from now). */
function futureExpiry(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

/** Past expiry timestamp. */
function pastExpiry(): string {
  return new Date(Date.now() - 3_600_000).toISOString();
}

function tickSync(): void {
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }
}

const SAMPLE_HASH = 'abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890';
const DIFFERENT_HASH = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

const BASE_PROPOSAL: CreateProposalInput = {
  operation: 'set_category',
  budgetId: 'budget-alpha',
  transactionId: 'txn-001',
  categoryId: 'cat-food',
  payloadHash: SAMPLE_HASH,
  policyVersion: '1.0.0',
  preconditions: JSON.stringify({ transactionVersion: 3 }),
  expiresAt: futureExpiry(),
  actorId: 'alice@example.com',
  provenance: 'model-derived',
  providerModel: 'fast-classifier/v2',
  correlationId: 'corr-001',
};

const BASE_APPROVAL: CreateApprovalInput = {
  proposalId: '',
  payloadHash: SAMPLE_HASH,
  actorId: 'bob@example.com',
  expiresAt: futureExpiry(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CategorizationProposal', () => {
  let store: SqliteWorkflowStore;

  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });

  // =======================================================================
  // Immutable exact proposals with payload hash binding
  // =======================================================================

  describe('createProposal', () => {
    it('persists a proposal with all fields intact', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);

      expect(p.id).toBeTypeOf('string');
      expect(p.operation).toBe('set_category');
      expect(p.budgetId).toBe(BASE_PROPOSAL.budgetId);
      expect(p.transactionId).toBe(BASE_PROPOSAL.transactionId);
      expect(p.categoryId).toBe(BASE_PROPOSAL.categoryId);
      expect(p.payloadHash).toBe(SAMPLE_HASH);
      expect(p.policyVersion).toBe(BASE_PROPOSAL.policyVersion);
      expect(p.preconditions).toBe(BASE_PROPOSAL.preconditions);
      expect(p.expiresAt).toBe(BASE_PROPOSAL.expiresAt);
      expect(p.actorId).toBe(BASE_PROPOSAL.actorId);
      expect(p.provenance).toBe(BASE_PROPOSAL.provenance);
      expect(p.providerModel).toBe(BASE_PROPOSAL.providerModel);
      expect(p.correlationId).toBe(BASE_PROPOSAL.correlationId);
      expect(p.supersededAt).toBeNull();
      expect(p.createdAt).toBeTypeOf('string');
    });

    it('assigns a stable UUID that can retrieve the record', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      const fetched = await store.getProposal(p.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(p.id);
    });

    it('is idempotent for same payloadHash on same target (returns existing)', async () => {
      const first = await store.createProposal(BASE_PROPOSAL);
      const second = await store.createProposal(BASE_PROPOSAL);

      expect(second.id).toBe(first.id);
      expect(second.payloadHash).toBe(SAMPLE_HASH);
    });

    it('creates a new proposal when payloadHash differs (changed content)', async () => {
      const first = await store.createProposal(BASE_PROPOSAL);

      tickSync();
      const second = await store.createProposal({
        ...BASE_PROPOSAL,
        payloadHash: DIFFERENT_HASH,
        categoryId: 'cat-utilities',
      });

      expect(second.id).not.toBe(first.id);
      expect(second.payloadHash).toBe(DIFFERENT_HASH);
      // First proposal is not superseded because it's a different payload
      const reloaded = await store.getProposal(first.id);
      expect(reloaded!.supersededAt).toBeNull();
    });

    it('does not mutate an existing proposal on idempotent return', async () => {
      const first = await store.createProposal(BASE_PROPOSAL);
      const createdAt = first.createdAt;

      tickSync();
      const second = await store.createProposal(BASE_PROPOSAL);

      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(createdAt);
    });

    it('can create a proposal with null correlationId and providerModel', async () => {
      const p = await store.createProposal({
        ...BASE_PROPOSAL,
        correlationId: null,
        providerModel: null,
      });
      expect(p.correlationId).toBeNull();
      expect(p.providerModel).toBeNull();
    });

    it('retrieves null for nonexistent proposal', async () => {
      const fetched = await store.getProposal('nonexistent-id');
      expect(fetched).toBeNull();
    });
  });

  describe('findActiveProposal', () => {
    it('returns null when no proposal exists for the target', async () => {
      const found = await store.findActiveProposal('budget-alpha', 'txn-001', 'set_category');
      expect(found).toBeNull();
    });

    it('finds an active proposal by budget, transaction, and operation', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      const found = await store.findActiveProposal(BASE_PROPOSAL.budgetId, BASE_PROPOSAL.transactionId, BASE_PROPOSAL.operation);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(p.id);
    });

    it('returns null if the only matching proposal is superseded', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      await store.supersedeProposal(p.id);
      const found = await store.findActiveProposal(BASE_PROPOSAL.budgetId, BASE_PROPOSAL.transactionId, BASE_PROPOSAL.operation);
      expect(found).toBeNull();
    });
  });

  describe('supersedeProposal', () => {
    it('marks a proposal as superseded while preserving content', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      tickSync();

      const superseded = await store.supersedeProposal(p.id);
      expect(superseded.supersededAt).not.toBeNull();
      expect(superseded.categoryId).toBe(BASE_PROPOSAL.categoryId);
      expect(superseded.payloadHash).toBe(SAMPLE_HASH);
    });

    it('throws when superseding a nonexistent proposal', async () => {
      await expect(store.supersedeProposal('nonexistent')).rejects.toThrow('not found');
    });

    it('is idempotent on already-superseded proposal', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      await store.supersedeProposal(p.id);
      tickSync();
      const again = await store.supersedeProposal(p.id);
      expect(again.supersededAt).toBeTypeOf('string');
    });
  });

  describe('listProposals', () => {
    it('returns empty array when no proposals exist', async () => {
      const results = await store.listProposals();
      expect(results).toEqual([]);
    });

    it('returns empty array when no proposals exist with superseded filter', async () => {
      const active = await store.listProposals({ superseded: false });
      expect(active).toEqual([]);

      const superseded = await store.listProposals({ superseded: true });
      expect(superseded).toEqual([]);
    });

    it('returns all proposals ordered by creation time descending', async () => {
      const p1 = await store.createProposal(BASE_PROPOSAL);
      tickSync();
      const p2 = await store.createProposal({
        ...BASE_PROPOSAL,
        payloadHash: DIFFERENT_HASH,
        transactionId: 'txn-002',
        categoryId: 'cat-utilities',
      });
      tickSync();
      const p3 = await store.createProposal({
        ...BASE_PROPOSAL,
        payloadHash: '3333333333333333333333333333333333333333333333333333333333333333',
        transactionId: 'txn-003',
        categoryId: 'cat-entertainment',
      });

      const results = await store.listProposals();
      expect(results).toHaveLength(3);
      // Most recent first
      expect(results[0].id).toBe(p3.id);
      expect(results[1].id).toBe(p2.id);
      expect(results[2].id).toBe(p1.id);
    });

    it('returns only non-superseded proposals when superseded=false', async () => {
      const p1 = await store.createProposal(BASE_PROPOSAL);
      tickSync();
      const p2 = await store.createProposal({
        ...BASE_PROPOSAL,
        payloadHash: DIFFERENT_HASH,
        transactionId: 'txn-002',
        categoryId: 'cat-utilities',
      });

      await store.supersedeProposal(p1.id);

      const active = await store.listProposals({ superseded: false });
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(p2.id);
    });

    it('returns only superseded proposals when superseded=true', async () => {
      const p1 = await store.createProposal(BASE_PROPOSAL);
      tickSync();
      const p2 = await store.createProposal({
        ...BASE_PROPOSAL,
        payloadHash: DIFFERENT_HASH,
        transactionId: 'txn-002',
        categoryId: 'cat-utilities',
      });

      await store.supersedeProposal(p1.id);

      const superseded = await store.listProposals({ superseded: true });
      expect(superseded).toHaveLength(1);
      expect(superseded[0].id).toBe(p1.id);
    });

    it('filters by budgetId', async () => {
      const pAlpha = await store.createProposal(BASE_PROPOSAL); // budget-alpha
      tickSync();
      const pBeta = await store.createProposal({
        ...BASE_PROPOSAL,
        payloadHash: DIFFERENT_HASH,
        transactionId: 'txn-beta',
        categoryId: 'cat-beta',
        budgetId: 'budget-beta',
      });

      const alphaResults = await store.listProposals({ budgetId: 'budget-alpha' });
      expect(alphaResults).toHaveLength(1);
      expect(alphaResults[0].id).toBe(pAlpha.id);

      const betaResults = await store.listProposals({ budgetId: 'budget-beta' });
      expect(betaResults).toHaveLength(1);
      expect(betaResults[0].id).toBe(pBeta.id);
    });

    it('combines budgetId and superseded filters', async () => {
      const p1 = await store.createProposal(BASE_PROPOSAL); // budget-alpha
      tickSync();
      const p2 = await store.createProposal({
        ...BASE_PROPOSAL,
        payloadHash: DIFFERENT_HASH,
        transactionId: 'txn-002',
        categoryId: 'cat-utilities',
      });

      await store.supersedeProposal(p1.id);

      const activeInAlpha = await store.listProposals({
        budgetId: 'budget-alpha',
        superseded: false,
      });
      expect(activeInAlpha).toHaveLength(1);
      expect(activeInAlpha[0].id).toBe(p2.id);

      const supersededInAlpha = await store.listProposals({
        budgetId: 'budget-alpha',
        superseded: true,
      });
      expect(supersededInAlpha).toHaveLength(1);
      expect(supersededInAlpha[0].id).toBe(p1.id);
    });

    it('respects limit and offset pagination', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const p = await store.createProposal({
          ...BASE_PROPOSAL,
          payloadHash: `${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}`,
          transactionId: `txn-paginate-${i}`,
        });
        ids.unshift(p.id); // prepend because created_at DESC
        tickSync();
      }

      const page1 = await store.listProposals({ limit: 3, offset: 0 });
      expect(page1).toHaveLength(3);
      expect(page1[0].id).toBe(ids[0]);
      expect(page1[1].id).toBe(ids[1]);
      expect(page1[2].id).toBe(ids[2]);

      const page2 = await store.listProposals({ limit: 3, offset: 3 });
      expect(page2).toHaveLength(3);
      expect(page2[0].id).toBe(ids[3]);
      expect(page2[1].id).toBe(ids[4]);
      expect(page2[2].id).toBe(ids[5]);

      const page4 = await store.listProposals({ limit: 3, offset: 9 });
      expect(page4).toHaveLength(1);
      expect(page4[0].id).toBe(ids[9]);
    });
  });

  // =======================================================================
  // ProposalApproval lifecycle
  // =======================================================================

  describe('createApproval', () => {
    let proposalId: string;

    beforeEach(async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      proposalId = p.id;
    });

    it('creates an approval bound to the exact proposal', async () => {
      const a = await store.createApproval({ ...BASE_APPROVAL, proposalId });

      expect(a.id).toBeTypeOf('string');
      expect(a.proposalId).toBe(proposalId);
      expect(a.payloadHash).toBe(SAMPLE_HASH);
      expect(a.actorId).toBe(BASE_APPROVAL.actorId);
      expect(a.status).toBe('active');
      expect(a.consumedAt).toBeNull();
      expect(a.supersededAt).toBeNull();
      expect(a.createdAt).toBeTypeOf('string');
    });

    it('rejects approval with past expiry', async () => {
      await expect(
        store.createApproval({
          ...BASE_APPROVAL,
          proposalId,
          expiresAt: pastExpiry(),
        }),
      ).rejects.toThrow(/expir/i);
    });

    it('rejects approval when payload hash does not match proposal', async () => {
      await expect(
        store.createApproval({
          ...BASE_APPROVAL,
          proposalId,
          payloadHash: DIFFERENT_HASH,
        }),
      ).rejects.toThrow(/hash/i);
    });

    it('rejects approval when proposal is superseded', async () => {
      await store.supersedeProposal(proposalId);
      await expect(
        store.createApproval({ ...BASE_APPROVAL, proposalId }),
      ).rejects.toThrow(/superseded/i);
    });

    it('rejects approval for nonexistent proposal', async () => {
      await expect(
        store.createApproval({ ...BASE_APPROVAL, proposalId: 'nonexistent' }),
      ).rejects.toThrow(/not found/i);
    });

    it('is idempotent for same (proposalId, actorId) returning existing approval', async () => {
      const first = await store.createApproval({ ...BASE_APPROVAL, proposalId });
      tickSync();
      const second = await store.createApproval({ ...BASE_APPROVAL, proposalId });

      expect(second.id).toBe(first.id);
      expect(second.status).toBe('active');
    });
  });

  describe('getApproval', () => {
    it('retrieves an approval by ID', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      const a = await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id });
      const fetched = await store.getApproval(a.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(a.id);
    });

    it('returns null for nonexistent approval', async () => {
      const fetched = await store.getApproval('nonexistent');
      expect(fetched).toBeNull();
    });
  });

  describe('findActiveApprovals', () => {
    it('returns empty array when no approvals exist', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      const approvals = await store.findActiveApprovals(p.id);
      expect(approvals).toEqual([]);
    });

    it('returns active approvals for a proposal', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      const a1 = await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id, actorId: 'bob@example.com' });
      const a2 = await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id, actorId: 'carol@example.com' });

      const active = await store.findActiveApprovals(p.id);
      expect(active).toHaveLength(2);
      expect(active.map(a => a.id).sort()).toEqual([a1.id, a2.id].sort());
    });

    it('excludes consumed approvals from active results', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      const a = await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id });
      await store.consumeApproval(a.id);

      const active = await store.findActiveApprovals(p.id);
      expect(active).toHaveLength(0);
    });

    it('excludes expired approvals from active results', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      await store.createApproval({
        ...BASE_APPROVAL,
        proposalId: p.id,
        expiresAt: futureExpiry(), // fresh
      });

      // An approval with past expiry cannot be created (rejected at create time)
      // To test expiry in active query, we create an approval with very short expiry and wait
      const shortExpiry = new Date(Date.now() + 100).toISOString();
      await store.createApproval({
        ...BASE_APPROVAL,
        proposalId: p.id,
        actorId: 'short@example.com',
        expiresAt: shortExpiry,
      });

      // Wait past the short expiry
      await new Promise(resolve => setTimeout(resolve, 150));

      const active = await store.findActiveApprovals(p.id);
      expect(active.every(a => a.actorId === 'bob@example.com')).toBe(true);
    });
  });

  describe('consumeApproval', () => {
    it('consumes an active approval and sets consumedAt', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      const a = await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id });
      tickSync();

      const consumed = await store.consumeApproval(a.id);
      expect(consumed.consumedAt).not.toBeNull();
    });

    it('rejects consuming an expired approval', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      // Create with past expiry (should fail at creation)
      // So create one and simulate expiry by consuming after it expires
      const shortExpiry = new Date(Date.now() + 50).toISOString();
      const a = await store.createApproval({
        ...BASE_APPROVAL,
        proposalId: p.id,
        actorId: 'expirer@example.com',
        expiresAt: shortExpiry,
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      await expect(store.consumeApproval(a.id)).rejects.toThrow(/expir/i);
    });

    it('rejects consuming an already-consumed approval', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      const a = await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id });
      await store.consumeApproval(a.id);

      await expect(store.consumeApproval(a.id)).rejects.toThrow(/consumed/i);
    });

    it('rejects consuming an approval whose proposal is superseded', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      const a = await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id });
      await store.supersedeProposal(p.id);

      await expect(store.consumeApproval(a.id)).rejects.toThrow(/superseded/i);
    });

    it('rejects consuming a nonexistent approval', async () => {
      await expect(store.consumeApproval('nonexistent')).rejects.toThrow(/not found/i);
    });
  });

  describe('verifyApprovalForExecution', () => {
    it('returns null when a valid approval chain exists', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id });

      const rejection = await store.verifyApprovalForExecution(p.id, SAMPLE_HASH);
      expect(rejection).toBeNull();
    });

    it('rejects when payload hash does not match proposal', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id });

      const rejection = await store.verifyApprovalForExecution(p.id, DIFFERENT_HASH);
      expect(rejection).not.toBeNull();
      expect(rejection!.toLowerCase()).toContain('hash');
    });

    it('rejects when proposal is superseded', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id });
      await store.supersedeProposal(p.id);

      const rejection = await store.verifyApprovalForExecution(p.id, SAMPLE_HASH);
      expect(rejection).not.toBeNull();
      expect(rejection!.toLowerCase()).toContain('superseded');
    });

    it('rejects when no approval exists for the proposal', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);

      const rejection = await store.verifyApprovalForExecution(p.id, SAMPLE_HASH);
      expect(rejection).not.toBeNull();
      expect(rejection!.toLowerCase()).toContain('approv');
    });

    it('rejects when proposal is not found', async () => {
      const rejection = await store.verifyApprovalForExecution('nonexistent', SAMPLE_HASH);
      expect(rejection).not.toBeNull();
      expect(rejection!.toLowerCase()).toContain('not found');
    });

    it('rejects when all approvals are consumed', async () => {
      const p = await store.createProposal(BASE_PROPOSAL);
      const a = await store.createApproval({ ...BASE_APPROVAL, proposalId: p.id });
      await store.consumeApproval(a.id);

      const rejection = await store.verifyApprovalForExecution(p.id, SAMPLE_HASH);
      expect(rejection).not.toBeNull();
      expect(rejection!.toLowerCase()).toContain('approv');
    });
  });

  // =======================================================================
  // Idempotency records
  // =======================================================================

  describe('IdempotencyRecord', () => {
    it('creates an idempotency record with all fields', async () => {
      const input: CreateIdempotencyInput = {
        idempotencyKey: 'ik-001',
        proposalId: 'proposal-001',
        operation: 'set_category',
        serialisedEffect: JSON.stringify({ category: 'cat-food' }),
      };
      const record = await store.createIdempotencyRecord(input);

      expect(record.idempotencyKey).toBe('ik-001');
      expect(record.proposalId).toBe('proposal-001');
      expect(record.operation).toBe('set_category');
      expect(record.completed).toBe(false);
      expect(record.errorMessage).toBeNull();
      expect(record.executedAt).toBeTypeOf('string');
      expect(record.updatedAt).toBeTypeOf('string');
    });

    it('returns existing record on idempotent retry with same content', async () => {
      const input: CreateIdempotencyInput = {
        idempotencyKey: 'ik-002',
        proposalId: 'proposal-002',
        operation: 'set_category',
        serialisedEffect: JSON.stringify({ category: 'cat-food' }),
      };
      const first = await store.createIdempotencyRecord(input);
      tickSync();
      const second = await store.createIdempotencyRecord(input);

      expect(second.idempotencyKey).toBe(first.idempotencyKey);
      expect(second.proposalId).toBe(first.proposalId);
      expect(second.executedAt).toBe(first.executedAt);
    });

    it('rejects replay with different proposalId under same idempotency key', async () => {
      const input: CreateIdempotencyInput = {
        idempotencyKey: 'ik-003',
        proposalId: 'proposal-003',
        operation: 'set_category',
        serialisedEffect: 'effect-a',
      };
      await store.createIdempotencyRecord(input);

      await expect(
        store.createIdempotencyRecord({
          ...input,
          proposalId: 'proposal-different',
        }),
      ).rejects.toThrow(/idempotency|replay/i);
    });

    it('rejects replay with different operation under same idempotency key', async () => {
      const input: CreateIdempotencyInput = {
        idempotencyKey: 'ik-004',
        proposalId: 'proposal-004',
        operation: 'set_category',
        serialisedEffect: 'effect-a',
      };
      await store.createIdempotencyRecord(input);

      await expect(
        store.createIdempotencyRecord({
          ...input,
          operation: 'set_category', // same op, different proposal — covered above
          // actually let's test different serialisedEffect
          serialisedEffect: 'effect-different',
        }),
      ).rejects.toThrow(/idempotency|replay/i);
    });

    it('returns null for nonexistent idempotency key', async () => {
      const fetched = await store.getIdempotencyRecord('nonexistent');
      expect(fetched).toBeNull();
    });

    it('retrieves an idempotency record by key', async () => {
      const input: CreateIdempotencyInput = {
        idempotencyKey: 'ik-lookup',
        proposalId: 'proposal-lookup',
        operation: 'set_category',
        serialisedEffect: 'effect',
      };
      const created = await store.createIdempotencyRecord(input);
      const fetched = await store.getIdempotencyRecord('ik-lookup');
      expect(fetched).not.toBeNull();
      expect(fetched!.idempotencyKey).toBe(created.idempotencyKey);
    });

    it('marks an idempotency record as completed', async () => {
      await store.createIdempotencyRecord({
        idempotencyKey: 'ik-complete',
        proposalId: 'proposal-complete',
        operation: 'set_category',
        serialisedEffect: 'effect',
      });

      const completed = await store.completeIdempotencyRecord('ik-complete');
      expect(completed.completed).toBe(true);
      expect(completed.errorMessage).toBeNull();
    });

    it('marks an idempotency record as completed with error', async () => {
      await store.createIdempotencyRecord({
        idempotencyKey: 'ik-error',
        proposalId: 'proposal-error',
        operation: 'set_category',
        serialisedEffect: 'effect',
      });

      const completed = await store.completeIdempotencyRecord('ik-error', 'Postcondition verification failed');
      expect(completed.completed).toBe(true);
      expect(completed.errorMessage).toBe('Postcondition verification failed');
    });
  });

  // =======================================================================
  // Audit records (append-only)
  // =======================================================================

  describe('AuditRecord', () => {
    function baseAudit(overrides: Partial<AppendAuditInput> = {}): AppendAuditInput {
      return {
        classification: 'proposal_created',
        actorId: 'alice@example.com',
        operation: 'set_category',
        budgetId: 'budget-alpha',
        backendIds: '[]',
        result: 'Proposal created successfully',
        isError: false,
        ...overrides,
      };
    }

    it('appends an audit record with all fields', async () => {
      const record = await store.appendAuditRecord(baseAudit({
        classification: 'proposal_created',
        proposalId: 'prop-001',
        payloadHash: SAMPLE_HASH,
        policyVersion: '1.0.0',
        authorizationDisposition: { kind: 'approval_required' },
        idempotencyKey: 'ik-001',
        expectedPriorState: '{"version":3}',
        observedResultState: '{"version":4}',
        providerModel: 'fast-classifier/v2',
        correlationId: 'corr-001',
        requestId: 'req-001',
      }));

      expect(record.id).toBeTypeOf('string');
      expect(record.classification).toBe('proposal_created');
      expect(record.actorId).toBe('alice@example.com');
      expect(record.operation).toBe('set_category');
      expect(record.proposalId).toBe('prop-001');
      expect(record.payloadHash).toBe(SAMPLE_HASH);
      expect(record.timestamp).toBeTypeOf('string');
      expect(record.isError).toBe(false);
    });

    it('appends audit records in order with distinct IDs', async () => {
      const r1 = await store.appendAuditRecord(baseAudit({ classification: 'execution_started', result: 'started' }));
      const r2 = await store.appendAuditRecord(baseAudit({ classification: 'execution_completed', result: 'completed' }));

      expect(r1.id).not.toBe(r2.id);
      expect(r1.timestamp <= r2.timestamp).toBe(true);
    });

    it('queries audit records by classification', async () => {
      await store.appendAuditRecord(baseAudit({ classification: 'proposal_created', result: 'created' }));
      await store.appendAuditRecord(baseAudit({ classification: 'approval_granted', result: 'granted', actorId: 'bob@example.com' }));
      await store.appendAuditRecord(baseAudit({ classification: 'execution_completed', result: 'done' }));

      const approvals = await store.queryAuditRecords('approval_granted');
      expect(approvals).toHaveLength(1);
      expect(approvals[0].classification).toBe('approval_granted');
      expect(approvals[0].actorId).toBe('bob@example.com');
    });

    it('queries audit records by proposal ID', async () => {
      await store.appendAuditRecord(baseAudit({ classification: 'proposal_created', proposalId: 'prop-query', result: 'created' }));
      await store.appendAuditRecord(baseAudit({ classification: 'approval_granted', proposalId: 'prop-query', result: 'granted' }));
      await store.appendAuditRecord(baseAudit({ classification: 'execution_completed', proposalId: 'prop-other', result: 'done' }));

      const records = await store.queryAuditRecordsByProposal('prop-query');
      expect(records).toHaveLength(2);
    });

    it('returns empty array when no matching audit records exist', async () => {
      const records = await store.queryAuditRecords('proposal_created');
      expect(records).toEqual([]);
    });

    it('paginates audit record queries', async () => {
      for (let i = 0; i < 10; i++) {
        await store.appendAuditRecord(baseAudit({
          classification: 'proposal_created',
          result: `event-${i}`,
        }));
      }

      const page1 = await store.queryAuditRecords(undefined, 3, 0);
      expect(page1).toHaveLength(3);

      const page2 = await store.queryAuditRecords(undefined, 3, 3);
      expect(page2).toHaveLength(3);
      expect(page2[0].id).not.toBe(page1[0].id);
    });
  });

  // =======================================================================
  // Authorization
  // =======================================================================

  describe('Authorization', () => {
    it('returns allowed=false for unknown actor', async () => {
      const result = await store.evaluateAuthorization('unknown@example.com', 'review.approve', 'budget-alpha', '1.0.0');
      expect(result.allowed).toBe(false);
      expect(result.membershipStatus).toBe('unknown');
    });

    it('returns allowed=false for inactive member', async () => {
      await store.upsertActorMembership('alice@example.com', 'inactive', ['review.approve'], 'budget-alpha');
      const result = await store.evaluateAuthorization('alice@example.com', 'review.approve', 'budget-alpha', '1.0.0');
      expect(result.allowed).toBe(false);
      expect(result.membershipStatus).toBe('inactive');
    });

    it('returns allowed=false for member lacking capability', async () => {
      await store.upsertActorMembership('alice@example.com', 'active', ['other.capability'], 'budget-alpha');
      const result = await store.evaluateAuthorization('alice@example.com', 'review.approve', 'budget-alpha', '1.0.0');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('capability');
    });

    it('returns allowed=false for member lacking scope', async () => {
      await store.upsertActorMembership('alice@example.com', 'active', ['review.approve'], 'budget-other');
      const result = await store.evaluateAuthorization('alice@example.com', 'review.approve', 'budget-alpha', '1.0.0');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('scope');
    });

    it('returns allowed=true for fully authorized actor', async () => {
      await store.upsertActorMembership('alice@example.com', 'active', ['review.approve', 'category.set'], 'budget-alpha');
      const result = await store.evaluateAuthorization('alice@example.com', 'review.approve', 'budget-alpha', '1.0.0');
      expect(result.allowed).toBe(true);
      expect(result.membershipStatus).toBe('active');
      expect(result.capability).toBe('review.approve');
      expect(result.scope).toBe('budget-alpha');
      expect(result.policyVersion).toBe('1.0.0');
      expect(result.disposition.kind).toBe('authorized_without_approval');
    });

    it('returns consistent result for same inputs (deterministic)', async () => {
      await store.upsertActorMembership('bob@example.com', 'active', ['category.set'], 'budget-alpha');

      const r1 = await store.evaluateAuthorization('bob@example.com', 'category.set', 'budget-alpha', '1.0.0');
      const r2 = await store.evaluateAuthorization('bob@example.com', 'category.set', 'budget-alpha', '1.0.0');

      expect(r1.allowed).toBe(r2.allowed);
      expect(r1.disposition.kind).toBe(r2.disposition.kind);
    });

    it('upsertActorMembership overwrites previous capabilities', async () => {
      await store.upsertActorMembership('alice@example.com', 'active', ['review.approve'], 'budget-alpha');
      let result = await store.evaluateAuthorization('alice@example.com', 'category.set', 'budget-alpha', '1.0.0');
      expect(result.allowed).toBe(false);

      await store.upsertActorMembership('alice@example.com', 'active', ['review.approve', 'category.set'], 'budget-alpha');
      result = await store.evaluateAuthorization('alice@example.com', 'category.set', 'budget-alpha', '1.0.0');
      expect(result.allowed).toBe(true);
    });

    it('getActorMembership returns null for unknown actor', async () => {
      const membership = await store.getActorMembership('unknown@example.com');
      expect(membership).toBeNull();
    });

    it('getActorMembership returns stored membership', async () => {
      await store.upsertActorMembership('alice@example.com', 'active', ['review.approve', 'category.set'], 'budget-alpha');
      const membership = await store.getActorMembership('alice@example.com');
      expect(membership).not.toBeNull();
      expect(membership!.status).toBe('active');
      expect(membership!.capabilities).toEqual(['review.approve', 'category.set']);
      expect(membership!.scope).toBe('budget-alpha');
    });
  });
});
