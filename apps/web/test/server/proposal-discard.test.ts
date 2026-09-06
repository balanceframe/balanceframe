import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { ProposalOperation } from '@balanceframe/workflow-store';
import type * as WorkflowStoreUtils from '../../server/utils/workflow-store';

const { current } = vi.hoisted(() => ({ current: { store: null as SqliteWorkflowStore | null } }));
vi.mock('h3', () => ({ setResponseStatus: vi.fn() }));
vi.mock('../../server/utils/workflow-store', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowStoreUtils>()),
  getWorkflowStore: () => ({ store: current.store! }),
}));
import handler from '../../server/api/proposal/[id]/discard.post';

const actorId = 'discard-actor';
const budgetId = 'private-discard-budget';
const expiresAt = '2099-01-01T00:00:00.000Z';
function request(id: string, authenticated = true) {
  return {
    context: {
      params: { id },
      auth: { authenticated, user: { id: actorId }, actorId: 'forged-actor' },
    },
  };
}

describe('current proposal discard authorization', () => {
  let store: SqliteWorkflowStore;
  beforeEach(() => {
    store = new SqliteWorkflowStore(':memory:');
    current.store = store;
  });
  afterEach(() => {
    store.close();
  });
  async function seed(operation: Exclude<ProposalOperation, 'transfer'> = 'create_rule') {
    return store.createProposal({
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
      payloadHash: 'a'.repeat(64),
      policyVersion: '1.0',
      preconditions: '{}',
      expiresAt,
      actorId: 'proposer',
      provenance: 'human',
    });
  }

  it.each([
    { name: 'nonmember', capabilities: [], scope: '*' },
    { name: 'observer', capabilities: ['observe'], scope: `budget:${budgetId}` },
    {
      name: 'wrong operation',
      capabilities: ['categorization:execute'],
      scope: `budget:${budgetId}`,
    },
    { name: 'wrong budget', capabilities: ['rule:execute'], scope: 'budget:other' },
  ])(
    'preserves the proposal and hides its existence from a $name',
    async ({ capabilities, scope }) => {
      if (capabilities.length)
        await store.upsertActorMembership(actorId, 'active', capabilities, scope);
      const proposal = await seed();
      const response = await handler(request(proposal.id));
      expect(response.status).toBe('error');
      expect((await store.getProposal(proposal.id))?.supersededAt).toBeNull();
      const missing = await handler(request('missing'));
      expect(response.error).toEqual(missing.error);
      for (const secret of [
        proposal.id,
        budgetId,
        proposal.transactionId,
        proposal.categoryId,
        proposal.payloadHash,
      ]) {
        expect(JSON.stringify(response)).not.toContain(secret);
      }
    },
  );

  it.each([
    ['create_rule', 'rule:execute'],
    ['set_category', 'categorization:execute'],
  ] as const)(
    'discards authorized %s and invalidates its exact approval',
    async (operation, capability) => {
      await store.upsertActorMembership(actorId, 'active', [capability], `budget:${budgetId}`);
      const proposal = await seed(operation);
      const approval = await store.createApproval({
        proposalId: proposal.id,
        actorId,
        payloadHash: proposal.payloadHash,
        expiresAt,
      });
      expect((await handler(request(proposal.id))).status).toBe('ok');
      expect((await store.getProposal(proposal.id))?.supersededAt).not.toBeNull();
      expect((await store.getApproval(approval.id))?.status).toBe('superseded');
      await store.upsertActorMembership(actorId, 'revoked', [capability], `budget:${budgetId}`);
      expect((await handler(request(proposal.id))).status).toBe('error');
    },
  );

  it('requires a real authenticated identity even when a named actor has execution authority', async () => {
    await store.upsertActorMembership(actorId, 'active', ['rule:execute'], '*');
    await store.upsertActorMembership('api-user', 'active', ['rule:execute'], '*');
    const proposal = await seed();
    expect((await handler(request(proposal.id, false))).status).toBe('error');
    expect(
      (await handler({ context: { params: { id: proposal.id }, auth: { authenticated: true } } }))
        .status,
    ).toBe('error');
    expect((await store.getProposal(proposal.id))?.supersededAt).toBeNull();
  });
});
