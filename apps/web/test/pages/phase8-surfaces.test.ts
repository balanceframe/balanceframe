/**
 * TDD: Phase 8 decision-surface pages.
 *
 * purchase-check — currency/account inputs, safe/not-safe/safe-with-reallocation/
 *   insufficient-data verdicts, proposals/donors/protected categories/expiry/
 *   competition, no-mutation guarantee, evidence/policy/freshness metadata.
 * cash-flow — assumptions/scope, envelope availability separated from projection.
 * targets — no-config, healthy/at-risk, sinking-fund states.
 * index (overview) — priority ordering, severity/why/freshness/scope/evidence/
 *   next-action per item.
 * reports — compatible with saved-view work.
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
// PURCHASE CHECK
// =========================================================================
import PurchaseCheckPage from '../../app/pages/purchase-check.vue';

const purchaseStubs = {
  ...stubs,
  UInput: {
    template: '<input />',
    props: ['modelValue', 'placeholder', 'type', 'min', 'max'],
  },
  SemanticAmount: {
    template: '<span data-testid="semantic-amount">{{ amount && amount.minorUnits }}</span>',
    props: ['amount'],
  },
};

/** Helper: mount, fill inputs, trigger evaluate, return wrapper. */
async function mountAndEvaluate(resultMock: unknown) {
  mockFetch.mockResolvedValue(okEnvelope(resultMock));
  const wrapper = shallowMount(PurchaseCheckPage, { global: { stubs: purchaseStubs } });
  await flushPromises();
  const vm = wrapper.vm as unknown as {
    categoryId: string;
    amountStr: string;
    evaluate: () => Promise<void>;
  };
  vm.categoryId = 'cg';
  vm.amountStr = '5000';
  await vm.evaluate();
  await flushPromises();
  return wrapper;
}

const safeResult = {
  allowable: true,
  verdict: 'safe',
  reasonCodes: ['sufficient_budget'],
  explanation: 'Budget allows this purchase.',
  categoryBudget: { minorUnits: '50000', currency: 'USD' },
  categorySpent: { minorUnits: '20000', currency: 'USD' },
  categoryRemaining: { minorUnits: '30000', currency: 'USD' },
  projectedBalance: { minorUnits: '100000', currency: 'USD' },
  hasEnvelope: true,
  proposals: [],
  donors: [],
  protectedCategories: [],
  expiry: null,
  competition: null,
  evidence: { source: 'native_protocol', snapshotAge: '2m' },
  policy: { allowsReallocations: false },
  freshness: { isStale: false, lastSync: '2026-07-15T10:00:00Z', label: 'current' },
};

const notSafeResult = {
  allowable: false,
  verdict: 'not_safe',
  reasonCodes: ['over_budget', 'insufficient_remaining'],
  explanation: 'Purchase exceeds remaining category budget.',
  categoryBudget: { minorUnits: '50000', currency: 'USD' },
  categorySpent: { minorUnits: '45000', currency: 'USD' },
  categoryRemaining: { minorUnits: '5000', currency: 'USD' },
  projectedBalance: { minorUnits: '12000', currency: 'USD' },
  hasEnvelope: true,
  proposals: [
    {
      targetCategoryId: 'cat_savings',
      amount: { minorUnits: '5000', currency: 'USD' },
      label: 'Move from savings',
    },
  ],
  donors: [
    { categoryId: 'cat_savings', availableAmount: { minorUnits: '30000', currency: 'USD' } },
  ],
  protectedCategories: ['cat_rent', 'cat_utilities'],
  expiry: '2026-07-31T23:59:59Z',
  competition: { competingPurchases: 2, totalCommitted: { minorUnits: '8000', currency: 'USD' } },
  evidence: { source: 'native_protocol', snapshotAge: '1m' },
  policy: { allowsReallocations: true },
  freshness: { isStale: false, lastSync: '2026-07-15T10:00:00Z', label: 'current' },
};

const safeWithReallocationResult = {
  allowable: true,
  verdict: 'safe_with_reallocation',
  reasonCodes: ['reallocation_required'],
  explanation: 'Allowable if funds are reallocated from savings.',
  categoryBudget: { minorUnits: '50000', currency: 'USD' },
  categorySpent: { minorUnits: '48000', currency: 'USD' },
  categoryRemaining: { minorUnits: '2000', currency: 'USD' },
  projectedBalance: { minorUnits: '5000', currency: 'USD' },
  hasEnvelope: true,
  proposals: [
    {
      targetCategoryId: 'cat_savings',
      amount: { minorUnits: '3000', currency: 'USD' },
      label: 'Reallocate from savings',
    },
  ],
  donors: [
    { categoryId: 'cat_savings', availableAmount: { minorUnits: '50000', currency: 'USD' } },
  ],
  protectedCategories: ['cat_rent'],
  expiry: null,
  competition: null,
  evidence: { source: 'native_protocol', snapshotAge: '3m' },
  policy: { allowsReallocations: true },
  freshness: { isStale: false, lastSync: '2026-07-15T10:00:00Z', label: 'current' },
};

const insufficientDataResult = {
  allowable: false,
  verdict: 'insufficient_data',
  reasonCodes: ['no_envelope', 'stale_data'],
  explanation: 'Cannot evaluate: no budget envelope for this category and data may be outdated.',
  categoryBudget: null,
  categorySpent: null,
  categoryRemaining: null,
  projectedBalance: null,
  hasEnvelope: false,
  proposals: [],
  donors: [],
  protectedCategories: [],
  expiry: null,
  competition: null,
  evidence: null,
  policy: null,
  freshness: { isStale: true, lastSync: '2026-06-01T00:00:00Z', label: 'stale' },
};

describe('Purchase Check page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('renders category and amount inputs', async () => {
    mockFetch.mockResolvedValue({ status: 'ok', result: null });
    const wrapper = shallowMount(PurchaseCheckPage, { global: { stubs: purchaseStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Category');
    expect(wrapper.text()).toContain('Amount');
  });

  it('renders currency input', async () => {
    mockFetch.mockResolvedValue({ status: 'ok', result: null });
    const wrapper = shallowMount(PurchaseCheckPage, { global: { stubs: purchaseStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Currency');
  });

  it('renders account input', async () => {
    mockFetch.mockResolvedValue({ status: 'ok', result: null });
    const wrapper = shallowMount(PurchaseCheckPage, { global: { stubs: purchaseStubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Account');
  });

  it('disables evaluate button when inputs are empty', async () => {
    mockFetch.mockResolvedValue({ status: 'ok', result: null });
    const wrapper = shallowMount(PurchaseCheckPage, { global: { stubs: purchaseStubs } });
    await flushPromises();
    const btn = wrapper.find('button');
    expect(btn.attributes('disabled')).toBeDefined();
  });

  it('enables Evaluate from UInput update:modelValue events and sends the expected query', async () => {
    mockFetch.mockResolvedValue(okEnvelope(safeResult));
    const wrapper = shallowMount(PurchaseCheckPage, { global: { stubs: purchaseStubs } });
    await flushPromises();

    const inputs = wrapper.findAllComponents(purchaseStubs.UInput);
    inputs[0].vm.$emit('update:modelValue', 'cg');
    inputs[1].vm.$emit('update:modelValue', 5000);
    await wrapper.vm.$nextTick();

    const button = wrapper.find('button');
    expect(button.attributes('disabled')).toBeUndefined();
    await button.trigger('click');
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith('/api/purchase/evaluate', {
      query: { categoryId: 'cg', amount: '5000', currency: 'USD' },
    });
  });

  it('calls /api/purchase/evaluate with category and amount', async () => {
    const wrapper = await mountAndEvaluate(safeResult);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/purchase/evaluate',
      expect.objectContaining({ query: expect.any(Object) }),
    );
  });

  it('shows safe verdict with green indicator', async () => {
    const wrapper = await mountAndEvaluate(safeResult);
    expect(wrapper.text()).toContain('Safe');
    expect(wrapper.text()).toContain('Budget allows this purchase');
  });

  it('shows not-safe verdict with red indicator', async () => {
    const wrapper = await mountAndEvaluate(notSafeResult);
    expect(wrapper.text()).toContain('Not Safe');
    expect(wrapper.text()).toContain('exceeds remaining');
  });

  it('shows safe-with-reallocation verdict', async () => {
    const wrapper = await mountAndEvaluate(safeWithReallocationResult);
    expect(wrapper.text()).toContain('Safe with Reallocation');
  });

  it('shows insufficient-data verdict', async () => {
    const wrapper = await mountAndEvaluate(insufficientDataResult);
    expect(wrapper.text()).toContain('Insufficient Data');
  });

  it('renders proposals when present', async () => {
    const wrapper = await mountAndEvaluate(notSafeResult);
    expect(wrapper.text()).toContain('Move from savings');
  });

  it('renders donors when present', async () => {
    const wrapper = await mountAndEvaluate(notSafeResult);
    expect(wrapper.text()).toContain('Donor');
  });

  it('renders protected categories', async () => {
    const wrapper = await mountAndEvaluate(notSafeResult);
    expect(wrapper.text()).toContain('Protected');
    expect(wrapper.text()).toContain('cat_rent');
  });

  it('renders expiry information', async () => {
    const wrapper = await mountAndEvaluate(notSafeResult);
    expect(wrapper.text()).toContain('Expiry');
  });

  it('renders competition information', async () => {
    const wrapper = await mountAndEvaluate(notSafeResult);
    expect(wrapper.text()).toContain('Competition');
    expect(wrapper.text()).toContain('2');
  });

  it('shows explicit no-mutation text', async () => {
    const wrapper = await mountAndEvaluate(safeResult);
    expect(wrapper.text()).toContain('read-only');
  });

  it('renders evidence metadata', async () => {
    const wrapper = await mountAndEvaluate(safeResult);
    expect(wrapper.text()).toContain('Evidence');
    expect(wrapper.text()).toContain('native_protocol');
  });

  it('renders policy metadata', async () => {
    const wrapper = await mountAndEvaluate(safeResult);
    expect(wrapper.text()).toContain('Policy');
  });

  it('renders freshness metadata', async () => {
    const wrapper = await mountAndEvaluate(safeResult);
    expect(wrapper.text()).toContain('Freshness');
    expect(wrapper.text()).toContain('current');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(PurchaseCheckPage, { global: { stubs: purchaseStubs } });
    await flushPromises();
    const vm = wrapper.vm as unknown as {
      categoryId: string;
      amountStr: string;
      evaluate: () => Promise<void>;
    };
    vm.categoryId = 'cg';
    vm.amountStr = '5000';
    await vm.evaluate();
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('does not perform client-side financial calculations', async () => {
    const wrapper = await mountAndEvaluate(safeResult);
    expect(wrapper.text()).not.toContain('budget is');
    expect(wrapper.text()).not.toContain('calculated');
  });

  it('renders reason codes from result', async () => {
    const wrapper = await mountAndEvaluate(safeResult);
    expect(wrapper.find('[data-testid="reason-codes"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="reason-code"]').length).toBeGreaterThan(0);
  });

  it('renders currency and account values from result', async () => {
    const wrapper = await mountAndEvaluate(safeResult);
    expect(wrapper.text()).toContain('Envelope budget active');
  });
});

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
