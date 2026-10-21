import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import EvidenceSettlementReview from '../../app/components/EvidenceSettlementReview.vue';
import fixture from '../../../../protocol/fixtures/transaction-evidence-result.json';
import type { TransactionEvidenceResult } from '@balanceframe/protocol-generated';
const request = vi.fn();
const wrappers: VueWrapper[] = [];
const transaction = {
  id: 'settlement',
  date: '2026-10-16',
  amount: { minorUnits: '-1200', currency: 'USD' },
  payeeName: 'Fixture Store',
  categoryId: null,
  categoryName: null,
  splits: [],
};
const result = {
  ...fixture,
  relationships: [
    {
      id: 'actual-match',
      fromId: 'wallet-1',
      toId: 'actual:settlement',
      kind: 'settlement',
      state: 'candidate',
      allocatedAmount: { minorUnits: '1200', currency: 'USD' },
      partial: false,
      score: 40,
      reasonCodes: ['amount_date_candidate'],
      evidenceIds: ['doc-wallet', 'actual-doc'],
    },
  ],
};
const reply = (value: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result: value, error: null }));
beforeEach(() => {
  vi.stubGlobal('fetch', request);
  request.mockReset().mockResolvedValue(reply({ transactions: [transaction] }));
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});
function panel() {
  const wrapper = mount(EvidenceSettlementReview, {
    props: {
      resolution: result as TransactionEvidenceResult,
      accounts: [
        { id: 'checking', name: 'Fixture Checking' },
        { id: 'other', name: 'Other' },
      ],
      documentIds: ['doc-wallet'],
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}
describe('source-bound settlement selection', () => {
  it('shows permitted names and exact source money, then selects only the native candidate without writing', async () => {
    const wrapper = panel();
    expect(request).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="settlement-account"]').setValue('checking');
    await wrapper.get('[data-testid="load-settlements"]').trigger('click');
    await flushPromises();
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({
      resolutionHash: result.resolutionHash,
      eventId: result.events[0]!.id,
      accountId: 'checking',
    });
    expect(wrapper.text()).toContain('Fixture Store');
    expect(wrapper.text()).toContain('12.00 USD');
    await wrapper.get('[data-testid="select-settlement"]').trigger('click');
    expect(wrapper.emitted('match')?.[0]).toEqual([
      {
        eventId: result.events[0]!.id,
        relationshipId: 'actual-match',
        accountId: 'checking',
        transaction,
      },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    await wrapper.get('[data-testid="settlement-account"]').setValue('other');
    expect(wrapper.text()).not.toContain('Fixture Store');
  });
  it('requires a current native relationship and hides malformed or unavailable results', async () => {
    const wrapper = panel();
    await wrapper.setProps({ resolution: { ...fixture, relationships: [] } });
    await wrapper.get('[data-testid="settlement-account"]').setValue('checking');
    await wrapper.get('[data-testid="load-settlements"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="select-settlement"]').exists()).toBe(false);
    request.mockResolvedValue(
      reply({
        transactions: [{ ...transaction, amount: { minorUnits: 'not-money', currency: 'USD' } }],
      }),
    );
    await wrapper.get('[data-testid="load-settlements"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Settlement candidates unavailable');
    expect(wrapper.text()).not.toContain('Fixture Store');
  });
  it('ignores pending responses after the evidence resolution changes', async () => {
    let complete: ((value: Response) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const wrapper = panel();
    await wrapper.get('[data-testid="settlement-account"]').setValue('checking');
    await wrapper.get('[data-testid="load-settlements"]').trigger('click');
    await wrapper.setProps({ resolution: { ...fixture, resolutionHash: 'c'.repeat(64) } });
    complete?.(reply({ transactions: [transaction] }));
    await flushPromises();
    expect(wrapper.text()).not.toContain('Fixture Store');
  });
});
