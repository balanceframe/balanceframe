/**
 * TDD: POST /api/notifications/acknowledge delegates to NotificationRuntime.acknowledgeFromCallback.
 * TDD: POST /api/notifications/suppress delegates to NotificationRuntime.suppress.
 *
 * Must fail if runtime is unavailable or outbox ID is invalid.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockReadBody,
  mockGetWorkflowStore,
  mockGetActorId,
  mockRequireAuthorization,
  mockGetNotificationPolicy,
  mockNotificationRuntime,
} = vi.hoisted(() => {
  const mockGetNotificationPolicy = vi.fn();
  return {
    mockReadBody: vi.fn(),
    mockGetWorkflowStore: vi.fn(() => ({
      store: {
        getNotificationPolicy: mockGetNotificationPolicy,
      },
    })),
    mockGetActorId: vi.fn(() => 'test-actor'),
    mockRequireAuthorization: vi.fn(),
    mockGetNotificationPolicy,
    mockNotificationRuntime: {
      acknowledgeFromCallback: vi.fn(),
      suppress: vi.fn(),
      getStatus: vi.fn(),
      setReAuthorizationHook: vi.fn(),
      loadPersistedPolicy: vi.fn(),
      listOutbox: vi.fn(),
      getOutboxDetail: vi.fn(),
    },
  };
});

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
  getActorId: mockGetActorId,
  sanitizeError: vi.fn((e, r, c, ret) => ({ code: c, message: String(e), retryable: ret })),
  requireAuthorization: mockRequireAuthorization,
  okEnvelope: (r, _a, _rid) => ({
    schemaVersion: '1',
    requestId: 'tr',
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: r,
    error: null,
  }),
  errorEnvelope: (c, m, authorization, _r, _rid) => ({
    schemaVersion: '1',
    requestId: 'tr',
    status: 'error',
    dataFreshness: null,
    authorization,
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
import policyHandler from '../../server/api/notifications/policy.get';

function request(actorId = 'test-actor', spaceId = 'space-a') {
  return {
    context: {
      auth: { authenticated: true, actorId, spaceId },
    },
  };
}

function authorized(actorId = 'test-actor', capability = 'notification:receive') {
  return {
    ok: true as const,
    info: { actorId, capability, allowed: true },
  };
}

function forbidden() {
  return {
    ok: false as const,
    response: {
      status: 'error',
      error: {
        code: 'FORBIDDEN',
        message: 'Capability required',
        retryable: false,
      },
    },
  };
}

beforeEach(() => {
  mockRequireAuthorization.mockResolvedValue(authorized());
  mockGetActorId.mockReturnValue('test-actor');
  mockGetWorkflowStore.mockReturnValue({
    store: {
      getNotificationPolicy: mockGetNotificationPolicy,
    },
  });
});

describe('POST /api/notifications/acknowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an anonymous request before reading its body or touching the store', async () => {
    mockRequireAuthorization.mockResolvedValueOnce(forbidden());

    const r = await ackHandler({ context: { auth: { authenticated: false } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('FORBIDDEN');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      'notification:receive',
    );
    expect(mockReadBody).not.toHaveBeenCalled();
    expect(mockGetWorkflowStore).not.toHaveBeenCalled();
    expect(mockNotificationRuntime.acknowledgeFromCallback).not.toHaveBeenCalled();
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
    mockNotificationRuntime.getOutboxDetail.mockResolvedValueOnce({
      outbox: { id: 'ob_delivered_001', eventId: 'evt_001', status: 'delivered' },
      event: {
        id: 'evt_001',
        recipientId: 'test-actor',
        scope: 'budget:budget-owner',
      },
      redactedPayload: { title: 'Alert' },
      deliveryAttempts: [],
    });

    const r = await ackHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('acknowledged');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      'notification:receive',
    );
    expect(mockNotificationRuntime.getOutboxDetail).toHaveBeenCalledWith(
      'ob_delivered_001',
      'test-actor',
    );
    expect(mockNotificationRuntime.acknowledgeFromCallback).toHaveBeenCalledWith(
      'ob_delivered_001',
      { outboxId: 'ob_delivered_001' },
    );
  });

  it('denies an authenticated actor from acknowledging another recipient notification', async () => {
    mockReadBody.mockResolvedValue({ outboxId: 'ob_other_recipient' });
    mockRequireAuthorization.mockResolvedValueOnce(authorized('test-actor'));
    mockNotificationRuntime.getOutboxDetail.mockResolvedValueOnce(null);
    mockNotificationRuntime.acknowledgeFromCallback.mockResolvedValue({
      id: 'ob_other_recipient',
      status: 'acknowledged',
    });

    const r = await ackHandler(request());

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('NOT_FOUND');
    expect(mockNotificationRuntime.acknowledgeFromCallback).not.toHaveBeenCalled();
  });

  it('allows a scoped administrator to acknowledge another recipient notification', async () => {
    mockReadBody.mockResolvedValue({ outboxId: 'ob_admin_scoped' });
    mockGetActorId.mockReturnValue('notification-admin');
    mockRequireAuthorization.mockImplementation(
      async (_event: unknown, capability: string, scope?: string) => {
        if (capability === 'notification:receive') {
          return authorized('notification-admin', capability);
        }
        if (capability === 'notification:admin' && scope === 'budget:budget-owner') {
          return authorized('notification-admin', capability);
        }
        return forbidden();
      },
    );
    mockNotificationRuntime.getOutboxDetail.mockResolvedValueOnce({
      outbox: { id: 'ob_admin_scoped', eventId: 'evt_admin_scoped', status: 'delivered' },
      event: {
        id: 'evt_admin_scoped',
        recipientId: 'other-actor',
        scope: 'budget:budget-owner',
      },
      redactedPayload: { title: 'Scoped alert' },
      deliveryAttempts: [],
    });
    mockNotificationRuntime.acknowledgeFromCallback.mockResolvedValue({
      id: 'ob_admin_scoped',
      status: 'acknowledged',
    });

    const r = await ackHandler(request('notification-admin'));

    expect(r.status).toBe('ok');
    expect(mockRequireAuthorization).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'notification:admin',
      'budget:budget-owner',
    );
    expect(mockNotificationRuntime.acknowledgeFromCallback).toHaveBeenCalledTimes(1);
  });

  it('must reject missing outboxId', async () => {
    mockReadBody.mockResolvedValue({});
    const r = await ackHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
  });

  it('must fail when runtime throws', async () => {
    mockReadBody.mockResolvedValue({ outboxId: 'ob_001' });
    mockNotificationRuntime.getOutboxDetail.mockResolvedValueOnce({
      outbox: { id: 'ob_001', eventId: 'evt_001', status: 'delivered' },
      event: {
        id: 'evt_001',
        recipientId: 'test-actor',
        scope: 'budget:budget-owner',
      },
      redactedPayload: { title: 'Alert' },
      deliveryAttempts: [],
    });
    mockNotificationRuntime.acknowledgeFromCallback.mockRejectedValue(new Error('Not found'));
    const r = await ackHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
  });
});

describe('POST /api/notifications/suppress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an anonymous request before reading its body or touching the store', async () => {
    mockRequireAuthorization.mockResolvedValueOnce(forbidden());

    const r = await suppressHandler({ context: { auth: { authenticated: false } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('FORBIDDEN');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      'notification:receive',
    );
    expect(mockReadBody).not.toHaveBeenCalled();
    expect(mockGetWorkflowStore).not.toHaveBeenCalled();
    expect(mockNotificationRuntime.suppress).not.toHaveBeenCalled();
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
    mockNotificationRuntime.getOutboxDetail.mockResolvedValueOnce({
      outbox: { id: 'ob_pending_001', eventId: 'evt_001', status: 'pending' },
      event: {
        id: 'evt_001',
        recipientId: 'test-actor',
        scope: 'budget:budget-owner',
      },
      redactedPayload: { title: 'Alert' },
      deliveryAttempts: [],
    });

    const r = await suppressHandler(request());
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('suppressed');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      'notification:receive',
    );
    expect(mockNotificationRuntime.getOutboxDetail).toHaveBeenCalledWith(
      'ob_pending_001',
      'test-actor',
    );
    expect(mockNotificationRuntime.suppress).toHaveBeenCalledWith(
      'ob_pending_001',
      'User dismissed',
    );
  });

  it('denies an authenticated actor from suppressing another recipient notification', async () => {
    mockReadBody.mockResolvedValue({
      outboxId: 'ob_other_recipient',
      reason: 'Dismiss another actor alert',
    });
    mockRequireAuthorization.mockResolvedValueOnce(authorized('test-actor'));
    mockNotificationRuntime.getOutboxDetail.mockResolvedValueOnce(null);
    mockNotificationRuntime.suppress.mockResolvedValue({
      id: 'ob_other_recipient',
      status: 'suppressed',
    });

    const r = await suppressHandler(request());

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('NOT_FOUND');
    expect(mockNotificationRuntime.suppress).not.toHaveBeenCalled();
  });

  it('allows a scoped administrator to suppress another recipient notification', async () => {
    mockReadBody.mockResolvedValue({
      outboxId: 'ob_admin_scoped',
      reason: 'Administrative suppression',
    });
    mockGetActorId.mockReturnValue('notification-admin');
    mockRequireAuthorization.mockImplementation(
      async (_event: unknown, capability: string, scope?: string) => {
        if (capability === 'notification:receive') {
          return authorized('notification-admin', capability);
        }
        if (capability === 'notification:admin' && scope === 'budget:budget-owner') {
          return authorized('notification-admin', capability);
        }
        return forbidden();
      },
    );
    mockNotificationRuntime.getOutboxDetail.mockResolvedValueOnce({
      outbox: { id: 'ob_admin_scoped', eventId: 'evt_admin_scoped', status: 'pending' },
      event: {
        id: 'evt_admin_scoped',
        recipientId: 'other-actor',
        scope: 'budget:budget-owner',
      },
      redactedPayload: { title: 'Scoped alert' },
      deliveryAttempts: [],
    });
    mockNotificationRuntime.suppress.mockResolvedValue({
      id: 'ob_admin_scoped',
      status: 'suppressed',
    });

    const r = await suppressHandler(request('notification-admin'));

    expect(r.status).toBe('ok');
    expect(mockRequireAuthorization).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'notification:admin',
      'budget:budget-owner',
    );
    expect(mockNotificationRuntime.suppress).toHaveBeenCalledWith(
      'ob_admin_scoped',
      'Administrative suppression',
    );
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

describe('GET /api/notifications/policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQuery.mockReturnValue({ spaceId: 'space-a', policyKey: 'delivery' });
  });

  it('denies a policy read outside the caller membership scope before store lookup', async () => {
    mockGetQuery.mockReturnValueOnce({ spaceId: 'space-b', policyKey: 'delivery' });
    mockRequireAuthorization.mockImplementationOnce(
      async (_event: unknown, _capability: string, scope?: string) =>
        scope === 'space-a'
          ? authorized('restricted-admin', 'notification:admin')
          : forbidden(),
    );
    const event = {
      context: {
        auth: { authenticated: true, user: { id: 'restricted-admin' } },
      },
    };

    const r = await policyHandler(event);

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('FORBIDDEN');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      event,
      'notification:admin',
      'space-b',
    );
    expect(mockGetWorkflowStore).not.toHaveBeenCalled();
    expect(mockGetNotificationPolicy).not.toHaveBeenCalled();
  });

  it('reads the requested policy for a scoped Better Auth session without auth spaceId', async () => {
    const policy = {
      id: 'policy-space-a',
      spaceId: 'space-a',
      policyKey: 'delivery',
      policyVersion: 'v2',
      policy: JSON.stringify(defaultPersistedPolicy),
    };
    mockGetActorId.mockReturnValue('policy-admin');
    mockRequireAuthorization.mockImplementationOnce(
      async (_event: unknown, _capability: string, scope?: string) =>
        scope === 'space-a'
          ? authorized('policy-admin', 'notification:admin')
          : forbidden(),
    );
    mockGetNotificationPolicy.mockResolvedValueOnce(policy);
    const event = {
      context: {
        auth: { authenticated: true, user: { id: 'policy-admin' } },
      },
    };

    const r = await policyHandler(event);

    expect(r.status).toBe('ok');
    expect(r.result).toEqual(policy);
    expect(mockRequireAuthorization).toHaveBeenCalledWith(event, 'notification:admin', 'space-a');
    expect(mockGetNotificationPolicy).toHaveBeenCalledWith('space-a', 'delivery');
  });

  it('returns MISSING_SPACE_ID before authorization or store lookup when spaceId is omitted', async () => {
    mockGetQuery.mockReturnValueOnce({ policyKey: 'delivery' });
    const event = {
      context: {
        auth: { authenticated: true, user: { id: 'policy-admin' } },
      },
    };

    const r = await policyHandler(event);

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_SPACE_ID');
    expect(r.authorization).toBeNull();
    expect(mockRequireAuthorization).not.toHaveBeenCalled();
    expect(mockGetWorkflowStore).not.toHaveBeenCalled();
    expect(mockGetNotificationPolicy).not.toHaveBeenCalled();
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
