import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setResponseStatus } from 'h3';
import type * as H3 from 'h3';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type * as Workflow from '../../server/utils/workflow-store';
import fixture from '../../../../protocol/fixtures/representative.json';

const { current, loadConfig, connect } = vi.hoisted(() => ({
  current: { store: null as SqliteWorkflowStore | null, unavailable: false },
  loadConfig: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('h3', async (original) => ({
  ...(await original<typeof H3>()),
  readBody: async (event: { body: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  },
}));
vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({ loadConfig, withConnection: connect }),
}));
vi.mock('../../server/utils/workflow-store', async (original) => ({
  ...(await original<typeof Workflow>()),
  getWorkflowStore: () =>
    current.unavailable ? { error: 'Store unavailable' } : { store: current.store! },
}));
import propose from '../../server/api/review/propose-rule.post';
import detail from '../../server/api/proposal/[id].get';
import seed from '../../server/api/review/seed.post';

const actorId = 'proposal-reader';
const budgetId = 'fixture-budget';
const now = '2026-08-01T12:00:00.000Z';
const transaction = fixture.transactions[0]!;
const categoryId = fixture.transactions[1]!.categoryId!;
const simulation = {
  transactionsMatched: 1,
  transactionsAffected: [transaction.id],
  categoryDistribution: { [transaction.categoryId!]: 1 },
  conflicts: [],
  examples: [
    {
      txId: transaction.id,
      payee: transaction.payeeName,
      amount: transaction.amount,
      currentCategory: transaction.categoryId,
      wouldChange: true,
    },
  ],
  simulatedAt: now,
};
let store: SqliteWorkflowStore;
function event(body: unknown = {}, id = '') {
  return {
    body,
    node: { res: { statusCode: 200, statusMessage: '' } },
    context: {
      params: { id },
      auth: { authenticated: true, user: { id: actorId }, actorId: 'forged-legacy' },
    },
  };
}
async function grant() {
  await store.upsertActorMembership(
    actorId,
    'active',
    ['observe', 'liquidity:full-read'],
    `budget:${budgetId}`,
  );
  store.liquidity.setResourceGrant({
    actorId,
    budgetId,
    capability: 'full-read',
    resourceKind: 'budget',
    resourceId: budgetId,
    granted: true,
    now,
  });
}
async function review() {
  return store.createReviewItem({
    transactionId: transaction.id,
    budgetId,
    categoryId: transaction.categoryId!,
    classifier: 'fixture',
    provenance: 'test',
  });
}
async function proposal(
  preconditions: string,
  expiresAt = '2026-08-02T12:00:00.000Z',
  selectedBudget = budgetId,
) {
  return store.createProposal({
    operation: 'set_category',
    budgetId: selectedBudget,
    payload: { kind: 'set_category', transactionId: transaction.id, categoryId },
    payloadHash: 'a'.repeat(64),
    policyVersion: '1.0',
    preconditions,
    expiresAt,
    actorId,
    provenance: 'test',
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  vi.stubGlobal('setResponseStatus', setResponseStatus);
  vi.stubEnv('BALANCEFRAME_SEED_ALLOWED', 'false');
  store = new SqliteWorkflowStore(':memory:');
  current.store = store;
  current.unavailable = false;
  loadConfig.mockResolvedValue({
    version: 1,
    budgetId,
    serverUrl: 'https://actual.invalid',
    budgetName: 'Fixture',
    groupId: 'fixture-group',
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  store.close();
});

describe('review rule proposal creation and authorized detail', () => {
  it('persists a normalized executable rule and exposes its simulation to an authorized reader', async () => {
    await grant();
    const item = await review();
    const response = await propose(
      event({
        reviewId: ` ${item.id} `,
        merchant: ` ${transaction.payeeName} `,
        categoryId: ` ${categoryId} `,
        name: '  Grocery rule  ',
        simulation,
        actorId: 'spoofed-body',
      }),
    );
    expect(response.status).toBe('ok');
    const id = response.result!.proposalId;
    const stored = await store.getProposal(id);
    expect(stored).toMatchObject({
      operation: 'create_rule',
      actorId,
      budgetId,
      payload: {
        kind: 'create_rule',
        transactionId: null,
        categoryId,
        rule: {
          name: 'Grocery rule',
          conditions: [{ field: 'payee_name', op: 'is', value: transaction.payeeName }],
          actions: [{ field: 'category', op: 'set', value: categoryId }],
        },
      },
    });
    expect(await store.findActiveApprovals(id)).toEqual([]);
    const shown = await detail(event({}, id));
    expect(shown.status).toBe('ok');
    expect(shown.result).toMatchObject({ stale: false, simulationStatus: 'present', simulation });
    expect(connect).not.toHaveBeenCalled();
  });
  it('keeps a proposal without simulation unapproved and marks evidence missing', async () => {
    await grant();
    const item = await review();
    const created = await propose(
      event({ reviewId: item.id, merchant: transaction.payeeName, categoryId }),
    );
    expect(created.status).toBe('ok');
    const id = created.result!.proposalId;
    expect((await detail(event({}, id))).result).toMatchObject({
      simulation: null,
      simulationStatus: 'missing',
      stale: false,
    });
    expect(await store.findActiveApprovals(id)).toEqual([]);
  });
  it.each([
    { body: new SyntaxError('JSON malformed'), status: 400, code: 'INVALID_JSON' },
    {
      body: { reviewId: 'review', merchant: '  ', categoryId },
      status: 422,
      code: 'MISSING_FIELDS',
    },
    {
      body: {
        reviewId: 'review',
        merchant: transaction.payeeName,
        categoryId,
        simulation: { transactionsMatched: 0, simulatedAt: now },
      },
      status: 422,
      code: 'INVALID_SIMULATION',
    },
    {
      body: {
        reviewId: 'review',
        merchant: transaction.payeeName,
        categoryId,
        simulation: { transactionsMatched: 1 },
      },
      status: 422,
      code: 'INVALID_SIMULATION',
    },
  ])(
    'rejects invalid proposal input with $code without storing a proposal',
    async ({ body, status, code }) => {
      const request = event(body);
      expect((await propose(request)).error?.code).toBe(code);
      expect(request.node.res.statusCode).toBe(status);
      expect(await store.listProposals()).toEqual([]);
    },
  );
  it('returns storage unavailability without claiming proposal creation', async () => {
    current.unavailable = true;
    const request = event({ reviewId: 'review', merchant: transaction.payeeName, categoryId });
    expect((await propose(request)).error?.code).toBe('STORE_UNAVAILABLE');
    expect(request.node.res.statusCode).toBe(503);
    expect(await store.listProposals()).toEqual([]);
  });
  it('reports a failed proposal write instead of manufacturing an identifier', async () => {
    const item = await review();
    vi.spyOn(store, 'createProposal').mockRejectedValue(new Error('Store write failed'));
    const request = event({ reviewId: item.id, merchant: transaction.payeeName, categoryId });
    const response = await propose(request);
    expect(response.error?.code).toBe('PROPOSAL_FAILED');
    expect(response.result).toBeNull();
    expect(request.node.res.statusCode).toBe(500);
    expect(await store.listProposals()).toEqual([]);
  });
});

describe('proposal detail read boundaries', () => {
  it.each([
    ['fresh simulation', JSON.stringify({ simulation }), now, false, 'present'],
    ['expiry boundary', JSON.stringify({ simulation }), '2026-08-02T12:00:00.000Z', true, 'stale'],
    ['expired without evidence', '{}', '2026-08-02T12:00:00.001Z', true, 'missing'],
    ['malformed stored evidence', '{', now, false, 'missing'],
  ] as const)(
    'classifies %s without reading the ledger',
    async (_name, preconditions, evaluatedAt, stale, simulationStatus) => {
      await grant();
      const item = await proposal(preconditions);
      vi.setSystemTime(new Date(evaluatedAt));
      const response = await detail(event({}, item.id));
      expect(response.status).toBe('ok');
      expect(response.result).toMatchObject({ stale, simulationStatus });
      if (simulationStatus === 'missing') expect(response.result!.simulation).toBeNull();
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it('does not disclose a proposal after its full-read resource grant is revoked', async () => {
    await grant();
    const item = await proposal(JSON.stringify({ simulation }));
    expect((await detail(event({}, item.id))).status).toBe('ok');
    store.liquidity.setResourceGrant({
      actorId,
      budgetId,
      capability: 'full-read',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now,
    });
    const read = vi.spyOn(store, 'getProposal');
    const request = event({}, item.id);
    const response = await detail(request);
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(request.node.res.statusCode).toBe(403);
    expect(response.result).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it('requires current observe capability even when a resource grant exists', async () => {
    await grant();
    const item = await proposal('{}');
    await store.upsertActorMembership(actorId, 'active', [], `budget:${budgetId}`);
    const read = vi.spyOn(store, 'getProposal');
    const response = await detail(event({}, item.id));
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(response.result).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it('does not reveal whether another budget proposal exists', async () => {
    await grant();
    const item = await proposal(
      JSON.stringify({ simulation }),
      '2026-08-02T12:00:00.000Z',
      'foreign-budget',
    );
    for (const id of [item.id, 'missing']) {
      const request = event({}, id);
      const response = await detail(request);
      expect(response.error?.code).toBe('PROPOSAL_NOT_FOUND');
      expect(request.node.res.statusCode).toBe(404);
      expect(response.result).toBeNull();
      expect(JSON.stringify(response)).not.toContain('foreign-budget');
      expect(JSON.stringify(response)).not.toContain(transaction.payeeName);
    }
  });
  it('rejects missing identifiers only after full-read authorization', async () => {
    await grant();
    const request = event();
    expect((await detail(request)).error?.code).toBe('MISSING_PROPOSAL_ID');
    expect(request.node.res.statusCode).toBe(400);
  });
  it('fails closed for a missing selected budget before proposal access', async () => {
    await grant();
    loadConfig.mockResolvedValue(null);
    const read = vi.spyOn(store, 'getProposal');
    const request = event({}, 'proposal');
    expect((await detail(request)).error?.code).toBe('FINANCIAL_READ_UNAVAILABLE');
    expect(request.node.res.statusCode).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });
  it('fails closed for unavailable authorization storage', async () => {
    current.unavailable = true;
    const request = event({}, 'proposal');
    expect((await detail(request)).error?.code).toBe('FINANCIAL_READ_UNAVAILABLE');
    expect(request.node.res.statusCode).toBe(503);
  });
  it('reports failed stored-proposal reads without returning partial detail', async () => {
    await grant();
    vi.spyOn(store, 'getProposal').mockRejectedValue(new Error('Storage unavailable'));
    const request = event({}, 'proposal');
    const response = await detail(request);
    expect(response.error?.code).toBe('PROPOSAL_SHOW_FAILED');
    expect(response.result).toBeNull();
    expect(request.node.res.statusCode).toBe(500);
  });
});

describe('development review seeding safety and lifecycle', () => {
  it('requires explicit environment opt-in and writes no review items when disabled', async () => {
    const request = event();
    expect((await seed(request)).error?.code).toBe('SEED_DISABLED');
    expect(request.node.res.statusCode).toBe(403);
    expect(await store.listReviewItems()).toEqual([]);
  });
  it('reports storage unavailability when explicitly enabled', async () => {
    vi.stubEnv('BALANCEFRAME_SEED_ALLOWED', 'true');
    current.unavailable = true;
    const request = event();
    expect((await seed(request)).error?.code).toBe('STORE_UNAVAILABLE');
    expect(request.node.res.statusCode).toBe(503);
  });
  it('creates pending reviews with correction alternatives usable by the review surface', async () => {
    vi.stubEnv('BALANCEFRAME_SEED_ALLOWED', 'true');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const response = await seed(event());
    expect(response.status).toBe('ok');
    const queue = await store.listReviewItems({ status: 'pending_review' });
    expect(queue.map((item) => item.id).sort()).toEqual(
      response.result!.items.map((item) => item.id).sort(),
    );
    for (const item of queue) {
      expect(item.status).toBe('pending_review');
      expect(new Date(item.freshnessExpiresAt!).getTime()).toBeGreaterThan(Date.now());
      const evidence = item.evidence as {
        alternatives: string[];
        categoryNames: Record<string, string>;
      };
      expect(
        evidence.alternatives.every((id) => typeof evidence.categoryNames[id] === 'string'),
      ).toBe(true);
      expect(item.provenance).toBe('dev-seed');
    }
    const first = queue[0]!;
    const approved = await store.transitionReviewItem(first.id, {
      toStatus: 'approved',
      actor: actorId,
      expectedVersion: first.version,
    });
    expect(approved.status).toBe('approved');
    expect(connect).not.toHaveBeenCalled();
  });
  it('isolates a failed seed write and still persists the remaining pending reviews', async () => {
    vi.stubEnv('BALANCEFRAME_SEED_ALLOWED', 'true');
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(store, 'createReviewItem').mockRejectedValueOnce(new Error('Storage busy'));
    const response = await seed(event());
    expect(response.status).toBe('ok');
    const failed = response.result!.items.filter((item) => item.id.startsWith('error:'));
    expect(failed).toHaveLength(1);
    const queue = await store.listReviewItems({ status: 'pending_review' });
    expect(queue.map((item) => item.transactionId).sort()).toEqual(
      response
        .result!.items.filter((item) => !item.id.startsWith('error:'))
        .map((item) => item.transactionId)
        .sort(),
    );
    expect(queue.some((item) => item.transactionId === failed[0]!.transactionId)).toBe(false);
  });
});
