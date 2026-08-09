/**
 * TDD: Additional saved-view lifecycle routes.
 * GET /api/reports/views/:id, POST duplicate, PATCH last-used
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
  getSavedView: vi.fn(),
  duplicateSavedView: vi.fn(),
  recordSavedViewUsage: vi.fn(),
};

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: mockStore })),
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

import getHandler from '../../server/api/reports/views/[id].get';
import duplicateHandler from '../../server/api/reports/views/[id]/duplicate.post';
import lastUsedHandler from '../../server/api/reports/views/[id]/last-used.patch';

const SAMPLE_VIEW = {
  viewId: 'view_001',
  name: 'My View',
  viewType: 'attention',
  scope: {},
  sort: null,
  lastUsedAt: null,
  createdAt: '2026-07-27T10:00:00Z',
};

describe('GET /api/reports/views/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must return a saved view by ID', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockStore.getSavedView.mockResolvedValue(SAMPLE_VIEW);
    const r = await getHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.viewId).toBe('view_001');
  });

  it('must return 404 when view not found', async () => {
    mockGetRouterParam.mockReturnValue('view_missing');
    mockStore.getSavedView.mockResolvedValue(null);
    const r = await getHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('VIEW_NOT_FOUND');
  });

  it('must reject missing view ID', async () => {
    mockGetRouterParam.mockReturnValue('');
    const r = await getHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_VIEW_ID');
  });
});

describe('POST /api/reports/views/[id]/duplicate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must duplicate a saved view', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockReadBody.mockResolvedValue({ name: 'Duplicated View' });
    mockStore.duplicateSavedView.mockResolvedValue({
      ...SAMPLE_VIEW,
      viewId: 'view_002',
      name: 'Duplicated View',
    });
    const r = await duplicateHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.name).toBe('Duplicated View');
  });

  it('must reject missing name', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockReadBody.mockResolvedValue({});
    const r = await duplicateHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_NAME');
  });
});

describe('PATCH /api/reports/views/[id]/last-used', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must record last used timestamp', async () => {
    mockGetRouterParam.mockReturnValue('view_001');
    mockStore.getSavedView.mockResolvedValue(SAMPLE_VIEW);
    mockStore.recordSavedViewUsage.mockResolvedValue({
      ...SAMPLE_VIEW,
      lastUsedAt: '2026-07-27T12:00:00Z',
    });
    const r = await lastUsedHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.lastUsedAt).toBe('2026-07-27T12:00:00Z');
  });

  it('must reject when view not found', async () => {
    mockGetRouterParam.mockReturnValue('view_missing');
    mockStore.getSavedView.mockResolvedValue(null);
    const r = await lastUsedHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('VIEW_NOT_FOUND');
  });
});
