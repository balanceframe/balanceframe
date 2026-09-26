import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SpendSessionPage from '../../app/pages/spend-sessions/[id].vue';

const fetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
vi.stubGlobal('useRoute', () => ({ params: { id: 'fixture-session' } }));

const editor = {
  name: 'SpendSessionEditor',
  props: ['session', 'catalog'],
  template: '<div data-testid="saved-editor" />',
};
const claims = {
  name: 'ProspectiveClaimPanel',
  props: ['session'],
  template: '<div data-testid="saved-claims" />',
};
const completion = {
  name: 'SessionCompletionPanel',
  props: ['session'],
  template: '<div data-testid="saved-completion" />',
};
const session = (version: number) => ({
  id: 'fixture-session',
  version,
  items: [],
  card: { cart: { categoryCharges: [], accountCharges: [] } },
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve({
      status: 'ok',
      result: url.includes('spendability') ? { accounts: [], categories: [] } : session(3),
    }),
  );
});

describe('saved session lifecycle actions', () => {
  it('hides claim and completion actions for unsaved cart edits and reloads the saved Card after a save', async () => {
    const wrapper = mount(SpendSessionPage, {
      global: {
        components: { SpendSessionEditor: editor, ProspectiveClaimPanel: claims, SessionCompletionPanel: completion },
        stubs: {
          AnalysisPage: { props: ['loading', 'error'], template: '<main><slot name="content" /></main>' },
          NuxtLink: { template: '<a><slot /></a>' },
        },
      },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="saved-claims"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="saved-completion"]').exists()).toBe(true);

    wrapper.getComponent(editor).vm.$emit('draft-state', true);
    await flushPromises();
    expect(wrapper.find('[data-testid="saved-claims"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="saved-completion"]').exists()).toBe(false);

    wrapper.getComponent(editor).vm.$emit('saved', session(4));
    await flushPromises();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/spend-sessions/'))).toHaveLength(2);
    expect(wrapper.find('[data-testid="saved-claims"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="saved-completion"]').exists()).toBe(true);
  });
});
