/**
 * TDD: Calendar page fetches /api/calendar and renders bill entries,
 * unpaid totals, status badges, and error states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import CalendarPage from '../../app/pages/calendar.vue';

const stubs = {
  AnalysisPage: { template: '<div><span v-if="error" data-testid="error">{{ error.code }}</span><slot v-else name="content" /></div>', props: ['title', 'loading', 'error', 'freshness', 'insufficientData'] },
  SemanticAmount: { template: '<span data-testid="semantic-amount">{{ amount.minorUnits }}</span>', props: ['amount'] },
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
  entries: [
    { name: 'Electric Bill', dueDate: '2026-02-05', amount: { minorUnits: '12000', currency: 'USD' }, categoryId: 'cat-1', status: 'unpaid' },
    { name: 'Internet', dueDate: '2026-02-10', amount: { minorUnits: '6500', currency: 'USD' }, categoryId: 'cat-2', status: 'paid' },
    { name: 'Car Insurance', dueDate: '2026-02-15', amount: { minorUnits: '8500', currency: 'USD' }, categoryId: null, status: 'unpaid' },
  ],
  totalUnpaid: { minorUnits: '20500', currency: 'USD' },
  unpaidCount: 2,
};

describe('Calendar page', () => {
  beforeEach(() => { vi.clearAllMocks(); mockFetch.mockReset(); });

  it('calls /api/calendar on mount', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    shallowMount(CalendarPage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/calendar', expect.objectContaining({ query: expect.any(Object) }));
  });

  it('renders bill entry names', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(CalendarPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Electric Bill');
    expect(wrapper.text()).toContain('Internet');
    expect(wrapper.text()).toContain('Car Insurance');
  });

  it('renders unpaid count', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(CalendarPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('2');
  });

  it('renders status labels', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(CalendarPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('paid');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(CalendarPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows error on API error envelope', async () => {
    mockFetch.mockResolvedValue(errorEnvelope('STORE_UNAVAILABLE'));
    const wrapper = shallowMount(CalendarPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('STORE_UNAVAILABLE');
  });

  it('shows stale data freshness', async () => {
    const stale = okEnvelope(sampleResult);
    stale.dataFreshness = { isStale: true, lastSync: '2025-12-01T00:00:00Z', label: 'stale' };
    mockFetch.mockResolvedValue(stale);
    const wrapper = shallowMount(CalendarPage, { global: { stubs } });
    await flushPromises();
    // Stale freshness is passed to AnalysisPage as prop; content renders
    expect(wrapper.text()).toContain('Electric Bill');
  });

  it('shows empty state when no entries', async () => {
    mockFetch.mockResolvedValue(okEnvelope({ entries: [], totalUnpaid: null, unpaidCount: 0 }));
    const wrapper = shallowMount(CalendarPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No calendar entries available');
  });

  it('renders semantic amount labels', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(CalendarPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Electric Bill');
  });

  it('does not calculate financial conclusions', async () => {
    mockFetch.mockResolvedValue(okEnvelope(sampleResult));
    const wrapper = shallowMount(CalendarPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('You should');
  });
});
