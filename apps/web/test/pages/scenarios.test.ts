/**
 * TDD: Scenarios page fetches /api/scenarios and renders comparison deltas,
 * summary, read-only labels, and error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import ScenariosPage from '../../app/pages/scenarios.vue';

const stubs = {
  AnalysisPage: { template: '<div><span v-if="error" data-testid="error">{{ error.code }}</span><slot name="content" /></div>', props: ['title', 'loading', 'error', 'freshness', 'insufficientData'] },
  UCard: { template: '<div><slot name="header" /><slot /></div>' },
  AnalysisTable: { template: '<table><tr v-for="(r,i) in rows" :key="i"><td v-for="c in columns" :key="c.key">{{ r[c.key] }}</td></tr></table>', props: ['columns', 'rows'] },
};

function okEnvelope(result: unknown) {
  return { schemaVersion: '1', requestId: 'req-test', status: 'ok' as const, dataFreshness: { isStale: false, lastSync: '2026-01-15T10:00:00Z', label: 'current' }, authorization: null, result, error: null };
}

function errorEnvelope(code: string) {
  return { schemaVersion: '1', requestId: 'req-test', status: 'error' as const, dataFreshness: null, authorization: null, result: null, error: { code, message: `Simulated ${code}`, retryable: true } };
}

const sampleResult = {
  deltas: [
    { dimension: 'Budget Total', baselineValue: 5000, comparisonValue: 4500, change: '-$500 (-10%)' },
    { dimension: 'Groceries', baselineValue: 600, comparisonValue: 500, change: '-$100 (-16.7%)' },
  ],
  summary: 'Reducing budget total by $500 keeps all categories within sustainable limits.',
};

describe('Scenarios page', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset(); });

  it('calls /api/scenarios on mount', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    shallowMount(ScenariosPage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/scenarios');
  });

  it('renders comparison summary', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ScenariosPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Reducing budget total by $500');
  });

  it('renders delta dimensions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ScenariosPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Budget Total');
    expect(wrapper.text()).toContain('Groceries');
  });

  it('shows read-only notice', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ScenariosPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('read-only');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(ScenariosPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows error on API error envelope', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STORE_UNAVAILABLE'));
    const wrapper = shallowMount(ScenariosPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STORE_UNAVAILABLE');
  });

  it('shows empty state when no deltas', async () => {
    mockFetch.mockResolvedValue(okEnvelope({ deltas: [], summary: '' }));
    const wrapper = shallowMount(ScenariosPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No scenario comparison data');
  });

  it('does not compute financial conclusions in Vue', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ScenariosPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should');
  });
});
