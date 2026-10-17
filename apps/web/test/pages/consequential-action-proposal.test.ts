import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import actionFixture from '../../../../protocol/fixtures/consequential-action.json';
import type { ConsequentialActionProposal } from '@balanceframe/application';
import ConsequentialActionProposalPage from '../../app/pages/proposals/[id].vue';

const request = vi.fn();
const reauth = vi.fn();
vi.stubGlobal('$fetch', request);
vi.stubGlobal('fetch', reauth);
vi.stubGlobal('useRoute', () => ({ params: { id: 'proposal-action' } }));

const ok = (result: unknown) => ({ status: 'ok', result });
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const plan = {
  version: '1',
  action: actionFixture.intent,
  source: {
    snapshotReference: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    policyVersion: 'policy-1',
    financialPolicyVersion: 'financial-1',
    claimSetRevision: 'claims-1',
  },
  evidenceReferences: [],
  expiresAt: '2099-09-06T17:00:00.000Z',
  reasonCodes: ['safe_reallocation'],
  impacts: [{
    kind: 'category_reallocation', sourceCategoryId: 'reserve', sourceAsOfMonth: '2026-09',
    destinationCategoryId: 'food', destinationAsOfMonth: '2026-09', amount: money('2000'),
    sourceProtected: false, sourceAvailabilityBefore: money('6000'), sourceAvailabilityAfter: money('4000'),
    sourceUncommittedAvailabilityBefore: money('6000'), sourceUncommittedAvailabilityAfter: money('4000'),
    minimumRetained: money('1000'), projectedRemainingNeed: money('2000'), safeToRedirectAfter: money('1000'),
    rationale: 'donor_category_surplus_redirected',
  }],
  expectedPostconditions: [
    ...actionFixture.postconditions.reallocation.currentLedger.assignments.map((assignment) => ({
      kind: 'assignment', ...assignment,
    })),
    ...actionFixture.postconditions.reallocation.financialSnapshot.accountBalances.map((account) => ({
      kind: 'account_balance', accountId: account.accountId, balance: account.balance,
    })),
  ],
};
 
const decisionContext = {
  horizon: { startsAt: '2099-09-06T00:00:00.000Z', endsAt: '2099-09-07T00:00:00.000Z' },
  validUntil: '2099-09-06T17:00:00.000Z',
  items: [{
    id: 'purchase-item', categoryId: 'food', accountId: 'checking', amount: money('2000'),
    priority: 'planned', purchaseAt: '2099-09-06T12:00:00.000Z',
    requiredBy: '2099-09-06T12:00:00.000Z',
  }],
};

function detail(phase: ConsequentialActionProposal['state']['phase'], overrides: Record<string, unknown> = {}) {
  return {
    proposal: {
      id: 'proposal-action', operation: 'consequential_action', spaceId: 'selected-space',
      budgetId: 'selected-budget', requesterActorId: 'actor-requester',
      requesterMembershipCurrent: true,
      governancePolicyVersion: 'governance-1', currentGovernancePolicyVersion: 'governance-1',
      policyVersion: 'generic-action-policy-1', payloadHash: 'b'.repeat(64),
      payload: { kind: 'consequential_action', plan },
      decisionContext,
      expiresAt: plan.expiresAt, requiredApprovers: 2, approvers: [], disposition: 'approval_required',
      canApprove: true, canExecute: false, currentAssistanceMaximum: 'create_approval_proposal',
      financialPolicyVersion: 'financial-1', currentFinancialPolicyVersion: 'financial-1',
      state: { phase, outcome: null },
      ...overrides,
    },
  };
}

const global = {
  stubs: {
    AnalysisPage: {
      props: ['loading', 'error'],
      template: '<main><p v-if="error" role="alert">{{ error.message }}</p><slot name="content" /></main>',
    },
    UCard: { template: '<section><slot name="header" /><slot /></section>' },
    UButton: {
      props: ['disabled'],
      template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
    },
    NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  },
};
const wrappers: VueWrapper[] = [];

beforeEach(() => {
  request.mockReset();
  reauth.mockReset();
  reauth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'success' }) });
  request.mockResolvedValue(ok(detail('proposed')));
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: false } }));
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

function mountPage() {
  const wrapper = mount(ConsequentialActionProposalPage, { global });
  wrappers.push(wrapper);
  return wrapper;
}

describe('consequential-action proposal review page', () => {
  it('loads the actor-scoped public proposal and renders typed action, impact, and cash postconditions separately', async () => {
    const wrapper = mountPage();
    await flushPromises();

    expect(request.mock.calls.some(([url, options]) => url === '/api/proposal/proposal-action' && (options?.method ?? 'GET') === 'GET')).toBe(true);
    expect(wrapper.text()).toContain('Proposed');
    expect(wrapper.text()).toContain('reserve');
    expect(wrapper.text()).toContain('food');
    expect(wrapper.text()).toContain('2026-09');
    expect(wrapper.text()).toContain('20.00 USD');
    expect(wrapper.text()).toMatch(/not protected|unprotected|protected\s*:\s*(?:no|false)/i);
    expect(wrapper.get('[data-testid="action-remainder"]').text()).toContain('40.00 USD / 10.00 USD / 20.00 USD / 10.00 USD');
    expect(wrapper.text()).toContain('purchase-item');
    expect(wrapper.text()).toContain('2099-09-06T00:00:00.000Z');
    expect(wrapper.text()).toContain('Requester');
    expect(wrapper.text()).toContain('actor-requester');
    expect(wrapper.text()).toContain('Requester membership current');
    expect(wrapper.text()).toContain('governance-1');
    expect(wrapper.text()).toContain('Captured source-policy version');
    expect(wrapper.text()).toContain('policy-1');
    expect(wrapper.text()).not.toContain('generic-action-policy-1');
    expect(wrapper.text()).toContain('Source snapshot reference');
    expect(wrapper.text()).toContain('6ba7b810-9dad-41d1-80b4-00c04fd430c8');
    expect(wrapper.text()).toContain('Payload hash');
    expect(wrapper.text()).toContain('b'.repeat(64));
    expect(wrapper.text()).toContain('2099-09-06T17:00:00.000Z');
    expect(wrapper.get('[data-testid="proposal-quorum"]').text()).toContain('2');
    expect(wrapper.text()).toContain('safe_reallocation');
    expect(wrapper.text()).toContain('category_reallocation');
    expect(wrapper.text()).toContain('2099-09-06T12:00:00.000Z');
    expect(wrapper.get('[data-testid="action-category-envelope"]').text()).toContain('20.00 USD');
    expect(wrapper.get('[data-testid="action-category-envelope"]').text()).not.toContain('130.00 USD');
    expect(wrapper.get('[data-testid="action-account-cash"]').text()).toContain('130.00 USD');
    expect(wrapper.get('[data-testid="proposal-execute"]').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).not.toContain('Executed');
  });

  it.each([
    ['proposed', 'Proposed'],
    ['approved', 'Approved — not executed'],
    ['verified', 'Execution result'],
    ['review_required', 'Review required'],
  ] as const)('labels %s action state as %s', async (phase, label) => {
    request.mockResolvedValue(ok(detail(phase, {
      canApprove: phase === 'proposed', canExecute: phase === 'approved',
      state: { phase, outcome: phase === 'verified' ? 'verified' : phase === 'review_required' ? 'review_required' : null },
    })));
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain(label);
  });

  it('strips private plan, precondition, and execution metadata from a returned view', async () => {
    const privatePlan = {
      ...plan,
      idempotencyKey: 'secret-idempotency-key',
      actionHash: 'secret-native-action-hash',
      source: {
        ...plan.source,
        snapshotId: 'secret-snapshot-id',
        contentHash: 'secret-content-hash',
        evidenceHash: 'secret-evidence-hash',
        preconditionsHash: 'secret-preconditions-hash',
        invariantsHash: 'secret-invariants-hash',
      },
    };
    
    request.mockResolvedValue(ok(detail('verified', {
      privateEnvelopeVisible: true,
      payload: { kind: 'consequential_action', plan: privatePlan },
      decisionContext: { ...decisionContext, privateDecisionMetadata: 'secret-decision-context' },
      preconditions: { supplemental: 'secret-supplemental', source: 'secret-preconditions' },
      state: {
        phase: 'verified', outcome: 'verified',
        effects: [{ actionHash: 'secret-effect-hash' }],
        result: { proofToken: 'secret-proof-token' },
      },
    })));
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('Execution result');
    expect(wrapper.text()).toContain('6ba7b810-9dad-41d1-80b4-00c04fd430c8');
    for (const secret of [
      'secret-idempotency-key', 'secret-native-action-hash', 'secret-snapshot-id',
      'secret-content-hash', 'secret-evidence-hash', 'secret-preconditions-hash',
      'secret-invariants-hash', 'secret-supplemental', 'secret-effect-hash', 'secret-proof-token',
      'secret-decision-context',
    ]) expect(wrapper.text()).not.toContain(secret);
    expect(wrapper.text()).not.toContain('Observed effects');
  });

  it('offers only read-only refresh while a write is uncertain', async () => {
    request.mockResolvedValue(ok(detail('write_intent', {
      canApprove: true, canExecute: true, currentAssistanceMaximum: 'execute_approved_actions',
      state: { phase: 'write_intent', outcome: null },
    })));
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('Execution state uncertain — refresh only');
    expect(wrapper.text()).toContain('Refresh is read-only');
    expect(wrapper.get('[data-testid="proposal-approve"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="proposal-execute"]').attributes('disabled')).toBeDefined();
    const readsBeforeRefresh = request.mock.calls.filter(([url, options]) =>
      url === '/api/proposal/proposal-action' && (options?.method ?? 'GET') === 'GET',
    ).length;
    await wrapper.findAll('button').find((button) => button.text().includes('Refresh current proposal'))!.trigger('click');
    await flushPromises();

    expect(request.mock.calls.filter(([url, options]) =>
      url === '/api/proposal/proposal-action' && (options?.method ?? 'GET') === 'GET',
    )).toHaveLength(readsBeforeRefresh + 1);
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });

  it('requires read-only recovery after an execute request loses its connection', async () => {
    const approved = detail('approved', {
      canApprove: false, canExecute: true, currentAssistanceMaximum: 'execute_approved_actions',
      state: { phase: 'approved', outcome: null },
    });
    let current = approved;
    request.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (url === '/api/proposal/proposal-action' && (options?.method ?? 'GET') === 'GET') return ok(current);
      if (url.endsWith('/execute') && options?.method === 'POST') throw new Error('connection lost');
      return ok({});
    });
    const wrapper = mountPage();
    await flushPromises();
    await wrapper.get('input[type="password"]').setValue('current-password');
    await wrapper.get('[data-testid="proposal-execute"]').trigger('click');
    await flushPromises();

    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(wrapper.text()).toContain('Execution state uncertain — refresh only');
    expect(wrapper.get('[data-testid="proposal-execute"]').attributes('disabled')).toBeDefined();
    await wrapper.get('input[type="password"]').setValue('current-password');
    expect(wrapper.get('[data-testid="proposal-execute"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="proposal-execute"]').trigger('click');
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);

    current = detail('write_intent', {
      canApprove: false, canExecute: true, currentAssistanceMaximum: 'execute_approved_actions',
      state: { phase: 'write_intent', outcome: null },
    });
    await wrapper.findAll('button').find((button) => button.text().includes('Refresh current proposal'))!.trigger('click');
    await flushPromises();
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(wrapper.text()).toContain('Refresh is read-only');
  });

  it('reauthenticates approval and execution separately and submits only the displayed exact hash', async () => {
    const proposed = detail('proposed');
    const approved = detail('approved', {
      disposition: 'authorized_without_approval', canApprove: false, canExecute: true,
      currentAssistanceMaximum: 'execute_approved_actions', requiredApprovers: 2,
      state: { phase: 'approved', outcome: null },
    });
    const verified = detail('verified', {
      disposition: 'authorized_without_approval', canApprove: false, canExecute: false,
      state: { phase: 'verified', outcome: 'verified' },
    });
    let current = proposed;
    request.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (url.endsWith('/approve') && options?.method === 'POST') {
        current = approved;
        return ok(approved);
      }
      if (url.endsWith('/execute') && options?.method === 'POST') {
        current = verified;
        return ok(verified);
      }
      return ok(current);
    });
    const wrapper = mountPage();
    await flushPromises();

    await wrapper.get('input[type="password"]').setValue('current-password');
    expect(wrapper.get('[data-testid="proposal-approve"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="proposal-execute"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="proposal-approve"]').trigger('click');
    await flushPromises();
    expect(reauth).toHaveBeenCalledWith('/api/reauth', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({ password: 'current-password' }),
    }));
    const approve = request.mock.calls.find(([url, options]) => url.endsWith('/approve') && options?.method === 'POST');
    const approveIndex = request.mock.calls.findIndex(([url, options]) => url.endsWith('/approve') && options?.method === 'POST');
    expect(reauth.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[approveIndex]!);
    expect(approve?.[0]).toBe('/api/proposal/proposal-action/approve');
    expect(approve?.[1]).toMatchObject({ method: 'POST', body: { payloadHash: 'b'.repeat(64) } });
    expect(approve?.[1]?.body).not.toHaveProperty('actorId');

    await wrapper.get('input[type="password"]').setValue('current-password');
    expect(wrapper.get('[data-testid="proposal-approve"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="proposal-execute"]').attributes('disabled')).toBeUndefined();
    await wrapper.get('[data-testid="proposal-execute"]').trigger('click');
    await flushPromises();
    const execute = request.mock.calls.find(([url, options]) => url.endsWith('/execute') && options?.method === 'POST');
    const executeIndex = request.mock.calls.findIndex(([url, options]) => url.endsWith('/execute') && options?.method === 'POST');
    expect(reauth.mock.invocationCallOrder[1]).toBeLessThan(request.mock.invocationCallOrder[executeIndex]!);
    expect(reauth).toHaveBeenCalledTimes(2);
    expect(execute?.[0]).toBe('/api/proposal/proposal-action/execute');
    expect(execute?.[1]).toMatchObject({ method: 'POST' });
    expect(wrapper.text()).toContain('Execution result');
  });

  it.each([
    { phase: 'proposed', action: 'approve', control: 'proposal-approve', canApprove: true, canExecute: false },
    { phase: 'approved', action: 'execute', control: 'proposal-execute', canApprove: false, canExecute: true },
  ])('does not $action when fresh human reauthentication fails', async ({ phase, control, canApprove, canExecute }) => {
    request.mockResolvedValue(ok(detail(phase, {
      canApprove, canExecute, currentAssistanceMaximum: 'execute_approved_actions',
    })));
    reauth.mockResolvedValue({ ok: false, status: 403, json: async () => ({ status: 'error' }) });
    const wrapper = mountPage();
    await flushPromises();
    await wrapper.get('input[type="password"]').setValue('incorrect-password');
    await wrapper.get(`[data-testid="${control}"]`).trigger('click');
    await flushPromises();
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });

  it.each([
    { constraint: 'the current assistance ceiling', currentAssistanceMaximum: 'create_approval_proposal', canExecute: true },
    { constraint: 'the current execute grant', currentAssistanceMaximum: 'execute_approved_actions', canExecute: false },
  ])('does not offer execution when $constraint denies it', async ({ currentAssistanceMaximum, canExecute }) => {
    request.mockResolvedValue(ok(detail('approved', {
      canApprove: false, canExecute, currentAssistanceMaximum,
      state: { phase: 'approved', outcome: null },
    })));
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.get('[data-testid="proposal-execute"]').attributes('disabled')).toBeDefined();
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });
  it('withholds approve and execute when the captured financial policy is no longer current', async () => {
    request.mockResolvedValue(ok(detail('proposed', {
      financialPolicyVersion: 'financial-1', currentFinancialPolicyVersion: 'financial-2',
    })));
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.get('[data-testid="proposal-approve"]').attributes('disabled')).toBeDefined();
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });

  it('withholds approval when the captured governance policy is no longer current', async () => {
    request.mockResolvedValue(ok(detail('proposed', {
      governancePolicyVersion: 'governance-1', currentGovernancePolicyVersion: 'governance-2',
    })));
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.get('[data-testid="proposal-approve"]').attributes('disabled')).toBeDefined();
    expect(request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  });
});
