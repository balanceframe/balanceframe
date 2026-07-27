/**
 * TDD: GET /api/reports/views delegates to savedViewsListAnalysis.
 *
 * Must fail against the current hardcoded stub.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockRestore, mockCreateDefaultConnectionManager, mockCreateNativeAnalysisProtocol } = vi.hoisted(() => ({
  mockRestore: vi.fn(),
  mockCreateDefaultConnectionManager: vi.fn(() => ({ restore: mockRestore })),
  mockCreateNativeAnalysisProtocol: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @balanceframe/application
// ---------------------------------------------------------------------------

vi.mock('@balanceframe/application', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createDefaultConnectionManager: mockCreateDefaultConnectionManager,
    createNativeAnalysisProtocol: mockCreateNativeAnalysisProtocol,
  };
});

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
  getWorkflowStore: vi.fn(() => ({ store: undefined as unknown as import('@balanceframe/workflow-store').SqliteWorkflowStore })),
  buildAuthorizationInfo: vi.fn(() => ({ actorId: 'test-actor', capability: 'observe', allowed: true })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((err, requestId, code, retryable) => ({ code, message: String(err), retryable })),
  okEnvelope: (result: unknown, _auth: unknown, requestId?: string) => ({
    schemaVersion: '1',
    requestId: requestId ?? 'test-req',
    status: 'ok' as const,
    dataFreshness: null,
    authorization: null,
    result,
    error: null,
  }),
  errorEnvelope: (code: string, message: string, _auth: unknown, retryable?: boolean, requestId?: string) => ({
    schemaVersion: '1',
    requestId: requestId ?? 'test-req',
    status: 'error' as const,
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code, message, retryable: retryable ?? false },
  }),
}));

// ---------------------------------------------------------------------------
// Import handler
// ---------------------------------------------------------------------------

import handler from '../../server/api/reports/views.get';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/reports/views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRestore.mockResolvedValue({
      connector: { name: 'mock-connector' },
      budget: { id: 'budget_test', groupId: 'group_test', name: 'Test', encrypted: false },
      synchronization: {},
    });
    mockCreateNativeAnalysisProtocol.mockResolvedValue({ listSavedViews: vi.fn() });
  });

  it('must delegate and return non-stub data', async () => {
    const p = await mockCreateNativeAnalysisProtocol();
    p.listSavedViews.mockResolvedValue({
      views: [
        { viewId: 'v1', name: 'Monthly', viewType: 'pending_review', scope: {}, createdAt: '2026-07-01T00:00:00Z' },
        { viewId: 'v2', name: 'Health', viewType: 'target_health', scope: {}, createdAt: '2026-07-15T00:00:00Z' },
      ],
      total: 2,
    });
    const r = await handler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.views).toHaveLength(2);
    expect(r.result.total).toBe(2);
    expect(r.result.views[0].name).toBe('Monthly');
    expect(r.result.views[1].viewId).toBe('v2');
  });

  it('must error when analysis fails', async () => {
    mockRestore.mockResolvedValue({ connector: null, budget: { id: 'b', groupId: 'g', name: 'T', encrypted: false }, synchronization: {} });
    const r = await handler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
  });
});
