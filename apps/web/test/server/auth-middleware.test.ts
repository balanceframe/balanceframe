/**
 * Focused tests for the server-side auth middleware.
 *
 * Tests use mocked h3 functions so no Nitro runtime is required.
 * The middleware exports via `defineEventHandler` which is mocked as
 * an identity wrapper — the default export is the raw handler function.
 */

import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  getActorId,
  type ApiEnvelope,
  type AuthorizationInfo,
} from '../../server/utils/workflow-store';
import { resetAuthMigrationStatus, setAuthMigrationFailed } from '../../server/utils/auth-migration-status';
// ---------------------------------------------------------------------------
// Mock h3 module — must be before importing the middleware
// ---------------------------------------------------------------------------

const { mockGetRequestHeaders } = vi.hoisted(() => ({
  mockGetRequestHeaders: vi.fn().mockReturnValue({}),
}));

const { mockGetRequestPath, mockGetHeader, mockGetCookie, mockSetResponseStatus, mockSetHeader } =
  vi.hoisted(() => ({
    mockGetRequestPath: vi.fn(),
    mockGetHeader: vi.fn(),
    mockGetCookie: vi.fn().mockReturnValue(undefined),
    mockSetResponseStatus: vi.fn(),
    mockSetHeader: vi.fn(),
  }));

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getRequestPath: mockGetRequestPath,
  getRequestHeaders: mockGetRequestHeaders,
  getHeader: mockGetHeader,
  getCookie: mockGetCookie,
  setResponseStatus: mockSetResponseStatus,
  setHeader: mockSetHeader,
}));

// ---------------------------------------------------------------------------
// Mock lib/auth — Better Auth is a heavy module with native bindings
// that esbuild cannot transform.  The mock returns stubs that allow the
// tests to focus on the legacy token fallback and route-scoping logic.
// ---------------------------------------------------------------------------

const { mockGetSession, mockVerifyApiKey } = vi.hoisted(() => ({
  mockGetSession: vi.fn().mockResolvedValue(null),
  mockVerifyApiKey: vi.fn().mockRejectedValue(new Error('not configured')),
}));

const { mockGetWorkflowStore } = vi.hoisted(() => ({ mockGetWorkflowStore: vi.fn() }));
vi.mock('../../server/utils/workflow-store', async (original) => ({
  ...(await original<typeof import('../../server/utils/workflow-store')>()),
  getWorkflowStore: mockGetWorkflowStore,
}));

vi.mock('../../lib/auth', () => ({
  auth: {
    api: {
      getSession: mockGetSession,
      verifyApiKey: mockVerifyApiKey,
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock h3 module — must be before importing the middleware
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Import module-under-test (after h3 mock is in place)
// ---------------------------------------------------------------------------

import authMiddleware from '../../server/middleware/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shape of the event object that the middleware reads from. */
interface MockMiddlewareEvent {
  context: {
    runtimeConfig?: Record<string, unknown>;
    auth?: {
      authenticated: boolean;
      actorId?: string;
      user?: Record<string, unknown>;
    };
  };
  body?: Record<string, unknown>;
}

/** Create a minimal mock Nitro event object. */
function mockEvent(overrides?: Partial<MockMiddlewareEvent>): MockMiddlewareEvent {
  return {
    context: {},
    ...overrides,
  };
}

/**
 * Narrow-cast an unknown value to an error envelope for assertions.
 * The expect calls serve as a runtime type guard for test assertions.
 */
function asErrorEnvelope(v: unknown): {
  status: string;
  error: { code: string; message: string; reasonCodes: string[] };
} {
  const e = v as {
    status: string;
    error: { code: string; message: string; reasonCodes: string[] };
  };
  expect(e.status).toBe('error');
  expect(e.error).toBeDefined();
  return e;
}

/** The middleware cast to accept mock events without H3Event dependencies. */
const handler = authMiddleware as (event: MockMiddlewareEvent) => Promise<unknown>;

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', '');
  vi.stubEnv('NUXT_BETTER_AUTH_SECRET', '');
  vi.stubEnv('BALANCEFRAME_API_TOKEN', '');
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  mockGetSession.mockResolvedValue(null);
  mockVerifyApiKey.mockRejectedValue(new Error('not configured'));
  mockGetHeader.mockReturnValue(undefined);
  mockGetCookie.mockReturnValue(undefined);
  resetAuthMigrationStatus();
});
afterEach(() => vi.unstubAllEnvs());

describe('auth middleware — Better Auth configured without legacy auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRequestPath.mockReturnValue('/api/review');
  });

  it.each([
    ['BETTER_AUTH_SECRET', undefined],
    ['BETTER_AUTH_SECRET', 'Bearer invalid-fixture-key'],
    ['NUXT_BETTER_AUTH_SECRET', undefined],
    ['NUXT_BETTER_AUTH_SECRET', 'Bearer invalid-fixture-key'],
  ])('returns 401 for %s with credentials %s', async (variable, authorization) => {
    vi.stubEnv(variable!, 'middleware-fixture-secret-with-enough-entropy');
    mockGetHeader.mockReturnValue(authorization);
    const event = mockEvent({ context: { runtimeConfig: { devBypassAuth: false } } });

    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 401);
    expect(mockSetHeader).toHaveBeenCalledWith(event, 'WWW-Authenticate', 'Bearer');
    expect(asErrorEnvelope(result).error.code).toBe('UNAUTHORIZED');
    expect(event.context.auth).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/API token|NUXT_|BALANCEFRAME_|fixture-secret/);
  });

  it('does not authenticate an invalid explicit key using a valid cookie session', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'middleware-fixture-secret-with-enough-entropy');
    mockGetHeader.mockReturnValue('Bearer invalid-fixture-key');
    mockGetSession.mockResolvedValue({ user: { id: 'fixture-user' } });
    const event = mockEvent();

    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 401);
    expect(asErrorEnvelope(result).error.code).toBe('UNAUTHORIZED');
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(event.context.auth).toBeUndefined();
  });

  it('still rejects the development bypass in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BETTER_AUTH_SECRET', 'middleware-fixture-secret-with-enough-entropy');
    mockGetHeader.mockReturnValue(undefined);
    const event = mockEvent({ context: { runtimeConfig: { devBypassAuth: true } } });

    expect(asErrorEnvelope(await handler(event)).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
    expect(event.context.auth).toBeUndefined();
  });

  it('preserves the verified Better Auth session identity', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'middleware-fixture-secret-with-enough-entropy');
    mockGetHeader.mockReturnValue(undefined);
    mockGetSession.mockResolvedValue({
      user: { id: 'fixture-user' },
      session: { id: 'fixture-session', userId: 'fixture-user', expiresAt: new Date('2099-01-01') },
    });
    const event = mockEvent();

    expect(await handler(event)).toBeUndefined();
    expect(event.context.auth).toMatchObject({ authenticated: true, actorId: 'fixture-user', method: 'session' });
    expect(mockSetResponseStatus).not.toHaveBeenCalled();
  });

  it('preserves 503 when the auth migration failed', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'middleware-fixture-secret-with-enough-entropy');
    setAuthMigrationFailed('fixture migration failed');
    const event = mockEvent();

    expect(asErrorEnvelope(await handler(event)).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
    expect(event.context.auth).toBeUndefined();
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('preserves 503 when a verified key cannot reach the workflow authority', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'middleware-fixture-secret-with-enough-entropy');
    mockGetHeader.mockReturnValue('Bearer verified-fixture-key');
    mockVerifyApiKey.mockResolvedValue({ valid: true, key: { id: 'fixture-key', referenceId: 'fixture-user', expiresAt: null } });
    mockGetWorkflowStore.mockReturnValue({ error: 'fixture workflow store unavailable' });
    const event = mockEvent();

    expect(asErrorEnvelope(await handler(event)).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
    expect(event.context.auth).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth middleware — route scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through for the health endpoint', async () => {
    mockGetRequestPath.mockReturnValue('/api/health');
    const event = mockEvent({ context: { runtimeConfig: { apiToken: 's3cret' } } });

    const result = await handler(event);

    expect(result).toBeUndefined();
    expect(mockSetResponseStatus).not.toHaveBeenCalled();
    expect(event.context.auth).toBeUndefined();
  });

  it('passes through for a browser /review (non-API) path', async () => {
    mockGetRequestPath.mockReturnValue('/review');
    const event = mockEvent({ context: { runtimeConfig: { apiToken: 's3cret' } } });

    const result = await handler(event);

    expect(result).toBeUndefined();
    expect(mockSetResponseStatus).not.toHaveBeenCalled();
    expect(event.context.auth).toBeUndefined();
  });

  it('passes through for an arbitrary static path', async () => {
    mockGetRequestPath.mockReturnValue('/_nuxt/assets/foo.js');
    const event = mockEvent({ context: { runtimeConfig: { apiToken: 's3cret' } } });

    const result = await handler(event);

    expect(result).toBeUndefined();
    expect(mockSetResponseStatus).not.toHaveBeenCalled();
  });
});


it('uses the Better Auth user ID when an older actor fallback is present', () => {
  const event = mockEvent({
    context: {
      auth: {
        authenticated: true,
        actorId: 'api-user',
        user: { id: 'owner-from-session', email: 'owner@example.com' },
      },
    },
  });

  expect(getActorId(event)).toBe('owner-from-session');
});

describe('auth middleware — no token configured (fail closed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 503 + SERVICE_UNAVAILABLE for an operational API route', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    mockGetHeader.mockReturnValue('Bearer some-token');
    const event = mockEvent({ context: { runtimeConfig: {} } });

    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
    const env = asErrorEnvelope(result);
    expect(env.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(env.error.reasonCodes).toContain('auth.not_configured');
  });

  it('does not set auth context on failure', async () => {
    mockGetRequestPath.mockReturnValue('/api/proposal');
    const event = mockEvent({ context: { runtimeConfig: {} } });

    await handler(event);

    expect(event.context.auth).toBeUndefined();
  });
});

describe('auth middleware — token validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 + WWW-Authenticate when no Authorization header is present', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    mockGetHeader.mockReturnValue(undefined);
    const event = mockEvent({ context: { runtimeConfig: { apiToken: 's3cret' } } });

    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 401);
    expect(mockSetHeader).toHaveBeenCalledWith(event, 'WWW-Authenticate', 'Bearer');
    const env = asErrorEnvelope(result);
    expect(env.error.code).toBe('UNAUTHORIZED');
    expect(env.error.reasonCodes).toContain('auth.missing_credentials');
  });

  it('returns 401 + WWW-Authenticate when Authorization header is not Bearer', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    mockGetHeader.mockReturnValue('Basic xyz');
    const event = mockEvent({ context: { runtimeConfig: { apiToken: 's3cret' } } });

    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 401);
    expect(mockSetHeader).toHaveBeenCalledWith(event, 'WWW-Authenticate', 'Bearer');
    const env = asErrorEnvelope(result);
    expect(env.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 + WWW-Authenticate for an invalid Bearer token', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    mockGetHeader.mockReturnValue('Bearer wrong-token');
    const event = mockEvent({ context: { runtimeConfig: { apiToken: 's3cret' } } });

    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 401);
    expect(mockSetHeader).toHaveBeenCalledWith(event, 'WWW-Authenticate', 'Bearer');
    const env = asErrorEnvelope(result);
    expect(env.error.code).toBe('UNAUTHORIZED');
    expect(env.error.reasonCodes).toContain('auth.missing_credentials');
  });

  it.each(['valid', 'expired', 'tampered', 'malformed'])(
    'preserves %s legacy signed-session validation', async (state) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime('2026-10-22T12:00:00.000Z');
      try {
        mockGetRequestPath.mockReturnValue('/api/review');
        const secret = 'legacy-fixture-secret';
        const expiry = Math.floor(Date.now() / 1000) + (state === 'expired' ? -1 : 60);
        const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ actorId: 'legacy-fixture-user', exp: expiry })).toString('base64url');
        const input = `${header}.${payload}`;
        const signature = createHmac('sha256', secret).update(input).digest('base64url');
        const cookie = state === 'malformed' ? 'invalid-cookie'
          : state === 'tampered' ? `${input}.${'x'.repeat(signature.length)}`
            : `${input}.${signature}`;
        mockGetCookie.mockReturnValue(cookie);
        const event = mockEvent({ context: { runtimeConfig: { apiToken: secret } } });

        const result = await handler(event);

        if (state === 'valid') {
          expect(result).toBeUndefined();
          expect(event.context.auth).toMatchObject({ actorId: 'legacy-fixture-user', method: 'legacy-token' });
        } else {
          expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 401);
          expect(asErrorEnvelope(result).error.code).toBe('UNAUTHORIZED');
          expect(event.context.auth).toBeUndefined();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

});

describe('auth middleware — actor identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets default actorId when authActorId is not configured', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    mockGetHeader.mockReturnValue('Bearer s3cret');
    const event = mockEvent({ context: { runtimeConfig: { apiToken: 's3cret' } } });

    await handler(event);

    expect(event.context.auth).toHaveProperty('actorId', 'api-user');
  });

  it('uses configured authActorId from runtime config', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    mockGetHeader.mockReturnValue('Bearer s3cret');
    const event = mockEvent({
      context: {
        runtimeConfig: {
          apiToken: 's3cret',
          authActorId: 'service-account',
        },
      },
    });

    await handler(event);

    expect(event.context.auth).toHaveProperty('actorId', 'service-account');
  });

  it('never reads actor identity from the request body', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    mockGetHeader.mockReturnValue('Bearer s3cret');
    const event = mockEvent({
      context: { runtimeConfig: { apiToken: 's3cret' } },
      body: { actorId: 'impostor@evil.dev' },
    });

    await handler(event);

    expect(event.context.auth).toHaveProperty('actorId', 'api-user');
  });
});

describe('auth middleware — dev bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });


  it('still returns 503 when devBypassAuth is false and no token', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    const event = mockEvent({ context: { runtimeConfig: { devBypassAuth: false } } });

    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
    const env = asErrorEnvelope(result);
    expect(env.error.code).toBe('SERVICE_UNAVAILABLE');
  });


  it('rejects env BALANCEFRAME_DEV_BYPASS_AUTH when value is "false" string', async () => {
    vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
    mockGetRequestPath.mockReturnValue('/api/review');
    const event = mockEvent();

    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
    const env = asErrorEnvelope(result);
    expect(env.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects config devBypassAuth when value is "false" string', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    const event = mockEvent({ context: { runtimeConfig: { devBypassAuth: 'false' } } });

    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
    const env = asErrorEnvelope(result);
    expect(env.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('auth middleware — constant-time comparison safeguard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects token with wrong length via fast-path 401', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    mockGetHeader.mockReturnValue('Bearer short');
    const event = mockEvent({ context: { runtimeConfig: { apiToken: 'a-long-secret-token' } } });

    await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 401);
    const headerCall = mockSetHeader.mock.calls.find(
      (c: unknown[]) => (c as string[])[1] === 'WWW-Authenticate',
    );
    expect(headerCall).toBeDefined();
  });

  it('accepts exact token match at the same length', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    mockGetHeader.mockReturnValue('Bearer abc123++');
    const event = mockEvent({ context: { runtimeConfig: { apiToken: 'abc123++' } } });

    const result = await handler(event);

    expect(result).toBeUndefined();
    expect(event.context.auth).toBeDefined();
  });
});
