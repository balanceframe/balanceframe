import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, shallowMount } from '@vue/test-utils';
import type { CashFlowProjectionResult } from '@balanceframe/application';
import CashFlowPage from '../../app/pages/cash-flow.vue';
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
  UCard: { template: '<section><slot name="header" /><slot /></section>' },
  UAlert: {
    props: ['title', 'description'],
    template: '<div role="alert">{{ title }} {{ description }}</div>',
  },
  UIcon: true,
  FreshnessBanner: true,
  SavedViewPicker: true,
  InsufficientDataPanel: true,
  UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
  UFormField: { template: '<div><slot /></div>' },
  UInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
};
const result: CashFlowProjectionResult = {
  projectionMonths: 1,
  monthlyProjections: [
    {
      month: '2026-07',
      projectedIncome: { minorUnits: '9007199254740993', currency: 'USD' },
      projectedExpenses: { minorUnits: '0', currency: 'USD' },
      netChange: { minorUnits: '-100', currency: 'USD' },
      endingBalance: { minorUnits: '9223372036854775807', currency: 'USD' },
      scheduledIncomeCount: 1,
      scheduledExpenseCount: 0,
    },
  ],
  sufficientData: true,
  dataWarning: null,
};
function ok(response: unknown) {
  return { status: 'ok', result: response, error: null };
}
async function project(response: unknown) {
  mockFetch.mockResolvedValue(ok(response));
  const wrapper = shallowMount(CashFlowPage, { global: { stubs } });
  expect(mockFetch).not.toHaveBeenCalled();
  const projectButton = wrapper.findAll('button').find((button) => button.text() === 'Project')!;
  expect(projectButton.attributes('disabled')).toBeUndefined();
  await projectButton.trigger('click');
  await flushPromises();
  return wrapper;
}
beforeEach(() => {
  mockFetch.mockReset();
});

describe('Cash Flow application response contract', () => {
  it('renders canonical monthly fields and preserves exact server money, zero and negative amounts', async () => {
    const wrapper = await project(result);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(
      wrapper
        .get('table')
        .findAll('tbody td')
        .map((cell) => cell.text()),
    ).toEqual([
      '2026-07',
      '90071992547409.93 USD',
      '0.00 USD',
      '−1.00 USD',
      '92233720368547758.07 USD',
    ]);
    expect(mockFetch).toHaveBeenCalledWith('/api/cash-flow/project', { query: { months: '3' } });
    expect(wrapper.text()).not.toContain('Warning');
    expect(wrapper.text()).not.toContain('Assumptions');
    expect(wrapper.text()).not.toContain('Envelope Availability');
    wrapper.unmount();
  });

  it.each([null, 'No scheduled transactions are available.'])(
    'shows insufficient data with warning %s and keeps projection reachable',
    async (dataWarning) => {
      const wrapper = await project({
        ...result,
        monthlyProjections: [],
        sufficientData: false,
        dataWarning,
      } satisfies CashFlowProjectionResult);
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
      expect(wrapper.text()).toContain(dataWarning ?? 'Projection data is insufficient.');
      expect(
        wrapper
          .findAll('button')
          .some(
            (button) => button.text() === 'Project' && button.attributes('disabled') === undefined,
          ),
      ).toBe(true);
      expect(wrapper.find('table').exists()).toBe(false);
      wrapper.unmount();
    },
  );

  it('preserves an explicit server warning even when sufficientData is true', async () => {
    const wrapper = await project({
      ...result,
      dataWarning: 'This projection includes estimated schedules.',
    } satisfies CashFlowProjectionResult);
    expect(wrapper.text()).toContain('This projection includes estimated schedules.');
    expect(wrapper.find('table').exists()).toBe(true);
    wrapper.unmount();
  });

  it('shows unexpected null monetary fields as Unknown instead of fabricating zero', async () => {
    const wrapper = await project({
      ...result,
      monthlyProjections: [
        {
          ...result.monthlyProjections[0]!,
          projectedIncome: null,
          projectedExpenses: null,
          netChange: null,
          endingBalance: null,
        },
      ],
    });
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(
      wrapper
        .get('table')
        .findAll('tbody td')
        .map((cell) => cell.text()),
    ).toEqual(['2026-07', 'Unknown', 'Unknown', 'Unknown', 'Unknown']);
    wrapper.unmount();
  });

  it('treats a missing successful result as a projection failure', async () => {
    const wrapper = await project(null);
    expect(wrapper.get('[role="alert"]').text()).toContain('PROJECT_FAILED');
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="Retry loading"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
