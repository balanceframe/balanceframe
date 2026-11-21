import type { VersionedGovernancePolicy } from '@balanceframe/workflow-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, onMounted, ref } from 'vue';
import SpacesPage from '../../app/pages/spaces.vue';

const stubs = {
  UContainer: { template: '<main><slot /></main>' },
};

interface RequestOptions {
  method?: string;
  body?: Record<string, unknown>;
}
const api = vi.fn<(url: string, options?: RequestOptions) => Promise<unknown>>();
const proofFetch = vi.fn();
const pages: VueWrapper[] = [];
let memberships: Record<string, unknown>[];
let policyConflict = false;
let currentPolicy: VersionedGovernancePolicy;

function ok(result: unknown) {
  return { status: 'ok', result, error: null };
}

function boundCategorizationFixture() {
  const previous = api.getMockImplementation()!;
  api.mockImplementation((url, options) => url.endsWith('/connection')
    ? Promise.resolve(ok({ budgetBound: true })) : previous(url, options));
}

function mountPage() {
  const page = mount(SpacesPage, { global: { stubs } });
  pages.push(page);
  return page;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.mockReset();
  proofFetch.mockReset();
  proofFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'success' })));
  vi.stubGlobal('fetch', proofFetch);
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: false } }));
  memberships = [{
    id: 'membership-owner', spaceId: 'space-selected', actorId: 'owner', grantedBy: 'owner',
    validFrom: '2098-01-01T00:00:00.000Z', validUntil: null, revokedAt: null,
    createdAt: '2098-01-01T00:00:00.000Z', origin: 'created',
  }];
  policyConflict = false;
  currentPolicy = {
    minimumApprovers: 1, approvalThresholds: [], operationApprovers: {},
    assistanceMaximum: 'analysis_only', spaceId: 'space-selected', version: '1',
    actorId: 'owner', createdAt: '2098-01-01T00:00:00.000Z',
  };
  api.mockImplementation(async (url, options) => {
    if (url === '/api/spaces') return ok({
      spaces: [{ id: 'space-selected', name: 'Household', kind: 'shared' }],
      selectedSpaceId: 'space-selected',
    });
    if (url === '/api/spaces/space-selected') return ok({
      space: {
        id: 'space-selected', name: 'Household', kind: 'shared', createdAt: '2098-01-01T00:00:00.000Z',
        membership: { id: 'membership-owner', actorId: 'owner', validFrom: '2098-01-01T00:00:00.000Z', validUntil: null, revokedAt: null, origin: 'created' },
      },
    });
    if (url.endsWith('/memberships') && options?.method !== 'POST') return ok({ memberships });
    if (url.endsWith('/memberships') && options?.method === 'POST') {
      const member = {
        id: 'membership-member', spaceId: 'space-selected', actorId: options.body?.actorId,
        grantedBy: 'owner', validFrom: options.body?.validFrom, validUntil: null, revokedAt: null,
        createdAt: '2098-01-01T00:00:00.000Z', origin: 'managed',
      };
      memberships = [...memberships, member];
      return ok({ membership: member });
    }
    if (url.endsWith('/policy') && options?.method === 'PUT' && policyConflict) return {
      status: 'error',
      result: null,
      error: { code: 'POLICY_VERSION_CONFLICT', message: 'The governance version changed. Reload the current state and retry.', retryable: false },
    };
    if (url.endsWith('/policy') && options?.method === 'PUT') {
      currentPolicy = {
        ...currentPolicy,
        ...(options.body?.policy as Partial<VersionedGovernancePolicy>),
        spaceId: 'space-selected', version: '2', actorId: 'owner', createdAt: '2098-01-01T00:00:00.000Z',
      };
      return ok({ policy: currentPolicy });
    }
    if (url.endsWith('/policy') && options?.method !== 'PUT') return ok({
      policy: currentPolicy,
      history: [],
    });
    if (url.endsWith('/grants')) return ok({ grants: [] });
    if (url.endsWith('/agents')) return ok({ agents: [] });
    if (url.endsWith('/delegations')) return ok({ delegations: [] });
    if (url.endsWith('/categorization-controls') && options?.method === 'PUT') return ok({ policy: {
      spaceId: 'space-selected', budgetId: 'budget', agentId: options.body?.agentId, version: 'controls-v1',
      actorId: 'owner', createdAt: '2098-01-01T00:00:00.000Z', policy: options.body?.policy,
    } });
    if (url.endsWith('/categorization-controls')) return ok({ policies: [] });
    if (url.endsWith('/credentials')) return ok({ credentials: [] });
    if (url.endsWith('/audit')) return ok({ records: [], total: 0, limit: 50, offset: 0 });
    if (url.endsWith('/connection')) return ok({ budgetBound: false });
  });
  vi.stubGlobal('$fetch', api);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('onMounted', onMounted);
});

afterEach(() => {
  for (const page of pages.splice(0)) page.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('space governance page', () => {
  it('keeps categorization controls disabled and stopped until an explicit reauthenticated save', async () => {
    boundCategorizationFixture();
    const page = mountPage(); await flushPromises();
    expect(page.text()).toContain('Categorization automation limits');
    expect(page.get<HTMLInputElement>('[aria-label="Enable delegated categorization"]').element.checked).toBe(false);
    expect(page.get<HTMLInputElement>('[aria-label="Stop delegated categorization"]').element.checked).toBe(true);
    await page.get('form[data-testid="categorization-controls"]').trigger('submit'); await flushPromises();
    expect(api.mock.calls.some(([url, options]) => url.endsWith('/categorization-controls') && options?.method === 'PUT')).toBe(false);
    expect(page.text()).toContain('Reauthenticate');
  });
  it('sends exact calendar/currency caps without changing human approval policy', async () => {
    boundCategorizationFixture();
    const page = mountPage(); await flushPromises();
    await page.get('#governance-password').setValue('one-time-password');
    await page.get('button[aria-label="Reauthenticate for space changes"]').trigger('click'); await flushPromises();
    const caps = [{ window: 'day', maxOperations: 2, maxMagnitude: [{ currency: 'USD', minorUnits: '100' }] }];
    await page.get('[aria-label="Categorization UTC caps"]').setValue(JSON.stringify(caps));
    await page.get('[aria-label="Enable delegated categorization"]').setValue(true);
    await page.get('[aria-label="Stop delegated categorization"]').setValue(false);
    await page.get('form[data-testid="categorization-controls"]').trigger('submit'); await flushPromises();
    const request = api.mock.calls.find(([url, options]) => url.endsWith('/categorization-controls') && options?.method === 'PUT');
    expect(request?.[1]?.body).toEqual({ agentId: null, expectedVersion: null,
      policy: { enabled: true, stopped: false, cooldownSeconds: 0, caps } });
    expect(currentPolicy.minimumApprovers).toBe(1);
    expect(page.text()).toContain('Independent human approvals remain required');
  });
  it('refuses malformed categorization caps before making a control write', async () => {
    boundCategorizationFixture();
    const page = mountPage(); await flushPromises();
    await page.get('[aria-label="Categorization UTC caps"]').setValue('{broken');
    await page.get('form[data-testid="categorization-controls"]').trigger('submit'); await flushPromises();
    expect(api.mock.calls.some(([url, options]) => url.endsWith('/categorization-controls') && options?.method === 'PUT')).toBe(false);
    expect(page.text()).toContain('Categorization caps');
  });

  it('lets a scoped delegation manager stop/configure limits without connection or agent management', async () => {
    const previous = api.getMockImplementation()!;
    api.mockImplementation((url, options) => {
      if (url.endsWith('/connection') || url.endsWith('/agents')) return Promise.resolve({ status: 'error', result: null,
        error: { code: 'FORBIDDEN', message: 'Not authorized', retryable: false } });
      if (url.endsWith('/delegations')) return Promise.resolve(ok({ delegations: [{ id: 'delegation', agentId: 'scoped-agent',
        issuerMembershipId: 'membership-owner', version: '1', rights: [], validFrom: '2098-01-01T00:00:00.000Z', validUntil: null, revokedAt: null }] }));
      return previous(url, options);
    });
    const page = mountPage(); await flushPromises();
    expect(page.find('form[data-testid="categorization-controls"]').exists()).toBe(true);
    expect(page.find('option[value="scoped-agent"]').exists()).toBe(true);
    await page.get('[aria-label="Categorization control scope"]').setValue('scoped-agent');
    await page.get('#governance-password').setValue('one-time-password');
    await page.get('button[aria-label="Reauthenticate for space changes"]').trigger('click'); await flushPromises();
    await page.get('form[data-testid="categorization-controls"]').trigger('submit'); await flushPromises();
    expect(api.mock.calls.find(([url, options]) => url.endsWith('/categorization-controls') && options?.method === 'PUT')?.[1]?.body)
      .toEqual({ agentId: 'scoped-agent', expectedVersion: null, policy: { enabled: false, stopped: true, cooldownSeconds: 0, caps: [] } });
    expect(api.mock.calls.some(([url, options]) => /\/(?:connection|agents|grants)$/.test(url) && options?.method !== undefined)).toBe(false);
  });

  it('requires a deliberate budget choice before binding a discovered Actual budget', async () => {
    const page = mountPage();
    await flushPromises();
    await page.get('#governance-password').setValue('one-time-password');
    await page.get('button[aria-label="Reauthenticate for space changes"]').trigger('click');
    await flushPromises();
    api.mockResolvedValueOnce(ok({ budgets: [
      { id: 'personal-budget', groupId: 'personal-group', name: 'Personal', encrypted: false },
      { id: 'shared-budget', groupId: 'shared-group', name: 'Shared', encrypted: false },
    ] }));
    await page.findAll('button').find((button) => button.text() === 'Discover available Actual budgets')!.trigger('click');
    await flushPromises();
    const choice = page.get('select:has(option[value="shared-budget"])');
    const bind = page.findAll('button').find((button) => button.text() === 'Connect and bind selected budget')!;
    expect((choice.element as HTMLSelectElement).value).toBe('');
    expect(bind.attributes('disabled')).toBeDefined();
    await choice.setValue('shared-budget');
    expect(bind.attributes('disabled')).toBeUndefined();
    api.mockResolvedValueOnce(ok({ connected: true }));
    await bind.trigger('click');
    await flushPromises();
    expect(api).toHaveBeenCalledWith('/api/connection', expect.objectContaining({
      method: 'POST', body: { budgetId: 'shared-budget' },
    }));
    expect(page.find('option[value="shared-budget"]').exists()).toBe(false);
  });

  it('requires explicit password reauthentication before adding a member and renders the saved period', async () => {
    const page = mountPage();
    await flushPromises();
    expect(page.text()).toContain('Household');
    expect(page.text()).toContain('owner');

    await page.get('#governance-password').setValue('one-time-password');
    await page.get('button[aria-label="Reauthenticate for space changes"]').trigger('click');
    await flushPromises();
    const reauthentication = proofFetch.mock.calls.find(([url]) => url === '/api/reauth');
    expect(reauthentication?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ password: 'one-time-password' }),
    });
    expect((page.get('#governance-password').element as HTMLInputElement).value).toBe('');

    await page.get('#member-actor-id').setValue('member-1');
    await page.get('#member-valid-from').setValue('2098-01-01T12:00');
    await page.get('form:has(#member-actor-id)').trigger('submit');
    await flushPromises();
    const mutation = api.mock.calls.find(([url, options]) => url.endsWith('/memberships') && options?.method === 'POST');
    expect(mutation?.[1]?.body).toMatchObject({ actorId: 'member-1' });
    expect(page.text()).toContain('member-1');
  });

  it('shows a stale policy compare-and-swap conflict after the server rejects the old version', async () => {
    const page = mountPage();
    await flushPromises();
    await page.get('#governance-password').setValue('one-time-password');
    await page.get('button[aria-label="Reauthenticate for space changes"]').trigger('click');
    await flushPromises();
    policyConflict = true;
    const policyForm = page.findAll('form').find((form) => form.text().includes('Save policy version'));
    if (!policyForm) throw new Error('Missing policy form');
    await policyForm.trigger('submit');
    await flushPromises();
    expect(api.mock.calls.some(([url, options]) => url === '/api/spaces/space-selected/policy' &&
      options?.method === 'PUT' && options.body?.expectedVersion === '1')).toBe(true);
    expect(page.text()).toContain('The governance version changed. Reload the current state and retry.');
  });
  it('fails closed to analysis_only for a policy response without an assistance ceiling', async () => {
    const { assistanceMaximum, ...legacyPolicy } = currentPolicy;
    expect(assistanceMaximum).toBe('analysis_only');
    currentPolicy = legacyPolicy;
    const page = mountPage();
    await flushPromises();
    const policyForm = page.findAll('form').find((form) => form.text().includes('Save policy version'));
    if (!policyForm) throw new Error('Missing policy form');
    expect(policyForm.get<HTMLSelectElement>('[aria-label="Maximum consequential-action assistance"]').element.value)
      .toBe('analysis_only');
  });

  it('exposes the authoritative consequential-action ceiling and saves it in the versioned policy', async () => {
    const page = mountPage();
    await flushPromises();
    const policyForm = page.findAll('form').find((form) => form.text().includes('Save policy version'));
    if (!policyForm) throw new Error('Missing policy form');
    const mode = policyForm.get<HTMLSelectElement>('[aria-label="Maximum consequential-action assistance"]');
    expect(mode.element.value).toBe('analysis_only');
    await mode.setValue('create_approval_proposal');
    await page.get('#governance-password').setValue('one-time-password');
    await page.get('button[aria-label="Reauthenticate for space changes"]').trigger('click');
    await flushPromises();
    await policyForm.trigger('submit');
    await flushPromises();
    const mutation = api.mock.calls.find(([url, options]) =>
      url === '/api/spaces/space-selected/policy' && options?.method === 'PUT');
    expect(mutation?.[1]?.body).toMatchObject({
      expectedVersion: '1',
      policy: { assistanceMaximum: 'create_approval_proposal' },
    });
  });

  it('preserves the existing assistance ceiling when saving another governance policy field', async () => {
    currentPolicy = { ...currentPolicy, assistanceMaximum: 'execute_approved_actions' };
    const page = mountPage();
    await flushPromises();
    const policyForm = page.findAll('form').find((form) => form.text().includes('Save policy version'));
    if (!policyForm) throw new Error('Missing policy form');
    await policyForm.get('input[type="number"]').setValue('2');
    await page.get('#governance-password').setValue('one-time-password');
    await page.get('button[aria-label="Reauthenticate for space changes"]').trigger('click');
    await flushPromises();
    await policyForm.trigger('submit');
    await flushPromises();
    const mutation = api.mock.calls.find(([url, options]) =>
      url === '/api/spaces/space-selected/policy' && options?.method === 'PUT');
    expect(mutation?.[1]?.body).toMatchObject({
      policy: { minimumApprovers: 2, assistanceMaximum: 'execute_approved_actions' },
    });
  });

  it('uses explicit disposable-demo confirmation instead of sending CONFIRM as an account password', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: true } }));
    proofFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'ready', shared: true, generation: 7, personaId: 'owner', csrfToken: 'demo-csrf',
    })));
    proofFetch.mockResolvedValueOnce(new Response(JSON.stringify({ generation: 7, reauthenticated: true })));
    const page = mountPage();
    await flushPromises();
    await page.get('#governance-password').setValue('CONFIRM');
    await page.get('button[aria-label="Reauthenticate for space changes"]').trigger('click');
    await flushPromises();
    expect(proofFetch.mock.calls.map(([path]) => path)).toEqual(['/__demo/state', '/__demo/reauth']);
    expect(proofFetch.mock.calls[1]?.[1]).toMatchObject({
      headers: { 'X-BalanceFrame-Demo-CSRF': 'demo-csrf' }, body: JSON.stringify({ expectedGeneration: 7 }),
    });
    expect(api.mock.calls.some(([path]) => path === '/api/reauth')).toBe(false);
    expect((page.get('#governance-password').element as HTMLInputElement).value).toBe('');
  });

  it('keeps governance changes unavailable after the current demo generation rejects renewal', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { demoMode: true } }));
    proofFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'ready', shared: true, generation: 7, personaId: 'owner', csrfToken: 'demo-csrf',
    })));
    proofFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'DEMO_STALE_GENERATION' } }), { status: 409 }));
    const page = mountPage();
    await flushPromises();
    await page.get('#governance-password').setValue('CONFIRM');
    await page.get('button[aria-label="Reauthenticate for space changes"]').trigger('click');
    await flushPromises();
    await page.get('#member-actor-id').setValue('member-1');
    await page.get('#member-valid-from').setValue('2098-01-01T12:00');
    await page.get('form:has(#member-actor-id)').trigger('submit');
    await flushPromises();
    expect(proofFetch.mock.calls.map(([path]) => path)).toEqual(['/__demo/state', '/__demo/reauth']);
    expect(api.mock.calls.some(([path, options]) => path.endsWith('/memberships') && options?.method === 'POST')).toBe(false);
  });
});
