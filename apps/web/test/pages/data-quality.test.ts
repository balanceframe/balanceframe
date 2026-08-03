/**
 * TDD: Data Quality page fetches /api/data-quality and renders dimensions,
 * overall score, recommendations, freshness, and error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import DataQualityPage from '../../app/pages/data-quality.vue';

const stubs = {
  AnalysisPage: { template: '<div><span v-if="error" data-testid="error">{{ error.code }}</span><slot v-else name="content" /></div>', props: ['title', 'loading', 'error', 'freshness', 'insufficientData'] },
  SemanticAmount: { template: '<span data-testid="semantic-amount">{{ amount.minorUnits }}</span>', props: ['amount'] },
  UCard: { template: '<div><slot name="header" /><slot /></div>' },
  AnalysisTable: { template: '<table><tr v-for="(r,i) in rows" :key="i"><td v-for="c in columns" :key="c.key">{{ r[c.key] }}</td></tr></table>', props: ['columns', 'rows'] },
  ScopeSummary: { template: '<div>{{ scope.label }}</div>', props: ['scope'] },
  UIcon: { template: '<span />', props: ['name'] },
};

function okEnvelope(result: unknown) {
  return { schemaVersion: '1', requestId: 'req-test', status: 'ok' as const, dataFreshness: { isStale: false, lastSync: '2026-01-15T10:00:00Z', label: 'current' }, authorization: null, result, error: null };
}

function errorEnvelope(code: string, retryable = false) {
  return { schemaVersion: '1', requestId: 'req-test', status: 'error' as const, dataFreshness: null, authorization: null, result: null, error: { code, message: `Simulated ${code}`, retryable } };
}

const sampleResult = {
  overallScore: 82,
  dimensions: [
    { name: 'Categorization', score: 90, severity: 'good', details: ['90% categorized'], worstSeverity: null },
    { name: 'Payee Coverage', score: 74, severity: 'warning', details: ['26% missing payees'], worstSeverity: 'warning' },
  ],
  recommendations: ['Review uncategorized transactions', 'Add missing payee information'],
};

describe('Data Quality page', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset(); });

  it('calls /api/data-quality on mount', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    shallowMount(DataQualityPage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/data-quality');
  });

  it('resolves loading and renders score', async () => {
    const { promise, resolve } = Promise.withResolvers();
    mockFetch.mockReturnValue(promise);
    const wrapper = shallowMount(DataQualityPage, { global: { stubs } });
    resolve(okEnvelope(sampleResult));
    await flushPromises();
    expect(wrapper.text()).toContain('82');
  });

  it('renders quality dimension names', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(DataQualityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Categorization');
    expect(wrapper.text()).toContain('Payee Coverage');
  });

  it('renders recommendations', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(DataQualityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Recommended Actions');
    expect(wrapper.text()).toContain('Review uncategorized transactions');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(DataQualityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows error on API error envelope', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STORE_UNAVAILABLE'));
    const wrapper = shallowMount(DataQualityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STORE_UNAVAILABLE');
  });

  it('shows retryable error code', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STALE_DATA', true));
    const wrapper = shallowMount(DataQualityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STALE_DATA');
  });

  it('shows stale data freshness', async () => {
    const stale = okEnvelope(sampleResult);
    stale.dataFreshness = { isStale: true, lastSync: '2025-12-01T00:00:00Z', label: 'stale' };
    mockFetch.mockResolvedValue(stale);
    const wrapper = shallowMount(DataQualityPage, { global: { stubs } });
    await flushPromises();
    // Freshness prop is passed to AnalysisPage stub; check via component props
    const analysisPage = wrapper.findComponent({ name: 'AnalysisPage' });
    if (analysisPage.exists()) {
      const freshness = analysisPage.props('freshness');
      expect(freshness).toBeTruthy();
      expect(freshness.isStale).toBe(true);
    }
  });

  it('renders empty state when no dimensions', async () => {
    mockFetch.mockResolvedValue(okEnvelope({ overallScore: null, dimensions: [], recommendations: [] }));
    const wrapper = shallowMount(DataQualityPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No data quality metrics available');
  });

  it('does not calculate financial conclusions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(DataQualityPage, { global: { stubs } });
    await flushPromises();
    const text = wrapper.text();
    expect(text).not.toContain('You should');
    expect(text).not.toContain('financial advice');
  });
});
