/**
 * TDD: GET /api/home/attention delegates to attentionHomeAnalysis.
 * Must fail against stub returning empty arrays.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockRestore,
  mockWithConnection,
  mockLoadConfig,
  mockCreateDefaultConnectionManager,
  mockCreateNativeAnalysisProtocol,
  mockSetResponseStatus,
  mockGetWorkflowStore,
} = vi.hoisted(() => {
  const mockRestore = vi.fn();
  const mockWithConnection = vi.fn();
  const mockLoadConfig = vi.fn();
  return {
    mockRestore,
    mockWithConnection,
    mockLoadConfig,
    mockCreateDefaultConnectionManager: vi.fn(() => ({
      restore: mockRestore,
      withConnection: mockWithConnection,
      loadConfig: mockLoadConfig,
    })),
    mockCreateNativeAnalysisProtocol: vi.fn(),
    mockSetResponseStatus: vi.fn(),
    mockGetWorkflowStore: vi.fn(() => ({ store: {} })),
  };
});

vi.mock('@balanceframe/application', async (i) => {
  const a = await i();
  return {
    ...a,
    createDefaultConnectionManager: mockCreateDefaultConnectionManager,
    createNativeAnalysisProtocol: mockCreateNativeAnalysisProtocol,
  };
});

vi.mock('h3', () => ({
  defineEventHandler: <T>(h: T) => h,
  getQuery: (e: Record<string, unknown>) => e.query ?? {},
  setResponseStatus: mockSetResponseStatus,
}));

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: mockGetWorkflowStore,
  requireAuthorization: vi.fn(async () => ({
    ok: true,
    info: {
      actorId: 'test-actor',
      capability: 'observe',
      allowed: true,
    },
  })),
  buildAuthorizationInfo: vi.fn(() => ({
    actorId: 'test-actor',
    capability: 'observe',
    allowed: true,
  })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((e, r, c, ret) => ({ code: c, message: String(e), retryable: ret })),
  okEnvelope: (r, _a, rid?) => ({
    schemaVersion: '1',
    requestId: rid ?? 'tr',
    status: 'ok' as const,
    dataFreshness: null,
    authorization: null,
    result: r,
    error: null,
  }),
  errorEnvelope: (c, m, _a, ret?, rid?, metadata?) => ({
    schemaVersion: '1',
    requestId: rid ?? 'tr',
    status: 'error' as const,
    dataFreshness: metadata?.dataFreshness ?? null,
    authorization: null,
    result: null,
    error: { code: c, message: m, retryable: ret ?? false },
    ...metadata,
  }),
  envelopeMetadata: (envelope) => ({ dataFreshness: envelope.dataFreshness ?? null, ...envelope }),
}));

import handler from '../../server/api/home/attention.get';

describe('GET /api/home/attention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockResolvedValue({
      version: 1,
      serverUrl: 'x',
      budgetId: 'b',
      budgetName: 'Test',
      groupId: 'g',
    });
    mockGetWorkflowStore.mockReturnValue({ store: {} });
    mockRestore.mockResolvedValue({
      connector: { name: 'm' },
      budget: { id: 'b', groupId: 'g', name: 'T', encrypted: false },
      synchronization: {},
    });
    mockWithConnection.mockImplementation(
      async (operation: (connected: unknown) => Promise<unknown>) => operation(await mockRestore()),
    );
    mockCreateNativeAnalysisProtocol.mockResolvedValue({ attentionHome: vi.fn() });
  });

  it('must delegate and return non-stub data', async () => {
    const p = await mockCreateNativeAnalysisProtocol();
    p.attentionHome.mockResolvedValue({
      blockers: [
        {
          code: 'uncategorized',
          message: '5 uncategorized',
          severity: 'warning',
          entityType: 'transaction',
        },
      ],
      alerts: [
        {
          code: 'overspent',
          message: 'Groceries overspent',
          severity: 'warning',
          categoryId: 'cg',
          categoryName: 'Groceries',
        },
      ],
      recurrences: [
        {
          payeeName: 'Netflix',
          amount: { minorUnits: '1549', currency: 'USD' },
          frequency: 'monthly',
          occurrences: 12,
          lastOccurrence: '2026-07-20',
          isEstimated: false,
        },
      ],
      categoryRisks: [
        {
          categoryId: 'cg',
          categoryName: 'Groceries',
          risk: 'high',
          reasonCodes: ['overspent'],
          remainingBudget: { minorUnits: '0', currency: 'USD' },
          daysRemaining: 5,
        },
      ],
      targetProgress: {
        overallLabel: 'at_risk',
        healthyCount: 3,
        atRiskCount: 2,
        sinkingFundsOnTrack: 1,
        totalSinkingFunds: 2,
      },
    });
    const r = await handler({
      query: { categoryGroup: 'essentials', detailed: 'true', month: '2026-07' },
      context: { auth: { authenticated: true } },
    });
    expect(r.status).toBe('ok');
    expect(r.result.blockers).toHaveLength(1);
    expect(r.result.alerts).toHaveLength(1);
    expect(r.result.targetProgress.overallLabel).toBe('at_risk');
    expect(r.result.categoryRisks[0].risk).toBe('high');
    expect(r.result.blockers.length).toBeGreaterThan(0);
    expect(r.result.targetProgress.overallLabel).not.toBe('healthy');
    expect(mockCreateDefaultConnectionManager).toHaveBeenCalledWith({
      configPath: process.env.BALANCEFRAME_CONFIG_PATH,
    });
    expect(mockWithConnection).toHaveBeenCalledTimes(1);
  });

  it('must error when analysis fails', async () => {
    mockRestore.mockResolvedValue({
      connector: null,
      budget: { id: 'b', groupId: 'g', name: 'T', encrypted: false },
      synchronization: {},
    });
    const r = await handler({ query: {}, context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
  });

  it('must reject invalid month format', async () => {
    const r = await handler({
      query: { month: '2026-1' },
      context: { auth: { authenticated: true } },
    });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('INVALID_MONTH');
  });

  it('must return not_connected when no budget is configured without touching the connector', async () => {
    mockLoadConfig.mockResolvedValue(null);
    const r = await handler({ query: {}, context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('not_connected');
    expect(r.error?.message).toBe('No ledger connected. Configure an Actual budget first.');
    expect(r.error?.retryable).toBe(true);
    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
  });

  it('returns not_connected before workflow-store initialization when configuration is absent', async () => {
    mockLoadConfig.mockResolvedValue(null);
    mockGetWorkflowStore.mockReturnValue({ error: 'workflow unavailable' });

    const r = await handler({ query: {}, context: { auth: { authenticated: true } } });

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

    const r = await handler({ query: {}, context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('not_connected');
    expect(r.error?.message).toBe('No ledger connected. Configure an Actual budget first.');
    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
  });
  it('sanitizes an unreadable configuration as an operational analysis failure', async () => {
    mockLoadConfig.mockRejectedValue(new Error('config unreadable'));

    const r = await handler({ query: {}, context: { auth: { authenticated: true } } });

    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('ANALYSIS_FAILED');
    expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 500);
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockCreateNativeAnalysisProtocol).not.toHaveBeenCalled();
  });
});
