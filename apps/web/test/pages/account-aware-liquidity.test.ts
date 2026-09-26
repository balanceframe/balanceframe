import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type {
  PublicLiquidityView,
  PublicPurchaseLiquidity,
  PublicTransferDetail,
} from '@balanceframe/application';
import LiquidityResult from '../../app/components/LiquidityResult.vue';
import TransferWorkflow from '../../app/components/TransferWorkflow.vue';
import SemanticAmount from '../../app/components/SemanticAmount.vue';

const fetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const purchase = (): PublicPurchaseLiquidity => ({
  id: 'item-1',
  categoryId: 'food',
  amount: money('2000'),
  selectedAccountId: 'checking',
  routeOrigin: 'explicit',
  fundingStatus: 'funded',
  paymentStatus: 'transfer_required',
  safeCapacityBefore: money('0'),
  safeCapacityAfter: money('0'),
  alternatives: [{ accountId: 'other', accountName: 'Other checking', status: 'ready' }],
  transfer: {
    minimumAmount: money('3000'),
    requiredBy: '2099-09-06T17:00:00Z',
    estimatedArrival: '2099-09-06T16:00:00Z',
    authorizedHolderRequired: false,
  },
  reasons: ['protected_buffer'],
  canPlanTransfer: true,
});
const view = (): PublicLiquidityView => ({
  evaluatedAt: '2099-09-06T12:00:00Z',
  horizon: { startsAt: '2099-09-06T12:00:00Z', endsAt: '2099-10-06T12:00:00Z' },
  expiresAt: '2099-09-06T18:00:00Z',
  fundingStatus: 'funded',
  paymentStatus: 'transfer_required',
  reasons: [],
  assumptions: [],
  accounts: [
    { id: 'checking', name: 'Daily checking', reasons: [] },
    { id: 'other', name: 'Other checking', reasons: [] },
  ],
  categories: [
    {
      id: 'food',
      name: 'Food',
      availabilityBefore: money('10000'),
      feasible: true,
      backing: [],
      reasons: [],
    },
  ],
  purchases: [purchase()],
  canConfigure: false,
  canManageGrants: false,
  canCreateSession: true,
});
const global = {
  components: { SemanticAmount, LiquidityResult },
  stubs: {
    UCard: { template: '<section><slot name="header" /><slot /></section>' },
    UButton: {
      props: ['disabled'],
      template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
    },
    UInput: {
      props: ['modelValue'],
      template:
        '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
    },
    UFormGroup: { template: '<div><slot /></div>' },
    AnalysisPage: {
      props: ['error'],
      template:
        '<main><div v-if="error" role="alert">{{ error.message }}</div><slot name="content" /></main>',
    },
    NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
    ReasonCodeList: true,
    FreshnessBanner: true,
    InsufficientDataPanel: true,
    EvidenceDrawer: true,
  },
};
const ok = (result: unknown) => ({ status: 'ok', result });
beforeEach(() => fetchMock.mockReset());

describe('account-aware spendability surfaces', () => {
  it('keeps funded category independent from an account requiring an exact transfer and unknown capacity', () => {
    const data = view();
    delete data.purchases[0]!.safeCapacityAfter;
    const wrapper = mount(LiquidityResult, { props: { view: data }, global });
    expect(wrapper.get('[data-testid="funding-item-1"]').text()).toContain('Funded');
    expect(wrapper.get('[data-testid="payment-item-1"]').text()).toContain('Transfer required');
    expect(wrapper.get('[data-testid="capacity-after-item-1"]').text()).toContain('Unknown');
    expect(wrapper.text()).toContain('30.00 USD');
    expect(wrapper.text()).not.toContain('Payment ready');
  });

  it('distinguishes current and future backing from the same account without combining their amounts', async () => {
    const data = view();
    data.categories[0]!.backing = [
      { accountId: 'checking', amount: money('1000'), asOfMonth: '2099-09', periodKind: 'current' },
      { accountId: 'checking', amount: money('2000'), asOfMonth: '2099-10', periodKind: 'future' },
    ];
    const wrapper = mount(LiquidityResult, { props: { view: data, showAccounts: true }, global });
    const lines = () =>
      wrapper
        .get('#category-food')
        .findAll('li')
        .map((line) => line.text());
    expect(lines().find((line) => line.includes('2099-09'))).toContain('10.00 USD');
    expect(lines().find((line) => line.includes('2099-10'))).toContain('20.00 USD');
    const updated = structuredClone(data);
    updated.categories[0]!.backing.reverse();
    updated.categories[0]!.backing[1]!.amount = money('500');
    await wrapper.setProps({ view: updated });
    expect(lines().find((line) => line.includes('2099-09'))).toContain('5.00 USD');
    expect(lines().find((line) => line.includes('2099-10'))).toContain('20.00 USD');
  });


  it('renders a source-redacted conclusion without a planning token or consequential controls', () => {
    const data = view();
    data.accounts = [];
    data.purchases[0]!.alternatives = [];
    data.purchases[0]!.canPlanTransfer = false;
    data.purchases[0]!.transfer = {
      minimumAmount: money('3000'),
      requiredBy: '2099-09-06T17:00:00Z',
      authorizedHolderRequired: true,
    };
    const wrapper = mount(LiquidityResult, { props: { view: data }, global });
    expect(wrapper.text()).toContain('authorized holder');
    expect(wrapper.text()).toContain('30.00 USD');
    expect(wrapper.findAll('button')).toHaveLength(0);
    expect(wrapper.html()).not.toMatch(/previewId|payloadHash|sourceAccount|Other checking/);
  });


  it('reports initiation using exact version/hash without presenting acknowledgement as settlement', async () => {
    const detail: PublicTransferDetail = {
      id: 'transfer-1',
      version: 4,
      payloadHash: 'authorized-hash',
      phase: 'approved',
      sourceObserved: false,
      destinationObserved: false,
      reconciled: false,
      outcome: null,
      requiredApprovals: 1,
      approvalCount: 1,
      plan: null,
      conclusion: null,
      canApprove: false,
      canGetInstructions: false,
      canReportInitiated: true,
      canReconcile: false,
      canCancel: true,
      instructionsAvailable: true,
      reasons: [],
    };
    fetchMock.mockResolvedValue(
      ok({ ...detail, version: 5, phase: 'initiated', canReportInitiated: false }),
    );
    const wrapper = mount(TransferWorkflow, { props: { detail }, global });
    await wrapper.get('[data-testid="report-initiated"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/transfer/transfer-1/report-initiated',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          payloadHash: 'authorized-hash',
          expectedVersion: 4,
          idempotencyKey: expect.any(String),
        }),
      }),
    );
    expect(wrapper.text()).toContain('not settlement');
    expect(wrapper.get('[data-testid="transfer-phase"]').text()).not.toContain('Confirmed');
    expect(wrapper.get('[data-testid="source-observed"]').text()).toContain('Not observed');
  });
});
