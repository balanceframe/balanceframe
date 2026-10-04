/**
 * TDD: POST /api/notifications/acknowledge delegates to NotificationRuntime.acknowledgeFromCallback.
 * TDD: POST /api/notifications/suppress delegates to NotificationRuntime.suppress.
 *
 * Must fail if runtime is unavailable or outbox ID is invalid.
 */

import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockReadBody,
  mockSetHeader,
  mockGetWorkflowStore,
  mockGetActorId,
  mockRequireAuthorization,
  mockRequireSelectedSpace,
  mockSelectedLiquidityActor,
  mockCanReadFinancialNotification,
  mockGetNotificationPolicy,
  mockNotificationRuntime,
} = vi.hoisted(() => {
  const mockGetNotificationPolicy = vi.fn();
  return {
    mockReadBody: vi.fn(),
    mockSetHeader: vi.fn(),
    mockGetWorkflowStore: vi.fn(() => ({
      store: {
        getNotificationPolicy: mockGetNotificationPolicy,
        governance: { getPolicy: () => ({ version: 'policy-v1' }) },
      },
    })),
    mockGetActorId: vi.fn(() => 'test-actor'),
    mockRequireAuthorization: vi.fn(),
    mockRequireSelectedSpace: vi.fn(),
    mockSelectedLiquidityActor: vi.fn(),
    mockCanReadFinancialNotification: vi.fn(),
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
  setHeader: mockSetHeader,
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

vi.mock('../../server/utils/space-context', () => ({
  requireSelectedSpace: mockRequireSelectedSpace,
}));

vi.mock('../../server/utils/liquidity-service', () => ({
  selectedLiquidityActor: mockSelectedLiquidityActor,
  canReadFinancialNotification: mockCanReadFinancialNotification,
}));

vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

vi.mock('@balanceframe/application', () => ({
  NotificationRuntime: vi.fn(function () { return mockNotificationRuntime; }),
  InAppChannelAdapter: vi.fn(function () { return { channelType: 'in_app' }; }),
  createDefaultConnectionManager: vi.fn(() => ({
    loadConfig: async () => ({ budgetId: 'selected' }),
  })),
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
    headers: { 'x-balanceframe-space': spaceId },
    node: { req: { headers: { 'x-balanceframe-space': spaceId, origin: 'http://localhost:3000' } } },
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
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3000');
  mockRequireAuthorization.mockResolvedValue(authorized());
  mockGetActorId.mockReturnValue('test-actor');
  mockRequireSelectedSpace.mockImplementation(async (event: {
    context?: { auth?: { authenticated?: boolean; actorId?: string; spaceId?: string } };
  }) => {
    const auth = event.context?.auth;
    if (!auth?.authenticated || !auth.actorId) return forbidden();
    const spaceId = auth.spaceId ?? 'space-a';
    return {
      ok: true as const,
      space: { id: spaceId, budgetId: 'selected', kind: 'shared' as const },
      membership: {
        id: `membership:${auth.actorId}`,
        actorId: auth.actorId,
        spaceId,
        status: 'active' as const,
        validFrom: '2000-01-01T00:00:00.000Z',
        validUntil: null,
      },
      auth: {
        method: 'session' as const,
        actorId: auth.actorId,
        sessionId: `session:${auth.actorId}`,
      },
    };
  });
  mockSelectedLiquidityActor.mockImplementation((_store: unknown, selected: {
    auth: { actorId: string };
    space: { id: string; budgetId: string };
    membership: { id: string };
  }) => ({
    actorId: selected.auth.actorId,
    budgetId: selected.space.budgetId,
    spaceId: selected.space.id,
    membershipId: selected.membership.id,
    governancePolicyVersion: 'policy-v1',
    auth: { method: 'session', actorId: selected.auth.actorId, sessionId: `session:${selected.auth.actorId}` },
    now: new Date().toISOString(),
  }));
  mockCanReadFinancialNotification.mockResolvedValue(true);
  mockGetNotificationPolicy.mockResolvedValue({
    id: 'notification-policy',
    spaceId: 'space-a',
    policyKey: 'notification',
    policyVersion: 'v1',
    policy: {
      policyVersion: 'v1',
      eligibility: [],
      recipients: [],
      channels: [{ type: 'in_app', enabled: true }],
      redaction: {},
      maxRetries: 3,
      defaultRedactionClass: 'public',
    },
  });
  mockGetWorkflowStore.mockReturnValue({
    store: {
      getNotificationPolicy: mockGetNotificationPolicy,
      governance: { getPolicy: () => ({ version: 'policy-v1' }) },
    },
  });
});

afterEach(() => vi.unstubAllEnvs());

describe('POST /api/notifications/acknowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an anonymous request before reading credentials or touching notification state', async () => {
    mockRequireSelectedSpace.mockResolvedValueOnce(forbidden());

    const anonymous = request();
    anonymous.context.auth.authenticated = false;
    const r = await ackHandler(anonymous);

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('FORBIDDEN');
    expect(mockRequireSelectedSpace).toHaveBeenCalled();
    expect(mockRequireAuthorization).not.toHaveBeenCalled();
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
        budgetId: 'selected',
        spaceId: 'space-a',
        recipientMembershipId: 'membership:test-actor',
        recipientId: 'test-actor',
        scope: 'budget:selected',
      },
      redactedPayload: { title: 'Alert' },
      deliveryAttempts: [],
    });

    const r = await ackHandler(request());
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('acknowledged');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      'notification:receive',
      'budget:selected',
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

  it('does not let a scoped receiver acknowledge a notification for another recipient period', async () => {
    mockReadBody.mockResolvedValue({ outboxId: 'ob_admin_scoped' });
    mockNotificationRuntime.getOutboxDetail.mockResolvedValueOnce({
      outbox: { id: 'ob_admin_scoped', eventId: 'evt_admin_scoped', status: 'delivered' },
      event: {
        id: 'evt_admin_scoped',
        budgetId: 'selected',
        spaceId: 'space-a',
        recipientMembershipId: 'membership:other-actor',
        recipientId: 'other-actor',
        scope: 'budget:selected',
      },
      redactedPayload: { title: 'Scoped alert' },
      deliveryAttempts: [],
    });

    const r = await ackHandler(request('notification-admin'));

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('NOT_FOUND');
    expect(mockNotificationRuntime.acknowledgeFromCallback).not.toHaveBeenCalled();
  });

  it('must reject missing outboxId', async () => {
    mockReadBody.mockResolvedValue({});
    const r = await ackHandler(request());
    expect(r.status).toBe('error');
  });

  it('must fail when runtime throws', async () => {
    mockReadBody.mockResolvedValue({ outboxId: 'ob_001' });
    mockNotificationRuntime.getOutboxDetail.mockResolvedValueOnce({
      outbox: { id: 'ob_001', eventId: 'evt_001', status: 'delivered' },
      event: {
        id: 'evt_001',
        budgetId: 'selected',
        spaceId: 'space-a',
        recipientMembershipId: 'membership:test-actor',
        recipientId: 'test-actor',
        scope: 'budget:selected',
      },
      redactedPayload: { title: 'Alert' },
      deliveryAttempts: [],
    });
    mockNotificationRuntime.acknowledgeFromCallback.mockRejectedValue(new Error('Not found'));
    const r = await ackHandler(request());
    expect(r.status).toBe('error');
  });
});

describe('POST /api/notifications/suppress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an anonymous request before reading credentials or touching notification state', async () => {
    mockRequireSelectedSpace.mockResolvedValueOnce(forbidden());

    const anonymous = request();
    anonymous.context.auth.authenticated = false;
    const r = await suppressHandler(anonymous);

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('FORBIDDEN');
    expect(mockRequireSelectedSpace).toHaveBeenCalled();
    expect(mockRequireAuthorization).not.toHaveBeenCalled();
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
        budgetId: 'selected',
        spaceId: 'space-a',
        recipientMembershipId: 'membership:test-actor',
        recipientId: 'test-actor',
        scope: 'budget:selected',
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
      'budget:selected',
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
  it('does not let a scoped receiver suppress a notification for another recipient period', async () => {
    mockReadBody.mockResolvedValue({
      outboxId: 'ob_admin_scoped',
      reason: 'Administrative suppression',
    });
    mockNotificationRuntime.getOutboxDetail.mockResolvedValueOnce({
      outbox: { id: 'ob_admin_scoped', eventId: 'evt_admin_scoped', status: 'pending' },
      event: {
        id: 'evt_admin_scoped',
        budgetId: 'selected',
        spaceId: 'space-a',
        recipientMembershipId: 'membership:other-actor',
        recipientId: 'other-actor',
        scope: 'budget:selected',
      },
      redactedPayload: { title: 'Scoped alert' },
      deliveryAttempts: [],
    });

    const r = await suppressHandler(request('notification-admin'));

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('NOT_FOUND');
    expect(mockNotificationRuntime.suppress).not.toHaveBeenCalled();
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


  it.each([
    { reason: 'User dismissed' },
    { outboxId: 'ob_001' },
    { outboxId: 'ob_001', reason: '' },
    null,
  ])('rejects invalid suppression bodies without mutating delivery state: %j', async (body) => {
    mockReadBody.mockResolvedValue(body);
    const response = await suppressHandler(request());
    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(mockNotificationRuntime.suppress).not.toHaveBeenCalled();
  });
});

describe('GET /api/notifications/policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQuery.mockReturnValue({ spaceId: 'space-a', policyKey: 'notification' });
  });

  it('reads the notification policy only with selected-space policy management authority', async () => {
    const policy = {
      id: 'policy-space-a',
      spaceId: 'space-a',
      policyKey: 'notification',
      policyVersion: 'v2',
      policy: JSON.stringify({
        policyVersion: 'v2',
        eligibility: [],
        recipients: [],
        channels: [{ type: 'in_app', enabled: true }],
        redaction: { public: { visibleFields: ['title'] } },
        maxRetries: 3,
        defaultRedactionClass: 'public',
      }),
    };
    mockGetNotificationPolicy.mockResolvedValueOnce(policy);
    const event = request();

    const r = await policyHandler(event);

    expect(r.status).toBe('ok');
    expect(r.result).toEqual(policy);
    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      event,
      'policy:manage',
      'space:space-a',
    );
    expect(mockGetNotificationPolicy).toHaveBeenCalledWith('space-a', 'notification');
  });

  it('does not read another space named in the query', async () => {
    mockGetQuery.mockReturnValueOnce({ spaceId: 'space-b', policyKey: 'notification' });
    const event = request();

    const r = await policyHandler(event);

    expect(r.status).toBe('error');
    expect(r.result).toBeNull();
    expect(mockRequireAuthorization).not.toHaveBeenCalled();
    expect(mockGetNotificationPolicy).not.toHaveBeenCalled();
  });

  it('rejects policy keys other than the selected space notification policy', async () => {
    mockGetQuery.mockReturnValueOnce({ spaceId: 'space-a', policyKey: 'delivery' });

    const r = await policyHandler(request());

    expect(r.status).toBe('error');
    expect(mockGetNotificationPolicy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /api/notifications/status
// ---------------------------------------------------------------------------

describe('GET /api/notifications/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotificationRuntime.loadPersistedPolicy.mockResolvedValue({
      policyVersion: 'v1',
      recipients: [],
    });
  });

  it('returns error when selected-space receive authorization is denied', async () => {
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

    const r = await statusHandler(request());

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('UNAUTHORIZED');
    expect(mockGetWorkflowStore).not.toHaveBeenCalled();
  });

  it('counts status only for the current selected-space actor and original recipient membership', async () => {
    mockNotificationRuntime.getStatus.mockResolvedValue({ storeConnected: true });
    const event = request();

    const r = await statusHandler(event);

    expect(r.status).toBe('ok');
    expect(mockGetNotificationPolicy).toHaveBeenCalledWith('space-a', 'notification');
    const scope = mockNotificationRuntime.getStatus.mock.calls[0]?.[0] as {
      actorId: string;
      budgetId: string;
      canReadEvent: (event: unknown) => Promise<boolean>;
    };
    expect(scope).toMatchObject({ actorId: 'test-actor', budgetId: 'selected' });
    expect(await scope.canReadEvent({
      budgetId: 'selected',
      spaceId: 'space-a',
      recipientId: 'test-actor',
      recipientMembershipId: 'membership:test-actor',
      classification: 'budget_alert',
    })).toBe(true);
    expect(await scope.canReadEvent({
      budgetId: 'selected',
      spaceId: 'space-a',
      recipientId: 'test-actor',
      recipientMembershipId: 'membership:old-test-actor',
      classification: 'budget_alert',
    })).toBe(false);
    expect(await scope.canReadEvent({
      budgetId: 'selected',
      spaceId: 'space-b',
      recipientId: 'test-actor',
      recipientMembershipId: 'membership:test-actor',
      classification: 'budget_alert',
    })).toBe(false);
  });

  it('returns error when workflow store unavailable', async () => {
    mockGetWorkflowStore.mockReturnValueOnce({ error: 'Store not initialized' });

    const r = await statusHandler(request());

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('STORE_UNAVAILABLE');
  });

  it('returns runtime unavailable when getStatus throws', async () => {
    mockNotificationRuntime.getStatus.mockRejectedValue(new Error('Runtime crash'));

    const r = await statusHandler(request());

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
    mockGetQuery.mockReturnValue({});
  });

  it('returns inbox items for the current actor', async () => {
    mockNotificationRuntime.listOutbox.mockResolvedValue([
      {
        outbox: { id: 'obx_001', status: 'delivered' },
        event: {
          id: 'evt_001',
          budgetId: 'selected',
          spaceId: 'space-a',
          recipientId: 'test-actor',
          recipientMembershipId: 'membership:test-actor',
          classification: 'budget_alert',
        },
        redactedPayload: { title: 'Alert' },
        deliveryAttempts: [],
      },
    ]);

    const r = await inboxHandler(request());

    expect(r.status).toBe('ok');
    expect(r.result.items).toHaveLength(1);
    expect(r.result.count).toBe(1);
    const [actorId, options] = mockNotificationRuntime.listOutbox.mock.calls[0] as [
      string,
      { budgetId: string; canReadEvent: (event: unknown) => Promise<boolean> },
    ];
    expect(actorId).toBe('test-actor');
    expect(options.budgetId).toBe('selected');
    expect(await options.canReadEvent({
      budgetId: 'selected',
      spaceId: 'space-a',
      recipientId: 'test-actor',
      recipientMembershipId: 'membership:test-actor',
      classification: 'budget_alert',
    })).toBe(true);
    expect(await options.canReadEvent({
      budgetId: 'selected',
      spaceId: 'space-a',
      recipientId: 'test-actor',
      recipientMembershipId: 'membership:prior-period',
      classification: 'budget_alert',
    })).toBe(false);
    expect(await options.canReadEvent({
      budgetId: 'selected',
      spaceId: 'space-b',
      recipientId: 'test-actor',
      recipientMembershipId: 'membership:test-actor',
      classification: 'budget_alert',
    })).toBe(false);
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

    const r = await inboxHandler(request());

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
      event: {
        id: 'evt_001',
        budgetId: 'selected',
        spaceId: 'space-a',
        recipientId: 'test-actor',
        recipientMembershipId: 'membership:test-actor',
        classification: 'budget_alert',
      },
      redactedPayload: { title: 'Alert' },
      deliveryAttempts: [{ attemptNumber: 1, status: 'success' }],
    });

    const r = await detailHandler(request());

    expect(r.status).toBe('ok');
    expect(r.result.outbox.id).toBe('obx_001');
    expect(r.result.deliveryAttempts).toHaveLength(1);
  });
  it.each([
    {
      spaceId: 'space-b',
      recipientMembershipId: 'membership:test-actor',
      marker: 'foreign-space-secret',
    },
    {
      spaceId: 'space-a',
      recipientMembershipId: 'membership:prior-period',
      marker: 'prior-membership-secret',
    },
  ])('returns not found for a notification from another space or membership period', async (provenance) => {
    mockGetRouterParam.mockReturnValue('obx_private');
    mockNotificationRuntime.getOutboxDetail.mockResolvedValue({
      outbox: { id: 'obx_private', status: 'delivered' },
      event: {
        id: 'evt_private',
        budgetId: 'selected',
        spaceId: provenance.spaceId,
        recipientId: 'test-actor',
        recipientMembershipId: provenance.recipientMembershipId,
        classification: 'budget_alert',
      },
      redactedPayload: { title: provenance.marker },
      deliveryAttempts: [],
    });

    const r = await detailHandler(request());

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('NOT_FOUND');
    expect(JSON.stringify(r)).not.toContain(provenance.marker);
  });

  it('returns 404 when outbox ID is missing', async () => {
    mockGetRouterParam.mockReturnValue(null);

    const r = await detailHandler(request());

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_ID');
  });

  it('returns 404 when notification not found', async () => {
    mockGetRouterParam.mockReturnValue('nonexistent');
    mockNotificationRuntime.getOutboxDetail.mockResolvedValue(null);

    const r = await detailHandler(request());

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
    const r = await detailHandler(request());

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('UNAUTHORIZED');
  });

  it('returns error when runtime throws', async () => {
    mockGetRouterParam.mockReturnValue('obx_001');
    mockNotificationRuntime.getOutboxDetail.mockRejectedValue(new Error('Store error'));

    const r = await detailHandler(request());

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('DETAIL_UNAVAILABLE');
  });
});
