/**
 * TDD: POST /api/notifications/acknowledge delegates to NotificationRuntime.acknowledgeFromCallback.
 * TDD: POST /api/notifications/suppress delegates to NotificationRuntime.suppress.
 *
 * Must fail if runtime is unavailable or outbox ID is invalid.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReadBody, mockGetWorkflowStore, mockNotificationRuntime } = vi.hoisted(() => ({
  mockReadBody: vi.fn(),
  mockGetWorkflowStore: vi.fn(() => ({ store: {} })),
  mockNotificationRuntime: {
    acknowledgeFromCallback: vi.fn(),
    suppress: vi.fn(),
    getStatus: vi.fn(),
    setReAuthorizationHook: vi.fn(),
    loadPersistedPolicy: vi.fn(),
    listOutbox: vi.fn(),
    getOutboxDetail: vi.fn(),
  },
}));

const { mockGetRouterParam, mockGetQuery } = vi.hoisted(() => ({
  mockGetRouterParam: vi.fn(),
  mockGetQuery: vi.fn(() => ({})),
}));

vi.mock('h3', () => ({
  defineEventHandler: <T>(h: T) => h,
  readBody: mockReadBody,
  setResponseStatus: vi.fn(),
  getRouterParam: mockGetRouterParam,
  getQuery: mockGetQuery,
}));

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: mockGetWorkflowStore,
  buildAuthorizationInfo: vi.fn(() => ({
    actorId: 'test-actor',
    capability: 'observe',
    allowed: true,
  })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((e, r, c, ret) => ({ code: c, message: String(e), retryable: ret })),
  requireAuthorization: vi.fn(async () => ({
    ok: true,
    info: { actorId: 'test-actor', capability: 'notification:receive', allowed: true },
    response: null,
  })),
  okEnvelope: (r, _a, _rid) => ({
    schemaVersion: '1',
    requestId: 'tr',
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: r,
    error: null,
  }),
  errorEnvelope: (c, m, _a, _r, _rid) => ({
    schemaVersion: '1',
    requestId: 'tr',
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code: c, message: m, retryable: false },
  }),
}));

vi.mock('@balanceframe/application', () => ({
  NotificationRuntime: vi.fn(() => mockNotificationRuntime),
  InAppChannelAdapter: vi.fn(() => ({ channelType: 'in_app' })),
}));

import ackHandler from '../../server/api/notifications/acknowledge.post';
import suppressHandler from '../../server/api/notifications/suppress.post';
import statusHandler from '../../server/api/notifications/status.get';
import inboxHandler from '../../server/api/notifications/inbox.get';
import detailHandler from '../../server/api/notifications/[id].get';

describe('POST /api/notifications/acknowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must acknowledge a delivered notification', async () => {
    mockReadBody.mockResolvedValue({ outboxId: 'ob_delivered_001' });
    mockNotificationRuntime.acknowledgeFromCallback.mockResolvedValue({
      id: 'ob_delivered_001',
      eventId: 'evt_001',
      channelType: 'in_app',
      status: 'acknowledged',
      deliveryKey: 'dk_001',
      attemptCount: 1,
      maxAttempts: 3,
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: null,
      createdAt: '2026-07-27T10:00:00Z',
      updatedAt: '2026-07-27T10:00:05Z',
    });

    const r = await ackHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('acknowledged');
  });

  it('must reject missing outboxId', async () => {
    mockReadBody.mockResolvedValue({});
    const r = await ackHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
  });

  it('must fail when runtime throws', async () => {
    mockReadBody.mockResolvedValue({ outboxId: 'ob_001' });
    mockNotificationRuntime.acknowledgeFromCallback.mockRejectedValue(new Error('Not found'));
    const r = await ackHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
  });
});

describe('POST /api/notifications/suppress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must suppress a notification with reason', async () => {
    mockReadBody.mockResolvedValue({ outboxId: 'ob_pending_001', reason: 'User dismissed' });
    mockNotificationRuntime.suppress.mockResolvedValue({
      id: 'ob_pending_001',
      eventId: 'evt_001',
      channelType: 'in_app',
      status: 'suppressed',
      deliveryKey: 'dk_001',
      attemptCount: 0,
      maxAttempts: 3,
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: null,
      createdAt: '2026-07-27T10:00:00Z',
      updatedAt: '2026-07-27T10:00:05Z',
    });

    const r = await suppressHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('suppressed');
  });

  it('must reject missing outboxId', async () => {
    mockReadBody.mockResolvedValue({ reason: 'User dismissed' });
    const r = await suppressHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_OUTBOX_ID');
  });

  it('must reject missing reason', async () => {
    mockReadBody.mockResolvedValue({ outboxId: 'ob_001' });
    const r = await suppressHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_REASON');
  });
});

// ---------------------------------------------------------------------------
// GET /api/notifications/status
// ---------------------------------------------------------------------------

const defaultPersistedPolicy = {
  policyVersion: 'v1',
  eligibility: [],
  recipients: [{ actorId: 'usr_a', channels: ['in_app'], quietHours: null }],
  channels: [{ type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' }],
  redaction: {
    sensitive: { visibleFields: ['title'] },
    public: { visibleFields: ['title', 'summary'] },
    restricted: { visibleFields: ['title'] },
  },
  maxRetries: 3,
  defaultRedactionClass: 'public',
};

describe('GET /api/notifications/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotificationRuntime.loadPersistedPolicy.mockResolvedValue(defaultPersistedPolicy);
  });

  it('returns runtime status with policy version and recipient count', async () => {
    mockNotificationRuntime.getStatus.mockResolvedValue({
      healthy: true,
      storeConnected: true,
      channelStatuses: [{ channel: 'in_app', healthy: true }],
      pendingCount: 0,
      failedCount: 0,
      disabledChannels: [],
      outageChannels: [],
    });
    mockNotificationRuntime.loadPersistedPolicy.mockResolvedValue({
      ...defaultPersistedPolicy,
      policyVersion: 'v2',
      recipients: [
        { actorId: 'usr_a', channels: ['in_app'], quietHours: null },
        { actorId: 'usr_b', channels: ['in_app'], quietHours: null },
      ],
    });

    const r = await statusHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('ok');
    expect(r.result.healthy).toBe(true);
    expect(r.result.policyVersion).toBe('v2');
    expect(r.result.recipientCount).toBe(2);
    // Verify loadPersistedPolicy was called with the space id
    expect(mockNotificationRuntime.loadPersistedPolicy).toHaveBeenCalledWith('default');
  });

  it('returns error when authorization denied', async () => {
    const { requireAuthorization } = await vi.importMock('../../server/utils/workflow-store');
    vi.mocked(requireAuthorization).mockResolvedValueOnce({
      ok: false,
      info: null,
      response: {
        status: 'error',
        error: {
          code: 'UNAUTHORIZED',
          message: 'Capability required: notification:receive',
          retryable: false,
        },
      },
    });

    const r = await statusHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('UNAUTHORIZED');
  });

  it('returns error when workflow store unavailable', async () => {
    mockGetWorkflowStore.mockReturnValueOnce({ error: 'Store not initialized' });

    const r = await statusHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('STORE_UNAVAILABLE');
  });

  it('reports unhealthy runtime when adapter is in outage', async () => {
    mockNotificationRuntime.getStatus.mockResolvedValue({
      healthy: false,
      storeConnected: true,
      channelStatuses: [{ channel: 'in_app', healthy: false }],
      pendingCount: 5,
      failedCount: 2,
      disabledChannels: [],
      outageChannels: ['in_app'],
    });

    const r = await statusHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('ok');
    expect(r.result.healthy).toBe(false);
    expect(r.result.channelStatuses[0].healthy).toBe(false);
    expect(r.result.pendingCount).toBe(5);
    expect(r.result.failedCount).toBe(2);
    expect(r.result.outageChannels).toEqual(['in_app']);
  });

  it('reports all channels disabled in persisted policy', async () => {
    mockNotificationRuntime.getStatus.mockResolvedValue({
      healthy: true,
      storeConnected: true,
      channelStatuses: [{ channel: 'in_app', healthy: true }],
      pendingCount: 0,
      failedCount: 0,
      disabledChannels: ['in_app'],
      outageChannels: [],
    });
    mockNotificationRuntime.loadPersistedPolicy.mockResolvedValue({
      ...defaultPersistedPolicy,
      channels: [{ type: 'in_app', enabled: false, rateLimitPerMinute: 60, displayName: 'In-App' }],
    });

    const r = await statusHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('ok');
    expect(r.result.healthy).toBe(true);
    expect(r.result.disabledChannels).toEqual(['in_app']);
  });

  it('falls back to default policy version when loadPersistedPolicy fails', async () => {
    mockNotificationRuntime.getStatus.mockResolvedValue({
      healthy: true,
      storeConnected: true,
      channelStatuses: [{ channel: 'in_app', healthy: true }],
      pendingCount: 0,
      failedCount: 0,
      disabledChannels: [],
      outageChannels: [],
    });
    // First call (version) fails, second call (recipients) succeeds
    mockNotificationRuntime.loadPersistedPolicy
      .mockRejectedValueOnce(new Error('Store read error'))
      .mockResolvedValueOnce({ ...defaultPersistedPolicy, recipients: [] });

    const r = await statusHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('ok');
    // Falls back to default version 'v1' when store lookup fails
    expect(r.result.policyVersion).toBe('v1');
    expect(r.result.recipientCount).toBe(0);
  });

  it('returns runtime unavailable when getStatus throws', async () => {
    mockNotificationRuntime.getStatus.mockRejectedValue(new Error('Runtime crash'));

    const r = await statusHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('RUNTIME_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// GET /api/notifications/inbox
// ---------------------------------------------------------------------------

describe('GET /api/notifications/inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns inbox items for the current actor', async () => {
    mockNotificationRuntime.listOutbox.mockResolvedValue([
      {
        outbox: { id: 'obx_001', status: 'delivered' },
        event: { id: 'evt_001', classification: 'budget_alert' },
        redactedPayload: { title: 'Alert' },
        deliveryAttempts: [],
      },
    ]);

    const r = await inboxHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('ok');
    expect(r.result.items).toHaveLength(1);
    expect(r.result.count).toBe(1);
  });

  it('passes query filters to the runtime', async () => {
    mockGetQuery.mockReturnValueOnce({
      status: 'delivered',
      channel: 'in_app',
      limit: '10',
      offset: '0',
    });
    mockNotificationRuntime.listOutbox.mockResolvedValue([]);

    await inboxHandler({ context: { auth: { authenticated: true } } });

    expect(mockNotificationRuntime.listOutbox).toHaveBeenCalledWith('test-actor', {
      status: 'delivered',
      channelType: 'in_app',
      limit: 10,
      offset: 0,
    });
  });

  it('rejects unknown status filter gracefully', async () => {
    mockGetQuery.mockReturnValueOnce({ status: 'bogus_status' });
    mockNotificationRuntime.listOutbox.mockResolvedValue([]);

    const r = await inboxHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('ok');
    expect(mockNotificationRuntime.listOutbox).toHaveBeenCalledWith('test-actor', {
      status: undefined,
      channelType: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('returns error when authorization denied', async () => {
    const { requireAuthorization } = await vi.importMock('../../server/utils/workflow-store');
    vi.mocked(requireAuthorization).mockResolvedValueOnce({
      ok: false,
      info: null,
      response: {
        status: 'error',
        error: { code: 'UNAUTHORIZED', message: 'Capability required', retryable: false },
      },
    });

    const r = await inboxHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// GET /api/notifications/:id
// ---------------------------------------------------------------------------

describe('GET /api/notifications/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns notification detail when it exists', async () => {
    mockGetRouterParam.mockReturnValue('obx_001');
    mockNotificationRuntime.getOutboxDetail.mockResolvedValue({
      outbox: { id: 'obx_001', status: 'delivered' },
      event: { id: 'evt_001', classification: 'budget_alert' },
      redactedPayload: { title: 'Alert' },
      deliveryAttempts: [{ attemptNumber: 1, status: 'success' }],
    });

    const r = await detailHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('ok');
    expect(r.result.outbox.id).toBe('obx_001');
    expect(r.result.deliveryAttempts).toHaveLength(1);
  });

  it('returns 404 when outbox ID is missing', async () => {
    mockGetRouterParam.mockReturnValue(null);

    const r = await detailHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_ID');
  });

  it('returns 404 when notification not found', async () => {
    mockGetRouterParam.mockReturnValue('nonexistent');
    mockNotificationRuntime.getOutboxDetail.mockResolvedValue(null);

    const r = await detailHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('returns error when authorization denied', async () => {
    const { requireAuthorization } = await vi.importMock('../../server/utils/workflow-store');
    vi.mocked(requireAuthorization).mockResolvedValueOnce({
      ok: false,
      info: null,
      response: {
        status: 'error',
        error: { code: 'UNAUTHORIZED', message: 'Capability required', retryable: false },
      },
    });

    mockGetRouterParam.mockReturnValue('obx_001');
    const r = await detailHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('UNAUTHORIZED');
  });

  it('returns error when runtime throws', async () => {
    mockGetRouterParam.mockReturnValue('obx_001');
    mockNotificationRuntime.getOutboxDetail.mockRejectedValue(new Error('Store error'));

    const r = await detailHandler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('DETAIL_UNAVAILABLE');
  });
});
