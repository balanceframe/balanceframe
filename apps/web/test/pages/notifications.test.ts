/**
 * TDD: Notifications page fetches inbox, status, and policy. Renders inbox items
 * with delivery state, policy info, and acknowledge/suppress actions kept separate
 * from findings. Shows error/empty states.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

const mockFetch = vi.fn();
vi.stubGlobal('$fetch', mockFetch);

import NotificationsPage from '../../app/pages/notifications/index.vue';

const stubs = {
  AnalysisPage: {
    template:
      '<div><span v-if="error" data-testid="error">{{ error.code }}</span><slot v-else name="content" /></div>',
    props: ['title', 'loading', 'error'],
  },
  UCard: { template: '<div><slot name="header" /><slot /></div>' },
  UAlert: {
    template: '<div data-testid="alert">{{ title }}: {{ description }}</div>',
    props: ['title', 'description', 'color', 'variant'],
  },
  UButton: {
    template: '<button @click="$emit(\'click\')"><slot /></button>',
    props: ['size', 'variant', 'color'],
  },
  UFormGroup: { template: '<div><slot /></div>', props: ['label'] },
  UInput: { template: '<input />', props: ['modelValue', 'placeholder'] },
};

function okEnvelope(result: unknown) {
  return {
    schemaVersion: '1',
    requestId: 'req-test',
    status: 'ok' as const,
    dataFreshness: null,
    authorization: null,
    result,
    error: null,
  };
}

const statusResult = {
  healthy: true,
  storeConnected: true,
  pendingCount: 3,
  deliveredCount: 12,
  failedCount: 1,
  channelStatuses: [{ channel: 'in_app', healthy: true }],
};

const inboxResult = {
  items: [
    {
      outbox: {
        id: 'out-1',
        channelType: 'in_app',
        status: 'delivered',
        attemptCount: 1,
        maxAttempts: 3,
        acknowledgedAt: null,
        suppressedAt: null,
      },
      event: { classification: 'budget_alert', createdAt: '2026-01-15T10:00:00Z' },
      redactedPayload: { title: 'Budget Alert', summary: 'Groceries exceeded.' },
      deliveryAttempts: [
        { id: 'da-1', success: true, deliveredAt: '2026-01-15T10:00:01Z', failureReason: null },
      ],
    },
  ],
  count: 1,
};

const policyResult = { policyVersion: 'v1', maxRetries: 3, defaultRedactionClass: 'public' };

describe('Notifications page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('calls notification APIs on mount', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/notifications/status')) return Promise.resolve(okEnvelope(statusResult));
      if (url.includes('/notifications/inbox')) return Promise.resolve(okEnvelope(inboxResult));
      if (url.includes('/notifications/policy')) return Promise.resolve(okEnvelope(policyResult));
      return Promise.resolve(okEnvelope({}));
    });
    shallowMount(NotificationsPage, { global: { stubs } });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('/api/notifications/status');
    expect(mockFetch).toHaveBeenCalledWith('/api/notifications/inbox');
  });

  it('renders runtime status counts', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/notifications/status')) return Promise.resolve(okEnvelope(statusResult));
      if (url.includes('/notifications/inbox')) return Promise.resolve(okEnvelope(inboxResult));
      if (url.includes('/notifications/policy')) return Promise.resolve(okEnvelope(policyResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(NotificationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('3');
    expect(wrapper.text()).toContain('12');
  });

  it('renders inbox notification titles', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/notifications/status')) return Promise.resolve(okEnvelope(statusResult));
      if (url.includes('/notifications/inbox')) return Promise.resolve(okEnvelope(inboxResult));
      if (url.includes('/notifications/policy')) return Promise.resolve(okEnvelope(policyResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(NotificationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Budget Alert');
  });

  it('shows delivery state separated from finding state', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/notifications/status')) return Promise.resolve(okEnvelope(statusResult));
      if (url.includes('/notifications/inbox')) return Promise.resolve(okEnvelope(inboxResult));
      if (url.includes('/notifications/policy')) return Promise.resolve(okEnvelope(policyResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(NotificationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Delivery state is tracked separately');
  });

  it('renders delivery history', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/notifications/status')) return Promise.resolve(okEnvelope(statusResult));
      if (url.includes('/notifications/inbox')) return Promise.resolve(okEnvelope(inboxResult));
      if (url.includes('/notifications/policy')) return Promise.resolve(okEnvelope(policyResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(NotificationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('Delivery History');
  });

  it('renders policy info', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/notifications/status')) return Promise.resolve(okEnvelope(statusResult));
      if (url.includes('/notifications/inbox')) return Promise.resolve(okEnvelope(inboxResult));
      if (url.includes('/notifications/policy')) return Promise.resolve(okEnvelope(policyResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(NotificationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('v1');
    expect(wrapper.text()).toContain('public');
  });

  it('shows error on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    const wrapper = shallowMount(NotificationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.find('[data-testid="error"]').text()).toContain('FETCH_ERROR');
  });

  it('shows empty state when no inbox items', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/notifications/status')) return Promise.resolve(okEnvelope(statusResult));
      if (url.includes('/notifications/inbox'))
        return Promise.resolve(okEnvelope({ items: [], count: 0 }));
      if (url.includes('/notifications/policy')) return Promise.resolve(okEnvelope(policyResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(NotificationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('No notifications in inbox');
  });

  it('acknowledge/suppress text notes independence from findings', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/notifications/status')) return Promise.resolve(okEnvelope(statusResult));
      if (url.includes('/notifications/inbox')) return Promise.resolve(okEnvelope(inboxResult));
      if (url.includes('/notifications/policy')) return Promise.resolve(okEnvelope(policyResult));
      return Promise.resolve(okEnvelope({}));
    });
    const wrapper = shallowMount(NotificationsPage, { global: { stubs } });
    await flushPromises();
    expect(wrapper.text()).toContain('does not affect');
  });
});
