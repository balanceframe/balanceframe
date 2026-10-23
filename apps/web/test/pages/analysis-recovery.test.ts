import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, shallowMount } from '@vue/test-utils';
import AnalysisPage from '../../app/components/AnalysisPage.vue';
import InsufficientDataPanel from '../../app/components/InsufficientDataPanel.vue';
import SavedViewPicker from '../../app/components/SavedViewPicker.vue';
import CashFlowPage from '../../app/pages/cash-flow.vue';
import ReportsPage from '../../app/pages/reports.vue';
import HealthPage from '../../app/pages/health.vue';
import IncomePage from '../../app/pages/income.vue';
import TrendsPage from '../../app/pages/trends.vue';
import CalendarPage from '../../app/pages/calendar.vue';
import ObligationsPage from '../../app/pages/obligations.vue';
import DataQualityPage from '../../app/pages/data-quality.vue';
import ForecastAccuracyPage from '../../app/pages/forecast-accuracy.vue';
import LiquidityPage from '../../app/pages/liquidity.vue';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

const stubs = {
  AnalysisPage,
  InsufficientDataPanel,
  SavedViewPicker,
  SemanticAmount: true,
  AnalysisTable: true,
  FreshnessBanner: true,
  UIcon: true,
  CurrentLiquidityPanel: true,
  ScopeSummary: true,
  UContainer: { template: '<main><slot /></main>' },
  UCard: { template: '<section><slot name="header" /><slot /></section>' },
  UAlert: {
    props: ['title', 'description'],
    template: '<div role="alert">{{ title }} {{ description }}</div>',
  },
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UFormField: { template: '<div><slot /></div>' },
  UInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
};

function ok(result: unknown) {
  return { status: 'ok', result, error: null, dataFreshness: null };
}

function failed(retryable?: boolean) {
  return {
    status: 'error',
    result: null,
    error: { code: 'UNAVAILABLE', message: 'Try later.', retryable },
  };
}

const pages = [
  {
    name: 'health',
    component: HealthPage,
    endpoint: '/api/financial-health',
    result: { dimensions: [], compositeScore: null, summary: '', recommendations: [] },
  },
  {
    name: 'income',
    component: IncomePage,
    endpoint: '/api/income',
    result: { sources: [], totalMonthly: null, overallScore: null, unreliableSourceCount: 0 },
  },
  {
    name: 'trends',
    component: TrendsPage,
    endpoint: '/api/trends-variance',
    result: {
      categoryVariances: [],
      trends: [],
      totalBudgeted: null,
      totalActual: null,
      totalVariance: null,
      overallVariancePercent: null,
    },
  },
  {
    name: 'calendar',
    component: CalendarPage,
    endpoint: '/api/calendar',
    result: { entries: [], totalUnpaid: null, unpaidCount: 0 },
  },
  {
    name: 'obligations',
    component: ObligationsPage,
    endpoint: '/api/obligations',
    result: { obligations: [], totalEstimatedAnnual: null },
  },
  {
    name: 'data quality',
    component: DataQualityPage,
    endpoint: '/api/data-quality',
    result: { overallScore: null, dimensions: [], recommendations: [] },
  },
  {
    name: 'forecast accuracy',
    component: ForecastAccuracyPage,
    endpoint: '/api/forecast-accuracy',
    result: { metrics: [], overallCalibrated: false, recommendations: [] },
  },
  {
    name: 'liquidity',
    component: LiquidityPage,
    endpoint: '/api/liquidity',
    result: { totalLiquid: null, totalObligations: null, coverage: [], upcomingObligations: [] },
  },
];

beforeEach(() => {
  mockFetch.mockReset();
});

describe('Analysis recovery with the real shared page', () => {
  it('lets a new cash-flow user project without existing results', async () => {
    mockFetch.mockResolvedValue(
      ok({ projectionMonths: 3, monthlyProjections: [], sufficientData: true, dataWarning: null }),
    );
    const wrapper = shallowMount(CashFlowPage, { global: { stubs } });
    expect(mockFetch).not.toHaveBeenCalled();
    const project = wrapper.findAll('button').find((button) => button.text() === 'Project');
    expect(project, 'Project must be reachable before any projection exists').toBeDefined();
    await project!.trigger('click');
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/cash-flow/project', { query: { months: '3' } });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('lets an empty reports user generate a report and save a view', async () => {
    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (url === '/api/reports/history') return Promise.resolve(ok({ entries: [], total: 0 }));
      if (url === '/api/reports/views' && options?.method !== 'POST')
        return Promise.resolve(ok({ views: [], total: 0 }));
      if (url === '/api/reports/views')
        return Promise.resolve(
          ok({ viewId: 'new-view', name: 'spending view', viewType: 'reports', scope: {} }),
        );
      return Promise.resolve(
        ok({ reportId: 'first-report', reportType: 'spending', label: 'First report' }),
      );
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Select a report type above to get started.');
    const spending = wrapper.findAll('button').find((button) => button.text() === 'Spending');
    expect(spending, 'Report types must be reachable with empty history and views').toBeDefined();
    await spending!.trigger('click');
    await wrapper.get('input').setValue('2026-01');
    await wrapper.get('button[aria-label="Save current view"]').trigger('click');
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/reports/views',
      expect.objectContaining({ method: 'POST' }),
    );
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Generate')!
      .trigger('click');
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/reports/generate', {
      query: { reportType: 'spending', monthRange: '2026-01' },
    });
    expect(wrapper.text()).toContain('Report ID: first-report');
    wrapper.unmount();
  });

  it('keeps a saved-views retry reachable when reports history is empty', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/reports/history' ? ok({ entries: [], total: 0 }) : failed(true),
      ),
    );
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    const retry = wrapper.find('button[aria-label="Retry saved views"]');
    expect(retry.exists()).toBe(true);
    mockFetch.mockResolvedValue(ok({ views: [], total: 0 }));
    await retry.trigger('click');
    await flushPromises();
    expect(wrapper.find('button[aria-label="Retry saved views"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="saved-view-picker"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it.each(['api', 'http', 'network'])(
    'retries a recoverable %s report-history load',
    async (failure) => {
      if (failure === 'api') mockFetch.mockResolvedValueOnce(failed(true));
      else if (failure === 'http') mockFetch.mockRejectedValueOnce({ data: failed(true) });
      else mockFetch.mockRejectedValueOnce(new Error('Network unavailable'));
      mockFetch.mockResolvedValue(ok({ views: [], total: 0 }));
      const wrapper = shallowMount(ReportsPage, { global: { stubs } });
      await flushPromises();
      const retry = wrapper.find('button[aria-label="Retry loading"]');
      expect(retry.exists()).toBe(true);
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(
          ok(url === '/api/reports/history' ? { entries: [], total: 0 } : { views: [], total: 0 }),
        ),
      );
      await retry.trigger('click');
      await flushPromises();
      expect(mockFetch.mock.calls.filter(([url]) => url === '/api/reports/history')).toHaveLength(
        2,
      );
      expect(wrapper.text()).toContain('Select a report type above to get started.');
      expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
      wrapper.unmount();
    },
  );

  it.each(['api', 'http', 'network'])(
    'retries a recoverable %s report generation with its original inputs',
    async (failure) => {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/reports/history') return Promise.resolve(ok({ entries: [], total: 0 }));
        return Promise.resolve(ok({ views: [], total: 0 }));
      });
      const wrapper = shallowMount(ReportsPage, { global: { stubs } });
      await flushPromises();
      await wrapper
        .findAll('button')
        .find((button) => button.text() === 'Income')!
        .trigger('click');
      await wrapper.get('input').setValue('2026-01');
      if (failure === 'api') mockFetch.mockResolvedValueOnce(failed(true));
      else if (failure === 'http') mockFetch.mockRejectedValueOnce({ data: failed(true) });
      else mockFetch.mockRejectedValueOnce(new Error('Network unavailable'));
      await wrapper
        .findAll('button')
        .find((button) => button.text() === 'Generate')!
        .trigger('click');
      await flushPromises();
      const retry = wrapper.find('button[aria-label="Retry loading"]');
      expect(retry.exists()).toBe(true);
      mockFetch.mockResolvedValueOnce(
        ok({ reportId: 'retried-report', reportType: 'income', label: 'Retried income' }),
      );
      await retry.trigger('click');
      await flushPromises();
      expect(mockFetch.mock.calls.filter(([url]) => url === '/api/reports/generate')).toEqual([
        ['/api/reports/generate', { query: { reportType: 'income', monthRange: '2026-01' } }],
        ['/api/reports/generate', { query: { reportType: 'income', monthRange: '2026-01' } }],
      ]);
      expect(wrapper.text()).toContain('Report ID: retried-report');
      expect(mockFetch.mock.calls.filter(([url]) => url === '/api/reports/history')).toHaveLength(
        1,
      );
      wrapper.unmount();
    },
  );

  it.each(['api', 'http', 'network'])(
    'retries a recoverable %s cash-flow projection',
    async (failure) => {
      if (failure === 'api') mockFetch.mockResolvedValueOnce(failed(true));
      else if (failure === 'http') mockFetch.mockRejectedValueOnce({ data: failed(true) });
      else mockFetch.mockRejectedValueOnce(new Error('Network unavailable'));
      const wrapper = shallowMount(CashFlowPage, { global: { stubs } });
      await wrapper.get('input').setValue('6');
      await wrapper
        .findAll('button')
        .find((button) => button.text() === 'Project')!
        .trigger('click');
      await flushPromises();
      const retry = wrapper.find('button[aria-label="Retry loading"]');
      expect(retry.exists()).toBe(true);
      mockFetch.mockResolvedValueOnce(
        ok({
          projectionMonths: 6,
          monthlyProjections: [],
          sufficientData: true,
          dataWarning: null,
        }),
      );
      await retry.trigger('click');
      await flushPromises();
      expect(mockFetch.mock.calls).toEqual([
        ['/api/cash-flow/project', { query: { months: '6' } }],
        ['/api/cash-flow/project', { query: { months: '6' } }],
      ]);
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      wrapper.unmount();
    },
  );

  it.each([false, undefined])(
    'does not offer a retry for a non-retryable projection error (%s)',
    async (retryable) => {
      mockFetch.mockResolvedValue(failed(retryable));
      const wrapper = shallowMount(CashFlowPage, { global: { stubs } });
      await wrapper
        .findAll('button')
        .find((button) => button.text() === 'Project')!
        .trigger('click');
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain('UNAVAILABLE');
      expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
      wrapper.unmount();
    },
  );

  it.each([false, undefined])(
    'does not offer a retry for non-retryable report history (%s)',
    async (retryable) => {
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(
          url === '/api/reports/history' ? failed(retryable) : ok({ views: [], total: 0 }),
        ),
      );
      const wrapper = shallowMount(ReportsPage, { global: { stubs } });
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain('UNAVAILABLE');
      expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
      wrapper.unmount();
    },
  );

  it.each([false, undefined])(
    'does not offer a retry for non-retryable report generation (%s)',
    async (retryable) => {
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(
          ok(url === '/api/reports/history' ? { entries: [], total: 0 } : { views: [], total: 0 }),
        ),
      );
      const wrapper = shallowMount(ReportsPage, { global: { stubs } });
      await flushPromises();
      await wrapper
        .findAll('button')
        .find((button) => button.text() === 'Income')!
        .trigger('click');
      await wrapper.get('input').setValue('2026-01');
      mockFetch.mockResolvedValueOnce(failed(retryable));
      await wrapper
        .findAll('button')
        .find((button) => button.text() === 'Generate')!
        .trigger('click');
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain('UNAVAILABLE');
      expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
      wrapper.unmount();
    },
  );

  it('keeps insufficient projection data visible while allowing another projection', async () => {
    mockFetch.mockResolvedValue(
      ok({
        projectionMonths: 0,
        monthlyProjections: [],
        sufficientData: false,
        dataWarning: 'Not enough transaction history to produce reliable projections.',
      }),
    );
    const wrapper = shallowMount(CashFlowPage, { global: { stubs } });
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Project')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain(
      'Not enough transaction history to produce reliable projections.',
    );
    expect(wrapper.findAll('button').some((button) => button.text() === 'Project')).toBe(true);
    wrapper.unmount();
  });

  it('allows invalid projection parameters to be edited without retrying the denied request', async () => {
    mockFetch.mockResolvedValueOnce({
      ...failed(false),
      error: { code: 'VALIDATION_ERROR', message: 'Months must not exceed 24.', retryable: false },
    });
    const wrapper = shallowMount(CashFlowPage, { global: { stubs } });
    await wrapper.get('input').setValue('25');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Project')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('VALIDATION_ERROR');
    expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
    const edit = wrapper.findAll('button').find((button) => button.text() === 'Edit parameters');
    expect(edit).toBeDefined();
    await edit!.trigger('click');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(wrapper.get<HTMLInputElement>('input').element.value).toBe('25');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await wrapper.get('input').setValue('6');
    mockFetch.mockResolvedValueOnce(
      ok({ projectionMonths: 6, monthlyProjections: [], sufficientData: true, dataWarning: null }),
    );
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Project')!
      .trigger('click');
    await flushPromises();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/cash-flow/project', {
      query: { months: '6' },
    });
    wrapper.unmount();
  });

  it('allows an invalid report month range to be edited without retrying the denied request', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        ok(url === '/api/reports/history' ? { entries: [], total: 0 } : { views: [], total: 0 }),
      ),
    );
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Income')!
      .trigger('click');
    await wrapper.get('input').setValue('bad');
    mockFetch.mockRejectedValueOnce({
      data: {
        ...failed(false),
        error: { code: 'VALIDATION_ERROR', message: 'Invalid month range.', retryable: false },
      },
    });
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Generate')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('VALIDATION_ERROR');
    expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
    const edit = wrapper.findAll('button').find((button) => button.text() === 'Edit parameters');
    expect(edit).toBeDefined();
    await edit!.trigger('click');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(wrapper.get<HTMLInputElement>('input').element.value).toBe('bad');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    await wrapper.get('input').setValue('2026-01');
    mockFetch.mockResolvedValueOnce(
      ok({ reportId: 'corrected-report', reportType: 'income', label: 'Corrected report' }),
    );
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Generate')!
      .trigger('click');
    await flushPromises();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/reports/generate', {
      query: { reportType: 'income', monthRange: '2026-01' },
    });
    expect(wrapper.text()).toContain('Report ID: corrected-report');
    wrapper.unmount();
  });

  describe.each(pages)('$name', ({ component, endpoint, result }) => {
    it.each(['api', 'http', 'network'])(
      'retries a recoverable %s load and reaches the empty state',
      async (failure) => {
        if (failure === 'api') mockFetch.mockResolvedValueOnce(failed(true));
        else if (failure === 'http') mockFetch.mockRejectedValueOnce({ data: failed(true) });
        else mockFetch.mockRejectedValueOnce(new Error('Network unavailable'));
        const wrapper = shallowMount(component, { global: { stubs } });
        await flushPromises();
        const retry = wrapper.find('button[aria-label="Retry loading"]');
        expect(retry.exists()).toBe(true);
        let resolveLoad!: (value: unknown) => void;
        mockFetch.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveLoad = resolve;
            }),
        );
        await retry.trigger('click');
        expect(wrapper.find('[aria-label="Loading"]').exists()).toBe(true);
        expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
        expect(mockFetch.mock.calls[1]?.[0]).toBe(endpoint);
        resolveLoad(ok(result));
        await flushPromises();
        expect(wrapper.find('[aria-label="Loading"]').exists()).toBe(false);
        expect(wrapper.find('[aria-label="Insufficient Data"]').exists()).toBe(true);
        expect(wrapper.text()).not.toContain('Try later.');
        wrapper.unmount();
      },
    );

    it.each([false, undefined])(
      'preserves non-retryable HTTP error envelopes (%s)',
      async (retryable) => {
        mockFetch.mockRejectedValue({ data: failed(retryable) });
        const wrapper = shallowMount(component, { global: { stubs } });
        await flushPromises();
        expect(wrapper.get('[role="alert"]').text()).toContain('UNAVAILABLE');
        expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        wrapper.unmount();
      },
    );

    it.each([false, undefined])('preserves non-retryable API errors (%s)', async (retryable) => {
      mockFetch.mockResolvedValue(failed(retryable));
      const wrapper = shallowMount(component, { global: { stubs } });
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain('UNAVAILABLE');
      expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    });
  });
});
