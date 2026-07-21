/**
 * Focused tests for the API-backed ReviewControllerAdapter.
 *
 * Verifies:
 * - Session credential header propagation
 * - Malformed / non-JSON envelope rejection
 * - Result-level failure propagation
 * - No-current-item early rejection
 * - Successful state refresh (item removed from queue)
 * - Unsupported operations return explicit failures
 *
 * All tests mock fetch; no Nitro runtime or WorkflowStore needed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { useApiReviewController } from '../composables/useApiReviewController';
import type { ReviewControllerAdapter } from '../types/review-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal review queue item shape that the surface state expects. */
function makeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewItem: {
      id: 'item-001',
      budgetId: 'budget-test',
      transactionId: 'txn-001',
      categoryId: 'cat-food',
      classifier: 'test',
      provenance: 'test',
      status: 'pending_review',
      version: 3,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      ...overrides,
    },
    evidence: {
      amount: 5000,
      currency: 'USD',
      description: 'Test transaction',
      history: [],
      provenance: 'test',
      freshness: null,
      changePreview: { field: null, oldValue: null, newValue: null },
      correlationId: null,
      promptVersion: '1',
    },
    homogeneity: {
      homogeneous: true,
      commonStatus: 'pending_review',
      commonCategory: 'cat-food',
      commonClassifier: 'test',
      groupSize: 1,
      conflictReason: null,
    },
    actionable: true,
  };
}

/** A valid ok envelope wrapping any result payload. */
function okEnvelope(result: unknown) {
  return {
    schemaVersion: '1',
    requestId: 'req-test',
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result,
    error: null,
  };
}

/** A valid error envelope. */
function errorEnvelope(
  code: string,
  message: string,
  retryable = false,
) {
  return {
    schemaVersion: '1',
    requestId: 'req-test',
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code, message, retryable },
  };
}

/** A valid SingleActionResult for a successful action. */
function successResult(itemId: string): { itemId: string; success: true; error: null } {
  return { itemId, success: true, error: null };
}

/** A valid SingleActionResult for a failed action (result-level). */
function failureResult(itemId: string, errorMsg: string): { itemId: string; success: false; error: string } {
  return { itemId, success: false, error: errorMsg };
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useApiReviewController', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Headers / credentials ───────────────────────────────────────

  describe('headers and credentials', () => {
    it('sends same-origin credentials by default', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.credentials).toBe('same-origin');
    });

    it('sets Authorization Bearer header when getSessionToken is provided', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const adapter = useApiReviewController('http://test.local', {
        getSessionToken: () => 'test-token-abc',
      });
      await adapter.loadNextPage();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers).toBeInstanceOf(Object);
      expect(opts.headers['Authorization']).toBe('Bearer test-token-abc');
    });

    it('omits Authorization header when getSessionToken returns null', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(okEnvelope({ items: [], total: 0 })),
      });

      const adapter = useApiReviewController('http://test.local', {
        getSessionToken: () => null,
      });
      await adapter.loadNextPage();

      const [, opts] = fetchMock.mock.calls[0];
      expect(opts.headers?.['Authorization']).toBeUndefined();
    });

    it('never sends actorId in request body', async () => {
      // First load: seed an item into state
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            okEnvelope({ items: [makeItem()], total: 1 }),
          ),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      // Second call: action request that should NOT include actorId
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(okEnvelope(successResult('item-001'))),
      });

      await adapter.approve();

      // Verify the action POST body does not contain actorId
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, opts] = fetchMock.mock.calls[1];
      const body = JSON.parse(opts.body as string);
      expect(body).not.toHaveProperty('actorId');
    });
  });

  // ── Malformed envelope handling ─────────────────────────────────

  describe('malformed envelopes', () => {
    it('rejects non-JSON response body', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new SyntaxError('Unexpected token')),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(adapter.error).not.toBeNull();
      expect(adapter.error).toContain('non-JSON');
    });

    it('rejects empty body', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(null),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(adapter.error).not.toBeNull();
    });

    it('rejects envelope missing status field', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ requestId: 'x' }),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(adapter.error).not.toBeNull();
      expect(adapter.error).toContain('invalid');
    });

    it('rejects envelope with invalid status value', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ status: 'maybe', requestId: 'x', result: null, error: null }),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(adapter.error).not.toBeNull();
    });
  });

  // ── Result-level failure propagation ────────────────────────────

  describe('result-level failure propagation', () => {
    async function setupWithItem(): Promise<ReviewControllerAdapter> {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            okEnvelope({ items: [makeItem()], total: 1 }),
          ),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      return adapter;
    }

    it('propagates result.success=false to error state and WebActionResult', async () => {
      const adapter = await setupWithItem();

      // Now seed the POST mock for an action that returns result-level failure
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            okEnvelope(
              failureResult('item-001', 'Workflow transition rejected'),
            ),
          ),
      });

      const result = await adapter.approve();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Workflow transition rejected');
      expect(adapter.error).toBe('Workflow transition rejected');
    });

    it('propagates envelope-level error to error state', async () => {
      const adapter = await setupWithItem();

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () =>
          Promise.resolve(
            errorEnvelope('INTERNAL', 'Server error occurred'),
          ),
      });

      const result = await adapter.approve();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Server error');
      expect(adapter.error).toContain('Server error');
    });
  });

  // ── No-current-item guard ───────────────────────────────────────

  describe('no-current-item guard', () => {
    it('returns failure when no current item exists', async () => {
      const adapter = useApiReviewController('http://test.local');

      const result = await adapter.approve();

      expect(result.success).toBe(false);
      expect(result.error).toContain('No current item');
      expect(adapter.error).toContain('No current item');
    });

    it('returns failure for correct when no current item', async () => {
      const adapter = useApiReviewController('http://test.local');

      const result = await adapter.correct('cat-office');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No current item');
    });

    it('returns failure for reject when no current item', async () => {
      const adapter = useApiReviewController('http://test.local');

      const result = await adapter.reject();

      expect(result.success).toBe(false);
    });

    it('returns failure for skip when no current item', async () => {
      const adapter = useApiReviewController('http://test.local');

      const result = await adapter.skip();

      expect(result.success).toBe(false);
    });
  });

  // ── Successful state refresh ────────────────────────────────────

  describe('state refresh after successful action', () => {
    async function setupWithOneItem(): Promise<ReviewControllerAdapter> {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            okEnvelope({ items: [makeItem()], total: 1 }),
          ),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();
      return adapter;
    }

    it('removes the approved item from the local queue', async () => {
      const adapter = await setupWithOneItem();

      expect(adapter.state.items).toHaveLength(1);

      // Mock the POST approve response
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(okEnvelope(successResult('item-001'))),
      });

      const result = await adapter.approve();

      expect(result.success).toBe(true);
      expect(result.error).toBeNull();

      // The item should be removed from the queue
      expect(adapter.state.items).toHaveLength(0);
      expect(adapter.state.currentItem).toBeNull();
      expect(adapter.state.currentIndex).toBe(-1);
    });

    it('advances to the next item after approving the first of two', async () => {
      // Return two items on initial load
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(
            okEnvelope({
              items: [makeItem({ id: 'item-001' }), makeItem({ id: 'item-002' })],
              total: 2,
            }),
          ),
      });

      const adapter = useApiReviewController('http://test.local');
      await adapter.loadNextPage();

      expect(adapter.state.items).toHaveLength(2);
      expect(adapter.state.currentItem?.reviewItem.id).toBe('item-001');

      // Approve the first item
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve(okEnvelope(successResult('item-001'))),
      });

      await adapter.approve();

      expect(adapter.state.items).toHaveLength(1);
      expect(adapter.state.currentItem?.reviewItem.id).toBe('item-002');
      expect(adapter.state.currentIndex).toBe(0);
    });
  });

  // ── Unsupported operations ──────────────────────────────────────

  describe('unsupported operations', () => {
    it('undo returns explicit failure', async () => {
      const adapter = useApiReviewController('http://test.local');
      const result = await adapter.undo();

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
      expect(adapter.error).toContain('not supported');
    });

    it('bulkApprove returns explicit failure', async () => {
      const adapter = useApiReviewController('http://test.local');
      const result = await adapter.bulkApprove();

      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain('not supported');
      expect(result.consumedCount).toBe(0);
      expect(result.errorCount).toBe(1);
    });

    it('bulkCorrect returns explicit failure', async () => {
      const adapter = useApiReviewController('http://test.local');
      const result = await adapter.bulkCorrect('cat-office');

      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(result.errorCount).toBe(1);
    });

    it('bulkReject returns explicit failure', async () => {
      const adapter = useApiReviewController('http://test.local');
      const result = await adapter.bulkReject();

      expect(result.results[0].success).toBe(false);
      expect(result.errorCount).toBe(1);
    });

    it('bulkSkip returns explicit failure', async () => {
      const adapter = useApiReviewController('http://test.local');
      const result = await adapter.bulkSkip();

      expect(result.results[0].success).toBe(false);
      expect(result.errorCount).toBe(1);
    });

    it('undo sets error on adapter even when no current item exists', async () => {
      const adapter = useApiReviewController('http://test.local');

      // Undo is a static failure regardless of state
      const result = await adapter.undo();
      expect(result.success).toBe(false);
      expect(adapter.error).toContain('not supported');
    });
  });
});
