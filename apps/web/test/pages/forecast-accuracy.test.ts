/**
 * TDD: Forecast Accuracy page fetches /api/forecast-accuracy and renders
 * calibration metrics, overall calibration state, and recommendations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import ForecastAccuracyPage from '../../app/pages/forecast-accuracy.vue';

const stubs = {
  AnalysisPage: { template: '<div><span v-if="error" data-testid="error">{{ error.code }}</span><slot name="content" /></div>', props: ['title', 'loading', 'error', 'freshness', 'insufficientData'] },
  UCard: { template: '<div><slot name="header" /><slot /></div>' },
  AnalysisTable: { template: '<table><tr v-for="(r,i) in rows" :key="i"><td v-for="c in columns" :key="c.key">{{ r[c.key] }}</td></tr></table>', props: ['columns', 'rows'] },
  ScopeSummary: { template: '<div>{{ scope.label }}</div>', props: ['scope'] },
};

function okEnvelope(result: unknown) {
  return { schemaVersion: '1', requestId: 'req-test', status: 'ok' as const, dataFreshness: { isStale: false, lastSync: '2026-01-15T10:00:00Z', label: 'current' }, authorization: null, result, error: null };
}

function errorEnvelope(code: string) {
  return { schemaVersion: '1', requestId: 'req-test', status: 'error' as const, dataFreshness: null, authorization: null, result: null, error: { code, message: `Simulated ${code}`, retryable: true } };
}

const sampleResult = {
  metrics: [
    { metricName: 'Groceries', mape: 8.5, bias: -2.1, periodsCompared: 12, isCalibrated: true },
    { metricName: 'Utilities', mape: 15.2, bias: 5.3, periodsCompared: 12, isCalibrated: false },
  ],
  overallCalibrated: false,
  recommendations: ['Review utility budget allocation', 'Add seasonal adjustment for heating costs'],
};

describe('Forecast Accuracy page', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset(); });

  it('calls /api/forecast-accuracy on mount', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    shallowMount(ForecastAccuracyPage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/forecast-accuracy');
  });

  it('renders overall calibration state', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ForecastAccuracyPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Not Calibrated');
  });

  it('renders metric names', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ForecastAccuracyPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Groceries');
    expect(wrapper.text()).toContain('Utilities');
  });

  it('renders MAPE values', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ForecastAccuracyPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('8.5%');
  });

  it('renders recommendations', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ForecastAccuracyPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Review utility budget allocation');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(ForecastAccuracyPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows error on API error envelope', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STORE_UNAVAILABLE'));
    const wrapper = shallowMount(ForecastAccuracyPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STORE_UNAVAILABLE');
  });

  it('shows empty state when no data', async () => {
    mockFetch.mockResolvedValue(okEnvelope({ metrics: [], overallCalibrated: false, recommendations: [] }));
    const wrapper = shallowMount(ForecastAccuracyPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No forecast accuracy data available');
  });

  it('does not calculate financial conclusions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(ForecastAccuracyPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should');
  });
});
