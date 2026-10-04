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
const reauthFetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
vi.stubGlobal('fetch', reauthFetchMock);
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const exactTransferPlan = () => ({
  minimumAmount: money('2000'),
  requiredBy: '2099-09-07T12:00:00Z',
  estimatedArrival: '2099-09-07T10:00:00Z',
  expiresAt: '2099-09-06T18:00:00Z',
  snapshotId: 'snapshot-1',
  policyVersion: 'financial-policy-1',
  legs: [{
    sourceAccountId: 'reserve',
    sourceAccountName: 'Private reserve',
    destinationAccountId: 'checking',
    destinationAccountName: 'Daily checking',
    amount: money('2000'),
    sourceCapacityBefore: money('4000'),
    sourceCapacityAfter: money('2000'),
    destinationCapacityBefore: money('500'),
    destinationCapacityAfter: money('2500'),
  }],
  reasons: [],
  assumptions: [],
});
const reauthSuccess = () => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => ({ status: 'success' }),
});
beforeEach(() => {
  fetchMock.mockReset();
  reauthFetchMock.mockReset();
  reauthFetchMock.mockImplementation(reauthSuccess);
});
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


  it('reports initiation with fresh human confirmation using the displayed plan hash and version', async () => {
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
      plan: exactTransferPlan(),
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
    expect(wrapper.text()).toContain('authorized-hash');
    expect(wrapper.text()).toContain('snapshot-1');
    expect(wrapper.text()).toContain('financial-policy-1');
    expect(wrapper.text()).toContain('2099-09-06T18:00:00Z');
    await wrapper.get('input[type="password"]').setValue('current-password');
    await wrapper.get('[data-testid="report-initiated"]').trigger('click');
    await flushPromises();
    expect(reauthFetchMock).toHaveBeenCalledWith(
      '/api/reauth',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ password: 'current-password' }),
      }),
    );
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
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toHaveProperty('actorId');
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toHaveProperty('reauthenticatedAt');
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toHaveProperty('password');
    expect(wrapper.get('input[type="password"]').element).toHaveProperty('value', '');
    expect(wrapper.text()).toContain('not settlement');
    expect(wrapper.get('[data-testid="transfer-phase"]').text()).not.toContain('Confirmed');
    expect(wrapper.get('[data-testid="source-observed"]').text()).toContain('Not observed');
  });

  it('does not approve after failed password confirmation', async () => {
    const detail: PublicTransferDetail = {
      id: 'transfer-1', version: 4, payloadHash: 'authorized-hash', phase: 'proposed',
      sourceObserved: false, destinationObserved: false, reconciled: false, outcome: null,
      requiredApprovals: 2, approvalCount: 0, plan: exactTransferPlan(), conclusion: null,
      canApprove: true, canGetInstructions: false, canReportInitiated: false,
      canReconcile: false, canCancel: true, instructionsAvailable: false, reasons: [],
    };
    const pendingProof = Promise.withResolvers<unknown>();
    reauthFetchMock.mockReturnValueOnce(pendingProof.promise);
    const wrapper = mount(TransferWorkflow, { props: { detail }, global });
    await wrapper.get('input[type="password"]').setValue('wrong-password');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.get('input[type="password"]').element).toHaveProperty('value', '');
    pendingProof.resolve({
      ok: false,
      status: 401,
      json: async () => ({
        status: 'error',
        error: { code: 'REAUTHENTICATION_FAILED', message: 'Password confirmation failed.' },
      }),
    });
    await flushPromises();
    expect(wrapper.text()).toContain('REAUTHENTICATION_FAILED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the displayed transfer snapshot on a stale hash until the user explicitly refreshes', async () => {
    const capturedMetadata = {
      requesterActorId: 'original-requester',
      requesterMembershipId: 'original-membership',
      governancePolicyVersion: 'captured-governance-policy',
      financialPolicyVersion: 'captured-financial-policy',
      approvers: [{
        actorId: 'old-eligible-human',
        issuedAt: '2099-09-06T09:00:00Z',
        expiresAt: '2099-09-06T11:00:00Z',
      }],
    };
    const detail: PublicTransferDetail = {
      id: 'transfer-1', version: 4, payloadHash: 'authorized-hash',
      expiresAt: '2099-09-06T17:00:00Z', approvalMetadata: capturedMetadata, phase: 'proposed',
      sourceObserved: false, destinationObserved: false, reconciled: false, outcome: null,
      requiredApprovals: 2, approvalCount: 0, plan: exactTransferPlan(), conclusion: null,
      canApprove: true, canGetInstructions: false, canReportInitiated: false,
      canReconcile: false, canCancel: true, instructionsAvailable: false, reasons: [],
    };
    const fresh = {
      ...detail,
      version: 5,
      payloadHash: 'fresh-hash',
      approvalMetadata: {
        ...capturedMetadata,
        approvers: [{
          actorId: 'new-eligible-human',
          issuedAt: '2099-09-06T10:00:00Z',
          expiresAt: '2099-09-06T12:00:00Z',
        }],
      },
      plan: {
        ...exactTransferPlan(), snapshotId: 'snapshot-2', policyVersion: 'financial-policy-2',
      },
    };
    fetchMock.mockRejectedValueOnce({
      statusCode: 409,
      data: { error: { message: 'Displayed payload hash is stale.' } },
    });
    const wrapper = mount(TransferWorkflow, { props: { detail }, global });
    await wrapper.get('input[type="password"]').setValue('current-password');
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(reauthFetchMock).toHaveBeenCalledWith(
      '/api/reauth',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ password: 'current-password' }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).toMatchObject({
      payloadHash: 'authorized-hash',
      expectedVersion: 4,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toHaveProperty('actorId');
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toHaveProperty('reauthenticatedAt');

    expect(wrapper.get('[data-testid="approval-requester-actor"]').text()).toContain('original-requester');
    expect(wrapper.get('[data-testid="approval-requester-membership"]').text()).toContain('original-membership');
    expect(wrapper.get('[data-testid="approval-governance-policy"]').text()).toContain('captured-governance-policy');
    expect(wrapper.get('[data-testid="approval-financial-policy"]').text()).toContain('captured-financial-policy');
    expect(wrapper.findAll('[data-testid="approval-current-approver"]').map((item) => item.text()).join(' '))
      .toContain('old-eligible-human');
    expect(wrapper.findAll('[data-testid="approval-current-approver"]').map((item) => item.text()).join(' '))
      .toContain('2099-09-06T09:00:00Z');
    expect(wrapper.findAll('[data-testid="approval-current-approver"]').map((item) => item.text()).join(' '))
      .toContain('2099-09-06T11:00:00Z');
    expect(wrapper.text()).not.toContain('new-eligible-human');

    expect(wrapper.get('[data-testid="proposal-expires-at"]').text()).toContain('2099-09-06T17:00:00Z');

    expect(wrapper.text()).toContain('authorized-hash');
    expect(wrapper.text()).toContain('Required by');
    expect(wrapper.text()).not.toContain('fresh-hash');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/transfer/transfer-1/approve');

    fetchMock.mockResolvedValueOnce(ok(fresh));
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('fresh-hash');
    expect(wrapper.get('[data-testid="approval-requester-actor"]').text()).toContain('original-requester');
    expect(wrapper.get('[data-testid="approval-requester-membership"]').text()).toContain('original-membership');
    expect(wrapper.get('[data-testid="approval-governance-policy"]').text()).toContain('captured-governance-policy');
    expect(wrapper.get('[data-testid="approval-financial-policy"]').text()).toContain('captured-financial-policy');
    const refreshedApprovers = wrapper
      .findAll('[data-testid="approval-current-approver"]')
      .map((item) => item.text())
      .join(' ');
    expect(refreshedApprovers).toContain('new-eligible-human');
    expect(refreshedApprovers).not.toContain('old-eligible-human');
    expect(refreshedApprovers).toContain('2099-09-06T10:00:00Z');
    expect(refreshedApprovers).toContain('2099-09-06T12:00:00Z');
    expect(wrapper.text()).not.toContain('authorized-hash');
  });
  it('keeps an authorized-holder transfer conclusion private and actionless', () => {
    const detail: PublicTransferDetail = {
      id: 'transfer-holder',
      version: 1,
      phase: 'proposed',
      sourceObserved: false,
      destinationObserved: false,
      reconciled: false,
      outcome: null,
      requiredApprovals: 1,
      approvalCount: 0,
      approvalMetadata: {
        requesterActorId: 'hidden-requester',
        requesterMembershipId: 'hidden-membership',
        governancePolicyVersion: 'hidden-governance-policy',
        financialPolicyVersion: 'hidden-financial-policy',
        approvers: [{
          actorId: 'hidden-current-approver',
          issuedAt: '2099-09-06T09:00:00Z',
          expiresAt: '2099-09-06T11:00:00Z',
        }],
      },
      plan: null,
      conclusion: {
        minimumAmount: money('2000'),
        requiredBy: '2099-09-07T12:00:00Z',
        authorizedHolderRequired: true,
      },
      canApprove: true,
      canGetInstructions: true,
      canReportInitiated: true,
      canReconcile: true,
      canCancel: true,
      instructionsAvailable: true,
      reasons: [],
    };
    const wrapper = mount(TransferWorkflow, { props: { detail }, global });
    expect(wrapper.text()).toContain('authorized holder');
    expect(wrapper.text()).not.toMatch(/payload hash|Immutable transfer plan|Private reserve/);
    expect(wrapper.find('[data-testid="report-initiated"]').exists()).toBe(false);
    expect(wrapper.findAll('input[type="password"]')).toHaveLength(0);
    expect(wrapper.text()).not.toMatch(
      /hidden-requester|hidden-membership|hidden-governance-policy|hidden-financial-policy|hidden-current-approver/,
    );
  });
});
