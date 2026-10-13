import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import LiquidityPreferenceEditor from '../../app/components/LiquidityPreferenceEditor.vue';
const fetchMock = vi.fn();
const confirmationFetch = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
const catalog = {
  accounts: [
    { id: 'checking', name: 'Daily checking', reasons: [] },
    { id: 'other', name: 'Other checking', reasons: [] },
  ],
  categories: [{ id: 'food', name: 'Food', feasible: true, backing: [], reasons: [] }],
};
const global = {
  stubs: {
    UCard: { template: '<section><slot name="header" /><slot /></section>' },
    UButton: {
      props: ['disabled'],
      template:
        '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
    },
  },
};
beforeEach(() => {
  fetchMock.mockReset();
  confirmationFetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ status: 'success' })));
  vi.stubGlobal('fetch', confirmationFetch);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: false } }));
});
describe('governed payment preferences', () => {
  it('requires fresh confirmation and clears credentials after an approved preference save', async () => {
    fetchMock.mockResolvedValue({
      status: 'ok',
      result: {
        items: [
          {
            id: 'preference-food',
            version: 3,
            categoryId: 'food',
            accountId: 'checking',
            expiresAt: '2099-09-07T12:00:00Z',
          },
        ],
        canManage: true,
      },
    });
    const wrapper = mount(LiquidityPreferenceEditor, { props: catalog, global });
    await flushPromises();
    await wrapper.get('[data-testid="preference-category"]').setValue('food');
    await wrapper.get('[data-testid="preference-account"]').setValue('other');
    const save = wrapper.findAll('button').find((button) => button.text() === 'Save approved payment preference')!;
    expect(save.attributes('disabled')).toBeDefined();
    await wrapper.get('input[type="password"]').setValue('fixture-password');
    expect(save.attributes('disabled')).toBeUndefined();
    fetchMock.mockResolvedValueOnce({
      status: 'ok', result: { canManage: true, items: [{
        id: 'preference-food', version: 4, categoryId: 'food', accountId: 'other',
        expiresAt: '2099-09-07T12:00:00Z',
      }] },
    });
    await save.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('Approved preference saved.');
    expect(wrapper.text()).toContain('Food → Other checking');
    expect(wrapper.get<HTMLInputElement>('input[type="password"]').element.value).toBe('');
    expect(confirmationFetch).toHaveBeenCalledOnce();
  });
  it('withholds the preference write after password confirmation fails', async () => {
    fetchMock.mockResolvedValue({ status: 'ok', result: { items: [], canManage: true } });
    confirmationFetch.mockResolvedValue(new Response(JSON.stringify({
      status: 'error', error: { message: 'Password confirmation refused.' },
    }), { status: 403 }));
    const wrapper = mount(LiquidityPreferenceEditor, { props: catalog, global });
    await flushPromises();
    await wrapper.get('[data-testid="preference-category"]').setValue('food');
    await wrapper.get('[data-testid="preference-account"]').setValue('checking');
    await wrapper.get('input[type="password"]').setValue('wrong-fixture-password');
    await wrapper.findAll('button').find((button) => button.text() === 'Save approved payment preference')!.trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('Password confirmation refused.');
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
    expect(wrapper.get<HTMLInputElement>('input[type="password"]').element.value).toBe('');
    expect(wrapper.text()).not.toContain('Approved preference saved.');
  });
  it('does not offer a save action to a reader lacking management permission', async () => {
    fetchMock.mockResolvedValue({ status: 'ok', result: { items: [], canManage: false } });
    const wrapper = mount(LiquidityPreferenceEditor, { props: catalog, global });
    await flushPromises();
    expect(wrapper.find('[data-testid="preference-account"]').exists()).toBe(false);
    expect(wrapper.findAll('button').some((button) => button.text().includes('Save'))).toBe(false);
  });
});
