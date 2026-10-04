import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setResponseStatus } from 'h3';
import fixture from '../../../../protocol/fixtures/representative.json';

const {
  mockLoadConfig,
  mockWithConnection,
  mockCreateNativeAnalysisProtocol,
  mockPendingReview,
  mockPersistPendingReviewResult,
  mockGetWorkflowStore,
  mockUpdateReviewCategoryCatalog,
  mockRequireFullRead,
  mockReconcileActive,
  mockGetHumanControlAuth,
  workflowStore,
  reviewItems,
  config,
} = vi.hoisted(() => {
  const config = {
    version: 1,
    serverUrl: 'https://actual.test',
    budgetId: 'review-budget',
    budgetName: 'Review budget',
    groupId: 'review-group',
  };
  const reviewItems: Array<{ id: string; version: number; status: string }> = [];
  const workflowStore = {
    listReviewItems: vi.fn(async ({ status }: { budgetId: string; status: string }) =>
      reviewItems.filter((item) => item.status === status).map(({ id, version }) => ({ id, version })),
    ),
    transitionInternalReviewItem: vi.fn(async (id: string, input: {
      toStatus: string;
      expectedVersion: number;
    }) => {
      const item = reviewItems.find((candidate) => candidate.id === id);
      if (!item || item.version !== input.expectedVersion) throw new Error('version conflict');
      if (input.toStatus !== 'pending_review') throw new Error('invalid transition');
      item.status = input.toStatus;
      item.version += 1;
      return item;
    }),
  };
  const actorFor = (actorId: string, agent = false) => ({
    actorId,
    budgetId: config.budgetId,
    spaceId: 'selected-space',
    membershipId: 'membership-1',
    governancePolicyVersion: 'policy-1',
    auth: agent
      ? {
          method: 'api-key' as const,
          actorId,
          credentialId: 'credential-1',
          credentialOwnerId: actorId,
          principalType: 'agent' as const,
          delegationId: 'delegation-1',
          delegationVersion: '1',
        }
      : { method: 'session' as const, actorId, sessionId: 'session-1' },
    now: '2026-09-06T12:00:00.000Z',
  });
  return {
    reviewItems,
    config,
    workflowStore,
    mockLoadConfig: vi.fn(),
    mockWithConnection: vi.fn(),
    mockCreateNativeAnalysisProtocol: vi.fn(async () => ({
      pendingReview: mockPendingReview,
    })),
    mockPendingReview: vi.fn(async () => ({ candidates: [] })),
    mockPersistPendingReviewResult: vi.fn(async () => 0),
    mockGetWorkflowStore: vi.fn(() => ({ store: workflowStore })),
    mockUpdateReviewCategoryCatalog: vi.fn(),
    mockRequireFullRead: vi.fn(async (event: {
      context: { auth: { actorId: string } };
    }) => {
      const actorId = event.context.auth.actorId;
      if (actorId === 'limited-observer') {
        return {
          ok: false as const,
          response: { status: 'error', result: null, error: { code: 'FORBIDDEN' } },
        };
      }
      return {
        ok: true as const,
        info: { actorId, capability: 'full-read', allowed: true },
        budgetId: config.budgetId,
        spaceId: 'selected-space',
        actor: actorFor(actorId, actorId === 'agent-actor'),
      };
    }),
    mockReconcileActive: vi.fn(async () => {}),
    mockGetHumanControlAuth: vi.fn(async (event: {
      context: { auth: { actorId: string; method: string; sessionId?: string } };
    }) => {
      const { actorId, method, sessionId } = event.context.auth;
      return method === 'session' && sessionId
        ? {
            method: 'human-session' as const,
            actorId,
            sessionId,
            reauthenticatedAt: '2026-09-06T12:00:00.000Z',
          }
        : null;
    }),
  };
});
vi.mock('../../server/utils/reauthentication', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getHumanControlAuth: mockGetHumanControlAuth,
}));

vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({
    loadConfig: mockLoadConfig,
    withConnection: mockWithConnection,
  }),
  createNativeAnalysisProtocol: mockCreateNativeAnalysisProtocol,
  persistPendingReviewResult: mockPersistPendingReviewResult,
  createLiquidityService: async () => ({ reconcileActive: mockReconcileActive }),
}));

vi.mock('../../server/utils/workflow-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWorkflowStore: mockGetWorkflowStore,
  sanitizeError: (_error: unknown, _requestId: string, code: string, retryable = false) => ({
    code,
    message: 'Synchronization unavailable',
    retryable,
  }),
}));

vi.mock('../../server/utils/review-category-catalog', () => ({
  updateReviewCategoryCatalog: mockUpdateReviewCategoryCatalog,
}));

vi.mock('../../server/utils/legacy-financial-read', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireFullRead: mockRequireFullRead,
}));

import handler from '../../server/api/review/sync.post';

function event(actorId = 'test-actor') {
  const agent = actorId === 'agent-actor';
  return {
    node: {
      req: { headers: { origin: 'http://localhost:3000' } },
      res: { statusCode: 200, statusMessage: '', setHeader: vi.fn() },
    },
    context: {
      auth: {
        authenticated: true,
        actorId,
        method: agent ? 'api-key' : 'session',
        principalType: agent ? 'agent' : 'human',
        sessionId: agent ? undefined : 'session-1',
        user: agent ? undefined : { id: actorId },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('setResponseStatus', setResponseStatus);
  mockGetWorkflowStore.mockReturnValue({ store: workflowStore });
  mockLoadConfig.mockResolvedValue(config);
  reviewItems.splice(0);
  workflowStore.transitionInternalReviewItem.mockImplementation(async (id, input) => {
    const item = reviewItems.find((candidate) => candidate.id === id);
    if (!item || item.version !== input.expectedVersion) throw new Error('version conflict');
    if (input.toStatus !== 'pending_review') throw new Error('invalid transition');
    item.status = input.toStatus;
    item.version += 1;
    return item;
  });
  mockPendingReview.mockResolvedValue({ candidates: [] });
  mockReconcileActive.mockResolvedValue(undefined);
  mockWithConnection.mockImplementation(async (operation) =>
    operation({
      connector: { name: 'actual' },
      budget: { id: config.budgetId },
      config,
      synchronization: { snapshot: fixture },
    }),
  );
});

describe('POST /api/review/sync', () => {
  it('fails closed without restoring or persisting when the selected budget is unavailable', async () => {
    mockLoadConfig.mockResolvedValue(null);
    const request = event();
    const response = await handler(request);
    expect(request.node.res.statusCode).toBe(503);
    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(response.error?.code).toBe('not_connected');
    expect(mockWithConnection).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mockPersistPendingReviewResult).not.toHaveBeenCalled();
    expect(mockUpdateReviewCategoryCatalog).not.toHaveBeenCalled();
  });

  it('denies an observer without full-read before any ledger analysis or persistence', async () => {
    const request = event('limited-observer');
    const response = await handler(request);
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(response.result).toBeNull();
    expect(mockWithConnection).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mockPersistPendingReviewResult).not.toHaveBeenCalled();
  });

  it('cannot synchronize when authorization storage is unavailable', async () => {
    mockGetWorkflowStore.mockReturnValue({ error: 'private storage details' });
    const request = event();
    const response = await handler(request);
    expect(request.node.res.statusCode).toBe(503);
    expect(response.error?.code).toBe('STORE_UNAVAILABLE');
    expect(JSON.stringify(response)).not.toContain('private storage details');
    expect(mockWithConnection).not.toHaveBeenCalled();
    expect(mockPersistPendingReviewResult).not.toHaveBeenCalled();
  });

  it('returns a reconnectable failure when configuration disappears after authorization', async () => {
    mockWithConnection.mockRejectedValue(
      Object.assign(new Error('connection removed'), { code: 'not_connected' }),
    );
    const request = event();
    const response = await handler(request);
    expect(request.node.res.statusCode).toBe(503);
    expect(response.error?.code).toBe('not_connected');
    expect(response.error?.retryable).toBe(true);
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mockPersistPendingReviewResult).not.toHaveBeenCalled();
  });


  it('keeps an authorized read-only sync available without fresh human settlement proof', async () => {
    mockGetHumanControlAuth.mockResolvedValueOnce(null);

    const response = await handler(event());
    expect(mockReconcileActive).not.toHaveBeenCalled();
    expect(response.status).toBe('ok');
  });

  it('reports successful, conflicting and failed review transitions independently', async () => {
    reviewItems.push(
      ...['ready', 'conflict', 'invalid', 'failed'].map((id) => ({
        id,
        version: 1,
        status: 'discovered',
      })),
    );
    workflowStore.transitionInternalReviewItem.mockImplementation(async (id, input) => {
      if (id === 'conflict') throw new Error('version conflict');
      if (id === 'invalid') throw new Error('invalid transition');
      if (id === 'failed') throw new Error('private storage failure');
      const item = reviewItems.find((candidate) => candidate.id === id);
      if (!item || item.version !== input.expectedVersion) throw new Error('version conflict');
      item.status = input.toStatus;
      item.version += 1;
      return item;
    });
    const response = await handler(event());
    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({
      synchronized: true,
      transitioned: 1,
      skipped: 2,
      failed: 1,
      reasons: { version_conflict: 1, invalid_transition: 1, unknown: 1 },
    });
    expect(reviewItems).toEqual([
      { id: 'ready', version: 2, status: 'pending_review' },
      { id: 'conflict', version: 1, status: 'discovered' },
      { id: 'invalid', version: 1, status: 'discovered' },
      { id: 'failed', version: 1, status: 'discovered' },
    ]);
    expect(workflowStore.transitionInternalReviewItem).toHaveBeenCalledWith('ready', {
      toStatus: 'pending_review',
      actor: 'system',
      reason: 'Auto-transition from sync: deterministic analysis complete',
      expectedVersion: 1,
    });
    expect(JSON.stringify(response)).not.toContain('private storage failure');
  });

  it('keeps authorized review queue synchronization available to agent readers without settling transfers', async () => {
    const response = await handler(event('agent-actor'));
    expect(response.status).toBe('ok');
    expect(mockReconcileActive).not.toHaveBeenCalled();
  });

  it('sanitizes unreadable configuration without ledger access', async () => {
    mockLoadConfig.mockRejectedValue(new Error('private configuration details'));
    const response = await handler(event());
    expect(response.status).toBe('error');
    expect(JSON.stringify(response)).not.toContain('private configuration details');
    expect(mockWithConnection).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mockPersistPendingReviewResult).not.toHaveBeenCalled();
  });
});
