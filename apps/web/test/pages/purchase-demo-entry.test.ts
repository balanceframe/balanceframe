import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PurchaseCheckPage from '../../app/pages/purchase-check.vue';

const fetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: true } }));

const catalog = {
  accounts: [{ id: 'checking', name: 'Checking', currency: 'USD' }],
  categories: [
    {
      id: 'food',
      name: 'Food',
      availabilityBefore: { minorUnits: '2000', currency: 'USD' },
      backing: [],
      feasible: true,
      reasons: [],
    },
  ],
  purchases: [],
  canCreateSession: false,
};

const stubs = {
  AnalysisPage: {
    template:
      '<main><div v-if="error" role="alert">{{ error.message }}</div><slot name="content" /></main>',
    props: ['title', 'loading', 'error'],
  },
  NuxtLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
  UButton: {
    template:
      '<button :disabled="disabled" type="button" @click="$emit(\'click\')"><slot /></button>',
    props: ['disabled'],
    emits: ['click'],
  },
  DecisionCardView: true,
  TransferPlanReview: true,
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/liquidity/spendability')
      return Promise.resolve({ status: 'ok', result: catalog });
    if (url === '/__demo/state') {
      return Promise.resolve({
        status: 'ready',
        scenarioId: 'funded-purchase',
        generation: 9,
        anchor: null,
        shared: true,
        personaId: 'owner',
        csrfToken: 'csrf-9',
      });
    }
    if (url === '/__demo/entry') {
      return Promise.resolve({
        generation: 9,
        path: '/purchase-check',
        input: {
          categoryId: 'food',
          accountId: 'checking',
          amount: { minorUnits: '2000', currency: 'USD' },
          purchaseAt: '2026-09-06T12:00:00.000Z',
        },
      });
    }
    return Promise.resolve({ status: 'ok', result: {} });
  });
});

describe('demo purchase entry', () => {
  it('prefills only the authorized current-generation purchase input and no computed Card', async () => {
    const wrapper = mount(PurchaseCheckPage, { global: { stubs } });
    await flushPromises();

    expect(wrapper.get('#purchase-category').element.value).toBe('food');
    expect(wrapper.get('#purchase-account').element.value).toBe('checking');
    expect(wrapper.get('#purchase-amount').element.value).toBe('2000');
    expect(wrapper.get('#purchase-currency').element.value).toBe('USD');
    expect(wrapper.get('#purchase-at').element.value).toBe('2026-09-06T12:00');
    expect(wrapper.find('[data-testid="purchase-card"]').exists()).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      '/__demo/entry',
      expect.objectContaining({ query: { generation: 9 }, credentials: 'same-origin' }),
    );
  });

  it('rejects an entry with an unauthorized category without changing the form', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/liquidity/spendability')
        return Promise.resolve({ status: 'ok', result: catalog });
      if (url === '/__demo/state')
        return Promise.resolve({
          status: 'ready',
          scenarioId: 'funded-purchase',
          generation: 9,
          anchor: null,
          shared: true,
          personaId: 'owner',
          csrfToken: 'csrf-9',
        });
      if (url === '/__demo/entry')
        return Promise.resolve({
          generation: 9,
          path: '/purchase-check',
          input: {
            categoryId: 'not-authorized',
            amount: { minorUnits: '2000', currency: 'USD' },
          },
        });
      return Promise.resolve({ status: 'ok', result: {} });
    });

    const wrapper = mount(PurchaseCheckPage, { global: { stubs } });
    await flushPromises();

    expect(wrapper.get('#purchase-category').element.value).toBe('');
    expect(wrapper.get('#purchase-amount').element.value).toBe('');
    expect(wrapper.find('[role="alert"]').text()).toMatch(/demo|authorized|entry/i);
  });

  it('offers the EUR currency-mismatch intent against USD-only authorized entities for a real Card request', async () => {
    const defaultFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/entry') {
        return Promise.resolve({
          generation: 9,
          path: '/purchase-check',
          input: {
            categoryId: 'food',
            accountId: 'checking',
            amount: { minorUnits: '2000', currency: 'EUR' },
          },
        });
      }
      if (url === '/api/purchase/evaluate') {
        return Promise.resolve({
          status: 'ok',
          result: { card: { outcome: 'insufficient_data', blockers: ['currency_mismatch'] } },
        });
      }
      return defaultFetch?.(url);
    });
    const wrapper = mount(PurchaseCheckPage, { global: { stubs } });
    await flushPromises();

    expect(wrapper.get('#purchase-category').element.value).toBe('food');
    expect(wrapper.get('#purchase-account').element.value).toBe('checking');
    expect(wrapper.get('#purchase-amount').element.value).toBe('2000');
    expect(wrapper.get('#purchase-currency').element.value).toBe('EUR');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);

    const evaluate = wrapper.findAll('button').find((button) => button.text() === 'Evaluate');
    if (!evaluate) throw new Error('Purchase evaluation is unavailable');
    await evaluate.trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/purchase/evaluate',
      expect.objectContaining({
        query: expect.objectContaining({
          categoryId: 'food',
          accountId: 'checking',
          amount: '2000',
          currency: 'EUR',
        }),
      }),
    );
    expect(wrapper.find('decision-card-view-stub').exists()).toBe(true);
  });
});
