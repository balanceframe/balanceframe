import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import EvidenceReceiptReview from '../../app/components/EvidenceReceiptReview.vue';
import source from '../../../../protocol/fixtures/evidence-settlement-plan.json';
import result from '../../../../protocol/fixtures/transaction-evidence-result.json';
const fetcher = vi.fn();
const reauth = vi.hoisted(() => vi.fn());
vi.mock('../../app/utils/reauthentication', () => ({ reauthenticateHuman: reauth }));
const wrappers: VueWrapper[] = [];
const hash = 'a'.repeat(64);
const context = {
  resolutionHash: hash,
  receipts: source.evidence.receipts.map((receipt, i) => ({
    documentId: `doc-${i}`,
    receipt,
    kind: i ? 'refund' : 'purchase',
    valid: true,
  })),
  orders: [
    {
      documentId: 'order-doc',
      observationId: 'order-1',
      date: '2026-10-16',
      amount: source.evidence.receipts[0]!.total,
      counterparty: 'Retailer',
    },
  ],
  members: [{ actorId: 'me', membershipId: 'member-me', label: 'Me' }],
  annotations: [],
};
const reply = (value: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result: value, error: null }));
beforeEach(() => {
  fetcher.mockReset();
  reauth.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  vi.unstubAllGlobals();
});
function panel() {
  const w = mount(EvidenceReceiptReview, { props: { resolutionHash: hash } });
  wrappers.push(w);
  return w;
}
async function load(w: VueWrapper) {
  fetcher.mockResolvedValueOnce(reply(context));
  await w.get('[data-testid="receipt-review-load"]').trigger('click');
  await flushPromises();
}
async function confirm(w: VueWrapper) {
  await w.get('[data-testid="receipt-review-confirm"]').setValue(true);
  await w.get('[data-testid="receipt-review-password"]').setValue('password');
}
describe('explicit receipt relationships', () => {
  it('loads on demand and saves only explicit member selectors after fresh human confirmation', async () => {
    const w = panel();
    expect(fetcher).not.toHaveBeenCalled();
    await load(w);
    expect(w.get<HTMLButtonElement>('[data-testid="receipt-review-save"]').element.disabled).toBe(
      true,
    );
    await w.get('[data-testid="receipt-review-receipt"]').setValue(context.receipts[0]!.receipt.id);
    await w
      .get('[data-testid="receipt-review-line"]')
      .setValue(context.receipts[0]!.receipt.lines[0]!.id);
    await w.get('[data-testid="receipt-review-member"]').setValue('member-me');
    await confirm(w);
    fetcher.mockResolvedValueOnce(reply(result));
    await w.get('[data-testid="receipt-review-save"]').trigger('click');
    await flushPromises();
    expect(reauth).toHaveBeenCalledWith('password');
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
      resolutionHash: hash,
      decisions: [
        {
          kind: 'member',
          receiptId: context.receipts[0]!.receipt.id,
          lineId: context.receipts[0]!.receipt.lines[0]!.id,
          membershipId: 'member-me',
        },
      ],
    });
    expect(w.emitted('saved')).toEqual([[result]]);
  });
  it('explicitly revokes a field and clears confirmation when a selection changes', async () => {
    const w = panel();
    await load(w);
    await w.get('[data-testid="receipt-review-receipt"]').setValue(context.receipts[0]!.receipt.id);
    await w
      .get('[data-testid="receipt-review-line"]')
      .setValue(context.receipts[0]!.receipt.lines[0]!.id);
    await w.get('[data-testid="receipt-review-clear"]').setValue(true);
    await confirm(w);
    await w.get('[data-testid="receipt-review-mode"]').setValue('fulfillment');
    expect(w.get<HTMLInputElement>('[data-testid="receipt-review-password"]').element.value).toBe(
      '',
    );
    await w.get('[data-testid="receipt-review-clear"]').setValue(true);
    await confirm(w);
    fetcher.mockResolvedValueOnce(reply(result));
    await w.get('[data-testid="receipt-review-save"]').trigger('click');
    await flushPromises();
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).decisions).toEqual([
      { kind: 'fulfillment', receiptId: context.receipts[0]!.receipt.id, order: null },
    ]);
  });
  it('uses exact original/order identities and never sends financial effects', async () => {
    const w = panel();
    await load(w);
    await w.get('[data-testid="receipt-review-receipt"]').setValue(context.receipts[1]!.receipt.id);
    await w.get('[data-testid="receipt-review-mode"]').setValue('return');
    await w
      .get('[data-testid="receipt-review-line"]')
      .setValue(context.receipts[1]!.receipt.lines[0]!.id);
    await w
      .get('[data-testid="receipt-review-original"]')
      .setValue(
        JSON.stringify([
          'doc-0',
          context.receipts[0]!.receipt.id,
          context.receipts[0]!.receipt.lines[0]!.id,
        ]),
      );
    await confirm(w);
    fetcher.mockResolvedValueOnce(reply(result));
    await w.get('[data-testid="receipt-review-save"]').trigger('click');
    await flushPromises();
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).decisions[0].original).toEqual({
      documentId: 'doc-0',
      receiptId: context.receipts[0]!.receipt.id,
      lineId: context.receipts[0]!.receipt.lines[0]!.id,
    });
    expect(fetcher.mock.calls.every((c) => !String(c[0]).includes('proposal'))).toBe(true);
  });
  it('discards late context after a resolution change and withholds writes on failed authentication', async () => {
    const w = panel();
    let finish!: (r: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await w.get('[data-testid="receipt-review-load"]').trigger('click');
    await w.setProps({ resolutionHash: 'b'.repeat(64) });
    finish(reply(context));
    await flushPromises();
    expect(w.find('[data-testid="receipt-review-save"]').exists()).toBe(false);
    await w.setProps({ resolutionHash: hash });
    await load(w);
    await w.get('[data-testid="receipt-review-receipt"]').setValue(context.receipts[0]!.receipt.id);
    await w.get('[data-testid="receipt-review-mode"]').setValue('fulfillment');
    await w
      .get('[data-testid="receipt-review-order"]')
      .setValue(JSON.stringify(['order-doc', 'order-1']));
    await confirm(w);
    reauth.mockRejectedValueOnce(new Error('expired'));
    await w.get('[data-testid="receipt-review-save"]').trigger('click');
    await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(w.find('[role="alert"]').exists()).toBe(true);
  });
});

it('keeps invalid current receipt fields available for explicit removal only', async () => {
  const w = panel();
  fetcher.mockResolvedValueOnce(
    reply({ ...context, receipts: context.receipts.map((entry) => ({ ...entry, valid: false })) }),
  );
  await w.get('[data-testid="receipt-review-load"]').trigger('click');
  await flushPromises();
  expect(w.get('[data-testid="receipt-review-receipt"]').findAll('option')).toHaveLength(1);
  await w.get('[data-testid="receipt-review-mode"]').setValue('return');
  await w.get('[data-testid="receipt-review-clear"]').setValue(true);
  await w.get('[data-testid="receipt-review-receipt"]').setValue(context.receipts[1]!.receipt.id);
  await w
    .get('[data-testid="receipt-review-line"]')
    .setValue(context.receipts[1]!.receipt.lines[0]!.id);
  await confirm(w);
  fetcher.mockResolvedValueOnce(reply(result));
  await w.get('[data-testid="receipt-review-save"]').trigger('click');
  await flushPromises();
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).decisions[0].original).toBeNull();
});
