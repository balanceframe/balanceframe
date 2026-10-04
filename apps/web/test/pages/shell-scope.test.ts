import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import DefaultLayout from '../../app/layouts/default.vue';
import FreshnessBanner from '../../app/components/FreshnessBanner.vue';

const { signOut, sessionState } = vi.hoisted(() => ({
  signOut: vi.fn(),
  sessionState: { current: null as null | { value: { data: null | { user: { email: string } } } } },
}));
vi.mock('../../lib/auth-client', () => ({
  authClient: {
    useSession: () => sessionState.current,
    signOut,
  },
}));

const stubs = {
  UContainer: { template: '<div><slot /></div>' },
  UButton: {
    template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
    emits: ['click'],
  },
  NuxtLink: {
    props: ['to'],
    template: '<a :href="to" @click.prevent="$emit(\'click\')"><slot /></a>',
    emits: ['click'],
  },
};

describe('shared shell scope', () => {
  beforeEach(() => {
    sessionState.current = ref({ data: { user: { email: 'owner@example.com' } } });
  });

  it('loads current memberships when the authoritative human session resolves after mount', async () => {
    const session = ref<{ data: null | { user: { email: string } } }>({ data: null });
    sessionState.current = session;
    vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
      if (url === '/api/spaces') return {
        status: 'ok',
        result: {
          spaces: [{ id: 'late-session-space', name: 'Current human space', kind: 'shared' }],
          selectedSpaceId: null,
        },
      };
      return { status: 'error', result: null };
    }));
    const wrapper = mount(DefaultLayout, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('select[aria-label="Select current space"]').exists()).toBe(false);
    session.value = { data: { user: { email: 'owner@example.com' } } };
    await flushPromises();
    expect(wrapper.get('select[aria-label="Select current space"] option').text()).toBe('Current human space');
    session.value = { data: null };
    await flushPromises();
    expect(wrapper.find('select[aria-label="Select current space"]').exists()).toBe(false);
  });
  it('shows current space, authorization scope, sync status and user menu sign out', async () => {
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({
        status: 'ok',
        result: {
          month: '2026-08',
          budgetName: 'Household',
          totalRemaining: { minorUnits: '100', currency: 'USD' },
        },
        dataFreshness: { isStale: false, lastSync: '2026-08-01T00:00:00Z', label: 'current' },
        authorization: { capability: 'observe', allowed: true },
      }),
    );
    const wrapper = mount(DefaultLayout, {
      global: { stubs },
      slots: { default: '<p>content</p>' },
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Household');
    expect(wrapper.text()).toContain('observe');
    expect(wrapper.text()).toContain('Data current');
    await wrapper.find('button[aria-label="Open user menu"]').trigger('click');
    await wrapper.find('button[aria-label="Sign out"]').trigger('click');
    expect(signOut).toHaveBeenCalled();
  });

  it('keeps mobile navigation keyboard accessible and reports pending state', async () => {
    vi.stubGlobal(
      '$fetch',
      vi
        .fn()
        .mockResolvedValue({
          status: 'error',
          result: null,
          dataFreshness: null,
          authorization: null,
        }),
    );
    const wrapper = mount(DefaultLayout, {
      global: { stubs },
      slots: { default: '<p>content</p>' },
    });
    const toggle = wrapper.find('button[aria-label="Toggle navigation menu"]');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('nav[aria-label="Mobile navigation"] a').attributes('class')).toContain(
      'focus-visible',
    );
    await wrapper.find('nav[aria-label="Mobile navigation"] a').trigger('click');
    expect(wrapper.find('nav[aria-label="Mobile navigation"]').exists()).toBe(false);
  });

  it('shows only spaces returned for the authenticated principal in the picker', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
      if (url === '/api/spaces') return {
        status: 'ok',
        result: {
          spaces: [
            { id: 'space-one', name: 'Household', kind: 'shared' },
            { id: 'space-two', name: 'Studio', kind: 'personal' },
          ],
          selectedSpaceId: 'space-one',
        },
        error: null,
      };
      return { status: 'error', result: null, dataFreshness: null, authorization: null };
    }));
    const wrapper = mount(DefaultLayout, { global: { stubs }, slots: { default: '<p>content</p>' } });
    await flushPromises();
    const picker = wrapper.find('select[aria-label="Select current space"]');
    expect(picker.exists()).toBe(true);
    expect(picker.findAll('option').map((option) => option.text())).toEqual(['Household', 'Studio']);
    expect(wrapper.find('a[href="/spaces"]').text()).toContain('Spaces');
  });
});

describe('FreshnessBanner', () => {
  it('uses a real focusable refresh control', () => {
    const wrapper = mount(FreshnessBanner, {
      props: { freshness: { isStale: true, lastSync: null, label: 'stale' }, showRefresh: true },
    });
    const button = wrapper.find('button[aria-label="Refresh data"]');
    expect(button.element.tagName).toBe('BUTTON');
    expect(button.attributes('class')).toContain('focus-visible');
  });
});
