/**
 * TDD: GET /api/sinking-fund/health delegates to sinkingFundHealthAnalysis.
 *
 * Must fail against the current hardcoded stub.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockRestore, mockCreateDefaultConnectionManager, mockCreateNativeAnalysisProtocol } =
  vi.hoisted(() => ({
    mockRestore: vi.fn(),
    mockCreateDefaultConnectionManager: vi.fn(() => ({
      restore: mockRestore,
      withConnection: async (operation: (connected: unknown) => Promise<unknown>) =>
        operation(await mockRestore()),
    })),
    mockCreateNativeAnalysisProtocol: vi.fn(),
  }));

// ---------------------------------------------------------------------------
// Mock @balanceframe/application
// ---------------------------------------------------------------------------

vi.mock('@balanceframe/application', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createDefaultConnectionManager: mockCreateDefaultConnectionManager,
    createNativeAnalysisProtocol: mockCreateNativeAnalysisProtocol,
  };
});

// ---------------------------------------------------------------------------
// Mock h3
// ---------------------------------------------------------------------------

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  setResponseStatus: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock workflow-store helpers
// ---------------------------------------------------------------------------

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: {} })),
  buildAuthorizationInfo: vi.fn(() => ({
    actorId: 'test-actor',
    capability: 'observe',
    allowed: true,
  })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((err, requestId, code, retryable) => ({
    code,
    message: String(err),
    retryable,
  })),
  okEnvelope: (result: unknown, _auth: unknown, requestId?: string) => ({
    schemaVersion: '1',
    requestId: requestId ?? 'test-req',
    status: 'ok' as const,
    dataFreshness: null,
    authorization: null,
    result,
    error: null,
  }),
  errorEnvelope: (
    code: string,
    message: string,
    _auth: unknown,
    retryable?: boolean,
    requestId?: string,
  ) => ({
    schemaVersion: '1',
    requestId: requestId ?? 'test-req',
    status: 'error' as const,
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code, message, retryable: retryable ?? false },
  }),
}));

// ---------------------------------------------------------------------------
// Import handler
// ---------------------------------------------------------------------------

import handler from '../../server/api/sinking-fund/health.get';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/sinking-fund/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRestore.mockResolvedValue({
      connector: { name: 'mock-connector' },
      budget: { id: 'budget_test', groupId: 'group_test', name: 'Test', encrypted: false },
      synchronization: {},
    });
    mockCreateNativeAnalysisProtocol.mockResolvedValue({
      sinkingFundHealth: vi.fn(),
    });
  });

  it('must delegate to sinkingFundHealthAnalysis and return non-stub data', async () => {
    const mockProtocol = await mockCreateNativeAnalysisProtocol();
    mockProtocol.sinkingFundHealth.mockResolvedValue({
      sinkingFunds: [
        {
          categoryId: 'cat_vacation',
          categoryName: 'Vacation',
          budgeted: { minorUnits: '200000', currency: 'USD' },
          spent: { minorUnits: '50000', currency: 'USD' },
          remaining: { minorUnits: '150000', currency: 'USD' },
          healthLabel: 'healthy',
          isSinkingFund: true,
          targetAmount: { minorUnits: '200000', currency: 'USD' },
          targetProgress: 0.75,
        },
        {
          categoryId: 'cat_emergency',
          categoryName: 'Emergency Fund',
          budgeted: { minorUnits: '500000', currency: 'USD' },
          spent: { minorUnits: '0', currency: 'USD' },
          remaining: { minorUnits: '500000', currency: 'USD' },
          healthLabel: 'healthy',
          isSinkingFund: true,
          targetAmount: { minorUnits: '1000000', currency: 'USD' },
          targetProgress: 0.5,
        },
      ],
      fullyFundedCount: 0,
      partiallyFundedCount: 2,
      unfundedCount: 0,
    });

    const event = { context: { auth: { authenticated: true } } };

    const response = await handler(event);

    expect(response.status).toBe('ok');
    expect(response.result.sinkingFunds).toHaveLength(2);
    expect(response.result.fullyFundedCount).toBe(0);
    expect(response.result.partiallyFundedCount).toBe(2);
    expect(response.result.unfundedCount).toBe(0);
    // Assertions that prove delegation (would fail against stub):
    expect(response.result.sinkingFunds[0].categoryName).toBe('Vacation');
    expect(response.result.partiallyFundedCount).toBeGreaterThan(0);
  });

  it('must return error when analysis fails', async () => {
    mockRestore.mockResolvedValue({
      connector: null,
      budget: { id: 'budget_test', groupId: 'group_test', name: 'Test', encrypted: false },
      synchronization: {},
    });

    const event = { context: { auth: { authenticated: true } } };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error).toBeDefined();
  });
});
