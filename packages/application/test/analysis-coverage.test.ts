import { describe, expect, it } from 'vitest';
import {
  auditQueryAnalysis,
  billCalendarAnalysis,
  budgetVarianceAnalysis,
  forecastCalibrationAnalysis,
  incomeReliabilityAnalysis,
  irregularObligationsAnalysis,
  liquidityCoverageAnalysis,
  multidimensionalHealthAnalysis,
  proposalListAnalysis,
  proposalShowAnalysis,
  purchaseEvaluationAnalysis,
  ruleCreateAnalysis,
  ruleListAnalysis,
  ruleShowAnalysis,
  ruleUpdateAnalysis,
  savedViewCreateAnalysis,
  savedViewsListAnalysis,
  scenarioComparisonAnalysis,
  sinkingFundHealthAnalysis,
} from '../src/analysis';
import type {
  AnalysisProtocol,
  CommandInput,
  ScenarioComparisonParams,
} from '../src/commands';
import type { LiquidityService } from '../src/liquidity-service';

function baseInput(overrides: Partial<CommandInput> = {}): CommandInput {
  return {
    args: [],
    mode: 'reviewAndApply',
    actorId: 'usr_analysis_coverage',
    requestId: 'req_analysis_coverage',
    ledger: { snapshotId: 'snapshot-2026-07' },
    freshness: null,
    ...overrides,
  };
}

/**
 * The mandatory protocol methods are intentionally unreachable in this file;
 * each test installs the public operation it is exercising. Keeping these
 * methods explicit makes an accidental call fail loudly rather than returning
 * a fixture that could hide a routing error.
 */
function protocol(overrides: Partial<AnalysisProtocol> = {}): AnalysisProtocol {
  const base: AnalysisProtocol = {
    async pendingReview() {
      throw new Error('pendingReview is not part of this scenario');
    },
    async reviewShow() {
      throw new Error('reviewShow is not part of this scenario');
    },
    async budgetSummary() {
      throw new Error('budgetSummary is not part of this scenario');
    },
  };
  return Object.assign(base, overrides);
}

const staleFreshness = {
  actualDownloadedAt: '2026-06-01T00:00:00Z',
  bankSyncedAt: null,
  pendingTransactionsIncluded: false,
  stalenessDays: 30,
  isStale: true,
};

describe('purchase evaluation analysis', () => {

  it('reports a refreshable error when the selected budget cannot evaluate a purchase', async () => {
    const service = {
      async evaluatePurchase() {
        throw new Error('selected budget is unavailable');
      },
    };
    const input = baseInput({
      liquidity: {
        // This fixture implements the public method used at the application boundary.
        service: service as unknown as LiquidityService,
        budgetId: 'budget-primary',
      },
    });

    const envelope = await purchaseEvaluationAnalysis(input, {
      categoryId: 'cat_food',
      amount: { minorUnits: '2000', currency: 'USD' },
      accountId: 'checking',
    });

    expect(envelope.status).toBe('error');
    expect(envelope.error).toMatchObject({
      code: 'liquidity_unavailable',
      retryable: true,
      reasonCodes: ['liquidity_refresh_required'],
    });
    expect(envelope.error?.message).toContain('selected budget is unavailable');
    expect(envelope.authorization?.capability).toBe('observe');
  });
});

describe('proposal and audit read analysis', () => {

  it('turns provider failures into actionable analysis errors for each read endpoint', async () => {
    const input = baseInput({
      analysisProtocol: protocol({
        async proposalShow() {
          throw new Error('proposal detail unavailable');
        },
        async proposalList() {
          throw new Error('proposal list unavailable');
        },
        async auditQuery() {
          throw new Error('audit service unavailable');
        },
      }),
    });

    const errors = await Promise.all([
      proposalShowAnalysis(input, 'proposal-missing'),
      proposalListAnalysis(input),
      auditQueryAnalysis(input),
    ]);

    expect(errors.map((envelope) => envelope.error?.code)).toEqual([
      'analysis_failed',
      'analysis_failed',
      'analysis_failed',
    ]);
    expect(errors.map((envelope) => envelope.error?.retryable)).toEqual([true, true, true]);
    expect(errors[0].error?.message).toContain('proposal detail unavailable');
    expect(errors[2].error?.message).toContain('audit service unavailable');
  });

  it('rejects missing ledger, stale snapshots, and unsupported read methods', async () => {
    const readCalls = [
      {
        call: (input: CommandInput) => proposalShowAnalysis(input, 'proposal-001'),
        staleCode: 'proposal_stale',
      },
      { call: (input: CommandInput) => proposalListAnalysis(input), staleCode: 'proposal_stale' },
      { call: (input: CommandInput) => auditQueryAnalysis(input), staleCode: 'stale_snapshot' },
    ];
    const workingProtocol = protocol({
      async proposalShow() {
        throw new Error('proposal show should be blocked by the guard');
      },
      async proposalList() {
        throw new Error('proposal list should be blocked by the guard');
      },
      async auditQuery() {
        throw new Error('audit query should be blocked by the guard');
      },
    });

    for (const { call, staleCode } of readCalls) {
      const disconnected = await call(baseInput({ ledger: null, analysisProtocol: workingProtocol }));
      expect(disconnected.error?.code).toBe('not_connected');

      const stale = await call(baseInput({ analysisProtocol: workingProtocol, freshness: staleFreshness }));
      expect(stale.error?.code).toBe(staleCode);

      const unsupported = await call(baseInput({ analysisProtocol: protocol() }));
      expect(unsupported.error?.code).toBe('no_analysis_protocol');
    }
  });
});

describe('rule analysis workflows', () => {
  it('rejects rule reads and mutations when disconnected, stale, or protocol-backed behavior is unavailable', async () => {
    const calls = [
      { call: (input: CommandInput) => ruleCreateAnalysis(input), staleCode: 'rule_create_stale' },
      { call: (input: CommandInput) => ruleListAnalysis(input), staleCode: 'rule_stale' },
      {
        call: (input: CommandInput) => ruleShowAnalysis(input, 'rule-001'),
        staleCode: 'rule_stale',
      },
      { call: (input: CommandInput) => ruleUpdateAnalysis(input), staleCode: 'rule_update_stale' },
    ];

    for (const { call, staleCode } of calls) {
      const disconnected = await call(baseInput({ ledger: null, analysisProtocol: protocol() }));
      expect(disconnected.error?.code).toBe('not_connected');

      const stale = await call(
        baseInput({ analysisProtocol: protocol(), freshness: staleFreshness }),
      );
      expect(stale.error?.code).toBe(staleCode);

      const unsupported = await call(baseInput());
      expect(unsupported.error?.code).toBe('no_analysis_protocol');
    }
  });

  it('preserves a ledger read failure for list and show as an analysis error', async () => {
    const brokenLedger = {
      async listRules() {
        throw new Error('rule snapshot unavailable');
      },
    };
    const input = baseInput({ ledger: brokenLedger, analysisProtocol: protocol() });

    const listed = await ruleListAnalysis(input);
    const shown = await ruleShowAnalysis(input, 'rule-groceries');

    expect(listed.error?.code).toBe('analysis_failed');
    expect(listed.error?.message).toContain('rule snapshot unavailable');
    expect(shown.error?.code).toBe('analysis_failed');
    expect(shown.error?.retryable).toBe(true);
  });

  it('blocks rule mutations in observe mode before protocol execution', async () => {
    const input = baseInput({
      mode: 'observe',
      analysisProtocol: protocol({
        async ruleCreate() {
          throw new Error('must not execute');
        },
        async ruleUpdate() {
          throw new Error('must not execute');
        },
      }),
    });

    const created = await ruleCreateAnalysis(input);
    const updated = await ruleUpdateAnalysis(input);

    expect(created.error?.code).toBe('write_rejected');
    expect(created.error?.reasonCodes).toContain('observe_mode_write_blocked');
    expect(updated.error?.code).toBe('write_rejected');
    expect(updated.error?.reasonCodes).toContain('observe_mode_write_blocked');
  });

  it('reports unavailable rule mutation methods and provider failures', async () => {
    const unsupportedInput = baseInput({ analysisProtocol: protocol() });
    expect((await ruleCreateAnalysis(unsupportedInput)).error?.code).toBe('no_analysis_protocol');
    expect((await ruleUpdateAnalysis(unsupportedInput)).error?.code).toBe('no_analysis_protocol');

    const failingInput = baseInput({
      analysisProtocol: protocol({
        async ruleCreate() {
          throw new Error('rule proposal rejected');
        },
        async ruleUpdate() {
          throw new Error('rule update rejected');
        },
      }),
    });
    const created = await ruleCreateAnalysis(failingInput);
    const updated = await ruleUpdateAnalysis(failingInput);

    expect(created.error).toMatchObject({ code: 'analysis_failed', retryable: false });
    expect(created.error?.message).toContain('rule proposal rejected');
    expect(updated.error).toMatchObject({ code: 'analysis_failed', retryable: false });
    expect(updated.error?.message).toContain('rule update rejected');
  });
});

type SavedViewPersistenceInput = {
  name: string;
  viewType: string;
  scope: Record<string, unknown>;
  sort?: string;
  actorId: string;
};

describe('saved-view persistence analysis', () => {

  it('returns stable validation and persistence errors from the store path', async () => {
    let createCalled = false;
    const store = {
      async listSavedViews(_actorId: string): Promise<never> {
        throw new Error('saved-view database unavailable');
      },
      async createSavedView(_params: SavedViewPersistenceInput): Promise<never> {
        createCalled = true;
        throw new Error('saved-view write unavailable');
      },
    };
    const input = baseInput({
      ledger: null,
      // Deliberately narrow store double: this test exercises only the saved-view boundary.
      workflowStore: store as unknown as CommandInput['workflowStore'],
    });

    const missingName = await savedViewCreateAnalysis(input, {
      name: '',
      viewType: 'attention',
      scope: {},
    });
    const listed = await savedViewsListAnalysis(input);
    const created = await savedViewCreateAnalysis(input, {
      name: 'Should fail',
      viewType: 'attention',
      scope: {},
    });

    expect(missingName.error?.code).toBe('view_params_required');
    expect(listed.error).toMatchObject({
      code: 'store_failed',
      retryable: true,
      reasonCodes: ['store_error'],
    });
    expect(listed.error?.message).toContain('saved-view database unavailable');
    expect(created.error).toMatchObject({ code: 'store_failed', retryable: true });
    expect(created.error?.message).toContain('saved-view write unavailable');
    expect(createCalled).toBe(true);
  });
});

describe('Phase 8 deterministic analysis handlers', () => {

  it('enforces required date/month and scenario parameters before native analysis', async () => {
    const input = baseInput({
      analysisProtocol: protocol({
        async liquidityCoverage() {
          throw new Error('liquidity should be blocked by params');
        },
        async billCalendar() {
          throw new Error('calendar should be blocked by params');
        },
        async budgetVariance() {
          throw new Error('variance should be blocked by params');
        },
        async scenarioComparison() {
          throw new Error('scenario should be blocked by params');
        },
        async multidimensionalHealth() {
          throw new Error('health should be blocked by params');
        },
      }),
    });

    expect((await liquidityCoverageAnalysis(input, '')).error?.code).toBe('current_month_required');
    expect((await billCalendarAnalysis(input, '')).error?.code).toBe('reference_date_required');
    expect((await budgetVarianceAnalysis(input, '')).error?.code).toBe('reference_date_required');
    // Deliberately malformed runtime payload; the handler must reject it before protocol use.
    const incompleteScenario = {
      baseline: {},
      comparison: undefined,
    } as unknown as ScenarioComparisonParams;
    expect((await scenarioComparisonAnalysis(input, incompleteScenario)).error?.code).toBe(
      'scenario_params_required',
    );
    expect((await multidimensionalHealthAnalysis(input, '')).error?.code).toBe(
      'current_month_required',
    );
  });

  it('blocks every Phase 8 endpoint at disconnected, stale, and unsupported-protocol boundaries', async () => {
    const calls = [
      (input: CommandInput) => sinkingFundHealthAnalysis(input),
      (input: CommandInput) => liquidityCoverageAnalysis(input, '2026-08'),
      (input: CommandInput) => billCalendarAnalysis(input, '2026-07-27'),
      (input: CommandInput) => budgetVarianceAnalysis(input, '2026-07-27'),
      (input: CommandInput) => irregularObligationsAnalysis(input),
      (input: CommandInput) => incomeReliabilityAnalysis(input),
      (input: CommandInput) => forecastCalibrationAnalysis(input),
      (input: CommandInput) =>
        scenarioComparisonAnalysis(input, { baseline: {}, comparison: {} }),
      (input: CommandInput) => multidimensionalHealthAnalysis(input, '2026-08'),
    ];

    for (const call of calls) {
      const disconnected = await call(baseInput({ ledger: null, analysisProtocol: protocol() }));
      expect(disconnected.error?.code).toBe('not_connected');

      const stale = await call(
        baseInput({ analysisProtocol: protocol(), freshness: staleFreshness }),
      );
      expect(stale.error?.code).toBe('stale_budget_intelligence');

      const unsupported = await call(baseInput({ analysisProtocol: protocol() }));
      expect(unsupported.error?.code).toBe('no_analysis_protocol');
    }
  });

  it('turns native analysis failures into retryable analysis errors', async () => {
    const input = baseInput({
      analysisProtocol: protocol({
        async sinkingFundHealth() {
          throw new Error('sinking fund service unavailable');
        },
        async liquidityCoverage() {
          throw new Error('liquidity service unavailable');
        },
        async billCalendar() {
          throw new Error('calendar service unavailable');
        },
        async budgetVariance() {
          throw new Error('variance service unavailable');
        },
        async irregularObligations() {
          throw new Error('obligation service unavailable');
        },
        async incomeReliability() {
          throw new Error('income service unavailable');
        },
        async forecastCalibration() {
          throw new Error('forecast service unavailable');
        },
        async scenarioComparison() {
          throw new Error('scenario service unavailable');
        },
        async multidimensionalHealth() {
          throw new Error('health service unavailable');
        },
      }),
    });

    const errors = await Promise.all([
      sinkingFundHealthAnalysis(input),
      liquidityCoverageAnalysis(input, '2026-08'),
      billCalendarAnalysis(input, '2026-07-27'),
      budgetVarianceAnalysis(input, '2026-07-27'),
      irregularObligationsAnalysis(input),
      incomeReliabilityAnalysis(input),
      forecastCalibrationAnalysis(input),
      scenarioComparisonAnalysis(input, { baseline: {}, comparison: {} }),
      multidimensionalHealthAnalysis(input, '2026-08'),
    ]);

    expect(errors.every((envelope) => envelope.status === 'error')).toBe(true);
    expect(errors.every((envelope) => envelope.error?.code === 'analysis_failed')).toBe(true);
    expect(errors.every((envelope) => envelope.error?.retryable === true)).toBe(true);
    expect(errors.map((envelope) => envelope.error?.message)).toEqual([
      'sinking fund service unavailable',
      'liquidity service unavailable',
      'calendar service unavailable',
      'variance service unavailable',
      'obligation service unavailable',
      'income service unavailable',
      'forecast service unavailable',
      'scenario service unavailable',
      'health service unavailable',
    ]);
  });
});
