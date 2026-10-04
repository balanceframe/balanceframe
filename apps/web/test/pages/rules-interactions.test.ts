import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { onMounted, ref } from 'vue';
import RulesPage from '../../app/pages/rules.vue';
import RuleList from '../../app/components/RuleList.vue';
import RuleDetail from '../../app/components/RuleDetail.vue';
import ProposedRulesModal from '../../app/components/ProposedRulesModal.vue';
const auth = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock('../../lib/auth-client', () => ({ authClient: auth }));

const stubs = {
  UContainer: { template: '<main><slot /></main>' },
  UCard: { template: '<section><slot name="header" /><slot /><slot name="footer" /></section>' },
  UButton: {
    props: ['label', 'disabled'],
    template: '<button type="button" :disabled="disabled"><slot />{{ label }}</button>',
  },
  UBadge: { props: ['label'], template: '<span><slot />{{ label }}</span>' },
  UAlert: {
    props: ['title', 'description'],
    template: '<aside role="alert">{{ title }} {{ description }}<slot name="trailing" /></aside>',
  },
  UModal: {
    props: ['open'],
    template: '<div v-if="open" role="dialog"><slot name="content" /></div>',
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function ok(result: unknown) {
  return { status: 'ok', result, error: null };
}

function failure(message: string) {
  return {
    status: 'error',
    result: null,
    error: { code: 'rule_unavailable', message, retryable: true },
  };
}

function rule(id: string, inactive = false) {
  return {
    id,
    name: id === 'groceries' ? 'Weekly groceries' : 'Monthly rent',
    order: id === 'groceries' ? 1 : 2,
    inactive,
    stage: null as 'pre' | 'post' | null,
    conditionsOp: 'or' as 'and' | 'or',
    trigger: { field: 'payee', op: 'contains', value: id },
    actions: [{ op: 'set', field: 'category', value: `cat-${id}` }],
  };
}

interface Rule {
  id: string;
  name: string;
  order: number;
  inactive: boolean;
  stage: 'pre' | 'post' | null;
  conditionsOp: 'and' | 'or';
  trigger: { field: string; op: string; value: string };
  actions: { op: string; field: string; value: string }[];
}

type RequestOptions = { method?: string; body?: { inactive: boolean } };

interface RuleProposal {
  readonly id: string;
  readonly operation: 'update_rule' | 'delete_rule';
  readonly spaceId: string;
  readonly budgetId: string;
  readonly requesterActorId: string;
  readonly requesterMembershipId: string;
  readonly governancePolicyVersion: string;
  readonly currentGovernancePolicyVersion: string;
  readonly requesterMembershipCurrent: boolean;
  readonly policyVersion: string;
  readonly payloadHash: string;
  readonly privateEnvelopeVisible: boolean;
  readonly payload: Record<string, unknown>;
  readonly requiredApprovers: number;
  readonly approvers: readonly {
    readonly actorId: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  }[];
  readonly disposition: 'approval_required';
  readonly canApprove: boolean;
  readonly canExecute: boolean;
}

interface ProposalPermissions {
  canApprove: boolean;
  canExecute: boolean;
}

let proposalPermissions: ProposalPermissions;

function ruleProposal(operation: 'update_rule' | 'delete_rule', inactive = false): RuleProposal {
  const currentRule = rule('groceries');
  return {
    id: `proposal-${operation}-groceries`,
    operation,
    spaceId: 'space-test',
    budgetId: 'budget-test',
    requesterActorId: 'requester-test',
    requesterMembershipId: 'membership-test',
    currentGovernancePolicyVersion: 'governance-3',
    requesterMembershipCurrent: true,
    governancePolicyVersion: 'governance-3',
    policyVersion: 'mutation-8',
    payloadHash: 'd'.repeat(64),
    privateEnvelopeVisible: true,
    payload:
      operation === 'update_rule'
        ? { kind: operation, ruleId: 'groceries', inactive, composite: null }
        : { kind: operation, ruleId: 'groceries', composite: null },
    preconditions: {
      rule: currentRule,
      override: null,
      actualVersion: 'actual-rule-version',
    },
    expiresAt: '2026-10-03T12:00:00.000Z',
    requiredApprovers: 1,
    approvers: [
      { actorId: 'reviewer-test', issuedAt: '2026-10-02T11:00:00.000Z', expiresAt: '2026-10-03T12:00:00.000Z' },
    ],
    disposition: 'approval_required',
    canApprove: proposalPermissions.canApprove,
    canExecute: proposalPermissions.canExecute,
  };
}

function httpResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const api = vi.fn<(url: string, options?: RequestOptions) => Promise<unknown>>();
const fetchMock = vi.fn<typeof fetch>();
const toast = vi.fn();
const navigate = vi.fn();
let stored: Rule[];
let pendingRuleProposal: RuleProposal | null;
const pages: VueWrapper[] = [];

function button(page: VueWrapper, label: string) {
  const control = page.findAll('button').find((candidate) => candidate.text() === label);
  if (!control) throw new Error(`Missing button: ${label}`);
  return control;
}

function row(page: VueWrapper, name: string) {
  const control = page
    .findComponent(RuleList)
    .findAll('button')
    .find((candidate) => candidate.text().includes(name));
  if (!control) throw new Error(`Missing rule: ${name}`);
  return control;
}

function mountPage() {
  const page = mount(RulesPage, {
    global: {
      components: { RuleList, RuleDetail, ProposedRulesModal },
      stubs,
    },
  });
  pages.push(page);
  return page;
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = [rule('groceries'), rule('rent', true)];
  pendingRuleProposal = null;
  proposalPermissions = { canApprove: true, canExecute: true };
  api.mockReset();
  api.mockImplementation(async (url, options) => {
    if (url === '/api/rule')
      return ok({ items: stored.map((item) => ({ ...item })), total: stored.length });
    const id = url.slice('/api/rule/'.length);
    const item = stored.find((candidate) => candidate.id === id);
    if (!item) return failure('Rule no longer exists');
    if (options?.method === 'PATCH') {
      pendingRuleProposal = ruleProposal('update_rule', options.body!.inactive);
      return ok({
        approvalRequired: true,
        success: false,
        applied: false,
        verified: false,
        disposition: 'approval_required',
        proposal: pendingRuleProposal,
      });
    }
    if (options?.method === 'DELETE') {
      pendingRuleProposal = ruleProposal('delete_rule');
      return ok({
        approvalRequired: true,
        success: false,
        applied: false,
        verified: false,
        disposition: 'approval_required',
        proposal: pendingRuleProposal,
      });
    }
    return ok({ ...item });
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, options) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    if (path === '/api/reauth') return httpResponse({ status: 'success' });
    if (path.endsWith('/approve'))
      return httpResponse({
        status: 'ok',
        result: { approvalId: 'approval-rule', proposalId: pendingRuleProposal?.id, status: 'active' },
        error: null,
      });
    if (path.endsWith('/execute')) {
      if (pendingRuleProposal?.operation === 'update_rule') {
        const inactive = pendingRuleProposal.payload.inactive;
        if (typeof inactive === 'boolean') {
          stored = stored.map((item) => item.id === 'groceries' ? { ...item, inactive } : item);
        }
      } else if (pendingRuleProposal?.operation === 'delete_rule') {
        stored = stored.filter((item) => item.id !== 'groceries');
      }
      return httpResponse({
        status: 'ok',
        result: { proposalId: pendingRuleProposal?.id, ruleId: 'groceries', status: 'verified', verified: true },
        error: null,
      });
    }
    if (path.startsWith('/api/proposal/')) {
      return httpResponse({
        status: 'ok',
        result: { proposal: pendingRuleProposal, stale: false, simulation: null, simulationStatus: 'missing' },
        error: null,
      });
    }
    throw new Error(`Unexpected request: ${String(options?.method)} ${path}`);
  });
  auth.signOut.mockResolvedValue(undefined);
  navigate.mockResolvedValue(undefined);
  vi.stubGlobal('$fetch', api);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('onMounted', onMounted);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://rules.test' } }));
  vi.stubGlobal('useToast', () => ({ add: toast }));
  vi.stubGlobal('navigateTo', navigate);
});

afterEach(() => {
  for (const page of pages.splice(0)) page.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('rules page with real list and detail controls', () => {
  it('keeps mutation controls absent while loading and renders an empty result without a selected detail', async () => {
    const pending = deferred<unknown>();
    api.mockReturnValueOnce(pending.promise);
    const page = mountPage();
    expect(page.text()).toContain('Loading rules');
    expect(page.findComponent(RuleDetail).exists()).toBe(false);
    pending.resolve(ok({ items: [], total: 0 }));
    await flushPromises();
    expect(page.text()).toContain('No rules configured');
    expect(page.text()).not.toContain('Loading rules');
    expect(page.findAll('button').map((control) => control.text())).toEqual(['Sign out']);
  });

  it.each([
    ['envelope', () => Promise.resolve(failure('Ledger is offline')), 'Ledger is offline'],
    ['exception', () => Promise.reject(new Error('Network disconnected')), 'Network disconnected'],
  ] as const)('recovers from a list %s failure through Retry', async (_kind, response, message) => {
    api.mockImplementationOnce(response);
    const page = mountPage();
    await flushPromises();
    expect(page.get('[role="alert"]').text()).toContain(message);
    expect(page.findComponent(RuleList).exists()).toBe(false);
    await button(page, 'Retry').trigger('click');
    await flushPromises();
    expect(page.find('[role="alert"]').exists()).toBe(false);
    expect(row(page, 'Weekly groceries').exists()).toBe(true);
  });

  it('clears the previous detail during a new selection and displays only the newly loaded rule', async () => {
    const page = mountPage();
    await flushPromises();
    await row(page, 'Weekly groceries').trigger('click');
    await flushPromises();
    expect(page.findComponent(RuleDetail).text()).toContain('Weekly groceries');
    const pending = deferred<unknown>();
    api.mockReturnValueOnce(pending.promise);
    await row(page, 'Monthly rent').trigger('click');
    expect(row(page, 'Monthly rent').attributes('aria-current')).toBe('true');
    expect(row(page, 'Weekly groceries').attributes('aria-current')).toBeUndefined();
    expect(page.findComponent(RuleDetail).exists()).toBe(false);
    pending.resolve(ok(rule('rent', true)));
    await flushPromises();
    expect(page.findComponent(RuleDetail).text()).toContain('Monthly rent');
    expect(page.findComponent(RuleDetail).text()).not.toContain('Weekly groceries');
    expect(button(page, 'Resume BalanceFrame classification').exists()).toBe(true);
  });

  it.each([
    [
      'envelope',
      () => Promise.resolve(failure('Rule permission denied')),
      'Rule permission denied',
    ],
    ['exception', () => Promise.reject(new Error('Detail unavailable')), 'Detail unavailable'],
  ] as const)(
    'removes stale mutation controls on a detail %s failure',
    async (_kind, response, message) => {
      const page = mountPage();
      await flushPromises();
      await row(page, 'Weekly groceries').trigger('click');
      await flushPromises();
      api.mockImplementationOnce(response);
      await row(page, 'Monthly rent').trigger('click');
      await flushPromises();
      expect(page.get('[role="alert"]').text()).toContain(message);
      expect(page.findComponent(RuleDetail).exists()).toBe(false);
      await button(page, 'Retry').trigger('click');
      await flushPromises();
      expect(page.find('[aria-current="true"]').exists()).toBe(false);
      expect(page.find('[role="alert"]').exists()).toBe(false);
    },
  );

  it('retains an exact BalanceFrame-only pause proposal until separately approved and executed', async () => {
    const page = mountPage();
    await flushPromises();
    await row(page, 'Weekly groceries').trigger('click');
    await flushPromises();
    expect(row(page, 'Weekly groceries').text()).toContain('Active in BalanceFrame');
    await button(page, 'Pause BalanceFrame classification').trigger('click');
    await flushPromises();

    const proposal = pendingRuleProposal!;
    expect(api.mock.calls.filter(([url]) => url === '/api/rule')).toHaveLength(1);
    expect(stored.find((item) => item.id === 'groceries')?.inactive).toBe(false);
    expect(row(page, 'Weekly groceries').text()).toContain('Active in BalanceFrame');
    expect(page.text()).toContain('BalanceFrame classification only');
    expect(page.text()).toContain('Actual may still execute');
    expect(page.text()).toContain(proposal.payloadHash);
    expect(page.text()).toContain('requester-test');
    expect(page.text()).toContain('governance-3');
    expect(page.text()).toContain('mutation-8');
    expect(page.text()).toContain('Requester membership epoch');
    expect(page.text()).toContain('Current governance policy');
    expect(page.text()).toContain('Native algorithm version');
    expect(page.text()).not.toContain('Financial policy version');
    expect(page.text()).toContain(proposal.expiresAt);
    expect(page.text()).toContain('"stage": null');
    expect(page.text()).toContain('"conditionsOp": "or"');
    expect(page.text()).toContain('"kind": "update_rule"');
    expect(page.text()).toContain('"ruleId": "groceries"');
    expect(page.text()).toContain('"inactive": true');
    expect(page.text()).toContain('"override": null');
    expect(page.text()).toContain('"actualVersion": "actual-rule-version"');
    expect(page.text()).toContain('reviewer-test');
    expect(page.text()).toContain('2026-10-02T11:00:00.000Z');
    expect(page.findComponent(ProposedRulesModal).props('open')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    await page.get('input[type="password"]').setValue('current-password');
    await button(page, 'Reauthenticate and approve exact proposal').trigger('click');
    await flushPromises();
    const approval = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/approve'));
    expect(approval?.[1]?.body).toBe(JSON.stringify({ payloadHash: proposal.payloadHash }));
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/execute'))).toBe(false);

    await button(page, 'Execute exact rule update').trigger('click');
    await flushPromises();
    const execution = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/execute'));
    expect(execution?.[1]?.body).toBe(JSON.stringify({ payloadHash: proposal.payloadHash }));
    expect(stored.find((item) => item.id === 'groceries')?.inactive).toBe(true);
    expect(row(page, 'Weekly groceries').text()).toContain('Paused in BalanceFrame');
  });

  it('requires confirmation before proposing Actual deletion and removes the rule only after execution', async () => {
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const page = mountPage();
    await flushPromises();
    await row(page, 'Weekly groceries').trigger('click');
    await flushPromises();
    await button(page, 'Delete Actual rule').trigger('click');
    await flushPromises();
    expect(api.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toEqual([]);
    expect(page.findComponent(RuleDetail).text()).toContain('Weekly groceries');

    confirmation.mockReturnValue(true);
    await button(page, 'Delete Actual rule').trigger('click');
    await flushPromises();
    const proposal = pendingRuleProposal!;
    expect(api.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1);
    expect(stored.map((item) => item.id)).toEqual(['groceries', 'rent']);
    expect(row(page, 'Weekly groceries').text()).toContain('Active in BalanceFrame');
    expect(page.text()).toContain(proposal.payloadHash);
    expect(page.findComponent(ProposedRulesModal).props('open')).toBe(true);

    await page.get('input[type="password"]').setValue('current-password');
    await button(page, 'Reauthenticate and approve exact proposal').trigger('click');
    await flushPromises();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/execute'))).toBe(false);
    await button(page, 'Execute exact rule deletion').trigger('click');
    await flushPromises();
    const execution = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/execute'));
    expect(execution?.[1]?.body).toBe(JSON.stringify({ payloadHash: proposal.payloadHash }));
    expect(stored.map((item) => item.id)).toEqual(['rent']);
    expect(page.findComponent(RuleList).text()).not.toContain('Weekly groceries');
    expect(row(page, 'Monthly rent').exists()).toBe(true);
  });

  it('renders approval availability from the server proposal view', async () => {
    proposalPermissions = { canApprove: false, canExecute: true };
    const page = mountPage();
    await flushPromises();
    await row(page, 'Weekly groceries').trigger('click');
    await flushPromises();
    await button(page, 'Pause BalanceFrame classification').trigger('click');
    await flushPromises();

    expect(page.text()).toContain(pendingRuleProposal!.payloadHash);
    expect(page.findAll('button').some((control) => control.text() === 'Reauthenticate and approve exact proposal')).toBe(false);
    expect(button(page, 'Execute exact rule update').exists()).toBe(true);
  });

  it('withholds proposal execution until the server projection allows it', async () => {
    proposalPermissions = { canApprove: true, canExecute: false };
    const page = mountPage();
    await flushPromises();
    await row(page, 'Weekly groceries').trigger('click');
    await flushPromises();
    await button(page, 'Pause BalanceFrame classification').trigger('click');
    await flushPromises();

    expect(button(page, 'Reauthenticate and approve exact proposal').exists()).toBe(true);
    expect(page.findAll('button').some((control) => control.text() === 'Execute exact rule update')).toBe(false);
  });

  it.each([
    ['Pause BalanceFrame classification', 'envelope', () => Promise.resolve(failure('Rule is locked')), 'Rule is locked'],
    [
      'Pause BalanceFrame classification',
      'exception',
      () => Promise.reject(new Error('Update timed out')),
      'Update timed out',
    ],
    [
      'Delete Actual rule',
      'envelope',
      () => Promise.resolve(failure('Rule is referenced')),
      'Rule is referenced',
    ],
    [
      'Delete Actual rule',
      'exception',
      () => Promise.reject(new Error('Delete timed out')),
      'Delete timed out',
    ],
  ] as const)(
    'preserves the selected rule when %s has an %s failure',
    async (action, _kind, response, message) => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const page = mountPage();
      await flushPromises();
      await row(page, 'Weekly groceries').trigger('click');
      await flushPromises();
      api.mockImplementationOnce(response);
      await button(page, action).trigger('click');
      await flushPromises();
      expect(toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ color: 'error', description: message }),
      );
      expect(page.findComponent(RuleDetail).text()).toContain('Weekly groceries');
      expect(button(page, action).exists()).toBe(true);
      expect(row(page, 'Weekly groceries').attributes('aria-current')).toBe('true');
      await button(page, action).trigger('click');
      await flushPromises();
      expect(page.findComponent(RuleDetail).exists()).toBe(true);
      expect(page.findComponent(RuleDetail).text()).toContain('Weekly groceries');
      expect(row(page, 'Weekly groceries').text()).toContain('Active in BalanceFrame');
      expect(page.findComponent(ProposedRulesModal).props('open')).toBe(true);
    },
  );

  it('waits for sign-out before leaving the authenticated rules surface', async () => {
    const pending = deferred<void>();
    auth.signOut.mockReturnValueOnce(pending.promise);
    const page = mountPage();
    await flushPromises();
    await button(page, 'Sign out').trigger('click');
    expect(navigate).not.toHaveBeenCalled();
    pending.resolve(undefined);
    await flushPromises();
    expect(navigate).toHaveBeenCalledWith('/');
  });
});
