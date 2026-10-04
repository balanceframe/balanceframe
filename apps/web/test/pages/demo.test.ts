import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DemoPage from '../../app/pages/demo.vue';
import DemoBanner from '../../app/components/DemoBanner.vue';

const fetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: true } }));

const catalog = [
  {
    id: 'funded-purchase',
    featureGroup: 'Purchase',
    title: 'Funded purchase',
    summary: 'A groceries purchase is funded now.',
    suggestedActions: ['Evaluate the purchase'],
    supportedEventIds: [],
  },
  {
    id: 'uncategorized-debit',
    featureGroup: 'Evidence',
    title: 'Uncategorized debit',
    summary: 'An uncategorized debit needs correction.',
    suggestedActions: ['Simulate fixture categorization'],
    supportedEventIds: ['categorize-uncategorized'],
  },
];

const state = {
  status: 'ready',
  scenarioId: 'funded-purchase',
  generation: 3,
  anchor: '2026-09-06T12:00:00.000Z',
  shared: true,
  personaId: 'owner',
  personaIds: ['owner'],
  csrfToken: 'csrf-3',
};

const stubs = {
  NuxtLink: { template: '<a :href="to"><slot /></a>', props: ['to'] },
  UContainer: { template: '<div><slot /></div>' },
  UButton: {
    template:
      '<button :disabled="disabled" type="button" @click="$emit(\'click\')"><slot /></button>',
    props: ['disabled'],
    emits: ['click'],
  },
};

beforeEach(() => {
  state.scenarioId = 'funded-purchase';
  state.personaIds = ['owner'];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
    if (url === '/__demo/state') return Promise.resolve(state);
    return Promise.resolve({ generation: 4 });
  });
});

describe('demo selector', () => {
  it('groups selectors, describes actions, and exposes the shared warning', async () => {
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();

    expect(wrapper.get('[data-testid="demo-feature-Purchase"]').text()).toContain(
      'Funded purchase',
    );
    expect(wrapper.get('[data-testid="demo-feature-Evidence"]').text()).toContain(
      'Uncategorized debit',
    );
    expect(wrapper.text()).toContain('A groceries purchase is funded now.');
    expect(wrapper.text()).toContain('Fictional data');
    expect(wrapper.text()).toContain('shared demo instance');
    expect(
      wrapper
        .get('select[aria-label="Fictional persona"]')
        .findAll('option')
        .map((option) => option.element.value),
    ).toEqual(['owner']);
    expect(wrapper.get('button[data-event-id="categorize-uncategorized"]').text()).toContain(
      'correction',
    );
  });

  it('offers the independent completion approver and submits that exact current-generation persona', async () => {
    state.personaIds = ['owner', 'coapprover', 'restricted', 'approver'];
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    const selector = wrapper.get('select[aria-label="Fictional persona"]');
    expect(selector.findAll('option').map((option) => option.element.value)).toContain('approver');
    await selector.setValue('approver');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith('/__demo/persona', expect.objectContaining({
      method: 'POST',
      body: { personaId: 'approver', expectedGeneration: 3 },
      headers: expect.objectContaining({ 'X-BalanceFrame-Demo-CSRF': 'csrf-3' }),
    }));
  });

  it('opens only a current-generation authorized entry in the real application', async () => {
    const navigate = vi.fn();
    vi.stubGlobal('navigateTo', navigate);
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve(state);
      if (url === '/__demo/entry?generation=3')
        return Promise.resolve({ generation: 3, path: '/purchase-check' });
      return Promise.reject(new Error('Unexpected demo request'));
    });
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    await wrapper.get('button[data-action="open-scenario"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/__demo/entry?generation=3',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(navigate).toHaveBeenCalledWith('/purchase-check');
    vi.stubGlobal('navigateTo', undefined);
  });

  it('sends the state CSRF token and expected generation, then hard reloads after a load', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();

    await wrapper
      .get('button[data-scenario-id="uncategorized-debit"][data-action="load"]')
      .trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/__demo/load',
      expect.objectContaining({
        method: 'POST',
        body: { scenarioId: 'uncategorized-debit', expectedGeneration: 3 },
        headers: expect.objectContaining({ 'X-BalanceFrame-Demo-CSRF': 'csrf-3' }),
      }),
    );
    expect(reload).toHaveBeenCalled();
    reload.mockRestore();
  });

  it('requires a shared-reset confirmation and includes the CSRF token on events', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);

    state.scenarioId = 'uncategorized-debit';
    const eventWrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    await eventWrapper.get('button[data-event-id="categorize-uncategorized"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/__demo/event',
      expect.objectContaining({
        method: 'POST',
        body: { eventId: 'categorize-uncategorized', expectedGeneration: 3 },
        headers: expect.objectContaining({ 'X-BalanceFrame-Demo-CSRF': 'csrf-3' }),
      }),
    );
    eventWrapper.unmount();

    state.scenarioId = 'funded-purchase';
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    await wrapper.get('button[data-action="reset"]').trigger('click');
    expect(wrapper.text()).toContain('Reset the shared demo');
    expect(fetchMock).not.toHaveBeenCalledWith('/__demo/reset', expect.anything());

    await wrapper.get('button[data-action="confirm-reset"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/__demo/reset',
      expect.objectContaining({
        method: 'POST',
        body: { expectedGeneration: 3 },
        headers: expect.objectContaining({ 'X-BalanceFrame-Demo-CSRF': 'csrf-3' }),
      }),
    );
    reload.mockRestore();
  });

  it('shows the server disabled reason instead of claiming an unsupported event succeeded', async () => {
    state.scenarioId = 'uncategorized-debit';
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve(state);
      if (url === '/__demo/event')
        return Promise.reject({ data: { error: { code: 'DEMO_OPERATION_DISABLED' } } });
      return Promise.resolve({ generation: 4 });
    });

    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    await wrapper.get('button[data-event-id="categorize-uncategorized"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toMatch(
      /This operation is unavailable for the active scenario.*DEMO_OPERATION_DISABLED/,
    );
    expect(wrapper.get('[role="alert"]').text()).not.toContain('Updating the shared demo');
  });
});

describe('demo banner', () => {
  it('does not expose technical identifiers while naming the active fictional persona', async () => {
    const wrapper = mount(DemoBanner, { global: { stubs } });
    await flushPromises();

    expect(wrapper.text()).toContain('Funded purchase');
    expect(wrapper.text()).toContain('Fictional owner');
    expect(wrapper.text()).toContain('Fictional data — changes affect this shared demo instance');
    expect(wrapper.text()).not.toContain('csrf-3');
    expect(wrapper.text()).not.toContain('2026-09-06T12:00:00.000Z');
  });

  it.each([
    ['another visitor finishes loading a new generation', { generation: 4, status: 'ready' }],
    [
      'another visitor begins resetting the current generation',
      { generation: 3, status: 'loading' },
    ],
  ])('clears an open financial page when %s', async (_name, replacement) => {
    const originalPath = window.location.pathname;
    window.history.replaceState({}, '', '/purchase-check');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    vi.useFakeTimers();
    let nextState = { ...state };
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve({ ...nextState });
      return Promise.reject(new Error('Unexpected demo request'));
    });
    const wrapper = mount(DemoBanner, { global: { stubs } });
    try {
      await flushPromises();
      expect(wrapper.text()).toContain('Funded purchase');
      await vi.advanceTimersByTimeAsync(2000);
      expect(assign).not.toHaveBeenCalled();

      nextState = { ...nextState, ...replacement };
      await vi.advanceTimersByTimeAsync(2000);
      expect(assign).toHaveBeenCalledWith('/demo');
    } finally {
      wrapper.unmount();
      vi.useRealTimers();
      assign.mockRestore();
      window.history.replaceState({}, '', originalPath);
    }
  });
});
