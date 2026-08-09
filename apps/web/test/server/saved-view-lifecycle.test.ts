/**
 * TDD: Saved-view lifecycle routes.
 * PATCH /api/reports/views/:id — update saved view scope/name/sort.
 * DELETE /api/reports/views/:id — delete a saved view.
 *
 * Must fail when view not found or store unavailable.
 * Tests cover:
 *  - Happy-path update (name, scope, sort independently)
 *  - Happy-path delete
 *  - View not found (404)
 *  - Missing view ID (400)
 *  - Store unavailable (503)
 *  - Authorized scope display (actorId in response)
 *  - Freshness separate from view metadata (lastUsedAt vs createdAt)
 *  - Sort update clears null
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

mockGetWorkflowStore.mockReturnValue({ store: mockStore });

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: mockGetWorkflowStore,
  buildAuthorizationInfo: vi.fn(() => ({
    actorId: 'test-actor',
    capability: 'observe',
    allowed: true,
  })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((e, r, c, ret) => ({ code: c, message: String(e), retryable: ret })),
  okEnvelope: (r) => ({
    schemaVersion: '1',
    requestId: 'tr',
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: r,
    error: null,
  }),
  errorEnvelope: (c, m) => ({
    schemaVersion: '1',
    requestId: 'tr',
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code: c, message: m, retryable: false },
  }),
}));

import patchHandler from '../../server/api/reports/views/[id].patch';
import deleteHandler from '../../server/api/reports/views/[id].delete';

const SAMPLE_VIEW = {
  viewId: 'view_001',
  name: 'Original View',
  viewType: 'attention',
  scope: { categoryGroup: 'all' },
  sort: null,
  lastUsedAt: null,
  actorId: 'actor_001',
  createdAt: '2026-07-27T10:00:00Z',
};

describe('PATCH /api/reports/views/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must update view name and scope', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockReadBody.mockResolvedValue({
      name: 'Renamed View',
      scope: { categoryGroup: 'essentials' },
    });
    mockStore.getSavedView.mockResolvedValue(SAMPLE_VIEW);
    mockStore.updateSavedView.mockResolvedValue({
      ...SAMPLE_VIEW,
      name: 'Renamed View',
      scope: { categoryGroup: 'essentials' },
    });

    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.name).toBe('Renamed View');
    expect(r.result.scope).toEqual({ categoryGroup: 'essentials' });
  });

  it('must update name only without touching scope', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockReadBody.mockResolvedValue({ name: 'Just Renamed' });
    mockStore.getSavedView.mockResolvedValue(SAMPLE_VIEW);
    mockStore.updateSavedView.mockResolvedValue({ ...SAMPLE_VIEW, name: 'Just Renamed' });

    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.name).toBe('Just Renamed');
    expect(mockStore.updateSavedView).toHaveBeenCalledWith('view_001', {
      name: 'Just Renamed',
      scope: undefined,
      sort: undefined,
    });
  });

  it('must update sort only', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockReadBody.mockResolvedValue({ sort: 'severity:desc' });
    mockStore.getSavedView.mockResolvedValue(SAMPLE_VIEW);
    mockStore.updateSavedView.mockResolvedValue({ ...SAMPLE_VIEW, sort: 'severity:desc' });

    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.sort).toBe('severity:desc');
  });

  it('must clear sort when sort is null', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockReadBody.mockResolvedValue({ sort: null });
    mockStore.getSavedView.mockResolvedValue({ ...SAMPLE_VIEW, sort: 'severity:desc' });
    mockStore.updateSavedView.mockResolvedValue({ ...SAMPLE_VIEW, sort: null });

    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.sort).toBeNull();
  });

  it('must preserve actorId (authorized scope) through updates', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockReadBody.mockResolvedValue({ name: 'Updated' });
    mockStore.getSavedView.mockResolvedValue(SAMPLE_VIEW);
    mockStore.updateSavedView.mockResolvedValue({
      ...SAMPLE_VIEW,
      name: 'Updated',
      actorId: 'actor_001',
    });

    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.actorId).toBe('actor_001');
  });

  it('must preserve createdAt (freshness is separate from view metadata)', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockReadBody.mockResolvedValue({ name: 'Updated' });
    mockStore.getSavedView.mockResolvedValue(SAMPLE_VIEW);
    mockStore.updateSavedView.mockResolvedValue({ ...SAMPLE_VIEW, name: 'Updated' });

    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.createdAt).toBe('2026-07-27T10:00:00Z');
    // lastUsedAt is separate from view metadata updates
    expect(r.result.lastUsedAt).toBeNull();
  });

  it('must reject when view not found', async () => {
    mockGetRouterParam.mockReturnValue('view_missing');
    mockReadBody.mockResolvedValue({ name: 'X' });
    mockStore.getSavedView.mockResolvedValue(null);

    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('VIEW_NOT_FOUND');
  });

  it('must reject missing view ID', async () => {
    mockGetRouterParam.mockReturnValue('');
    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_VIEW_ID');
  });

  it('must return 503 when store unavailable', async () => {
    mockGetWorkflowStore.mockReturnValueOnce({ error: 'DB locked' });
    mockGetRouterParam.mockReturnValue('view_001');
    const r = await patchHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('STORE_UNAVAILABLE');
  });
});

describe('DELETE /api/reports/views/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must delete existing view', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockStore.getSavedView.mockResolvedValue(SAMPLE_VIEW);
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

  it('must reject missing view ID', async () => {
    mockGetRouterParam.mockReturnValue('');
    const r = await deleteHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_VIEW_ID');
  });

  it('must return 503 when store unavailable', async () => {
    mockGetWorkflowStore.mockReturnValueOnce({ error: 'DB locked' });
    mockGetRouterParam.mockReturnValue('view_001');
    const r = await deleteHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('STORE_UNAVAILABLE');
  });
});
