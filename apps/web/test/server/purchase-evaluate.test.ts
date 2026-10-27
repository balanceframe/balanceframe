import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent } from 'h3';
import type * as H3 from 'h3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FinancialSnapshot } from '@balanceframe/protocol-generated';
import type { ConnectionManager, LiquidityServiceOptions } from '@balanceframe/application';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { actualLiquidityRequest } from '../../../../tests/contract/fixtures/actual-liquidity.js';

const mocks = vi.hoisted(() => ({
  manager: null as unknown,
  evaluateDecisionCard: vi.fn(),
  withConnection: vi.fn(async (operation: (connected: unknown) => Promise<unknown>) => operation({})),
  loadConfig: vi.fn(),
}));

vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));
// The hoisted package mock loads the Source class so tests never use a stale workspace dist export.
vi.mock('@balanceframe/application', async () => {
  const application = await import('../../../../packages/application/src/index');
  return {
    ...application,
    createDefaultConnectionManager: () => mocks.manager as ConnectionManager,
    createLiquidityService: async (options: Omit<LiquidityServiceOptions, 'native'>) =>
      new application.LiquidityService({
        ...options,
        native: {
          evaluateDecisionCard: (input: string) => {
            mocks.evaluateDecisionCard(input);
            return '{}';
          },
          evaluateAccountAwareSpendability: () => '{}',
          verifyTransferPreconditions: () => '{}',
          verifyTransferSettlement: () => '{}',
        },
      }),
  };
});

vi.mock('../../server/utils/bounded-json', () => ({
  readBoundedJsonBody: async (event: H3.H3Event) => event.context.explanationBody,
}));
import explainHandler from '../../server/api/purchase/explain.post';
import handler from '../../server/api/purchase/evaluate.get';

const OWNER = 'purchase-route-owner';
const ACTOR = 'purchase-route-human';
const NOW = '2026-09-06T10:01:00.000Z';
const ownerAuth = {
  method: 'human-session' as const,
  actorId: OWNER,
  sessionId: `session:${OWNER}`,
  reauthenticatedAt: NOW,
};
const baseSnapshot = actualLiquidityRequest(false).financialSnapshot;
let directory = '';
let store: SqliteWorkflowStore;
let sequence = 0;
let spaceId = '';
let budgetId = '';
let membershipId = '';
let snapshot: FinancialSnapshot;
let connectionSource = 'fixture-connection';

function request(url: string) {
  const req = new IncomingMessage(new Socket());
  req.url = url;
  req.method = 'GET';
  req.headers = { 'x-balanceframe-space': spaceId };
  const event = createEvent(req, new ServerResponse(req)) as unknown as H3.H3Event & EventWithContext;
  event.context.auth = {
    authenticated: true,
    actorId: 'forged-legacy-actor',
    user: { id: ACTOR },
    method: 'session',
    principalType: 'human',
    sessionId: `session:${ACTOR}`,
    impersonatedBy: null,
  };
  event.context.runtimeConfig = { workflowDbPath: join(directory, 'workflow.sqlite'), devBypassAuth: false };
  return event;
}

function grant(capability: string, resourceKind: 'budget' | 'category' | 'account', resourceId: string) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: ACTOR,
    membershipId,
    budgetId,
    capability,
    resourceKind,
    resourceId,
    granted: true,
    now: NOW,
    auth: ownerAuth,
  });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  directory = mkdtempSync(join(tmpdir(), 'purchase-evaluate-native-'));
  const opened = getWorkflowStore(request('/api/purchase/evaluate') as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({
    name: 'Purchase route owner',
    email: 'purchase-route-owner@example.test',
    claimId: 'purchase-evaluate-native-fixture',
  });
  await store.finalizeBootstrap({ claimId: 'purchase-evaluate-native-fixture', ownerUserId: OWNER });
  await store.upsertActorMembership(ACTOR, 'active', [], '');
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BALANCEFRAME_CONVERSATION_POLICY', '');
  vi.stubEnv('BALANCEFRAME_CONVERSATION_PROVIDER', '');
  vi.stubEnv('BALANCEFRAME_CONVERSATION_API_KEY', '');
  budgetId = `purchase-route-budget-${++sequence}`;
  const baseSpace = store.governance.createSpace({
    actorId: OWNER,
    name: `Purchase route space ${sequence}`,
    kind: 'shared',
    now: NOW,
    auth: ownerAuth,
  });
  spaceId = store.governance.bindBudget({
    spaceId: baseSpace.id,
    budgetId,
    now: NOW,
    auth: ownerAuth,
  }).id;
  if (!store.governance.getPolicy({ spaceId }))
    store.governance.setPolicy({
      spaceId,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [] },
      now: NOW,
      auth: ownerAuth,
    });
  membershipId = store.governance.addMembership({
    spaceId,
    actorId: ACTOR,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  }).id;
  snapshot = { ...baseSnapshot, source: { ...baseSnapshot.source, budgetId } };
  mocks.manager = {
    loadConfig: mocks.loadConfig,
    withConnection: mocks.withConnection,
  };
  connectionSource = 'fixture-connection';
  mocks.loadConfig.mockResolvedValue({ budgetId });
  mocks.withConnection.mockImplementation(async (operation) =>
    operation({
      config: { budgetId, serverUrl: connectionSource },
      budget: { id: budgetId },
      connector: {},
      synchronization: { financialSnapshot: snapshot },
    }),
  );
  mocks.evaluateDecisionCard.mockImplementation(() => {
    throw new Error('Private savings source insufficient: account-private, 900000 USD');
  });
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('GET /api/purchase/evaluate current Native trust boundary', () => {
  it('denies an authenticated member without the exact evaluation grant before connection access', async () => {
    const response = await handler(request('/api/purchase/evaluate?categoryId=food&amount=2000&currency=USD&accountId=cash&purchaseAt=2026-09-06T12%3A00%3A00.000Z&requiredBy=2026-09-06T12%3A00%3A00.000Z'));

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(response.authorization).toBeNull();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(mocks.evaluateDecisionCard).not.toHaveBeenCalled();
  });

  it('rejects caller financial context after current exact-scope authorization and keeps the session actor', async () => {
    grant('affordability:evaluate', 'budget', budgetId);

    const response = await handler(request(
      '/api/purchase/evaluate?categoryId=food&amount=2000&currency=USD&accountId=cash&purchaseAt=2026-09-06T12%3A00%3A00.000Z&requiredBy=2026-09-06T12%3A00%3A00.000Z&actorId=owner&context=%7B%22actorId%22%3A%22owner%22%7D',
    ));

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('INVALID_LIQUIDITY_INPUT');
    expect(response.authorization).toMatchObject({ actorId: ACTOR, capability: 'affordability:evaluate', allowed: true });
    expect(mocks.loadConfig).toHaveBeenCalledOnce();
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(mocks.evaluateDecisionCard).not.toHaveBeenCalled();
  });

  it('redacts private Native evaluation failures for a current selected-space grant', async () => {
    grant('affordability:evaluate', 'budget', budgetId);
    grant('conclusion', 'budget', budgetId);
    grant('existence', 'category', 'food');
    grant('conclusion', 'category', 'food');
    grant('existence', 'account', 'cash');
    const currentPolicy = store.governance.getPolicy({ spaceId });
    if (!currentPolicy) throw new Error('Current purchase fixture policy unavailable');
    const ownerMembership = store.governance.getCurrentMembership({ spaceId, actorId: OWNER, now: NOW });
    if (!ownerMembership) throw new Error('Current purchase owner membership unavailable');
    const policy = actualLiquidityRequest(false).liquidityPolicy;
    store.liquidity.savePolicy({
      actorId: OWNER,
      budgetId,
      spaceId,
      membershipId: ownerMembership.id,
      now: NOW,
      auth: ownerAuth,
      expectedVersion: null,
      expectedGovernancePolicyVersion: currentPolicy.version,
      policy: { ...policy, reservationMode: 'inform' },
      approvalPolicy: { minimumApprovers: 1 },
    });

    const response = await handler(request('/api/purchase/evaluate?categoryId=food&amount=2000&currency=USD&accountId=cash&purchaseAt=2026-09-06T12%3A00%3A00.000Z&requiredBy=2026-09-06T12%3A00%3A00.000Z'));
    const serialized = JSON.stringify(response);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('LIQUIDITY_REFRESH_REQUIRED');
    expect(response.authorization).toMatchObject({ actorId: ACTOR, capability: 'affordability:evaluate', allowed: true });
    expect(mocks.withConnection).toHaveBeenCalledOnce();
    expect(mocks.evaluateDecisionCard).toHaveBeenCalledOnce();
    expect(serialized).not.toMatch(/Private savings|account-private|900000/);
  });
});


describe('POST /api/purchase/explain selected-space boundary', () => {
  const body = {
    kind: 'purchase',
    categoryId: 'food',
    amount: { minorUnits: '2000', currency: 'USD' },
  };
  function explanationEvent(value: unknown = body) {
    const event = request('/api/purchase/explain');
    event.node.req.method = 'POST';
    event.node.req.headers.origin = 'http://localhost:3000';
    event.context.explanationBody = value;
    return event;
  }
  it('requires the exact existing evaluation capability before reading the source', async () => {
    const response = await explainHandler(explanationEvent());
    expect(response.status).toBe('error');
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });
  it('returns the ordinary insufficient-data Card with conversation disabled', async () => {
    for (const [capability, kind, id] of [
      ['affordability:evaluate', 'budget', budgetId],
      ['conclusion', 'budget', budgetId],
      ['existence', 'category', 'food'],
      ['conclusion', 'category', 'food'],
    ] as const)
      grant(capability, kind, id);
    const response = await explainHandler(explanationEvent());
    expect(response).toMatchObject({
      status: 'ok',
      authorization: { actorId: ACTOR, capability: 'affordability:evaluate' },
      result: {
        card: { outcome: 'insufficient_data', blockers: ['policy_unavailable'] },
        explanation: { status: 'manual', code: 'disabled' },
      },
    });
    expect(JSON.stringify(response)).not.toContain('forged-legacy-actor');
  });
  it.each([
    { card: {} },
    { actorId: OWNER },
    { endpoint: 'https://attacker.example' },
    { policy: { mode: 'external_allowed' } },
  ])('rejects client authority/configuration: %j', async (extra) => {
    grant('affordability:evaluate', 'budget', budgetId);
    const response = await explainHandler(explanationEvent({ ...body, ...extra }));
    expect(response).toMatchObject({ status: 'error', error: { code: 'INVALID_LIQUIDITY_INPUT' } });
    expect(mocks.withConnection).not.toHaveBeenCalled();
  });
  it.each(['valid', 'source', 'connection', 'credential', 'policy'] as const)(
    'runs the configured transport with normal public scope and rejects late %s changes',
    async (mode) => {
      for (const [capability, kind, id] of [
        ['affordability:evaluate', 'budget', budgetId],
        ['conclusion', 'budget', budgetId],
        ['existence', 'category', 'food'],
        ['conclusion', 'category', 'food'],
      ] as const)
        grant(capability, kind, id);
      const policy = {
        mode: 'external_allowed',
        revision: 'policy-1',
        timeoutMs: 1000,
        allowedProviders: [
          {
            id: 'conversation',
            model: 'approved-model',
            endpoint: 'https://synthetic.example/chat',
            promptVersion: 'decision-card-explanation-v1',
          },
        ],
      };
      vi.stubEnv('BALANCEFRAME_CONVERSATION_POLICY', JSON.stringify(policy));
      vi.stubEnv(
        'BALANCEFRAME_CONVERSATION_PROVIDER',
        JSON.stringify({
          id: 'conversation',
          model: 'approved-model',
          endpoint: 'https://synthetic.example/chat',
          locality: 'external',
        }),
      );
      vi.stubEnv('BALANCEFRAME_CONVERSATION_API_KEY', 'synthetic-only');
      let valid = true;
      const event = explanationEvent();
      event.context.auth!.isCredentialValid = () => valid;
      const fetchFn = vi.fn<typeof fetch>(async () => {
        if (mode === 'source')
          snapshot.legacySnapshot.accounts[0]!.name = 'changed synthetic source';
        if (mode === 'connection') connectionSource = 'changed-fixture-connection';
      if (mode === 'credential') valid = false;
        if (mode === 'policy')
          process.env.BALANCEFRAME_CONVERSATION_POLICY = JSON.stringify({
            ...policy,
            revision: 'policy-2',
          });
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: { content: JSON.stringify({ status: 'explained', factIds: ['f0'] }) },
              },
            ],
          }),
        );
      });
      vi.stubGlobal('fetch', fetchFn);
      const response = await explainHandler(event);
      expect(fetchFn).toHaveBeenCalledOnce();
      if (mode === 'valid')
        expect(response).toMatchObject({
          status: 'ok',
          result: {
            card: { outcome: 'insufficient_data' },
            explanation: {
              status: 'explained',
              facts: [{ kind: 'outcome', code: 'insufficient_data' }],
            },
          },
        });
      else expect(response).toMatchObject({ status: 'error', result: null });
      const sent = String(fetchFn.mock.calls[0]![1]!.body);
      expect(sent).not.toContain(budgetId);
      expect(sent).not.toContain(ACTOR);
      expect(sent).not.toContain('2000');
      expect(JSON.stringify(response)).not.toContain('synthetic-only');
    },
  );
  it('denies foreign-origin dispatch without consuming the source', async () => {
    grant('affordability:evaluate', 'budget', budgetId);
    const event = explanationEvent();
    event.node.req.headers.origin = 'https://attacker.example';
    const response = await explainHandler(event);
    expect(response.status).toBe('error');
    expect(mocks.withConnection).not.toHaveBeenCalled();
  });
});
