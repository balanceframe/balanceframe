/**
 * TDD: POST /api/reports/views delegates to savedViewCreateAnalysis.
 * Must fail against stub that fabricates IDs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRestore, mockReadBody, mockCreateDefaultConnectionManager, mockCreateNativeAnalysisProtocol } = vi.hoisted(() => ({
  mockRestore: vi.fn(),
  mockReadBody: vi.fn(),
  mockCreateDefaultConnectionManager: vi.fn(() => ({ restore: mockRestore })),
  mockCreateNativeAnalysisProtocol: vi.fn(),
}));

vi.mock('@balanceframe/application', async (i) => {
  const a = await i();
  return { ...a, createDefaultConnectionManager: mockCreateDefaultConnectionManager, createNativeAnalysisProtocol: mockCreateNativeAnalysisProtocol };
});

vi.mock('h3', () => ({ defineEventHandler: <T>(h: T) => h, readBody: mockReadBody, setResponseStatus: vi.fn() }));

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: undefined as unknown as import('@balanceframe/workflow-store').SqliteWorkflowStore })),
  buildAuthorizationInfo: vi.fn(() => ({ actorId: 'test-actor', capability: 'observe', allowed: true })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((e, r, c, ret) => ({ code: c, message: String(e), retryable: ret })),
  okEnvelope: (r, _a, rid?) => ({ schemaVersion: '1', requestId: rid ?? 'tr', status: 'ok' as const, dataFreshness: null, authorization: null, result: r, error: null }),
  errorEnvelope: (c, m, _a, ret?, rid?) => ({ schemaVersion: '1', requestId: rid ?? 'tr', status: 'error' as const, dataFreshness: null, authorization: null, result: null, error: { code: c, message: m, retryable: ret ?? false } }),
}));

import handler from '../../server/api/reports/views.post';

describe('POST /api/reports/views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRestore.mockResolvedValue({ connector: { name: 'm' }, budget: { id: 'b', groupId: 'g', name: 'T', encrypted: false }, synchronization: {} });
    mockCreateNativeAnalysisProtocol.mockResolvedValue({ createSavedView: vi.fn() });
  });

  it('must delegate and return protocol view ID (not fabricated)', async () => {
    const p = await mockCreateNativeAnalysisProtocol();
    p.createSavedView.mockResolvedValue({ view: { viewId: 'view_mock_det', name: 'My Dashboard', viewType: 'attention', scope: {}, sort: 'n:asc', createdAt: '2026-07-27T10:00:00Z' } });
    mockReadBody.mockResolvedValue({ name: 'My Dashboard', viewType: 'attention', scope: {}, sort: 'n:asc' });
    const r = await handler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.view.viewId).toBe('view_mock_det');
    expect(r.result.view.name).toBe('My Dashboard');
    expect(r.result.view.viewId).not.toMatch(/^view_[a-z0-9]{8}$/);
  });

  it('must error when protocol unavailable', async () => {
    mockRestore.mockResolvedValue({ connector: null, budget: { id: 'b', groupId: 'g', name: 'T', encrypted: false }, synchronization: {} });
    mockReadBody.mockResolvedValue({ name: 'T', viewType: 'v' });
    const r = await handler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
  });

  it('must reject missing name', async () => {
    mockReadBody.mockResolvedValue({ viewType: 'v' });
    const r = await handler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_NAME');
  });
});
