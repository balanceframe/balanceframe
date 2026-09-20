import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import type {
  PublicLiquidityConfiguration,
  PublicLiquidityGrants,
} from '@balanceframe/application';
import LiquidityObservationEditor from '../../app/components/LiquidityObservationEditor.vue';
import LiquidityPolicyEditor from '../../app/components/LiquidityPolicyEditor.vue';
import LiquidityGrantEditor from '../../app/components/LiquidityGrantEditor.vue';

const fetchMock = vi.fn();
const ok = (result: unknown) => ({ status: 'ok', result });
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const global = {
  stubs: {
    UCard: { template: '<section><slot name="header" /><slot /></section>' },
    UButton: {
      props: ['disabled'],
      emits: ['click'],
      template:
        '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
    },
  },
};
type Surface = VueWrapper | DOMWrapper<Element>;
function field(surface: Surface, label: string) {
  const match = surface.findAll('label').find((item) => item.text().startsWith(label));
  if (!match) throw new Error(`Missing labeled field: ${label}`);
  return match.get('input, select');
}
function button(surface: Surface, label: string) {
  const match = surface.findAll('button').find((item) => item.text() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
const wrappers: VueWrapper[] = [];
function remember<T extends VueWrapper>(wrapper: T): T {
  wrappers.push(wrapper);
  return wrapper;
}
function configuration(): PublicLiquidityConfiguration {
  return {
    policy: null,
    approvalPolicy: null,
    observationVersion: 4,
    observations: [],
    observationsExpiresAt: null,
    canConfigure: true,
    accounts: [
      { id: 'checking', name: 'Daily checking', currency: 'USD', reasons: [] },
      { id: 'card', name: 'Household card', currency: 'USD', reasons: [] },
    ],
    categories: [{ id: 'payment', name: 'Card payment', feasible: null, backing: [], reasons: [] }],
  };
}
function configured(): PublicLiquidityConfiguration {
  const value = configuration();
  value.policy = {
    version: 'policy-4',
    policyHash: 'policy-hash',
    expiresAt: '2099-09-07T12:00:00Z',
    accounts: [
      {
        accountId: 'checking',
        role: 'bill_payment',
        protectedBuffer: money('9007199254740993'),
        paymentEligible: true,
        sourceEligible: false,
        backingEligible: true,
        eligibleCategoryIds: ['payment'],
        restrictedCashBucketIds: ['restricted-1'],
        automationAllowed: false,
        resourceScope: 'private:checking',
      },
    ],
    transferRoutes: [
      {
        id: 'route-1',
        sourceAccountId: 'checking',
        destinationAccountId: 'card',
        providerArrivalAt: '2099-09-06T17:00:00Z',
        calendarMode: 'business_days',
        delayDays: 1,
        utcOffsetMinutes: -300,
        cutoffMinute: 900,
        weekendsAvailable: false,
        holidaysComplete: true,
        holidays: ['2099-09-01'],
        evidence: {
          state: 'known',
          source: 'user_attested',
          observedAt: '2099-09-06T12:00:00Z',
          expiresAt: '2099-09-07T12:00:00Z',
          reasons: [],
        },
      },
    ],
  };
  value.approvalPolicy = {
    minimumApprovers: 2,
    thresholds: [{ minimumMinorUnits: '10000', currency: 'USD', minimumApprovers: 3 }],
  };
  value.observations = [
    {
      accountId: 'card',
      kind: 'credit',
      currency: 'USD',
      owned: true,
      holds: money('500'),
      credit: {
        authorizationAvailable: money('10000'),
        reservedCash: money('6000'),
        paymentAccountId: 'checking',
        paymentCategoryId: 'payment',
        dueAt: '2099-09-07T12:00:00Z',
        economicObligationId: 'card-payment',
        pendingIncludedInAuthorization: true,
      },
      obligations: [
        {
          id: 'obligation-1',
          economicObligationId: 'card-payment',
          categoryId: 'payment',
          amount: money('6000'),
          dueAt: '2099-09-07T12:00:00Z',
          paid: false,
          includedInBalance: false,
          matchedTransactionIds: [],
        },
      ],
      unsettledFlows: [
        {
          id: 'pending-1',
          economicObligationId: 'grocery-1',
          direction: 'outflow',
          amount: money('1200'),
          includedInBalance: false,
          matchedTransactionIds: [],
          scheduleId: null,
          transferTransactionId: null,
          importedId: null,
          reconciled: false,
          provenance: 'manual_ledger',
        },
      ],
    },
  ];
  return value;
}
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('$fetch', fetchMock);
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('supplemental observations', () => {
  it('blocks configuration without authority even if a form submit event is dispatched', async () => {
    const value = configuration();
    value.canConfigure = false;
    const wrapper = remember(
      mount(LiquidityObservationEditor, { props: { configuration: value }, global }),
    );
    expect(wrapper.get('form > fieldset').attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('keeps existing card, obligation and pending facts immutable until a successful save', async () => {
    const value = configured();
    const original = structuredClone(value);
    const wrapper = remember(
      mount(LiquidityObservationEditor, { props: { configuration: value }, global }),
    );
    const card = wrapper.findAll('form > fieldset > fieldset')[1]!;
    expect((field(card, 'I checked this account').element as HTMLInputElement).checked).toBe(false);
    await field(card, 'Authorization available').setValue('7500');
    await field(card, 'Holds').setValue('700');
    await field(card, 'Reserved payment cash').setValue('5000');
    await field(card, 'Card due date').setValue('2099-09-08T12:00');
    await field(card, 'Payment account').setValue('checking');
    await field(card, 'Payment category').setValue('payment');
    await field(card, 'Payment obligation reference').setValue('card-payment-revised');
    await field(card, 'Pending purchases').setValue(false);
    await field(card, 'I checked this account').setValue(true);
    const obligations = card.findAll('details')[1]!;
    await field(obligations, 'Amount').setValue('5000');
    await field(obligations, 'Due').setValue('2099-09-08T12:00');
    await field(obligations, 'Already paid').setValue(true);
    await field(obligations, 'Already included').setValue(true);
    const pending = card.findAll('details')[2]!;
    await field(pending, 'Direction').setValue('inflow');
    await field(pending, 'Amount').setValue('2000');
    await field(pending, 'Already included').setValue(true);
    expect(value).toEqual(original);
    fetchMock.mockRejectedValueOnce({ statusCode: 409 });
    await button(wrapper, 'Save user-attested observations').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/changed|refresh/i);
    expect((field(card, 'Authorization available').element as HTMLInputElement).value).toBe('7500');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    fetchMock.mockResolvedValueOnce(ok({ ...configuration(), observationVersion: 5 }));
    await button(wrapper, 'Save user-attested observations').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[role="status"]').text()).toMatch(/saved.*reevaluated/i);
  });

  it('validates newly attested card facts and permits removing supplemental activity without asserting settlement', async () => {
    const wrapper = remember(
      mount(LiquidityObservationEditor, { props: { configuration: configuration() }, global }),
    );
    const card = wrapper.findAll('form > fieldset > fieldset')[1]!;
    await field(card, 'Include supplemental').setValue(true);
    await field(card, 'Account kind').setValue('credit');
    await field(card, 'Observed currency').setValue('USD');
    await field(card, 'Ownership').setValue('false');
    await field(card, 'Holds').setValue('0');
    await field(card, 'Attest card').setValue(true);
    expect(
      (field(card, 'Authorization available').element as HTMLInputElement).checkValidity(),
    ).toBe(false);
    await field(card, 'Authorization available').setValue('12.50');
    expect(
      (field(card, 'Authorization available').element as HTMLInputElement).checkValidity(),
    ).toBe(false);
    await field(card, 'Authorization available').setValue('1250');
    expect(
      (field(card, 'Authorization available').element as HTMLInputElement).checkValidity(),
    ).toBe(true);
    await field(card, 'Reserved payment cash').setValue('1250');
    await field(card, 'Payment account').setValue('checking');
    await field(card, 'Payment category').setValue('payment');
    await field(card, 'Card due date').setValue('2099-09-07T12:00');
    await button(card, 'Add obligation').trigger('click');
    const obligations = card.findAll('details')[1]!;
    await field(obligations, 'Economic obligation').setValue('payment-new');
    await field(obligations, 'Amount').setValue('1250');
    await field(obligations, 'Due').setValue('2099-09-07T12:00');
    await field(obligations, 'Category').setValue('payment');
    await button(card, 'Add pending / uncleared activity').trigger('click');
    const pending = card.findAll('details')[2]!;
    await field(pending, 'Economic obligation').setValue('pending-new');
    await field(pending, 'Amount').setValue('500');
    expect(pending.text()).toContain('not settlement evidence');
    fetchMock.mockResolvedValueOnce(ok({ ...configuration(), observationVersion: 5 }));
    await button(wrapper, 'Save user-attested observations').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toMatch(/saved/i);
    await button(card, 'Remove supplemental obligation').trigger('click');
    await button(card, 'Remove supplemental activity').trigger('click');
    expect(obligations.find('input').exists()).toBe(false);
    expect(pending.find('input').exists()).toBe(false);
    await field(card, 'Account kind').setValue('cash');
    expect(card.text()).not.toContain('Authorization available');
  });

  it('disables edits and duplicate saves while a request is pending, then recovers from denial', async () => {
    const { promise, reject } = Promise.withResolvers<unknown>();
    fetchMock.mockReturnValueOnce(promise);
    const wrapper = remember(
      mount(LiquidityObservationEditor, { props: { configuration: configuration() }, global }),
    );
    await wrapper.get('form').trigger('submit');
    await wrapper.get('form').trigger('submit');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.get('form > fieldset').attributes('disabled')).toBeDefined();
    reject({ status: 403 });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/permissions/i);
    expect(wrapper.get('form > fieldset').attributes('disabled')).toBeUndefined();
  });
});

describe('account policy and transfer timing', () => {
  it('blocks unauthorized policy submission and identifies missing setup without inventing eligibility', async () => {
    const value = configuration();
    value.canConfigure = false;
    const wrapper = remember(
      mount(LiquidityPolicyEditor, { props: { configuration: value }, global }),
    );
    expect(wrapper.get('[role="status"]').text()).toMatch(/setup required/i);
    expect(wrapper.get('form > fieldset').attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isolates unsaved nested policy edits and preserves exact large-money input across a conflict', async () => {
    const value = configured();
    const original = structuredClone(value);
    const wrapper = remember(
      mount(LiquidityPolicyEditor, { props: { configuration: value }, global }),
    );
    const account = wrapper.findAll('form > fieldset > fieldset')[0]!;
    expect((field(account, 'Protected buffer').element as HTMLInputElement).value).toBe(
      '9007199254740993',
    );
    await field(account, 'Protected buffer').setValue('9007199254740995');
    await field(account, 'Account role').setValue('reserve');
    await field(account, 'Payment eligible').setValue(false);
    await field(account, 'Transfer-source').setValue(true);
    await field(account, 'Category-backing').setValue(false);
    await field(account, 'Eligible categories').setValue([]);
    await field(account, 'Restricted cash').setValue('safe-1, safe-2, ');
    const route = wrapper.findAll('form > fieldset > fieldset')[2]!;
    await field(route, 'Holiday dates').setValue('2099-09-02, 2099-09-03');
    await field(route, 'Known arrival').setValue('');
    await field(route, 'UTC offset').setValue('');
    await field(route, 'Cutoff').setValue('');
    expect(value).toEqual(original);
    fetchMock.mockRejectedValueOnce({ status: 409 });
    await button(wrapper, 'Save account policy and timing').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/refresh/i);
    expect((field(account, 'Protected buffer').element as HTMLInputElement).value).toBe(
      '9007199254740995',
    );
    fetchMock.mockResolvedValueOnce(ok(configured()));
    await button(wrapper, 'Save account policy and timing').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[role="status"]').text()).toMatch(/saved.*reevaluate/i);
  });

  it('validates and removes explicit timing and approval rules before saving', async () => {
    const wrapper = remember(
      mount(LiquidityPolicyEditor, { props: { configuration: configuration() }, global }),
    );
    await button(wrapper, 'Add transfer timing route').trigger('click');
    const route = wrapper.findAll('form > fieldset > fieldset')[2]!;
    await field(route, 'Source account').setValue('checking');
    await field(route, 'Destination account').setValue('card');
    await field(route, 'Known arrival').setValue('2099-09-07T12:00');
    await field(route, 'Calendar mode').setValue('business_days');
    await field(route, 'Delay').setValue(2);
    await field(route, 'UTC offset').setValue(-300);
    await field(route, 'Cutoff').setValue(1440);
    expect((field(route, 'Cutoff').element as HTMLInputElement).checkValidity()).toBe(false);
    await field(route, 'Cutoff').setValue(1439);
    expect((field(route, 'Cutoff').element as HTMLInputElement).checkValidity()).toBe(true);
    await field(route, 'Weekends available').setValue('true');
    await field(route, 'Holiday dates').setValue('2099-09-01');
    await field(route, 'Holiday calendar').setValue(true);
    await button(wrapper, 'Add approval threshold').trigger('click');
    await field(wrapper, 'Minimum amount').setValue('5000');
    await field(wrapper, 'Required approvers').setValue(0);
    expect((field(wrapper, 'Required approvers').element as HTMLInputElement).checkValidity()).toBe(
      false,
    );
    await field(wrapper, 'Required approvers').setValue(2);
    expect((field(wrapper, 'Required approvers').element as HTMLInputElement).checkValidity()).toBe(
      true,
    );
    await button(wrapper, 'Remove threshold').trigger('click');
    expect(wrapper.text()).not.toContain('Required approvers');
    await button(wrapper, 'Remove route 1').trigger('click');
    expect(wrapper.text()).not.toContain('Known arrival');
    fetchMock.mockResolvedValueOnce(ok(configured()));
    await button(wrapper, 'Save account policy and timing').trigger('click');
    await flushPromises();
    expect(
      wrapper.findAll('[role="status"]').some((status) => /policy saved/i.test(status.text())),
    ).toBe(true);
  });

  it('prevents concurrent policy writes and re-enables editing after a rejected save', async () => {
    const { promise, reject } = Promise.withResolvers<unknown>();
    fetchMock.mockReturnValueOnce(promise);
    const wrapper = remember(
      mount(LiquidityPolicyEditor, { props: { configuration: configured() }, global }),
    );
    await wrapper.get('form').trigger('submit');
    await wrapper.get('form').trigger('submit');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.get('form > fieldset').attributes('disabled')).toBeDefined();
    reject(new Error('Policy store unavailable'));
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Policy store unavailable');
    expect(wrapper.get('form > fieldset').attributes('disabled')).toBeUndefined();
  });
});

const catalog = (): PublicLiquidityGrants => ({
  members: [{ actorId: 'holder' }, { actorId: 'observer' }],
  resources: [{ resourceKind: 'account', resourceId: 'checking', name: 'Private checking' }],
  capabilities: ['conclusion', 'balance'],
  grants: [
    {
      actorId: 'holder',
      resourceKind: 'account',
      resourceId: 'checking',
      capability: 'balance',
      granted: true,
    },
  ],
});
describe('scoped resource access', () => {
  it('distinguishes conclusion-only access, isolates member selection and clears dirty state only after save', async () => {
    fetchMock.mockResolvedValueOnce(ok(catalog()));
    const wrapper = remember(mount(LiquidityGrantEditor, { global }));
    await flushPromises();
    expect(button(wrapper, 'Save scoped resource grants').attributes('disabled')).toBeDefined();
    await field(wrapper, 'Current member').setValue('holder');
    await field(wrapper, 'Resource').setValue('account:checking');
    expect((field(wrapper, 'balance').element as HTMLInputElement).checked).toBe(true);
    await field(wrapper, 'balance').setValue(false);
    await field(wrapper, 'Current member').setValue('observer');
    expect((field(wrapper, 'balance').element as HTMLInputElement).checked).toBe(false);
    await field(wrapper, 'Conclusion only').setValue(true);
    expect((field(wrapper, 'balance').element as HTMLInputElement).checked).toBe(false);
    const saved = catalog();
    saved.grants = [
      {
        actorId: 'observer',
        resourceKind: 'account',
        resourceId: 'checking',
        capability: 'conclusion',
        granted: true,
      },
    ];
    fetchMock.mockResolvedValueOnce(ok(saved));
    await button(wrapper, 'Save scoped resource grants').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toMatch(/access updated/i);
    expect(button(wrapper, 'Save scoped resource grants').attributes('disabled')).toBeDefined();
    expect((field(wrapper, 'Conclusion only').element as HTMLInputElement).checked).toBe(true);
    await field(wrapper, 'Conclusion only').setValue(false);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });

  it('does not offer private grant editing on denial and supports retry with an empty membership catalog', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 403 });
    const wrapper = remember(mount(LiquidityGrantEditor, { global }));
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/permissions/i);
    expect(wrapper.find('form').exists()).toBe(false);
    fetchMock.mockResolvedValueOnce(ok({ ...catalog(), members: [] }));
    await button(wrapper, 'Reload access catalog').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).toMatch(/no current members/i);
    expect(button(wrapper, 'Save scoped resource grants').attributes('disabled')).toBeDefined();
  });

  it('preserves unsaved access choices after save failure and disables the form while saving', async () => {
    fetchMock.mockResolvedValueOnce(ok(catalog()));
    const wrapper = remember(mount(LiquidityGrantEditor, { global }));
    await flushPromises();
    await field(wrapper, 'Current member').setValue('holder');
    await field(wrapper, 'Resource').setValue('account:checking');
    await field(wrapper, 'balance').setValue(false);
    const { promise, reject } = Promise.withResolvers<unknown>();
    fetchMock.mockReturnValueOnce(promise);
    await button(wrapper, 'Save scoped resource grants').trigger('click');
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();
    reject({ statusCode: 409 });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/changed/i);
    expect((field(wrapper, 'balance').element as HTMLInputElement).checked).toBe(false);
    expect(button(wrapper, 'Save scoped resource grants').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
  });
});
