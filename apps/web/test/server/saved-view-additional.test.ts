import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';

const { loadConfig } = vi.hoisted(() => ({ loadConfig: vi.fn() }));
vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getCookie: (event: { cookies?: Record<string, string> }, name: string) => event.cookies?.[name],
  getHeader: (event: { headers?: Record<string, string> }, name: string) => event.headers?.[name.toLowerCase()],
  getRouterParam: (event: { context: { params?: Record<string, string> } }, name: string) =>
    event.context.params?.[name],
  readBody: async (event: { body?: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  },
  setHeader: vi.fn(),
  setResponseStatus: (event: { statusCode?: number }, statusCode: number) => {
    event.statusCode = statusCode;
  },
}));
vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({ loadConfig }),
}));

import createHandler from '../../server/api/reports/views.post';
import getHandler from '../../server/api/reports/views/[id].get';
import patchHandler from '../../server/api/reports/views/[id].patch';
import deleteHandler from '../../server/api/reports/views/[id].delete';
import duplicateHandler from '../../server/api/reports/views/[id]/duplicate.post';
import lastUsedHandler from '../../server/api/reports/views/[id]/last-used.patch';

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
const spaceBudgetById = new Map<string, string>();
let activeConfigBudgetId = '';

function event(spaceId: string, viewId = '', body?: unknown): EventWithContext & {
  headers: Record<string, string>;
  context: EventWithContext['context'] & { params: Record<string, string> };
  body?: unknown;
  statusCode?: number;
} {
  activeConfigBudgetId = spaceBudgetById.get(spaceId) ?? selectedBudgetId;
  return {
    statusCode: 200,
    headers: { 'x-balanceframe-space': spaceId },
    body,
    context: {
      runtimeConfig: { workflowDbPath: ':memory:' },
      params: { id: viewId },
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
  spaceBudgetById.set(space.id, budgetId);
  return { actorId, spaceId: space.id, budgetId, membershipId: membership.id };
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  const workflow = getWorkflowStore(event('') as EventWithContext);
  if ('error' in workflow) throw new Error(workflow.error);
  store = workflow.store;
  await store.claimBootstrap({ name: 'Owner', email: 'owner@example.test', claimId: 'saved-view-additional' });
  await store.finalizeBootstrap({ claimId: 'saved-view-additional', ownerUserId: ownerId });
  await store.upsertActorMembership(actorId, 'active', [], '');
});

beforeEach(() => {
  vi.clearAllMocks();
  fixtureSequence += 1;
  selectedBudgetId = `saved-view-selected-budget-${fixtureSequence}`;
  spaceBudgetById.clear();
  activeConfigBudgetId = selectedBudgetId;
  loadConfig.mockImplementation(async () => ({ budgetId: activeConfigBudgetId }));
});

afterAll(() => {
  store.close();
  vi.useRealTimers();
});

describe('saved-view ID lifecycle routes', () => {
  it('keeps create validation behind real selected-space authorization', async () => {
    const selected = await selectedScope(selectedBudgetId);
    const invalidJsonEvent = event(selected.spaceId, '', new Error('malformed JSON'));
    const invalidJson = await createHandler(invalidJsonEvent);
    expect(invalidJson.status).toBe('error');
    expect(invalidJson.error?.code).toBe('INVALID_JSON');
    expect(invalidJsonEvent.statusCode).toBe(400);

    const missingNameEvent = event(selected.spaceId, '', { viewType: 'budget_summary' });
    const missingName = await createHandler(missingNameEvent);
    expect(missingName.status).toBe('error');
    expect(missingName.error?.code).toBe('MISSING_NAME');
    expect(missingNameEvent.statusCode).toBe(422);

    const missingTypeEvent = event(selected.spaceId, '', { name: 'Named view' });
    const missingType = await createHandler(missingTypeEvent);
    expect(missingType.status).toBe('error');
    expect(missingType.error?.code).toBe('MISSING_VIEW_TYPE');
    expect(missingTypeEvent.statusCode).toBe(422);
  });

  it('creates and updates within the selected immutable budget provenance', async () => {
    const selected = await selectedScope(selectedBudgetId);
    const other = await selectedScope(`saved-view-other-budget-${fixtureSequence}`);
    const created = await createHandler(event(selected.spaceId, '', {
      name: 'Created view',
      viewType: 'budget_summary',
      scope: { monthRange: '2098-01' },
    }));
    expect(created.status).toBe('ok');
    expect(created.result.view).toMatchObject({
      name: 'Created view',
      viewType: 'budget_summary',
      scope: { monthRange: '2098-01' },
      spaceId: selected.spaceId,
      budgetId: selected.budgetId,
    });
    expect(created.result.view.sort).toBeUndefined();
    const viewId = created.result.view.viewId as string;
    const otherCreated = await createHandler(event(other.spaceId, '', {
      name: 'Other scope view',
      viewType: 'budget_summary',
      scope: {},
    }));
    expect(otherCreated.status).toBe('ok');
    expect(otherCreated.result.view.budgetId).toBe(other.budgetId);

    const updated = await patchHandler(event(selected.spaceId, viewId, { name: 'Updated view' }));
    expect(updated.status).toBe('ok');
    expect(updated.result).toMatchObject({
      name: 'Updated view',
      viewType: 'budget_summary',
      scope: { monthRange: '2098-01' },
      spaceId: selected.spaceId,
      budgetId: selected.budgetId,
    });

    const foreignUpdate = await patchHandler(event(other.spaceId, viewId, { name: 'Cross-space update' }));
    expect(foreignUpdate.status).toBe('error');
    expect(foreignUpdate.error?.code).toBe('VIEW_NOT_FOUND');
    const foreignDelete = await deleteHandler(event(other.spaceId, viewId));
    expect(foreignDelete.status).toBe('error');
    expect(foreignDelete.error?.code).toBe('VIEW_NOT_FOUND');
    expect(await store.getSavedView(viewId, selected)).toMatchObject({ name: 'Updated view' });

    const deleted = await deleteHandler(event(selected.spaceId, viewId));
    expect(deleted.status).toBe('ok');
    expect(deleted.result).toEqual({ deleted: true });
  });

  it('retrieves a view only in its originating selected space', async () => {
    const selected = await selectedScope(selectedBudgetId);
    const other = await selectedScope(`saved-view-other-budget-${fixtureSequence}`);
    const saved = await store.createSavedView({
      authority: selected,
      name: 'Private saved view',
      viewType: 'budget_summary',
      scope: { privateFilter: 'private-source-scope' },
    });
    const otherSaved = await store.createSavedView({
      authority: other,
      name: 'Other space view',
      viewType: 'budget_summary',
      scope: {},
    });

    const allowed = await getHandler(event(selected.spaceId, saved.viewId));
    expect(allowed.status).toBe('ok');
    expect(allowed.result).toMatchObject({
      viewId: saved.viewId,
      name: 'Private saved view',
      spaceId: selected.spaceId,
      budgetId: selected.budgetId,
    });
    const otherAllowed = await getHandler(event(other.spaceId, otherSaved.viewId));
    expect(otherAllowed.status).toBe('ok');

    const denied = await getHandler(event(other.spaceId, saved.viewId));
    expect(denied.status).toBe('error');
    expect(denied.error?.code).toBe('VIEW_NOT_FOUND');
    expect(JSON.stringify(denied)).not.toContain('Private saved view');
    expect(JSON.stringify(denied)).not.toContain('private-source-scope');
  });

  it('duplicates and records usage only within the originating membership period', async () => {
    const selected = await selectedScope(selectedBudgetId);
    const other = await selectedScope(`saved-view-other-budget-${fixtureSequence}`);
    const saved = await store.createSavedView({
      authority: selected,
      name: 'Original view',
      viewType: 'budget_summary',
      scope: { monthRange: '2098-01' },
    });
    const otherSaved = await store.createSavedView({
      authority: other,
      name: 'Other space view',
      viewType: 'budget_summary',
      scope: {},
    });
    const otherAllowed = await getHandler(event(other.spaceId, otherSaved.viewId));
    expect(otherAllowed.status).toBe('ok');

    const duplicate = await duplicateHandler(event(selected.spaceId, saved.viewId, { name: 'Scoped copy' }));
    expect(duplicate.status).toBe('ok');
    expect(duplicate.result).toMatchObject({
      name: 'Scoped copy',
      actorId,
      spaceId: selected.spaceId,
      budgetId: selected.budgetId,
    });

    const crossSpaceCopy = await duplicateHandler(event(other.spaceId, saved.viewId, { name: 'Wrong-space copy' }));
    expect(crossSpaceCopy.status).toBe('error');
    expect(crossSpaceCopy.error?.code).toBe('VIEW_NOT_FOUND');
    const used = await lastUsedHandler(event(selected.spaceId, saved.viewId));
    expect(used.status).toBe('ok');
    expect(used.result.lastUsedAt).toBe(now);

    const crossSpaceUsage = await lastUsedHandler(event(other.spaceId, saved.viewId));
    expect(crossSpaceUsage.status).toBe('error');
    expect(crossSpaceUsage.error?.code).toBe('VIEW_NOT_FOUND');
  });

  it('preserves missing-ID and stored-ID not-found errors', async () => {
    const selected = await selectedScope(selectedBudgetId);
    const missingGet = await getHandler(event(selected.spaceId));
    expect(missingGet.status).toBe('error');
    expect(missingGet.error?.code).toBe('MISSING_VIEW_ID');

    const missingPatch = await patchHandler(event(selected.spaceId, '', { name: 'Updated' }));
    expect(missingPatch.status).toBe('error');
    expect(missingPatch.error?.code).toBe('MISSING_VIEW_ID');

    const missingDelete = await deleteHandler(event(selected.spaceId));
    expect(missingDelete.status).toBe('error');
    expect(missingDelete.error?.code).toBe('MISSING_VIEW_ID');

    const absentGet = await getHandler(event(selected.spaceId, 'missing-saved-view'));
    expect(absentGet.status).toBe('error');
    expect(absentGet.error?.code).toBe('VIEW_NOT_FOUND');

    const absentPatch = await patchHandler(
      event(selected.spaceId, 'missing-saved-view', { name: 'Updated' }),
    );
    expect(absentPatch.status).toBe('error');
    expect(absentPatch.error?.code).toBe('VIEW_NOT_FOUND');

    const absentDelete = await deleteHandler(event(selected.spaceId, 'missing-saved-view'));
    expect(absentDelete.status).toBe('error');
    expect(absentDelete.error?.code).toBe('VIEW_NOT_FOUND');
  });
});
