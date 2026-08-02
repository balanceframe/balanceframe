/**
 * TDD: GET /api/purchase/evaluate delegates to purchaseEvaluationAnalysis.
 *
 * Verifies that the route invokes the real analysis function with a
 * properly constructed CommandInput and that non-trivial data from
 * the protocol flows back through the response envelope.
 *
 * Must fail against the current hardcoded stub.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------

const { mockRestore, mockCreateDefaultConnectionManager, mockCreateNativeAnalysisProtocol, mockRequireAuthorization } = vi.hoisted(() => ({
  mockRestore: vi.fn(),
  mockCreateDefaultConnectionManager: vi.fn(() => ({ restore: mockRestore })),
  mockCreateNativeAnalysisProtocol: vi.fn(),
  mockRequireAuthorization: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock @balanceframe/application — keep real analysis functions, mock deps
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
// Mock h3 — unwrap defineEventHandler so tests call the raw handler
// ---------------------------------------------------------------------------

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getQuery: (event: Record<string, unknown>) => event.query ?? {},
  setResponseStatus: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock workflow-store helpers
// ---------------------------------------------------------------------------

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: {} })),
  buildAuthorizationInfo: vi.fn(() => ({ actorId: 'test-actor', capability: 'observe', allowed: true })),
  requireAuthorization: mockRequireAuthorization,
  getActorId: vi.fn(() => 'test-actor'),
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
// Import handler (after mocks)
// ---------------------------------------------------------------------------

import handler from '../../server/api/purchase/evaluate.get';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/purchase/evaluate', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRequireAuthorization.mockResolvedValue({
      ok: true,
      info: { actorId: 'test-actor', capability: 'observe', allowed: true },
    });

    // Default: connected ledger + protocol available
    mockRestore.mockResolvedValue({
      connector: { name: 'mock-connector' },
      budget: { id: 'budget_test', groupId: 'group_test', name: 'Test', encrypted: false },
      synchronization: {},
    });
    mockCreateNativeAnalysisProtocol.mockResolvedValue({
      purchaseEvaluation: vi.fn(),
    });
  });

  it('rejects unauthenticated callers before restoring the ledger', async () => {
    mockRequireAuthorization.mockResolvedValueOnce({
      ok: false,
      info: null,
      response: { status: 'error', error: { code: 'AUTHORIZATION_REQUIRED' } },
    });
    const response = await handler({ query: { categoryId: 'cat', amount: '100' }, context: {} });
    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('AUTHORIZATION_REQUIRED');
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('must delegate to purchaseEvaluationAnalysis and return non-stub data', async () => {
    const mockProtocol = await mockCreateNativeAnalysisProtocol();
    mockProtocol.purchaseEvaluation.mockResolvedValue({
      allowable: false,
      reasonCodes: ['test_mock_reason'],
      categoryBudget: { minorUnits: '50000', currency: 'USD' },
      categorySpent: { minorUnits: '30000', currency: 'USD' },
      categoryRemaining: { minorUnits: '20000', currency: 'USD' },
      projectedBalance: { minorUnits: '100000', currency: 'USD' },
      hasEnvelope: true,
    });

    const event = {
      query: {
        categoryId: 'cat_groceries',
        amount: '2500',
        currency: 'USD',
      },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    expect(response.status).toBe('ok');
    expect(response.result).toEqual({
      allowable: false,
      reasonCodes: ['test_mock_reason'],
      categoryBudget: { minorUnits: '50000', currency: 'USD' },
      categorySpent: { minorUnits: '30000', currency: 'USD' },
      categoryRemaining: { minorUnits: '20000', currency: 'USD' },
      projectedBalance: { minorUnits: '100000', currency: 'USD' },
      hasEnvelope: true,
    });
    // Assertions that prove delegation (would fail against hardcoded stub):
    expect(response.result.reasonCodes).not.toEqual(['sufficient_budget']);
    expect(response.result.categoryBudget.minorUnits).not.toBe('0');
    expect(response.result.categorySpent.minorUnits).not.toBe('0');
    expect(response.result.projectedBalance).not.toBeNull();
  });

  it('must return error envelope when analysis returns error', async () => {
    mockRestore.mockResolvedValue({
      connector: null,
      budget: { id: 'budget_test', groupId: 'group_test', name: 'Test', encrypted: false },
      synchronization: {},
    });

    const event = {
      query: {
        categoryId: 'cat_groceries',
        amount: '2500',
        currency: 'USD',
      },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    // ledger is null → analysis returns not_connected error
    expect(response.status).toBe('error');
    expect(response.error).toBeDefined();
  });

  it('must require categoryId', async () => {
    const event = {
      query: { amount: '2500' },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('PURCHASE_CATEGORY_REQUIRED');
  });

  it('must require a non-zero amount', async () => {
    const event = {
      query: { categoryId: 'cat_test', amount: '0' },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('PURCHASE_AMOUNT_REQUIRED');
  });
});
