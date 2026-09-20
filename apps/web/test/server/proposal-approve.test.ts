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

import handler from '../../server/api/proposal/[id]/approve.post';

const actorId = 'authenticated-user';
const budgetId = 'secret-budget';
const payloadHash = 'a'.repeat(64);
const expiresAt = '2099-01-01T00:00:00.000Z';

function event(
  id: string,
  auth = { authenticated: true, user: { id: actorId }, actorId: 'forged-legacy-actor' },
) {
  return { context: { params: { id }, auth } };
}

describe('POST proposal approval authorization', () => {
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
              transactionId: 'secret-transaction',
              categoryId: 'secret-category',
              rule: {},
            }
          : {
              kind: 'set_category',
              transactionId: 'secret-transaction',
              categoryId: 'secret-category',
            },
      payloadHash,
      policyVersion: '1.0',
      preconditions: '{}',
      expiresAt,
      actorId: 'proposer',
      provenance: 'human',
    });
  }

  it.each([
    { name: 'nonmember', capabilities: null, scope: '*' },
    { name: 'read-only member', capabilities: ['observe'], scope: `budget:${budgetId}` },
    {
      name: 'wrong operation',
      capabilities: ['categorization:execute'],
      scope: `budget:${budgetId}`,
    },
    { name: 'wrong budget', capabilities: ['rule:execute'], scope: 'budget:other' },
  ])('denies $name without disclosing proposal contents', async ({ capabilities, scope }) => {
    if (capabilities) await store.upsertActorMembership(actorId, 'active', capabilities, scope);
    const p = await seed();
    const response = await handler(event(p.id));
    expect(response.status).toBe('error');
    expect(await store.findActiveApprovals(p.id)).toEqual([]);
    const serialized = JSON.stringify(response);
    for (const secret of [budgetId, p.transactionId, p.categoryId, payloadHash, p.id]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('does not distinguish missing, expired and superseded proposals for a nonmember', async () => {
    const active = await seed();
    const activeResponse = await handler(event(active.id));
    await store.supersedeProposal(active.id);
    const supersededResponse = await handler(event(active.id));
    const missingResponse = await handler(event('missing'));
    expect(activeResponse.status).toBe('error');
    expect(supersededResponse.error).toEqual(activeResponse.error);
    expect(missingResponse.error).toEqual(activeResponse.error);
  });

  it.each([
    ['create_rule', 'rule:execute'],
    ['set_category', 'categorization:execute'],
  ] as const)(
    'issues exact %s approval using the authenticated session identity',
    async (operation, capability) => {
      await store.upsertActorMembership(actorId, 'active', [capability], `budget:${budgetId}`);
      const p = await seed(operation);
      const response = await handler(event(p.id));
      expect(response.status).toBe('ok');
      const approvals = await store.findActiveApprovals(p.id);
      expect(approvals).toEqual([
        expect.objectContaining({ actorId, payloadHash, proposalId: p.id }),
      ]);
      expect(response.authorization).toEqual({ actorId, capability, allowed: true });
    },
  );

  it('rejects unauthenticated requests even when a legacy actor has a grant', async () => {
    await store.upsertActorMembership(actorId, 'active', ['rule:execute'], '*');
    const p = await seed();
    const response = await handler(
      event(p.id, { authenticated: false, user: { id: actorId }, actorId }),
    );
    expect(response.status).toBe('error');
    expect(await store.findActiveApprovals(p.id)).toEqual([]);
  });

  it('does not manufacture an api-user identity for an incomplete authenticated context', async () => {
    await store.upsertActorMembership('api-user', 'active', ['rule:execute'], '*');
    const p = await seed();
    const response = await handler({
      context: { params: { id: p.id }, auth: { authenticated: true } },
    });
    expect(response.status).toBe('error');
    expect(await store.findActiveApprovals(p.id)).toEqual([]);
  });
});
