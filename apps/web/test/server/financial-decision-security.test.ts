import { beforeEach, describe, expect, it, vi } from 'vitest';

const RESTRICTED_EVIDENCE_SECRET = 'restricted-bank-secret-9f43f0';
const RAW_NOTIFICATION_SECRET = 'raw-notification-secret-6ac12e';
const CAPTURED_AT = '2026-08-23T12:00:00Z';

const {
  mockAttentionHomeAnalysis,
  mockBuildAuthorizationInfo,
  mockCreateDefaultConnectionManager,
  mockCreateNativeAnalysisProtocol,
  mockGetActorId,
  mockGetQuery,
  mockGetWorkflowStore,
  mockLoadConfig,
  mockNotificationRuntime,
  mockRequireAuthorization,
  mockRestore,
  mockSetResponseStatus,
  mockWithConnection,
} = vi.hoisted(() => {
  const mockRestore = vi.fn();
  const mockLoadConfig = vi.fn();
  const mockWithConnection = vi.fn();
  return {
    mockAttentionHomeAnalysis: vi.fn(),
    mockBuildAuthorizationInfo: vi.fn(() => ({
      actorId: 'security-actor',
      capability: 'observe',
      allowed: true,
    })),
    mockCreateDefaultConnectionManager: vi.fn(() => ({
      restore: mockRestore,
      loadConfig: mockLoadConfig,
      withConnection: mockWithConnection,
    })),
    mockCreateNativeAnalysisProtocol: vi.fn(),
    mockGetActorId: vi.fn(() => 'security-actor'),
    mockGetQuery: vi.fn(() => ({})),
    mockGetWorkflowStore: vi.fn(),
    mockLoadConfig,
    mockNotificationRuntime: {
      listOutbox: vi.fn(),
    },
    mockRequireAuthorization: vi.fn(),
    mockRestore,
    mockSetResponseStatus: vi.fn(),
    mockWithConnection,
  };
});

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getQuery: mockGetQuery,
  setResponseStatus: mockSetResponseStatus,
}));

vi.mock('@balanceframe/application', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    attentionHomeAnalysis: mockAttentionHomeAnalysis,
    createDefaultConnectionManager: mockCreateDefaultConnectionManager,
    createNativeAnalysisProtocol: mockCreateNativeAnalysisProtocol,
    NotificationRuntime: vi.fn(() => mockNotificationRuntime),
    InAppChannelAdapter: vi.fn(() => ({ channelType: 'in_app' })),
  };
});

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: mockGetWorkflowStore,
  buildAuthorizationInfo: mockBuildAuthorizationInfo,
  getActorId: mockGetActorId,
  requireAuthorization: mockRequireAuthorization,
  sanitizeError: vi.fn((_error, requestId, code, retryable) => ({
    code,
    message: 'Sanitized server error',
    retryable,
    requestId,
  })),
  envelopeMetadata: vi.fn((envelope) => ({ dataFreshness: envelope.dataFreshness ?? null })),
  okEnvelope: (result, authorization, requestId, metadata = {}) => ({
    schemaVersion: '1',
    requestId,
    status: 'ok' as const,
    dataFreshness: null,
    authorization,
    result,
    error: null,
    ...metadata,
  }),
  errorEnvelope: (code, message, authorization, retryable = false, requestId = 'request') => ({
    schemaVersion: '1',
    requestId,
    status: 'error' as const,
    dataFreshness: null,
    authorization,
    result: null,
    error: { code, message, retryable },
  }),
}));

import attentionHandler from '../../server/api/home/attention.get';
import inboxHandler from '../../server/api/notifications/inbox.get';

function event() {
  return {
    context: {
      auth: { authenticated: true, actorId: 'security-actor' },
    },
  };
}

function authorized(capability: string) {
  return {
    ok: true as const,
    info: {
      actorId: 'security-actor',
      capability,
      allowed: true,
    },
  };
}

function denied() {
  return {
    ok: false as const,
    response: {
      schemaVersion: '1',
      requestId: 'request-denied',
      status: 'error' as const,
      dataFreshness: null,
      authorization: {
        actorId: 'security-actor',
        capability: 'observe',
        allowed: false,
      },
      result: null,
      error: {
        code: 'FORBIDDEN',
        message: 'Observe capability is required for this scope.',
        retryable: false,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetQuery.mockReturnValue({});
  mockGetWorkflowStore.mockReturnValue({ store: {} });
  mockLoadConfig.mockResolvedValue({
    version: 1,
    serverUrl: 'http://actual.invalid',
    budgetId: 'budget-security',
    budgetName: 'Security budget',
    groupId: 'group-security',
  });
  mockRestore.mockResolvedValue({
    connector: { name: 'actual-security' },
    budget: { id: 'budget-security', groupId: 'group-security', name: 'Security budget' },
    synchronization: {},
  });
  mockWithConnection.mockImplementation(async (operation) =>
    operation({ connector: { name: 'actual-security' } }),
  );
  mockCreateNativeAnalysisProtocol.mockResolvedValue({ attentionHome: vi.fn() });
  mockRequireAuthorization.mockImplementation(async (_event, capability) => authorized(capability));
  mockAttentionHomeAnalysis.mockResolvedValue({
    schemaVersion: '1',
    requestId: 'request-attention',
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: {
      blockers: [],
      alerts: [],
      recurrences: [],
      categoryRisks: [],
      targetProgress: {
        overallLabel: 'healthy',
        healthyCount: 0,
        atRiskCount: 0,
        sinkingFundsOnTrack: 0,
        totalSinkingFunds: 0,
      },
    },
    error: null,
  });
});

describe('financial attention ledger authorization', () => {
  it('requires observe capability before configuration, store, connection, or ledger access', async () => {
    const request = event();
    mockRequireAuthorization.mockResolvedValueOnce(denied());

    const response = await attentionHandler(request);

    expect(mockRequireAuthorization).toHaveBeenCalledWith(request, 'observe');
    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(mockCreateDefaultConnectionManager).not.toHaveBeenCalled();
    expect(mockLoadConfig).not.toHaveBeenCalled();
    expect(mockGetWorkflowStore).not.toHaveBeenCalled();
    expect(mockWithConnection).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mockAttentionHomeAnalysis).not.toHaveBeenCalled();
  });

  it('completes the capability/scope guard before opening the existing attention ledger path', async () => {
    const request = event();

    const response = await attentionHandler(request);

    expect(response.status).toBe('ok');
    expect(mockRequireAuthorization).toHaveBeenCalledWith(request, 'observe');
    expect(mockRequireAuthorization.mock.invocationCallOrder[0]).toBeLessThan(
      mockLoadConfig.mock.invocationCallOrder[0],
    );
    expect(mockRequireAuthorization.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetWorkflowStore.mock.invocationCallOrder[0],
    );
    expect(mockRequireAuthorization.mock.invocationCallOrder[0]).toBeLessThan(
      mockWithConnection.mock.invocationCallOrder[0],
    );
  });

  it('redacts restricted canonical evidence on the server before returning the home DTO', async () => {
    mockAttentionHomeAnalysis.mockResolvedValueOnce({
      schemaVersion: '1',
      requestId: 'request-restricted',
      status: 'ok',
      dataFreshness: null,
      authorization: null,
      result: {
        blockers: [
          {
            code: 'account_freshness_coverage',
            message: 'An account source is unavailable.',
            severity: 'critical',
            classification: 'evidence_connector_degradation',
            snapshotId: 'snapshot-security',
            policyVersion: 'financial-attention-v1',
            revision: 'sha256:security-revision',
            dedupKey: 'financial-decision:restricted',
            rawEvidence: {
              providerAccessToken: RESTRICTED_EVIDENCE_SECRET,
            },
            issue: {
              code: 'account_freshness_coverage',
              severity: 'critical',
              effect: 'blocks',
              scope: { kind: 'account', id: 'account-restricted' },
              evidence: [
                {
                  evidenceId: 'restricted-reference-1',
                  kind: 'connector_error',
                  authorized: false,
                  redaction: 'redacted',
                  rawPayload: {
                    providerResponse: RESTRICTED_EVIDENCE_SECRET,
                  },
                },
              ],
              remediation: { code: 'reconnect_source', action: 'Reconnect the account source.' },
              redaction: 'redacted',
            },
          },
        ],
        alerts: [],
        recurrences: [],
        categoryRisks: [],
        targetProgress: {
          overallLabel: 'unknown',
          healthyCount: 0,
          atRiskCount: 1,
          sinkingFundsOnTrack: 0,
          totalSinkingFunds: 0,
        },
      },
      error: null,
    });

    const response = await attentionHandler(event());
    const serialized = JSON.stringify(response);
    const blocker = response.result.blockers[0];

    expect(response.status).toBe('ok');
    expect(serialized).not.toContain(RESTRICTED_EVIDENCE_SECRET);
    expect(blocker).not.toHaveProperty('rawEvidence');
    expect(blocker.issue.evidence[0]).toEqual({
      evidenceId: 'restricted-reference-1',
      kind: 'connector_error',
      authorized: false,
      redaction: 'redacted',
    });
    expect(blocker.issue.evidence[0]).not.toHaveProperty('rawPayload');
  });
});

describe('financial notification browser DTO', () => {
  it('returns redactedPayload and sanitized event metadata without the stored raw payload', async () => {
    mockNotificationRuntime.listOutbox.mockResolvedValueOnce([
      {
        outbox: {
          id: 'outbox-security',
          eventId: 'event-security',
          deliveryKey: 'delivery-security',
          channelType: 'in_app',
          status: 'delivered',
        },
        event: {
          id: 'event-security',
          eventVersion: 1,
          budgetId: 'budget-security',
          classification: 'unresolved_material_evidence',
          recipientId: 'security-actor',
          scope: 'budget:budget-security',
          redactionClass: 'restricted',
          channelConfigVersion: null,
          policyVersion: 'financial-attention-v1',
          correlationId: 'financial-decision:security',
          payload: JSON.stringify({
            title: 'Restricted finding',
            providerToken: RAW_NOTIFICATION_SECRET,
            rawEvidence: { body: RAW_NOTIFICATION_SECRET },
          }),
          createdAt: CAPTURED_AT,
        },
        redactedPayload: {
          title: 'Restricted finding',
          summary: 'Material evidence needs review.',
        },
        deliveryAttempts: [],
      },
    ]);

    const response = await inboxHandler(event());
    const serialized = JSON.stringify(response);
    const item = response.result.items[0];

    expect(mockRequireAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      'notification:receive',
    );
    expect(response.status).toBe('ok');
    expect(item.redactedPayload).toEqual({
      title: 'Restricted finding',
      summary: 'Material evidence needs review.',
    });
    expect(item.event).toEqual(
      expect.objectContaining({
        id: 'event-security',
        classification: 'unresolved_material_evidence',
        scope: 'budget:budget-security',
        policyVersion: 'financial-attention-v1',
        createdAt: CAPTURED_AT,
      }),
    );
    expect(item.event).not.toHaveProperty('payload');
    expect(serialized).not.toContain(RAW_NOTIFICATION_SECRET);
  });
});
