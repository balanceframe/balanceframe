/**
 * Current rule-read boundary behavior.
 *
 * Verifies current full-read authorization, selected-budget connection errors,
 * rule projection and local override persistence.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';


const {
  mockSetResponseStatus,
  mockSetHeader,
  mockLoadConfig,
  mockWithConnection,
  mockCreateMutationConnectionManager,
} = vi.hoisted(() => ({
  mockSetResponseStatus: vi.fn(),
  mockSetHeader: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockWithConnection: vi.fn(),
  mockCreateMutationConnectionManager: vi.fn(),
}));

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getCookie: (event: { cookies?: Record<string, string> }, name: string) => event.cookies?.[name],
  getHeader: (event: { headers?: Record<string, string>; node?: { req?: { headers?: Record<string, string> } } }, name: string) =>
    event.node?.req?.headers?.[name.toLowerCase()] ?? event.headers?.[name.toLowerCase()],
  setHeader: mockSetHeader,
  setResponseStatus: mockSetResponseStatus,
}));

vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({ loadConfig: mockLoadConfig }),
}));

vi.mock('../../server/utils/mutation-executor', () => ({
  createMutationConnectionManager: mockCreateMutationConnectionManager,
}));


import listRulesHandler from '../../server/api/rule/index.get';
import showRuleHandler from '../../server/api/rule/[id].get';

const actorId = 'test-actor';
const ownerId = 'rule-space-owner';
let budgetId = 'budget_test';
const now = new Date().toISOString();
const controlAuth = {
  method: 'human-session' as const,
  actorId: ownerId,
  sessionId: `session:${ownerId}`,
  reauthenticatedAt: now,
};
let routeStore: SqliteWorkflowStore;
let selectedSpaceId = '';
let routeMembershipId = '';
let fixtureSequence = 0;

function routeEvent(id = 'rule-1') {
  return {
    headers: { 'x-balanceframe-space': selectedSpaceId },
    node: {
      req: { headers: { 'x-balanceframe-space': selectedSpaceId } },
      res: { headersSent: false },
    },
    cookies: {},
    context: {
      runtimeConfig: { workflowDbPath: ':memory:' },
      auth: {
        authenticated: true,
        actorId,
        principalType: 'human',
        method: 'session',
        sessionId: `session:${actorId}`,
        user: { id: actorId },
      },
      params: { id },
    },
  };
}

function notConnectedError() {
  return Object.assign(new Error('No BalanceFrame connection configured.'), {
    code: 'not_connected',
  });
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const workflow = getWorkflowStore(routeEvent());
  if ('error' in workflow) throw new Error('Rule API test workflow store unavailable');
  routeStore = workflow.store;
  await routeStore.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'rule-api-fixture' });
  await routeStore.finalizeBootstrap({ claimId: 'rule-api-fixture', ownerUserId: ownerId });
  await routeStore.upsertActorMembership(actorId, 'active', [], '');
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  budgetId = `budget_test_${++fixtureSequence}`;
  const space = routeStore.governance.createSpace({
    actorId: ownerId,
    name: 'Rule API selected space',
    kind: 'shared',
    now,
    auth: controlAuth,
  });
  selectedSpaceId = space.id;
  routeStore.governance.bindBudget({ spaceId: selectedSpaceId, budgetId, now, auth: controlAuth });
  if (!routeStore.governance.getPolicy({ spaceId: selectedSpaceId })) {
    routeStore.governance.setPolicy({
      spaceId: selectedSpaceId,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [] },
      now,
      auth: controlAuth,
    });
  }
  const membership = routeStore.governance.addMembership({
    spaceId: selectedSpaceId,
    actorId,
    validFrom: now,
    now,
    auth: controlAuth,
  });
  routeMembershipId = membership.id;
  for (const capability of ['observe', 'full-read'] as const) {
    routeStore.governance.provisionResourceGrant({
      spaceId: selectedSpaceId,
      actorId,
      membershipId: routeMembershipId,
      budgetId,
      capability,
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: true,
      now,
      auth: controlAuth,
    });
  }
  mockLoadConfig.mockResolvedValue({ budgetId });
  mockCreateMutationConnectionManager.mockReturnValue({
    withConnection: mockWithConnection,
  });
  vi.stubGlobal('setResponseStatus', mockSetResponseStatus);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  routeStore.close();
  vi.useRealTimers();
});

describe('rule GET connection failures', () => {
  it('returns the canonical recovery envelope for a missing selection in the list route', async () => {
    mockWithConnection.mockRejectedValueOnce(notConnectedError());

    const response = await listRulesHandler(routeEvent());

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
    expect(response.error).toEqual({
      code: 'not_connected',
      message: 'No ledger connected. Configure an Actual budget first.',
      retryable: true,
    });
  });

  it('preserves the list route operational failure for an unreadable configuration', async () => {
    mockWithConnection.mockRejectedValueOnce(new Error('Could not read Actual configuration.'));

    const response = await listRulesHandler(routeEvent());

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
    expect(response.error.code).toBe('LEDGER_UNAVAILABLE');
    expect(response.error.message).toBe(
      'Failed to connect to Actual: Could not read Actual configuration.',
    );
  });

  it('returns the canonical recovery envelope for a missing selection in the detail route', async () => {
    mockWithConnection.mockRejectedValueOnce(notConnectedError());

    const response = await showRuleHandler(routeEvent());

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
    expect(response.error).toEqual({
      code: 'not_connected',
      message: 'No ledger connected. Configure an Actual budget first.',
      retryable: true,
    });
  });

  it('preserves the detail route operational failure for an unreadable configuration', async () => {
    mockWithConnection.mockRejectedValueOnce(new Error('Could not read Actual configuration.'));

    const response = await showRuleHandler(routeEvent());

    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 500);
    expect(response.error).toEqual({
      code: 'RULE_SHOW_FAILED',
      message: 'Could not read Actual configuration.',
      retryable: true,
    });
  });
  it('returns selected-space rules with current local overrides and private caching', async () => {
    await routeStore.setRuleOverride({
      spaceId: selectedSpaceId,
      budgetId,
      ruleId: 'rule-1',
      inactive: true,
      expectedVersion: null,
    });
    const rules = [{
      id: 'rule-1',
      name: 'Rule One',
      order: 1,
      trigger: [{ field: 'payee_name', op: 'is', value: 'Merchant' }],
      actions: [{ type: 'set-category', field: 'category', value: 'food' }],
      inactive: false,
      stage: 'pre' as const,
      conditionsOp: 'and' as const,
    }];
    mockWithConnection.mockImplementationOnce(async (operation) =>
      operation({
        budget: { id: budgetId },
        connector: { listRules: vi.fn().mockResolvedValue(rules) },
      }),
    );

    const response = await listRulesHandler(routeEvent());
    expect(response.error).toBeNull();
    expect(response).toMatchObject({ status: 'ok' });
    expect(response.result.items).toEqual([{
      ...rules[0],
      inactive: true,
      _localOverride: true,
    }]);
    expect(mockSetHeader).toHaveBeenCalledWith(expect.anything(), 'Cache-Control', 'private, no-store');
    expect(mockWithConnection).toHaveBeenCalledWith(expect.any(Function), {
      expectedBudgetId: budgetId,
      dispose: true,
    });
  });

  it('preserves Actual inactive state in list and detail without a scoped override', async () => {
    const rule = {
      id: 'rule-1',
      name: 'Rule One',
      order: 1,
      trigger: [{ field: 'payee_name', op: 'is', value: 'Merchant' }],
      actions: [{ type: 'set-category', field: 'category', value: 'food' }],
      inactive: true,
      stage: 'pre' as const,
      conditionsOp: 'and' as const,
    };
    mockWithConnection.mockImplementation(async (operation) =>
      operation({ budget: { id: budgetId }, connector: { listRules: vi.fn().mockResolvedValue([rule]) } }),
    );

    const list = await listRulesHandler(routeEvent());
    const detail = await showRuleHandler(routeEvent('rule-1'));

    expect(list.status).toBe('ok');
    expect(list.result.items).toEqual([rule]);
    expect(detail.status).toBe('ok');
    expect(detail.result).toEqual(rule);
    expect(mockWithConnection).toHaveBeenNthCalledWith(1, expect.any(Function), {
      expectedBudgetId: budgetId,
      dispose: true,
    });
    expect(mockWithConnection).toHaveBeenNthCalledWith(2, expect.any(Function), {
      expectedBudgetId: budgetId,
      dispose: true,
    });
  });
  it('returns one selected-space rule with the scoped BalanceFrame override in detail', async () => {
    await routeStore.setRuleOverride({
      spaceId: selectedSpaceId,
      budgetId,
      ruleId: 'rule-1',
      inactive: true,
      expectedVersion: null,
    });
    const rule = {
      id: 'rule-1',
      name: 'Rule One',
      order: 1,
      trigger: [{ field: 'payee_name', op: 'is', value: 'Merchant' }],
      actions: [{ type: 'set-category', field: 'category', value: 'food' }],
      inactive: false,
      stage: 'pre' as const,
      conditionsOp: 'and' as const,
    };
    mockWithConnection.mockImplementationOnce(async (operation) =>
      operation({ budget: { id: budgetId }, connector: { listRules: vi.fn().mockResolvedValue([rule]) } }),
    );

    const response = await showRuleHandler(routeEvent('rule-1'));

    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({ ...rule, inactive: true, _localOverride: true });
    expect(mockSetHeader).toHaveBeenCalledWith(expect.anything(), 'Cache-Control', 'private, no-store');
  });
  it('never applies a same-ID override from a foreign space', async () => {
    const foreign = routeStore.governance.createSpace({
      actorId: ownerId,
      name: 'Foreign rule space',
      kind: 'shared',
      now,
      auth: controlAuth,
    });
    routeStore.governance.bindBudget({
      spaceId: foreign.id,
      budgetId: 'foreign-budget',
      now,
      auth: controlAuth,
    });
    await routeStore.setRuleOverride({
      spaceId: foreign.id,
      budgetId: 'foreign-budget',
      ruleId: 'rule-1',
      inactive: true,
      expectedVersion: null,
    });
    const rule = {
      id: 'rule-1',
      name: 'Rule One',
      order: 1,
      trigger: [{ field: 'payee_name', op: 'is', value: 'Merchant' }],
      actions: [{ type: 'set-category', field: 'category', value: 'food' }],
      inactive: false,
      stage: 'pre' as const,
      conditionsOp: 'and' as const,
    };
    mockWithConnection.mockImplementationOnce(async (operation) =>
      operation({ budget: { id: budgetId }, connector: { listRules: vi.fn().mockResolvedValue([rule]) } }),
    );

    const response = await listRulesHandler(routeEvent());

    expect(response.status).toBe('ok');
    expect(response.result.items).toEqual([rule]);
  });
});
