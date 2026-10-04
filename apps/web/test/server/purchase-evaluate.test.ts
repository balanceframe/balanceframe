import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  mocks.loadConfig.mockResolvedValue({ budgetId });
  mocks.withConnection.mockImplementation(async (operation) =>
    operation({
      config: { budgetId },
      budget: { id: budgetId },
      connector: {},
      synchronization: { financialSnapshot: snapshot },
    }),
  );
  mocks.evaluateDecisionCard.mockImplementation(() => {
    throw new Error('Private savings source insufficient: account-private, 900000 USD');
  });
});

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
