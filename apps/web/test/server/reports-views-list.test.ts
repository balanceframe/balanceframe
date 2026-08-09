/**
 * TDD: GET /api/reports/views delegates to savedViewsListAnalysis.
 *
 * Must fail against the current hardcoded stub.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';

// ---------------------------------------------------------------------------
// Mock h3
// ---------------------------------------------------------------------------

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  setResponseStatus: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock workflow-store helpers
// ---------------------------------------------------------------------------

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: undefined as unknown as SqliteWorkflowStore })),
  buildAuthorizationInfo: vi.fn(() => ({
    actorId: 'test-actor',
    capability: 'observe',
    allowed: true,
  })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((err, requestId, code, retryable) => ({
    code,
    message: String(err),
    retryable,
  })),
  okEnvelope: (result: unknown, _auth: unknown, requestId?: string) => ({
    schemaVersion: '1',
    requestId: requestId ?? 'test-req',
    status: 'ok' as const,
    dataFreshness: null,
    authorization: null,
    result,
    error: null,
  }),
  errorEnvelope: (
    code: string,
    message: string,
    _auth: unknown,
    retryable?: boolean,
    requestId?: string,
  ) => ({
    schemaVersion: '1',
    requestId: requestId ?? 'test-req',
    status: 'error' as const,
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code, message, retryable: retryable ?? false },
  }),
}));

import handler from '../../server/api/reports/views.get';

describe('GET /api/reports/views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorkflowStore).mockReset();
    vi.mocked(getWorkflowStore).mockReturnValue({
      store: undefined as unknown as SqliteWorkflowStore,
    });
  });

  it('lists persisted views without restoring the external ledger', async () => {
    const listSavedViews = vi
      .fn()
      .mockResolvedValue([
        {
          viewId: 'v1',
          name: 'Monthly',
          viewType: 'pending_review',
          scope: {},
          sort: null,
          createdAt: '2026-07-01T00:00:00Z',
        },
      ]);
    vi.mocked(getWorkflowStore).mockReturnValue({
      store: { listSavedViews } as unknown as SqliteWorkflowStore,
    });

    const r = await handler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('ok');
    expect(r.result.views).toEqual([
      {
        viewId: 'v1',
        name: 'Monthly',
        viewType: 'pending_review',
        scope: {},
        createdAt: '2026-07-01T00:00:00Z',
      },
    ]);
    expect(listSavedViews).toHaveBeenCalledWith('test-actor');
  });

  it('returns a retryable store failure when view persistence fails', async () => {
    const listSavedViews = vi.fn().mockRejectedValue(new Error('database is locked'));
    vi.mocked(getWorkflowStore).mockReturnValue({
      store: { listSavedViews } as unknown as SqliteWorkflowStore,
    });

    const r = await handler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error.code).toBe('store_failed');
    expect(r.error.retryable).toBe(true);
  });
});
