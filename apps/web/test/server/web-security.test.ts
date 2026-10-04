/**
 * Auth identity derivation, response envelopes, readiness, and production auth-middleware tests.
 *
 * Bound-space Native authorization and proposal behavior are exercised by review route tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  reviewAndApplyEnabled,
  getActorId,
  okEnvelope,
  errorEnvelope,
  buildAuthorizationInfo,
  sanitizeError,
} from '../../server/utils/workflow-store';
import type { EventWithContext, ApiError } from '../../server/utils/workflow-store';
import { resolveAuthDbPath } from '../../lib/auth-db-path';

// ---------------------------------------------------------------------------
// Mock h3 for auth middleware tests — must be before importing middleware
// ---------------------------------------------------------------------------

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
  getHeader: mockGetHeader,
  getCookie: mockGetCookie,
  setResponseStatus: mockSetResponseStatus,
  setHeader: mockSetHeader,
}));

// ---------------------------------------------------------------------------
// Auth middleware — lazy import so h3 mock is in place
// ---------------------------------------------------------------------------

import authMiddleware from '../../server/middleware/auth';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACTOR = 'test-security-user';


function mockEvent(opts: {
  authenticated?: boolean;
  actorId?: string;
  config?: Record<string, unknown>;
}): EventWithContext {
  return {
    context: {
      auth: opts.authenticated
        ? { authenticated: true, actorId: opts.actorId ?? ACTOR }
        : undefined,
      runtimeConfig: opts.config ?? {},
    },
  };
}

// ---------------------------------------------------------------------------
// Authenticated identity derivation
// ---------------------------------------------------------------------------

describe('authenticated identity derivation', () => {
  it('getActorId returns "anonymous" when no auth context is present', () => {
    const ev = mockEvent({ authenticated: false });
    expect(getActorId(ev)).toBe('anonymous');
  });

  it('buildAuthorizationInfo returns null when auth context is absent', () => {
    const ev = mockEvent({ authenticated: false });
    expect(buildAuthorizationInfo(ev, 'categorization:execute')).toBeNull();
  });

  it('buildAuthorizationInfo returns null when auth context is undefined', () => {
    const ev = { context: {} } as EventWithContext;
    expect(buildAuthorizationInfo(ev, 'categorization:execute')).toBeNull();
  });

  it('getActorId returns "anonymous" for completely missing auth', () => {
    const ev = { context: {} } as EventWithContext;
    expect(getActorId(ev)).toBe('anonymous');
  });

});

// ---------------------------------------------------------------------------
// Public response envelopes
// ---------------------------------------------------------------------------

describe('public response envelopes', () => {
  it('errorEnvelope preserves safe codes, messages, and correlation IDs', () => {
    const authInfo = null;
    const envelope = errorEnvelope(
      'FORBIDDEN',
      'Current selected-space grant is unavailable.',
      authInfo,
      false,
      'req-abc-123',
    );

    const error = envelope.error as ApiError;
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('Current selected-space grant is unavailable.');
    expect(error.retryable).toBe(false);
    expect(envelope.requestId).toBe('req-abc-123');
  });

  it('okEnvelope carries requestId for correlation', () => {
    const authInfo = null;
    const envelope = okEnvelope({ items: [] }, authInfo, 'req-xyz');
    expect(envelope.requestId).toBe('req-xyz');
    expect(envelope.status).toBe('ok');
    expect(envelope.error).toBeNull();
  });

  it('errorEnvelope with retryable=true signals transient failure', () => {
    const authInfo = null;
    const envelope = errorEnvelope(
      'NATIVE_UNAVAILABLE',
      'Native service unavailable.',
      authInfo,
      true,
      'req-retry',
    );
    const error = envelope.error as ApiError;
    expect(error.retryable).toBe(true);
    expect(error.code).toBe('NATIVE_UNAVAILABLE');
  });

  it('errorEnvelope with retryable=false signals non-transient failure', () => {
    const authInfo = null;
    const envelope = errorEnvelope('INVALID_REVIEW_CORRECTION', 'Bad input', authInfo, false, 'req-no-retry');
    const error = envelope.error as ApiError;
    expect(error.retryable).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Readiness and proposal configuration
// ---------------------------------------------------------------------------

describe('readiness and fail-closed startup', () => {
  it('resolveAuthDbPath returns a non-empty path (readiness)', () => {
    const path = resolveAuthDbPath();
    expect(path).toBeTruthy();
    expect(typeof path).toBe('string');
  });

  it('health mode defaults to "observe" when reviewAndApply is not set', () => {
    const ev = mockEvent({ authenticated: true, config: {} });
    const mode = reviewAndApplyEnabled(ev) ? 'reviewAndApply' : 'observe';
    expect(mode).toBe('observe');
  });

  it('health mode is "reviewAndApply" when config enables it', () => {
    const ev = mockEvent({ authenticated: true, config: { reviewAndApply: true } });
    const mode = reviewAndApplyEnabled(ev) ? 'reviewAndApply' : 'observe';
    expect(mode).toBe('reviewAndApply');
  });

  it('reviewAndApplyEnabled returns false when config is missing', () => {
    const ev = { context: {} } as EventWithContext;
    expect(reviewAndApplyEnabled(ev)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Safe error responses
// ---------------------------------------------------------------------------

describe('safe error responses', () => {
  it('sanitizeError strips paths and source references before building a public envelope', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const authInfo = null;
    const safe = sanitizeError(
      new Error('Internal SQLite failure at /var/app/data/db.sqlite (review.ts:42) ActualLedger.deleteRule'),
      'req-redact-1',
      'STORE_UNAVAILABLE',
    );
    const envelope = errorEnvelope(
      safe.code,
      safe.message,
      authInfo,
      safe.retryable,
      'req-redact-1',
    );
    const error = envelope.error as ApiError;

    expect(error.code).toBe('STORE_UNAVAILABLE');
    expect(error.message).toBe('Internal SQLite failure at');
    expect(error.message).not.toContain('/var/app');
    expect(error.message).not.toContain('review.ts');
    expect(error.message).not.toContain('ActualLedger');
    expect(envelope.requestId).toBe('req-redact-1');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('req-redact-1'));
    log.mockRestore();
  });

  it('error code is always a stable machine-readable string', () => {
    const authInfo = null;
    const codes = [
      'STORE_UNAVAILABLE',
      'SPACE_BUDGET_REQUIRED',
      'FORBIDDEN',
      'NATIVE_UNAVAILABLE',
      'PROPOSAL_DENIED',
      'INVALID_REVIEW_CORRECTION',
      'REAUTHENTICATION_REQUIRED',
    ];

    for (const code of codes) {
      const envelope = errorEnvelope(code, `Message for ${code}`, authInfo, false, `req-${code}`);
      const err = envelope.error as ApiError;
      expect(err.code).toBe(code);
      // Code is always uppercase with underscores — machine parseable
      expect(err.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it('error response always carries a requestId regardless of success state', () => {
    const authInfo = null;
    const successEnv = okEnvelope({ data: 'test' }, authInfo, 'req-success');
    expect(successEnv.requestId).toBe('req-success');

    const errorEnv = errorEnvelope('NATIVE_UNAVAILABLE', 'service unavailable', authInfo, false, 'req-error');
    expect(errorEnv.requestId).toBe('req-error');
  });

});

// ---------------------------------------------------------------------------
// Production auth bypass rejection
// ---------------------------------------------------------------------------

interface MockMiddlewareEvent {
  context: {
    runtimeConfig?: Record<string, unknown>;
    auth?: { authenticated: boolean; actorId?: string };
  };
}

function mockMiddlewareEvent(): MockMiddlewareEvent {
  return { context: {} };
}

function asErrorEnvelope(v: unknown): {
  status: string;
  error: { code: string; message: string };
} {
  const e = v as {
    status: string;
    error: { code: string; message: string };
  };
  expect(e.status).toBe('error');
  expect(e.error).toBeDefined();
  return e;
}

describe('production mode — dev bypass rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects dev bypass with 503 when NODE_ENV is production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'true');
    mockGetRequestPath.mockReturnValue('/api/review');
    const event = mockMiddlewareEvent();

    const handler = authMiddleware as (event: MockMiddlewareEvent) => Promise<unknown>;
    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
    const env = asErrorEnvelope(result);
    expect(env.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('rejects dev bypass with 503 when NODE_ENV is empty (unset)', async () => {
    vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'true');
    vi.stubEnv('NODE_ENV', '');
    mockGetRequestPath.mockReturnValue('/api/review');
    const event = mockMiddlewareEvent();

    const handler = authMiddleware as (event: MockMiddlewareEvent) => Promise<unknown>;
    const result = await handler(event);

    expect(mockSetResponseStatus).toHaveBeenCalledWith(event, 503);
    const env = asErrorEnvelope(result);
    expect(env.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
