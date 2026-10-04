import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { PublicSessionCompletion, PublicSpendSession } from '@balanceframe/application';
import SessionCompletionPanel from '../../app/components/SessionCompletionPanel.vue';
import SemanticAmount from '../../app/components/SemanticAmount.vue';

const money = (minorUnits: string, currency = 'USD') => ({ minorUnits, currency });
const fetchMock = vi.fn();
const reauthFetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
vi.stubGlobal('fetch', reauthFetchMock);
const reauthSuccess = () => Promise.resolve({
  ok: true, status: 200, json: async () => ({ status: 'success' }),
});
const reauthFailure = () => Promise.resolve({
  ok: false, status: 401,
  json: async () => ({ status: 'error', error: { code: 'REAUTHENTICATION_FAILED', message: 'Password confirmation failed.' } }),
});
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
  reauthFetchMock.mockReset();
  reauthFetchMock.mockImplementation(reauthSuccess);
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
    expect(wrapper.text()).toContain('hash-1');
    expect(wrapper.text()).toContain('Proposal expires 2026-09-06T15:00:00.000Z');
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
    await wrapper.get('input[type="password"]').setValue('current-password');
    await wrapper.get('[data-testid="completion-approve"]').trigger('click');
    await flushPromises();
    expect(reauthFetchMock).toHaveBeenCalledWith(
      '/api/reauth',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ password: 'current-password' }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/spend-sessions/fixture-session/completions/completion-1/approve',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ payloadHash: 'hash-1', expectedVersion: 1 }),
      }),
    );
    const approvalBody = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/approve'))?.[1]?.body;
    expect(approvalBody).not.toHaveProperty('actorId');
    expect(approvalBody).not.toHaveProperty('reauthenticatedAt');
    expect(approvalBody).not.toHaveProperty('password');
    expect(wrapper.get('input[type="password"]').element).toHaveProperty('value', '');
    expect(
      fetchMock.mock.calls.filter(
        ([url, options]) => options?.method === 'POST' && String(url).endsWith('/execute'),
      ),
    ).toHaveLength(0);

    await wrapper.get('[data-testid="completion-execute-confirmation"]').setValue(true);
    await wrapper.get('input[type="password"]').setValue('current-password');
    await wrapper.get('[data-testid="completion-execute"]').trigger('click');
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/spend-sessions/fixture-session/completions/completion-1/execute',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ payloadHash: 'hash-1', expectedVersion: 2 }),
      }),
    );
    expect(reauthFetchMock).toHaveBeenCalledTimes(2);
    expect(wrapper.get('input[type="password"]').element).toHaveProperty('value', '');
    expect(wrapper.text()).toContain('Human review required');
    expect(wrapper.text()).not.toContain('Verified manual transaction');
  });


  it('blocks approval after failed password confirmation and clears the password', async () => {
    const proposal = completion({ cooldownUntil: null, canApprove: true });
    fetchMock.mockResolvedValue(envelope([proposal]));
    reauthFetchMock.mockImplementationOnce(reauthFailure);
    const wrapper = mount(SessionCompletionPanel, { props: { session: sessionFixture() }, global });
    await flushPromises();

    await wrapper.get('[data-testid="completion-approve-confirmation"]').setValue(true);
    await wrapper.get('input[type="password"]').setValue('wrong-password');
    await wrapper.get('[data-testid="completion-approve"]').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/spend-sessions/fixture-session/completions');
    expect(wrapper.text()).toContain('REAUTHENTICATION_FAILED');
    expect(wrapper.text()).toContain('hash-1');
    expect(wrapper.get('input[type="password"]').element).toHaveProperty('value', '');
  });

  it('keeps the old completion snapshot after a stale approval until explicit refresh', async () => {
    const capturedMetadata = {
      requesterActorId: 'original-requester',
      requesterMembershipId: 'original-membership',
      governancePolicyVersion: 'captured-governance-policy',
      financialPolicyVersion: 'captured-financial-policy',
      approvers: [{
        actorId: 'old-eligible-human',
        issuedAt: '2026-09-06T09:00:00Z',
        expiresAt: '2026-09-06T11:00:00Z',
      }],
    };
    const proposal = completion({
      cooldownUntil: null, canApprove: true, approvalMetadata: capturedMetadata,
    });
    const fresh = completion({
      version: 2,
      payloadHash: 'fresh-hash',
      cooldownUntil: null,
      approvalMetadata: {
        ...capturedMetadata,
        approvers: [{
          actorId: 'new-eligible-human',
          issuedAt: '2026-09-06T10:00:00Z',
          expiresAt: '2026-09-06T12:00:00Z',
        }],
      },
    });
    fetchMock
      .mockResolvedValueOnce(envelope([proposal]))
      .mockRejectedValueOnce({
        statusCode: 409,
        data: { error: { message: 'stale payload hash' } },
      })
      .mockResolvedValueOnce(envelope([fresh]));
    const wrapper = mount(SessionCompletionPanel, { props: { session: sessionFixture() }, global });
    await flushPromises();

    await wrapper.get('[data-testid="completion-approve-confirmation"]').setValue(true);
    await wrapper.get('input[type="password"]').setValue('current-password');
    await wrapper.get('[data-testid="completion-approve"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="approval-requester-actor"]').text()).toContain('original-requester');
    expect(wrapper.get('[data-testid="approval-requester-membership"]').text()).toContain('original-membership');
    expect(wrapper.get('[data-testid="approval-governance-policy"]').text()).toContain('captured-governance-policy');
    expect(wrapper.get('[data-testid="approval-financial-policy"]').text()).toContain('captured-financial-policy');
    const currentApprovers = wrapper
      .findAll('[data-testid="approval-current-approver"]')
      .map((item) => item.text())
      .join(' ');
    expect(currentApprovers).toContain('old-eligible-human');
    expect(currentApprovers).toContain('2026-09-06T09:00:00Z');
    expect(currentApprovers).toContain('2026-09-06T11:00:00Z');
    expect(wrapper.text()).not.toContain('new-eligible-human');

    expect(wrapper.text()).toContain('hash-1');
    expect(wrapper.text()).toContain('Fixture shop');
    expect(wrapper.text()).toMatch(/plan or version changed/i);
    expect(wrapper.text()).not.toContain('fresh-hash');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await wrapper.get('[data-testid="completion-refresh"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('fresh-hash');
    expect(wrapper.text()).not.toContain('hash-1');
    expect(wrapper.get('[data-testid="approval-requester-actor"]').text()).toContain('original-requester');
    expect(wrapper.get('[data-testid="approval-requester-membership"]').text()).toContain('original-membership');
    expect(wrapper.get('[data-testid="approval-governance-policy"]').text()).toContain('captured-governance-policy');
    expect(wrapper.get('[data-testid="approval-financial-policy"]').text()).toContain('captured-financial-policy');
    const refreshedApprovers = wrapper
      .findAll('[data-testid="approval-current-approver"]')
      .map((item) => item.text())
      .join(' ');
    expect(refreshedApprovers).toContain('new-eligible-human');
    expect(refreshedApprovers).not.toContain('old-eligible-human');
    expect(refreshedApprovers).toContain('2026-09-06T10:00:00Z');
    expect(refreshedApprovers).toContain('2026-09-06T12:00:00Z');
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
      approvalMetadata: {
        requesterActorId: 'hidden-requester',
        requesterMembershipId: 'hidden-membership',
        governancePolicyVersion: 'hidden-governance-policy',
        financialPolicyVersion: 'hidden-financial-policy',
        approvers: [{
          actorId: 'hidden-current-approver',
          issuedAt: '2026-09-06T09:00:00Z',
          expiresAt: '2026-09-06T11:00:00Z',
        }],
      },
    });
    fetchMock.mockResolvedValue(envelope([redacted]));
    const wrapper = mount(SessionCompletionPanel, {
      props: { session: sessionFixture(), saving: true },
      global,
    });
    await flushPromises();

    expect(wrapper.text()).toContain('Restricted completion details');
    expect(wrapper.find('[data-testid="approval-metadata"]').exists()).toBe(false);
    expect(wrapper.text()).not.toMatch(
      /hidden-requester|hidden-membership|hidden-governance-policy|hidden-financial-policy|hidden-current-approver/,
    );
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
    await wrapper.get('input[type="password"]').setValue('current-password');
    await wrapper.get('[data-testid="completion-reconcile"]').trigger('click');
    await flushPromises();
    expect(reauthFetchMock).toHaveBeenCalledWith(
      '/api/reauth',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ password: 'current-password' }),
      }),
    );
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
