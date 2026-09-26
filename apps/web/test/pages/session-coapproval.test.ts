import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { PublicSessionCompletion } from '@balanceframe/application';
import SemanticAmount from '../../app/components/SemanticAmount.vue';
import SessionCoapprovalPage from '../../app/pages/spend-sessions/[id]/completions/[proposalId].vue';

const fetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
vi.stubGlobal('useRoute', () => ({
  params: { id: 'owner-session', proposalId: 'completion-1' },
}));

const money = (minorUnits: string, currency = 'USD') => ({ minorUnits, currency });
const debit = {
  accountId: 'checking',
  amount: -5500,
  date: '2026-09-06',
  payeeName: 'Fixture shop',
  notes: 'Order 1',
  categoryCharges: [
    { categoryId: 'food', amount: money('3500') },
    { categoryId: 'other', amount: money('2000') },
  ],
  splits: [
    { categoryId: 'food', amount: -3500 },
    { categoryId: 'other', amount: -2000 },
  ],
};

const completion = (overrides: Partial<PublicSessionCompletion> = {}): PublicSessionCompletion => ({
  id: 'completion-1',
  version: 1,
  phase: 'proposed',
  outcome: null,
  expiresAt: '2026-09-06T15:00:00.000Z',
  cooldownUntil: null,
  payloadHash: 'hash-1',
  requiredApprovals: 2,
  approvalCount: 1,
  canApprove: true,
  canExecute: false,
  debit,
  manualTransactionId: null,
  importedTransactionId: null,
  reviewRequired: false,
  ...overrides,
});

const envelope = <T>(result: T) => ({ status: 'ok', result });
const global = {
  components: { SemanticAmount },
  stubs: {
    AnalysisPage: {
      props: ['loading', 'error'],
      template: '<main><p v-if="error" role="alert">{{ error.message }}</p><template v-else><slot name="error-actions" /><slot name="content" /></template></main>',
    },
    NuxtLink: {
      props: ['to'],
      template: '<a :href="to"><slot /></a>',
    },
    UCard: { template: '<section><slot name="header" /><slot /></section>' },
    UButton: {
      props: ['disabled', 'variant'],
      template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
    },
  },
};

const wrappers: VueWrapper[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T10:01:00.000Z'));
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.useRealTimers();
});

function mountPage() {
  const wrapper = mount(SessionCoapprovalPage, { global });
  wrappers.push(wrapper);
  return wrapper;
}

describe('session completion coapproval page', () => {
  it('loads only the scoped public proposal, renders exact debit details, and approves after consent', async () => {
    const proposed = completion();
    const approved = completion({
      version: 2,
      phase: 'approved',
      approvalCount: 2,
      canApprove: false,
    });
    fetchMock.mockImplementation(async (_url: string, options?: { method?: string }) => {
      if (options?.method === 'POST') return envelope(approved);
      return envelope(proposed);
    });

    const wrapper = mountPage();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/spend-sessions/owner-session/completions/completion-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(wrapper.get('[data-testid="completion-debit-amount"]').text()).toContain('−55.00 USD');
    expect(wrapper.get('[data-testid="completion-debit-account"]').text()).toContain('checking');
    expect(wrapper.get('[data-testid="completion-date"]').text()).toContain('2026-09-06');
    expect(wrapper.text()).toContain('Fixture shop');
    expect(wrapper.text()).toContain('Order 1');
    expect(wrapper.get('[data-testid="completion-category-food"]').text()).toContain('35.00 USD');
    expect(wrapper.get('[data-testid="completion-split-food"]').text()).toContain('−35.00 USD');
    expect(wrapper.find('[data-testid="spend-session-editor"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="session-cart"]').exists()).toBe(false);

    expect(wrapper.get('[data-testid="completion-approve"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="completion-approve-confirmation"]').setValue(true);
    await wrapper.get('[data-testid="completion-approve"]').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/spend-sessions/owner-session/completions/completion-1/approve',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          payloadHash: 'hash-1',
          expectedVersion: 1,
          idempotencyKey: expect.any(String),
        }),
      }),
    );
    expect(wrapper.text()).toContain('Approved');
  });

  it('does not offer an approval mutation to a projection without approval authorization', async () => {
    const restricted = completion({ canApprove: false });
    fetchMock.mockResolvedValue(envelope(restricted));

    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.get('[data-testid="completion-approve"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="completion-approve-confirmation"]').attributes('disabled')).toBeDefined();
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('describes cooldown as temporal readiness rather than falsely denying the actor grant', async () => {
    fetchMock.mockResolvedValue(envelope(completion({
      cooldownUntil: '2026-09-06T10:02:00.000Z', canApprove: false,
    })));
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('Cooldown until 2026-09-06T10:02:00.000Z');
    expect(wrapper.text()).not.toContain('authorization does not allow');
    expect(wrapper.get('[data-testid="completion-approve"]').attributes('disabled')).toBeDefined();
  });

  it('keeps a redacted proposal detail projection from exposing debit or approval controls', async () => {
    fetchMock.mockResolvedValue(
      envelope(completion({ debit: null, payloadHash: null, canApprove: false })),
    );

    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('Restricted completion details');
    expect(wrapper.find('[data-testid="completion-debit"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="completion-approve"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Fixture shop');
    expect(wrapper.text()).not.toContain('Order 1');
  });
  it('shows a scoped authorization error without loading the private saved session', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('not authorized'), { status: 403 }));

    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toMatch(/permissions|authorized/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/spend-sessions/owner-session/completions/completion-1',
    );
    expect(wrapper.find('[data-testid="spend-session-editor"]').exists()).toBe(false);
  });
});
