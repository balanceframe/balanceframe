import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { onMounted, ref } from 'vue';
import RulesPage from '../../app/pages/rules.vue';
import RuleList from '../../app/components/RuleList.vue';
import RuleDetail from '../../app/components/RuleDetail.vue';

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
    trigger: { field: 'payee', op: 'contains', value: id },
    actions: [{ op: 'set', field: 'category', value: `cat-${id}` }],
  };
}

interface Rule {
  id: string;
  name: string;
  order: number;
  inactive: boolean;
  trigger: { field: string; op: string; value: string };
  actions: { op: string; field: string; value: string }[];
}
type RequestOptions = { method?: string; body?: { inactive: boolean } };
const api = vi.fn<(url: string, options?: RequestOptions) => Promise<unknown>>();
const toast = vi.fn();
const navigate = vi.fn();
let stored: Rule[];
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
  const page = mount(RulesPage, { global: { components: { RuleList, RuleDetail }, stubs } });
  pages.push(page);
  return page;
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = [rule('groceries'), rule('rent', true)];
  api.mockReset();
  api.mockImplementation(async (url, options) => {
    if (url === '/api/rule')
      return ok({ items: stored.map((item) => ({ ...item })), total: stored.length });
    const id = url.slice('/api/rule/'.length);
    const item = stored.find((candidate) => candidate.id === id);
    if (!item) return failure('Rule no longer exists');
    if (options?.method === 'PATCH') {
      item.inactive = options.body!.inactive;
      return ok({ updated: true });
    }
    if (options?.method === 'DELETE') {
      stored = stored.filter((candidate) => candidate.id !== id);
      return ok({ deleted: true });
    }
    return ok({ ...item });
  });
  auth.signOut.mockResolvedValue(undefined);
  navigate.mockResolvedValue(undefined);
  vi.stubGlobal('$fetch', api);
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
    expect(button(page, 'Activate').exists()).toBe(true);
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

  it('deactivates and reactivates the selected rule using refreshed server state', async () => {
    const page = mountPage();
    await flushPromises();
    await row(page, 'Weekly groceries').trigger('click');
    await flushPromises();
    await button(page, 'Deactivate').trigger('click');
    await flushPromises();
    expect(row(page, 'Weekly groceries').text()).toContain('Inactive');
    expect(row(page, 'Monthly rent').text()).toContain('Inactive');
    expect(page.findComponent(RuleDetail).exists()).toBe(false);
    await row(page, 'Weekly groceries').trigger('click');
    await flushPromises();
    await button(page, 'Activate').trigger('click');
    await flushPromises();
    expect(row(page, 'Weekly groceries').text()).toContain('Active');
    expect(row(page, 'Weekly groceries').text()).not.toContain('Inactive');
    expect(row(page, 'Monthly rent').text()).toContain('Inactive');
  });

  it('does not delete on cancellation and removes only the confirmed rule', async () => {
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const page = mountPage();
    await flushPromises();
    await row(page, 'Weekly groceries').trigger('click');
    await flushPromises();
    await button(page, 'Delete').trigger('click');
    await flushPromises();
    expect(api.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toEqual([]);
    expect(page.findComponent(RuleDetail).text()).toContain('Weekly groceries');
    confirmation.mockReturnValue(true);
    await button(page, 'Delete').trigger('click');
    await flushPromises();
    expect(page.findComponent(RuleList).text()).not.toContain('Weekly groceries');
    expect(row(page, 'Monthly rent').exists()).toBe(true);
    expect(page.findComponent(RuleDetail).exists()).toBe(false);
  });

  it.each([
    ['Deactivate', 'envelope', () => Promise.resolve(failure('Rule is locked')), 'Rule is locked'],
    [
      'Deactivate',
      'exception',
      () => Promise.reject(new Error('Update timed out')),
      'Update timed out',
    ],
    [
      'Delete',
      'envelope',
      () => Promise.resolve(failure('Rule is referenced')),
      'Rule is referenced',
    ],
    [
      'Delete',
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
      expect(button(page, 'Deactivate').exists()).toBe(true);
      expect(row(page, 'Weekly groceries').attributes('aria-current')).toBe('true');
      await button(page, action).trigger('click');
      await flushPromises();
      expect(page.findComponent(RuleDetail).exists()).toBe(false);
      if (action === 'Delete')
        expect(page.findComponent(RuleList).text()).not.toContain('Weekly groceries');
      else expect(row(page, 'Weekly groceries').text()).toContain('Inactive');
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
