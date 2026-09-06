import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { ResourceCapability } from '@balanceframe/workflow-store';
import type * as WorkflowUtils from '../../server/utils/workflow-store';

const { current, loadConfig, withConnection, native, analysis, query, body, listBudgets, connect } =
  vi.hoisted(() => ({
    current: { store: null as SqliteWorkflowStore | null },
    loadConfig: vi.fn(),
    withConnection: vi.fn(),
    native: vi.fn(),
    analysis: vi.fn(),
    query: vi.fn(),
    body: vi.fn(),
    listBudgets: vi.fn(),
    connect: vi.fn(),
  }));
vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getQuery: query,
  readBody: body,
  getRouterParam: (event: { context: { params?: Record<string, string> } }, name: string) =>
    event.context.params?.[name],
  setResponseStatus: vi.fn(),
}));
vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({ loadConfig, withConnection, listBudgets, connect }),
  createNativeAnalysisProtocol: native,
  liquidityCoverageAnalysis: analysis,
}));
vi.mock('../../server/utils/workflow-store', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowUtils>()),
  getWorkflowStore: () => ({ store: current.store! }),
}));
import handler from '../../server/api/liquidity.get';
import historyHandler from '../../server/api/reports/history.get';
import viewHandler from '../../server/api/reports/views/[id].get';
import duplicateViewHandler from '../../server/api/reports/views/[id]/duplicate.post';
import reviewHandler from '../../server/api/review/index.get';
import proposalHandler from '../../server/api/proposal/index.get';
import discoveryHandler from '../../server/api/connection/budgets.get';
import selectionHandler from '../../server/api/connection/index.post';

const actorId = 'reader';
const budgetId = 'selected-private-budget';
const secret = 'private-source-balance-and-routing-proof';
const now = '2026-09-06T12:00:00.000Z';
const fullRead = 'full-read' as ResourceCapability;
const event = (id = actorId) => ({ context: { auth: { authenticated: true, user: { id } } } });

describe('legacy whole-budget financial read authorization', () => {
  let store: SqliteWorkflowStore;
  let directory: string;
  beforeEach(() => {
    vi.clearAllMocks();
    directory = mkdtempSync(join(tmpdir(), 'legacy-full-read-'));
    store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
    current.store = store;
    loadConfig.mockResolvedValue({ budgetId, budgetName: 'Private budget' });
    withConnection.mockImplementation(async (operation) =>
      operation({ budget: { id: budgetId }, connector: {} }),
    );
    native.mockResolvedValue({});
    analysis.mockResolvedValue({
      status: 'ok',
      requestId: 'analysis',
      result: { privateEvidence: secret, accountId: 'hidden-source' },
    });
    query.mockReturnValue({});
    body.mockResolvedValue({ budgetId: 'foreign-budget' });
    listBudgets.mockResolvedValue([
      { id: 'foreign-budget', groupId: 'group', name: secret, encrypted: false },
    ]);
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function grant(
    capabilities = ['observe', 'liquidity:full-read'],
    grantedBudget = budgetId,
  ) {
    await store.upsertActorMembership(actorId, 'active', capabilities, `budget:${grantedBudget}`);
    store.liquidity.setResourceGrant({
      actorId,
      budgetId: grantedBudget,
      capability: fullRead,
      resourceKind: 'budget',
      resourceId: grantedBudget,
      granted: true,
      now,
    });
  }
  async function expectDenied(request = event()) {
    const response = await handler(request);
    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain('hidden-source');
    expect(withConnection).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    expect(analysis).not.toHaveBeenCalled();
  }

  it.each([
    ['observe-only', ['observe']],
    ['conclusion-only', ['observe', 'liquidity:conclusion']],
  ])(
    'denies %s before restoring any connection or exposing private evidence',
    async (_label, capabilities) => {
      await store.upsertActorMembership(
        actorId,
        'active',
        capabilities as string[],
        `budget:${budgetId}`,
      );
      store.liquidity.setResourceGrant({
        actorId,
        budgetId,
        capability: 'conclusion',
        resourceKind: 'budget',
        resourceId: budgetId,
        granted: true,
        now,
      });
      await expectDenied();
    },
  );
  it('preserves the existing financial response for an explicitly granted full-read member', async () => {
    await grant();
    const response = await handler(event());
    expect(response.status).toBe('ok');
    expect(response.result).toEqual({ privateEvidence: secret, accountId: 'hidden-source' });
  });
  it('requires observe as well as the separate full-read grant for nonowners', async () => {
    await grant(['liquidity:full-read']);
    await expectDenied();
  });
  it('allows the actual registered owner only while current budget membership is active', async () => {
    store['db']
      .prepare(
        'INSERT INTO registration_state(singleton,owner_user_id,bootstrapped_at) VALUES (1,?,?)',
      )
      .run(actorId, now);
    await store.upsertActorMembership(actorId, 'active', [], `budget:${budgetId}`);
    expect((await handler(event())).result).toEqual({
      privateEvidence: secret,
      accountId: 'hidden-source',
    });
    await store.upsertActorMembership(actorId, 'inactive', [], `budget:${budgetId}`);
    vi.clearAllMocks();
    await expectDenied();
  });
  it('reauthorizes a previously allowed reader after the resource grant is revoked', async () => {
    await grant();
    expect((await handler(event())).status).toBe('ok');
    store.liquidity.setResourceGrant({
      actorId,
      budgetId,
      capability: fullRead,
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now,
    });
    vi.clearAllMocks();
    await expectDenied();
  });
  it('reauthorizes a previously allowed reader after membership is suspended', async () => {
    await grant();
    expect((await handler(event())).status).toBe('ok');
    await store.upsertActorMembership(
      actorId,
      'suspended',
      ['observe', 'liquidity:full-read'],
      `budget:${budgetId}`,
    );
    vi.clearAllMocks();
    await expectDenied();
  });
  it('uses the selected server budget and authenticated actor rather than forged query identities', async () => {
    await grant(['observe', 'liquidity:full-read'], 'different-budget');
    query.mockReturnValue({ budgetId: 'different-budget', actorId: 'owner' });
    await expectDenied();
  });
  it('pins report history to the selected budget even when a foreign budget is requested', async () => {
    await grant();
    await store.createReportRecord({
      budgetId,
      reportType: 'summary',
      config: { label: 'selected' },
      policyVersion: '1',
    });
    await store.createReportRecord({
      budgetId: 'foreign-budget',
      reportType: 'summary',
      config: { label: secret },
      policyVersion: '1',
    });
    query.mockReturnValue({ budgetId: 'foreign-budget' });
    const response = await historyHandler(event());
    expect(JSON.stringify(response)).not.toContain(secret);
    if (response.status === 'ok')
      expect(
        response.result.entries.every((entry: { budgetId: string }) => entry.budgetId === budgetId),
      ).toBe(true);
  });
  it('never returns another actor saved view through an arbitrary view ID', async () => {
    await grant();
    const foreign = await store.createSavedView({
      actorId: 'other-actor',
      name: secret,
      viewType: 'budget_summary',
      scope: {},
    });
    const response = await viewHandler({
      ...event(),
      context: { ...event().context, params: { id: foreign.viewId } },
    });
    expect(response.status).toBe('error');
    expect(JSON.stringify(response)).not.toContain(secret);
  });
  it('duplicates an owned saved view while refusing a foreign source', async () => {
    await grant();
    body.mockResolvedValue({ name: 'Owned copy' });
    const owned = await store.createSavedView({
      actorId,
      name: 'Owned original',
      viewType: 'budget_summary',
      scope: {},
    });
    const duplicated = await duplicateViewHandler({
      ...event(),
      context: { ...event().context, params: { id: owned.viewId } },
    });
    expect(duplicated.status).toBe('ok');
    expect(duplicated.result).toMatchObject({ name: 'Owned copy', actorId });
    const foreign = await store.createSavedView({
      actorId: 'other-actor',
      name: secret,
      viewType: 'budget_summary',
      scope: {},
    });
    const denied = await duplicateViewHandler({
      ...event(),
      context: { ...event().context, params: { id: foreign.viewId } },
    });
    expect(denied.status).toBe('error');
    expect(JSON.stringify(denied)).not.toContain(secret);
  });
  it('does not mix persisted review or proposal rows from a different budget into authorized lists', async () => {
    await grant();
    for (const selected of [budgetId, 'foreign-budget']) {
      const review = await store.createReviewItem({
        budgetId: selected,
        transactionId: selected === budgetId ? 'selected-transaction' : secret,
        categoryId: 'food',
        classifier: 'manual',
        provenance: 'human',
      });
      await store.transitionReviewItem(review.id, {
        toStatus: 'suggestion_generated',
        actor: actorId,
        expectedVersion: 1,
      });
      await store.transitionReviewItem(review.id, {
        toStatus: 'pending_review',
        actor: actorId,
        expectedVersion: 2,
      });
      await store.createProposal({
        operation: 'set_category',
        budgetId: selected,
        payload: {
          kind: 'set_category',
          transactionId: selected === budgetId ? 'selected-transaction' : secret,
          categoryId: 'food',
        },
        payloadHash: (selected === budgetId ? 'a' : 'b').repeat(64),
        policyVersion: '1',
        preconditions: '{}',
        actorId,
        provenance: 'human',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }
    const reviews = await reviewHandler(event());
    const proposals = await proposalHandler(event());
    expect(reviews.status).toBe('ok');
    expect(proposals.status).toBe('ok');
    expect(JSON.stringify(reviews)).not.toContain(secret);
    expect(JSON.stringify(proposals)).not.toContain(secret);
    expect(reviews.result.total).toBe(1);
    expect(proposals.result.total).toBe(1);
  });

  it('does not treat selected-budget full-read as server-wide budget discovery or selection authority', async () => {
    await grant();
    expect((await discoveryHandler(event())).status).toBe('error');
    expect((await selectionHandler(event())).status).toBe('error');
    expect(listBudgets).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it('permits first-setup discovery only for the current active registered owner without selected-budget config', async () => {
    store['db']
      .prepare(
        'INSERT INTO registration_state(singleton,owner_user_id,bootstrapped_at) VALUES (1,?,?)',
      )
      .run(actorId, now);
    await store.upsertActorMembership(actorId, 'active', [], '*');
    loadConfig.mockResolvedValue(null);
    expect((await discoveryHandler(event())).result.budgets[0].name).toBe(secret);
    await store.upsertActorMembership(actorId, 'suspended', [], '*');
    vi.clearAllMocks();
    expect((await discoveryHandler(event())).status).toBe('error');
    expect(listBudgets).not.toHaveBeenCalled();
  });
});
