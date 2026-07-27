/**
 * TDD: PATCH /api/reports/views/[id] — update saved view scope/name.
 * TDD: DELETE /api/reports/views/[id] — delete a saved view.
 *
 * Must fail when view not found or store unavailable.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReadBody, mockGetWorkflowStore, mockGetRouterParam } = vi.hoisted(() => ({
  mockReadBody: vi.fn(),
  mockGetWorkflowStore: vi.fn(),
  mockGetRouterParam: vi.fn(),
}));

vi.mock('h3', () => ({
  defineEventHandler: <T>(h: T) => h,
  readBody: mockReadBody,
  getRouterParam: mockGetRouterParam,
  setResponseStatus: vi.fn(),
}));

const mockStore = {
  updateSavedView: vi.fn(),
  deleteSavedView: vi.fn(),
  getSavedView: vi.fn(),
};

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: mockStore })),
  buildAuthorizationInfo: vi.fn(() => ({ actorId: 'test-actor', capability: 'observe', allowed: true })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((e, r, c, ret) => ({ code: c, message: String(e), retryable: ret })),
  okEnvelope: (r) => ({ schemaVersion: '1', requestId: 'tr', status: 'ok', dataFreshness: null, authorization: null, result: r, error: null }),
  errorEnvelope: (c, m) => ({ schemaVersion: '1', requestId: 'tr', status: 'error', dataFreshness: null, authorization: null, result: null, error: { code: c, message: m, retryable: false } }),
}));

import patchHandler from '../../server/api/reports/views/[id].patch';
import deleteHandler from '../../server/api/reports/views/[id].delete';

describe('PATCH /api/reports/views/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must update view name and scope', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockReadBody.mockResolvedValue({ name: 'Renamed View', scope: { categoryGroup: 'essentials' } });
    mockStore.getSavedView.mockResolvedValue({ viewId: 'view_001', name: 'Original', viewType: 'attention', scope: {}, sort: null, lastUsedAt: null, createdAt: '2026-07-27T10:00:00Z' });
    mockStore.updateSavedView.mockResolvedValue({ viewId: 'view_001', name: 'Renamed View', viewType: 'attention', scope: { categoryGroup: 'essentials' }, sort: null, lastUsedAt: null, createdAt: '2026-07-27T10:00:00Z' });

    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.name).toBe('Renamed View');
  });

  it('must reject when view not found', async () => {
    mockGetRouterParam.mockReturnValue('view_missing');
    mockReadBody.mockResolvedValue({ name: 'X' });
    mockStore.getSavedView.mockResolvedValue(null);

    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('VIEW_NOT_FOUND');
  });
});

describe('DELETE /api/reports/views/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must delete existing view', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockStore.getSavedView.mockResolvedValue({ viewId: 'view_001', name: 'To Delete', viewType: 'attention', scope: {}, sort: null, lastUsedAt: null, createdAt: '2026-07-27T10:00:00Z' });
    mockStore.deleteSavedView.mockResolvedValue(true);

    const r = await deleteHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.deleted).toBe(true);
  });

  it('must reject when view not found', async () => {
    mockGetRouterParam.mockReturnValue('view_missing');
    mockStore.getSavedView.mockResolvedValue(null);

    const r = await deleteHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('VIEW_NOT_FOUND');
  });
});
