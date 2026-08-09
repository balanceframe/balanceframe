/**
 * TDD: GET /api/home/budget-summary delegates to budgetSummaryAnalysis.
 *
 * Must fail against stub returning empty arrays.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  setResponseStatus: vi.fn(),
}));

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: {} })),
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
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: r,
    error: null,
  }),
  errorEnvelope: (c, m, _a, ret?, rid?, metadata?) => ({
    schemaVersion: '1',
    requestId: rid ?? 'tr',
    status: 'error',
    dataFreshness: metadata?.dataFreshness ?? null,
    authorization: null,
    result: null,
    error: { code: c, message: m, retryable: ret ?? false },
    ...metadata,
  }),
  envelopeMetadata: (envelope) => ({ dataFreshness: envelope.dataFreshness ?? null, ...envelope }),
}));

import handler from '../../server/api/home/budget-summary.get';

describe('GET /api/home/budget-summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRestore.mockResolvedValue({
      connector: { name: 'm' },
      budget: { id: 'b', groupId: 'g', name: 'T', encrypted: false },
      synchronization: {},
    });
    mockCreateNativeAnalysisProtocol.mockResolvedValue({ budgetSummary: vi.fn() });
  });

  it('must delegate and return non-stub data', async () => {
    const p = await mockCreateNativeAnalysisProtocol();
    p.budgetSummary.mockResolvedValue({
      totalBudgeted: { minorUnits: '500000', currency: 'USD' },
      totalSpent: { minorUnits: '350000', currency: 'USD' },
      totalRemaining: { minorUnits: '150000', currency: 'USD' },
      categories: [
        {
          categoryId: 'cg',
          categoryName: 'Groceries',
          budgeted: 200000,
          spent: 180000,
          remaining: 20000,
          status: 'on_track',
        },
      ],
      month: '2026-07',
    });

    const r = await handler({
      query: { month: '2026-07' },
      context: { auth: { authenticated: true } },
    });
    expect(r.status).toBe('ok');
    expect(r.result.totalBudgeted.minorUnits).toBe('500000');
    expect(r.result.categories).toHaveLength(1);
    expect(r.result.categories[0].status).toBe('on_track');
  });

  it('must error when protocol unavailable', async () => {
    mockRestore.mockResolvedValue({
      connector: null,
      budget: { id: 'b', groupId: 'g', name: 'T', encrypted: false },
      synchronization: {},
    });
    const r = await handler({ query: {}, context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
  });
});
