/**
 * Focused tests for the server-side auth middleware.
 *
 * Tests use mocked h3 functions so no Nitro runtime is required.
 * The middleware exports via `defineEventHandler` which is mocked as
 * an identity wrapper — the default export is the raw handler function.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ApiEnvelope,
  AuthorizationInfo,
} from '../../server/utils/workflow-store';

// ---------------------------------------------------------------------------
// Mock h3 module — must be before importing the middleware
// ---------------------------------------------------------------------------

const { mockGetRequestPath, mockGetHeader, mockGetCookie, mockSetResponseStatus, mockSetHeader } = vi.hoisted(() => ({
  mockGetRequestPath: vi.fn(),
  mockGetHeader: vi.fn(),
  mockGetCookie: vi.fn().mockReturnValue(undefined),
  mockSetResponseStatus: vi.fn(),
  mockSetHeader: vi.fn(),
}));

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getRequestPath: mockGetRequestPath,
  getHeader: mockGetHeader,
  getCookie: mockGetCookie,
  setResponseStatus: mockSetResponseStatus,
  setHeader: mockSetHeader,
}));

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
    auth?: { authenticated: boolean; actorId?: string };
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

  it('passes through for a valid Bearer token on an operational API route', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    mockGetHeader.mockReturnValue('Bearer s3cret');
    const event = mockEvent({ context: { runtimeConfig: { apiToken: 's3cret' } } });

    const result = await handler(event);

    expect(result).toBeUndefined();
    expect(mockSetResponseStatus).not.toHaveBeenCalled();
    expect(mockSetHeader).not.toHaveBeenCalled();
    expect(event.context.auth).toEqual({
      authenticated: true,
      actorId: 'api-user',
    });
  });
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

  it('passes through when no token but devBypassAuth is true', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    const event = mockEvent({ context: { runtimeConfig: { devBypassAuth: true } } });

    const result = await handler(event);

    expect(result).toBeUndefined();
    expect(mockSetResponseStatus).not.toHaveBeenCalled();
    expect(event.context.auth).toBeUndefined();
  });

  it('still returns 503 when devBypassAuth is false and no token', async () => {
    mockGetRequestPath.mockReturnValue('/api/review');
    const event = mockEvent({ context: { runtimeConfig: { devBypassAuth: false } } });

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
