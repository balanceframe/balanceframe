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
});
