import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { PublicSessionCompletion } from '@balanceframe/application';
import SemanticAmount from '../../app/components/SemanticAmount.vue';
import SessionCoapprovalPage from '../../app/pages/spend-sessions/[id]/completions/[proposalId].vue';

const fetchMock = vi.fn();
const reauthFetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);
vi.stubGlobal('fetch', reauthFetchMock);
vi.stubGlobal('useRoute', () => ({
  params: { id: 'owner-session', proposalId: 'completion-1' },
}));
const reauthSuccess = () => Promise.resolve({
  ok: true, status: 200, json: async () => ({ status: 'success' }),
});
const reauthFailure = () => Promise.resolve({
  ok: false, status: 401,
  json: async () => ({ status: 'error', error: { code: 'REAUTHENTICATION_FAILED', message: 'Password confirmation failed.' } }),
});

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
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: false } }));
  fetchMock.mockReset();
  reauthFetchMock.mockReset();
  reauthFetchMock.mockImplementation(reauthSuccess);
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
    expect(wrapper.text()).toContain('hash-1');
    expect(wrapper.text()).toContain('Proposal expires 2026-09-06T15:00:00.000Z');
    expect(wrapper.get('[data-testid="completion-category-food"]').text()).toContain('35.00 USD');
    expect(wrapper.get('[data-testid="completion-split-food"]').text()).toContain('−35.00 USD');
    expect(wrapper.find('[data-testid="spend-session-editor"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="session-cart"]').exists()).toBe(false);

    expect(wrapper.get('[data-testid="completion-approve"]').attributes('disabled')).toBeDefined();
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
    const approvalBody = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/approve'))?.[1]?.body;
    expect(approvalBody).not.toHaveProperty('actorId');
    expect(approvalBody).not.toHaveProperty('reauthenticatedAt');
    expect(approvalBody).not.toHaveProperty('password');
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Approved');
  });

  it('blocks approval after failed password confirmation', async () => {
    fetchMock.mockResolvedValue(envelope(completion()));
    reauthFetchMock.mockImplementationOnce(reauthFailure);
    const wrapper = mountPage();
    await flushPromises();
    await wrapper.get('[data-testid="completion-approve-confirmation"]').setValue(true);
    await wrapper.get('input[type="password"]').setValue('wrong-password');
    await wrapper.get('[data-testid="completion-approve"]').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/spend-sessions/owner-session/completions/completion-1');
    expect(wrapper.text()).toContain('REAUTHENTICATION_FAILED');
    expect(wrapper.text()).toContain('hash-1');
    expect(wrapper.get('input[type="password"]').element).toHaveProperty('value', '');
  });

  it('does not forward financial approval when explicit disposable-demo renewal fails', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: true } }));
    fetchMock.mockResolvedValue(envelope(completion()));
    reauthFetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ status: 'ready', shared: true, generation: 7, personaId: 'coapprover', csrfToken: 'demo-csrf' }),
    });
    reauthFetchMock.mockResolvedValueOnce({
      ok: false, status: 409,
      json: async () => ({ error: { code: 'DEMO_STALE_GENERATION' } }),
    });
    const wrapper = mountPage();
    await flushPromises();
    await wrapper.get('[data-testid="completion-approve-confirmation"]').setValue(true);
    expect(wrapper.text()).toContain('Disposable-demo confirmation');
    await wrapper.get('input[type="password"]').setValue('CONFIRM');
    await wrapper.get('[data-testid="completion-approve"]').trigger('click');
    await flushPromises();
    expect(reauthFetchMock.mock.calls.map(([path]) => path)).toEqual(['/__demo/state', '/__demo/reauth']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('DEMO_STALE_GENERATION');
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
    const original = completion({ approvalMetadata: capturedMetadata });
    const fresh = completion({
      version: 2,
      payloadHash: 'fresh-hash',
      approvalMetadata: {
        ...capturedMetadata,
        approvers: [{
          actorId: 'new-eligible-human',
          issuedAt: '2026-09-06T10:00:00Z',
          expiresAt: '2026-09-06T12:00:00Z',
        }],
      },
    });
    const path = '/api/spend-sessions/owner-session/completions/completion-1';
    let reads = 0;
    fetchMock.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (url === `${path}/approve` && options?.method === 'POST')
        throw { statusCode: 409, data: { error: { message: 'stale payload hash' } } };
      if (url === path && options?.method === 'GET') {
        reads += 1;
        return envelope(reads === 1 ? original : fresh);
      }
      throw new Error(`Unexpected completion request: ${options?.method} ${url}`);
    });
    const wrapper = mountPage();
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

  it('labels nullable legacy membership and governance policy without a current-value fallback', async () => {
    fetchMock.mockResolvedValue(envelope(completion({
      approvalMetadata: {
        requesterActorId: 'legacy-requester',
        requesterMembershipId: null,
        governancePolicyVersion: null,
        financialPolicyVersion: 'legacy-financial-policy',
        approvers: [],
      },
    })));
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.get('[data-testid="approval-requester-membership"]').text()).toBe('Unavailable');
    expect(wrapper.get('[data-testid="approval-governance-policy"]').text()).toBe('Unavailable');
    expect(wrapper.get('[data-testid="approval-financial-policy"]').text()).toBe('legacy-financial-policy');
  });

  it('keeps a redacted proposal projection from exposing approval metadata', async () => {
    fetchMock.mockResolvedValue(envelope(completion({
      debit: null,
      payloadHash: null,
      canApprove: false,
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
    })));

    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('Restricted completion details');
    expect(wrapper.find('[data-testid="completion-debit"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="completion-approve"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Fixture shop');
    expect(wrapper.text()).not.toContain('hash-1');
    expect(wrapper.text()).not.toContain('Order 1');
    expect(wrapper.find('[data-testid="approval-metadata"]').exists()).toBe(false);
    expect(wrapper.text()).not.toMatch(
      /hidden-requester|hidden-membership|hidden-governance-policy|hidden-financial-policy|hidden-current-approver/,
    );
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
