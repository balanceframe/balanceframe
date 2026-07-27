/**
 * TDD: GET /api/targets/health delegates to targetHealthAnalysis.
 *
 * Must fail against the current hardcoded stub.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockRestore, mockCreateDefaultConnectionManager, mockCreateNativeAnalysisProtocol } = vi.hoisted(() => ({
  mockRestore: vi.fn(),
  mockCreateDefaultConnectionManager: vi.fn(() => ({ restore: mockRestore })),
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
  buildAuthorizationInfo: vi.fn(() => ({ actorId: 'test-actor', capability: 'observe', allowed: true })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((err, requestId, code, retryable) => ({ code, message: String(err), retryable })),
  okEnvelope: (result: unknown, _auth: unknown, requestId?: string) => ({
    schemaVersion: '1',
    requestId: requestId ?? 'test-req',
    status: 'ok' as const,
    dataFreshness: null,
    authorization: null,
    result,
    error: null,
  }),
  errorEnvelope: (code: string, message: string, _auth: unknown, retryable?: boolean, requestId?: string) => ({
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

import handler from '../../server/api/targets/health.get';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/targets/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRestore.mockResolvedValue({
      connector: { name: 'mock-connector' },
      budget: { id: 'budget_test', groupId: 'group_test', name: 'Test', encrypted: false },
      synchronization: {},
    });
    mockCreateNativeAnalysisProtocol.mockResolvedValue({
      targetHealth: vi.fn(),
    });
  });

  it('must delegate to targetHealthAnalysis and return non-stub data', async () => {
    const mockProtocol = await mockCreateNativeAnalysisProtocol();
    mockProtocol.targetHealth.mockResolvedValue({
      categories: [
        {
          categoryId: 'cat_groceries',
          categoryName: 'Groceries',
          budgeted: { minorUnits: '400000', currency: 'USD' },
          spent: { minorUnits: '320000', currency: 'USD' },
          remaining: { minorUnits: '80000', currency: 'USD' },
          healthLabel: 'at_risk',
          isSinkingFund: false,
          targetAmount: null,
          targetProgress: null,
        },
        {
          categoryId: 'cat_vacation',
          categoryName: 'Vacation',
          budgeted: { minorUnits: '200000', currency: 'USD' },
          spent: { minorUnits: '50000', currency: 'USD' },
          remaining: { minorUnits: '150000', currency: 'USD' },
          healthLabel: 'healthy',
          isSinkingFund: true,
          targetAmount: { minorUnits: '200000', currency: 'USD' },
          targetProgress: 0.25,
        },
      ],
      overallLabel: 'mixed',
      healthyCount: 1,
      atRiskCount: 1,
      sinkingFundCount: 1,
    });

    const event = { context: { auth: { authenticated: true } } };

    const response = await handler(event);

    expect(response.status).toBe('ok');
    expect(response.result.categories).toHaveLength(2);
    expect(response.result.overallLabel).toBe('mixed');
    expect(response.result.healthyCount).toBe(1);
    expect(response.result.atRiskCount).toBe(1);
    expect(response.result.sinkingFundCount).toBe(1);
    // Assertions that prove delegation (would fail against stub):
    expect(response.result.categories[0].categoryName).toBe('Groceries');
    expect(response.result.healthyCount).toBeGreaterThan(0);
    expect(response.result.atRiskCount).toBeGreaterThan(0);
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
