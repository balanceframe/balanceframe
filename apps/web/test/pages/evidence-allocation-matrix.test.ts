import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import EvidenceAllocationMatrix from '../../app/components/EvidenceAllocationMatrix.vue';
import source from '../../../../protocol/fixtures/evidence-allocation-plan.json';
import plan from '../../../../protocol/fixtures/evidence-allocation-plan-result.json';
import result from '../../../../protocol/fixtures/evidence-allocation-resolution.json';
const fetcher = vi.fn();
const reauth = vi.hoisted(() => vi.fn());
vi.mock('../../app/utils/reauthentication', () => ({ reauthenticateHuman: reauth }));
const wrappers: VueWrapper[] = [];
const reply = (v: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result: v, error: null }));
beforeEach(() => {
  fetcher.mockReset();
  reauth.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  vi.unstubAllGlobals();
});
const targets = source.evidence.observations
  .filter((o) => o.kind === 'ledger_transaction')
  .map((o) => ({
    id: o.ledgerTransactionId!,
    date: o.date,
    amount: { minorUnits: `-${o.amount.minorUnits}`, currency: o.amount.currency },
    payeeName: 'Retailer',
    categoryId: null,
    categoryName: null,
    splits: [],
  }));
function panel() {
  const w = mount(EvidenceAllocationMatrix, {
    props: {
      resolution: result,
      receipts: source.evidence.receipts,
      accounts: [{ id: 'checking', name: 'Checking' }],
      categories: [{ id: 'food', name: 'Food' }],
    },
  });
  wrappers.push(w);
  return w;
}
async function select(w: VueWrapper) {
  await w.get('[data-testid="matrix-receipt"]').setValue(true);
  await w.get('[data-testid="matrix-account"]').setValue('checking');
  fetcher.mockResolvedValueOnce(reply({ transactions: targets }));
  await w.get('[data-testid="matrix-find"]').trigger('click');
  await flushPromises();
  for (const field of w.findAll('[data-testid="matrix-target"]')) await field.setValue(true);
  await w.get('[data-testid="matrix-category"]').setValue('food');
  await w.get('[data-testid="matrix-line-account"]').setValue('checking');
  const cells = w.findAll('[data-testid="matrix-cell"]');
  await cells[0]!.setValue('700');
  await cells[1]!.setValue('500');
}
it('sends explicit item cells, displays native remainders and saves only after exact human confirmation', async () => {
  const w = panel();
  await select(w);
  fetcher.mockResolvedValueOnce(reply(plan));
  await w.get('[data-testid="matrix-preview"]').trigger('click');
  await flushPromises();
  const selector = JSON.parse(fetcher.mock.calls[1]![1].body);
  expect(selector.cells.map((c: { amount: unknown }) => c.amount)).toEqual([
    { minorUnits: '700', currency: 'USD' },
    { minorUnits: '500', currency: 'USD' },
  ]);
  expect(selector).not.toHaveProperty('ledgerEffect');
  expect(w.text()).toContain('7.00 USD');
  expect(w.text()).toContain('5.00 USD');
  expect(w.get<HTMLButtonElement>('[data-testid="matrix-save"]').element.disabled).toBe(true);
  await w.get('[data-testid="matrix-confirm"]').setValue(true);
  await w.get('[data-testid="matrix-password"]').setValue('password');
  fetcher.mockResolvedValueOnce(reply(result));
  await w.get('[data-testid="matrix-save"]').trigger('click');
  await flushPromises();
  expect(reauth).toHaveBeenCalledWith('password');
  expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({
    ...selector,
    allocationSetHash: plan.allocationSetHash,
  });
  expect(w.emitted('saved')).toEqual([[result]]);
});
it('invalidates previews on cell/source changes and rejects late responses', async () => {
  const w = panel();
  await select(w);
  fetcher.mockResolvedValueOnce(reply(plan));
  await w.get('[data-testid="matrix-preview"]').trigger('click');
  await flushPromises();
  await w.findAll('[data-testid="matrix-cell"]')[0]!.setValue('699');
  expect(w.find('[data-testid="matrix-save"]').exists()).toBe(false);
  let finish!: (r: Response) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await w.get('[data-testid="matrix-preview"]').trigger('click');
  await w.setProps({ resolution: { ...result, resolutionHash: 'f'.repeat(64) } });
  finish(reply(plan));
  await flushPromises();
  expect(w.find('[data-testid="matrix-save"]').exists()).toBe(false);
});
