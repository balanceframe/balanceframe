import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ReceiptItemInference from '../../app/components/ReceiptItemInference.vue';
vi.mock('../../app/utils/reauthentication', () => ({
  reauthenticateHuman: vi.fn(async () => undefined),
}));
const payload = {
  itemLabel: 'Apples',
  categories: [{ alias: 'c0123456789abcdef', label: 'Groceries' }],
};
const preview = {
  state: 'preview',
  previewId: 'preview-1',
  payloadHash: 'a'.repeat(64),
  expiresAt: '2026-10-22T12:05:00Z',
  provider: {
    id: 'synthetic',
    version: '1',
    model: 'test',
    locality: 'local',
    configRevision: '1',
  },
  payload,
};
const suggestion = {
  state: 'suggested',
  previewId: preview.previewId,
  payloadHash: preview.payloadHash,
  receiptId: 'receipt',
  lineId: 'line',
  categoryId: 'food',
  provenance: preview.provider,
  reasonCode: 'receipt_model_suggestion',
};
const props = {
  accountId: 'checking',
  receiptId: 'receipt',
  lineId: 'line',
  categories: [{ id: 'food', name: 'Groceries' }],
};
const reply = (result: unknown) =>
  new Response(JSON.stringify({ status: 'ok', result, error: null }));
afterEach(() => vi.unstubAllGlobals());
describe('optional receipt inference review', () => {
  it('previews exact minimized input and waits for consent and a separate category selection', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(preview))
      .mockResolvedValueOnce(reply(suggestion));
    vi.stubGlobal('fetch', fetch);
    const wrapper = mount(ReceiptItemInference, { props });
    expect(fetch).not.toHaveBeenCalled();
    await wrapper.get('[data-testid="receipt-inference-local"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Apples');
    expect(wrapper.text()).toContain('Groceries');
    expect(wrapper.emitted('suggested')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    await wrapper.get('input[type="password"]').setValue('synthetic-password');
    await wrapper.get('[data-testid="receipt-inference-consent"]').trigger('click');
    await flushPromises();
    expect(wrapper.emitted('suggested')).toBeUndefined();
    await wrapper.get('[data-testid="receipt-inference-use"]').trigger('click');
    expect(wrapper.emitted('suggested')).toEqual([['food']]);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      previewId: 'preview-1',
      payloadHash: 'a'.repeat(64),
    });
  });
  it('keeps manual selection available for absent or failed providers and rejects stale context results', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply({ state: 'manual', reasonCode: 'inference_unavailable' }));
    vi.stubGlobal('fetch', fetch);
    const wrapper = mount(ReceiptItemInference, { props });
    await wrapper.get('[data-testid="receipt-inference-local"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Choose a category manually');
    expect(wrapper.emitted('suggested')).toBeUndefined();
    let resolve!: (value: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    await wrapper.get('[data-testid="receipt-inference-local"]').trigger('click');
    await wrapper.setProps({ accountId: 'other' });
    resolve(reply(suggestion));
    await flushPromises();
    expect(wrapper.find('[data-testid="receipt-inference-use"]').exists()).toBe(false);
    expect(wrapper.emitted('suggested')).toBeUndefined();
  });
  it('rejects a suggestion explicitly without dispatching external inference', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(suggestion))
      .mockResolvedValueOnce(reply({ state: 'rejected' }));
    vi.stubGlobal('fetch', fetch);
    const wrapper = mount(ReceiptItemInference, { props });
    await wrapper.get('[data-testid="receipt-inference-local"]').trigger('click');
    await flushPromises();
    await wrapper.get('input[type="password"]').setValue('synthetic-password');
    await wrapper.get('[data-testid="receipt-inference-reject"]').trigger('click');
    await flushPromises();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toContain('withdraw');
    expect(wrapper.emitted('suggested')).toBeUndefined();
  });
});
