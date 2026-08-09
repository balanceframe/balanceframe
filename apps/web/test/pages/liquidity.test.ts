/**
 * TDD: Liquidity page fetches /api/liquidity and renders liquid totals,
 * coverage ratios, upcoming obligations, and error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import LiquidityPage from '../../app/pages/liquidity.vue';

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
      '<table><tr v-for="(r,i) in rows" :key="i"><td v-for="c in columns" :key="c.key">{{ r[c.key] }}</td></tr></table>',
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
  totalLiquid: { minorUnits: '1500000', currency: 'USD' },
  totalObligations: { minorUnits: '850000', currency: 'USD' },
  coverage: [{ ratio: 1.76, label: 'full coverage' }],
  upcomingObligations: [
    {
      name: 'Rent',
      dueDate: '2026-02-01',
      amount: { minorUnits: '500000', currency: 'USD' },
      categoryId: 'cat-1',
      isRecurring: true,
    },
    {
      name: 'Insurance',
      dueDate: '2026-02-15',
      amount: { minorUnits: '350000', currency: 'USD' },
      categoryId: 'cat-2',
      isRecurring: true,
    },
  ],
};

describe('Liquidity page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('calls /api/liquidity on mount', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/liquidity',
      expect.objectContaining({ query: expect.any(Object) }),
    );
  });

  it('renders data after success', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Rent');
  });

  it('renders coverage ratio label', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('1.76x');
  });

  it('describes explicit no-obligation coverage without rendering a numeric ratio', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({
        totalLiquid: { minorUnits: '1500000', currency: 'USD' },
        totalObligations: { minorUnits: '0', currency: 'USD' },
        coverage: [{ ratio: null, label: 'no obligations' }],
        upcomingObligations: [],
      }),
    );
    const wrapper = shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();

    const request = mockFetch.mock.calls[0]?.[1] as { query: { currentMonth: string } };
    expect(wrapper.get('[data-testid="coverage-ratio"]').text()).toBe(
      `No upcoming obligations in ${request.query.currentMonth}`,
    );
    expect(wrapper.text()).not.toContain('x');
  });

  it('distinguishes an empty current window from nonzero total obligations', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({
        totalLiquid: { minorUnits: '1500000', currency: 'USD' },
        totalObligations: { minorUnits: '30000', currency: 'USD' },
        coverage: [
          { ratio: null, label: 'no 30-day obligations' },
          { ratio: 50, label: 'full coverage' },
        ],
        upcomingObligations: [],
      }),
    );
    const wrapper = shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();

    const request = mockFetch.mock.calls[0]?.[1] as { query: { currentMonth: string } };
    expect(wrapper.text()).toContain(`No scheduled obligations in ${request.query.currentMonth}`);
    expect(wrapper.text()).toContain('full coverage 50x');
    expect(wrapper.text()).not.toContain(
      `No upcoming obligations in ${request.query.currentMonth}`,
    );
  });

  it('renders upcoming obligations', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Rent');
    expect(wrapper.text()).toContain('Insurance');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows error on API error envelope', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STORE_UNAVAILABLE'));
    const wrapper = shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STORE_UNAVAILABLE');
  });

  it('shows stale data freshness', async () => {
    const stale = okEnvelope(sampleResult);
    stale.dataFreshness = { isStale: true, lastSync: '2025-12-01T00:00:00Z', label: 'stale' };
    mockFetch.mockResolvedValue(stale);
    const wrapper = shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();
    // Content renders when no error — freshness is passed to AnalysisPage as prop
    expect(wrapper.text()).toContain('Rent');
  });

  it('shows empty state when no data', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({
        totalLiquid: null,
        totalObligations: null,
        coverage: [],
        upcomingObligations: [],
      }),
    );
    const wrapper = shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No liquidity data available');
  });

  it('does not calculate financial conclusions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(LiquidityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should');
  });
});
