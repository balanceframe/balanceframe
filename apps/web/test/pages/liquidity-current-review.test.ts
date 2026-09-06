import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type {
  PublicLiquidityView,
  PublicTransferDetail,
  PublicTransferPreview,
} from '@balanceframe/application';
import CurrentLiquidityPanel from '../../app/components/CurrentLiquidityPanel.vue';
import TransferPlanReview from '../../app/components/TransferPlanReview.vue';
import LiquidityResult from '../../app/components/LiquidityResult.vue';
import SemanticAmount from '../../app/components/SemanticAmount.vue';

const fetchMock = vi.fn();
const navigate = vi.fn();
const ok = (result: unknown) => ({ status: 'ok', result });
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const global = {
  components: { LiquidityResult, SemanticAmount },
  stubs: {
    UCard: { template: '<section><slot name="header" /><slot /></section>' },
    UButton: {
      props: ['disabled'],
      emits: ['click'],
      template:
        '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
    },
    NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
    ReasonCodeList: true,
    FreshnessBanner: true,
    InsufficientDataPanel: true,
    EvidenceDrawer: true,
  },
};
const wrappers: VueWrapper[] = [];
function remember<T extends VueWrapper>(wrapper: T): T {
  wrappers.push(wrapper);
  return wrapper;
}
function button(wrapper: VueWrapper, label: string) {
  const match = wrapper.findAll('button').find((item) => item.text() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
function field(wrapper: VueWrapper, label: string) {
  const match = wrapper.findAll('label').find((item) => item.text().startsWith(label));
  if (!match) throw new Error(`Missing labeled field: ${label}`);
  return match.get('input, select');
}
function view(): PublicLiquidityView {
  return {
    evaluatedAt: '2099-09-06T12:00:00Z',
    horizon: { startsAt: '2099-09-06T12:00:00Z', endsAt: '2099-09-07T12:00:00Z' },
    expiresAt: '2099-09-06T18:00:00Z',
    fundingStatus: 'funded',
    paymentStatus: 'ready',
    reasons: [],
    assumptions: [],
    purchases: [],
    accounts: [
      { id: 'checking', name: 'Daily checking', safeTransfer: money('4000'), reasons: [] },
    ],
    categories: [
      {
        id: 'food',
        name: 'Food',
        availabilityBefore: money('3000'),
        availabilityAfter: money('3000'),
        feasible: true,
        backing: [],
        reasons: [],
      },
      {
        id: 'rent',
        name: 'Rent',
        availabilityBefore: money('10000'),
        availabilityAfter: money('10000'),
        feasible: true,
        backing: [],
        reasons: [],
      },
    ],
    canConfigure: false,
    canManageGrants: false,
    canCreateSession: false,
  };
}
function preview(): PublicTransferPreview {
  return {
    previewId: 'preview-1',
    payloadHash: 'reviewed-payload',
    plan: {
      minimumAmount: money('2000'),
      requiredBy: '2099-09-07T12:00:00Z',
      estimatedArrival: '2099-09-07T10:00:00Z',
      expiresAt: '2099-09-06T18:00:00Z',
      snapshotId: 'snapshot-1',
      policyVersion: 'policy-1',
      legs: [
        {
          sourceAccountId: 'reserve',
          sourceAccountName: 'Private reserve',
          destinationAccountId: 'checking',
          destinationAccountName: 'Daily checking',
          amount: money('2000'),
          sourceCapacityBefore: money('4000'),
          sourceCapacityAfter: money('2000'),
          destinationCapacityBefore: money('500'),
          destinationCapacityAfter: money('2500'),
        },
      ],
      reasons: ['protected_buffer'],
      assumptions: ['Arrival depends on the explicit route calendar.'],
    },
  };
}
function detail(): PublicTransferDetail {
  return {
    id: 'transfer-1',
    version: 1,
    payloadHash: 'reviewed-payload',
    phase: 'proposed',
    sourceObserved: false,
    destinationObserved: false,
    reconciled: false,
    outcome: null,
    requiredApprovals: 2,
    approvalCount: 0,
    plan: null,
    conclusion: null,
    canApprove: true,
    canGetInstructions: false,
    canReportInitiated: false,
    canReconcile: false,
    canCancel: true,
    instructionsAvailable: false,
    reasons: [],
  };
}
beforeEach(() => {
  fetchMock.mockReset();
  navigate.mockReset();
  vi.stubGlobal('$fetch', fetchMock);
  vi.stubGlobal('navigateTo', navigate);
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('current liquidity and cash-neutral previews', () => {
  it('offers configuration and session links only when the current view authorizes them', async () => {
    fetchMock.mockResolvedValueOnce(ok(view()));
    const wrapper = remember(mount(CurrentLiquidityPanel, { global }));
    expect(wrapper.get('[role="status"]').text()).toMatch(/loading/i);
    expect(button(wrapper, 'Refresh current data').attributes('disabled')).toBeDefined();
    await flushPromises();
    expect(wrapper.find('a[href="/purchase-check"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/spend-sessions/new"]').exists()).toBe(false);
    expect(wrapper.find('a[href="/liquidity/settings"]').exists()).toBe(false);
    fetchMock.mockResolvedValueOnce(
      ok({ ...view(), canManageGrants: true, canCreateSession: true }),
    );
    await button(wrapper, 'Refresh current data').trigger('click');
    await flushPromises();
    expect(wrapper.find('a[href="/spend-sessions/new"]').exists()).toBe(true);
    expect(wrapper.find('a[href="/liquidity/settings"]').exists()).toBe(true);
    fetchMock.mockResolvedValueOnce(ok({ ...view(), canConfigure: true }));
    await button(wrapper, 'Refresh current data').trigger('click');
    await flushPromises();
    expect(wrapper.find('a[href="/liquidity/settings"]').exists()).toBe(true);
  });

  it('removes previously displayed capacity when refreshing fails, instead of presenting stale data as current', async () => {
    fetchMock.mockResolvedValueOnce(ok(view()));
    const wrapper = remember(mount(CurrentLiquidityPanel, { global }));
    await flushPromises();
    expect(wrapper.find('#category-food').exists()).toBe(true);
    fetchMock.mockRejectedValueOnce(new Error('Current snapshot unavailable'));
    await button(wrapper, 'Refresh current data').trigger('click');
    expect(wrapper.find('#category-food').exists()).toBe(false);
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Current snapshot unavailable');
    expect(wrapper.find('form').exists()).toBe(false);
    expect(button(wrapper, 'Refresh current data').attributes('disabled')).toBeUndefined();
  });

  it('rejects same-category movement and invalid minor units before previewing, then discards results for edited inputs', async () => {
    fetchMock.mockResolvedValueOnce(ok(view()));
    const wrapper = remember(mount(CurrentLiquidityPanel, { global }));
    await flushPromises();
    await field(wrapper, 'From category').setValue('food');
    await field(wrapper, 'To category').setValue('food');
    await field(wrapper, 'Amount').setValue('250');
    expect(
      button(wrapper, 'Preview category and backing effects').attributes('disabled'),
    ).toBeDefined();
    await field(wrapper, 'To category').setValue('rent');
    await field(wrapper, 'Amount').setValue('2.50');
    expect((field(wrapper, 'Amount').element as HTMLInputElement).checkValidity()).toBe(false);
    await field(wrapper, 'Amount').setValue('250');
    await field(wrapper, 'Currency').setValue('USD');
    const pending = Promise.withResolvers<unknown>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await button(wrapper, 'Preview category and backing effects').trigger('click');
    expect(
      button(wrapper, 'Preview category and backing effects').attributes('disabled'),
    ).toBeDefined();
    await wrapper.get('form').trigger('submit');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await field(wrapper, 'Amount').setValue('500');
    pending.resolve(ok(view()));
    await flushPromises();
    expect(wrapper.text()).not.toContain('Preview only — bank cash unchanged');
    fetchMock.mockResolvedValueOnce(ok(view()));
    await button(wrapper, 'Preview category and backing effects').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Preview only — bank cash unchanged');
    await field(wrapper, 'To category').setValue('food');
    expect(wrapper.text()).not.toContain('Preview only — bank cash unchanged');
  });

  it('keeps the authoritative current view available when a read-only preview is denied and permits retry', async () => {
    fetchMock.mockResolvedValueOnce(ok(view()));
    const wrapper = remember(mount(CurrentLiquidityPanel, { global }));
    await flushPromises();
    await field(wrapper, 'From category').setValue('food');
    await field(wrapper, 'To category').setValue('rent');
    await field(wrapper, 'Amount').setValue('250');
    fetchMock.mockRejectedValueOnce({ status: 403 });
    await button(wrapper, 'Preview category and backing effects').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/permissions/i);
    expect(wrapper.find('#category-food').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Preview only — bank cash unchanged');
    fetchMock.mockResolvedValueOnce(ok(view()));
    await button(wrapper, 'Preview category and backing effects').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Preview only — bank cash unchanged');
  });
});

describe('exact transfer review', () => {
  it('requires reviewing actual capacity effects before proposing and prevents actions while the proposal is pending', async () => {
    const wrapper = remember(mount(TransferPlanReview, { props: { preview: preview() }, global }));
    expect(wrapper.text()).toContain('Private reserve → Daily checking');
    expect(wrapper.text()).toContain('40.00 USD');
    expect(wrapper.text()).toContain('25.00 USD');
    expect(wrapper.text()).toMatch(/no funds moved or reserved/i);
    expect(button(wrapper, 'Propose reviewed transfer').attributes('disabled')).toBeDefined();
    await wrapper.get('input[type="checkbox"]').setValue(true);
    const pending = Promise.withResolvers<unknown>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await button(wrapper, 'Propose reviewed transfer').trigger('click');
    expect(button(wrapper, 'Proposing…').attributes('disabled')).toBeDefined();
    expect(button(wrapper, 'Close preview').attributes('disabled')).toBeDefined();
    expect(navigate).not.toHaveBeenCalled();
    pending.resolve(ok(detail()));
    await flushPromises();
    expect(navigate).toHaveBeenCalledWith('/transfer/transfer-1');
    expect(wrapper.emitted('proposed')).toHaveLength(1);
    expect(wrapper.text()).not.toMatch(/transfer (?:settled|confirmed)/i);
  });

  it('cannot propose an expired preview, including one which expires while a new preview prop arrives', async () => {
    const value = preview();
    const wrapper = remember(mount(TransferPlanReview, { props: { preview: value }, global }));
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await wrapper.setProps({
      preview: { ...value, plan: { ...value.plan, expiresAt: '2000-01-01T00:00:00Z' } },
    });
    expect(button(wrapper, 'Propose reviewed transfer').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toMatch(/preview expired/i);
    await button(wrapper, 'Propose reviewed transfer').trigger('click');
    expect(fetchMock).not.toHaveBeenCalled();
    await button(wrapper, 'Close preview').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('surfaces a stale proposal failure without navigation and preserves retry idempotency for the same review', async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 409 });
    const wrapper = remember(mount(TransferPlanReview, { props: { preview: preview() }, global }));
    await wrapper.get('input[type="checkbox"]').setValue(true);
    await button(wrapper, 'Propose reviewed transfer').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toMatch(/refresh.*review/i);
    expect(navigate).not.toHaveBeenCalled();
    expect(wrapper.emitted('proposed')).toBeUndefined();
    const firstKey = fetchMock.mock.calls[0]![1].body.idempotencyKey;
    fetchMock.mockResolvedValueOnce(ok(detail()));
    await button(wrapper, 'Propose reviewed transfer').trigger('click');
    await flushPromises();
    expect(fetchMock.mock.calls[1]![1].body.idempotencyKey).toBe(firstKey);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/transfer/transfer-1');
  });
});
