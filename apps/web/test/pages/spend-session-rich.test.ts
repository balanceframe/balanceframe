import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { PublicDecisionCard, PublicLiquidityView, PublicSpendSession } from '@balanceframe/application';
import SpendSessionEditor from '../../app/components/SpendSessionEditor.vue';
import actionFixture from '../../../../protocol/fixtures/consequential-action.json';
import SemanticAmount from '../../app/components/SemanticAmount.vue';

const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const fetchMock = vi.fn();
const navigateTo = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
vi.stubGlobal('navigateTo', navigateTo);
const catalog: PublicLiquidityView = {
  evaluatedAt: '2026-09-06T10:01:00.000Z',
  horizon: { startsAt: '2026-09-06T10:01:00.000Z', endsAt: '2026-10-06T10:01:00.000Z' },
  expiresAt: '2026-09-06T10:15:00.000Z',
  fundingStatus: 'funded', paymentStatus: 'ready', reasons: [], assumptions: [],
  accounts: [{ id: 'checking', name: 'Checking', reasons: [] }],
  categories: [
    { id: 'food', name: 'Food', feasible: true, backing: [], reasons: [] },
    { id: 'reserve', name: 'Reserve', feasible: true, backing: [], reasons: [] },
    { id: 'other', name: 'Other', feasible: true, backing: [], reasons: [] },
  ],
  purchases: [], canConfigure: false, canManageGrants: false, canCreateSession: true,
};
const card: PublicDecisionCard = {
  outcome: 'funded_now', budgetFundingStatus: 'funded', paymentLiquidityStatus: 'ready',
  selectedAccountId: 'checking', before: null, after: null, fundingPaths: [], evidence: [], blockers: [],
  cart: {
    subtotal: money('5000'), tax: money('500'), fee: money('0'), discount: money('0'), total: money('5500'),
    categoryCharges: [{ categoryId: 'food', amount: money('3500') }, { categoryId: 'other', amount: money('2000') }],
    accountCharges: [{ accountId: 'checking', amount: money('5500') }],
  },
  warnings: [{
    thresholdId: 'cart-limit', threshold: money('5000'), actual: money('5500'), excess: money('500'),
    reason: 'threshold_exceeded', alternatives: [{
      removedItemIds: ['optional'], retainedItemIds: ['required'], total: money('1500'),
      outcome: 'funded_now', categoryCharges: [{ categoryId: 'food', amount: money('1500') }],
    }],
  }],
  trimAlternatives: [{
    removedItemIds: ['optional'], retainedItemIds: ['required'], total: money('1500'),
    outcome: 'funded_now', categoryCharges: [{ categoryId: 'food', amount: money('1500') }],
  }],
};
const session = (): PublicSpendSession => ({
  id: 'fixture-session', version: 3, accountId: 'checking',
  createdAt: '2026-09-06T10:00:00.000Z', expiresAt: '2026-09-06T15:00:00.000Z',
  items: [
    {
      id: 'required', categoryId: 'food', amount: money('1000'), quantity: 1, priority: 'required',
      accountId: null, purchaseAt: '2026-09-06T12:00:00.000Z', requiredBy: '2026-09-06T12:00:00.000Z',
      priceProvenance: { kind: 'current_session_manual', observedAt: '2026-09-06T10:00:00.000Z', estimate: false },
    },
    {
      id: 'optional', categoryId: 'food', amount: money('2000'), quantity: 2, priority: 'optional',
      categoryAllocations: [{ categoryId: 'food', amount: money('2000') }, { categoryId: 'other', amount: money('2000') }],
      accountId: null, purchaseAt: '2026-09-06T12:00:00.000Z', requiredBy: '2026-09-06T12:00:00.000Z',
      barcode: '0123456789012',
      priceProvenance: {
        kind: 'outside_price', source: 'shelf tag', store: 'fixture shop',
        observedAt: '2026-09-05T10:00:00.000Z', estimate: true,
      },
    },
  ],
  adjustments: [{ kind: 'tax', categoryId: 'food', amount: money('500') }],
  warningThresholds: [{ id: 'cart-limit', basis: 'cart_total', maximum: money('5000') }],
  card, canEdit: true, linkedTransfers: [],
});
function sessionWithReallocation(): PublicSpendSession {
  const saved = session();
  const assignment = actionFixture.intent.assignments[0]!;
  saved.items = [{
    id: 'required', categoryId: 'food', amount: assignment.amount, quantity: 1, priority: 'required',
    accountId: null, purchaseAt: actionFixture.evaluatedAt, requiredBy: actionFixture.evaluatedAt,
    priceProvenance: { kind: 'current_session_manual', observedAt: actionFixture.evaluatedAt, estimate: false },
  }];
  saved.adjustments = [];
  saved.warningThresholds = [];
  saved.card = {
    ...card,
    outcome: 'safe_with_reallocation',
    cart: {
      subtotal: assignment.amount, tax: money('0'), fee: money('0'), discount: money('0'), total: assignment.amount,
      categoryCharges: [{ categoryId: 'food', amount: assignment.amount }],
      accountCharges: [{ accountId: 'checking', amount: assignment.amount }],
    },
    fundingPaths: [{
      kind: 'category_reallocation',
      ...assignment,
      approvalRequired: true,
      tradeoffs: [],
      before: { sourceAvailability: money('6000'), destinationAvailability: money('0') },
      after: { sourceAvailability: money('4000'), destinationAvailability: money('2000') },
    }],
  };
  return saved;
}

const global = {
  components: {
    DecisionCardView: {
      props: ['card'],
      emits: ['propose'],
      data: () => ({ action: structuredClone(actionFixture.intent) }),
      template: '<section data-testid="session-card-present">Card reviewed<button v-if="card.fundingPaths.length" type="button" data-testid="session-propose" @click="$emit(\'propose\', action)">Propose</button></section>',
    },
    SemanticAmount,
    LiquidityResult: { template: '<section data-testid="legacy-liquidity">Legacy result</section>' },
  },
  stubs: {
    UCard: { template: '<section><slot name="header" /><slot /></section>' },
    UButton: { props: ['disabled'], template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>' },
    NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
    TransferPlanReview: true,
  },
};

beforeEach(() => {
  fetchMock.mockReset();
  navigateTo.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T10:01:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('editable Spend Session cart', () => {
  it('shows full source-backed cart controls and invalidates the prior Card on a quantity edit', async () => {
    const wrapper = mount(SpendSessionEditor, { props: { session: session(), catalog }, global });
    expect(wrapper.get('[data-testid="session-quantity-optional"]').element).toHaveProperty('value', '2');
    expect(wrapper.get('[data-testid="session-priority-optional"]').element).toHaveProperty('value', 'optional');
    expect(wrapper.get('[data-testid="session-allocation-optional-1-category"]').element).toHaveProperty('value', 'other');
    expect(wrapper.get('[data-testid="session-price-source-optional"]').element).toHaveProperty('value', 'shelf tag');
    expect(wrapper.get('[data-testid="session-price-store-optional"]').element).toHaveProperty('value', 'fixture shop');
    expect(wrapper.get('[data-testid="session-adjustment-0-amount"]').element).toHaveProperty('value', '500');
    expect(wrapper.get('[data-testid="session-threshold-0-maximum"]').element).toHaveProperty('value', '5000');
    expect(wrapper.get('[data-testid="session-running-total"]').text()).toContain('55.00 USD');
    expect(wrapper.get('[data-testid="session-card-present"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="session-propose"]').exists()).toBe(false);

    await wrapper.get('[data-testid="session-quantity-optional"]').setValue('3');
    expect(wrapper.find('[data-testid="session-propose"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="session-card-present"]').exists()).toBe(false);
    expect(wrapper.emitted('draft-state')?.at(-1)).toEqual([true]);
    expect(wrapper.text()).toContain('Evaluate changes');
    expect(wrapper.find('[data-testid="session-running-total"]').exists()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hides the saved native Propose path as soon as its source cart becomes a draft', async () => {
    const wrapper = mount(SpendSessionEditor, { props: { session: sessionWithReallocation(), catalog }, global });
    expect(wrapper.get('[data-testid="session-propose"]').exists()).toBe(true);

    await wrapper.get('[data-testid="session-quantity-required"]').setValue('2');

    expect(wrapper.find('[data-testid="session-propose"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="session-card-present"]').exists()).toBe(false);
    expect(wrapper.emitted('draft-state')?.at(-1)).toEqual([true]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a reallocation intent bound to the unchanged saved session, without copying its cart', async () => {
    fetchMock.mockResolvedValue({ status: 'ok', result: { proposal: { id: 'proposal-action' } } });
    const wrapper = mount(SpendSessionEditor, { props: { session: sessionWithReallocation(), catalog }, global });

    await wrapper.get('[data-testid="session-propose"]').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/proposal/action');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: {
        action: actionFixture.intent,
        decision: { origin: { sessionId: 'fixture-session', sessionVersion: 3 } },
      },
    });
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(Object.keys(body ?? {}).sort()).toEqual(['action', 'decision']);
    expect(body.decision).not.toHaveProperty('items');
    expect(body).not.toHaveProperty('plan');
    expect(body).not.toHaveProperty('payloadHash');
    expect(navigateTo).toHaveBeenCalledWith('/proposals/proposal-action');
  });

  it('adds a manual item and removes only the chosen optional item without silently saving the cart', async () => {
    const wrapper = mount(SpendSessionEditor, { props: { session: session(), catalog }, global });
    await wrapper.findAll('button').find((button) => button.text() === 'Add item')!.trigger('click');
    const newItem = wrapper.findAll('fieldset').find((fieldset) =>
      fieldset.find('legend').text() === 'Item 3');
    expect(newItem).toBeDefined();
    await newItem!.find('select').setValue('food');
    await newItem!.find('input[inputmode="numeric"]').setValue('900');
    await newItem!.findAll('select').find((select) =>
      select.element.parentElement?.textContent?.includes('Priority'))!.setValue('required');
    await wrapper.get('[aria-label="Remove item 2"]').trigger('click');

    const remaining = wrapper.findAll('fieldset').find((fieldset) =>
      fieldset.find('legend').text() === 'Item 2');
    expect(remaining!.find('input[inputmode="numeric"]').element).toHaveProperty('value', '900');
    expect(remaining!.findAll('select').find((select) =>
      select.element.parentElement?.textContent?.includes('Priority'))!.element)
      .toHaveProperty('value', 'required');
    expect(wrapper.find('[data-testid="session-quantity-optional"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="session-card-present"]').exists()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves corrected split and provenance intent through a saved re-evaluation', async () => {
    const corrected = session();
    corrected.version = 4;
    corrected.items[1]!.categoryAllocations = [
      { categoryId: 'food', amount: money('2500') }, { categoryId: 'other', amount: money('1500') },
    ];
    corrected.items[1]!.priceProvenance = {
      kind: 'outside_price', source: 'receipt', store: 'fixture shop',
      observedAt: '2026-09-06T10:01:00.000Z', estimate: false,
    };
    corrected.card = { ...card, cart: {
      ...card.cart!, categoryCharges: [
        { categoryId: 'food', amount: money('4000') }, { categoryId: 'other', amount: money('1500') },
      ],
    } };
    fetchMock.mockResolvedValue({ status: 'ok', result: corrected });
    const wrapper = mount(SpendSessionEditor, { props: { session: session(), catalog }, global });
    await wrapper.get('[data-testid="session-allocation-optional-0-amount"]').setValue('2500');
    await wrapper.get('[data-testid="session-allocation-optional-1-amount"]').setValue('1500');
    await wrapper.get('[data-testid="session-price-source-optional"]').setValue('receipt');
    await wrapper.get('[data-testid="session-price-estimate-optional"]').setValue(false);
    expect(wrapper.emitted('draft-state')?.at(-1)).toEqual([true]);
    await wrapper.findAll('button').find((button) => button.text() === 'Evaluate changes')!.trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="session-allocation-optional-0-amount"]').element).toHaveProperty('value', '2500');
    expect(wrapper.get('[data-testid="session-price-source-optional"]').element).toHaveProperty('value', 'receipt');
    expect(wrapper.get('[data-testid="session-card-present"]').exists()).toBe(true);
    expect(wrapper.emitted('saved')?.at(-1)?.[0]).toMatchObject({ id: 'fixture-session', version: 4 });
    expect(wrapper.emitted('draft-state')?.at(-1)).toEqual([false]);
    expect(wrapper.get('[data-testid="session-running-total"]').text()).toContain('55.00 USD');
  });
  it('omits an unknown store when saving an outside price provenance', async () => {
    const unknownStore = session();
    delete unknownStore.items[1]!.priceProvenance!.store;
    fetchMock.mockResolvedValue({ status: 'ok', result: unknownStore });
    const wrapper = mount(SpendSessionEditor, { props: { session: unknownStore, catalog }, global });

    expect(wrapper.get('[data-testid="session-price-store-optional"]').element).toHaveProperty(
      'value',
      '',
    );
    expect(
      wrapper.get('[data-testid="session-price-store-optional"]').attributes('required'),
    ).toBeUndefined();
    await wrapper.get('[data-testid="session-price-store-optional"]').setValue('   ');
    await wrapper.findAll('button').find((button) => button.text() === 'Evaluate changes')!.trigger('click');
    await flushPromises();

    const request = fetchMock.mock.calls[0]?.[1] as {
      body: { items: Array<{ priceProvenance: Record<string, unknown> }> };
    };
    expect(request.body.items[1]?.priceProvenance).toEqual({
      kind: 'outside_price',
      source: 'shelf tag',
      observedAt: '2026-09-05T10:00:00.000Z',
      estimate: true,
    });
  });
});
