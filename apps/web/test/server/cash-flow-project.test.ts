/**
 * TDD: GET /api/cash-flow/project delegates to cashFlowProjectionAnalysis.
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
  getQuery: (event: Record<string, unknown>) => event.query ?? {},
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
  envelopeMetadata: (envelope: { dataFreshness?: unknown }) => ({ dataFreshness: envelope.dataFreshness ?? null }),
}));

// ---------------------------------------------------------------------------
// Import handler
// ---------------------------------------------------------------------------

import handler from '../../server/api/cash-flow/project.get';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cash-flow/project', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRestore.mockResolvedValue({
      connector: { name: 'mock-connector' },
      budget: { id: 'budget_test', groupId: 'group_test', name: 'Test', encrypted: false },
      synchronization: {},
    });
    mockCreateNativeAnalysisProtocol.mockResolvedValue({
      cashFlowProjection: vi.fn(),
    });
  });

  it('must delegate to cashFlowProjectionAnalysis and return non-stub data', async () => {
    const mockProtocol = await mockCreateNativeAnalysisProtocol();
    mockProtocol.cashFlowProjection.mockResolvedValue({
      projectionMonths: 6,
      monthlyProjections: [
        {
          month: '2026-07',
          projectedIncome: { minorUnits: '500000', currency: 'USD' },
          projectedExpenses: { minorUnits: '350000', currency: 'USD' },
          netChange: { minorUnits: '150000', currency: 'USD' },
          endingBalance: { minorUnits: '150000', currency: 'USD' },
          scheduledIncomeCount: 2,
          scheduledExpenseCount: 15,
        },
        {
          month: '2026-08',
          projectedIncome: { minorUnits: '500000', currency: 'USD' },
          projectedExpenses: { minorUnits: '400000', currency: 'USD' },
          netChange: { minorUnits: '100000', currency: 'USD' },
          endingBalance: { minorUnits: '250000', currency: 'USD' },
          scheduledIncomeCount: 2,
          scheduledExpenseCount: 14,
        },
      ],
      sufficientData: true,
      dataWarning: null,
    });

    const event = {
      query: { months: '6', startMonth: '2026-07' },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    expect(response.status).toBe('ok');
    expect(response.result.projectionMonths).toBe(6);
    expect(response.result.monthlyProjections).toHaveLength(2);
    expect(response.result.monthlyProjections[0].month).toBe('2026-07');
    expect(response.result.monthlyProjections[1].scheduledExpenseCount).toBe(14);
    // Assertions that prove delegation (would fail against stub):
    expect(response.result.monthlyProjections[0].scheduledIncomeCount).toBeGreaterThan(0);
    expect(response.result.projectionMonths).toBeGreaterThan(0);
  });

  it('must return error when ledger is null', async () => {
    mockRestore.mockResolvedValue({
      connector: null,
      budget: { id: 'budget_test', groupId: 'group_test', name: 'Test', encrypted: false },
      synchronization: {},
    });

    const event = {
      query: { months: '3' },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error).toBeDefined();
  });

  it('must reject invalid months', async () => {
    const event = {
      query: { months: '25' },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('INVALID_MONTHS');
  });
});
