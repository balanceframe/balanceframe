import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';
import type { CreateProposalInput, MembershipStatus, ProposalOperation } from '../src/types.js';

const actorId = 'approver';
const budgetId = 'private-budget';
const payloadHash = 'a'.repeat(64);
const expiresAt = '2099-01-01T00:00:00.000Z';

function proposal(
  operation: Exclude<ProposalOperation, 'transfer'> = 'set_category',
): CreateProposalInput {
  return {
    operation,
    budgetId,
    payload:
      operation === 'create_rule'
        ? {
            kind: 'create_rule',
            transactionId: 'private-transaction',
            categoryId: 'private-category',
            rule: {},
          }
        : {
            kind: 'set_category',
            transactionId: 'private-transaction',
            categoryId: 'private-category',
          },
    payloadHash,
    policyVersion: '1.0',
    preconditions: '{}',
    expiresAt,
    actorId: 'proposer',
    provenance: 'human',
  };
}

describe('approval issuer authorization', () => {
  let store: SqliteWorkflowStore;
  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  async function grant(
    capabilities = ['categorization:execute'],
    scope = `budget:${budgetId}`,
    status: MembershipStatus = 'active',
  ) {
    await store.upsertActorMembership(actorId, status, capabilities, scope);
  }

  async function issue(operation: Exclude<ProposalOperation, 'transfer'> = 'set_category') {
    const p = await store.createProposal(proposal(operation));
    return { p, input: { proposalId: p.id, payloadHash, actorId, expiresAt } };
  }

  it('rejects a nonmember without persisting approval', async () => {
    const { p, input } = await issue();
    await expect(store.createApproval(input)).rejects.toThrow(/authoriz/i);
    expect(await store.findActiveApprovals(p.id)).toEqual([]);
  });

  it.each([
    { capabilities: ['observe'], scope: `budget:${budgetId}`, status: 'active' },
    { capabilities: ['rule:execute'], scope: `budget:${budgetId}`, status: 'active' },
    { capabilities: ['categorization:execute'], scope: 'budget:other', status: 'active' },
    { capabilities: ['categorization:execute'], scope: `budget:${budgetId}`, status: 'inactive' },
  ] as const)(
    'rejects a grant that cannot authorize the exact operation: %j',
    async ({ capabilities, scope, status }) => {
      await grant([...capabilities], scope, status);
      const { p, input } = await issue();
      await expect(store.createApproval(input)).rejects.toThrow(/authoriz/i);
      expect(await store.findActiveApprovals(p.id)).toEqual([]);
    },
  );

  it('requires rule execution rather than categorization execution for rule approval', async () => {
    await grant();
    const { input } = await issue('create_rule');
    await expect(store.createApproval(input)).rejects.toThrow(/authoriz/i);
    await grant(['rule:execute']);
    const approval = await store.createApproval(input);
    expect((await store.consumeApproval(approval.id)).status).toBe('consumed');
  });

  it('rejects unsupported operations even for a fully granted actor', async () => {
    await grant(['categorization:execute', 'rule:execute']);
    // Exercise a legacy/corrupted operation outside the compile-time union.
    const unsupported = 'delete_budget' as Exclude<ProposalOperation, 'transfer'>;
    await expect(issue(unsupported)).rejects.toThrow(/operation|authoriz/i);
  });

  it.each(['inactive', 'suspended'] as const)(
    'rejects issuance replay, chain verification and consumption after issuer becomes %s',
    async (status) => {
      await grant();
      const { p, input } = await issue();
      const approval = await store.createApproval(input);
      await grant(['categorization:execute'], `budget:${budgetId}`, status);
      await expect(store.createApproval(input)).rejects.toThrow(/authoriz/i);
      expect(await store.verifyApprovalForExecution(p.id, payloadHash)).not.toBeNull();
      await expect(store.consumeApproval(approval.id)).rejects.toThrow(/authoriz/i);
      expect((await store.getApproval(approval.id))?.status).toBe('active');
    },
  );

  it('rejects consumption and verification when issuer loses the proposal scope', async () => {
    await grant();
    const { p, input } = await issue();
    const approval = await store.createApproval(input);
    await grant(['categorization:execute'], 'budget:other');
    expect(await store.verifyApprovalForExecution(p.id, payloadHash)).not.toBeNull();
    await expect(store.consumeApproval(approval.id)).rejects.toThrow(/authoriz/i);
  });

  it('rejects a mismatched stored approval hash during verification and consumption', async () => {
    await grant();
    const { p, input } = await issue();
    const approval = await store.createApproval(input);
    // Existing tests use the private database seam to simulate persisted corruption.
    const internal = store as unknown as {
      db: { prepare(sql: string): { run(...args: unknown[]): void } };
    };
    const db = internal.db;
    db.prepare('UPDATE proposal_approvals SET payload_hash = ? WHERE id = ?').run(
      'b'.repeat(64),
      approval.id,
    );
    expect(await store.verifyApprovalForExecution(p.id, payloadHash)).not.toBeNull();
    await expect(store.consumeApproval(approval.id)).rejects.toThrow(/hash/i);
  });

  it('allows only the exact current hash for an authorized categorization approval', async () => {
    await grant();
    const { p, input } = await issue();
    await expect(store.createApproval({ ...input, payloadHash: 'b'.repeat(64) })).rejects.toThrow(
      /hash/i,
    );
    const approval = await store.createApproval(input);
    expect(await store.verifyApprovalForExecution(p.id, payloadHash)).toBeNull();
    expect((await store.consumeApproval(approval.id)).status).toBe('consumed');
    await expect(store.consumeApproval(approval.id)).rejects.toThrow(/consumed/i);
  });
});
