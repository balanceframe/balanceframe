import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import LiquidityPreferenceEditor from '../../app/components/LiquidityPreferenceEditor.vue';
const fetchMock = vi.fn();
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
beforeEach(() => fetchMock.mockReset());
describe('governed payment preferences', () => {
  it('requires an explicit save and submits the selected authorized route with the current preference version', async () => {
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
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Save approved payment preference')!
      .trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/liquidity/preferences',
      expect.objectContaining({
        method: 'PUT',
        body: {
          categoryId: 'food',
          accountId: 'other',
          expectedVersion: 3,
          expiresAt: '2099-09-07T12:00:00.000Z',
        },
      }),
    );
  });
  it('does not offer a save action to a reader lacking management permission', async () => {
    fetchMock.mockResolvedValue({ status: 'ok', result: { items: [], canManage: false } });
    const wrapper = mount(LiquidityPreferenceEditor, { props: catalog, global });
    await flushPromises();
    expect(wrapper.find('[data-testid="preference-account"]').exists()).toBe(false);
    expect(wrapper.findAll('button').some((button) => button.text().includes('Save'))).toBe(false);
  });
});
