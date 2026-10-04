import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getCookie: (event: { cookies?: Record<string, string> }, name: string) => event.cookies?.[name],
  getHeader: (event: { headers?: Record<string, string> }, name: string) => event.headers?.[name.toLowerCase()],
  setHeader: vi.fn(),
  setResponseStatus: vi.fn(),
}));
vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({ loadConfig }),
}));

import handler from '../../server/api/reports/views.get';

const actorId = 'saved-view-reader';
const ownerId = 'saved-view-owner';
const now = '2098-01-01T12:00:00.000Z';
const controlAuth = {
  method: 'human-session' as const,
  actorId: ownerId,
  sessionId: `session:${ownerId}`,
  reauthenticatedAt: now,
};
let store: SqliteWorkflowStore;
let selectedBudgetId = '';
let fixtureSequence = 0;

function event(spaceId: string): EventWithContext {
  return {
    headers: { 'x-balanceframe-space': spaceId },
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
    },
  };
}

async function selectedScope(budgetId: string) {
  const governance = store.governance;
  const unbound = governance.createSpace({
    actorId: ownerId,
    name: budgetId,
    kind: 'shared',
    now,
    auth: controlAuth,
  });
  const space = governance.bindBudget({
    spaceId: unbound.id,
    budgetId,
    now,
    auth: controlAuth,
  });
  const membership = governance.addMembership({
    spaceId: space.id,
    actorId,
    validFrom: now,
    now,
    auth: controlAuth,
  });
  for (const capability of ['observe', 'full-read']) {
    governance.provisionResourceGrant({
      spaceId: space.id,
      actorId,
      membershipId: membership.id,
      budgetId,
      capability,
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: true,
      now,
      auth: controlAuth,
    });
  }
  return { actorId, spaceId: space.id, budgetId, membershipId: membership.id };
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const workflow = getWorkflowStore(event('') as EventWithContext);
  if ('error' in workflow) throw new Error(workflow.error);
  store = workflow.store;
  await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'saved-view-list' });
  await store.finalizeBootstrap({ claimId: 'saved-view-list', ownerUserId: ownerId });
  await store.upsertActorMembership(actorId, 'active', [], '');
});

beforeEach(() => {
  vi.clearAllMocks();
  fixtureSequence += 1;
  selectedBudgetId = `saved-view-selected-budget-${fixtureSequence}`;
  loadConfig.mockImplementation(async () => ({ budgetId: selectedBudgetId }));
});

afterAll(() => {
  store.close();
  vi.useRealTimers();
});

describe('GET /api/reports/views', () => {
  it('lists persisted views only from the currently selected space and budget', async () => {
    const selected = await selectedScope(selectedBudgetId);
    const foreign = await selectedScope(`saved-view-foreign-budget-${fixtureSequence}`);
    await store.createSavedView({
      authority: selected,
      name: 'Selected Monthly',
      viewType: 'pending_review',
      scope: { monthRange: '2098-01', privateFilter: 'selected-space-filter' },
    });
    await store.createSavedView({
      authority: foreign,
      name: 'Foreign Monthly',
      viewType: 'pending_review',
      scope: { privateFilter: 'foreign-space-filter' },
    });

    const response = await handler(event(selected.spaceId));

    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({
      total: 1,
      views: [{
        name: 'Selected Monthly',
        viewType: 'pending_review',
        scope: { monthRange: '2098-01', privateFilter: 'selected-space-filter' },
      }],
    });
    expect(JSON.stringify(response)).not.toContain('Foreign Monthly');
    expect(JSON.stringify(response)).not.toContain('foreign-space-filter');
  });
});
