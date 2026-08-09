/**
 * TDD: Health page fetches /api/financial-health and renders composite
 * score, dimension cards with severity badges, recommendations, and error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import HealthPage from '../../app/pages/health.vue';

const stubs = {
  AnalysisPage: {
    template:
      '<div><span v-if="error" data-testid="error">{{ error.code }}</span><slot name="content" /></div>',
    props: ['title', 'loading', 'error', 'freshness', 'insufficientData'],
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
  dimensions: [
    {
      dimension: 'Budget Adherence',
      score: 0.85,
      weight: 0.3,
      explanation: 'Spending within budget across most categories.',
      severity: 'good',
    },
    {
      dimension: 'Cash Position',
      score: 0.62,
      weight: 0.25,
      explanation: 'Cash reserves below recommended level.',
      severity: 'warning',
    },
  ],
  compositeScore: 0.75,
  summary: 'Overall financial health is moderate.',
  recommendations: ['Build emergency fund to 3 months of expenses'],
};

describe('Health page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('calls /api/financial-health on mount', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/financial-health',
      expect.objectContaining({ query: expect.any(Object) }),
    );
  });

  it('renders composite score', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('75');
  });

  it('converts normalized health scores and weights to whole percentages', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({
        ...sampleResult,
        dimensions: [
          {
            dimension: 'Liquidity',
            score: 0.85,
            weight: 0.25,
            explanation: 'Coverage is healthy.',
            severity: 'good',
          },
        ],
        compositeScore: 0.75,
      }),
    );
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();

    expect(wrapper.get('[data-testid="composite-score"]').text()).toBe('75/ 100');
    expect(wrapper.get('[data-testid="dim-score-Liquidity"]').text()).toBe('85/ 100 (weight: 25%)');
  });

  it('renders dimension names', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Budget Adherence');
    expect(wrapper.text()).toContain('Cash Position');
  });

  it('renders dimension scores', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('85');
    expect(wrapper.text()).toContain('62');
  });

  it('renders severity badges', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('good');
    expect(wrapper.text()).toContain('warning');
  });

  it('renders explanations', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Spending within budget');
  });

  it('renders recommendations', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Build emergency fund');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows error on API error envelope', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STORE_UNAVAILABLE'));
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STORE_UNAVAILABLE');
  });

  it('shows empty state when no dimensions', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({ dimensions: [], compositeScore: 0, summary: '', recommendations: [] }),
    );
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No health assessment data available');
  });

  it('does not calculate financial conclusions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(HealthPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should');
  });
});
