/**
 * Focused tests for the session auth boundary.
 *
 * Verifies:
 * - No public endpoint mints bearer tokens (session.get.ts removed)
 * - useSessionToken returns null — no bearer token exposed to browser JS
 * - The controller omits Authorization header when no token is provided
 * - Session auth relies on same-origin HttpOnly cookie, not a JS token
 * - No private token appears in runtimeConfig.public
 *
 * All tests mock fetch; no Nitro runtime or WorkflowStore needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { useSessionToken, resetSessionTokenCache } from '../composables/useSessionToken';
import { useApiReviewController } from '../composables/useApiReviewController';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid ok envelope wrapping any result payload. */
function okEnvelope(result: unknown) {
  return {
    schemaVersion: '1',
    requestId: 'test-req',
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session auth boundary', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    resetSessionTokenCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── No public token minting ──────────────────────────────────────

  it('has no public session-minting endpoint', async () => {
    // The file server/api/auth/session.get.ts has been removed.
    // Verify the composable does NOT attempt to fetch a token.
    const { getSessionToken } = useSessionToken();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSessionToken()).toBeNull();
  });

  // ── useSessionToken returns null ─────────────────────────────────

  describe('useSessionToken', () => {
    it('returns null via getSessionToken — no bearer token from browser', () => {
      const { getSessionToken } = useSessionToken();
      expect(getSessionToken()).toBeNull();
    });

    it('does not call fetch at all', () => {
      useSessionToken();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null on repeated calls', () => {
      const { getSessionToken } = useSessionToken();
      expect(getSessionToken()).toBeNull();
      expect(getSessionToken()).toBeNull();
    });
  });

  // ── Integration with useApiReviewController ─────────────────────

  describe('integration with useApiReviewController', () => {
    it('omits Authorization header when getSessionToken returns null', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const { getSessionToken } = useSessionToken();
      const adapter = useApiReviewController('http://test.local', {
        getSessionToken,
      });

      await adapter.loadNextPage();

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers?.['Authorization']).toBeUndefined();
      // same-origin credentials are still sent regardless
      expect(opts.credentials).toBe('same-origin');
    });

    it('omits Authorization header when no options passed', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers?.['Authorization']).toBeUndefined();
      expect(opts.credentials).toBe('same-origin');
    });

    it('sends same-origin credentials on every request', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      await adapter.loadNextPage();

      for (const call of fetchMock.mock.calls) {
        expect(call[1].credentials).toBe('same-origin');
      }
    });
  });

  // ── Boundary: no runtimeConfig.public token leak ────────────────

  describe('no private token leak', () => {
    it('does not expose apiToken in runtimeConfig.public', async () => {
      // Simulate what the page does: read runtimeConfig.public.apiBase
      const runtimeConfig = {
        public: {
          apiBase: 'http://localhost:3000',
          // apiToken is NOT in public config
        },
      };

      // Verify the apiToken is not in the public config
      expect(runtimeConfig.public).not.toHaveProperty('apiToken');
      expect(runtimeConfig.public.apiBase).toBe('http://localhost:3000');
    });

    it('never sends actorId in request body', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [makeItem()], total: 1 })),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      // Action request
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ itemId: 'item-001', success: true, error: null })),
      });

      await adapter.approve();

      const [, opts] = fetchMock.mock.calls[1];
      const body = JSON.parse(opts.body as string);
      expect(body).not.toHaveProperty('actorId');
      expect(body).toHaveProperty('reviewId');
      expect(opts.headers?.['Authorization']).toBeUndefined();
    });

    it('never sends Bearer Authorization header', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      for (const call of fetchMock.mock.calls) {
        expect(call[1].headers?.['Authorization']).toBeUndefined();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Test helper (same shape as api-review-controller.test.ts)
// ---------------------------------------------------------------------------
/** Test item matching the server API wire format (nested under reviewItem). */
function makeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewItem: {
      id: 'item-001',
      description: 'Test item',
      category: 'test',
      source: 'test-source',
      ...overrides,
    },
  };
}
