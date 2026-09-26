import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { PublicSessionCompletion, PublicSpendSession } from '@balanceframe/application';
import SessionCompletionPanel from '../../app/components/SessionCompletionPanel.vue';
import SemanticAmount from '../../app/components/SemanticAmount.vue';

const money = (minorUnits: string, currency = 'USD') => ({ minorUnits, currency });
const fetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);

const sessionFixture = (): PublicSpendSession => ({
  id: 'fixture-session',
  version: 3,
  accountId: 'checking',
  createdAt: '2026-09-06T10:00:00.000Z',
  expiresAt: '2026-09-06T15:00:00.000Z',
  items: [
    {
      id: 'item-1',
      categoryId: 'food',
      accountId: 'checking',
      amount: money('3500'),
      quantity: 1,
      priority: 'required',
      purchaseAt: '2026-09-06T10:00:00.000Z',
      requiredBy: '2026-09-06T10:00:00.000Z',
    },
  ],
  adjustments: [],
  warningThresholds: [],
  card: {
    outcome: 'funded_now',
    budgetFundingStatus: 'funded',
    paymentLiquidityStatus: 'ready',
    selectedAccountId: 'checking',
    before: null,
    after: null,
    fundingPaths: [],
    evidence: [],
    blockers: [],
    cart: {
      subtotal: money('5500'),
      tax: money('0'),
      fee: money('0'),
      discount: money('0'),
      total: money('5500'),
      categoryCharges: [
        { categoryId: 'food', amount: money('3500') },
        { categoryId: 'other', amount: money('2000') },
      ],
      accountCharges: [{ accountId: 'checking', amount: money('5500') }],
    },
    warnings: [],
    trimAlternatives: [],
  },
  canEdit: true,
  linkedTransfers: [],
});

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

const completion = (
  overrides: Partial<PublicSessionCompletion> = {},
): PublicSessionCompletion => ({
  id: 'completion-1',
  version: 1,
  phase: 'proposed',
  outcome: null,
  expiresAt: '2026-09-06T15:00:00.000Z',
  cooldownUntil: '2026-09-06T10:02:00.000Z',
  payloadHash: 'hash-1',
  requiredApprovals: 1,
  approvalCount: 0,
  canApprove: false,
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
    NuxtLink: {
      props: ['to'],
      template: '<a :href="to" v-bind="$attrs"><slot /></a>',
    },
    UCard: { template: '<section><slot name="header" /><slot /></section>' },
    UButton: {
      props: ['disabled', 'variant', 'color'],
      template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
    },
  },
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T10:01:00.000Z'));
});

afterEach(() => vi.useRealTimers());

describe('SessionCompletionPanel', () => {
  it('reviews the exact fixture debit, keeps cooldown approval disabled until refreshed, and executes only after separate confirmation', async () => {
    const proposed = completion();
    const ready = completion({ cooldownUntil: null, canApprove: true });
    const approved = completion({
      version: 2,
      cooldownUntil: null,
      phase: 'approved',
      approvalCount: 1,
      canApprove: false,
      canExecute: true,
    });
    const uncertain = completion({
      version: 3,
      phase: 'review_required',
      outcome: 'write_uncertain',
      canApprove: false,
      canExecute: false,
      reviewRequired: true,
    });
    const lists: PublicSessionCompletion[][] = [[], [proposed], [proposed], [ready], [approved], [uncertain]];
    fetchMock.mockImplementation(async (url: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === 'POST' && url === '/api/spend-sessions/fixture-session/completions')
        return envelope(proposed);
      if (options?.method === 'POST' && url.endsWith('/approve')) return envelope(approved);
      if (options?.method === 'POST' && url.endsWith('/execute')) return envelope(uncertain);
      if (!options?.method || options.method === 'GET') return envelope(lists.shift() ?? [uncertain]);
      throw new Error(`Unexpected request ${options?.method ?? 'GET'} ${url}`);
    });

    const wrapper = mount(SessionCompletionPanel, {
      props: { session: sessionFixture() },
      global,
    });
    await flushPromises();

    await wrapper.get('[data-testid="completion-payee"]').setValue('Fixture shop');
    await wrapper.get('[data-testid="completion-notes"]').setValue('Order 1');
    await wrapper.get('[data-testid="completion-propose"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="completion-debit-amount"]').text()).toContain('−55.00 USD');
    expect(wrapper.get('[data-testid="completion-debit-account"]').text()).toContain('checking');
    expect(wrapper.get('[data-testid="completion-category-food"]').text()).toContain('35.00 USD');
    expect(wrapper.get('[data-testid="completion-category-other"]').text()).toContain('20.00 USD');
    expect(wrapper.get('[data-testid="completion-split-food"]').text()).toContain('−35.00 USD');
    expect(wrapper.get('[data-testid="completion-date"]').text()).toContain('2026-09-06');
    expect(wrapper.get('[data-testid="completion-coapproval-link-completion-1"]').attributes('href')).toBe(
      '/spend-sessions/fixture-session/completions/completion-1',
    );
    expect(wrapper.text()).toContain('Fixture shop');
    expect(wrapper.text()).toContain('Order 1');
    expect(wrapper.text()).toContain('Cooldown until');

    const approve = wrapper.get('[data-testid="completion-approve"]');
    expect(approve.attributes('disabled')).toBeDefined();
    const approveRequestsBeforeRefresh = fetchMock.mock.calls.filter(
      ([url, options]) => options?.method === 'POST' && String(url).endsWith('/approve'),
    ).length;
    await approve.trigger('click');
    expect(
      fetchMock.mock.calls.filter(
        ([url, options]) => options?.method === 'POST' && String(url).endsWith('/approve'),
      ),
    ).toHaveLength(approveRequestsBeforeRefresh);

    await wrapper.get('[data-testid="completion-refresh"]').trigger('click');
    await flushPromises();
    vi.setSystemTime(new Date('2026-09-06T10:02:00.000Z'));
    await wrapper.get('[data-testid="completion-refresh"]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="completion-approve-confirmation"]').setValue(true);
    await wrapper.get('[data-testid="completion-approve"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/spend-sessions/fixture-session/completions/completion-1/approve',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ payloadHash: 'hash-1', expectedVersion: 1 }),
      }),
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url, options]) => options?.method === 'POST' && String(url).endsWith('/execute'),
      ),
    ).toHaveLength(0);

    await wrapper.get('[data-testid="completion-execute-confirmation"]').setValue(true);
    await wrapper.get('[data-testid="completion-execute"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/spend-sessions/fixture-session/completions/completion-1/execute',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ payloadHash: 'hash-1', expectedVersion: 2 }),
      }),
    );
    expect(wrapper.text()).toContain('Human review required');
    expect(wrapper.text()).not.toContain('Verified manual transaction');
  });

  it('never offers a completion proposal when the current Card has a material blocker', async () => {
    const session = sessionFixture();
    session.card = {
      ...session.card,
      outcome: 'insufficient_data',
      blockers: ['incomplete_accounts_coverage'],
    };
    fetchMock.mockResolvedValue(envelope([]));
    const wrapper = mount(SessionCompletionPanel, { props: { session }, global });
    await flushPromises();
    expect(wrapper.get('[data-testid="completion-propose"]').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('current Card is not funded now');
    await wrapper.get('[data-testid="completion-propose"]').trigger('click');
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });

  it('does not expose actions for a redacted debit and disables actions while the saved session changes or is saving', async () => {
    const redacted = completion({
      payloadHash: null,
      debit: null,
      canApprove: true,
      canExecute: true,
    });
    fetchMock.mockResolvedValue(envelope([redacted]));
    const wrapper = mount(SessionCompletionPanel, {
      props: { session: sessionFixture(), saving: true },
      global,
    });
    await flushPromises();

    expect(wrapper.text()).toContain('Restricted completion details');
    expect(wrapper.find('[data-testid="completion-approve"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="completion-execute"]').exists()).toBe(false);

    await wrapper.setProps({ saving: false, session: { ...sessionFixture(), version: 4 } });
    expect(wrapper.text()).toContain('Session changed');
    expect(wrapper.find('[data-testid="completion-approve"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="completion-execute"]').exists()).toBe(false);
  });
  it('checks Actual for a later import without letting the browser nominate bank evidence or retry a write', async () => {
    const manual = completion({
      phase: 'verified', version: 4, cooldownUntil: null,
      manualTransactionId: 'actual-parent', canApprove: false, canExecute: false,
    });
    const linked = completion({
      ...manual, version: 5, importedTransactionId: 'actual-parent',
    });
    let refreshed = false;
    fetchMock.mockImplementation(async (url: string, options?: { method?: string; body?: unknown }) => {
      if (options?.method === 'POST' && url.endsWith('/reconcile')) {
        refreshed = true;
        return envelope(linked);
      }
      return envelope([refreshed ? linked : manual]);
    });
    const wrapper = mount(SessionCompletionPanel, {
      props: { session: sessionFixture() }, global,
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Verified manual transaction');
    await wrapper.get('[data-testid="completion-reconcile"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/spend-sessions/fixture-session/completions/completion-1/reconcile',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ payloadHash: 'hash-1', expectedVersion: 4 }),
      }),
    );
    const payload = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/reconcile'))?.[1]?.body;
    expect(payload).not.toHaveProperty('importedId');
    expect(payload).not.toHaveProperty('evidence');
    expect(wrapper.text()).toContain('Import-linked transaction');
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/execute'))).toBe(false);
  });
});
