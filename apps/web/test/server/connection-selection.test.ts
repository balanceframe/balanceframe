import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockReadBody,
  mockSetResponseStatus,
  mockConnect,
  mockCreateDefaultConnectionManager,
  mockBuildAuthorizationInfo,
  mockOkEnvelope,
  mockErrorEnvelope,
  mockSanitizeError,
  mockUpdateReviewCategoryCatalog,
  connectedBudget,
  connectedConfig,
  connectedSynchronization,
} = vi.hoisted(() => {
  const connectedBudget = {
    id: 'selected-budget-id',
    groupId: 'selected-group-id',
    name: 'Selected budget',
    encrypted: false,
  };
  const connectedConfig = {
    version: 1,
    serverUrl: 'https://selected.actual.test',
    budgetId: connectedBudget.id,
    budgetName: connectedBudget.name,
    groupId: connectedBudget.groupId,
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
  const authorization = {
    actorId: 'test-actor',
    capability: 'observe',
    allowed: true,
  };
  const mockConnect = vi.fn();

  return {
    mockReadBody: vi.fn(),
    mockSetResponseStatus: vi.fn(),
    mockConnect,
    mockCreateDefaultConnectionManager: vi.fn(() => ({ connect: mockConnect })),
    mockBuildAuthorizationInfo: vi.fn(() => authorization),
    mockOkEnvelope: vi.fn((result: unknown, auth: unknown, requestId: string) => ({
      schemaVersion: '1',
      requestId,
      status: 'ok' as const,
      dataFreshness: null,
      authorization: auth,
      result,
      error: null,
    })),
    mockErrorEnvelope: vi.fn(
      (code: string, message: string, auth: unknown, retryable: boolean, requestId: string) => ({
        schemaVersion: '1',
        requestId,
        status: 'error' as const,
        dataFreshness: null,
        authorization: auth,
        result: null,
        error: { code, message, retryable },
      }),
    ),
    mockSanitizeError: vi.fn(
      (_error: unknown, _requestId: string, code: string, retryable: boolean) => ({
        code,
        message: 'connection failed',
        retryable,
      }),
    ),
    mockUpdateReviewCategoryCatalog: vi.fn(),
    connectedBudget,
    connectedConfig,
    connectedSynchronization,
  };
});

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  readBody: mockReadBody,
  setResponseStatus: mockSetResponseStatus,
}));

vi.mock('@balanceframe/application', () => ({
  createDefaultConnectionManager: mockCreateDefaultConnectionManager,
}));

vi.mock('../../server/utils/workflow-store', () => ({
  buildAuthorizationInfo: mockBuildAuthorizationInfo,
  okEnvelope: mockOkEnvelope,
  errorEnvelope: mockErrorEnvelope,
  sanitizeError: mockSanitizeError,
}));

vi.mock('../../server/utils/review-category-catalog', () => ({
  updateReviewCategoryCatalog: mockUpdateReviewCategoryCatalog,
}));

import handler from '../../server/api/connection/index.post';

describe('POST /api/connection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadBody.mockResolvedValue({ budgetId: `  ${connectedBudget.id}  ` });
    mockConnect.mockResolvedValue({
      connector: { name: 'selected-connector' },
      budget: connectedBudget,
      config: connectedConfig,
      synchronization: connectedSynchronization,
    });
  });

  it('updates the review category catalog from the lifecycle-scoped connected budget', async () => {
    const response = await handler({ context: { auth: { authenticated: true } } });

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith({ budgetId: connectedBudget.id });
    expect(mockUpdateReviewCategoryCatalog).toHaveBeenCalledTimes(1);
    expect(mockUpdateReviewCategoryCatalog.mock.calls[0]?.[0]).toBe(connectedConfig);
    expect(mockUpdateReviewCategoryCatalog.mock.calls[0]?.[1]).toBe(connectedSynchronization);
    expect(mockUpdateReviewCategoryCatalog.mock.invocationCallOrder[0]).toBeLessThan(
      mockOkEnvelope.mock.invocationCallOrder[0],
    );
    expect(response.status).toBe('ok');
    expect(response.result).toEqual({
      connected: true,
      budget: connectedBudget,
    });
  });

  it('does not update the catalog when the selection body is invalid', async () => {
    mockReadBody.mockResolvedValue({ budgetId: '   ' });

    const response = await handler({ context: { auth: { authenticated: true } } });

    expect(mockCreateDefaultConnectionManager).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockUpdateReviewCategoryCatalog).not.toHaveBeenCalled();
    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('BUDGET_ID_REQUIRED');
  });

  it('does not update the catalog when the selected budget cannot connect', async () => {
    const failure = new Error('Actual is unavailable');
    mockConnect.mockRejectedValueOnce(failure);

    const response = await handler({ context: { auth: { authenticated: true } } });

    expect(mockUpdateReviewCategoryCatalog).not.toHaveBeenCalled();
    expect(mockSanitizeError).toHaveBeenCalledWith(
      failure,
      expect.any(String),
      'ACTUAL_BUDGET_CONNECT_FAILED',
      true,
    );
    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('ACTUAL_BUDGET_CONNECT_FAILED');
  });
});
