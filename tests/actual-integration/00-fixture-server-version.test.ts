import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  init: vi.fn(),
  shutdown: vi.fn(),
  createBudget: vi.fn(),
  deleteBudget: vi.fn(),
  downloadBudget: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('./actual-client.js', () => client);

const fetchInfo = vi.fn<typeof fetch>();

function serverInfo(version: string): Response {
  return Response.json({ build: { name: '@actual-app/sync-server', version } });
}

async function runFixtureTest(): Promise<void> {
  await import('./setup.js');
  await client.init();
  await client.createBudget();
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', fetchInfo);
  vi.stubEnv('ACTUAL_EXPECTED_SERVER_VERSION', '26.10.0');
  vi.stubEnv('BALANCEFRAME_ACTUAL_FIXTURE', '1');
  vi.stubEnv('ACTUAL_SERVER_URL', 'http://127.0.0.1:5006');
  vi.stubEnv('ACTUAL_SECRET_KEY', 'test-only-secret');
  vi.stubEnv('ACTUAL_BUDGET_ID', 'fixture-budget-id');
  vi.stubEnv('ACTUAL_GROUP_ID', 'fixture-group-id');
  vi.stubEnv('ACTUAL_BUDGET_NAME', 'Fixture-Budget');
  vi.stubEnv('ACTUAL_SEED_DATA_DIR', '/unused/disposable-fixture-seed');
  fetchInfo.mockResolvedValue(serverInfo('26.10.0'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('fixture server version gate in Vitest setup', () => {
  it.each([
    ['26.7.0', '26.10.0'],
    ['26.10.0', '26.7.0'],
  ])('refuses expected %s when the running server is %s before client writes', async (expected, actual) => {
    vi.stubEnv('ACTUAL_EXPECTED_SERVER_VERSION', expected);
    fetchInfo.mockResolvedValue(serverInfo(actual));

    await expect(runFixtureTest()).rejects.toThrow(`expected ${expected}, received ${actual}`);
    expect(client.init).not.toHaveBeenCalled();
    expect(client.createBudget).not.toHaveBeenCalled();
  });

  it.each(['26.7.0', '26.10.0'])('accepts an actual %s server and checks /info safely', async (version) => {
    vi.stubEnv('ACTUAL_EXPECTED_SERVER_VERSION', version);
    fetchInfo.mockResolvedValue(serverInfo(version));

    await expect(runFixtureTest()).resolves.toBeUndefined();
    expect(fetchInfo).toHaveBeenCalledExactlyOnceWith(
      new URL('http://127.0.0.1:5006/info'),
      { signal: expect.any(AbortSignal), redirect: 'error' },
    );
    expect(client.init).toHaveBeenCalledOnce();
    expect(client.createBudget).toHaveBeenCalledOnce();
  });

  it('preserves ordinary runs when no expected version is supplied', async () => {
    vi.stubEnv('ACTUAL_EXPECTED_SERVER_VERSION', undefined);
    vi.stubEnv('BALANCEFRAME_ACTUAL_FIXTURE', undefined);

    await expect(import('./setup.js')).resolves.toBeDefined();
    expect(fetchInfo).not.toHaveBeenCalled();
    expect(process.env.NODE_ENV).toBe('production');
  });

  it.each(['', '   '])('refuses an explicitly empty expected version %j', async (version) => {
    vi.stubEnv('ACTUAL_EXPECTED_SERVER_VERSION', version);

    await expect(runFixtureTest()).rejects.toThrow(/ACTUAL_EXPECTED_SERVER_VERSION/);
    expect(fetchInfo).not.toHaveBeenCalled();
    expect(client.init).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { build: null },
    { build: { name: '@actual-app/api', version: '26.10.0' } },
    { build: { name: '@actual-app/sync-server' } },
    { build: { name: '@actual-app/sync-server', version: 26.10 } },
    { build: { name: '@actual-app/sync-server', version: '' } },
  ])('refuses malformed or non-server /info metadata %j', async (body) => {
    fetchInfo.mockResolvedValue(Response.json(body));

    await expect(runFixtureTest()).rejects.toThrow(/sync-server.*metadata/);
    expect(client.init).not.toHaveBeenCalled();
    expect(client.createBudget).not.toHaveBeenCalled();
  });

  it('refuses malformed JSON', async () => {
    fetchInfo.mockResolvedValue(new Response('{invalid-json'));

    await expect(runFixtureTest()).rejects.toThrow();
    expect(client.init).not.toHaveBeenCalled();
  });

  it('refuses a non-OK /info response', async () => {
    fetchInfo.mockResolvedValue(new Response('unavailable', { status: 503 }));

    await expect(runFixtureTest()).rejects.toThrow(/info.*503/);
    expect(client.init).not.toHaveBeenCalled();
  });

  it.each([new Error('fixture network failure'), new DOMException('timed out', 'TimeoutError')])(
    'refuses a failed request before initialization: %s',
    async (error) => {
      fetchInfo.mockRejectedValue(error);

      await expect(runFixtureTest()).rejects.toThrow(error);
      expect(client.init).not.toHaveBeenCalled();
      expect(client.createBudget).not.toHaveBeenCalled();
    },
  );

  it('bounds the metadata request to five seconds', async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);

    await runFixtureTest();
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5_000);
    expect(fetchInfo.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  it.each([
    ['BALANCEFRAME_ACTUAL_FIXTURE', undefined, /BALANCEFRAME_ACTUAL_FIXTURE/],
    ['BALANCEFRAME_ACTUAL_FIXTURE', '0', /BALANCEFRAME_ACTUAL_FIXTURE/],
    ['ACTUAL_SERVER_URL', 'https://actual.example.test', /loopback/],
    ['ACTUAL_SERVER_URL', 'file:///tmp/fixture', /HTTP/],
    ['ACTUAL_SECRET_KEY', undefined, /ACTUAL_SECRET_KEY/],
    ['ACTUAL_BUDGET_ID', undefined, /ACTUAL_BUDGET_ID/],
    ['ACTUAL_GROUP_ID', undefined, /ACTUAL_GROUP_ID/],
    ['ACTUAL_BUDGET_NAME', undefined, /ACTUAL_BUDGET_NAME/],
    ['ACTUAL_SEED_DATA_DIR', '   ', /ACTUAL_SEED_DATA_DIR/],
  ] as const)('refuses invalid fixture provenance %s=%s before any request', async (key, value, diagnostic) => {
    vi.stubEnv(key, value);

    await expect(runFixtureTest()).rejects.toThrow(diagnostic);
    expect(fetchInfo).not.toHaveBeenCalled();
    expect(client.init).not.toHaveBeenCalled();
    expect(client.createBudget).not.toHaveBeenCalled();
  });
});
