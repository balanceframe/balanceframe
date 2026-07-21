/**
 * Focused tests for the Nuxt global auth middleware.
 *
 * Verifies:
 * - In SSR, the incoming Cookie header is forwarded to the session check
 * - In SPA mode, no extra Cookie header is sent (browser sends automatically)
 * - Unauthenticated requests redirect to /login
 * - Public routes (login, /api/auth/*) bypass the session check
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mock #app — Nuxt auto-imports for route middleware
// ---------------------------------------------------------------------------

const { mockUseRequestHeaders, mockNavigateTo } = vi.hoisted(() => ({
  mockUseRequestHeaders: vi.fn<(include: string[]) => Record<string, string | undefined>>(),
  mockNavigateTo: vi.fn<(location: unknown) => void>(),
}));

vi.mock('#app', () => ({
  defineNuxtRouteMiddleware: <T>(handler: T) => handler,
  useRequestHeaders: mockUseRequestHeaders,
  navigateTo: mockNavigateTo,
}));

// ---------------------------------------------------------------------------
// Import module-under-test (after #app mock is in place)
// ---------------------------------------------------------------------------

import authMiddleware from '../../app/middleware/auth.global';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal shape of the `to` route object the middleware reads. */
interface MockRoute {
  path: string;
  fullPath: string;
}

function mockRoute(overrides?: Partial<MockRoute>): MockRoute {
  return {
    path: '/review',
    fullPath: '/review',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth.global middleware — session check', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('$fetch', fetchMock);
    mockUseRequestHeaders.mockReset();
    mockNavigateTo.mockReset();

    // Default: no incoming cookie (SPA / client-side context)
    mockUseRequestHeaders.mockReturnValue({});
  });

  // ── Bypassed routes ──────────────────────────────────────────────

  it('bypasses session check for /login', async () => {
    const result = await authMiddleware(mockRoute({ path: '/login' }));
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bypasses session check for /api/auth/* routes', async () => {
    const result = await authMiddleware(
      mockRoute({ path: '/api/auth/get-session' }),
    );
    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── SPA mode (no cookie forwarding) ──────────────────────────────

  it('fetches session without extra Cookie header in SPA mode', async () => {
    fetchMock.mockResolvedValueOnce({ user: { id: 'u1', email: 'a@b' } });

    await authMiddleware(mockRoute());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.credentials).toBe('same-origin');
    expect(opts.headers?.Cookie).toBeUndefined();
  });

  // ── SSR mode (cookie forwarded) ──────────────────────────────────

  it('forwards incoming Cookie header to session check during SSR', async () => {
    fetchMock.mockResolvedValueOnce({ user: { id: 'u1', email: 'a@b' } });

    // Simulate SSR context: incoming request carries a session cookie
    mockUseRequestHeaders.mockReturnValue({
      cookie: 'better-auth-session=abc123',
    });

    await authMiddleware(mockRoute());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers?.Cookie).toBe('better-auth-session=abc123');
    expect(opts.credentials).toBe('same-origin');
  });

  it('forwards empty cookie header as undefined when no cookie present', async () => {
    fetchMock.mockResolvedValueOnce({ user: { id: 'u1', email: 'a@b' } });

    // SSR context but no cookie on the incoming request
    mockUseRequestHeaders.mockReturnValue({ cookie: undefined });

    await authMiddleware(mockRoute());

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers?.Cookie).toBeUndefined();
  });

  // ── Redirects ────────────────────────────────────────────────────

  it('redirects to /login when session check fails (no user)', async () => {
    fetchMock.mockResolvedValueOnce({ user: null });

    await authMiddleware(mockRoute());

    expect(mockNavigateTo).toHaveBeenCalledWith({
      path: '/login',
      query: { redirect: '/review' },
    });
  });

  it('redirects to /login on fetch error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));

    await authMiddleware(mockRoute());

    expect(mockNavigateTo).toHaveBeenCalledWith({
      path: '/login',
      query: { redirect: '/review' },
    });
  });

  it('preserves original fullPath in redirect query', async () => {
    fetchMock.mockResolvedValueOnce({ user: null });

    await authMiddleware(
      mockRoute({ path: '/review/some-item', fullPath: '/review/some-item?tab=details' }),
    );

    expect(mockNavigateTo).toHaveBeenCalledWith({
      path: '/login',
      query: { redirect: '/review/some-item?tab=details' },
    });
  });

  // ── Session found — no redirect ──────────────────────────────────

  it('allows navigation when session is valid', async () => {
    fetchMock.mockResolvedValueOnce({ user: { id: 'u1', email: 'a@b' } });

    const result = await authMiddleware(mockRoute());
    expect(result).toBeUndefined(); // no redirect
    expect(mockNavigateTo).not.toHaveBeenCalled();
  });
});
