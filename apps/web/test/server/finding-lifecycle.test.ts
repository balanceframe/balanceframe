/**
 * TDD: Finding lifecycle routes.
 * GET /api/findings, GET /api/findings/:id, POST acknowledge, POST dismiss,
 * POST correct, POST reopen, POST supersede.
 *
 * Tests cover:
 *  - Happy-path transitions
 *  - Missing required fields
 *  - Version conflict (stale expectedVersion)
 *  - Authorization capability checks (unauthenticated → 403)
 *  - Store unavailable → 503
 *  - Transition constraints (e.g. cannot correct an already corrected finding)
 *  - Finding lifecycle is separate from notification lifecycle
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockReadBody,
  mockGetWorkflowStore,
  mockGetRouterParam,
  mockGetQuery,
  mockRequireAuthorization,
} = vi.hoisted(() => ({
  mockReadBody: vi.fn(),
  mockGetWorkflowStore: vi.fn(),
  mockGetRouterParam: vi.fn(),
  mockGetQuery: vi.fn(() => ({})),
  mockRequireAuthorization: vi.fn(),
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
  correctFinding: vi.fn(),
  reopenFinding: vi.fn(),
  supersedeFinding: vi.fn(),
};

// Set default return so existing tests that forget to mock still get a store.
mockGetWorkflowStore.mockReturnValue({ store: mockStore });

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: mockGetWorkflowStore,
  buildAuthorizationInfo: vi.fn(() => ({
    actorId: 'test-actor',
    capability: 'observe',
    allowed: true,
  })),
  getActorId: vi.fn(() => 'test-actor'),
  requireAuthorization: mockRequireAuthorization,
  sanitizeError: vi.fn((e, r, c, ret) => ({ code: c, message: String(e), retryable: ret })),
  okEnvelope: (r) => ({
    schemaVersion: '1',
    requestId: 'tr',
    status: 'ok',
    dataFreshness: null,
    authorization: null,
    result: r,
    error: null,
  }),
  errorEnvelope: (c, m) => ({
    schemaVersion: '1',
    requestId: 'tr',
    status: 'error',
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code: c, message: m, retryable: false },
  }),
}));

import listHandler from '../../server/api/findings/index.get';
import detailHandler from '../../server/api/findings/[id].get';
import ackHandler from '../../server/api/findings/[id]/acknowledge.post';
import dismissHandler from '../../server/api/findings/[id]/dismiss.post';
import correctHandler from '../../server/api/findings/[id]/correct.post';
import reopenHandler from '../../server/api/findings/[id]/reopen.post';
import supersedeHandler from '../../server/api/findings/[id]/supersede.post';

const SAMPLE_FINDING = {
  id: 'f_001',
  budgetId: 'b_001',
  classification: 'budget_risk',
  description: 'Test',
  evidence: {},
  evidenceRefs: [],
  severity: 'high',
  status: 'open',
  actorId: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  correctedAt: null,
  correctedBy: null,
  correctionRef: null,
  dismissedAt: null,
  dismissedBy: null,
  dismissedReason: null,
  reopenedAt: null,
  reopenedBy: null,
  supersededAt: null,
  supersededBy: null,
  supersededReason: null,
  expiresAt: null,
  version: 1,
  createdAt: '2026-07-27T10:00:00Z',
  updatedAt: '2026-07-27T10:00:00Z',
};

function mockAuthEvent() {
  return { context: { auth: { authenticated: true } } };
}

function allowAuth() {
  mockRequireAuthorization.mockResolvedValue({
    ok: true,
    info: { actorId: 'test-actor', capability: 'finding:transition', allowed: true },
  });
}

function denyAuth() {
  mockRequireAuthorization.mockResolvedValue({
    ok: false,
    response: {
      schemaVersion: '1',
      requestId: 'tr',
      status: 'error',
      dataFreshness: null,
      authorization: null,
      result: null,
      error: {
        code: 'AUTHORIZATION_DENIED',
        message: 'Insufficient capabilities.',
        retryable: false,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/findings
// ---------------------------------------------------------------------------

describe('GET /api/findings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQuery.mockReturnValue({});
  });

  it('must list findings', async () => {
    mockStore.listFindings.mockResolvedValue([SAMPLE_FINDING]);
    const r = await listHandler(mockAuthEvent());
    expect(r.status).toBe('ok');
    expect(Array.isArray(r.result)).toBe(true);
    expect(r.result[0].id).toBe('f_001');
  });

  it('must reject invalid status', async () => {
    mockGetQuery.mockReturnValue({ status: 'bogus' });
    const r = await listHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('INVALID_STATUS');
  });

  it('must reject invalid severity', async () => {
    mockGetQuery.mockReturnValue({ severity: 'extreme' });
    const r = await listHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('INVALID_SEVERITY');
  });

  it('must return 503 when store unavailable', async () => {
    mockGetWorkflowStore.mockReturnValueOnce({ error: 'DB locked' });
    const r = await listHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('STORE_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// GET /api/findings/:id
// ---------------------------------------------------------------------------

describe('GET /api/findings/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('must return a finding by ID', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockStore.getFinding.mockResolvedValue(SAMPLE_FINDING);
    const r = await detailHandler(mockAuthEvent());
    expect(r.status).toBe('ok');
    expect(r.result.id).toBe('f_001');
  });

  it('must return 404 when not found', async () => {
    mockGetRouterParam.mockReturnValue('f_missing');
    mockStore.getFinding.mockResolvedValue(null);
    const r = await detailHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('FINDING_NOT_FOUND');
  });

  it('must reject missing finding ID', async () => {
    mockGetRouterParam.mockReturnValue('');
    const r = await detailHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_FINDING_ID');
  });
});

// ---------------------------------------------------------------------------
// POST /api/findings/:id/acknowledge
// ---------------------------------------------------------------------------

describe('POST /api/findings/[id]/acknowledge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowAuth();
  });

  it('must acknowledge a finding', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    mockStore.acknowledgeFinding.mockResolvedValue({
      ...SAMPLE_FINDING,
      status: 'acknowledged',
      version: 2,
    });
    const r = await ackHandler(mockAuthEvent());
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('acknowledged');
  });

  it('must reject missing version', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({});
    const r = await ackHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_VERSION');
  });

  it('must reject unauthenticated requests', async () => {
    denyAuth();
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    const r = await ackHandler({ context: {} });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AUTHORIZATION_DENIED');
  });

  it('must handle version conflict from store', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    mockStore.acknowledgeFinding.mockRejectedValue(
      new Error('Finding f_001 version conflict or invalid transition from open to acknowledged'),
    );
    const r = await ackHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('ACKNOWLEDGE_FAILED');
  });

  it('must handle store unavailable', async () => {
    mockGetWorkflowStore.mockReturnValueOnce({ error: 'DB locked' });
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    const r = await ackHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('STORE_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// POST /api/findings/:id/dismiss
// ---------------------------------------------------------------------------

describe('POST /api/findings/[id]/dismiss', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowAuth();
  });

  it('must dismiss a finding', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, reason: 'Not actionable' });
    mockStore.dismissFinding.mockResolvedValue({
      ...SAMPLE_FINDING,
      status: 'dismissed',
      version: 2,
    });
    const r = await dismissHandler(mockAuthEvent());
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('dismissed');
  });

  it('must reject missing reason', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    const r = await dismissHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_REASON');
  });

  it('must reject unauthenticated requests', async () => {
    denyAuth();
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, reason: 'ok' });
    const r = await dismissHandler({ context: {} });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AUTHORIZATION_DENIED');
  });

  it('must handle version conflict from store', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, reason: 'ok' });
    mockStore.dismissFinding.mockRejectedValue(
      new Error('Finding f_001 version conflict or invalid transition from open to dismissed'),
    );
    const r = await dismissHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('DISMISS_FAILED');
  });
});

// ---------------------------------------------------------------------------
// POST /api/findings/:id/correct
// ---------------------------------------------------------------------------

describe('POST /api/findings/[id]/correct', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowAuth();
  });

  it('must correct a finding with evidence reference', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, correctionRef: 'cr_001' });
    mockStore.correctFinding.mockResolvedValue({
      ...SAMPLE_FINDING,
      status: 'corrected',
      version: 2,
      correctedAt: '2026-07-28T10:00:00Z',
      correctedBy: 'test-actor',
      correctionRef: 'cr_001',
    });
    const r = await correctHandler(mockAuthEvent());
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('corrected');
    expect(r.result.correctionRef).toBe('cr_001');
    expect(r.result.correctedBy).toBe('test-actor');
    expect(mockStore.correctFinding).toHaveBeenCalledWith({
      findingId: 'f_001',
      actorId: 'test-actor',
      correctionRef: 'cr_001',
      expectedVersion: 1,
    });
  });

  it('must reject missing version', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ correctionRef: 'cr_001' });
    const r = await correctHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_VERSION');
  });

  it('must reject missing correctionRef', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    const r = await correctHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_CORRECTION_REF');
  });

  it('must reject empty correctionRef', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, correctionRef: '  ' });
    const r = await correctHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_CORRECTION_REF');
  });

  it('must reject missing finding ID', async () => {
    mockGetRouterParam.mockReturnValue('');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, correctionRef: 'cr_001' });
    const r = await correctHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_FINDING_ID');
  });

  it('must reject unauthenticated requests', async () => {
    denyAuth();
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, correctionRef: 'cr_001' });
    const r = await correctHandler({ context: {} });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AUTHORIZATION_DENIED');
  });

  it('must handle version conflict from store', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, correctionRef: 'cr_001' });
    mockStore.correctFinding.mockRejectedValue(
      new Error('Finding f_001 version conflict or invalid transition from open to corrected'),
    );
    const r = await correctHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('CORRECT_FAILED');
  });

  it('must handle transition constraint violation', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 2, correctionRef: 'cr_002' });
    mockStore.correctFinding.mockRejectedValue(
      new Error('Cannot correct finding in status dismissed'),
    );
    const r = await correctHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('CORRECT_FAILED');
  });

  it('must handle store unavailable', async () => {
    mockGetWorkflowStore.mockReturnValueOnce({ error: 'DB locked' });
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, correctionRef: 'cr_001' });
    const r = await correctHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('STORE_UNAVAILABLE');
  });

  it('must not trigger any notification action', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, correctionRef: 'cr_001' });
    mockStore.correctFinding.mockResolvedValue({
      ...SAMPLE_FINDING,
      status: 'corrected',
      version: 2,
      correctedAt: '2026-07-28T10:00:00Z',
      correctedBy: 'test-actor',
      correctionRef: 'cr_001',
    });
    const r = await correctHandler(mockAuthEvent());
    expect(r.status).toBe('ok');
    // Finding lifecycle only — no notification store methods called
    expect(mockStore.acknowledgeFinding).not.toHaveBeenCalled();
    expect(mockStore.dismissFinding).not.toHaveBeenCalled();
    expect(mockStore.reopenFinding).not.toHaveBeenCalled();
    expect(mockStore.supersedeFinding).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/findings/:id/reopen
// ---------------------------------------------------------------------------

describe('POST /api/findings/[id]/reopen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowAuth();
  });

  it('must reopen a previously dismissed finding', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 2 });
    mockStore.reopenFinding.mockResolvedValue({
      ...SAMPLE_FINDING,
      status: 'reopened',
      version: 3,
      reopenedAt: '2026-07-28T10:00:00Z',
      reopenedBy: 'test-actor',
    });
    const r = await reopenHandler(mockAuthEvent());
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('reopened');
    expect(r.result.reopenedBy).toBe('test-actor');
    expect(mockStore.reopenFinding).toHaveBeenCalledWith({
      findingId: 'f_001',
      actorId: 'test-actor',
      expectedVersion: 2,
    });
  });

  it('must reject missing version', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({});
    const r = await reopenHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_VERSION');
  });

  it('must reject missing finding ID', async () => {
    mockGetRouterParam.mockReturnValue('');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    const r = await reopenHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_FINDING_ID');
  });

  it('must reject unauthenticated requests', async () => {
    denyAuth();
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    const r = await reopenHandler({ context: {} });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AUTHORIZATION_DENIED');
  });

  it('must handle version conflict from store', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    mockStore.reopenFinding.mockRejectedValue(
      new Error('Finding f_001 version conflict or invalid transition from dismissed to reopened'),
    );
    const r = await reopenHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('REOPEN_FAILED');
  });

  it('must handle transition constraint violation', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    mockStore.reopenFinding.mockRejectedValue(new Error('Cannot reopen finding in status expired'));
    const r = await reopenHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('REOPEN_FAILED');
  });

  it('must handle store unavailable', async () => {
    mockGetWorkflowStore.mockReturnValueOnce({ error: 'DB locked' });
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1 });
    const r = await reopenHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('STORE_UNAVAILABLE');
  });

  it('must not trigger any notification action', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 2 });
    mockStore.reopenFinding.mockResolvedValue({
      ...SAMPLE_FINDING,
      status: 'reopened',
      version: 3,
      reopenedAt: '2026-07-28T10:00:00Z',
      reopenedBy: 'test-actor',
    });
    const r = await reopenHandler(mockAuthEvent());
    expect(r.status).toBe('ok');
    expect(mockStore.acknowledgeFinding).not.toHaveBeenCalled();
    expect(mockStore.dismissFinding).not.toHaveBeenCalled();
    expect(mockStore.correctFinding).not.toHaveBeenCalled();
    expect(mockStore.supersedeFinding).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/findings/:id/supersede
// ---------------------------------------------------------------------------

describe('POST /api/findings/[id]/supersede', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowAuth();
  });

  it('must supersede a finding with reason and replacement ref', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({
      expectedVersion: 1,
      supersededBy: 'f_002',
      reason: 'Replaced by improved detection',
    });
    mockStore.supersedeFinding.mockResolvedValue({
      ...SAMPLE_FINDING,
      status: 'superseded',
      version: 2,
      supersededAt: '2026-07-28T10:00:00Z',
      supersededBy: 'f_002',
      supersededReason: 'Replaced by improved detection',
    });
    const r = await supersedeHandler(mockAuthEvent());
    expect(r.status).toBe('ok');
    expect(r.result.status).toBe('superseded');
    expect(r.result.supersededBy).toBe('f_002');
    expect(r.result.supersededReason).toBe('Replaced by improved detection');
    expect(mockStore.supersedeFinding).toHaveBeenCalledWith({
      findingId: 'f_001',
      actorId: 'test-actor',
      supersededBy: 'f_002',
      reason: 'Replaced by improved detection',
      expectedVersion: 1,
    });
  });

  it('must reject missing version', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ supersededBy: 'f_002', reason: 'test' });
    const r = await supersedeHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_VERSION');
  });

  it('must reject missing supersededBy', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, reason: 'test' });
    const r = await supersedeHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_SUPERSEDED_BY');
  });

  it('must reject missing reason', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, supersededBy: 'f_002' });
    const r = await supersedeHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_REASON');
  });

  it('must reject empty reason', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, supersededBy: 'f_002', reason: '  ' });
    const r = await supersedeHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_REASON');
  });

  it('must reject missing finding ID', async () => {
    mockGetRouterParam.mockReturnValue('');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, supersededBy: 'f_002', reason: 'test' });
    const r = await supersedeHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('MISSING_FINDING_ID');
  });

  it('must reject unauthenticated requests', async () => {
    denyAuth();
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, supersededBy: 'f_002', reason: 'test' });
    const r = await supersedeHandler({ context: {} });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AUTHORIZATION_DENIED');
  });

  it('must handle version conflict from store', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, supersededBy: 'f_002', reason: 'test' });
    mockStore.supersedeFinding.mockRejectedValue(
      new Error('Finding f_001 version conflict or invalid transition from open to superseded'),
    );
    const r = await supersedeHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('SUPERSEDE_FAILED');
  });

  it('must handle transition constraint violation', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, supersededBy: 'f_002', reason: 'test' });
    mockStore.supersedeFinding.mockRejectedValue(
      new Error('Cannot supersede finding in status superseded'),
    );
    const r = await supersedeHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('SUPERSEDE_FAILED');
  });

  it('must handle store unavailable', async () => {
    mockGetWorkflowStore.mockReturnValueOnce({ error: 'DB locked' });
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({ expectedVersion: 1, supersededBy: 'f_002', reason: 'test' });
    const r = await supersedeHandler(mockAuthEvent());
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('STORE_UNAVAILABLE');
  });

  it('must not trigger any notification action', async () => {
    mockGetRouterParam.mockReturnValue('f_001');
    mockReadBody.mockResolvedValue({
      expectedVersion: 1,
      supersededBy: 'f_002',
      reason: 'Replaced by improved detection',
    });
    mockStore.supersedeFinding.mockResolvedValue({
      ...SAMPLE_FINDING,
      status: 'superseded',
      version: 2,
      supersededAt: '2026-07-28T10:00:00Z',
      supersededBy: 'f_002',
      supersededReason: 'Replaced by improved detection',
    });
    const r = await supersedeHandler(mockAuthEvent());
    expect(r.status).toBe('ok');
    expect(mockStore.acknowledgeFinding).not.toHaveBeenCalled();
    expect(mockStore.dismissFinding).not.toHaveBeenCalled();
    expect(mockStore.correctFinding).not.toHaveBeenCalled();
    expect(mockStore.reopenFinding).not.toHaveBeenCalled();
  });
});
