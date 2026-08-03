/**
 * TDD: GET /api/home/attention delegates to attentionHomeAnalysis.
 * Must fail against stub returning empty arrays.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockRestore, mockCreateDefaultConnectionManager, mockCreateNativeAnalysisProtocol } = vi.hoisted(() => ({
  mockRestore: vi.fn(),
  mockCreateDefaultConnectionManager: vi.fn(() => ({ restore: mockRestore })),
  mockCreateNativeAnalysisProtocol: vi.fn(),
}));

vi.mock('@balanceframe/application', async (i) => {
  const a = await i();
  return { ...a, createDefaultConnectionManager: mockCreateDefaultConnectionManager, createNativeAnalysisProtocol: mockCreateNativeAnalysisProtocol };
});

vi.mock('h3', () => ({ defineEventHandler: <T>(h: T) => h, getQuery: (e: Record<string, unknown>) => e.query ?? {}, setResponseStatus: vi.fn() }));

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: {} })),
  buildAuthorizationInfo: vi.fn(() => ({ actorId: 'test-actor', capability: 'observe', allowed: true })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((e, r, c, ret) => ({ code: c, message: String(e), retryable: ret })),
  okEnvelope: (r, _a, rid?) => ({ schemaVersion: '1', requestId: rid ?? 'tr', status: 'ok' as const, dataFreshness: null, authorization: null, result: r, error: null }),
  errorEnvelope: (c, m, _a, ret?, rid?, metadata?) => ({ schemaVersion: '1', requestId: rid ?? 'tr', status: 'error' as const, dataFreshness: metadata?.dataFreshness ?? null, authorization: null, result: null, error: { code: c, message: m, retryable: ret ?? false }, ...metadata }),
  envelopeMetadata: (envelope) => ({ dataFreshness: envelope.dataFreshness ?? null, ...envelope }),
}));

import handler from '../../server/api/home/attention.get';

describe('GET /api/home/attention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRestore.mockResolvedValue({ connector: { name: 'm' }, budget: { id: 'b', groupId: 'g', name: 'T', encrypted: false }, synchronization: {} });
    mockCreateNativeAnalysisProtocol.mockResolvedValue({ attentionHome: vi.fn() });
  });

  it('must delegate and return non-stub data', async () => {
    const p = await mockCreateNativeAnalysisProtocol();
    p.attentionHome.mockResolvedValue({
      blockers: [{ code: 'uncategorized', message: '5 uncategorized', severity: 'warning', entityType: 'transaction' }],
      alerts: [{ code: 'overspent', message: 'Groceries overspent', severity: 'warning', categoryId: 'cg', categoryName: 'Groceries' }],
      recurrences: [{ payeeName: 'Netflix', amount: { minorUnits: '1549', currency: 'USD' }, frequency: 'monthly', occurrences: 12, lastOccurrence: '2026-07-20', isEstimated: false }],
      categoryRisks: [{ categoryId: 'cg', categoryName: 'Groceries', risk: 'high', reasonCodes: ['overspent'], remainingBudget: { minorUnits: '0', currency: 'USD' }, daysRemaining: 5 }],
      targetProgress: { overallLabel: 'at_risk', healthyCount: 3, atRiskCount: 2, sinkingFundsOnTrack: 1, totalSinkingFunds: 2 },
    });
    const r = await handler({ query: { categoryGroup: 'essentials', detailed: 'true', month: '2026-07' }, context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.blockers).toHaveLength(1);
    expect(r.result.alerts).toHaveLength(1);
    expect(r.result.targetProgress.overallLabel).toBe('at_risk');
    expect(r.result.categoryRisks[0].risk).toBe('high');
    expect(r.result.blockers.length).toBeGreaterThan(0);
    expect(r.result.targetProgress.overallLabel).not.toBe('healthy');
  });

  it('must error when analysis fails', async () => {
    mockRestore.mockResolvedValue({ connector: null, budget: { id: 'b', groupId: 'g', name: 'T', encrypted: false }, synchronization: {} });
    const r = await handler({ query: {}, context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
  });

  it('must reject invalid month format', async () => {
    const r = await handler({ query: { month: '2026-1' }, context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('INVALID_MONTH');
  });
});
