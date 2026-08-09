/**
 * TDD: Intelligence route delegation with deterministic protocol/application
 * layer.  Replaces stale tests that unconditionally asserted ANALYSIS_UNAVAILABLE
 * on all nine routes.
 *
 * Covers: data-quality, liquidity, calendar, trends-variance, obligations,
 * income, forecast-accuracy, scenarios, financial-health
 *
 * Categories:
 *   - Deterministic result envelopes when capability exists
 *   - Structured unavailable fallback when capability is absent
 *   - Invalid query validation (scenario JSON parse failure)
 *   - Freshness propagation (via CommandInput)
 *   - Authorization propagation (via envelope auth info)
 *   - Scenario non-mutation (read-only delegation)
 *   - Store unavailable fallback
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock references — accessible in mock factories below
// ---------------------------------------------------------------------------

const {
  mockGetWorkflowStore,
  mockSetResponseStatus,
  mockGetQuery,
  mockBuildAuthorizationInfo,
  mockOkEnvelope,
  mockErrorEnvelope,
  mockGetActorId,
  mockSanitizeError,
  mockEnvelopeMetadata,
  mockWithConnection,
  mockErrorHasCode,
} = vi.hoisted(() => {
  const mockWithConnection = vi.fn(
    async (operation: (connected: { connector: string }) => Promise<unknown>) =>
      operation({ connector: 'mock-ledger' }),
  );
  return {
    mockWithConnection,
    mockErrorHasCode: vi.fn(
      (error: unknown, code: string) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === code,
    ),
    mockEnvelopeMetadata: vi.fn((envelope) => ({
      dataFreshness: envelope.dataFreshness ?? null,
      ...(envelope.scope !== undefined ? { scope: envelope.scope } : {}),
      ...(envelope.semanticClasses !== undefined
        ? { semanticClasses: envelope.semanticClasses }
        : {}),
      ...(envelope.evidence !== undefined ? { evidence: envelope.evidence } : {}),
      ...(envelope.policyVersion !== undefined ? { policyVersion: envelope.policyVersion } : {}),
    })),
    mockGetWorkflowStore: vi.fn(() => ({ store: {} })),
    mockSetResponseStatus: vi.fn(),
    mockGetQuery: vi.fn(() => ({})),
    mockBuildAuthorizationInfo: vi.fn(() => ({
      actorId: 'test-actor',
      capability: 'observe',
      allowed: true,
    })),
    mockOkEnvelope: vi.fn((result, auth, requestId) => ({
      schemaVersion: '1',
      status: 'ok',
      result,
      error: null,
      meta: { auth, requestId },
    })),
    mockErrorEnvelope: vi.fn((code, message, auth, retryable, requestId) => ({
      schemaVersion: '1',
      status: 'error',
      error: { code, message, retryable },
      meta: { auth, requestId },
    })),
    mockGetActorId: vi.fn(() => 'test-actor'),
    mockSanitizeError: vi.fn((err, _requestId, code, retryable) => {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === 'not_connected'
      ) {
        return {
          code: 'not_connected',
          message: 'No ledger connected. Configure an Actual budget first.',
          retryable: true,
        };
      }
      return {
        code,
        message: err instanceof Error ? err.message : String(err),
        retryable,
      };
    }),
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../server/utils/workflow-store', () => ({
  getWorkflowStore: mockGetWorkflowStore,
  getActorId: mockGetActorId,
  buildAuthorizationInfo: mockBuildAuthorizationInfo,
  okEnvelope: mockOkEnvelope,
  errorEnvelope: mockErrorEnvelope,
  envelopeMetadata: mockEnvelopeMetadata,
  sanitizeError: mockSanitizeError,
  errorHasCode: mockErrorHasCode,
}));

vi.mock('h3', () => ({
  defineEventHandler: <T>(h: T) => h,
  getQuery: mockGetQuery,
  setResponseStatus: mockSetResponseStatus,
}));

vi.mock('@balanceframe/application', () => {
  const unconfigured = () => {
    throw new Error(
      'analysis mock not configured for this test — call mockResolvedValue explicitly',
    );
  };
  return {
    createDefaultConnectionManager: vi.fn(() => ({
      restore: vi.fn().mockResolvedValue({ connector: 'mock-ledger' }),
      withConnection: mockWithConnection,
    })),
    createNativeAnalysisProtocol: vi.fn().mockResolvedValue({}),
    dataQualityAnalysis: vi.fn(unconfigured),
    liquidityCoverageAnalysis: vi.fn(unconfigured),
    billCalendarAnalysis: vi.fn(unconfigured),
    budgetVarianceAnalysis: vi.fn(unconfigured),
    irregularObligationsAnalysis: vi.fn(unconfigured),
    incomeReliabilityAnalysis: vi.fn(unconfigured),
    forecastCalibrationAnalysis: vi.fn(unconfigured),
    scenarioComparisonAnalysis: vi.fn(unconfigured),
    multidimensionalHealthAnalysis: vi.fn(unconfigured),
  };
});

// ---------------------------------------------------------------------------
// Imports — these resolve through the mocks above
// ---------------------------------------------------------------------------

import dataQuality from '../../server/api/data-quality.get';
import liquidity from '../../server/api/liquidity.get';
import calendar from '../../server/api/calendar.get';
import trendsVariance from '../../server/api/trends-variance.get';
import obligations from '../../server/api/obligations.get';
import income from '../../server/api/income.get';
import forecastAccuracy from '../../server/api/forecast-accuracy.get';
import scenarios from '../../server/api/scenarios.get';
import financialHealth from '../../server/api/financial-health.get';

import {
  dataQualityAnalysis,
  liquidityCoverageAnalysis,
  billCalendarAnalysis,
  budgetVarianceAnalysis,
  irregularObligationsAnalysis,
  incomeReliabilityAnalysis,
  forecastCalibrationAnalysis,
  scenarioComparisonAnalysis,
  multidimensionalHealthAnalysis,
} from '@balanceframe/application';

// ---------------------------------------------------------------------------
// Handler-to-analysis mapping
// ---------------------------------------------------------------------------

interface HandlerEntry {
  name: string;
  handler: (...args: unknown[]) => unknown;
  analysisFn: (...args: unknown[]) => unknown;
  usesQuery: boolean;
}

const handlerEntries: HandlerEntry[] = [
  { name: 'data-quality', handler: dataQuality, analysisFn: dataQualityAnalysis, usesQuery: false },
  { name: 'liquidity', handler: liquidity, analysisFn: liquidityCoverageAnalysis, usesQuery: true },
  { name: 'calendar', handler: calendar, analysisFn: billCalendarAnalysis, usesQuery: true },
  {
    name: 'trends-variance',
    handler: trendsVariance,
    analysisFn: budgetVarianceAnalysis,
    usesQuery: true,
  },
  {
    name: 'obligations',
    handler: obligations,
    analysisFn: irregularObligationsAnalysis,
    usesQuery: false,
  },
  { name: 'income', handler: income, analysisFn: incomeReliabilityAnalysis, usesQuery: false },
  {
    name: 'forecast-accuracy',
    handler: forecastAccuracy,
    analysisFn: forecastCalibrationAnalysis,
    usesQuery: false,
  },
  {
    name: 'scenarios',
    handler: scenarios,
    analysisFn: scenarioComparisonAnalysis,
    usesQuery: true,
  },
  {
    name: 'financial-health',
    handler: financialHealth,
    analysisFn: multidimensionalHealthAnalysis,
    usesQuery: true,
  },
];

/** Minimal event shape the handlers accept. */
const mockEvent = { context: { auth: { authenticated: true } } };

/** Configure a single analysis mock to return a given envelope. */
function mockAnalysisReturn(entry: HandlerEntry, envelope: unknown) {
  vi.mocked(entry.analysisFn).mockResolvedValue(envelope);
}

/** Build a minimal ok envelope from the analysis layer. */
function okAnalysisEnvelope(result: unknown, overrides: { requestId?: string } = {}) {
  return {
    status: 'ok',
    result,
    error: null,
    requestId: overrides.requestId ?? 'req-test',
    authorization: { capability: 'observe', allowed: true, actorId: 'test-actor' },
  };
}

/** Build a minimal error envelope from the analysis layer. */
function errorAnalysisEnvelope(
  code: string,
  overrides: { message?: string; retryable?: boolean } = {},
) {
  return {
    status: 'error',
    result: null,
    error: {
      code,
      message: overrides.message ?? `Simulated ${code}`,
      retryable: overrides.retryable ?? true,
    },
    requestId: 'req-test',
    authorization: { capability: 'observe', allowed: true, actorId: 'test-actor' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Intelligence route delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetQuery.mockReturnValue({
      baseline: JSON.stringify({ income: 5_000 }),
      comparison: JSON.stringify({ income: 6_000 }),
    });
    mockGetWorkflowStore.mockReturnValue({ store: {} });
    mockWithConnection.mockImplementation(
      async (operation: (connected: { connector: string }) => Promise<unknown>) =>
        operation({ connector: 'mock-ledger' }),
    );

    // Reset every analysis mock to a rejecting default so an unconfigured
    // test fails fast rather than leaking state from a prior test.
    for (const entry of handlerEntries) {
      vi.mocked(entry.analysisFn).mockRejectedValue(
        new Error(`mock not configured for ${entry.name}`),
      );
    }
  });

  describe('missing selected budget classification', () => {
    for (const entry of handlerEntries) {
      it(`GET /api/${entry.name} returns not_connected with HTTP 503`, async () => {
        mockWithConnection.mockRejectedValueOnce(
          Object.assign(new Error('No BalanceFrame connection configured. Run connect first.'), {
            code: 'not_connected',
          }),
        );

        const response = await entry.handler(mockEvent);

        expect(response).toMatchObject({
          status: 'error',
          error: {
            code: 'not_connected',
            message: 'No ledger connected. Configure an Actual budget first.',
            retryable: true,
          },
        });
        expect(mockSetResponseStatus).toHaveBeenCalledWith(mockEvent, 503);
      });
    }
  });

  // -----------------------------------------------------------------------
  // 1. Deterministic result envelopes when capability exists
  // -----------------------------------------------------------------------

  describe('deterministic result envelopes when capability exists', () => {
    for (const entry of handlerEntries) {
      it(`GET /api/${entry.name} returns an ok envelope when analysis succeeds`, async () => {
        const payload = { handled: true, route: entry.name };
        mockAnalysisReturn(entry, okAnalysisEnvelope(payload));

        const r = await entry.handler(mockEvent);

        expect(r).toBeDefined();
        expect(r.status).toBe('ok');
        expect(r.result).toEqual(payload);
        expect(r.error).toBeNull();
        // Confirm the analysis function was called exactly once
        expect(vi.mocked(entry.analysisFn)).toHaveBeenCalledTimes(1);
      });
    }

    it('passes query params to liquidityCoverageAnalysis', async () => {
      mockGetQuery.mockReturnValue({ currentMonth: '2026-07' });
      mockAnalysisReturn(
        handlerEntries[1], // liquidity
        okAnalysisEnvelope({ ratio: 1.5 }),
      );

      await liquidity(mockEvent);

      expect(vi.mocked(liquidityCoverageAnalysis).mock.calls[0][1]).toBe('2026-07');
    });

    it('passes referenceDate to billCalendarAnalysis', async () => {
      mockGetQuery.mockReturnValue({ referenceDate: '2026-08-15' });
      mockAnalysisReturn(
        handlerEntries[2], // calendar
        okAnalysisEnvelope({ events: [] }),
      );

      await calendar(mockEvent);

      expect(vi.mocked(billCalendarAnalysis).mock.calls[0][1]).toBe('2026-08-15');
    });

    it('passes referenceDate to budgetVarianceAnalysis', async () => {
      mockGetQuery.mockReturnValue({ referenceDate: '2026-07' });
      mockAnalysisReturn(
        handlerEntries[3], // trends-variance
        okAnalysisEnvelope({ variance: 0.12 }),
      );

      await trendsVariance(mockEvent);

      expect(vi.mocked(budgetVarianceAnalysis).mock.calls[0][1]).toBe('2026-07');
    });

    it('passes currentMonth to multidimensionalHealthAnalysis', async () => {
      mockGetQuery.mockReturnValue({ currentMonth: '2026-09' });
      mockAnalysisReturn(
        handlerEntries[8], // financial-health
        okAnalysisEnvelope({ health: 'good' }),
      );

      await financialHealth(mockEvent);

      expect(vi.mocked(multidimensionalHealthAnalysis).mock.calls[0][1]).toBe('2026-09');
    });

    it('passes JSON-decoded baseline/comparison to scenarioComparisonAnalysis', async () => {
      const baseline = { income: 5000 };
      const comparison = { income: 6000 };
      mockGetQuery.mockReturnValue({
        baseline: JSON.stringify(baseline),
        comparison: JSON.stringify(comparison),
      });
      mockAnalysisReturn(
        handlerEntries[7], // scenarios
        okAnalysisEnvelope({ differences: [{ field: 'income', delta: 1000 }] }),
      );

      await scenarios(mockEvent);

      const params = vi.mocked(scenarioComparisonAnalysis).mock.calls[0][1] as any;
      expect(params.baseline).toEqual(baseline);
      expect(params.comparison).toEqual(comparison);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Structured unavailable fallback when capability is absent
  // -----------------------------------------------------------------------

  describe('structured unavailable fallback when capability is absent', () => {
    for (const entry of handlerEntries) {
      it(`GET /api/${entry.name} returns no_analysis_protocol error envelope`, async () => {
        mockAnalysisReturn(entry, errorAnalysisEnvelope('no_analysis_protocol'));

        const r = await entry.handler(mockEvent);

        expect(r).toBeDefined();
        expect(r.status).toBe('error');
        expect(r.error?.code).toBe('no_analysis_protocol');
        expect(r.error?.retryable).toBe(true);
        // Handler should set HTTP 503 for no_analysis_protocol
        expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
      });
    }
  });

  describe('client input failures', () => {
    const requiredParameterCases = [
      {
        name: 'liquidity',
        handler: liquidity,
        analysisFn: liquidityCoverageAnalysis,
        code: 'current_month_required',
      },
      {
        name: 'calendar',
        handler: calendar,
        analysisFn: billCalendarAnalysis,
        code: 'reference_date_required',
      },
      {
        name: 'trends-variance',
        handler: trendsVariance,
        analysisFn: budgetVarianceAnalysis,
        code: 'reference_date_required',
      },
      {
        name: 'financial-health',
        handler: financialHealth,
        analysisFn: multidimensionalHealthAnalysis,
        code: 'current_month_required',
      },
    ];

    for (const entry of requiredParameterCases) {
      it(`maps lowercase ${entry.name} required-parameter errors to HTTP 400`, async () => {
        vi.mocked(entry.analysisFn).mockResolvedValue(errorAnalysisEnvelope(entry.code));

        const response = await entry.handler(mockEvent);

        expect(response).toMatchObject({ status: 'error', error: { code: entry.code } });
        expect(mockSetResponseStatus).toHaveBeenCalledWith(mockEvent, 400);
      });
    }

    it('rejects missing scenario payloads before opening a ledger connection', async () => {
      mockGetQuery.mockReturnValue({});

      const response = await scenarios(mockEvent);

      expect(response).toMatchObject({
        status: 'error',
        error: { code: 'scenario_params_required', retryable: false },
      });
      expect(mockSetResponseStatus).toHaveBeenCalledWith(mockEvent, 400);
      expect(mockWithConnection).not.toHaveBeenCalled();
      expect(vi.mocked(scenarioComparisonAnalysis)).not.toHaveBeenCalled();
    });

    it('rejects scenario payloads that are not JSON objects before opening a connection', async () => {
      mockGetQuery.mockReturnValue({ baseline: '[]', comparison: '{}' });

      const response = await scenarios(mockEvent);

      expect(response).toMatchObject({
        status: 'error',
        error: { code: 'INVALID_SCENARIO_PARAMS', retryable: false },
      });
      expect(mockSetResponseStatus).toHaveBeenCalledWith(mockEvent, 400);
      expect(mockWithConnection).not.toHaveBeenCalled();
      expect(vi.mocked(scenarioComparisonAnalysis)).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 3. Invalid query validation
  // -----------------------------------------------------------------------

  describe('invalid query validation', () => {
    it('returns INVALID_SCENARIO_PARAMS when baseline JSON is malformed', async () => {
      mockGetQuery.mockReturnValue({
        baseline: '{invalid json',
        comparison: '{}',
      });

      const r = await scenarios(mockEvent);

      expect(r.status).toBe('error');
      expect(r.error?.code).toBe('INVALID_SCENARIO_PARAMS');
      expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 400);
      // The analysis function must NOT have been called
      expect(vi.mocked(scenarioComparisonAnalysis)).not.toHaveBeenCalled();
    });

    it('returns INVALID_SCENARIO_PARAMS when comparison JSON is malformed', async () => {
      mockGetQuery.mockReturnValue({
        baseline: '{}',
        comparison: '[unclosed',
      });

      const r = await scenarios(mockEvent);

      expect(r.status).toBe('error');
      expect(r.error?.code).toBe('INVALID_SCENARIO_PARAMS');
      expect(vi.mocked(scenarioComparisonAnalysis)).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 4. Freshness propagation
  // -----------------------------------------------------------------------

  describe('freshness propagation', () => {
    for (const entry of handlerEntries) {
      it(`GET /api/${entry.name} passes freshness field in the CommandInput`, async () => {
        mockAnalysisReturn(entry, okAnalysisEnvelope({ ok: true }));

        await entry.handler(mockEvent);

        const input = vi.mocked(entry.analysisFn).mock.calls[0][0] as any;
        expect(input).toBeDefined();
        expect(input).toHaveProperty('freshness', null);
        expect(input).toHaveProperty('mode', 'observe');
      });
    }
  });

  // -----------------------------------------------------------------------
  // 5. Authorization propagation
  // -----------------------------------------------------------------------

  describe('authorization propagation', () => {
    it('calls buildAuthorizationInfo with observe capability for every route', async () => {
      for (const entry of handlerEntries) {
        mockAnalysisReturn(entry, okAnalysisEnvelope({ ok: true }));
        await entry.handler(mockEvent);
      }

      // Each handler calls buildAuthorizationInfo exactly once
      expect(mockBuildAuthorizationInfo).toHaveBeenCalledTimes(handlerEntries.length);
      for (const call of mockBuildAuthorizationInfo.mock.calls) {
        expect(call[1]).toBe('observe');
      }
    });

    it('includes auth info in ok response envelopes', async () => {
      mockAnalysisReturn(handlerEntries[0], okAnalysisEnvelope({ score: 85 }));

      const r = await dataQuality(mockEvent);

      expect(r.meta?.auth).toBeDefined();
      expect(r.meta?.auth.capability).toBe('observe');
      expect(r.meta?.auth.allowed).toBe(true);
    });

    it('includes auth info in error response envelopes', async () => {
      mockAnalysisReturn(handlerEntries[0], errorAnalysisEnvelope('no_analysis_protocol'));

      const r = await dataQuality(mockEvent);

      expect(r.meta?.auth).toBeDefined();
      expect(r.meta?.auth.capability).toBe('observe');
    });
  });

  // -----------------------------------------------------------------------
  // 6. Scenario non-mutation (read-only)
  // -----------------------------------------------------------------------

  describe('scenario non-mutation (read-only)', () => {
    it('delegates only to scenarioComparisonAnalysis — no other application fn', async () => {
      mockGetQuery.mockReturnValue({
        baseline: '{"income":5000}',
        comparison: '{"income":6000}',
      });
      mockAnalysisReturn(
        handlerEntries[7], // scenarios
        okAnalysisEnvelope({ differences: [] }),
      );

      await scenarios(mockEvent);

      // Only the scenario analysis function must have been called
      expect(vi.mocked(scenarioComparisonAnalysis)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(dataQualityAnalysis)).not.toHaveBeenCalled();
      expect(vi.mocked(liquidityCoverageAnalysis)).not.toHaveBeenCalled();
      expect(vi.mocked(billCalendarAnalysis)).not.toHaveBeenCalled();
      expect(vi.mocked(budgetVarianceAnalysis)).not.toHaveBeenCalled();
      expect(vi.mocked(irregularObligationsAnalysis)).not.toHaveBeenCalled();
      expect(vi.mocked(incomeReliabilityAnalysis)).not.toHaveBeenCalled();
      expect(vi.mocked(forecastCalibrationAnalysis)).not.toHaveBeenCalled();
      expect(vi.mocked(multidimensionalHealthAnalysis)).not.toHaveBeenCalled();
    });

    it('does not call setResponseStatus on success (read-only path)', async () => {
      mockGetQuery.mockReturnValue({
        baseline: '{"income":5000}',
        comparison: '{"income":6000}',
      });
      mockAnalysisReturn(handlerEntries[7], okAnalysisEnvelope({ differences: [] }));

      mockSetResponseStatus.mockClear();
      await scenarios(mockEvent);

      // On success the handler returns okEnvelope directly without setting status
      expect(mockSetResponseStatus).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 7. Store unavailable fallback
  // -----------------------------------------------------------------------

  describe('store unavailable fallback', () => {
    for (const entry of handlerEntries) {
      it(`GET /api/${entry.name} returns STORE_UNAVAILABLE when store fails`, async () => {
        mockGetWorkflowStore.mockReturnValueOnce({ error: 'DB locked' });

        const r = await entry.handler(mockEvent);

        expect(r.status).toBe('error');
        expect(r.error?.code).toBe('STORE_UNAVAILABLE');
        expect(mockSetResponseStatus).toHaveBeenCalledWith(expect.anything(), 503);
        // Analysis function must NOT be called when store is unavailable
        expect(vi.mocked(entry.analysisFn)).not.toHaveBeenCalled();
      });
    }
  });
});
