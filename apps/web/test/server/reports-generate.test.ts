/**
 * TDD: GET /api/reports/generate delegates to reportGenerateAnalysis.
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
  getQuery: (event: Record<string, unknown>) => event.query ?? {},
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

import handler from '../../server/api/reports/generate.get';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/reports/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRestore.mockResolvedValue({
      connector: { name: 'mock-connector' },
      budget: { id: 'budget_test', groupId: 'group_test', name: 'Test', encrypted: false },
      synchronization: {},
    });
    mockCreateNativeAnalysisProtocol.mockResolvedValue({
      generateReport: vi.fn(),
    });
  });

  it('must delegate to reportGenerateAnalysis and return non-stub data', async () => {
    const mockProtocol = await mockCreateNativeAnalysisProtocol();
    const fixedReportId = 'rpt_mock_fixed_id';
    mockProtocol.generateReport.mockResolvedValue({
      reportId: fixedReportId,
      reportType: 'spending',
      scope: {
        monthRange: '2026-07:2026-09',
        includePending: true,
      },
      label: 'Q3 Spending',
      transactionCount: 142,
      totalAmount: { minorUnits: '1250000', currency: 'USD' },
      generatedAt: '2026-07-27T12:00:00.000Z',
      tags: ['quarterly'],
    });

    const event = {
      query: {
        reportType: 'spending',
        monthRange: '2026-07:2026-09',
        label: 'Q3 Spending',
        tag: 'quarterly',
      },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    expect(response.status).toBe('ok');
    expect(response.result.reportId).toBe(fixedReportId);
    expect(response.result.reportType).toBe('spending');
    expect(response.result.transactionCount).toBe(142);
    expect(response.result.totalAmount.minorUnits).toBe('1250000');
    expect(response.result.tags).toEqual(['quarterly']);
    // Assertions that prove delegation (would fail against stub):
    expect(response.result.transactionCount).toBeGreaterThan(0);
    expect(response.result.totalAmount.minorUnits).not.toBe('0');
    expect(response.result.label).toBe('Q3 Spending');
  });

  it('must return error when analysis fails', async () => {
    mockRestore.mockResolvedValue({
      connector: null,
      budget: { id: 'budget_test', groupId: 'group_test', name: 'Test', encrypted: false },
      synchronization: {},
    });

    const event = {
      query: {
        reportType: 'spending',
        monthRange: '2026-07',
      },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error).toBeDefined();
  });

  it('must reject invalid reportType', async () => {
    const event = {
      query: { reportType: 'invalid_type', monthRange: '2026-07' },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('INVALID_REPORT_TYPE');
  });

  it('must reject invalid monthRange', async () => {
    const event = {
      query: { reportType: 'spending', monthRange: 'not-a-range' },
      context: { auth: { authenticated: true } },
    };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('INVALID_MONTH_RANGE');
  });
});
