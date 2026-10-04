import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';
import { issueReauthentication, REAUTH_COOKIE_NAME } from '../../server/utils/reauthentication';
import handler from '../../server/api/notifications/policy.post';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
}));
vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof H3>()),
  readBody: async (event: { body: unknown }) => event.body,
}));
vi.mock('better-auth/node', () => ({ fromNodeHeaders: (headers: ConstructorParameters<typeof Headers>[0]) => new Headers(headers) }));
vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession, verifyPassword: mocks.verifyPassword } },
}));
// Load the Source Native store in Vitest's hoisted mock factory, not a stale workspace dist export.
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));

const OWNER = 'notification-policy-owner';
const AGENT = 'notification-policy-agent';
const ORIGIN = 'https://balanceframe.example.test';
const SESSION_ID = 'notification-policy-session';
const NOW = '2026-09-06T10:00:00.000Z';
const ownerControl = {
  method: 'human-session' as const,
  actorId: OWNER,
  sessionId: SESSION_ID,
  reauthenticatedAt: NOW,
};
let directory = '';
let store: SqliteWorkflowStore;
let sequence = 0;
let spaceId = '';
let foreignSpaceId = '';
let budgetId = '';

function request(options: {
  body?: unknown;
  cookie?: string;
  selectedSpace?: string;
  auth?: Record<string, unknown>;
} = {}) {
  const headers = new Map<string, string | number | readonly string[]>();
  const cookie = [`better-auth.session_token=${SESSION_ID}`, options.cookie].filter(Boolean).join('; ');
  return {
    body: options.body,
    node: {
      req: {
        headers: {
          origin: ORIGIN,
          cookie,
          'x-balanceframe-space': options.selectedSpace ?? spaceId,
        },
      },
      res: {
        statusCode: 200,
        statusMessage: '',
        headersSent: false,
        setHeader(name: string, value: string | number | readonly string[]) {
          headers.set(name.toLowerCase(), value);
        },
        getHeader(name: string) {
          return headers.get(name.toLowerCase());
        },
        removeHeader(name: string) {
          headers.delete(name.toLowerCase());
        },
      },
    },
    context: {
      auth: options.auth ?? {
        authenticated: true,
        actorId: OWNER,
        user: { id: OWNER },
        method: 'session',
        principalType: 'human',
        sessionId: SESSION_ID,
        impersonatedBy: null,
      },
      runtimeConfig: { workflowDbPath: join(directory, 'workflow.sqlite'), devBypassAuth: false },
    },
  } as unknown as H3.H3Event & EventWithContext;
}

function createSpace(selectedBudget: string, name: string) {
  const created = store.governance.createSpace({
    actorId: OWNER,
    name,
    kind: 'shared',
    now: NOW,
    auth: ownerControl,
  });
  return store.governance.bindBudget({
    spaceId: created.id,
    budgetId: selectedBudget,
    now: NOW,
    auth: ownerControl,
  });
}

function policy() {
  return {
    policyVersion: `policy-${sequence}`,
    eligibility: [{
      classifications: ['budget_alert'],
      minSeverity: 'low',
      requiredCapability: 'notification:receive',
      requiredScope: `budget:${budgetId}`,
    }],
    recipients: [{ actorId: OWNER, channels: ['in_app'], quietHours: null }],
    channels: [{ type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' }],
    redaction: { sensitive: { visibleFields: ['title'] } },
    maxRetries: 3,
    defaultRedactionClass: 'sensitive',
  };
}

async function issueCookie(): Promise<string> {
  const event = request();
  if (!(await issueReauthentication(event as unknown as ReauthenticationEvent, 'fixture-password')))
    throw new Error('Fixture human reauthentication failed');
  const header = event.node.res.getHeader('set-cookie');
  const values = Array.isArray(header) ? header : [header];
  const value = values.find((entry): entry is string => typeof entry === 'string' && entry.startsWith(`${REAUTH_COOKIE_NAME}=`));
  if (!value) throw new Error('Reauthentication proof cookie was not issued');
  return value.split(';', 1)[0]!;
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'notification-policy-'));
  const opened = getWorkflowStore(request({ selectedSpace: '' }) as unknown as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({ name: 'Policy owner', email: 'policy-owner@example.test', claimId: 'notification-policy-fixture' });
  await store.finalizeBootstrap({ claimId: 'notification-policy-fixture', ownerUserId: OWNER });
  mocks.getSession.mockResolvedValue({ user: { id: OWNER }, session: { id: SESSION_ID, userId: OWNER } });
  mocks.verifyPassword.mockResolvedValue({ status: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('BETTER_AUTH_SECRET', 'notification-policy-fixture-secret');
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  budgetId = `notification-policy-budget-${++sequence}`;
  spaceId = createSpace(budgetId, `Selected notification space ${sequence}`).id;
  foreignSpaceId = createSpace(`notification-policy-private-${sequence}`, `Foreign notification space ${sequence}`).id;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('POST /api/notifications/policy governed human control', () => {
  it('saves a complete policy only after a fresh selected-space human proof', async () => {
    const body = { spaceId, policy: policy() };
    const cookie = await issueCookie();
    const response = await handler(request({ body, cookie }));
    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({ spaceId, policyKey: 'notification', policyVersion: `policy-${sequence}` });
    expect(JSON.parse(response.result.policy)).toMatchObject(body.policy);
    expect(await store.getNotificationPolicy(foreignSpaceId, 'notification')).toBeNull();
  });

  it('rejects missing, expired, and future reauthentication proofs without changing policy', async () => {
    const body = { spaceId, policy: policy() };
    const missing = await handler(request({ body }));
    expect(missing.status).toBe('error');
    expect(missing.error?.code).toBe('HUMAN_CONTROL_REQUIRED');
    expect(await store.getNotificationPolicy(spaceId, 'notification')).toBeNull();

    const staleCookie = await issueCookie();
    vi.setSystemTime(new Date(Date.parse(NOW) + 301_000));
    const stale = await handler(request({ body, cookie: staleCookie }));
    expect(stale.status).toBe('error');
    expect(stale.error?.code).toBe('HUMAN_CONTROL_REQUIRED');
    expect(await store.getNotificationPolicy(spaceId, 'notification')).toBeNull();

    vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
    const futureCookie = await issueCookie();
    vi.setSystemTime(new Date(NOW));
    const future = await handler(request({ body, cookie: futureCookie }));
    expect(future.status).toBe('error');
    expect(future.error?.code).toBe('HUMAN_CONTROL_REQUIRED');
    expect(await store.getNotificationPolicy(spaceId, 'notification')).toBeNull();
  });

  it('rejects foreign body authority and prevents delegation of human-controlled notification policy', async () => {
    const cookie = await issueCookie();
    const wrongSpace = await handler(request({
      body: { spaceId: foreignSpaceId, policy: policy() },
      cookie,
    }));
    expect(wrongSpace.status).toBe('error');
    expect(wrongSpace.error?.code).toBe('SPACE_SCOPE_MISMATCH');
    expect(await store.getNotificationPolicy(foreignSpaceId, 'notification')).toBeNull();

    const ownerMembership = store.governance.getCurrentMembership({ spaceId, actorId: OWNER, now: NOW });
    if (!ownerMembership) throw new Error('Owner fixture membership unavailable');
    store.governance.registerAgent({ spaceId, agentId: AGENT, now: NOW, auth: ownerControl });
    expect(() => store.governance.delegate({
      spaceId,
      agentId: AGENT,
      issuerMembershipId: ownerMembership.id,
      expectedVersion: null,
      rights: [{ capability: 'policy:manage', resourceKind: 'space', resourceId: spaceId }],
      validFrom: NOW,
      now: NOW,
      auth: ownerControl,
    })).toThrow(Error);
    expect(store.governance.listDelegations({ spaceId, agentId: AGENT })).toEqual([]);
    expect(await store.getNotificationPolicy(spaceId, 'notification')).toBeNull();
  });
});