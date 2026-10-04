/**
 * TDD: Reports page fetches report history, saved views, and supports
 * report generation. Renders history table, saved views, and error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import ReportsPage from '../../app/pages/reports.vue';
import SavedViewPicker from '../../app/components/SavedViewPicker.vue';

const stubs = {
  SavedViewPicker,
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
  UButton: {
    template: '<button :data-variant="variant" @click="$emit(\'click\')"><slot /></button>',
    props: ['variant', 'size'],
  },
  UFormField: { template: '<div><slot /></div>', props: ['label'] },
  UInput: {
    template:
      '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
    props: ['modelValue', 'placeholder'],
  },
  AnalysisTable: {
    template:
      '<table data-testid="analysis-table"><tr v-for="(r,i) in rows" :key="i"><td v-for="c in columns" :key="c.key">{{ r[c.key] }}</td></tr></table>',
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

const historyResult = {
  entries: [
    {
      id: 'rpt-1',
      reportType: 'spending',
      budgetId: 'b-1',
      generatedAt: '2026-01-10T12:00:00Z',
      label: 'January Spending',
      isExpired: false,
    },
    {
      id: 'rpt-2',
      reportType: 'income',
      budgetId: 'b-1',
      generatedAt: '2026-01-05T10:00:00Z',
      label: 'January Income',
      isExpired: true,
    },
  ],
  total: 2,
};

const viewsResult = {
  views: [
    {
      viewId: 'v-1',
      name: 'My Budget View',
      viewType: 'reports',
      scope: {},
      createdAt: '2026-01-10T10:00:00Z',
    },
  ],
  total: 1,
};

describe('Reports page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('calls /api/reports/history and /api/reports/views on mount', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history')) return Promise.resolve(okEnvelope(historyResult));
      if (url.includes('/reports/views')) return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(okEnvelope({}));
    });
    shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/reports/history');
    expect(mockFetch).toHaveBeenCalledWith('/api/reports/views');
  });

  it('renders report history entries', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history')) return Promise.resolve(okEnvelope(historyResult));
      if (url.includes('/reports/views')) return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('January Spending');
    expect(wrapper.text()).toContain('January Income');
  });

  it('renders expired status', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history')) return Promise.resolve(okEnvelope(historyResult));
      if (url.includes('/reports/views')) return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Expired');
    expect(wrapper.text()).toContain('Active');
  });

  it('renders saved views', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history')) return Promise.resolve(okEnvelope(historyResult));
      if (url.includes('/reports/views')) return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('My Budget View');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows error on API error envelope', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STORE_UNAVAILABLE'));
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STORE_UNAVAILABLE');
  });

  it('generates the selected report using the edited month range', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/reports/history') return Promise.resolve(okEnvelope(historyResult));
      if (url === '/api/reports/views') return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(
        okEnvelope({
          reportId: 'generated-report',
          reportType: 'spending',
          label: 'January through February',
          transactionCount: 2,
          totalAmount: { minorUnits: '2500', currency: 'USD' },
          generatedAt: '2026-03-01T00:00:00Z',
          tags: ['household'],
        }),
      );
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === 'Spending')!.trigger('click');
    const generate = wrapper.findAll('button').find((button) => button.text() === 'Generate')!;
    await generate.trigger('click');
    expect(mockFetch).not.toHaveBeenCalledWith('/api/reports/generate', expect.anything());
    await wrapper.get('input[placeholder="YYYY-MM or YYYY-MM:YYYY-MM"]').setValue('2026-01:2026-02');
    await generate.trigger('click');
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/reports/generate', {
      query: { reportType: 'spending', monthRange: '2026-01:2026-02' },
    });
    expect(wrapper.get('[data-testid="report-id"]').text()).toBe('Report ID: generated-report');
    expect(wrapper.text()).toContain('January through February');
    expect(wrapper.text()).toContain('household');
  });

  it.each(['api', 'network'])('shows %s generation failures without a report result', async (failure) => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/reports/history') return Promise.resolve(okEnvelope(historyResult));
      if (url === '/api/reports/views') return Promise.resolve(okEnvelope(viewsResult));
      return failure === 'api'
        ? Promise.resolve(errorEnvelope('GENERATE_FAILED'))
        : Promise.reject(new Error('Network unavailable'));
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === 'Income')!.trigger('click');
    await wrapper.get('input[placeholder="YYYY-MM or YYYY-MM:YYYY-MM"]').setValue('2026-02');
    await wrapper.findAll('button').find((button) => button.text() === 'Generate')!.trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="error"]').text()).toBe(
      failure === 'api' ? 'GENERATE_FAILED' : 'FETCH_ERROR',
    );
    expect(wrapper.find('[data-testid="report-id"]').exists()).toBe(false);
  });

  it('restores a saved report selection and replaces its scope when updated', async () => {
    const view = {
      ...viewsResult.views[0]!,
      scope: { reportType: 'income', monthRange: '2026-01' },
      lastUsedAt: null,
    };
    const usedView = { ...view, lastUsedAt: '2026-02-01T12:00:00Z' };
    const updatedView = {
      ...usedView,
      name: 'Updated Budget View',
      scope: { reportType: 'cash_flow', monthRange: '2026-02' },
    };
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/reports/history') return Promise.resolve(okEnvelope(historyResult));
      if (url === '/api/reports/views')
        return Promise.resolve(okEnvelope({ views: [view], total: 1 }));
      if (url === '/api/reports/views/v-1/last-used') return Promise.resolve(okEnvelope(usedView));
      if (url === '/api/reports/views/v-1') return Promise.resolve(okEnvelope(updatedView));
      throw new Error(`Unexpected request: ${url}`);
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === 'Spending')!.trigger('click');
    await wrapper.get('input[placeholder="YYYY-MM or YYYY-MM:YYYY-MM"]').setValue('2025-12');
    expect(wrapper.text()).toContain('Never');
    await wrapper.get('#saved-view-select').setValue('v-1');
    await flushPromises();

    expect(
      wrapper.get<HTMLInputElement>('input[placeholder="YYYY-MM or YYYY-MM:YYYY-MM"]').element.value,
    ).toBe('2026-01');
    expect(
      wrapper.findAll('button').find((button) => button.text() === 'Income')!.attributes('data-variant'),
    ).toBe('solid');
    expect(
      wrapper
        .findAll('button')
        .find((button) => button.text() === 'Spending')!
        .attributes('data-variant'),
    ).toBe('outline');
    expect(wrapper.get<HTMLSelectElement>('#saved-view-select').element.value).toBe('v-1');
    expect(wrapper.text()).toContain(usedView.lastUsedAt);

    await wrapper.findAll('button').find((button) => button.text() === 'Cash Flow')!.trigger('click');
    await wrapper.get('input[placeholder="YYYY-MM or YYYY-MM:YYYY-MM"]').setValue('2026-02');
    await wrapper.findAll('button').find((button) => button.text() === 'Update')!.trigger('click');
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith('/api/reports/views/v-1', {
      method: 'PATCH',
      body: { scope: { reportType: 'cash_flow', monthRange: '2026-02' } },
    });
    expect(wrapper.get('[data-testid="saved-view-picker"]').text()).toContain(
      JSON.stringify(updatedView.scope),
    );
    expect(wrapper.get('#saved-view-select option[value="v-1"]').text()).toBe(updatedView.name);
    expect(wrapper.findAll('#saved-view-select option')).toHaveLength(2);
    expect(wrapper.get<HTMLSelectElement>('#saved-view-select').element.value).toBe('v-1');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('selects a newly saved report view and clears selection when it is deleted', async () => {
    const createdView = {
      ...viewsResult.views[0]!,
      viewId: 'v-2',
      name: 'February income',
      scope: { reportType: 'income', monthRange: '2026-02' },
    };
    mockFetch.mockImplementation((url: string, options?: { method?: string }) => {
      if (url === '/api/reports/history') return Promise.resolve(okEnvelope(historyResult));
      if (url === '/api/reports/views')
        return Promise.resolve(okEnvelope(options?.method === 'POST' ? createdView : viewsResult));
      if (url === '/api/reports/views/v-2') return Promise.resolve(okEnvelope({ deleted: true }));
      throw new Error(`Unexpected request: ${url}`);
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === 'Income')!.trigger('click');
    await wrapper.get('input[placeholder="YYYY-MM or YYYY-MM:YYYY-MM"]').setValue('2026-02');
    await wrapper.get('button[aria-label="Save current view"]').trigger('click');
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith('/api/reports/views', {
      method: 'POST',
      body: {
        name: 'income view',
        viewType: 'reports',
        scope: { reportType: 'income', monthRange: '2026-02' },
      },
    });
    expect(wrapper.get<HTMLSelectElement>('#saved-view-select').element.value).toBe('v-2');
    expect(wrapper.get('#saved-view-select option[value="v-2"]').text()).toBe(createdView.name);
    expect(wrapper.get('[data-testid="saved-view-picker"]').text()).toContain(
      JSON.stringify(createdView.scope),
    );
    expect(wrapper.findAll('#saved-view-select option')).toHaveLength(3);

    await wrapper.findAll('button').find((button) => button.text() === 'Delete')!.trigger('click');
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith('/api/reports/views/v-2', {
      method: 'DELETE',
      body: undefined,
    });
    expect(wrapper.get<HTMLSelectElement>('#saved-view-select').element.value).toBe('');
    expect(wrapper.find('#saved-view-select option[value="v-2"]').exists()).toBe(false);
    expect(wrapper.get('#saved-view-select option[value="v-1"]').text()).toBe('My Budget View');
    expect(wrapper.text()).not.toContain(createdView.name);
    expect(wrapper.findAll('button').some((button) => button.text() === 'Delete')).toBe(false);
  });

  it('preserves the selected saved view on API failures and exposes a retryable error', async () => {
    const view = {
      ...viewsResult.views[0]!,
      scope: { reportType: 'income', monthRange: '2026-01' },
    };
    let viewsLoads = 0;
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/reports/history') return Promise.resolve(okEnvelope(historyResult));
      if (url === '/api/reports/views') {
        viewsLoads += 1;
        return Promise.resolve(
          viewsLoads === 2
            ? errorEnvelope('VIEWS_UNAVAILABLE')
            : okEnvelope({ views: [view], total: 1 }),
        );
      }
      if (url === '/api/reports/views/v-1/last-used') return Promise.resolve(okEnvelope(view));
      if (url === '/api/reports/views/v-1') return Promise.resolve(errorEnvelope('UPDATE_DENIED'));
      throw new Error(`Unexpected request: ${url}`);
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    await wrapper.get('#saved-view-select').setValue('v-1');
    await flushPromises();
    await wrapper.get('input[placeholder="YYYY-MM or YYYY-MM:YYYY-MM"]').setValue('2026-02');
    await wrapper.findAll('button').find((button) => button.text() === 'Update')!.trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('Simulated UPDATE_DENIED');
    expect(wrapper.get<HTMLSelectElement>('#saved-view-select').element.value).toBe('v-1');
    expect(wrapper.get('[data-testid="saved-view-picker"]').text()).toContain(
      JSON.stringify(view.scope),
    );
    expect(wrapper.get('#saved-view-select option[value="v-1"]').text()).toBe(view.name);
    expect(wrapper.findAll('#saved-view-select option')).toHaveLength(2);
    expect(
      wrapper.get<HTMLInputElement>('input[placeholder="YYYY-MM or YYYY-MM:YYYY-MM"]').element.value,
    ).toBe('2026-02');

    await wrapper.get('button[aria-label="Retry saved views"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe('Simulated VIEWS_UNAVAILABLE');
    expect(wrapper.get<HTMLSelectElement>('#saved-view-select').element.value).toBe('v-1');
    expect(wrapper.get('[data-testid="saved-view-picker"]').text()).toContain(
      JSON.stringify(view.scope),
    );

    await wrapper.get('button[aria-label="Retry saved views"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="Retry saved views"]').exists()).toBe(false);
    expect(wrapper.get<HTMLSelectElement>('#saved-view-select').element.value).toBe('v-1');
  });

  it('does not calculate financial conclusions', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/reports/history')) return Promise.resolve(okEnvelope(historyResult));
      if (url.includes('/reports/views')) return Promise.resolve(okEnvelope(viewsResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(ReportsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should');
  });
});
