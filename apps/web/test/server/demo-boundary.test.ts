import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { mockGetRequestPath, mockGetHeader, mockSetResponseStatus } = vi.hoisted(() => {
  const mockGetRequestPath = vi.fn((event: MockEvent) => event.path);
  const mockGetHeader = vi.fn(
    (event: MockEvent, name: string) => event.headers[name.toLowerCase()],
  );
  const mockSetResponseStatus = vi.fn((event: MockEvent, status: number) => {
    event.status = status;
  });
  return { mockGetRequestPath, mockGetHeader, mockSetResponseStatus };
});

vi.mock('h3', () => ({
  getRequestPath: mockGetRequestPath,
  getHeader: mockGetHeader,
  setResponseStatus: mockSetResponseStatus,
}));

import { enforceDemoBoundary } from '../../server/utils/demo-boundary';

interface MockEvent {
  path: string;
  method: string;
  headers: Record<string, string | undefined>;
  status?: number;
  context: { runtimeConfig: Record<string, unknown> };
  node: {
    req: {
      method: string;
      url: string;
      headers: Record<string, string | undefined>;
      socket: { localAddress: string; remoteAddress: string };
    };
  };
}

const ORIGIN = 'https://demo.example.test';
const INTERNAL = 'internal-demo-secret-012345678901234567890123';

let root: string;
let manifestPath: string;
let authDbPath: string;
let workflowDbPath: string;
let connectionPath: string;
let credentialDir: string;

function makeEvent(
  path: string,
  method: string,
  headers: Record<string, string | undefined> = {},
): MockEvent {
  const normalizedHeaders = {
    host: 'demo.example.test',
    origin: ORIGIN,
    ...headers,
  };
  return {
    path,
    method,
    headers: normalizedHeaders,
    context: {
      runtimeConfig: {
        demoManifestPath: manifestPath,
        authDbPath,
        workflowDbPath,
        connectionPath,
        credentialDir,
        actualServerUrl: 'http://127.0.0.1:49231',
        reviewAndApply: true,
      },
    },
    node: {
      req: {
        method,
        url: path,
        headers: normalizedHeaders,
        socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' },
      },
    },
  };
}

function writeManifest(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      phase: 'ready',
      generation: 3,
      origin: ORIGIN,
      actualUrl: 'http://127.0.0.1:49231',
      root,
      authDbPath,
      workflowDbPath,
      connectionPath,
      internalSecret: INTERNAL,
      budgetId: 'budget-demo',
      actorIds: ['owner-demo'],
      scenarioId: 'funded-purchase',
      spaceId: overrides.phase === 'setup' ? null : 'space-demo',
      ...overrides,
    }),
    { mode: 0o600 },
  );
  chmodSync(manifestPath, 0o600);
}

beforeAll(() => {
  root = mkdtempSync(join('/tmp', 'balanceframe-demo-boundary-'));
  chmodSync(root, 0o700);
  manifestPath = join(root, 'manifest.json');
  authDbPath = join(root, 'auth.sqlite');
  workflowDbPath = join(root, 'workflow.sqlite');
  connectionPath = join(root, 'config.json');
  writeFileSync(
    connectionPath,
    JSON.stringify({
      version: 1,
      serverUrl: 'http://127.0.0.1:49231',
      budgetId: 'budget-demo',
      budgetName: 'Demo Budget',
      groupId: 'group-demo',
    }),
    { mode: 0o600 },
  );
  chmodSync(connectionPath, 0o600);
  credentialDir = join(root, 'credentials');
  mkdirSync(credentialDir, { mode: 0o700 });
  vi.stubEnv('BALANCEFRAME_CONFIG_PATH', connectionPath);
  vi.stubEnv('BALANCEFRAME_CREDENTIAL_DIR', credentialDir);
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  writeManifest();
});

describe('enforceDemoBoundary', () => {
  it('leaves ordinary deployments unchanged when no manifest is configured', async () => {
    const event = makeEvent('/api/review/seed', 'POST');
    event.context.runtimeConfig = { reviewAndApply: true };

    expect(enforceDemoBoundary(event)).toBeUndefined();
    expect(event.status).toBeUndefined();
  });

  it('fails closed when the configured manifest is missing or malformed', async () => {
    writeFileSync(manifestPath, '{not-json', { mode: 0o600 });
    const event = makeEvent('/api/liquidity/spendability', 'GET');

    const response = await enforceDemoBoundary(event);

    expect(event.status).toBe(503);
    expect(response).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
  });

  it('denies review mutations even when the demo is ready', async () => {
    const event = makeEvent('/api/review/seed', 'POST');

    const response = await enforceDemoBoundary(event);

    expect(event.status).toBe(403);
    expect(response).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
  });

  it('allows an exact approved financial write in ready phase', async () => {
    const event = makeEvent('/api/liquidity/preferences', 'PUT');

    expect(enforceDemoBoundary(event)).toBeUndefined();
    expect(event.status).toBeUndefined();
  });
  it('keeps Better Auth sign-in private while allowing only supervisor loopback transport', async () => {
    const browserEvent = makeEvent('/api/auth/sign-in/email', 'POST');
    const internalEvent = makeEvent('/api/auth/sign-in/email', 'POST', {
      'x-balanceframe-demo-internal': INTERNAL,
    });

    const browserResponse = enforceDemoBoundary(browserEvent);

    expect(browserEvent.status).toBe(403);
    expect(browserResponse).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
    expect(enforceDemoBoundary(internalEvent)).toBeUndefined();
  });
  it('accepts trusted forwarded public host for private supervisor setup transport', async () => {
    writeManifest({ phase: 'setup', budgetId: null, actorIds: [] });
    const event = makeEvent('/api/registration/bootstrap', 'POST', {
      host: '127.0.0.1:49001',
      'x-forwarded-host': 'demo.example.test',
      'x-forwarded-proto': 'https',
      'x-balanceframe-demo-internal': INTERNAL,
    });

    expect(enforceDemoBoundary(event)).toBeUndefined();
  });

  it.each(['setup', 'ready'])('admits only private loopback proof and selected-space transport in %s phase', (phase) => {
    writeManifest({ phase, ...(phase === 'setup' ? { budgetId: null, actorIds: [] } : {}) });
    for (const path of ['/api/reauth', '/api/spaces/space-demo/select']) {
      expect(enforceDemoBoundary(makeEvent(path, 'POST', {
        'x-balanceframe-demo-internal': INTERNAL,
      }))).toBeUndefined();
      for (const secret of [undefined, 'incorrect-internal-secret']) {
        const untrusted = makeEvent(path, 'POST', { 'x-balanceframe-demo-internal': secret });
        expect(enforceDemoBoundary(untrusted)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
        expect(untrusted.status).toBe(403);
      }
      const remote = makeEvent(path, 'POST', { 'x-balanceframe-demo-internal': INTERNAL });
      remote.node.req.socket.remoteAddress = '192.0.2.10';
      expect(enforceDemoBoundary(remote)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
      expect(remote.status).toBe(403);
    }
  });

  it('allows only the exact private space setup writes, not public or ready-phase governance controls', () => {
    for (const [path, method] of [
      ['/api/spaces', 'POST'],
      ['/api/spaces/space-demo/grants', 'PUT'],
    ] as const) {
      writeManifest({ phase: 'setup', budgetId: null, actorIds: [] });
      expect(enforceDemoBoundary(makeEvent(path, method, {
        'x-balanceframe-demo-internal': INTERNAL,
      }))).toBeUndefined();
      const external = makeEvent(path, method);
      expect(enforceDemoBoundary(external)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
      expect(external.status).toBe(403);
      writeManifest();
      const ready = makeEvent(path, method, { 'x-balanceframe-demo-internal': INTERNAL });
      expect(enforceDemoBoundary(ready)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
      expect(ready.status).toBe(403);
    }
    writeManifest({ phase: 'setup', budgetId: null, actorIds: [] });
    for (const [path, method] of [
      ['/api/spaces/space-demo/memberships', 'POST'],
      ['/api/spaces/space-demo/policy', 'PUT'],
      ['/api/spaces/space-demo/agents', 'POST'],
    ] as const) {
      const event = makeEvent(path, method, { 'x-balanceframe-demo-internal': INTERNAL });
      expect(enforceDemoBoundary(event)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
      expect(event.status).toBe(403);
    }
  });

  it('requires the configured Host and Origin for unsafe requests', async () => {
    const event = makeEvent('/api/liquidity/preferences', 'PUT', { origin: undefined });

    const response = await enforceDemoBoundary(event);

    expect(event.status).toBe(403);
    expect(response).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
  });

  it('allows setup writes only with the loopback internal secret', async () => {
    writeManifest({ phase: 'setup', budgetId: null, actorIds: [] });
    const browserEvent = makeEvent('/api/registration/bootstrap', 'POST');
    const internalEvent = makeEvent('/api/registration/bootstrap', 'POST', {
      'x-balanceframe-demo-internal': INTERNAL,
    });

    const browserResponse = await enforceDemoBoundary(browserEvent);
    const internalResponse = await enforceDemoBoundary(internalEvent);

    expect(browserEvent.status).toBe(403);
    expect(browserResponse).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
    expect(internalResponse).toBeUndefined();
  });
  it('denies external API reads until setup has published a ready manifest', async () => {
    writeManifest({ phase: 'setup', budgetId: null, actorIds: [] });
    const event = makeEvent('/api/liquidity/spendability', 'GET');

    const response = await enforceDemoBoundary(event);

    expect(event.status).toBe(403);
    expect(response).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
  });

  it('rejects an external Actual target and mismatched configured database path', async () => {
    writeManifest({ actualUrl: 'https://actual.example.test' });
    const event = makeEvent('/api/liquidity/preferences', 'PUT');

    const response = await enforceDemoBoundary(event);

    expect(event.status).toBe(503);
    expect(response).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });

    writeManifest();
    event.context.runtimeConfig.authDbPath = '/tmp/not-owned.sqlite';
    const mismatchResponse = await enforceDemoBoundary(event);
    expect(event.status).toBe(503);
    expect(mismatchResponse).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
  });

  it.each([
    ['governance-scoped-access', '/api/spaces/space-demo/grants', 'PUT'],
    ['governance-invitation-lifecycle', '/api/spaces/space-demo/memberships/member-demo/revoke', 'POST'],
    ['governance-invitation-lifecycle', '/api/spaces/space-demo/grants', 'PUT'],
    ['governance-delegated-assistant', '/api/spaces/space-demo/delegations/delegation-demo/revoke', 'POST'],
    ['merchant-local-sparse', '/api/review/sync', 'POST'],
    ['merchant-local-insufficient', '/api/review/sync', 'POST'],
    ['merchant-alias-conflict', '/api/merchant/confirm', 'POST'],
    ['merchant-alias-conflict', '/api/merchant/reject', 'POST'],
    ['merchant-alias-conflict', '/api/review/correct', 'POST'],
    ['merchant-alias-conflict', '/api/proposal/proposal-demo/approve', 'POST'],
    ['merchant-alias-conflict', '/api/proposal/proposal-demo/execute', 'POST'],
    ['merchant-recurrence-calendar', '/api/merchant/confirm', 'POST'],
    ['merchant-recurrence-calendar', '/api/merchant/reject', 'POST'],
    ['merchant-native-rule-lifecycle', '/api/review/propose-rule', 'POST'],
    ['merchant-native-rule-lifecycle', '/api/review/sync', 'POST'],
    ['merchant-native-rule-lifecycle', '/api/proposal/proposal-demo/approve', 'POST'],
    ['merchant-native-rule-lifecycle', '/api/proposal/proposal-demo/execute', 'POST'],
    ['merchant-research-success', '/api/merchant/research/preview', 'POST'],
    ['merchant-research-lifecycle', '/api/merchant/research/preview', 'POST'],
    ['merchant-research-lifecycle', '/api/merchant/research', 'POST'],
    ['merchant-research-success', '/api/merchant/research', 'POST'],
    ['merchant-research-outage', '/api/merchant/research', 'POST'],
    ['merchant-research-lifecycle', '/api/merchant/research/cache', 'POST'],
    ['merchant-research-lifecycle', '/api/merchant', 'DELETE'],
    ['merchant-research-lifecycle', '/api/merchant/policy', 'PUT'],
    ['merchant-research-lifecycle', '/api/merchant/space-policy', 'PUT'],
    ['merchant-research-lifecycle', '/api/spaces/space-demo/grants', 'PUT'],
  ])('admits only the declared %s action %s %s in the selected space', (scenarioId, path, method) => {
    writeManifest({ scenarioId });
    const legitimate = makeEvent(path, method, { 'x-balanceframe-space': 'space-demo' });
    legitimate.context.runtimeConfig.public = { demoMode: false };
    expect(enforceDemoBoundary(legitimate)).toBeUndefined();
    expect(legitimate.status).toBeUndefined();

    for (const headers of [
      { 'x-balanceframe-space': 'unrelated-space' },
      { 'x-balanceframe-space': 'space-demo', origin: 'https://attacker.example' },
      { 'x-balanceframe-space': 'space-demo', origin: undefined },
      { 'x-balanceframe-space': 'space-demo', origin: 'null' },
      { 'x-balanceframe-space': 'space-demo', host: 'attacker.example', 'x-forwarded-host': 'demo.example.test', 'x-forwarded-proto': 'https' },
      { 'x-balanceframe-space': 'space-demo', 'x-balanceframe-demo-internal': 'forged-secret' },
    ]) {
      const denied = makeEvent(path, method, headers);
      expect(enforceDemoBoundary(denied)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
      expect(denied.status).toBe(403);
    }
    const wrongMethod = makeEvent(path, method === 'POST' ? 'PUT' : 'POST', { 'x-balanceframe-space': 'space-demo' });
    expect(enforceDemoBoundary(wrongMethod)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
    expect(wrongMethod.status).toBe(403);
    writeManifest({ scenarioId: 'funded-purchase' });
    const unrelatedStory = makeEvent(path, method, { 'x-balanceframe-space': 'space-demo' });
    expect(enforceDemoBoundary(unrelatedStory)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
    expect(unrelatedStory.status).toBe(403);
  });

  it.each(['governance-scoped-access', 'governance-invitation-lifecycle', 'governance-delegated-assistant', 'merchant-research-lifecycle'])(
    'does not turn %s into general governance, auth, connection or provider CRUD',
    (scenarioId) => {
      writeManifest({ scenarioId });
      for (const [path, method] of [
        ['/api/spaces', 'POST'],
        ['/api/spaces/unrelated-space/grants', 'PUT'],
        ['/api/spaces/space-demo/policy', 'PUT'],
        ['/api/spaces/space-demo/credentials', 'POST'],
        ['/api/auth/api-key/create', 'POST'],
        ['/api/auth/sign-up/email', 'POST'],
        ['/api/invitations', 'POST'],
        ['/api/connection', 'POST'],
        ['/api/review/seed', 'POST'],
      ]) {
        const event = makeEvent(path!, method!, {
          'x-balanceframe-space': 'space-demo',
          'x-forwarded-host': 'demo.example.test',
          'x-balanceframe-demo-internal': 'browser-injected-secret',
        });
        expect(enforceDemoBoundary(event)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
        expect(event.status).toBe(403);
      }
    },
  );

  it('permits real assistant/key setup only privately for that story and never in ready phase', () => {
    for (const path of ['/api/spaces/space-demo/agents', '/api/spaces/space-demo/delegations', '/api/auth/api-key/create', '/api/spaces/space-demo/credentials']) {
      writeManifest({ phase: 'setup', budgetId: null, actorIds: [], scenarioId: 'governance-delegated-assistant' });
      expect(enforceDemoBoundary(makeEvent(path, 'POST', {
        'x-balanceframe-space': 'space-demo',
        'x-balanceframe-demo-internal': INTERNAL,
      }))).toBeUndefined();
      const browser = makeEvent(path, 'POST', { 'x-balanceframe-space': 'space-demo' });
      expect(enforceDemoBoundary(browser)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
      expect(browser.status).toBe(403);
      writeManifest({ scenarioId: 'governance-delegated-assistant' });
      const ready = makeEvent(path, 'POST', { 'x-balanceframe-demo-internal': INTERNAL });
      expect(enforceDemoBoundary(ready)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
      expect(ready.status).toBe(403);
      writeManifest({ phase: 'setup', budgetId: null, actorIds: [] });
      const wrongStory = makeEvent(path, 'POST', { 'x-balanceframe-demo-internal': INTERNAL });
      expect(enforceDemoBoundary(wrongStory)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
      expect(wrongStory.status).toBe(403);
    }
  });

  it.each([
    ['/api/spend-sessions', 'POST'],
    ['/api/spend-sessions/session-demo', 'PUT'],
    ['/api/spend-sessions/session-demo', 'DELETE'],
    ['/api/spend-sessions/session-demo/completions', 'POST'],
    ['/api/spend-sessions/session-demo/completions/completion-demo/approve', 'POST'],
    ['/api/spend-sessions/session-demo/completions/completion-demo/execute', 'POST'],
    ['/api/spend-sessions/session-demo/completions/completion-demo/reconcile', 'POST'],
    ['/api/liquidity/policy', 'PUT'],
    ['/api/liquidity/observations', 'PUT'],
    ['/api/liquidity/grants', 'PUT'],
    ['/api/liquidity/preferences', 'PUT'],
    ['/api/liquidity/claims', 'POST'],
    ['/api/liquidity/claims/claim-demo/release', 'POST'],
    ['/api/liquidity/reallocation-preview', 'POST'],
    ['/api/transfer/preview', 'POST'],
    ['/api/transfer/propose', 'POST'],
    ['/api/transfer/transfer-demo/approve', 'POST'],
    ['/api/transfer/transfer-demo/report-initiated', 'POST'],
    ['/api/transfer/transfer-demo/reconcile', 'POST'],
    ['/api/transfer/transfer-demo/cancel', 'POST'],
    ['/api/transfer/transfer-demo/instructions', 'POST'],
  ])('preserves the safe legacy spending method %s %s', (path, method) => {
    const event = makeEvent(path, method);
    expect(enforceDemoBoundary(event)).toBeUndefined();
    expect(event.status).toBeUndefined();
  });

  it.each([
    { scenarioId: '../../merchant-research-success' },
    { scenarioId: 'not-a-registered-story' },
    { spaceId: '' },
    { research: { provider: 'https://attacker.example', mode: 'success' } },
    { scenarioId: 'merchant-research-success', research: { provider: 'fixture', controlPath: '/tmp/not-owned-control.json' } },
  ])('fails closed on invalid protected scenario selection %j with public demo disabled', (overrides) => {
    writeManifest(overrides);
    const event = makeEvent('/api/merchant', 'GET');
    event.context.runtimeConfig.public = { demoMode: false };
    expect(enforceDemoBoundary(event)).toMatchObject({ error: { code: 'DEMO_OPERATION_DISABLED' } });
    expect(event.status).toBe(503);
  });
});
