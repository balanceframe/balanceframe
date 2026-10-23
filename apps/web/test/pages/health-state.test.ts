import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import type { MultidimensionalHealthResult } from '@balanceframe/application';
import type { Freshness } from '../../app/components/types';
import HealthPage from '../../app/pages/health.vue';
import AnalysisPage from '../../app/components/AnalysisPage.vue';
import FreshnessBanner from '../../app/components/FreshnessBanner.vue';
import InsufficientDataPanel from '../../app/components/InsufficientDataPanel.vue';

const mockFetch = vi.fn();
const currentFreshness: Freshness = {
  isStale: false,
  lastSync: '2026-01-15T10:00:00Z',
  label: 'current',
};
const result: MultidimensionalHealthResult = {
  dimensions: [
    {
      dimension: 'data_quality',
      score: 0.85,
      weight: 0.15,
      explanation: 'Service supplied data quality explanation.',
      severity: 'good',
    },
  ],
  compositeScore: 0.85,
  summary: 'Service supplied health summary.',
  recommendations: ['Service supplied recommendation.'],
};

function okEnvelope(
  health: MultidimensionalHealthResult | null = result,
  freshness: Freshness | null = currentFreshness,
) {
  return {
    schemaVersion: '1',
    requestId: 'req-health-state',
    status: 'ok' as const,
    authorization: null,
    dataFreshness: freshness,
    result: health,
    error: null,
  };
}

function mountPage() {
  return mount(HealthPage, {
    global: {
      // Exercise shared state gating and freshness; stub only Nuxt UI primitives.
      components: { AnalysisPage, FreshnessBanner, InsufficientDataPanel },
      stubs: {
        UContainer: { template: '<main><slot /></main>' },
        UCard: { template: '<section><slot name="header" /><slot /></section>' },
        UIcon: true,
        UAlert: {
          props: ['title', 'description'],
          template: '<div role="alert">{{ title }}: {{ description }}</div>',
        },
        SavedViewPicker: true,
      },
    },
  });
}

enableAutoUnmount(afterEach);

describe('Financial Health display states', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal('$fetch', mockFetch);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-15T10:30:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps scores and insufficient-data content hidden until the request settles', async () => {
    let resolve!: (value: ReturnType<typeof okEnvelope>) => void;
    mockFetch.mockReturnValue(
      new Promise<ReturnType<typeof okEnvelope>>((settle) => {
        resolve = settle;
      }),
    );
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-label="Loading"]').text()).toBe('Loading...');
    expect(wrapper.find('[data-testid="composite-score"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(result.summary);
    expect(wrapper.text()).not.toContain(result.recommendations[0]);
    expect(mockFetch).toHaveBeenCalledExactlyOnceWith('/api/financial-health', {
      query: { currentMonth: '2026-01' },
    });

    resolve(okEnvelope());
    await flushPromises();

    expect(wrapper.find('[aria-label="Loading"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="composite-score"]').text()).toBe('85/ 100');
    expect(wrapper.text()).toContain(result.summary);
    expect(wrapper.text()).toContain(result.recommendations[0]);
  });

  it('keeps stale freshness visible alongside the supplied scores', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope(result, { ...currentFreshness, isStale: true, label: 'snapshot is stale' }),
    );
    const wrapper = mountPage();
    await flushPromises();

    expect(
      wrapper.get('[role="status"][aria-label="Data freshness: stale — snapshot is stale"]').text(),
    ).toContain('Stale data');
    expect(wrapper.text()).not.toContain('Data current');
    expect(wrapper.get('[data-testid="composite-score"]').text()).toBe('85/ 100');
  });

  it('makes unavailable freshness visible without claiming data is current', async () => {
    mockFetch.mockResolvedValue(okEnvelope(result, null));
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-label="Data freshness unavailable"]').text()).toBe(
      'Data freshness unavailable.',
    );
    expect(wrapper.findComponent(FreshnessBanner).exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Data current');
    expect(wrapper.get('[data-testid="composite-score"]').text()).toBe('85/ 100');
  });

  it('rejects a null success result without presenting health conclusions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(null));
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe(
      'UNKNOWN: Health assessment returned an error.',
    );
    expect(wrapper.find('[data-testid="composite-score"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Insufficient Data"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Loading"]').exists()).toBe(false);
  });

  it('shows insufficient data for empty dimensions without a fabricated zero score', async () => {
    mockFetch.mockResolvedValue(okEnvelope({ ...result, dimensions: [], compositeScore: 0 }));
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.get('[role="alert"][aria-label="Insufficient Data"]').text()).toContain(
      'Insufficient Data',
    );
    expect(wrapper.find('[aria-label="Loading"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="composite-score"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(result.summary);
    expect(wrapper.text()).not.toContain(result.recommendations[0]);
    expect(wrapper.text()).not.toContain('UNKNOWN');
  });

  it('shows the API error code and message without health conclusions', async () => {
    mockFetch.mockResolvedValue({
      ...okEnvelope(),
      status: 'error',
      result: null,
      error: {
        code: 'STORE_UNAVAILABLE',
        message: 'Health analysis unavailable.',
        retryable: false,
      },
    });
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe(
      'STORE_UNAVAILABLE: Health analysis unavailable.',
    );
    expect(wrapper.find('[data-testid="composite-score"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Insufficient Data"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Loading"]').exists()).toBe(false);
  });

  it('shows a network rejection without health conclusions', async () => {
    mockFetch.mockRejectedValue(new Error('Test network unavailable'));
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe(
      'FETCH_ERROR: Unable to load analysis. Please try again.',
    );
    expect(wrapper.find('[data-testid="composite-score"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Insufficient Data"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Loading"]').exists()).toBe(false);
  });

  it.each([
    [0.6999, true],
    [0.7, false],
    [0.7001, false],
  ])('qualifies data quality %s using the unrounded 0.70 boundary', async (score, qualified) => {
    mockFetch.mockResolvedValue(
      okEnvelope({
        ...result,
        dimensions: [{ ...result.dimensions[0]!, score }],
        compositeScore: score,
      }),
    );
    const wrapper = mountPage();
    await flushPromises();

    const qualification = wrapper.find(
      '[role="status"][aria-label="Qualified by limited data quality"]',
    );
    expect(qualification.exists()).toBe(qualified);
    if (qualified) {
      expect(qualification.isVisible()).toBe(true);
      expect(qualification.text()).toBe('Qualified by limited data quality');
    }
    const region = wrapper.get(
      '[role="region"][aria-label="Global health score — not purchase readiness"]',
    );
    expect(region.text()).toContain('Global health score — not purchase readiness');
    expect(region.get('[data-testid="composite-score"]').text()).toBe('70/ 100');
    expect(wrapper.get('[data-testid="dim-score-data_quality"]').text()).toBe(
      '70/ 100 (weight: 15%)',
    );
    expect(wrapper.text()).toContain(result.dimensions[0]!.explanation);
  });

  it('does not infer limited data quality from a low score in another dimension', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({
        ...result,
        dimensions: [{ ...result.dimensions[0]!, dimension: 'budget_adherence', score: 0.1 }],
        compositeScore: 0.1,
      }),
    );
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.find('[aria-label="Qualified by limited data quality"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="composite-score"]').text()).toBe('10/ 100');
  });

  it('preserves unknown severity as plain text with neutral styling', async () => {
    const severity = '<em>future_severity</em>';
    mockFetch.mockResolvedValue(
      okEnvelope({ ...result, dimensions: [{ ...result.dimensions[0]!, severity }] }),
    );
    const wrapper = mountPage();
    await flushPromises();

    const badge = wrapper.findAll('span').find((span) => span.text() === severity);
    expect(badge).toBeDefined();
    expect(badge!.classes()).toContain('bg-gray-100');
    expect(badge!.find('em').exists()).toBe(false);
    expect(wrapper.get('[data-testid="dim-score-data_quality"]').text()).toBe(
      '85/ 100 (weight: 15%)',
    );
  });

  it('renders zero scores and zero weights as data with visible qualification', async () => {
    mockFetch.mockResolvedValue(
      okEnvelope({
        dimensions: [{ ...result.dimensions[0]!, score: 0, weight: 0, severity: 'critical' }],
        compositeScore: 0,
        summary: '',
        recommendations: [],
      }),
    );
    const wrapper = mountPage();
    await flushPromises();

    const region = wrapper.get(
      '[role="region"][aria-label="Global health score — not purchase readiness"]',
    );
    expect(region.get('[data-testid="composite-score"]').text()).toBe('0/ 100');
    expect(wrapper.get('[data-testid="dim-score-data_quality"]').text()).toBe(
      '0/ 100 (weight: 0%)',
    );
    expect(region.get('[aria-label="Qualified by limited data quality"]').isVisible()).toBe(true);
    expect(wrapper.find('[aria-label="Insufficient Data"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Summary');
    expect(wrapper.text()).not.toContain('Recommendations');
  });
});
