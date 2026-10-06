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
  {
    id: 'governance-scoped-access',
    featureGroup: 'Governance',
    title: 'Scoped fictional access',
    summary: 'Inspect visible and withheld resources.',
    suggestedActions: ['Open space governance'],
    supportedEventIds: [],
  },
  {
    id: 'governance-invitation-lifecycle',
    featureGroup: 'Governance',
    title: 'Invitation lifecycle',
    summary: 'Redeem a pending fictional invitation.',
    suggestedActions: ['Accept as the invited human'],
    supportedEventIds: ['invite-redeem'],
  },
  {
    id: 'merchant-research-lifecycle',
    featureGroup: 'Merchant',
    title: 'Fixture merchant research',
    summary: 'Offline fixture provider; no live paid searches.',
    suggestedActions: ['Release the held fixture result'],
    supportedEventIds: ['research-release'],
  },
  {
    id: 'governance-delegated-assistant',
    featureGroup: 'Governance',
    title: 'Bounded delegated assistant',
    summary: 'Inspect admitted metadata and blocked operations.',
    suggestedActions: ['Probe the bounded assistant'],
    supportedEventIds: ['assistant-probe', 'assistant-revoke'],
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
  personas: [{ id: 'owner', label: 'Fictional owner' }],
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
  state.personas = [{ id: 'owner', label: 'Fictional owner' }];
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
    state.personas = [
      { id: 'owner', label: 'Fictional owner' },
      { id: 'coapprover', label: 'Fictional co-approver' },
      { id: 'restricted', label: 'Fictional restricted viewer' },
      { id: 'approver', label: 'Fictional independent approver' },
    ];
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

  it('shows current bounded-assistant outcomes and retires admitted metadata after denial or malformed results', async () => {
    state.scenarioId = 'governance-delegated-assistant';
    const replies: unknown[] = [
      { generation: 3, probe: {
        checking: { status: 200, resources: [{ resourceKind: 'account', resourceId: 'checking', name: 'Household Checking' }] },
        denials: ['manage-grants', 'financial', 'full-history'].map(operation => ({ operation, status: 403 })),
      } },
      { generation: 3, probe: {
        checking: { status: 401, resources: [] },
        denials: ['manage-grants', 'financial', 'full-history'].map(operation => ({ operation, status: 401 })),
      } },
      { generation: 3, probe: {
        checking: { status: 200, resources: [{ resourceKind: 'account', resourceId: 'checking',
          name: 'Untrusted result', balance: { minorUnits: '99999', currency: 'USD' } }] },
        denials: ['manage-grants', 'financial', 'full-history'].map(operation => ({ operation, status: 403 })),
      } },
    ];
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve(state);
      if (url === '/__demo/event') return Promise.resolve(replies.shift());
      return Promise.reject(new Error('Unexpected demo request'));
    });
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    const probe = wrapper.get('[data-event-id="assistant-probe"]');
    await probe.trigger('click');
    await flushPromises();
    const result = wrapper.get('[data-testid="demo-assistant-probe"]');
    expect(result.text()).toContain('Household Checking');
    expect(result.text()).toMatch(/checking.*200/i);
    expect(result.findAll('li').map(row => row.text())).toEqual([
      expect.stringMatching(/manage-grants.*403/), expect.stringMatching(/financial.*403/),
      expect.stringMatching(/full-history.*403/),
    ]);
    await probe.trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="demo-assistant-probe"]').text()).toMatch(/checking.*401/i);
    expect(wrapper.text()).not.toContain('Household Checking');
    await probe.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="demo-assistant-probe"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Untrusted result');
    expect(wrapper.text()).not.toContain('99999');
    wrapper.unmount();
    reload.mockRestore();
  });

  it('retires bounded-assistant metadata when polling changes generation during a pending entry request', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    state.scenarioId = 'governance-delegated-assistant';
    let latestState = { ...state };
    let resolveEntry!: (value: unknown) => void;
    const entry = new Promise<unknown>(resolve => { resolveEntry = resolve; });
    const navigate = vi.fn();
    vi.stubGlobal('navigateTo', navigate);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve(latestState);
      if (url === '/__demo/entry?generation=3') return entry;
      if (url === '/__demo/event') return Promise.resolve({ generation: 3, probe: {
        checking: { status: 200, resources: [{ resourceKind: 'account', resourceId: 'checking', name: 'Household Checking' }] },
        denials: ['manage-grants', 'financial', 'full-history'].map(operation => ({ operation, status: 403 })),
      } });
      return Promise.reject(new Error('Unexpected demo request'));
    });
    const wrapper = mount(DemoPage, { global: { stubs } });
    try {
      await flushPromises();
      await wrapper.get('[data-event-id="assistant-probe"]').trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-testid="demo-assistant-probe"]').text()).toContain('Household Checking');
      await wrapper.get('[data-action="open-scenario"]').trigger('click');
      latestState = { ...state, scenarioId: 'merchant-research-lifecycle', generation: 4, csrfToken: 'csrf-4' };
      await vi.advanceTimersByTimeAsync(1500);
      await flushPromises();
      expect(wrapper.find('[data-testid="demo-assistant-probe"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('Household Checking');
      resolveEntry({ generation: 3, path: '/spaces' });
      await flushPromises();
      expect(navigate).not.toHaveBeenCalled();
      expect(wrapper.text()).not.toContain('Household Checking');
    } finally {
      resolveEntry({ generation: 3, path: '/spaces' });
      wrapper.unmount();
      reload.mockRestore();
      vi.useRealTimers();
      vi.stubGlobal('navigateTo', undefined);
    }
  });

  it('does not republish a late admitted probe after polling reports same-generation reset loading', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    state.scenarioId = 'governance-delegated-assistant';
    let latestState = { ...state };
    let resolveProbe!: (value: unknown) => void;
    const delayed = new Promise<unknown>(resolve => { resolveProbe = resolve; });
    const admitted = { generation: 3, probe: {
      checking: { status: 200, resources: [{ resourceKind: 'account', resourceId: 'checking', name: 'Household Checking' }] },
      denials: ['manage-grants', 'financial', 'full-history'].map(operation => ({ operation, status: 403 })),
    } };
    let probes = 0;
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve(latestState);
      if (url === '/__demo/event') return ++probes === 1 ? Promise.resolve(admitted) : delayed;
      return Promise.reject(new Error('Unexpected demo request'));
    });
    const wrapper = mount(DemoPage, { global: { stubs } });
    try {
      await flushPromises();
      await wrapper.get('[data-event-id="assistant-probe"]').trigger('click');
      await flushPromises();
      expect(wrapper.get('[data-testid="demo-assistant-probe"]').text()).toContain('Household Checking');
      await wrapper.get('[data-event-id="assistant-probe"]').trigger('click');
      latestState = { ...state, status: 'loading' };
      await vi.advanceTimersByTimeAsync(1500);
      await flushPromises();
      resolveProbe(admitted);
      await flushPromises();
      expect(wrapper.find('[data-testid="demo-assistant-probe"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('Household Checking');
      expect(wrapper.find('[role="alert"]').exists()).toBe(true);
      latestState = { ...state, scenarioId: 'merchant-research-lifecycle', generation: 4, csrfToken: 'csrf-4' };
      await vi.advanceTimersByTimeAsync(1500);
      await flushPromises();
      expect(wrapper.text()).not.toContain('Household Checking');
    } finally {
      resolveProbe(admitted);
      wrapper.unmount();
      reload.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    ['governance-scoped-access', '/spaces'],
    ['merchant-research-lifecycle', '/review'],
    ['merchant-native-rule-lifecycle', '/rules'],
    ['merchant-recurrence-calendar', '/'],
  ])('opens the exact normal page entry for %s', async (scenarioId, path) => {
    state.scenarioId = scenarioId;
    const navigate = vi.fn();
    vi.stubGlobal('navigateTo', navigate);
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve(state);
      if (url === '/__demo/entry?generation=3') return Promise.resolve({ generation: 3, path });
      throw new Error(`Unexpected demo request ${url}`);
    });
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    await wrapper.get('button[data-action="open-scenario"]').trigger('click');
    await flushPromises();
    expect(navigate).toHaveBeenCalledExactlyOnceWith(path);
    wrapper.unmount();
    vi.stubGlobal('navigateTo', undefined);
  });

  it.each([
    'https://attacker.example/keys',
    '//attacker.example',
    '/spaces?invitationToken=private-token',
    '/review?apiKey=private-key',
    '/api/auth/api-key/create',
    '/spaces/other-space',
  ])('never navigates to an arbitrary or secret-bearing entry %s', async (path) => {
    const navigate = vi.fn();
    vi.stubGlobal('navigateTo', navigate);
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve(state);
      if (url === '/__demo/entry?generation=3') return Promise.resolve({ generation: 3, path });
      throw new Error(`Unexpected demo request ${url}`);
    });
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    await wrapper.get('button[data-action="open-scenario"]').trigger('click');
    await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('private-token');
    expect(wrapper.text()).not.toContain('private-key');
    wrapper.unmount();
    vi.stubGlobal('navigateTo', undefined);
  });

  it('groups Governance and Merchant and labels research explicitly as an offline fixture', async () => {
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.get('[data-testid="demo-feature-Governance"]').text()).toContain('Scoped fictional access');
    expect(wrapper.get('[data-testid="demo-feature-Merchant"]').text()).toContain('Offline fixture provider; no live paid searches.');
    expect(wrapper.findAll('a').map((link) => link.attributes('href'))).not.toContain('https://attacker.example');
    wrapper.unmount();
  });

  it.each([
    ['governance-invitation-lifecycle', 'invite-redeem', /accept|redeem/i],
    ['merchant-research-lifecycle', 'research-release', /release/i],
  ] as const)('gives the declared %s control an action-specific safe label', async (scenarioId, eventId, label) => {
    state.scenarioId = scenarioId;
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.get(`button[data-event-id="${eventId}"]`).text()).toMatch(label);
    wrapper.unmount();
  });

  it.each([
    ['limited', 'Fictional limited member'],
    ['invitee', 'Invited Member'],
  ])('selects the server-declared active %s human without exposing private recipe fields', async (id, label) => {
    state.personaIds = ['owner', id];
    state.personas = [{ id: 'owner', label: 'Fictional owner' }, { id, label }];
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve({
        ...state,
        governance: { pendingInvitations: { invitee: { token: 'PRIVATE-INVITATION-TOKEN' } }, assistant: { apiKey: 'PRIVATE-ASSISTANT-KEY' } },
        internalSecret: 'PRIVATE-INTERNAL-SECRET',
      });
      return Promise.resolve({ generation: 3 });
    });
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    const selector = wrapper.get('select[aria-label="Fictional persona"]');
    expect(selector.findAll('option').map((option) => [option.element.value, option.text()])).toEqual([
      ['owner', 'Fictional owner'], [id, label],
    ]);
    expect(wrapper.html()).not.toMatch(/PRIVATE-(INVITATION-TOKEN|ASSISTANT-KEY|INTERNAL-SECRET)/);
    await selector.setValue(id);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith('/__demo/persona', expect.objectContaining({
      body: { personaId: id, expectedGeneration: 3 },
      headers: expect.objectContaining({ 'X-BalanceFrame-Demo-CSRF': 'csrf-3' }),
    }));
    expect(reload).toHaveBeenCalledOnce();
    reload.mockRestore();
    wrapper.unmount();
  });

  it('does not offer a pending invitee or assistant key as a selectable human', async () => {
    state.scenarioId = 'governance-invitation-lifecycle';
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve({
        ...state,
        pendingInvitations: [{ personaId: 'invitee', displayName: 'Invited Member', token: 'PRIVATE-PENDING-TOKEN' }],
        assistant: { id: 'assistant', apiKey: 'PRIVATE-KEY' },
      });
      return Promise.resolve({ generation: 3 });
    });
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.get('select[aria-label="Fictional persona"]').findAll('option').map((option) => option.element.value)).toEqual(['owner']);
    expect(wrapper.html()).not.toMatch(/PRIVATE-(PENDING-TOKEN|KEY)/);
    wrapper.unmount();
  });

  it('rejects an undeclared arbitrary persona rather than exposing its URL or submitting its identity', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve({
        ...state, personaIds: ['owner', 'https://attacker.example/PRIVATE-KEY'],
        personas: [
          { id: 'owner', label: 'Fictional owner' },
          { id: 'https://attacker.example/PRIVATE-KEY', label: 'Injected human' },
        ],
      });
      return Promise.resolve({ generation: 3 });
    });
    const wrapper = mount(DemoPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.html()).not.toContain('PRIVATE-KEY');
    expect(fetchMock).not.toHaveBeenCalledWith('/__demo/persona', expect.anything());
    wrapper.unmount();
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
    ['limited', 'Fictional limited member'],
    ['invitee', 'Invited Member'],
  ])('names the current %s human from declared safe metadata without private recipe leakage', async (id, label) => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/__demo/catalog') return Promise.resolve({ scenarios: catalog });
      if (url === '/__demo/state') return Promise.resolve({
        ...state, personaId: id, personaIds: ['owner', id],
        personas: [{ id: 'owner', label: 'Fictional owner' }, { id, label }],
        invitationToken: 'PRIVATE-BANNER-TOKEN', apiKey: 'PRIVATE-BANNER-KEY',
      });
      throw new Error(`Unexpected demo request ${url}`);
    });
    const wrapper = mount(DemoBanner, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain(label);
    expect(wrapper.html()).not.toMatch(/PRIVATE-BANNER-(TOKEN|KEY)|csrf-3/);
    wrapper.unmount();
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
