import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import type { Ref } from 'vue';
import ProposedRulesModal from '../app/components/ProposedRulesModal.vue';
import type { PendingProposalApproval } from '../types/review-client';
import type { ProposalApprovalView } from '../server/utils/proposal-approval-view';

const auth = vi.hoisted(() => ({
  session: undefined as unknown as Ref<{ data: { user: { id: string; email: string } } | null }>,
}));
vi.mock('../lib/auth-client', () => ({
  authClient: { useSession: () => auth.session },
}));
auth.session = ref({ data: { user: { id: 'owner-001', email: 'owner@example.test' } } });

const proposal: ProposalApprovalView = {
  id: 'proposal-001',
  operation: 'create_rule',
  spaceId: 'space-001',
  budgetId: 'budget-001',
  requesterActorId: 'requester-001',
  requesterMembershipId: 'membership-001',
  governancePolicyVersion: 'governance-4',
  currentGovernancePolicyVersion: 'governance-4',
  requesterMembershipCurrent: true,
  policyVersion: 'financial-7',
  payloadHash: 'a'.repeat(64),
  privateEnvelopeVisible: true,
  payload: {
    kind: 'create_rule',
    transactionId: null,
    categoryId: 'cat-groceries',
    rule: { name: 'Market', conditions: [{ field: 'payee', operation: 'contains', value: 'Market' }] },
  },
  preconditions: { source: 'review', normalizedRule: { merchant: 'Market' }, transactionVersion: 3 },
  expiresAt: '2026-10-03T12:00:00.000Z',
  requiredApprovers: 2,
  approvers: [
    { actorId: 'reviewer-002', issuedAt: '2026-10-02T11:00:00.000Z', expiresAt: '2026-10-03T12:00:00.000Z' },
  ],
  disposition: 'approval_required',
  canApprove: true,
  canExecute: true,
};

const listItem = {
  id: proposal.id,
  operation: proposal.operation,
  budgetId: proposal.budgetId,
  transactionId: 'transaction-001',
  categoryId: 'cat-groceries',
  preconditions: JSON.stringify(proposal.preconditions),
  expiresAt: proposal.expiresAt,
  actorId: proposal.requesterActorId,
  provenance: 'review',
  providerModel: null,
  correlationId: null,
  createdAt: '2026-10-02T10:00:00.000Z',
  simulationStatus: 'missing' as const,
};

const fetchMock = vi.fn<typeof fetch>();
const wrappers: VueWrapper[] = [];

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function envelope(result: unknown) {
  return { status: 'ok', result, error: null };
}

function detail(view = proposal) {
  return envelope({ proposal: view, simulation: null, stale: false, simulationStatus: 'missing' });
}

function mountModal(proposalApprovalViews: readonly PendingProposalApproval[] = []) {
  const wrapper = mount(ProposedRulesModal, {
    props: { open: true, proposals: [listItem], proposalApprovalViews },
    global: {
      stubs: {
        UModal: {
          props: ['open'],
          template: '<div v-if="open" role="dialog"><slot name="content" /></div>',
        },
        UCard: { template: '<section><slot name="header" /><slot /><slot name="footer" /></section>' },
        UBadge: { props: ['label'], template: '<span>{{ label }}</span>' },
        UButton: {
          props: ['label', 'disabled'],
          emits: ['click'],
          template: '<button type="button" :disabled="disabled" @click="$emit(\'click\')"><slot />{{ label }}</button>',
        },
      },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}


function button(wrapper: VueWrapper, label: string) {
  const control = wrapper.findAll('button').find((candidate) => candidate.text() === label);
  if (!control) throw new Error(`Missing button: ${label}`);
  return control;
}

function route(input: Parameters<typeof fetch>[0]) {
  return typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  fetchMock.mockClear();
  auth.session.value = { data: { user: { id: 'owner-001', email: 'owner@example.test' } } };
  vi.unstubAllGlobals();
});

describe('private proposal lifetime', () => {
  it.each(['HTTP denial', 'error envelope', 'malformed response', 'transport failure'])(
    'removes a previously authorized exact payload and actions after %s, including prop-backed snapshots',
    async (failure) => {
      fetchMock.mockResolvedValueOnce(response(detail()));
      vi.stubGlobal('fetch', fetchMock);
      const wrapper = mountModal([{ reviewId: 'review-001', proposal }]);
      await button(wrapper, 'Refresh proposal view').trigger('click');
      await flushPromises();
      expect(wrapper.text()).toContain(proposal.payloadHash);
      expect(wrapper.text()).toContain('"normalizedRule"');
      expect(button(wrapper, 'Execute exact rule proposal').attributes('disabled')).toBeUndefined();
      await wrapper.get('input[type="password"]').setValue('private-password');

      if (failure === 'transport failure') fetchMock.mockRejectedValueOnce(new Error('Offline'));
      else if (failure === 'malformed response') fetchMock.mockResolvedValueOnce(response(null));
      else fetchMock.mockResolvedValueOnce(response({
        status: 'error', result: null,
        error: { code: 'DENIED', message: 'Private proposal denied' },
      }, failure === 'HTTP denial' ? 403 : 200));
      await button(wrapper, 'Refresh proposal view').trigger('click');
      await flushPromises();

      expect(wrapper.find('[role="alert"]').exists()).toBe(true);
      expect(wrapper.text()).not.toContain(proposal.payloadHash);
      expect(wrapper.text()).not.toContain('"normalizedRule"');
      expect(wrapper.findAll('button').some((control) => control.text().includes('Execute exact'))).toBe(false);
      expect(wrapper.findAll('button').some((control) => control.text().includes('approve exact proposal'))).toBe(false);
      expect(wrapper.find('input[type="password"]').element).not.toHaveProperty('value', 'private-password');
      await wrapper.setProps({ open: false });
      await wrapper.setProps({ open: true });
      await flushPromises();
      expect(wrapper.text()).not.toContain(proposal.payloadHash);
      expect(wrapper.text()).not.toContain('"normalizedRule"');
    },
  );

  it('clears fetched detail on close and ignores an old successful completion after reopening', async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    fetchMock.mockResolvedValueOnce(response(detail())).mockReturnValueOnce(promise);
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal();
    await button(wrapper, 'Review exact proposal').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain(proposal.payloadHash);
    await button(wrapper, 'Refresh proposal view').trigger('click');
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    expect(wrapper.text()).not.toContain(proposal.payloadHash);
    resolve(response(detail()));
    await flushPromises();
    expect(wrapper.text()).not.toContain(proposal.payloadHash);
    expect(wrapper.findAll('button').some((control) => control.text().includes('Execute exact'))).toBe(false);
  });

  it('clears identity-bound private props and ignores the previous identity detail response', async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(promise);
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal([{ reviewId: 'review-001', proposal }]);
    expect(wrapper.text()).toContain(proposal.payloadHash);
    await button(wrapper, 'Refresh proposal view').trigger('click');
    auth.session.value = { data: { user: { id: 'owner-002', email: 'other@example.test' } } };
    await flushPromises();
    expect(wrapper.text()).not.toContain(proposal.payloadHash);
    expect(wrapper.text()).not.toContain('Market');
    resolve(response(detail()));
    await flushPromises();
    expect(wrapper.text()).not.toContain(proposal.payloadHash);
    expect(wrapper.findAll('button').some((control) => control.text().includes('Execute exact'))).toBe(false);
  });
  it('recovers an initial-proposal-only caller through an explicitly authorized fresh snapshot after failure', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal();
    await wrapper.setProps({ proposals: [], initialProposal: proposal });
    expect(wrapper.text()).toContain(proposal.payloadHash);
    fetchMock.mockResolvedValueOnce(response({
      status: 'error', result: null, error: { code: 'DENIED', message: 'Private proposal denied' },
    }, 403));
    await button(wrapper, 'Refresh proposal view').trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain(proposal.payloadHash);
    const fresh = { ...proposal, payloadHash: 'f'.repeat(64) };
    fetchMock.mockResolvedValueOnce(response(detail(fresh)));
    await button(wrapper, 'Refresh proposal view').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain(fresh.payloadHash);
    expect(wrapper.text()).not.toContain(proposal.payloadHash);
    expect(button(wrapper, 'Execute exact rule proposal').attributes('disabled')).toBeUndefined();
  });

  it('does not submit an old approval after reauthentication completes following close/reopen', async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(promise);
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal([{ reviewId: 'review-001', proposal }]);
    await wrapper.get('input[type="password"]').setValue('private-password');
    await button(wrapper, 'Reauthenticate and approve exact proposal').trigger('click');
    await button(wrapper, 'Close').trigger('click');
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    resolve(response({ status: 'success' }));
    await flushPromises();
    expect(fetchMock.mock.calls.map(([input]) => route(input))).toEqual(['/api/reauth']);
    expect(wrapper.text()).not.toContain(proposal.payloadHash);
    expect(wrapper.text()).not.toContain('Human approval recorded');
    expect(wrapper.emitted('accepted')).toBeUndefined();
  });
});

describe('bulk exact proposal review', () => {
  it('displays ordered snapshots and submits one reviewId-to-displayed-hash approval request', async () => {
    const entries = [
      { reviewId: 'review-002', proposal: { ...proposal, id: 'proposal-002', payloadHash: 'b'.repeat(64) } },
      { reviewId: 'review-001', proposal: { ...proposal, id: 'proposal-001', payloadHash: 'c'.repeat(64) } },
    ];
    fetchMock.mockImplementation(async (input, options) => {
      const path = route(input);
      if (path === '/api/reauth') return response({ status: 'success' });
      if (path === '/api/review/approve-bulk')
        return response(
          envelope({
            items: entries.map(({ reviewId, proposal }, index) => ({
              reviewId,
              proposalId: proposal.id,
              approvalId: `approval-${index}`,
              status: 'active',
              expiresAt: proposal.expiresAt,
            })),
          }),
        );
      if (path === '/api/proposal/proposal-002' || path === '/api/proposal/proposal-001')
        return response(detail());
      throw new Error(`Unexpected request: ${String(options?.method)} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal(entries);

    expect(wrapper.text().indexOf('review-002')).toBeLessThan(wrapper.text().indexOf('review-001'));
    expect(wrapper.text().indexOf('b'.repeat(64))).toBeLessThan(wrapper.text().indexOf('c'.repeat(64)));
    expect(wrapper.text()).toContain('transactionVersion');

    await wrapper.get('input[type="password"]').setValue('current-password');
    await button(wrapper, 'Reauthenticate and approve displayed reviews').trigger('click');
    await flushPromises();

    const calls = fetchMock.mock.calls.map(([input, options]) => ({
      path: route(input),
      method: options?.method,
      body: options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined,
    }));
    expect(calls.map(({ path }) => path)).toEqual([
      '/api/reauth',
      '/api/review/approve-bulk',
      '/api/proposal/proposal-002',
      '/api/proposal/proposal-001',
    ]);
    expect(calls[0]?.body).toEqual({ password: 'current-password' });
    expect(calls[1]?.body).toEqual({
      ids: ['review-002', 'review-001'],
      payloadHashes: { 'review-002': 'b'.repeat(64), 'review-001': 'c'.repeat(64) },
    });
    expect(calls.some(({ path }) => /\/approve$/.test(path))).toBe(false);
    expect(calls.some(({ path }) => path.endsWith('/execute'))).toBe(false);
  });
});

describe('authenticated proposal discard', () => {
  it('requires fresh human proof and leaves the proposal available when reauthentication fails', async () => {
    fetchMock.mockImplementation(async (input) => {
      if (route(input) === '/api/reauth') {
        return response({ status: 'error', error: { code: 'REAUTHENTICATION_FAILED' } }, 401);
      }
      throw new Error(`Unexpected request: ${route(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal();

    await wrapper.get('input[type="password"]').setValue('wrong-password');
    await button(wrapper, 'Reauthenticate and discard').trigger('click');
    await flushPromises();

    expect(fetchMock.mock.calls.map(([input]) => route(input))).toEqual(['/api/reauth']);
    expect(wrapper.text()).toContain('REAUTHENTICATION_FAILED');
    expect(wrapper.text()).toContain('create_rule');
    expect(wrapper.find('input[type="password"]').element).toHaveProperty('value', '');
  });
});

describe('exact rule proposal review', () => {
  it('displays the full server snapshot and sends only its displayed hash after fresh human reauthentication', async () => {
    const approvedView = {
      ...proposal,
      approvers: [
        ...proposal.approvers,
        { actorId: 'reviewer-003', issuedAt: '2026-10-02T11:30:00.000Z', expiresAt: proposal.expiresAt },
      ],
    };
    fetchMock.mockImplementation(async (input, options) => {
      const path = route(input);
      const method = options?.method ?? 'GET';
      if (path === `/api/proposal/${proposal.id}` && method === 'GET')
        return response(detail(fetchMock.mock.calls.filter(([, request]) => request?.method === 'POST').length > 1 ? approvedView : proposal));
      if (path === '/api/reauth') return response({ status: 'success' });
      if (path === `/api/proposal/${proposal.id}/approve`)
        return response(envelope({ approvalId: 'approval-001', proposalId: proposal.id, status: 'active' }));
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal();

    await button(wrapper, 'Review exact proposal').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain(proposal.payloadHash);
    expect(wrapper.text()).toContain('requester-001');
    expect(wrapper.text()).toContain('membership-001');
    expect(wrapper.text()).toContain('governance-4');
    expect(wrapper.text()).toContain('financial-7');
    expect(wrapper.text()).toContain('Requester membership epoch');
    expect(wrapper.text()).toContain('Current governance policy');
    expect(wrapper.text()).toContain('Native algorithm version');
    expect(wrapper.text()).toContain('Required approvers: 2');
    expect(wrapper.text()).toContain('reviewer-002');
    expect(wrapper.text()).toContain('transactionVersion');
    expect(wrapper.text()).toContain('normalizedRule');
    expect(wrapper.text()).toContain('conditions');
    expect(wrapper.text()).toContain(proposal.expiresAt);

    await wrapper.get('input[type="password"]').setValue('current-password');
    await button(wrapper, 'Reauthenticate and approve exact proposal').trigger('click');
    await flushPromises();

    const calls = fetchMock.mock.calls.map(([input, options]) => ({
      path: route(input),
      method: options?.method ?? 'GET',
      body: options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined,
    }));
    expect(calls.map(({ path, method }) => [path, method])).toEqual([
      [`/api/proposal/${proposal.id}`, 'GET'],
      ['/api/reauth', 'POST'],
      [`/api/proposal/${proposal.id}/approve`, 'POST'],
      [`/api/proposal/${proposal.id}`, 'GET'],
    ]);
    expect(calls[1]?.body).toEqual({ password: 'current-password' });
    expect(calls[2]?.body).toEqual({ payloadHash: proposal.payloadHash });
    expect(wrapper.find('input[type="password"]').element).toHaveProperty('value', '');
    expect(calls.some(({ path }) => path.endsWith('/execute'))).toBe(false);
    expect(wrapper.text()).toContain('reviewer-003');
  });

  it('blocks proposal approval when fresh password confirmation fails', async () => {
    fetchMock.mockImplementation(async (input, options) => {
      const path = route(input);
      if (path === `/api/proposal/${proposal.id}`) return response(detail());
      if (path === '/api/reauth')
        return response({ status: 'error', error: { code: 'REAUTHENTICATION_FAILED' } }, 401);
      throw new Error(`Unexpected request: ${String(options?.method)} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal();

    await button(wrapper, 'Review exact proposal').trigger('click');
    await flushPromises();
    await wrapper.get('input[type="password"]').setValue('wrong-password');
    await button(wrapper, 'Reauthenticate and approve exact proposal').trigger('click');
    await flushPromises();

    expect(fetchMock.mock.calls.map(([input]) => route(input))).toEqual([
      `/api/proposal/${proposal.id}`,
      '/api/reauth',
    ]);
    expect(wrapper.text()).toContain('REAUTHENTICATION_FAILED');
    expect(wrapper.find('input[type="password"]').element).toHaveProperty('value', '');
  });

  it('classifies a stale displayed hash and requires an explicit fresh view before any replacement approval', async () => {
    let detailReads = 0;
    const replacement = { ...proposal, payloadHash: 'b'.repeat(64) };
    fetchMock.mockImplementation(async (input) => {
      const path = route(input);
      if (path === `/api/proposal/${proposal.id}`) {
        detailReads += 1;
        return response(detail(detailReads === 1 ? proposal : replacement));
      }
      if (path === '/api/reauth') return response({ status: 'success' });
      if (path === `/api/proposal/${proposal.id}/approve`)
        return response({ status: 'error', error: { code: 'PAYLOAD_HASH_MISMATCH', message: 'Displayed proposal changed.' } }, 409);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal();

    await button(wrapper, 'Review exact proposal').trigger('click');
    await flushPromises();
    await wrapper.get('input[type="password"]').setValue('current-password');
    await button(wrapper, 'Reauthenticate and approve exact proposal').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('PAYLOAD_HASH_MISMATCH');
    expect(fetchMock.mock.calls.map(([input]) => route(input))).toEqual([
      `/api/proposal/${proposal.id}`,
      '/api/reauth',
      `/api/proposal/${proposal.id}/approve`,
    ]);

    await button(wrapper, 'Refresh proposal view').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain(replacement.payloadHash);
    expect(wrapper.find('input[type="password"]').element).toHaveProperty('value', '');
    expect(fetchMock.mock.calls.map(([input]) => route(input))).toEqual([
      `/api/proposal/${proposal.id}`,
      '/api/reauth',
      `/api/proposal/${proposal.id}/approve`,
      `/api/proposal/${proposal.id}`,
    ]);
  });

  it('executes only from a separate explicit action and reports success only after the server confirms it', async () => {
    fetchMock.mockImplementation(async (input, options) => {
      const path = route(input);
      if (path === `/api/proposal/${proposal.id}`) return response(detail());
      if (path === `/api/proposal/${proposal.id}/execute`)
        return response(envelope({ proposalId: proposal.id, ruleId: 'rule-001', name: 'Market', verified: true }));
      throw new Error(`Unexpected request: ${String(options?.method)} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal();

    await button(wrapper, 'Review exact proposal').trigger('click');
    await flushPromises();
    expect(fetchMock.mock.calls.some(([input]) => route(input).endsWith('/execute'))).toBe(false);

    await button(wrapper, 'Execute exact rule proposal').trigger('click');
    await flushPromises();

    expect(fetchMock.mock.calls.map(([input]) => route(input))).toEqual([
      `/api/proposal/${proposal.id}`,
      `/api/proposal/${proposal.id}/execute`,
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ payloadHash: proposal.payloadHash }));
    expect(wrapper.emitted('accepted')).toEqual([[proposal.id]]);
  });
  it('does not accept an unverified execution response', async () => {
    fetchMock.mockImplementation(async (input, options) => {
      const path = route(input);
      if (path === `/api/proposal/${proposal.id}`) return response(detail());
      if (path === `/api/proposal/${proposal.id}/execute`)
        return response(envelope({ proposalId: proposal.id, verified: false }));
      throw new Error(`Unexpected request: ${String(options?.method)} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mountModal();

    await button(wrapper, 'Review exact proposal').trigger('click');
    await flushPromises();
    await button(wrapper, 'Execute exact rule proposal').trigger('click');
    await flushPromises();

    expect(fetchMock.mock.calls.map(([input]) => route(input))).toEqual([
      `/api/proposal/${proposal.id}`,
      `/api/proposal/${proposal.id}/execute`,
    ]);
    expect(wrapper.emitted('accepted')).toBeUndefined();
    expect(wrapper.text()).toContain('Proposal execution was not verified');
  });
});

describe('native rule impact and standalone export', () => {
  it('renders exact stable IDs, unchanged matches, category diffs and conflicts without executing', async () => {
    const nativeRule = {
      stage: 'post', conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: 'opaque-payee-ID' }],
      actions: [{ op: 'set', field: 'category', value: 'category-food' }],
    };
    const reviewedSimulation = {
      ruleId: '', name: 'Human label', transactionsMatched: 2, transactionsAffected: ['tx-a', 'tx-b'], categoryDistribution: { 'category-food': 2 },
      examples: [
        { txId: 'tx-a', payee: 'Same display', amount: { minorUnits: '-100', currency: 'JPY' }, currentCategory: 'category-old', wouldChange: true },
        { txId: 'tx-b', payee: 'Same display', amount: { minorUnits: '-200', currency: 'KWD' }, currentCategory: 'category-food', wouldChange: false },
      ],
      conflicts: ['rule-existing'],
    };
    const wrapper = mountModal([{ reviewId: 'review-001', proposal: {
      ...proposal, preconditions: { nativeRule, reviewedSimulation, ruleName: 'Human label' },
    } }]);
    expect(wrapper.get('[aria-label="Standalone Actual rule payload"]').text()).toBe(JSON.stringify(nativeRule, null, 2));
    expect(wrapper.text()).toContain('Global future effect');
    expect(wrapper.text()).toContain('opaque-payee-ID');
    expect(wrapper.text()).toContain('tx-a');
    expect(wrapper.text()).toContain('tx-b');
    expect(wrapper.text()).toContain('category-old');
    expect(wrapper.text()).toContain('rule-existing');
    expect(wrapper.get('a[download]').attributes('href')).toBe(`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(nativeRule, null, 2))}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('pages the complete reviewed category differences without truncating the impact', async () => {
    const nativeRule = {
      stage: 'post', conditionsOp: 'and',
      conditions: [{ field: 'payee', op: 'is', value: 'opaque-payee-ID' }],
      actions: [{ op: 'set', field: 'category', value: 'category-food' }],
    };
    const examples = Array.from({ length: 125 }, (_, index) => ({
      txId: `tx-${String(index).padStart(3, '0')}`, payee: 'Market',
      amount: { minorUnits: '9223372036854775807', currency: 'KWD' },
      currentCategory: 'category-old', wouldChange: true,
    }));
    const wrapper = mountModal([{ reviewId: 'review-001', proposal: { ...proposal, preconditions: {
      nativeRule, reviewedSimulation: {
        ruleId: '', name: 'Market', transactionsMatched: 125,
        transactionsAffected: examples.map(example => example.txId),
        categoryDistribution: { 'category-food': 125 }, conflicts: [], examples,
      },
    } } }]);
    expect(wrapper.text()).toContain('125');
    expect(wrapper.findAll('tbody tr')).toHaveLength(100);
    expect(wrapper.text()).toContain('9223372036854775.807 KWD');
    await button(wrapper, 'Next impact page').trigger('click');
    expect(wrapper.findAll('tbody tr')).toHaveLength(25);
    expect(wrapper.text()).toContain('tx-124');
    await button(wrapper, 'Previous impact page').trigger('click');
    expect(wrapper.findAll('tbody tr')).toHaveLength(100);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
