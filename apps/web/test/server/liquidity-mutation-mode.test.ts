import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { issueReauthentication, REAUTH_COOKIE_NAME } from '../../server/utils/reauthentication';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';
import { liquidityRoute } from '../../server/utils/liquidity-service';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
  createDefaultConnectionManager: vi.fn(),
}));

vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));
// The hoisted package mock loads Source exports rather than a stale workspace dist bundle.
vi.mock('@balanceframe/application', async () => {
  const application = await import('../../../../packages/application/src/index');
  return {
    ...application,
    createDefaultConnectionManager: () => {
      mocks.createDefaultConnectionManager();
      throw new Error('Observe-only mutation reached financial connection setup');
    },
  };
});
vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession, verifyPassword: mocks.verifyPassword } },
}));
vi.mock('better-auth/node', () => ({
  fromNodeHeaders: (headers: ConstructorParameters<typeof Headers>[0]) => new Headers(headers),
}));

const OWNER = 'mutation-mode-owner';
const ACTOR = 'mutation-mode-human';
const BUDGET = 'mutation-mode-budget';
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2026-09-06T10:00:00.000Z';
const SESSION_ID = 'mutation-mode-session';
const ownerAuth = {
  method: 'human-session' as const,
  actorId: OWNER,
  sessionId: `session:${OWNER}`,
  reauthenticatedAt: NOW,
};
let directory = '';
let store: SqliteWorkflowStore;
let spaceId = '';
let membershipId = '';

function request(cookie = '') {
  const req = new IncomingMessage(new Socket());
  req.url = '/api/spend-sessions/session/completions/proposal/execute';
  req.method = 'POST';
  req.headers = {
    origin: ORIGIN,
    'x-balanceframe-space': spaceId,
    cookie: `better-auth.session_token=fixture-session${cookie ? `; ${cookie}` : ''}`,
  };
  const res = new ServerResponse(req);
  return {
    path: req.url!,
    node: { req, res },
    context: {
      params: { id: 'session-not-needed', proposalId: 'proposal-not-needed' },
      auth: {
        authenticated: true,
        actorId: ACTOR,
        user: { id: ACTOR },
        method: 'session' as const,
        principalType: 'human' as const,
        sessionId: SESSION_ID,
        impersonatedBy: null,
      },
      runtimeConfig: {
        workflowDbPath: join(directory, 'workflow.sqlite'),
        devBypassAuth: false,
        reviewAndApply: false,
      },
    },
  } as unknown as H3.H3Event & EventWithContext & ReauthenticationEvent;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('BETTER_AUTH_SECRET', 'mutation-mode-fixture-secret');
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  directory = mkdtempSync(join(tmpdir(), 'liquidity-mutation-mode-native-'));
  const opened = getWorkflowStore(request() as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({
    name: 'Mutation mode owner',
    email: 'mutation-mode-owner@example.test',
    claimId: 'liquidity-mutation-mode-fixture',
  });
  await store.finalizeBootstrap({ claimId: 'liquidity-mutation-mode-fixture', ownerUserId: OWNER });
  await store.upsertActorMembership(ACTOR, 'active', [], '');
  const baseSpace = store.governance.createSpace({
    actorId: OWNER,
    name: 'Mutation mode selected space',
    kind: 'shared',
    now: NOW,
    auth: ownerAuth,
  });
  spaceId = store.governance.bindBudget({
    spaceId: baseSpace.id,
    budgetId: BUDGET,
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
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: ACTOR,
    membershipId,
    budgetId: BUDGET,
    capability: 'session:execute',
    resourceKind: 'budget',
    resourceId: BUDGET,
    granted: true,
    now: NOW,
    auth: ownerAuth,
  });
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('observe-only financial mutation boundary', () => {
  it('denies the SDK write after exact session:execute scope and fresh human control pass', async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: ACTOR },
      session: { id: SESSION_ID, userId: ACTOR },
    });
    mocks.verifyPassword.mockResolvedValue({ status: true });
    mocks.createDefaultConnectionManager.mockClear();
    const proofEvent = request();
    expect(await issueReauthentication(proofEvent, 'fixture-password')).toBe(true);
    const rawCookie = proofEvent.node.res.getHeader('set-cookie');
    const cookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
    if (typeof cookie !== 'string') throw new Error('Current human-control cookie was not issued');
    const cookiePair = cookie.split(';', 1)[0]!;
    expect(cookiePair.startsWith(`${REAUTH_COOKIE_NAME}=`)).toBe(true);

    const sdkWrite = vi.fn(async () => ({ written: true }));
    const route = liquidityRoute(async () => sdkWrite(), {
      capability: 'session:execute',
      mutation: true,
      humanControl: true,
    });
    const event = request(cookiePair);
    const response = await route(event);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('MUTATION_MODE_DISABLED');
    expect(response.authorization).toMatchObject({ actorId: ACTOR, capability: 'session:execute', allowed: true });
    expect(event.node.res.statusCode).toBe(403);
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.verifyPassword).toHaveBeenCalledOnce();
    expect(sdkWrite).not.toHaveBeenCalled();
    expect(mocks.createDefaultConnectionManager).not.toHaveBeenCalled();
  });
});
