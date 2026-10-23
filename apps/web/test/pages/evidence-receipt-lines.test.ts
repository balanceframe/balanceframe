import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import EvidenceReceiptLines from '../../app/components/EvidenceReceiptLines.vue';
import fixture from '../../../../protocol/fixtures/transaction-evidence-receipt.json';
import type { ReceiptEvidence } from '@balanceframe/protocol-generated';
import { economicEventLedgerEffectSchema } from '@balanceframe/protocol-generated/validators';
const receipt = fixture.receipts[0]! as ReceiptEvidence;
const props = {
  receipt,
  valid: true,
  direction: 'outflow' as const,
  categories: [
    { id: 'food', name: 'Fixture Groceries' },
    { id: 'household', name: 'Household' },
  ],
};
afterEach(() => vi.unstubAllGlobals());
const suggestion = {
  proposalId: 'approved-rule',
  payloadHash: 'a'.repeat(64),
  accountId: 'checking',
  receiptId: receipt.id,
  lineId: receipt.lines[0]!.id,
  categoryId: 'food',
  sourceDocumentId: 'doc-wallet',
  simulationHash: 'b'.repeat(64),
  state: 'suggested',
  reasonCodes: ['approved_exact_sku_rule'],
};
const reply = (suggestions: unknown[]) =>
  new Response(JSON.stringify({ status: 'ok', result: suggestions, error: null }));
describe('exact receipt item category review', () => {
  it('uses current approved exact item suggestions only on request and keeps their provenance inspectable', async () => {
    const request = vi.fn(async () => reply([suggestion]));
    vi.stubGlobal('fetch', request);
    const wrapper = mount(EvidenceReceiptLines, { props: { ...props, accountId: 'checking' } });
    await wrapper.get('[data-testid="receipt-line-mode"]').setValue(true);
    expect(request).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="receipt-line-suggestions"]').trigger('click');
    await flushPromises();
    expect(request).toHaveBeenCalledWith(
      '/api/evidence/rules/suggestions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ accountId: 'checking' }) }),
    );
    expect(
      wrapper.get<HTMLSelectElement>('[data-testid="receipt-line-category"]').element.value,
    ).toBe('food');
    expect(wrapper.text()).toContain('approved-rule');
    expect(wrapper.text()).toContain('a'.repeat(64));
    expect(wrapper.emitted('change')?.at(-1)?.[0]).toEqual([
      { categoryId: 'food', amount: { minorUnits: '-1200', currency: 'USD' } },
    ]);
  });
  it('leaves conflicting or inaccessible suggestions unresolved and preserves manual review when rules fail', async () => {
    const request = vi.fn(async () =>
      reply([
        { ...suggestion, state: 'conflicting_rules' },
        { ...suggestion, categoryId: 'inaccessible', proposalId: 'hidden' },
      ]),
    );
    vi.stubGlobal('fetch', request);
    const wrapper = mount(EvidenceReceiptLines, { props: { ...props, accountId: 'checking' } });
    await wrapper.get('[data-testid="receipt-line-mode"]').setValue(true);
    await wrapper.get('[data-testid="receipt-line-suggestions"]').trigger('click');
    await flushPromises();
    expect(
      wrapper.get<HTMLSelectElement>('[data-testid="receipt-line-category"]').element.value,
    ).toBe('');
    expect(wrapper.emitted('change')?.at(-1)?.[0]).toBeNull();
    request.mockRejectedValueOnce(new Error('offline'));
    await wrapper.get('[data-testid="receipt-line-suggestions"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Choose categories manually');
    await wrapper.get('[data-testid="receipt-line-category"]').setValue('food');
    expect(wrapper.emitted('change')?.at(-1)?.[0]).toHaveLength(1);
  });
  it('discards late suggestions when the account changes and clears prior account-scoped choices', async () => {
    let complete: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const wrapper = mount(EvidenceReceiptLines, { props: { ...props, accountId: 'checking' } });
    await wrapper.get('[data-testid="receipt-line-mode"]').setValue(true);
    await wrapper.get('[data-testid="receipt-line-suggestions"]').trigger('click');
    await wrapper.setProps({ accountId: 'other' });
    complete?.(reply([suggestion]));
    await flushPromises();
    expect(
      wrapper.get<HTMLSelectElement>('[data-testid="receipt-line-category"]').element.value,
    ).toBe('');
    expect(wrapper.text()).not.toContain('approved-rule');
  });
  it('retains a free item for inspection without asking its category or creating a zero-value ledger split', async () => {
    const free = {
      ...receipt.lines[0]!,
      id: 'free-item',
      rawDescription: 'Promotional free item',
      quantityMicros: 1000000,
      unitGross: { minorUnits: '0', currency: 'USD' },
      gross: { minorUnits: '0', currency: 'USD' },
      discount: { minorUnits: '0', currency: 'USD' },
      tax: { minorUnits: '0', currency: 'USD' },
      net: { minorUnits: '0', currency: 'USD' },
    };
    const wrapper = mount(EvidenceReceiptLines, {
      props: { ...props, receipt: { ...receipt, lines: [...receipt.lines, free] } },
    });
    await wrapper.get('[data-testid="receipt-line-mode"]').setValue(true);
    expect(wrapper.text()).toContain('Promotional free item');
    expect(wrapper.findAll('[data-testid="receipt-line-category"]')).toHaveLength(1);
    await wrapper.get('[data-testid="receipt-line-category"]').setValue('food');
    expect(wrapper.emitted('change')?.at(-1)?.[0]).toEqual([
      { categoryId: 'food', amount: { minorUnits: '-1200', currency: 'USD' } },
    ]);
  });
  it('requires every exact item category before emitting an inspectable debit split', async () => {
    const wrapper = mount(EvidenceReceiptLines, { props });
    expect(wrapper.text()).toContain('two items');
    expect(wrapper.text()).toContain('12.00 USD');
    await wrapper.get('[data-testid="receipt-line-mode"]').setValue(true);
    expect(wrapper.emitted('change')?.at(-1)).toEqual([null]);
    await wrapper.get('[data-testid="receipt-line-category"]').setValue('household');
    expect(
      economicEventLedgerEffectSchema.safeParse({
        accountId: 'checking',
        categoryId: null,
        amount: { minorUnits: '-1200', currency: 'USD' },
        date: '2026-10-15',
        payeeName: null,
        notes: null,
        splits: wrapper.emitted('change')?.at(-1)?.[0],
      }).success,
    ).toBe(true);
    expect(wrapper.emitted('change')?.at(-1)).toEqual([
      [{ categoryId: 'household', amount: { minorUnits: '-1200', currency: 'USD' } }],
    ]);
    await wrapper.get('[data-testid="receipt-line-mode"]').setValue(false);
    expect(wrapper.emitted('change')?.at(-1)).toEqual([undefined]);
  });
  it('preserves exact refund sign and clears categories when current permission targets change', async () => {
    const wrapper = mount(EvidenceReceiptLines, { props: { ...props, direction: 'inflow' } });
    await wrapper.get('[data-testid="receipt-line-mode"]').setValue(true);
    await wrapper.get('[data-testid="receipt-line-category"]').setValue('food');
    expect(wrapper.emitted('change')?.at(-1)?.[0]).toMatchObject([
      { amount: { minorUnits: '1200', currency: 'USD' } },
    ]);
    await wrapper.setProps({ categories: [] });
    expect(wrapper.emitted('change')?.at(-1)).toEqual([null]);
  });
  it('refuses to offer line splits when native receipt conservation has not passed', () => {
    const wrapper = mount(EvidenceReceiptLines, { props: { ...props, valid: false } });
    expect(wrapper.find('[data-testid="receipt-line-mode"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Receipt totals need review');
    expect(wrapper.emitted('change')).toBeUndefined();
  });
});

it('emits explicit stable line choices for learning only after a separate human opt-in', async () => {
  const wrapper = mount(EvidenceReceiptLines, { props: { ...props, accountId: 'checking' } });
  await wrapper.get('[data-testid="receipt-line-mode"]').setValue(true);
  await wrapper.get('[data-testid="receipt-line-category"]').setValue('food');
  expect(wrapper.emitted('review')?.at(-1)?.[0] ?? []).toEqual([]);
  await wrapper.get('[data-testid="receipt-line-learning"]').setValue(true);
  expect(wrapper.emitted('review')?.at(-1)?.[0]).toEqual([
    {
      receiptId: receipt.id,
      lineId: receipt.lines[0]!.id,
      accountId: 'checking',
      categoryId: 'food',
    },
  ]);
  await wrapper.setProps({ accountId: 'savings' });
  expect(wrapper.emitted('review')?.at(-1)?.[0]).toEqual([]);
  expect(
    wrapper.get<HTMLInputElement>('[data-testid="receipt-line-learning"]').element.checked,
  ).toBe(false);
});
