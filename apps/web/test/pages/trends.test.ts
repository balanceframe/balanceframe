/**
 * TDD: Trends page fetches /api/trends-variance and renders category variances,
 * trend directions, totals, and error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import TrendsPage from '../../app/pages/trends.vue';

const stubs = {
  AnalysisPage: {
    template:
      '<div><span v-if="error" data-testid="error">{{ error.code }}</span><slot v-else name="content" /></div>',
    props: ['title', 'loading', 'error', 'freshness', 'insufficientData'],
  },
  SemanticAmount: {
    template: '<span data-testid="semantic-amount">{{ amount.minorUnits }}</span>',
    props: ['amount'],
  },
  UCard: { template: '<div><slot name="header" /><slot /></div>' },
  AnalysisTable: {
    template:
      '<table><tr v-for="(r,i) in rows" :key="i"><td v-for="c in columns" :key="c.key">{{ c.type === "amount" ? r[c.key].minorUnits + " " + r[c.key].currency : r[c.key] }}</td></tr></table>',
    props: ['columns', 'rows'],
  },
  ScopeSummary: { template: '<div>{{ scope.label }}</div>', props: ['scope'] },
};

function okEnvelope(result: unknown) {
  return {
    schemaVersion: '1',
    requestId: 'req-test',
    status: 'ok' as const,
    dataFreshness: { isStale: false, lastSync: '2026-01-15T10:00:00Z', label: 'current' },
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

const sampleResult = {
  categoryVariances: [
    {
      categoryId: 'cat-1',
      categoryName: 'Groceries',
      budgeted: { minorUnits: '50000', currency: 'USD' },
      actual: { minorUnits: '55000', currency: 'USD' },
      variance: { minorUnits: '5000', currency: 'USD' },
      variancePercent: 10,
      label: 'overspent',
    },
    {
      categoryId: 'cat-2',
      categoryName: 'Utilities',
      budgeted: { minorUnits: '20000', currency: 'USD' },
      actual: { minorUnits: '18000', currency: 'USD' },
      variance: { minorUnits: '-2000', currency: 'USD' },
      variancePercent: -10,
      label: 'on_track',
    },
  ],
  trends: [
    {
      categoryId: 'cat-1',
      categoryName: 'Groceries',
      direction: 'increasing',
      avgChange: { minorUnits: '520', currency: 'USD' },
      periodsAnalyzed: 6,
      seasonalityDetected: false,
    },
    {
      categoryId: 'cat-2',
      categoryName: 'Utilities',
      direction: 'stable',
      avgChange: { minorUnits: '30', currency: 'USD' },
      periodsAnalyzed: 6,
      seasonalityDetected: true,
    },
  ],
  totalBudgeted: { minorUnits: '70000', currency: 'USD' },
  totalActual: { minorUnits: '73000', currency: 'USD' },
  totalVariance: { minorUnits: '3000', currency: 'USD' },
  overallVariancePercent: 4.3,
};

describe('Trends page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('calls /api/trends-variance on mount', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/trends-variance',
      expect.objectContaining({ query: expect.any(Object) }),
    );
  });

  it('renders category names', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Groceries');
    expect(wrapper.text()).toContain('Utilities');
  });

  it('renders trend directions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('increasing');
    expect(wrapper.text()).toContain('stable');
  });

  it('renders variance labels', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('overspent');
    expect(wrapper.text()).toContain('on_track');
  });

  it('renders overall variance percent', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('4.3');
  });

  it('renders average monthly changes as currency amounts instead of percentages', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('520 USD');
    expect(wrapper.text()).not.toContain('+520%');
  });

  it('rounds percentage-point variance values for display', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({
        ...sampleResult,
        categoryVariances: [{ ...sampleResult.categoryVariances[0], variancePercent: 10.1234 }],
        overallVariancePercent: 4.3333,
      }),
    );
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('+10.1%');
    expect(wrapper.text()).toContain('4.3%');
    expect(wrapper.text()).not.toContain('10.1234%');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows error on API error envelope', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STORE_UNAVAILABLE'));
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STORE_UNAVAILABLE');
  });

  it('shows stale data freshness', async () => {
    const stale = okEnvelope(sampleResult);
    stale.dataFreshness = { isStale: true, lastSync: '2025-12-01T00:00:00Z', label: 'stale' };
    mockFetch.mockResolvedValue(stale);
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    // Stale freshness passed as prop; content renders
    expect(wrapper.text()).toContain('Groceries');
  });

  it('shows empty state when no variances', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({
        categoryVariances: [],
        trends: [],
        totalBudgeted: null,
        totalActual: null,
        totalVariance: null,
        overallVariancePercent: null,
      }),
    );
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No trend data available');
  });

  it('does not calculate financial conclusions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(TrendsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should');
  });
});
