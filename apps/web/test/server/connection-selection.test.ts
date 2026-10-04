import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMutationConnectionManager } from '../../server/utils/mutation-executor';
import type { H3Event } from 'h3';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getHumanControlAuth, issueReauthentication } from '../../server/utils/reauthentication';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
  connect: vi.fn(),
  listBudgets: vi.fn(),
  catalog: vi.fn(),
}));
vi.mock('h3', async (original) => ({
  ...(await original<typeof import('h3')>()),
  readBody: async (event: { body: unknown }) => event.body,
}));
vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession, verifyPassword: mocks.verifyPassword } },
}));
vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({ connect: mocks.connect, listBudgets: mocks.listBudgets }),
}));
vi.mock('../../server/utils/review-category-catalog', () => ({
  updateReviewCategoryCatalog: mocks.catalog,
}));
import handler from '../../server/api/connection/index.post';

const actorId = 'connection-owner';
const sessionId = 'connection-owner-session';
let now = '2026-08-01T12:00:00.000Z';
let store: SqliteWorkflowStore;
let sequence = 0;
let selectedSpaceId = '';
let requestedBudgetId = '';
let configuredBudgetId = 'previous-budget';
let initialized = false;
let proofCookie = '';

function request(body: unknown = { budgetId: requestedBudgetId }) {
  const responseHeaders = new Map<string, string | number | readonly string[]>();
  return {
    body,
    node: {
      req: { headers: {
        origin: 'https://balanceframe.example.test',
        'x-balanceframe-space': selectedSpaceId,
        cookie: 'better-auth.session_token=connection-fixture',
      } },
      res: {
        statusCode: 200,
        statusMessage: '',
        setHeader: (key: string, value: string | number | readonly string[]) => {
          responseHeaders.set(key.toLowerCase(), value);
        },
        getHeader: (key: string) => responseHeaders.get(key.toLowerCase()),
      },
    },
    context: {
      auth: {
        authenticated: true,
        actorId,
        user: { id: actorId },
        method: 'session' as const,
        principalType: 'human' as const,
        sessionId,
      },
      runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false },
    },
  };
}
async function confirmedRequest(body?: unknown) {
  const event = request(body);
  if (!proofCookie) {
    const proof = await issueReauthentication(event as unknown as ReauthenticationEvent, 'fixture-password');
    if (!proof) throw new Error('Fixture human reauthentication failed');
    const setCookie = event.node.res.getHeader('set-cookie');
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    proofCookie = cookies.map((value) => value.split(';')[0]).join('; ');
  }
  event.node.req.headers.cookie += `; ${proofCookie}`;
  return event;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  now = new Date(Date.parse('2026-08-01T12:00:00.000Z') + sequence * 360_000).toISOString();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  proofCookie = '';
  vi.stubEnv('BETTER_AUTH_SECRET', 'connection-fixture-secret');
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.example.test');
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  mocks.getSession.mockResolvedValue({ user: { id: actorId }, session: { id: sessionId, userId: actorId } });
  mocks.verifyPassword.mockResolvedValue({ status: true });
  const workflow = getWorkflowStore(request() as unknown as EventWithContext);
  if ('error' in workflow) throw new Error(workflow.error);
  store = workflow.store;
  if (!initialized) {
    await store.claimBootstrap({ name: 'Connection owner', email: 'connection-owner@example.test', claimId: 'connection-fixture' });
    await store.finalizeBootstrap({ claimId: 'connection-fixture', ownerUserId: actorId });
    initialized = true;
  }
  const event = await confirmedRequest();
  const auth = await getHumanControlAuth(event as unknown as ReauthenticationEvent);
  if (!auth) throw new Error('Fixture signed proof is unavailable');
  const space = store.governance.createSpace({ actorId, name: 'Connection fixture', kind: 'shared', now, auth });
  selectedSpaceId = space.id;
  requestedBudgetId = `connection-budget-${++sequence}`;
  mocks.listBudgets.mockResolvedValue([{ id: requestedBudgetId, groupId: 'fixture-group', name: 'Fixture', encrypted: false }]);
  configuredBudgetId = 'previous-budget';
  mocks.connect.mockImplementation(async ({ budgetId }: { budgetId: string }) => {
    configuredBudgetId = budgetId;
    return {
      config: { budgetId },
      budget: { id: budgetId, name: 'Disposable fixture budget', groupId: 'fixture-group', encrypted: false },
      synchronization: {},
    };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(() => store.close());

describe('governed Actual connection selection', () => {
  it('rejects a budget bound to a different space before private selection or configuration changes', async () => {
    const event = await confirmedRequest();
    const auth = await getHumanControlAuth(event as unknown as ReauthenticationEvent);
    if (!auth) throw new Error('Fixture signed proof is unavailable');
    const foreign = store.governance.createSpace({ actorId, name: 'Other space', kind: 'shared', now, auth });
    store.governance.bindBudget({ spaceId: foreign.id, budgetId: requestedBudgetId, now, auth });

    const response = await handler(event as unknown as H3Event);

    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(configuredBudgetId).toBe('previous-budget');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(store.governance.getSpace({ spaceId: selectedSpaceId })?.budgetId).toBeNull();
  });

  it('establishes the immutable authorized binding before restoring the private budget', async () => {
    mocks.connect.mockImplementation(async ({ budgetId }: { budgetId: string }) => {
      if (store.governance.getSpace({ spaceId: selectedSpaceId })?.budgetId !== budgetId)
        throw new Error('Attempted private selection without a binding');
      configuredBudgetId = budgetId;
      return { config: { budgetId }, budget: { id: budgetId }, synchronization: {} };
    });

    const response = await handler(await confirmedRequest() as unknown as H3Event);

    expect(response.status).toBe('ok');
    expect(configuredBudgetId).toBe(requestedBudgetId);
    expect(store.governance.getSpace({ spaceId: selectedSpaceId })?.budgetId).toBe(requestedBudgetId);
  });

  it('does not restore a budget without current human proof', async () => {
    const response = await handler(request() as unknown as H3Event);
    expect(response.status).toBe('error');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(configuredBudgetId).toBe('previous-budget');
  });

  it('rejects a blank budget without binding or restoring private data', async () => {
    const response = await handler(await confirmedRequest({ budgetId: ' ' }) as unknown as H3Event);
    expect(response.status).toBe('error');
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(store.governance.getSpace({ spaceId: selectedSpaceId })?.budgetId).toBeNull();
  });

  it('does not seal an unbound space to a nonexistent Actual budget', async () => {
    mocks.listBudgets.mockResolvedValue([]);
    mocks.connect.mockRejectedValueOnce(new Error('Budget not found on server'));

    const response = await handler(await confirmedRequest() as unknown as H3Event);

    expect(response.status).toBe('error');
    expect(store.governance.getSpace({ spaceId: selectedSpaceId })?.budgetId).toBeNull();
    expect(configuredBudgetId).toBe('previous-budget');
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('uses the configured Source connection instead of another home budget for review mutations', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'review-connection-config-'));
    const config = (budgetId: string) => ({
      version: 1, serverUrl: 'http://actual.invalid', budgetId,
      budgetName: budgetId, groupId: `group-${budgetId}`,
    });
    try {
      await mkdir(join(directory, '.balanceframe'));
      await writeFile(join(directory, '.balanceframe/config.json'), JSON.stringify(config('other-budget')));
      const selectedPath = join(directory, 'selected.json');
      await writeFile(selectedPath, JSON.stringify(config('selected-budget')));
      vi.stubEnv('HOME', directory);
      vi.stubEnv('BALANCEFRAME_CONFIG_PATH', selectedPath);
      expect((await createMutationConnectionManager().loadConfig())?.budgetId).toBe('selected-budget');
      expect((await createMutationConnectionManager({
        configPath: join(directory, '.balanceframe/config.json'),
      }).loadConfig())?.budgetId).toBe('other-budget');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
