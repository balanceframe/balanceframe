import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import ReceiptPhotoCapture from '../../app/components/ReceiptPhotoCapture.vue';
const wrappers: VueWrapper[] = [];
const create = vi.fn();
const revoke = vi.fn();
beforeEach(() => {
  create.mockReset().mockReturnValue('blob:synthetic-local-receipt');
  revoke.mockReset();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});
function panel() {
  const wrapper = mount(ReceiptPhotoCapture, { props: { resetKey: 0, disabled: false } });
  wrappers.push(wrapper);
  return wrapper;
}
async function choose(wrapper: VueWrapper, file: File) {
  const input = wrapper.get<HTMLInputElement>('input');
  Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
  await input.trigger('change');
}
describe('mobile receipt photo input', () => {
  it('offers the rear camera and local JPEG/PNG chooser only through the native file input', async () => {
    const wrapper = panel();
    expect(wrapper.get('input').attributes('capture')).toBe('environment');
    expect(wrapper.get('input').attributes('accept')).toBe('image/jpeg,image/png');
    expect(create).not.toHaveBeenCalled();
    const photo = new File(['synthetic photo'], 'receipt.jpg', { type: 'image/jpeg' });
    await choose(wrapper, photo);
    expect(wrapper.emitted('selected')?.[0]).toEqual([photo]);
    expect(wrapper.get('img').attributes('src')).toBe('blob:synthetic-local-receipt');
    expect(wrapper.text()).toContain('untrusted evidence');
    await wrapper.setProps({ resetKey: 1 });
    expect(wrapper.find('img').exists()).toBe(false);
    expect(revoke).toHaveBeenCalledWith('blob:synthetic-local-receipt');
    expect(wrapper.get<HTMLInputElement>('input').element.value).toBe('');
  });
  it.each([
    ['receipt.svg', 'image/svg+xml', 10],
    ['receipt.heic', 'image/heic', 10],
    ['large.jpg', 'image/jpeg', 5 * 1024 * 1024 + 1],
  ])(
    'rejects unsupported or oversized photos (%s) before emitting or creating a preview',
    async (name, type, size) => {
      const wrapper = panel();
      const file = new File(['photo'], name, { type });
      Object.defineProperty(file, 'size', { value: size });
      await choose(wrapper, file);
      expect(wrapper.emitted('selected')).toBeUndefined();
      expect(create).not.toHaveBeenCalled();
      expect(wrapper.get('[role="alert"]').text()).toContain('JPEG or PNG');
    },
  );
  it('revokes a replaced local preview and respects an in-progress parent upload', async () => {
    const wrapper = panel();
    await choose(wrapper, new File(['one'], 'one.png', { type: 'image/png' }));
    await choose(wrapper, new File(['two'], 'two.jpg', { type: 'image/jpeg' }));
    expect(revoke).toHaveBeenCalledWith('blob:synthetic-local-receipt');
    await wrapper.setProps({ disabled: true });
    expect(wrapper.get<HTMLInputElement>('input').element.disabled).toBe(true);
    wrapper.unmount();
    wrappers.splice(wrappers.indexOf(wrapper), 1);
    expect(revoke).toHaveBeenCalledTimes(2);
  });
  it('clears the previous selected source when a replacement photo is invalid', async () => {
    const wrapper = panel();
    await choose(wrapper, new File(['first'], 'first.png', { type: 'image/png' }));
    await choose(wrapper, new File(['unsupported'], 'other.svg', { type: 'image/svg+xml' }));
    expect(wrapper.emitted('cleared')).toEqual([[]]);
    expect(wrapper.find('img').exists()).toBe(false);
  });
});
