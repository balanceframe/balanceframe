import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Connection from '../../app/pages/connection.vue';

const api = vi.fn();
const authentication = vi.fn();
const global = {
  stubs: {
    UContainer: { template: '<main><slot /></main>' },
    UCard: { template: '<section><slot name="header" /><slot /></section>' },
    UAlert: { props: ['title', 'description'], template: '<p role="status">{{ title }} {{ description }}</p>' },
    UButton: {
      props: ['label', 'disabled'], emits: ['click'],
      template: '<button :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
    },
  },
};
beforeEach(() => {
  api.mockReset();
  authentication.mockReset();
  vi.stubGlobal('$fetch', api);
  vi.stubGlobal('fetch', authentication);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: false } }));
});

describe('connection human confirmation', () => {
  it('shows discovery failure without permitting an unavailable budget to be saved', async () => {
    const wrapper = mount(Connection, { global });
    try {
      authentication.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success' }) });
      api.mockResolvedValueOnce({
        status: 'error', result: null, error: { message: 'Actual server unavailable' },
      });
      await wrapper.get('input[type="password"]').setValue('fixture-password');
      await wrapper.get('button').trigger('click');
      await flushPromises();
      expect(wrapper.text()).toContain('Actual server unavailable');
      expect(wrapper.find('input[type="radio"]').exists()).toBe(false);
      expect(wrapper.findAll('button').some((button) => button.text() === 'Save connection')).toBe(false);
      expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe('');
    } finally { wrapper.unmount(); }
  });

  it('does not discover private budgets after rejected password confirmation', async () => {
    const wrapper = mount(Connection, { global });
    try {
      await flushPromises();
      expect(api).not.toHaveBeenCalled();
      authentication.mockResolvedValueOnce({
        ok: false, status: 401,
        json: async () => ({ status: 'error', error: { message: 'Password confirmation rejected.' } }),
      });
      await wrapper.get('input[type="password"]').setValue('fixture-password');
      await wrapper.get('button').trigger('click');
      await flushPromises();
      expect(api).not.toHaveBeenCalled();
      expect(wrapper.text()).toContain('Password confirmation rejected.');
      expect((wrapper.get('input[type="password"]').element as HTMLInputElement).value).toBe('');
      expect(wrapper.find('input[type="radio"]').exists()).toBe(false);
    } finally { wrapper.unmount(); }
  });

  it('loads budgets under fresh proof and saves only the explicitly selected budget', async () => {
    const wrapper = mount(Connection, { global });
    try {
      await flushPromises();
      expect(api).not.toHaveBeenCalled();
      authentication.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'success' }) });
      api.mockResolvedValueOnce({ status: 'ok', result: { budgets: [
        { id: 'personal-budget', groupId: 'personal-group', name: 'Personal', encrypted: false },
        { id: 'shared-budget', groupId: 'shared-group', name: 'Shared', encrypted: false },
      ] } });
      await wrapper.get('input[type="password"]').setValue('fixture-password');
      await wrapper.get('button').trigger('click');
      await flushPromises();
      const radios = wrapper.findAll('input[type="radio"]');
      expect(radios.every((radio) => !(radio.element as HTMLInputElement).checked)).toBe(true);
      expect(wrapper.findAll('button').find((button) => button.text() === 'Save connection')!.attributes('disabled')).toBeDefined();
      await radios[1]!.setValue(true);
      api.mockImplementationOnce(async (_path: string, options: { body: { budgetId: string } }) => {
        if (options.body.budgetId !== 'shared-budget') throw new Error('Wrong budget selected');
        return { status: 'ok', result: { connected: true } };
      });
      await wrapper.findAll('button').find((button) => button.text() === 'Save connection')!.trigger('click');
      await flushPromises();
      expect(wrapper.text()).toContain('Connection saved');
      expect((radios[0]!.element as HTMLInputElement).checked).toBe(false);
      expect((radios[1]!.element as HTMLInputElement).checked).toBe(true);
    } finally { wrapper.unmount(); }
  });
});
