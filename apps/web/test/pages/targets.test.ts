import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, shallowMount } from '@vue/test-utils';
import type {
  CategoryHealthResult,
  SinkingFundHealthResult,
  TargetHealthResult,
} from '@balanceframe/application';
import TargetsPage from '../../app/pages/targets.vue';
import AnalysisPage from '../../app/components/AnalysisPage.vue';
import AnalysisTable from '../../app/components/AnalysisTable.vue';
import SemanticAmount from '../../app/components/SemanticAmount.vue';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);
const stubs = {
  AnalysisPage,
  AnalysisTable,
  SemanticAmount,
  UContainer: { template: '<main><slot /></main>' },
  UAlert: {
    props: ['title', 'description'],
    template: '<div role="alert">{{ title }} {{ description }}</div>',
  },
  UIcon: true,
  FreshnessBanner: true,
  SavedViewPicker: true,
  InsufficientDataPanel: true,
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
};

// These are the application contracts forwarded unchanged by both health endpoints.
const category: CategoryHealthResult = {
  categoryId: 'cat/groceries',
  categoryName: 'Groceries',
  budgeted: { minorUnits: '400000', currency: 'USD' },
  spent: { minorUnits: '12345', currency: 'USD' },
  remaining: { minorUnits: '387655', currency: 'USD' },
  healthLabel: 'healthy',
  isSinkingFund: false,
  targetAmount: null,
  targetProgress: null,
};
const targets: TargetHealthResult = {
  categories: [category],
  overallLabel: 'healthy',
  healthyCount: 1,
  atRiskCount: 0,
  sinkingFundCount: 0,
};
const emptyTargets: TargetHealthResult = {
  categories: [],
  overallLabel: 'unknown',
  healthyCount: 0,
  atRiskCount: 0,
  sinkingFundCount: 0,
};
const emptySinking: SinkingFundHealthResult = {
  sinkingFunds: [],
  fullyFundedCount: 0,
  partiallyFundedCount: 0,
  unfundedCount: 0,
};
function ok(result: unknown) {
  return { status: 'ok', result, error: null };
}
function failed(retryable?: boolean) {
  return {
    status: 'error',
    result: null,
    error: { code: 'TARGET_UNAVAILABLE', message: 'Target health unavailable.', retryable },
  };
}
const endpoints = ['/api/targets/health', '/api/sinking-fund/health'];
function success(url: string) {
  return ok(url === endpoints[0] ? emptyTargets : emptySinking);
}
function mountPage() {
  return shallowMount(TargetsPage, { global: { stubs } });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('Targets server contract and recovery', () => {
  it('shows server budgeted, spent, remaining and health without inventing target progress', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(ok(url === endpoints[0] ? targets : emptySinking)),
    );
    const wrapper = mountPage();
    await flushPromises();
    const table = wrapper.get('table');
    expect(table.findAll('th').map((cell) => cell.text())).toEqual([
      'Category',
      'Budgeted',
      'Spent',
      'Remaining',
      'Status',
    ]);
    expect(table.findAll('tbody td').map((cell) => cell.text())).toEqual([
      'Groceries',
      '4000.00 USD',
      '123.45 USD',
      '3876.55 USD',
      'healthy',
    ]);
    expect(wrapper.text()).not.toContain('NaN');
    expect(wrapper.get('a').attributes('href')).toBe('/liquidity#category-cat%2Fgroceries');
    wrapper.unmount();
  });

  it('preserves sinking-fund unknowns, zero progress, server status and exact large money', async () => {
    const sinking: SinkingFundHealthResult = {
      sinkingFunds: [null, 0, 0.5].map((targetProgress, index) => ({
        ...category,
        categoryId: `fund-${index}`,
        categoryName: `Fund ${index}`,
        isSinkingFund: true,
        targetAmount:
          targetProgress === null ? null : { minorUnits: '9223372036854775807', currency: 'USD' },
        remaining: { minorUnits: '9007199254740993', currency: 'USD' },
        targetProgress,
        healthLabel: 'at_risk',
      })),
      fullyFundedCount: 0,
      partiallyFundedCount: 1,
      unfundedCount: 1,
    };
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(ok(url === endpoints[0] ? emptyTargets : sinking)),
    );
    const wrapper = mountPage();
    await flushPromises();
    const table = wrapper.findAll('table').at(-1)!;
    expect(table.findAll('th').map((cell) => cell.text())).toEqual([
      'Category',
      'Target',
      'Remaining',
      'Progress',
      'Status',
    ]);
    expect(
      table.findAll('tbody tr').map((row) => row.findAll('td').map((cell) => cell.text())),
    ).toEqual([
      ['Fund 0', 'Unknown', '90071992547409.93 USD', 'Unknown', 'at_risk'],
      ['Fund 1', '92233720368547758.07 USD', '90071992547409.93 USD', '0%', 'at_risk'],
      ['Fund 2', '92233720368547758.07 USD', '90071992547409.93 USD', '50%', 'at_risk'],
    ]);
    expect(wrapper.text()).not.toContain('NaN');
    expect(wrapper.text()).not.toContain('No target categories configured.');
    wrapper.unmount();
  });

  it('shows the empty state only after both successful empty responses', async () => {
    mockFetch.mockImplementation((url: string) => Promise.resolve(success(url)));
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('No target categories configured.');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  describe.each(endpoints)('%s', (failedEndpoint) => {
    it.each(['api', 'http', 'network'])(
      'recovers from %s errors by explicitly reloading both sources',
      async (failure) => {
        mockFetch.mockImplementation((url: string) => {
          if (url !== failedEndpoint) return Promise.resolve(success(url));
          if (failure === 'api') return Promise.resolve(failed(true));
          return Promise.reject(
            failure === 'http' ? { data: failed(true) } : new Error('private network details'),
          );
        });
        const wrapper = mountPage();
        await flushPromises();
        expect(wrapper.get('[role="alert"]').text()).toContain(
          failure === 'network' ? 'FETCH_ERROR' : 'TARGET_UNAVAILABLE',
        );
        expect(wrapper.text()).not.toContain('No target categories configured.');
        expect(wrapper.text()).not.toContain('private network details');
        const retry = wrapper.find('button[aria-label="Retry loading"]');
        expect(retry.exists()).toBe(true);
        mockFetch.mockImplementation((url: string) => Promise.resolve(success(url)));
        await retry.trigger('click');
        await flushPromises();
        expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([...endpoints, ...endpoints]);
        expect(wrapper.find('[role="alert"]').exists()).toBe(false);
        expect(wrapper.text()).toContain('No target categories configured.');
        wrapper.unmount();
      },
    );

    it.each([false, undefined])('preserves non-retryable API failures (%s)', async (retryable) => {
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(url === failedEndpoint ? failed(retryable) : success(url)),
      );
      const wrapper = mountPage();
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain('TARGET_UNAVAILABLE');
      expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('No target categories configured.');
      wrapper.unmount();
    });

    it('preserves a non-retryable HTTP authorization failure', async () => {
      mockFetch.mockImplementation((url: string) =>
        url === failedEndpoint
          ? Promise.reject({ data: failed(false) })
          : Promise.resolve(success(url)),
      );
      const wrapper = mountPage();
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain('TARGET_UNAVAILABLE');
      expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      wrapper.unmount();
    });

    it('does not report empty targets for an unsuccessful response without error metadata', async () => {
      mockFetch.mockImplementation((url: string) =>
        Promise.resolve(
          url === failedEndpoint ? { status: 'error', result: null, error: null } : success(url),
        ),
      );
      const wrapper = mountPage();
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain('TARGETS_FAILED');
      expect(wrapper.text()).not.toContain('No target categories configured.');
      wrapper.unmount();
    });
  });
});
