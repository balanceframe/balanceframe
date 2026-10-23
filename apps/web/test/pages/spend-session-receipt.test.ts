import { spendSessionReceiptContextSchema } from '../../app/utils/spend-session-receipt-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import SpendSessionReceiptComparison from '../../app/components/SpendSessionReceiptComparison.vue';
import fixture from '../../../../protocol/fixtures/spend-session-receipt.json';
import comparison from '../../../../protocol/fixtures/spend-session-receipt-result.json';
const request = vi.fn();
const wrappers: VueWrapper[] = [];
const context = {
  snapshot: fixture.sessionSnapshot,
  receipts: [
    {
      documentId: fixture.receipt.documentId,
      receiptId: fixture.receipt.receiptId,
      counterparty: 'Fixture Store',
      date: '2026-10-15',
      amount: comparison.receiptTotal,
      lines: fixture.evidence.receipts[0]!.lines.map((line) => ({
        id: line.id,
        description: line.rawDescription,
      })),
    },
  ],
  associations: [],
  completionReferences: [
    {
      proposalId: 'old-completion',
      manualTransactionId: 'old-manual',
      importedTransactionId: 'bank-import',
    },
  ],
};
const reply = (result: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result, error: null }));
beforeEach(() => {
  request.mockReset();
  vi.stubGlobal('fetch', request);
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});
function panel() {
  const wrapper = mount(SpendSessionReceiptComparison, {
    props: { documentId: 'doc-session' },
    global: {
      stubs: {
        SemanticAmount: {
          props: ['amount'],
          template: '<span>{{ amount.minorUnits }} {{ amount.currency }}</span>',
        },
      },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}
async function load(wrapper: VueWrapper) {
  await wrapper.get('[data-testid="session-receipt-load"]').trigger('click');
  await flushPromises();
  await wrapper
    .get('[data-testid="session-receipt-choice"]')
    .setValue(JSON.stringify(['doc-receipt', 'receipt-1']));
}
async function mapComplete(wrapper: VueWrapper) {
  await wrapper.get('[data-testid="session-receipt-coverage"]').setValue('complete_purchase');
  const items = wrapper.findAll('[data-testid="session-receipt-item"]');
  await items[0]!.setValue('line:line-1');
  await items[1]!.setValue('__omitted__');
}
describe('saved-session receipt comparison UI', () => {
  it('loads on request and sends explicit mappings, never planned money or a completion intent', async () => {
    request.mockResolvedValueOnce(reply(context)).mockResolvedValueOnce(reply(comparison));
    expect(spendSessionReceiptContextSchema.safeParse(context)).toMatchObject({ success: true });
    const wrapper = panel();
    expect(request).not.toHaveBeenCalled();
    await load(wrapper);
    await mapComplete(wrapper);
    expect(wrapper.text()).toContain('old-completion');
    expect(wrapper.text()).toContain('bank-import');
    await wrapper.get('[data-testid="session-receipt-compare"]').trigger('click');
    await flushPromises();
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/api/evidence/session-context',
      '/api/evidence/session-compare',
    ]);
    expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({
      sessionDocumentId: 'doc-session',
      receipt: fixture.receipt,
      review: fixture.review,
    });
    expect(wrapper.text()).toContain('matched');
    expect(wrapper.text()).toContain('omitted');
    expect(wrapper.text()).toContain('1200 USD');
    expect(wrapper.text()).toContain('does not complete');
  });
  it('shows native currency and estimated-price uncertainty even when an item identity is matched', async () => {
    const uncertain = structuredClone(comparison);
    uncertain.state = 'review_required';
    uncertain.rows[0]!.priceComparison = 'currency_mismatch';
    uncertain.rows[0]!.reasonCodes = ['currency_mismatch', 'estimated_reference_price'];
    uncertain.rows[0]!.observedReference = { minorUnits: '600', currency: 'JPY' };
    request.mockResolvedValueOnce(reply(context)).mockResolvedValueOnce(reply(uncertain));
    const wrapper = panel();
    await load(wrapper);
    await mapComplete(wrapper);
    await wrapper.get('[data-testid="session-receipt-compare"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Currencies differ');
    expect(wrapper.text()).toContain('Estimated reference price');
    expect(wrapper.text()).toContain('600 USD');
    expect(wrapper.text()).toContain('600 JPY');
    expect(wrapper.text()).toContain('Quantity: same');
  });
  it('requires fresh human confirmation and binds saving to the displayed comparison hash', async () => {
    request
      .mockResolvedValueOnce(reply(context))
      .mockResolvedValueOnce(reply(comparison))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success' })))
      .mockResolvedValueOnce(reply({ result: comparison }));
    const wrapper = panel();
    await load(wrapper);
    await mapComplete(wrapper);
    await wrapper.get('[data-testid="session-receipt-compare"]').trigger('click');
    await flushPromises();
    expect(
      wrapper.get('[data-testid="session-receipt-save"]').attributes('disabled'),
    ).toBeDefined();
    await wrapper.get('[data-testid="session-receipt-password"]').setValue('synthetic-only');
    await wrapper.get('[data-testid="session-receipt-save"]').trigger('click');
    await flushPromises();
    expect(request.mock.calls[2]![0]).toBe('/api/reauth');
    expect(request.mock.calls[3]![0]).toBe('/api/evidence/session-association');
    expect(JSON.parse(request.mock.calls[3]![1].body).comparisonHash).toBe(
      comparison.comparisonHash,
    );
    expect(wrapper.text()).toContain('Comparison saved');
    expect(
      (wrapper.get('[data-testid="session-receipt-password"]').element as HTMLInputElement).value,
    ).toBe('');
  });
  it('invalidates previews on edits and refuses a duplicate receipt-line mapping', async () => {
    request.mockResolvedValueOnce(reply(context)).mockResolvedValueOnce(reply(comparison));
    const wrapper = panel();
    await load(wrapper);
    await mapComplete(wrapper);
    await wrapper.get('[data-testid="session-receipt-compare"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="session-receipt-password"]').setValue('synthetic-only');
    await wrapper.findAll('[data-testid="session-receipt-item"]')[1]!.setValue('line:line-1');
    expect(wrapper.find('[data-testid="session-receipt-save"]').exists()).toBe(false);
    expect(
      wrapper.get('[data-testid="session-receipt-compare"]').attributes('disabled'),
    ).toBeDefined();
  });
  it('keeps partial coverage, substitutions and additional items explicit without inventing omitted items', async () => {
    const withExtra = structuredClone(context);
    withExtra.receipts[0]!.lines.push({ id: 'extra-line', description: 'Extra purchase' });
    request
      .mockResolvedValueOnce(reply(withExtra))
      .mockResolvedValueOnce(reply({ ...comparison, state: 'review_required' }));
    const wrapper = panel();
    await load(wrapper);
    await mapComplete(wrapper);
    await wrapper.get('[data-testid="session-receipt-coverage"]').setValue('partial_purchase');
    const substitutions = wrapper.findAll('input[type="checkbox"]');
    await substitutions[0]!.setValue(true);
    await substitutions[1]!.setValue(true);
    await wrapper.get('[data-testid="session-receipt-compare"]').trigger('click');
    await flushPromises();
    expect(JSON.parse(request.mock.calls[1]![1].body).review).toEqual({
      coverage: 'partial_purchase',
      pairs: [{ sessionItemId: 'item-1', receiptLineId: 'line-1', kind: 'substitution' }],
      omittedItemIds: [],
      newLineIds: ['extra-line'],
    });
    expect(wrapper.text()).toContain('review_required');
  });
  it('does not offer approval for blocked comparisons and rejects mismatched returned identities', async () => {
    request
      .mockResolvedValueOnce(reply(context))
      .mockResolvedValueOnce(reply({ ...comparison, state: 'blocked' }))
      .mockResolvedValueOnce(reply({ ...comparison, sessionDocumentId: 'wrong' }));
    const wrapper = panel();
    await load(wrapper);
    await wrapper.get('[data-testid="session-receipt-compare"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('blocked');
    expect(wrapper.find('[data-testid="session-receipt-save"]').exists()).toBe(false);
    await wrapper.get('[data-testid="session-receipt-compare"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('unavailable');
    expect(wrapper.find('[data-testid="session-receipt-save"]').exists()).toBe(false);
  });
  it('clears failed confirmation secrets and does not save after the source changes during reauthentication', async () => {
    request
      .mockResolvedValueOnce(reply(context))
      .mockResolvedValueOnce(reply(comparison))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error' }), { status: 403 }));
    const wrapper = panel();
    await load(wrapper);
    await mapComplete(wrapper);
    await wrapper.get('[data-testid="session-receipt-compare"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="session-receipt-password"]').setValue('synthetic-only');
    await wrapper.get('[data-testid="session-receipt-save"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('save unavailable');
    expect(
      (wrapper.get('[data-testid="session-receipt-password"]').element as HTMLInputElement).value,
    ).toBe('');
    let confirm: ((value: Response) => void) | undefined;
    request.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          confirm = done;
        }),
    );
    await wrapper.get('[data-testid="session-receipt-password"]').setValue('synthetic-only');
    await wrapper.get('[data-testid="session-receipt-save"]').trigger('click');
    await wrapper.setProps({ documentId: 'new-session' });
    confirm?.(new Response(JSON.stringify({ status: 'success' })));
    await flushPromises();
    expect(
      request.mock.calls.filter(([url]) => url === '/api/evidence/session-association'),
    ).toEqual([]);
    expect(wrapper.find('[data-testid="session-receipt-save"]').exists()).toBe(false);
  });
  it('drops late previous-context responses and keeps unavailable receipt processing separate from saved items', async () => {
    let resolve: ((value: Response) => void) | undefined;
    request.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const wrapper = panel();
    await wrapper.get('[data-testid="session-receipt-load"]').trigger('click');
    await wrapper.setProps({ documentId: 'new-session' });
    resolve?.(reply(context));
    await flushPromises();
    expect(wrapper.find('[data-testid="session-receipt-choice"]').exists()).toBe(false);
    request.mockResolvedValueOnce(reply({ invalid: true }));
    await wrapper.get('[data-testid="session-receipt-load"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('unavailable');
    expect(
      wrapper.get('[data-testid="session-receipt-load"]').attributes('disabled'),
    ).toBeUndefined();
  });
});
