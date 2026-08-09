import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import IndexPage from '../../app/pages/index.vue';
import AnalysisPage from '../../app/components/AnalysisPage.vue';

type SessionData = {
  data: { user: { id?: string; email: string } } | null;
  isPending: boolean;
};
type FetchCall = (url: string, options?: unknown) => Promise<unknown>;

const auth = vi.hoisted(() => ({
  session: undefined as unknown as Ref<SessionData>,
  signOut: vi.fn(),
}));

auth.session = ref<SessionData>({
  data: { user: { email: 'dashboard@example.test' } },
  isPending: false,
});

const fetchMock = vi.fn<FetchCall>();

vi.mock('../../lib/auth-client', () => ({
  authClient: {
    useSession: () => auth.session,
    signOut: auth.signOut,
  },
}));

vi.stubGlobal('$fetch', fetchMock);

const RouterButton = {
  template: `
    <a v-if="to" :href="to"><slot>{{ label }}</slot></a>
    <button v-else type="button" :aria-label="ariaLabel" :disabled="disabled" @click="$emit('click')">
      <slot>{{ label }}</slot>
    </button>
  `,
  props: {
    ariaLabel: String,
    disabled: Boolean,
    label: String,
    to: String,
  },
  emits: ['click'],
};

const uiStubs = {
  UAlert: {
    template: '<div role="alert"><strong>{{ title }}</strong><span>{{ description }}</span></div>',
    props: ['title', 'description'],
  },
  FreshnessBanner: {
    template: '<span data-testid="freshness-label">{{ freshness.label }}</span>',
    props: ['freshness'],
  },
  FindingCard: {
    template: '<article />',
    props: ['finding'],
  },
  SemanticAmount: {
    template: '<span />',
    props: ['amount'],
  },
  ReasonCodeList: {
    template: '<ul />',
    props: ['codes'],
  },
  AnalysisTable: {
    template: '<table />',
    props: ['columns', 'rows'],
  },
  SavedViewPicker: {
    template: '<div />',
    props: ['views', 'showSave'],
    emits: ['select', 'save'],
  },
  InsufficientDataPanel: {
    template: '<section />',
    props: ['reason'],
  },
  UButton: RouterButton,
  UCard: {
    template:
      '<article><header><slot name="header" /></header><slot /><footer><slot name="footer" /></footer></article>',
  },
  UContainer: { template: '<main><slot /></main>' },
  UIcon: { template: '<span />' },
  NuxtLink: {
    template: '<a :href="to"><slot /></a>',
    props: ['to'],
  },
};

const attentionResult = {
  blockers: [
    {
      code: 'attention_restored',
      message: 'Attention restored',
      severity: 'warning',
      entityType: 'budget',
    },
  ],
  alerts: [],
  categoryRisks: [],
  recurrences: [],
  targetProgress: {
    overallLabel: 'healthy',
    healthyCount: 1,
    atRiskCount: 0,
    sinkingFundsOnTrack: 0,
    totalSinkingFunds: 0,
  },
};

type AttentionResponse = {
  status: string;
  result: typeof attentionResult;
  dataFreshness: { isStale: boolean; lastSync: string | null; label: string };
};

function attentionResponse(): AttentionResponse {
  return {
    status: 'ok',
    result: attentionResult,
    dataFreshness: { isStale: false, lastSync: '2026-08-01T00:00:00Z', label: 'current' },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

const mountedWrappers: Array<{ unmount: () => void }> = [];

function mountDashboard() {
  const wrapper = mount(IndexPage, {
    global: {
      components: { AnalysisPage },
      stubs: uiStubs,
    },
  });
  mountedWrappers.push(wrapper);
  return wrapper;
}

async function mountAfterAttentionLoad() {
  const wrapper = mountDashboard();
  await flushPromises();
  return wrapper;
}

describe('Dashboard recovery', () => {
  beforeEach(() => {
    auth.session.value = {
      data: { user: { email: 'dashboard@example.test' } },
      isPending: false,
    };
    fetchMock.mockReset();
  });

  afterEach(() => {
    mountedWrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  });

  it('renders structured not_connected errors with the connection recovery link', async () => {
    fetchMock.mockRejectedValue({
      data: {
        error: {
          code: 'not_connected',
          message: 'No ledger connected. Configure an Actual budget first.',
          retryable: true,
        },
      },
    });

    const wrapper = await mountAfterAttentionLoad();

    const alert = wrapper.get('[role="alert"]');
    expect(alert.text()).toContain('not_connected');
    expect(alert.text()).toContain('No ledger connected. Configure an Actual budget first.');
    expect(wrapper.get('a[href="/connection"]').text()).toContain('Configure Actual connection');
  });

  it('does not offer the connection recovery link for other structured errors', async () => {
    fetchMock.mockRejectedValue({
      data: {
        error: {
          code: 'STORE_UNAVAILABLE',
          message: 'The attention store is unavailable.',
          retryable: true,
        },
      },
    });

    const wrapper = await mountAfterAttentionLoad();

    expect(wrapper.get('[role="alert"]').text()).toContain('The attention store is unavailable.');
    expect(wrapper.find('a[href="/connection"]').exists()).toBe(false);
  });

  it('retries attention loading and replaces the error with attention content', async () => {
    fetchMock
      .mockRejectedValueOnce({
        data: {
          error: {
            code: 'not_connected',
            message: 'No ledger connected.',
            retryable: true,
          },
        },
      })
      .mockResolvedValueOnce(attentionResponse());

    const wrapper = await mountAfterAttentionLoad();
    await wrapper.get('button[aria-label="Retry loading"]').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/home/attention',
      expect.objectContaining({ query: expect.any(Object) }),
    );
    expect(wrapper.get('[aria-label="Blockers"]').text()).toContain('Attention restored');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('a[href="/connection"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="freshness-label"]').text()).toBe('current');
  });

  it('uses an Error cause message for unstructured attention failures', async () => {
    fetchMock.mockRejectedValue(new Error('Attention service refused the request'));

    const wrapper = await mountAfterAttentionLoad();

    expect(wrapper.get('[role="alert"]').text()).toContain('Attention service refused the request');
  });

  it('uses String(cause) for non-Error attention failures', async () => {
    const cause = { reason: 'connection reset' };
    fetchMock.mockRejectedValue(cause);

    const wrapper = await mountAfterAttentionLoad();

    expect(wrapper.get('[role="alert"]').text()).toContain(String(cause));
  });

  it('loads only auth config when unauthenticated', async () => {
    auth.session.value = { data: null, isPending: false };
    fetchMock.mockResolvedValue({
      result: {
        registrationMode: 'invite_only',
        bootstrapAvailable: false,
        invitationRequired: true,
      },
    });

    await mountAfterAttentionLoad();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/config');
  });

  it('waits for pending session hydration before loading authenticated attention', async () => {
    auth.session.value = { data: null, isPending: true };
    fetchMock.mockRejectedValue({
      data: {
        error: {
          code: 'not_connected',
          message: 'No ledger connected. Configure an Actual budget first.',
          retryable: true,
        },
      },
    });

    const wrapper = mountDashboard();
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();

    auth.session.value = {
      data: { user: { id: 'owner-1', email: 'owner@example.test' } },
      isPending: false,
    };
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/home/attention',
      expect.objectContaining({ query: expect.any(Object) }),
    );
    expect(wrapper.get('[role="alert"]').text()).toContain('not_connected');
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'No ledger connected. Configure an Actual budget first.',
    );
    expect(wrapper.get('a[href="/connection"]').text()).toContain('Configure Actual connection');
  });

  it('loads attention once across cached authenticated session startup hydration', async () => {
    auth.session.value = {
      data: { user: { id: 'owner-1', email: 'owner@example.test' } },
      isPending: false,
    };
    fetchMock.mockRejectedValue({
      data: {
        error: {
          code: 'not_connected',
          message: 'No ledger connected. Configure an Actual budget first.',
          retryable: true,
        },
      },
    });

    const wrapper = mountDashboard();
    await flushPromises();

    auth.session.value = {
      data: { user: { id: 'owner-1', email: 'owner@example.test' } },
      isPending: true,
    };
    await flushPromises();

    auth.session.value = {
      data: { user: { id: 'owner-1', email: 'owner@example.test' } },
      isPending: false,
    };
    await flushPromises();

    const attentionCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/home/attention');
    expect(attentionCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/home/attention',
      expect.objectContaining({ retry: 0 }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith('/api/auth/config');
    expect(wrapper.get('[role="alert"]').text()).toContain('not_connected');
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'No ledger connected. Configure an Actual budget first.',
    );
    expect(wrapper.get('a[href="/connection"]').text()).toContain('Configure Actual connection');
  });
  it('loads attention when an initially unauthenticated session hydrates to the authenticated owner', async () => {
    auth.session.value = { data: null, isPending: false };
    fetchMock.mockImplementation((url) => {
      if (url === '/api/auth/config') {
        return Promise.resolve({
          result: {
            registrationMode: 'invite_only',
            bootstrapAvailable: false,
            invitationRequired: true,
          },
        });
      }

      if (url === '/api/home/attention') {
        return Promise.reject({
          data: {
            error: {
              code: 'not_connected',
              message: 'No ledger connected. Configure an Actual budget first.',
              retryable: true,
            },
          },
        });
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    const wrapper = mountDashboard();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/auth/config');
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/home/attention',
      expect.objectContaining({ query: expect.any(Object) }),
    );

    auth.session.value = {
      data: { user: { id: 'owner-1', email: 'owner@example.test' } },
      isPending: false,
    };
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/home/attention',
      expect.objectContaining({ query: expect.any(Object) }),
    );
    expect(wrapper.get('[role="alert"]').text()).toContain('not_connected');
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'No ledger connected. Configure an Actual budget first.',
    );
    expect(wrapper.get('a[href="/connection"]').text()).toContain('Configure Actual connection');
  });

  it('keeps the authenticated dashboard loading until its attention request settles after anonymous config becomes stale', async () => {
    auth.session.value = { data: null, isPending: false };
    const configRequest = deferred<{
      result: {
        registrationMode: string;
        bootstrapAvailable: boolean;
        invitationRequired: boolean;
      };
    }>();
    const attentionRequest = deferred<AttentionResponse>();
    fetchMock.mockImplementation((url) => {
      if (url === '/api/auth/config') return configRequest.promise;
      if (url === '/api/home/attention') return attentionRequest.promise;
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    const wrapper = mountDashboard();
    await flushPromises();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/auth/config']);
    expect(wrapper.get('a[href="/login"]').text()).toContain('Sign in');

    auth.session.value = {
      data: { user: { id: 'owner-1', email: 'owner@example.test' } },
      isPending: false,
    };
    await flushPromises();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/auth/config',
      '/api/home/attention',
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/home/attention',
      expect.objectContaining({ query: expect.any(Object), retry: 0 }),
    );
    expect(wrapper.get('[role="status"][aria-label="Loading"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="direct-auth-fallback"]').text()).toContain(
      'owner@example.test',
    );

    configRequest.resolve({
      result: {
        registrationMode: 'open',
        bootstrapAvailable: true,
        invitationRequired: false,
      },
    });
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-label="Loading"]').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Blockers"]').exists()).toBe(false);
    expect(wrapper.find('a[href="/setup"]').exists()).toBe(false);
    expect(wrapper.find('a[href="/login"]').exists()).toBe(false);

    attentionRequest.reject({
      data: {
        error: {
          code: 'not_connected',
          message: 'Owner attention requires a connection.',
          retryable: true,
        },
      },
    });
    await flushPromises();

    expect(wrapper.find('[role="status"][aria-label="Loading"]').exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'Owner attention requires a connection.',
    );
    expect(wrapper.get('a[href="/connection"]').text()).toContain('Configure Actual connection');
    expect(wrapper.find('a[href="/setup"]').exists()).toBe(false);
  });

  it('ignores an older authenticated owner attention response while a newer owner load is pending', async () => {
    auth.session.value = {
      data: { user: { id: 'owner-1', email: 'owner-one@example.test' } },
      isPending: false,
    };
    const firstAttentionRequest = deferred<AttentionResponse>();
    const secondAttentionRequest = deferred<AttentionResponse>();
    fetchMock
      .mockImplementationOnce(() => firstAttentionRequest.promise)
      .mockImplementationOnce(() => secondAttentionRequest.promise);

    const wrapper = mountDashboard();
    await flushPromises();

    auth.session.value = {
      data: { user: { id: 'owner-2', email: 'owner-two@example.test' } },
      isPending: false,
    };
    await flushPromises();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/home/attention',
      '/api/home/attention',
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/home/attention',
      expect.objectContaining({ query: expect.any(Object), retry: 0 }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/home/attention',
      expect.objectContaining({ query: expect.any(Object), retry: 0 }),
    );
    expect(wrapper.get('[role="status"][aria-label="Loading"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="direct-auth-fallback"]').text()).toContain(
      'owner-two@example.test',
    );

    firstAttentionRequest.resolve({
      ...attentionResponse(),
      result: {
        ...attentionResult,
        blockers: [
          {
            ...attentionResult.blockers[0],
            code: 'old_owner_attention',
            message: 'Old owner attention',
          },
        ],
      },
    });
    await flushPromises();

    expect(wrapper.get('[role="status"][aria-label="Loading"]').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Blockers"]').exists()).toBe(false);

    secondAttentionRequest.resolve({
      ...attentionResponse(),
      result: {
        ...attentionResult,
        blockers: [
          {
            ...attentionResult.blockers[0],
            code: 'new_owner_attention',
            message: 'New owner attention',
          },
        ],
      },
    });
    await flushPromises();

    expect(wrapper.find('[role="status"][aria-label="Loading"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[aria-label="Blockers"]').text()).toContain('New owner attention');
    expect(wrapper.get('[data-testid="freshness-label"]').text()).toBe('current');
  });

  it('loads attention once when session hydration finishes before the mounted hook', async () => {
    auth.session.value = { data: null, isPending: false };
    fetchMock.mockImplementation((url) => {
      if (url === '/api/home/attention') {
        return Promise.reject({
          data: {
            error: {
              code: 'not_connected',
              message: 'No ledger connected. Configure an Actual budget first.',
              retryable: true,
            },
          },
        });
      }

      if (url === '/api/auth/config') {
        return Promise.resolve({
          result: {
            registrationMode: 'invite_only',
            bootstrapAvailable: false,
            invitationRequired: true,
          },
        });
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    let hydrated = false;
    const wrapper = mount(IndexPage, {
      global: {
        components: { AnalysisPage },
        stubs: {
          ...uiStubs,
          UContainer: {
            template: '<main><slot /></main>',
            setup() {
              if (!hydrated) {
                hydrated = true;
                auth.session.value = {
                  data: { user: { id: 'owner-1', email: 'owner@example.test' } },
                  isPending: false,
                };
              }
            },
          },
        },
      },
    });
    mountedWrappers.push(wrapper);
    await flushPromises();

    const attentionCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/home/attention');
    expect(attentionCalls).toHaveLength(1);
    expect(wrapper.get('[role="alert"]').text()).toContain('not_connected');
  });
});
