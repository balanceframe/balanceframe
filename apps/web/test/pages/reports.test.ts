/**
 * TDD: Reports page fetches report history, saved views, and supports
 * report generation. Renders history table, saved views, and error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import ReportsPage from '../../app/pages/reports.vue';

const stubs = {
  AnalysisPage: { template: '<div><span v-if="error" data-testid="error">{{ error.code }}</span><slot name="content" /></div>', props: ['title', 'loading', 'error', 'freshness', 'insufficientData'] },
  SemanticAmount: { template: '<span data-testid="semantic-amount">{{ amount.minorUnits }}</span>', props: ['amount'] },
  UCard: { template: '<div><slot name="header" /><slot /></div>' },
  UButton: { template: '<button @click="$emit(\'click\')"><slot /></button>', props: ['variant', 'size'] },
  UFormGroup: { template: '<div><slot /></div>', props: ['label'] },
  UInput: { template: '<input />', props: ['modelValue', 'placeholder'] },
  AnalysisTable: { template: '<table data-testid="analysis-table"><tr v-for="(r,i) in rows" :key="i"><td v-for="c in columns" :key="c.key">{{ r[c.key] }}</td></tr></table>', props: ['columns', 'rows'] },
};

function okEnvelope(result: unknown) {
  return { schemaVersion: '1', requestId: 'req-test', status: 'ok' as const, dataFreshness: { isStale: false, lastSync: '2026-01-15T10:00:00Z', label: 'current' }, authorization: null, result, error: null };
}

function errorEnvelope(code: string) {
  return { schemaVersion: '1', requestId: 'req-test', status: 'error' as const, dataFreshness: null, authorization: null, result: null, error: { code, message: `Simulated ${code}`, retryable: true } };
}

const historyResult = {
  entries: [
    { id: 'rpt-1', reportType: 'spending', budgetId: 'b-1', generatedAt: '2026-01-10T12:00:00Z', label: 'January Spending', isExpired: false },
    { id: 'rpt-2', reportType: 'income', budgetId: 'b-1', generatedAt: '2026-01-05T10:00:00Z', label: 'January Income', isExpired: true },
  ],
  total: 2,
};

const viewsResult = {
  views: [
    { viewId: 'v-1', name: 'My Budget View', viewType: 'reports', scope: {}, createdAt: '2026-01-10T10:00:00Z' },
  ],
  total: 1,
};

describe('Reports page', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset(); });

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
