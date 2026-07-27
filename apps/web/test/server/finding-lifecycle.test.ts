/**
 * TDD: Finding lifecycle routes.
 * GET /api/findings, GET /api/findings/:id, POST acknowledge, POST dismiss
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockReadBody, mockGetWorkflowStore, mockGetRouterParam, mockGetQuery } = vi.hoisted(() => ({
  mockReadBody: vi.fn(),
  mockGetWorkflowStore: vi.fn(),
  mockGetRouterParam: vi.fn(),
  mockGetQuery: vi.fn(() => ({})),
}));

vi.mock('h3', () => ({
  defineEventHandler: <T>(h: T) => h,
  readBody: mockReadBody,
  getRouterParam: mockGetRouterParam,
  getQuery: mockGetQuery,
  setResponseStatus: vi.fn(),
}));

const mockStore = {
  listFindings: vi.fn(),
  getFinding: vi.fn(),
  acknowledgeFinding: vi.fn(),
  dismissFinding: vi.fn(),
};

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: vi.fn(() => ({ store: mockStore })),
  buildAuthorizationInfo: vi.fn(() => ({ actorId: 'test-actor', capability: 'observe', allowed: true })),
  getActorId: vi.fn(() => 'test-actor'),
  sanitizeError: vi.fn((e, r, c, ret) => ({ code: c, message: String(e), retryable: ret })),
  okEnvelope: (r) => ({ schemaVersion: '1', requestId: 'tr', status: 'ok', result: r, error: null }),
  errorEnvelope: (c, m) => ({ schemaVersion: '1', requestId: 'tr', status: 'error', error: { code: c, message: m, retryable: false } }),
}));

import listHandler from '../../server/api/findings/index.get';
import detailHandler from '../../server/api/findings/[id].get';
import ackHandler from '../../server/api/findings/[id]/acknowledge.post';
import dismissHandler from '../../server/api/findings/[id]/dismiss.post';

const SAMPLE_FINDING = { id: 'f_001', budgetId: 'b_001', classification: 'budget_risk', description: 'Test', evidence: {}, evidenceRefs: [], severity: 'high', status: 'open', actorId: null, acknowledgedAt: null, acknowledgedBy: null, correctedAt: null, correctedBy: null, correctionRef: null, dismissedAt: null, dismissedBy: null, dismissedReason: null, reopenedAt: null, reopenedBy: null, supersededAt: null, supersededBy: null, supersededReason: null, expiresAt: null, version: 1, createdAt: '2026-07-27T10:00:00Z', updatedAt: '2026-07-27T10:00:00Z' };

describe('GET /api/findings', () => {
  beforeEach(() => { vi.clearAllMocks(); mockGetQuery.mockReturnValue({}); });

  it('must list findings', async () => {
    mockStore.listFindings.mockResolvedValue([SAMPLE_FINDING]);
    const r = await listHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(Array.isArray(r.result)).toBe(true);
    expect(r.result[0].id).toBe('f_001');
  });

  it('must reject invalid status', async () => {
    mockGetQuery.mockReturnValue({ status: 'bogus' });
    const r = await listHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('INVALID_STATUS');
  });
});

describe('GET /api/findings/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('must return a finding by ID', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockStore.getFinding.mockResolvedValue(SAMPLE_FINDING);
    const r = await detailHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.id).toBe('f_001');
  });

  it('must return 404 when not found', async () => {
    mockGetRouterParam.mockReturnValue('f_missing');
    mockStore.getFinding.mockResolvedValue(null);
    const r = await detailHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('FINDING_NOT_FOUND');
  });
});

describe('POST /api/findings/[id]/acknowledge', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('must acknowledge a finding', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    mockStore.acknowledgeFinding.mockResolvedValue({ ...SAMPLE_FINDING, status: 'acknowledged', version: 2 });
    const r = await ackHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('acknowledged');
  });

  it('must reject missing version', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({});
    const r = await ackHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_VERSION');
  });
});

describe('POST /api/findings/[id]/dismiss', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('must dismiss a finding', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, reason: 'Not actionable' });
    mockStore.dismissFinding.mockResolvedValue({ ...SAMPLE_FINDING, status: 'dismissed', version: 2 });
    const r = await dismissHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('dismissed');
  });

  it('must reject missing reason', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    const r = await dismissHandler({ context: { auth: { authenticated: true } } });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_REASON');
  });
});
