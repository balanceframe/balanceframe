/**
 * POST /api/review/sync — delegates through ConnectionManager.withConnection()
 * and persists deterministic review candidates.
 *
 * TDD: a missing selected budget must return `not_connected` before touching
 * the Actual connector or native analysis; a configured budget preserves the
 * existing synchronize → analyze → persist → transition path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRestore,
  mockWithConnection,
  mockLoadConfig,
  mockCreateDefaultConnectionManager,
  mockCreateNativeAnalysisProtocol,
  mockPersistPendingReviewResult,
  mockListReviewItems,
  mockTransitionReviewItem,
  mockUpdateReviewCategoryCatalog,
  mockConnectionOperationCompleted,
  mockSetResponseStatus,
  mockGetWorkflowStore,
  pendingReview,
  restoredConnector,
  restoredBudget,
  pendingReviewResult,
  workflowStore,
  loadedConnectionConfig,
  connectedConfig,
  connectedSynchronization,
} = vi.hoisted(() => {
  const restoredConnector = { name: 'restored-connector' };
  const restoredBudget = {
    id: 'restored-budget-id',
    groupId: 'restored-group-id',
    name: 'Restored budget',
    encrypted: false,
  };
  const pendingReviewResult = { candidates: [] };
  const pendingReview = vi.fn().mockResolvedValue(pendingReviewResult);
  const workflowStore = {
    listReviewItems: vi.fn(async () => []),
    transitionReviewItem: vi.fn(async () => {}),
  };
  const mockRestore = vi.fn();
  const mockWithConnection = vi.fn();
  const loadedConnectionConfig = {
    version: 1,
    serverUrl: 'x',
    budgetId: restoredBudget.id,
    budgetName: restoredBudget.name,
    groupId: restoredBudget.groupId,
  };
  const connectedConfig = {
    version: 1,
    serverUrl: 'https://selected.actual.test',
    budgetId: restoredBudget.id,
    budgetName: restoredBudget.name,
    groupId: restoredBudget.groupId,
  };
  const connectedSynchronization = {
    snapshot: {
      categories: [
        {
          id: 'category-1',
          name: 'Groceries',
          groupName: 'Living',
          isIncome: false,
          deleted: false,
        },
      ],
    },
  };
  const mockUpdateReviewCategoryCatalog = vi.fn<
    (
      config: typeof loadedConnectionConfig,
      synchronization: typeof connectedSynchronization,
    ) => void
  >();
  const mockConnectionOperationCompleted = vi.fn<() => void>();
  const mockLoadConfig = vi.fn();
  return {
    mockRestore,
    mockWithConnection,
    mockLoadConfig,
    mockUpdateReviewCategoryCatalog,
    mockConnectionOperationCompleted,
    mockCreateDefaultConnectionManager: vi.fn(() => ({
      restore: mockRestore,
      withConnection: mockWithConnection,
      loadConfig: mockLoadConfig,
    })),
    mockCreateNativeAnalysisProtocol: vi.fn(async () => ({ pendingReview })),
    mockPersistPendingReviewResult: vi.fn(async () => 2),
    mockListReviewItems: workflowStore.listReviewItems,
    mockTransitionReviewItem: workflowStore.transitionReviewItem,
    mockSetResponseStatus: vi.fn(),
    mockGetWorkflowStore: vi.fn(() => ({ store: workflowStore })),
    pendingReview,
    restoredConnector,
    restoredBudget,
    pendingReviewResult,
    workflowStore,
    loadedConnectionConfig,
    connectedConfig,
    connectedSynchronization,
  };
});

vi.mock('@balanceframe/application', async (i) => {
  const a = await i();
  return {
    ...a,
    createDefaultConnectionManager: mockCreateDefaultConnectionManager,
    createNativeAnalysisProtocol: mockCreateNativeAnalysisProtocol,
    persistPendingReviewResult: mockPersistPendingReviewResult,
  };
});

vi.mock('../../server/utils/workflow-store', async (i) => {
  const a = await i();
  return {
    ...a,
    getWorkflowStore: mockGetWorkflowStore,
    buildAuthorizationInfo: vi.fn(() => ({
      actorId: 'test-actor',
      capability: 'observe',
      allowed: true,
    })),
    sanitizeError: (error: unknown, _requestId: string, code: string, retryable = false) => ({
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable,
    }),
  };
});

vi.mock('../../server/utils/review-category-catalog', () => ({
  updateReviewCategoryCatalog: mockUpdateReviewCategoryCatalog,
}));

import handler from '../../server/api/review/sync.post';

describe('POST /api/review/sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('setResponseStatus', mockSetResponseStatus);
    mockGetWorkflowStore.mockReturnValue({ store: workflowStore });
    mockLoadConfig.mockResolvedValue(loadedConnectionConfig);
    mockRestore.mockResolvedValue({
      connector: restoredConnector,
      budget: restoredBudget,
      config: connectedConfig,
      synchronization: connectedSynchronization,
    });
    mockWithConnection.mockImplementation(
      async (operation: (connected: unknown) => Promise<unknown>) => {
        const result = await operation(await mockRestore());
        mockConnectionOperationCompleted();
        return result;
      },
    );
  });

  it('must return not_connected when no budget is configured without restoring', async () => {
    mockLoadConfig.mockResolvedValue(null);
    const r = await handler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('not_connected');
    expect(r.error?.message).toBe('No ledger connected. Configure an Actual budget first.');
    expect(r.error?.retryable).toBe(true);
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mockPersistPendingReviewResult).not.toHaveBeenCalled();
    expect(mockUpdateReviewCategoryCatalog).not.toHaveBeenCalled();
    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
  });

  it('returns not_connected before workflow-store initialization when configuration is absent', async () => {
    mockLoadConfig.mockResolvedValue(null);
    mockGetWorkflowStore.mockReturnValue({ error: 'workflow unavailable' });

    const r = await handler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('not_connected');
    expect(mockGetWorkflowStore).not.toHaveBeenCalled();
  });

  it('returns not_connected when configuration disappears before restoration', async () => {
    mockWithConnection.mockRejectedValue(
      Object.assign(new Error('No BalanceFrame connection configured. Run connect first.'), {
        code: 'not_connected',
        retryable: true,
      }),
    );

    const r = await handler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('not_connected');
    expect(r.error?.message).toBe('No ledger connected. Configure an Actual budget first.');
    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mockPersistPendingReviewResult).not.toHaveBeenCalled();
  });

  it('must preserve the configured synchronize → analyze → persist path', async () => {
    mockListReviewItems.mockResolvedValue([{ id: 'r1', version: 1 }]);
    const r = await handler({ context: { auth: { authenticated: true } } });
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockWithConnection).toHaveBeenCalledTimes(1);
    expect(mockCreateNativeAnalysisProtocol).toHaveBeenCalledTimes(1);
    expect(pendingReview).toHaveBeenCalledTimes(1);
    expect(pendingReview).toHaveBeenCalledWith(restoredConnector, null);
    expect(mockPersistPendingReviewResult).toHaveBeenCalledWith(
      workflowStore,
      restoredBudget.id,
      pendingReviewResult,
    );
    expect(mockListReviewItems).toHaveBeenCalled();
    expect(mockTransitionReviewItem).toHaveBeenCalledTimes(1);
    expect(mockUpdateReviewCategoryCatalog).toHaveBeenCalledTimes(1);
    expect(mockUpdateReviewCategoryCatalog.mock.calls[0]?.[0]).toBe(connectedConfig);
    expect(mockUpdateReviewCategoryCatalog.mock.calls[0]?.[0]).not.toBe(loadedConnectionConfig);
    expect(mockUpdateReviewCategoryCatalog.mock.calls[0]?.[1]).toBe(connectedSynchronization);
    expect(mockConnectionOperationCompleted).toHaveBeenCalledTimes(1);
    expect(mockUpdateReviewCategoryCatalog.mock.invocationCallOrder[0]).toBeLessThan(
      mockConnectionOperationCompleted.mock.invocationCallOrder[0],
    );
    expect(r.status).toBe('ok');
    expect(mockCreateDefaultConnectionManager).toHaveBeenCalledWith({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
  });

  it('sanitizes an unreadable configuration without restoring or persisting', async () => {
    mockLoadConfig.mockRejectedValue(new Error('config unreadable'));

    const r = await handler({ context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('SYNC_REVIEW_FAILED');
    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 500);
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
    expect(mockPersistPendingReviewResult).not.toHaveBeenCalled();
  });
});
