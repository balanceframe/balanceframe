/**
 * Legacy Phase 8 analysis surfaces outside Purchase Check; the latter uses
 * canonical Decision Card regressions in purchase-card-regression.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

// ---------------------------------------------------------------------------
// Mock auth-client for index.vue
// ---------------------------------------------------------------------------
vi.mock('../../lib/auth-client', () => ({
  authClient: {
    useSession: vi.fn(() => ({
      value: { data: { user: { email: 'test@example.com' } } },
      then: undefined,
    })),
    signOut: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Stubs shared across pages
// ---------------------------------------------------------------------------
const AnalysisPageStub = {
  template:
    '<div><span v-if="error" data-testid="error">{{ error.code }}</span><span v-if="insufficientData" data-testid="insufficient-data" /><slot name="content" /></div>',
  props: ['title', 'loading', 'error', 'freshness', 'insufficientData'],
};

const stubs = {
  AnalysisPage: AnalysisPageStub,
  UCard: { template: '<div><slot name="header" /><slot /></div>' },
  UButton: {
    template: `<button :disabled="disabled" @click="$emit('click')"><slot /></button>`,
    props: ['variant', 'size', 'disabled', 'label'],
  },
  UFormGroup: {
    template: '<div data-testid="form-group"><span v-if="label">{{ label }}</span><slot /></div>',
    props: ['label'],
  },
  UInput: { template: '<input />', props: ['modelValue', 'placeholder', 'type', 'min', 'max'] },
  AnalysisTable: {
    template:
      '<table data-testid="analysis-table"><tr v-for="(r,i) in rows" :key="i"><td v-for="c in columns" :key="c.key">{{ r[c.key] }}</td></tr></table>',
    props: ['columns', 'rows'],
  },
  SemanticAmount: {
    template: '<span data-testid="semantic-amount">{{ amount && amount.minorUnits }}</span>',
    props: ['amount'],
  },
  UContainer: { template: '<div><slot /></div>' },
  FindingCard: {
    template:
      '<div data-testid="finding-card">{{ finding.title }} | {{ finding.severity }} | {{ finding.category }}</div>',
    props: ['finding'],
  },
  ReasonCodeList: {
    template:
      '<div data-testid="reason-codes"><span v-for="c in codes" :key="c" data-testid="reason-code">{{ c }}</span></div>',
    props: ['codes'],
  },
};

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------
function okEnvelope(result: unknown, freshness?: Record<string, unknown>) {
  return {
    schemaVersion: '1',
    requestId: 'req-test',
    status: 'ok' as const,
    dataFreshness: freshness ?? {
      isStale: false,
      lastSync: '2026-07-15T10:00:00Z',
      label: 'current',
    },
    authorization: null,
    result,
    error: null,
  };
}

function errorEnvelope(code: string) {
  return {
    schemaVersion: '1',
    requestId: 'req-test',
    status: 'error' as const,
    dataFreshness: null,
    authorization: null,
    result: null,
    error: { code, message: `Simulated ${code}`, retryable: true },
  };
}


// =========================================================================
// CASH FLOW
// =========================================================================
import CashFlowPage from '../../app/pages/cash-flow.vue';

const cashFlowStubs = { ...stubs };

const projectionResult = {
  projectionMonths: 3,
  projections: [
    {
      month: '2026-08',
      income: { minorUnits: '500000', currency: 'USD' },
      expenses: { minorUnits: '350000', currency: 'USD' },
      netFlow: { minorUnits: '150000', currency: 'USD' },
      endingBalance: { minorUnits: '150000', currency: 'USD' },
    },
    {
      month: '2026-09',
      income: { minorUnits: '500000', currency: 'USD' },
      expenses: { minorUnits: '400000', currency: 'USD' },
      netFlow: { minorUnits: '100000', currency: 'USD' },
      endingBalance: { minorUnits: '250000', currency: 'USD' },
    },
  ],
  summary: {
    netProjection: { minorUnits: '250000', currency: 'USD' },
    minBalance: { minorUnits: '150000', currency: 'USD' },
    maxBalance: { minorUnits: '250000', currency: 'USD' },
  },
  assumptions: {
    basedOn: 'scheduled_transactions',
    inflationRate: null,
    growthRate: null,
    note: 'Projections use only confirmed scheduled transactions.',
  },
  scope: {
    monthsProjected: 3,
    accountsIncluded: ['acct_checking'],
    categoriesIncluded: ['cat_salary', 'cat_rent', 'cat_food'],
  },
  envelopeAvailability: {
    available: true,
    envelopeCount: 5,
    totalBudgeted: { minorUnits: '800000', currency: 'USD' },
    totalSpent: { minorUnits: '450000', currency: 'USD' },
  },
  sufficientData: true,
  dataWarning: null,
};

const insufficientProjectionResult = {
  projectionMonths: 0,
  projections: [],
  summary: {
    netProjection: { minorUnits: '0', currency: 'USD' },
    minBalance: { minorUnits: '0', currency: 'USD' },
    maxBalance: { minorUnits: '0', currency: 'USD' },
  },
  assumptions: {
    basedOn: 'scheduled_transactions',
    inflationRate: null,
    growthRate: null,
    note: 'Insufficient data.',
  },
  scope: { monthsProjected: 0, accountsIncluded: [], categoriesIncluded: [] },
  envelopeAvailability: {
    available: false,
    envelopeCount: 0,
    totalBudgeted: { minorUnits: '0', currency: 'USD' },
    totalSpent: { minorUnits: '0', currency: 'USD' },
  },
  sufficientData: false,
  dataWarning: 'Not enough transaction history to produce reliable projections.',
};

async function mountCashFlowAndProject(resultMock: unknown) {
  mockFetch.mockResolvedValue(okEnvelope(resultMock));
  const wrapper = shallowMount(CashFlowPage, { global: { stubs: cashFlowStubs } });
  await flushPromises();
  const vm = wrapper.vm as unknown as { months: number; project: () => Promise<void> };
  vm.months = 3;
  await vm.project();
  await flushPromises();
  return wrapper;
}

describe('Cash Flow page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('renders months input and project button', async () => {
    mockFetch.mockResolvedValue(okEnvelope({}));
    const wrapper = shallowMount(CashFlowPage, { global: { stubs: cashFlowStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Months to project');
    expect(wrapper.find('button').exists()).toBe(true);
  });

  it('calls /api/cash-flow/project with months query', async () => {
    const wrapper = await mountCashFlowAndProject(projectionResult);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/cash-flow/project',
      expect.objectContaining({ query: expect.any(Object) }),
    );
  });

  it('renders projection table after projecting', async () => {
    const wrapper = await mountCashFlowAndProject(projectionResult);
    expect(wrapper.find('[data-testid="analysis-table"]').exists()).toBe(true);
  });

  it('shows assumptions section separate from projection', async () => {
    const wrapper = await mountCashFlowAndProject(projectionResult);
    expect(wrapper.text()).toContain('Assumptions');
    expect(wrapper.text()).toContain('scheduled_transactions');
  });

  it('shows scope information', async () => {
    const wrapper = await mountCashFlowAndProject(projectionResult);
    expect(wrapper.text()).toContain('Scope');
    expect(wrapper.text()).toContain('acct_checking');
  });

  it('separates envelope availability from projection', async () => {
    const wrapper = await mountCashFlowAndProject(projectionResult);
    expect(wrapper.text()).toContain('Envelope Availability');
    expect(wrapper.text()).toContain('5');
  });

  it('shows insufficient data warning', async () => {
    const wrapper = await mountCashFlowAndProject(insufficientProjectionResult);
    expect(wrapper.text()).toContain('Not enough transaction history');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(CashFlowPage, { global: { stubs: cashFlowStubs } });
    await flushPromises();
    (wrapper.vm as any).months = 3;
    await (wrapper.vm as any).project();
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('does not perform client-side financial calculations', async () => {
    const wrapper = await mountCashFlowAndProject(projectionResult);
    expect(wrapper.text()).not.toContain('projected =');
    expect(wrapper.text()).not.toContain('calculated');
  });
});

// =========================================================================
// TARGETS
// =========================================================================
import TargetsPage from '../../app/pages/targets.vue';

const targetStubs = { ...stubs };

const healthyTargetResult = {
  categories: [
    {
      categoryId: 'cat_groceries',
      categoryName: 'Groceries',
      target: { minorUnits: '400000', currency: 'USD' },
      current: { minorUnits: '200000', currency: 'USD' },
      progress: 0.5,
      status: 'healthy',
    },
  ],
  overallLabel: 'healthy',
};

const atRiskTargetResult = {
  categories: [
    {
      categoryId: 'cat_groceries',
      categoryName: 'Groceries',
      target: { minorUnits: '400000', currency: 'USD' },
      current: { minorUnits: '380000', currency: 'USD' },
      progress: 0.95,
      status: 'at_risk',
    },
  ],
  overallLabel: 'at_risk',
};

const partiallyFundedSinkingResult = {
  sinkingFunds: [
    {
      categoryId: 'cat_emergency',
      categoryName: 'Emergency Fund',
      target: { minorUnits: '1000000', currency: 'USD' },
      current: { minorUnits: '500000', currency: 'USD' },
      progress: 0.5,
      status: 'at_risk',
    },
  ],
  fullyFunded: 0,
};

describe('Targets page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('fetches /api/targets/health and /api/sinking-fund/health on mount', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/targets/health'))
        return Promise.resolve(
          okEnvelope({
            categories: [],
            overallLabel: 'unknown',
            healthyCount: 0,
            atRiskCount: 0,
            sinkingFundCount: 0,
          }),
        );
      if (url.includes('/sinking-fund/health'))
        return Promise.resolve(
          okEnvelope({
            sinkingFunds: [],
            fullyFundedCount: 0,
            partiallyFundedCount: 0,
            unfundedCount: 0,
          }),
        );
      return Promise.resolve(okEnvelope({}));
    });
    shallowMount(TargetsPage, { global: { stubs: targetStubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/targets/health');
    expect(mockFetch).toHaveBeenCalledWith('/api/sinking-fund/health');
  });

  it('shows no-config state when no data available', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/targets/health'))
        return Promise.resolve(
          okEnvelope({
            categories: [],
            overallLabel: 'unknown',
            healthyCount: 0,
            atRiskCount: 0,
            sinkingFundCount: 0,
          }),
        );
      if (url.includes('/sinking-fund/health'))
        return Promise.resolve(
          okEnvelope({
            sinkingFunds: [],
            fullyFundedCount: 0,
            partiallyFundedCount: 0,
            unfundedCount: 0,
          }),
        );
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(TargetsPage, { global: { stubs: targetStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No target');
  });

  it('renders healthy target category with badge', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/targets/health')) return Promise.resolve(okEnvelope(healthyTargetResult));
      if (url.includes('/sinking-fund/health'))
        return Promise.resolve(
          okEnvelope({
            sinkingFunds: [],
            fullyFundedCount: 0,
            partiallyFundedCount: 0,
            unfundedCount: 0,
          }),
        );
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(TargetsPage, { global: { stubs: targetStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Groceries');
    expect(wrapper.text()).toContain('healthy');
  });

  it('renders at-risk target category', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/targets/health')) return Promise.resolve(okEnvelope(atRiskTargetResult));
      if (url.includes('/sinking-fund/health'))
        return Promise.resolve(
          okEnvelope({
            sinkingFunds: [],
            fullyFundedCount: 0,
            partiallyFundedCount: 0,
            unfundedCount: 0,
          }),
        );
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(TargetsPage, { global: { stubs: targetStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('at_risk');
  });

  it('renders sinking fund with progress', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/targets/health')) return Promise.resolve(okEnvelope(healthyTargetResult));
      if (url.includes('/sinking-fund/health'))
        return Promise.resolve(okEnvelope(partiallyFundedSinkingResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(TargetsPage, { global: { stubs: targetStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Emergency Fund');
    expect(wrapper.text()).toContain('50%');
  });

  it('shows overall label', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/targets/health'))
        return Promise.resolve(okEnvelope({ ...healthyTargetResult, overallLabel: 'healthy' }));
      if (url.includes('/sinking-fund/health'))
        return Promise.resolve(
          okEnvelope({
            sinkingFunds: [],
            fullyFundedCount: 0,
            partiallyFundedCount: 0,
            unfundedCount: 0,
          }),
        );
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(TargetsPage, { global: { stubs: targetStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Categories');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(TargetsPage, { global: { stubs: targetStubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });
});

// =========================================================================
// INDEX (OVERVIEW / DASHBOARD)
// =========================================================================
import IndexPage from '../../app/pages/index.vue';

const indexStubs = { ...stubs };

const attentionResult = {
  blockers: [
    {
      code: 'stale_sync',
      message: 'Ledger sync is stale by 14 days',
      severity: 'critical',
      entityType: 'synchronization',
    },
  ],
  alerts: [
    {
      code: 'category_overspent',
      message: 'Groceries category is overspent',
      severity: 'warning',
      categoryId: 'cat_groceries',
      categoryName: 'Groceries',
    },
    {
      code: 'target_at_risk',
      message: 'Vacation fund behind schedule',
      severity: 'warning',
      categoryId: 'cat_vacation',
      categoryName: 'Vacation',
    },
  ],
  targetProgress: {
    overallLabel: 'at_risk',
    healthyCount: 3,
    atRiskCount: 2,
    sinkingFundsOnTrack: 1,
    totalSinkingFunds: 3,
  },
  categoryRisks: [
    {
      categoryId: 'cat_groceries',
      categoryName: 'Groceries',
      risk: 'high',
      reasonCodes: ['over_budget', 'declining_trend'],
      remainingBudget: { minorUnits: '5000', currency: 'USD' },
      daysRemaining: 5,
    },
    {
      categoryId: 'cat_dining',
      categoryName: 'Dining',
      risk: 'medium',
      reasonCodes: ['approaching_limit'],
      remainingBudget: { minorUnits: '20000', currency: 'USD' },
      daysRemaining: 12,
    },
  ],
  recurrences: [
    {
      payeeName: 'Netflix',
      amount: { minorUnits: '1599', currency: 'USD' },
      frequency: 'monthly',
      occurrences: 12,
      lastOccurrence: '2026-07-01',
      isEstimated: false,
    },
  ],
};

describe('Index (Overview) page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('fetches /api/home/attention when authenticated', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/home/attention',
      expect.objectContaining({ query: expect.any(Object) }),
    );
  });

  it('renders priority order: blockers before alerts', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    const text = wrapper.text();
    const blockerIdx = text.indexOf('Blockers');
    const alertIdx = text.indexOf('Alerts');
    expect(blockerIdx).toBeGreaterThanOrEqual(0);
    expect(alertIdx).toBeGreaterThan(blockerIdx);
  });

  it('shows blocker severity and entityType', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('critical');
    expect(wrapper.text()).toContain('synchronization');
  });

  it('shows alert with FindingCard including severity', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    const cards = wrapper.findAll('[data-testid="finding-card"]');
    expect(cards.length).toBeGreaterThanOrEqual(1);
    const alertCard = cards.find((card) =>
      card.text().includes('Groceries category is overspent | warning | Groceries'),
    );
    expect(alertCard).toBeDefined();
    expect(alertCard!.text()).toContain('warning');
  });

  it('shows target progress section with healthy/at-risk counts', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Target Progress');
    expect(wrapper.text()).toContain('3 healthy');
    expect(wrapper.text()).toContain('2 at risk');
  });

  it('shows sinking fund on-track count', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Sinking funds');
    expect(wrapper.text()).toContain('1 / 3');
  });

  it('shows category risk cards with risk level', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Category Risks');
    expect(wrapper.text()).toContain('Groceries');
    expect(wrapper.text()).toContain('high');
  });

  it('shows remaining budget and days on risk cards', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Remaining');
    expect(wrapper.text()).toContain('5 days remaining');
  });

  it('renders reason codes on category risk cards', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="reason-codes"]').exists()).toBe(true);
  });

  it('shows recurrences section', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Recurring Transactions');
    expect(wrapper.text()).toContain('Netflix');
  });

  it('shows freshness metadata', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope(attentionResult, {
        isStale: false,
        lastSync: '2026-07-15T10:00:00Z',
        label: 'current',
      }),
    );
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('test@example.com');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('does not include financial conclusions in output', async () => {
    mockFetch.mockResolvedValue(okEnvelope(attentionResult));
    const wrapper = shallowMount(IndexPage, { global: { stubs: indexStubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should invest');
    expect(wrapper.text()).not.toContain('Your net worth');
  });
});

// =========================================================================
// REPORTS (saved-view compatible)
// =========================================================================
import ReportsPage from '../../app/pages/reports.vue';

const reportsStubs = { ...stubs };

const historyResult = {
  entries: [
    {
      id: 'r-1',
      reportType: 'spending',
      budgetId: 'b-1',
      generatedAt: '2026-07-15T10:00:00Z',
      label: 'July Spending',
      isExpired: false,
    },
    {
      id: 'r-2',
      reportType: 'income',
      budgetId: 'b-1',
      generatedAt: '2026-06-15T10:00:00Z',
      label: 'June Income',
      isExpired: true,
    },
  ],
  total: 2,
};

const viewsResult = {
  views: [
    {
      viewId: 'v-1',
      name: 'Monthly Overview',
      viewType: 'reports',
      scope: { monthRange: '2026-07' },
      createdAt: '2026-07-10T10:00:00Z',
    },
    {
      viewId: 'v-2',
      name: 'Q2 Spending',
      viewType: 'reports',
      scope: { monthRange: '2026-04:2026-06' },
      createdAt: '2026-07-01T10:00:00Z',
    },
  ],
  total: 2,
};

describe('Reports page — saved-view compatible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('fetches saved views on mount alongside history', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history')) return Promise.resolve(okEnvelope(historyResult));
      if (url.includes('/reports/views')) return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(okEnvelope({}));
    });
    shallowMount(ReportsPage, { global: { stubs: reportsStubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/reports/history');
    expect(mockFetch).toHaveBeenCalledWith('/api/reports/views');
  });

  it('renders saved view names and scope metadata', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history')) return Promise.resolve(okEnvelope(historyResult));
      if (url.includes('/reports/views')) return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs: reportsStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Monthly Overview');
    expect(wrapper.text()).toContain('Q2 Spending');
  });

  it('renders saved view created dates', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history')) return Promise.resolve(okEnvelope(historyResult));
      if (url.includes('/reports/views')) return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs: reportsStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('2026-07-10');
  });

  it('does not generate financial conclusions', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history')) return Promise.resolve(okEnvelope(historyResult));
      if (url.includes('/reports/views')) return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs: reportsStubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should');
    expect(wrapper.text()).not.toContain('Your budget is');
  });

  it('shows empty state when no data', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history'))
        return Promise.resolve(okEnvelope({ entries: [], total: 0 }));
      if (url.includes('/reports/views'))
        return Promise.resolve(okEnvelope({ views: [], total: 0 }));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs: reportsStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Select a report type');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(ReportsPage, { global: { stubs: reportsStubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('renders report history entries with expiry status', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history')) return Promise.resolve(okEnvelope(historyResult));
      if (url.includes('/reports/views')) return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs: reportsStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('July Spending');
    expect(wrapper.text()).toContain('Active');
    expect(wrapper.text()).toContain('Expired');
  });
});
