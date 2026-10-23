import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import EvidenceReceiptVersionReview from '../../app/components/EvidenceReceiptVersionReview.vue';
const reauth = vi.hoisted(() => vi.fn());
vi.mock('../../app/utils/reauthentication', () => ({ reauthenticateHuman: reauth }));
const fetcher = vi.fn(),
  wrappers: VueWrapper[] = [];
const hash = 'a'.repeat(64),
  fold = 'b'.repeat(64);
const source = (name: string) => ({
  documentId: name,
  receiptId: `${name}:receipt`,
  contentHash: 'c'.repeat(64),
  parserVersion: 'retail-photo-user-v1',
});
const choice = (name: string) => ({
  ...source(name),
  label: `${name}.jpg`,
  merchant: '<img src=x onerror=alert(1)>',
  date: '2026-10-21',
  total: { minorUnits: '1200', currency: 'USD' },
  direction: 'outflow',
  version: 1,
  familyKey: 'd'.repeat(64),
});
const context = {
  resolutionHash: hash,
  foldHash: fold,
  children: [choice('child')],
  predecessors: [choice('parent')],
  links: [],
  blockedChildren: [],
};
const preview = {
  resolutionHash: hash,
  foldHash: fold,
  previewHash: 'e'.repeat(64),
  child: source('child'),
  predecessor: source('parent'),
  predecessorVersion: 1,
  version: 2,
  identityBasis: 'human_attested_same_receipt',
  sourceClosure: [source('child'), source('parent')],
  nativeResolutionHash: 'f'.repeat(64),
};
const reply = (value: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result: value, error: null }));
const key = (name: string) => JSON.stringify([name, `${name}:receipt`]);
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
  const w = mount(EvidenceReceiptVersionReview, { props: { sourceVersion: hash } });
  wrappers.push(w);
  return w;
}
async function load(w: VueWrapper, value: unknown = context) {
  fetcher.mockResolvedValueOnce(reply(value));
  await w.get('[data-testid="receipt-version-load"]').trigger('click');
  await flushPromises();
}
async function select(w: VueWrapper) {
  await w.get('[data-testid="receipt-version-child"]').setValue(key('child'));
  await w.get('[data-testid="receipt-version-parent"]').setValue(key('parent'));
}
async function prepare(w: VueWrapper) {
  fetcher.mockResolvedValueOnce(reply(preview));
  await w.get('[data-testid="receipt-version-preview"]').trigger('click');
  await flushPromises();
}
async function confirm(w: VueWrapper) {
  await w.get('[data-testid="receipt-version-confirm"]').setValue(true);
  await w.get('[data-testid="receipt-version-password"]').setValue('password');
}
describe('explicit receipt version review', () => {
  it('loads on demand and previews/selects exact sources before fresh human approval', async () => {
    const w = panel();
    expect(fetcher).not.toHaveBeenCalled();
    await load(w);
    await select(w);
    expect(w.find('img').exists()).toBe(false);
    expect(w.get<HTMLButtonElement>('[data-testid="receipt-version-save"]').element.disabled).toBe(
      true,
    );
    await prepare(w);
    expect(w.text()).toContain('version 2');
    expect(w.text()).toContain('retail-photo-user-v1');
    await confirm(w);
    fetcher.mockResolvedValueOnce(reply({ saved: true, child: source('child'), version: 2 }));
    await w.get('[data-testid="receipt-version-save"]').trigger('click');
    await flushPromises();
    expect(reauth).toHaveBeenCalledWith('password');
    expect(JSON.parse(fetcher.mock.calls[2]![1].body)).toEqual({
      resolutionHash: hash,
      child: { documentId: 'child', receiptId: 'child:receipt' },
      predecessor: { documentId: 'parent', receiptId: 'parent:receipt' },
      previewHash: preview.previewHash,
      expectedFoldHash: fold,
      sameReceiptAcknowledged: true,
    });
    expect(w.emitted('saved')).toHaveLength(1);
    expect(fetcher.mock.calls.every((c) => !String(c[0]).includes('proposal'))).toBe(true);
  });
  it('clears preview, confirmation and secret when selection or resolution changes', async () => {
    const w = panel();
    await load(w);
    await select(w);
    await prepare(w);
    await confirm(w);
    await w.get('[data-testid="receipt-version-parent"]').setValue('');
    expect(w.get<HTMLInputElement>('[data-testid="receipt-version-password"]').element.value).toBe(
      '',
    );
    expect(w.find('[data-testid="receipt-version-proof"]').exists()).toBe(false);
    await w.setProps({ sourceVersion: '0'.repeat(64) });
    expect(w.find('[data-testid="receipt-version-child"]').exists()).toBe(false);
  });
  it('discards late preview/context and never saves after failed or stale authentication', async () => {
    const w = panel();
    let finish!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await w.get('[data-testid="receipt-version-load"]').trigger('click');
    await w.setProps({ sourceVersion: '0'.repeat(64) });
    finish(reply(context));
    await flushPromises();
    expect(w.find('[data-testid="receipt-version-child"]').exists()).toBe(false);
    await w.setProps({ sourceVersion: hash });
    await load(w);
    await select(w);
    await prepare(w);
    await confirm(w);
    reauth.mockRejectedValueOnce(new Error('expired'));
    await w.get('[data-testid="receipt-version-save"]').trigger('click');
    await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(w.find('[role="alert"]').exists()).toBe(true);
  });
  it('keeps summary-only receipts explicit and supports revocation without predecessor detail', async () => {
    const w = panel();
    await load(w, {
      ...context,
      children: [],
      predecessors: [],
      blockedChildren: [
        { child: source('child'), reasonCode: 'reviewed_receipt_history_unavailable' },
      ],
    });
    expect(w.text()).toContain('Summary-only');
    await w.get('[data-testid="receipt-version-mode"]').setValue('revoke');
    await w.get('[data-testid="receipt-version-revoke-child"]').setValue(key('child'));
    await confirm(w);
    fetcher.mockResolvedValueOnce(
      reply({ revoked: true, childDocumentId: 'child', childReceiptId: 'child:receipt' }),
    );
    await w.get('[data-testid="receipt-version-revoke"]').trigger('click');
    await flushPromises();
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
      childDocumentId: 'child',
      childReceiptId: 'child:receipt',
      expectedFoldHash: fold,
    });
    expect(w.emitted('saved')).toHaveLength(1);
  });
});
it('validates the source-only version context fixture', async () => {
  const { receiptVersionContextSchema } =
    await import('../../app/utils/evidence-receipt-version-client');
  expect(receiptVersionContextSchema.safeParse(context)).toMatchObject({ success: true });
});

it('treats sourceVersion only as invalidation and sends the independently captured context resolution', async () => {
  const w = panel();
  await w.setProps({ sourceVersion: 'different-current-financial-decision' });
  await load(w);
  await select(w);
  await prepare(w);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).resolutionHash).toBe(context.resolutionHash);
});
