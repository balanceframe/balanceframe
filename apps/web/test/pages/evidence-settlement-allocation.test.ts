import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EvidenceSettlementAllocation from '../../app/components/EvidenceSettlementAllocation.vue';
import source from '../../../../protocol/fixtures/evidence-settlement-plan.json';
import result from '../../../../protocol/fixtures/transaction-evidence-result.json';
import canonicalPlan from '../../../../protocol/fixtures/evidence-settlement-plan-result.json';
import type { ReceiptEvidence, TransactionEvidenceResult } from '@balanceframe/protocol-generated';
const request = vi.fn();
const reauthenticate = vi.hoisted(() => vi.fn());
vi.mock('../../app/utils/reauthentication', () => ({ reauthenticateHuman: reauthenticate }));
const wrappers: VueWrapper[] = [];
const target = {
  id: 'actual-bank-1',
  date: '2026-10-16',
  amount: { minorUnits: '-1200', currency: 'USD' },
  payeeName: 'Retailer',
  categoryId: null,
  categoryName: null,
  splits: [],
};
const current = {
  ...result,
  resolutionHash: 'a'.repeat(64),
  events: source.evidence.receipts.map((receipt, index) => ({
    ...result.events[0],
    id: `event-${index}`,
    observationIds: [receipt.observationId],
  })),
  receipts: source.evidence.receipts.map((receipt) => ({
    receiptId: receipt.id,
    valid: true,
    reasonCodes: [],
    allocatedDiscount: [],
    allocatedTax: [],
  })),
} as TransactionEvidenceResult;
const plan = { ...canonicalPlan, targetObservationId: 'actual:actual-bank-1' };
const reply = (value: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result: value, error: null }));
beforeEach(() => {
  request.mockReset();
  reauthenticate.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', request);
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});
function panel() {
  const wrapper = mount(EvidenceSettlementAllocation, {
    props: {
      resolution: current,
      receipts: source.evidence.receipts as ReceiptEvidence[],
      accounts: [{ id: 'checking', name: 'Checking' }],
      categories: [
        { id: 'food', name: 'Groceries' },
        { id: 'household', name: 'Household' },
      ],
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}
async function select(wrapper: VueWrapper) {
  for (const checkbox of wrapper.findAll('[data-testid="allocation-receipt"]'))
    await checkbox.setValue(true);
  await wrapper.get('[data-testid="allocation-account"]').setValue('checking');
  request.mockResolvedValueOnce(reply({ transactions: [target] }));
  await wrapper.get('[data-testid="allocation-find-targets"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-testid="allocation-target"]').setValue(target.id);
  const fields = wrapper.findAll('[data-testid="allocation-line-category"]');
  await fields[0]!.setValue('food');
  await fields[1]!.setValue('household');
}
describe('many receipts one existing settlement review', () => {
  it('previews only IDs and categories, displays native4+8 split and saves exact proof after explicit human confirmation', async () => {
    const wrapper = panel();
    await select(wrapper);
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({
      resolutionHash: current.resolutionHash,
      eventId: 'event-0',
      accountId: 'checking',
      matchMode: 'partial',
    });
    request.mockResolvedValueOnce(reply(plan));
    await wrapper.get('[data-testid="allocation-preview"]').trigger('click');
    await flushPromises();
    const selector = {
      resolutionHash: current.resolutionHash,
      targetTransactionId: target.id,
      receiptIds: source.receiptIds,
      lineCategories: source.lineCategories,
    };
    expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual(selector);
    expect(wrapper.text()).toContain('4.00 USD');
    expect(wrapper.text()).toContain('8.00 USD');
    expect(wrapper.text()).toContain('12.00 USD');
    expect(wrapper.get<HTMLButtonElement>('[data-testid="allocation-save"]').element.disabled).toBe(
      true,
    );
    await wrapper.get('[data-testid="allocation-confirm"]').setValue(true);
    await wrapper.get('[data-testid="allocation-password"]').setValue('source-password');
    request.mockResolvedValueOnce(reply(current));
    await wrapper.get('[data-testid="allocation-save"]').trigger('click');
    await flushPromises();
    expect(reauthenticate).toHaveBeenCalledWith('source-password');
    expect(JSON.parse(request.mock.calls[2]![1].body)).toEqual({
      ...selector,
      allocationHash: plan.allocationHash,
    });
    expect(wrapper.emitted('saved')?.[0]).toEqual([current]);
    expect(request.mock.calls.every((call) => !String(call[0]).includes('/proposal'))).toBe(true);
  });
  it('invalidates preview when a category changes and discards late responses after source change', async () => {
    const wrapper = panel();
    await select(wrapper);
    request.mockResolvedValueOnce(reply(plan));
    await wrapper.get('[data-testid="allocation-preview"]').trigger('click');
    await flushPromises();
    await wrapper.findAll('[data-testid="allocation-line-category"]')[0]!.setValue('household');
    expect(wrapper.find('[data-testid="allocation-save"]').exists()).toBe(false);
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await wrapper.get('[data-testid="allocation-preview"]').trigger('click');
    await flushPromises();
    await wrapper.setProps({ resolution: { ...current, resolutionHash: 'd'.repeat(64) } });
    finish(reply(plan));
    await flushPromises();
    expect(wrapper.find('[data-testid="allocation-save"]').exists()).toBe(false);
    expect(wrapper.emitted('saved')).toBeUndefined();
  });
  it('withholds invalid receipts and native failures, and never saves after failed reauthentication', async () => {
    const wrapper = panel();
    await wrapper.setProps({
      resolution: {
        ...current,
        receipts: current.receipts.map((item) => ({ ...item, valid: false })),
      },
    });
    expect(wrapper.findAll('[data-testid="allocation-receipt"]')).toHaveLength(0);
    await wrapper.setProps({ resolution: current });
    await select(wrapper);
    request.mockRejectedValueOnce(new Error('mismatch'));
    await wrapper.get('[data-testid="allocation-preview"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="allocation-save"]').exists()).toBe(false);
    request.mockResolvedValueOnce(reply(plan));
    await wrapper.get('[data-testid="allocation-preview"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="allocation-confirm"]').setValue(true);
    await wrapper.get('[data-testid="allocation-password"]').setValue('password');
    reauthenticate.mockRejectedValueOnce(new Error('expired'));
    const calls = request.mock.calls.length;
    await wrapper.get('[data-testid="allocation-save"]').trigger('click');
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(calls);
  });
});
