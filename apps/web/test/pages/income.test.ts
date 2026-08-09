/**
 * TDD: Income page fetches /api/income and renders income sources,
 * total monthly, overall score, and freshness/error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import IncomePage from '../../app/pages/income.vue';

const stubs = {
  AnalysisPage: {
    template:
      '<div><span v-if="error" data-testid="error">{{ error.code }}</span><slot name="content" /></div>',
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
  sources: [
    {
      name: 'Salary',
      typicalMonthly: { minorUnits: '500000', currency: 'USD' },
      reliabilityScore: 0.95,
      variability: 0.02,
      paymentCount: 24,
      isRegular: true,
    },
    {
      name: 'Freelance',
      typicalMonthly: { minorUnits: '120000', currency: 'USD' },
      reliabilityScore: 0.6,
      variability: 0.35,
      paymentCount: 12,
      isRegular: false,
    },
  ],
  totalMonthly: { minorUnits: '620000', currency: 'USD' },
  overallScore: 0.82,
  unreliableSourceCount: 1,
};

describe('Income page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('calls /api/income on mount', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    shallowMount(IncomePage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/income');
  });

  it('renders income source names', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(IncomePage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Salary');
    expect(wrapper.text()).toContain('Freelance');
  });

  it('renders total monthly amount', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(IncomePage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('620000');
  });

  it('renders overall reliability score', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(IncomePage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('82');
  });

  it('converts normalized reliability scores to whole percentages', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({
        ...sampleResult,
        sources: [
          { ...sampleResult.sources[0], reliabilityScore: 0.956 },
          { ...sampleResult.sources[1], reliabilityScore: 0 },
        ],
        overallScore: 0.823,
      }),
    );
    const wrapper = shallowMount(IncomePage, { global: { stubs } });
    await flushPromises();

    expect(wrapper.get('[data-testid="overall-score"]').text()).toBe('82%');
    expect(wrapper.text()).toContain('96%');
    expect(wrapper.text()).toContain('0%');
  });

  it('renders unreliable source count', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(IncomePage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('1');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(IncomePage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows error on API error envelope', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STORE_UNAVAILABLE'));
    const wrapper = shallowMount(IncomePage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STORE_UNAVAILABLE');
  });

  it('shows empty state when no sources', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({ sources: [], totalMonthly: null, overallScore: null, unreliableSourceCount: 0 }),
    );
    const wrapper = shallowMount(IncomePage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No income source data available');
  });

  it('does not calculate financial conclusions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(IncomePage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should');
  });
});
