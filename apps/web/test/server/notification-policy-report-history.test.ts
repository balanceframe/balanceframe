/**
 * TDD: Notification policy routes and report history route.
 * GET/POST /api/notifications/policy, GET /api/reports/history
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockReadBody,
  mockGetWorkflowStore,
  mockGetQuery,
  mockGetRouterParam,
  mockRequireAuthorization,
} = vi.hoisted(() => {
  const mockRequireAuthorization = vi.fn();
  mockRequireAuthorization.mockResolvedValue({
    ok: true,
    info: { actorId: 'test-actor', capability: 'notification:admin', allowed: true },
  });
  return {
    mockReadBody: vi.fn(),
    mockGetWorkflowStore: vi.fn(),
    mockGetQuery: vi.fn(() => ({})),
    mockGetRouterParam: vi.fn(),
    mockRequireAuthorization,
  };
});

vi.mock('h3', () => ({
  defineEventHandler: <T>(h: T) => h,
  readBody: mockReadBody,
  getQuery: mockGetQuery,
  getRouterParam: mockGetRouterParam,
  setResponseStatus: vi.fn(),
}));

const mockStore = {
  getNotificationPolicy: vi.fn(),
  saveNotificationPolicy: vi.fn(),
  getReportHistory: vi.fn(),
  countReportRecords: vi.fn(),
};

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: mockStore })),
  buildAuthorizationInfo: vi.fn(() => ({
    actorId: 'test-actor',
    capability: 'observe',
    allowed: true,
  })),
  requireAuthorization: mockRequireAuthorization,
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((e, r, c, ret) => ({ code: c, message: String(e), retryable: ret })),
  okEnvelope: (r) => ({
    schemaVersion: '1',
    requestId: 'tr',
    status: 'ok',
    result: r,
    error: null,
  }),
  errorEnvelope: (c, m, authorization) => ({
    schemaVersion: '1',
    requestId: 'tr',
    status: 'error',
    authorization,
    error: { code: c, message: m, retryable: false },
  }),
}));

import policyGet from '../../server/api/notifications/policy.get';
import policyPost from '../../server/api/notifications/policy.post';
import historyGet from '../../server/api/reports/history.get';

const SAMPLE_POLICY = {
  id: 'pol_001',
  spaceId: 'space_1',
  policyKey: 'delivery',
  policyVersion: 'v1',
  policy: '{}',
  isActive: true,
  createdAt: '2026-07-27T10:00:00Z',
  updatedAt: '2026-07-27T10:00:00Z',
};

describe('GET /api/notifications/policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQuery.mockReturnValue({});
  });

  it('must return the requested notification policy for a Better Auth session without spaceId', async () => {
    mockGetQuery.mockReturnValue({ spaceId: 'space-a', policyKey: 'delivery' });
    const policy = { ...SAMPLE_POLICY, spaceId: 'space-a' };
    mockStore.getNotificationPolicy.mockResolvedValue(policy);
    const event = {
      context: {
        auth: { authenticated: true, user: { id: 'policy-admin' } },
      },
    };

    const r = await policyGet(event);

    expect(r.status).toBe('ok');
    expect(r.result).toEqual(policy);
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      event,
      'notification:admin',
      'space-a',
    );
    expect(mockStore.getNotificationPolicy).toHaveBeenCalledWith('space-a', 'delivery');
  });

  it('must deny a requested space outside the caller membership scope before store lookup', async () => {
    mockGetQuery.mockReturnValue({ spaceId: 'space-b', policyKey: 'delivery' });
    mockRequireAuthorization.mockResolvedValueOnce({
      ok: false,
      response: {
        status: 'error',
        error: { code: 'FORBIDDEN', message: 'Capability required', retryable: false },
      },
    });
    const event = {
      context: {
        auth: { authenticated: true, user: { id: 'restricted-admin' } },
      },
    };

    const r = await policyGet(event);

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('FORBIDDEN');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      event,
      'notification:admin',
      'space-b',
    );
    expect(mockStore.getNotificationPolicy).not.toHaveBeenCalled();
  });

  it('must reject missing query spaceId before authorization or policy store lookup', async () => {
    mockGetQuery.mockReturnValue({});
    const r = await policyGet({
      context: { auth: { authenticated: true, user: { id: 'policy-admin' } } },
    });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_SPACE_ID');
    expect(r.authorization).toBeNull();
    expect(mockRequireAuthorization).not.toHaveBeenCalled();
    expect(mockStore.getNotificationPolicy).not.toHaveBeenCalled();
  });

  it('must return 404 when the requested policy is not found', async () => {
    mockGetQuery.mockReturnValue({ spaceId: 'space_x' });
    mockStore.getNotificationPolicy.mockResolvedValue(null);
    const event = {
      context: {
        auth: { authenticated: true, user: { id: 'policy-admin' } },
      },
    };

    const r = await policyGet(event);

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('POLICY_NOT_FOUND');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      event,
      'notification:admin',
      'space_x',
    );
    expect(mockStore.getNotificationPolicy).toHaveBeenCalledWith('space_x', 'delivery');
  });
});

describe('POST /api/notifications/policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must save notification policy', async () => {
    mockReadBody.mockResolvedValue({
      spaceId: 'space_1',
      policyKey: 'delivery',
      policyVersion: 'v1',
      policy: { maxRetries: 3 },
    });
    mockStore.saveNotificationPolicy.mockResolvedValue(SAMPLE_POLICY);
    const r = await policyPost({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.spaceId).toBe('space_1');
  });

  it('must reject missing spaceId', async () => {
    mockReadBody.mockResolvedValue({});
    const r = await policyPost({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_SPACE_ID');
  });
});

describe('GET /api/reports/history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQuery.mockReturnValue({});
  });

  it('must return report history', async () => {
    mockStore.getReportHistory.mockResolvedValue([
      { id: 'r_001', reportType: 'spending', label: 'July Spending', isExpired: false },
    ]);
    mockStore.countReportRecords.mockResolvedValue(1);
    const r = await historyGet({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(Array.isArray(r.result.entries)).toBe(true);
    expect(r.result.total).toBe(1);
  });

  it('must apply limit and offset params', async () => {
    mockGetQuery.mockReturnValue({ limit: '10', offset: '5' });
    mockStore.getReportHistory.mockResolvedValue([]);
    mockStore.countReportRecords.mockResolvedValue(0);
    const r = await historyGet({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(mockStore.getReportHistory).toHaveBeenCalledWith(undefined, 10, 5);
  });
});
