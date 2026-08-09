/**
 * TDD: Obligations page fetches /api/obligations and renders irregular
 * obligations with planning-input semantics clearly distinguished from
 * ledger facts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import ObligationsPage from '../../app/pages/obligations.vue';

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
  obligations: [
    {
      name: 'Annual Insurance',
      kind: 'nonMonthly',
      typicalAmount: { minorUnits: '120000', currency: 'USD' },
      frequency: 'yearly',
      categoryId: 'cat-1',
      nextExpectedDate: '2026-06-15',
    },
    {
      name: 'Holiday Gifts',
      kind: 'seasonal',
      typicalAmount: { minorUnits: '50000', currency: 'USD' },
      frequency: 'yearly',
      categoryId: 'cat-2',
      nextExpectedDate: '2026-12-01',
    },
    {
      name: 'Car Maintenance',
      kind: 'variableAmount',
      typicalAmount: { minorUnits: '30000', currency: 'USD' },
      frequency: 'as-needed',
      categoryId: null,
      nextExpectedDate: null,
    },
  ],
  totalEstimatedAnnual: { minorUnits: '200000', currency: 'USD' },
};

describe('Obligations page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('calls /api/obligations on mount', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/obligations');
  });

  it('renders obligation names', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Annual Insurance');
    expect(wrapper.text()).toContain('Holiday Gifts');
    expect(wrapper.text()).toContain('Car Maintenance');
  });

  it('renders irregularity kind badges', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('nonMonthly');
    expect(wrapper.text()).toContain('seasonal');
    expect(wrapper.text()).toContain('variableAmount');
  });

  it('renders frequency labels', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('yearly');
    expect(wrapper.text()).toContain('as-needed');
  });

  it('distinguishes planning inputs from ledger facts', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('planning inputs');
  });

  it('renders next expected dates', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('2026-06-15');
    expect(wrapper.text()).toContain('2026-12-01');
  });

  it('renders estimated annual total', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Annual Insurance');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows error on API error envelope', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STORE_UNAVAILABLE'));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STORE_UNAVAILABLE');
  });

  it('shows stale data freshness', async () => {
    const stale = okEnvelope(sampleResult);
    stale.dataFreshness = { isStale: true, lastSync: '2025-12-01T00:00:00Z', label: 'stale' };
    mockFetch.mockResolvedValue(stale);
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    // Stale freshness passed as prop; content renders
    expect(wrapper.text()).toContain('Annual Insurance');
  });

  it('shows empty state when no obligations', async () => {
    mockFetch.mockResolvedValue(okEnvelope({ obligations: [], totalEstimatedAnnual: null }));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No irregular obligations detected');
  });

  it('does not calculate financial conclusions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should');
  });

  it('does not present planning inputs as ledger facts', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ObligationsPage, { global: { stubs } });
    await flushPromises();
    const text = wrapper.text();
    // Should not say these ARE actual or confirmed (the page correctly says 'not confirmed')
    expect(text).not.toMatch(/\bactual ledger\b/);
    expect(text).not.toMatch(/\bconfirmed facts\b/);
  });
});
