import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Component } from 'vue';
import ConnectionPage from '../app/pages/connection.vue';

interface FetchMock {
  (url: string, options?: Record<string, unknown>): Promise<unknown>;
  mockResolvedValueOnce(value: unknown): FetchMock;
  mockResolvedValue(value: unknown): FetchMock;
}

declare global {
  var $fetch: FetchMock;
}

const uiStubs: Record<string, Component> = {
  UContainer: { template: '<div><slot /></div>' },
  UCard: { template: '<div><slot name="header" /><slot /></div>' },
  UAlert: { props: ['title', 'description'], template: '<div>{{ title }} {{ description }}</div>' },
  UButton: {
    props: ['label', 'disabled', 'loading'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>',
  },
};

function getFetchMock(): FetchMock {
  return globalThis.$fetch;
}

describe('connection.vue', () => {
  it('lists budgets and persists the selected budget', async () => {
    getFetchMock()
      .mockResolvedValueOnce({
        status: 'ok',
        result: {
          budgets: [{ id: 'budget-1', groupId: 'group-1', name: 'Household', encrypted: false }],
        },
        error: null,
      })
      .mockResolvedValueOnce({ status: 'ok', result: { connected: true }, error: null });

    const wrapper = mount(ConnectionPage, { global: { stubs: uiStubs } });
    await vi.waitFor(() => expect(wrapper.text()).toContain('Household'));

    await wrapper.get('button').trigger('click');
    await vi.waitFor(() =>
      expect(getFetchMock()).toHaveBeenCalledWith(
        '/api/connection',
        expect.objectContaining({
          method: 'POST',
          body: { budgetId: 'budget-1' },
        }),
      ),
    );
    expect(wrapper.text()).toContain('Connection saved');
  });

  it('shows the Actual connection error when budget discovery fails', async () => {
    getFetchMock().mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: { message: 'Actual server unavailable' },
    });

    const wrapper = mount(ConnectionPage, { global: { stubs: uiStubs } });
    await vi.waitFor(() => expect(wrapper.text()).toContain('Actual server unavailable'));
  });
});
