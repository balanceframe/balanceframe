import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setResponseStatus } from 'h3';

const {
  mockLoadConfig,
  mockWithConnection,
  mockCreateNativeAnalysisProtocol,
  mockPersistPendingReviewResult,
  mockGetWorkflowStore,
  mockUpdateReviewCategoryCatalog,
  workflowStore,
  config,
} = vi.hoisted(() => {
  const config = {
    version: 1,
    serverUrl: 'https://actual.test',
    budgetId: 'review-budget',
    budgetName: 'Review budget',
    groupId: 'review-group',
  };
  const workflowStore = {
    liquidity: {
      isOwner: vi.fn(
        ({ actorId, budgetId }) => actorId === 'test-actor' && budgetId === config.budgetId,
      ),
      isAuthorized: vi.fn(() => false),
    },
    evaluateAuthorization: vi.fn(async () => ({ allowed: false })),
    listReviewItems: vi.fn(async (): Promise<Array<{ id: string; version: number }>> => []),
    transitionReviewItem: vi.fn(async (_id: string) => {}),
  };
  return {
    config,
    workflowStore,
    mockLoadConfig: vi.fn(),
    mockWithConnection: vi.fn(),
    mockCreateNativeAnalysisProtocol: vi.fn(async () => ({
      pendingReview: async () => ({ candidates: [] }),
    })),
    mockPersistPendingReviewResult: vi.fn(async () => 0),
    mockGetWorkflowStore: vi.fn(() => ({ store: workflowStore })),
    mockUpdateReviewCategoryCatalog: vi.fn(),
  };
});

vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDefaultConnectionManager: () => ({
    loadConfig: mockLoadConfig,
    withConnection: mockWithConnection,
  }),
  createNativeAnalysisProtocol: mockCreateNativeAnalysisProtocol,
  persistPendingReviewResult: mockPersistPendingReviewResult,
  createLiquidityService: async () => ({ reconcileActive: async () => [] }),
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

import handler from '../../server/api/review/sync.post';

function event(actorId = 'test-actor') {
  return {
    node: { res: { statusCode: 200, statusMessage: '' } },
    context: { auth: { authenticated: true, actorId } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('setResponseStatus', setResponseStatus);
  mockGetWorkflowStore.mockReturnValue({ store: workflowStore });
  mockLoadConfig.mockResolvedValue(config);
  workflowStore.liquidity.isOwner.mockImplementation(
    ({ actorId, budgetId }) => actorId === 'test-actor' && budgetId === config.budgetId,
  );
  workflowStore.evaluateAuthorization.mockResolvedValue({ allowed: false });
  workflowStore.liquidity.isAuthorized.mockReturnValue(false);
  workflowStore.listReviewItems.mockResolvedValue([]);
  workflowStore.transitionReviewItem.mockResolvedValue(undefined);
  mockWithConnection.mockImplementation(async (operation) =>
    operation({
      connector: { name: 'actual' },
      budget: { id: config.budgetId },
      config,
      synchronization: { snapshot: { categories: [] } },
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
    expect(response.error?.code).toBe('FINANCIAL_READ_UNAVAILABLE');
    expect(mockWithConnection).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mockPersistPendingReviewResult).not.toHaveBeenCalled();
    expect(mockUpdateReviewCategoryCatalog).not.toHaveBeenCalled();
  });

  it('denies an observer without full-read before any ledger analysis or persistence', async () => {
    workflowStore.evaluateAuthorization.mockResolvedValue({ allowed: true });
    const request = event('limited-observer');
    const response = await handler(request);
    expect(request.node.res.statusCode).toBe(403);
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
    expect(response.error?.code).toBe('FINANCIAL_READ_UNAVAILABLE');
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

  it('reports successful, conflicting and failed review transitions independently', async () => {
    workflowStore.listReviewItems.mockResolvedValue(
      ['ready', 'conflict', 'invalid', 'failed'].map((id) => ({ id, version: 1 })),
    );
    workflowStore.transitionReviewItem.mockImplementation(async (id) => {
      if (id === 'conflict') throw new Error('version conflict');
      if (id === 'invalid') throw new Error('invalid transition');
      if (id === 'failed') throw new Error('private storage failure');
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
    expect(JSON.stringify(response)).not.toContain('private storage failure');
  });

  it('sanitizes unreadable configuration without ledger access', async () => {
    mockLoadConfig.mockRejectedValue(new Error('private configuration details'));
    const request = event();
    const response = await handler(request);
    expect(request.node.res.statusCode).toBe(503);
    expect(response.error?.code).toBe('FINANCIAL_READ_UNAVAILABLE');
    expect(JSON.stringify(response)).not.toContain('private configuration details');
    expect(mockWithConnection).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mockPersistPendingReviewResult).not.toHaveBeenCalled();
  });
});
