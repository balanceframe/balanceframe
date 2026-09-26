import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { PublicLiquidityView, PublicSpendSession } from '@balanceframe/application';
import type {
  RedactedStoredProspectiveClaim,
  StoredProspectiveClaim,
  VisibleStoredProspectiveClaim,
} from '@balanceframe/workflow-store';
import ProspectiveClaimPanel from '../../app/components/ProspectiveClaimPanel.vue';

const fetchMock = vi.fn();
vi.stubGlobal('$fetch', fetchMock);

const ok = (result: unknown) => ({ status: 'ok', result });
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });

const session = {
  id: 'session-1',
  version: 7,
  card: {
    cart: {
      total: money('2750'),
      categoryCharges: [
        { categoryId: 'food', amount: money('1250') },
        { categoryId: 'home', amount: money('1500') },
      ],
      accountCharges: [{ accountId: 'checking', amount: money('2750') }],
    },
  },
} as PublicSpendSession;

const catalog = {
  categories: [
    { id: 'food', name: 'Food' },
    { id: 'home', name: 'Home' },
  ],
  accounts: [{ id: 'checking', name: 'Checking' }],
} as PublicLiquidityView;

function visibleClaim(
  overrides: Partial<VisibleStoredProspectiveClaim> = {},
): VisibleStoredProspectiveClaim {
  return {
    claimId: 'claim-own',
    kind: 'reservation',
    sourceId: 'session:session-1:7',
    scope: { kind: 'category', id: 'food' },
    amount: money('1250'),
    status: 'active',
    effectiveFrom: '2026-09-26T10:00:00.000Z',
    expiresAt: '2026-09-26T12:00:00.000Z',
    visibility: 'visible',
    policyVersion: 'policy-1',
    snapshotId: 'snapshot-1',
    mode: 'block',
    lifecycleState: 'active',
    ...overrides,
  };
}

const redactedClaim: RedactedStoredProspectiveClaim = {
  claimId: null,
  kind: 'commitment',
  sourceId: null,
  scope: { kind: 'account', id: null },
  amount: null,
  status: 'active',
  effectiveFrom: '2026-09-26T10:00:00.000Z',
  expiresAt: '2026-09-26T18:00:00.000Z',
  visibility: 'redacted',
  policyVersion: null,
  snapshotId: null,
  mode: 'inform',
  lifecycleState: 'active',
};

const globals = {
  stubs: {
    UButton: { template: '<button type="button"><slot /></button>' },
    UCard: { template: '<article><slot /><slot name="header" /></article>' },
  },
};
const wrappers: VueWrapper[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    ok([
      visibleClaim(),
      visibleClaim({
        claimId: 'claim-consumed',
        kind: 'commitment',
        sourceId: 'session:other-session:3',
        status: 'released',
        lifecycleState: 'consumed',
      }),
      redactedClaim,
    ]),
  );
});
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

function mountPanel() {
  const wrapper = mount(ProspectiveClaimPanel, {
    props: { session, catalog },
    global: globals,
  });
  wrappers.push(wrapper);
  return wrapper;
}

describe('ProspectiveClaimPanel', () => {
  it('creates a claim with the selected native Card scope and never sends a client amount', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    fetchMock.mockResolvedValueOnce(ok(visibleClaim({ claimId: 'claim-new', sourceId: 'session:session-1:7' })));

    await wrapper.get('[data-testid="claim-kind"]').setValue('commitment');
    await wrapper.get('[data-testid="claim-scope"]').setValue('category:home');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    const [url, options] = fetchMock.mock.calls[1]!;
    expect(url).toBe('/api/liquidity/claims');
    expect(options.method).toBe('POST');
    expect(options.body).toEqual({
      sessionId: 'session-1',
      expectedSessionVersion: 7,
      kind: 'commitment',
      scope: { kind: 'category', id: 'home' },
      idempotencyKey: expect.any(String),
    });
    expect(options.body).not.toHaveProperty('amount');
    expect(JSON.stringify(options.body)).not.toContain('1500');
    expect(wrapper.text()).toContain('15.00 USD');
  });

  it('shows visible lifecycle details and releases only the active self-owned claim', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.text()).toContain('reservation');
    expect(wrapper.text()).toContain('block');
    expect(wrapper.text()).toContain('session-1:7');
    expect(wrapper.text()).toContain('Active');
    expect(wrapper.text()).toContain('Expires');
    expect(wrapper.get('[data-testid="claim-claim-consumed-status"]').text()).toContain('Consumed');
    expect(wrapper.find('[data-testid="release-claim-claim-consumed"]').exists()).toBe(false);

    fetchMock.mockResolvedValueOnce(ok(visibleClaim({ status: 'released', lifecycleState: 'released' })));
    await wrapper.get('[data-testid="release-claim-claim-own"]').trigger('click');
    await flushPromises();

    const [url, options] = fetchMock.mock.calls[1]!;
    expect(url).toBe('/api/liquidity/claims/claim-own/release');
    expect(options.method).toBe('POST');
    expect(options.body).toEqual({ idempotencyKey: expect.any(String) });
    expect(options.body).not.toHaveProperty('amount');
    expect(wrapper.get('[data-testid="claim-claim-own-status"]').text()).toContain('Released');
    expect(wrapper.find('[data-testid="release-claim-claim-own"]').exists()).toBe(false);
  });
  it('releases an active self-owned claim from any saved-session version', async () => {
    const oldVersionClaim = visibleClaim({
      claimId: 'claim-old-version',
      sourceId: 'session:session-1:6',
    });
    fetchMock.mockResolvedValueOnce(ok([oldVersionClaim]));
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.find('[data-testid="release-claim-claim-old-version"]').exists()).toBe(true);
    fetchMock.mockResolvedValueOnce(ok({ ...oldVersionClaim, status: 'released', lifecycleState: 'released' }));
    await wrapper.get('[data-testid="release-claim-claim-old-version"]').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/liquidity/claims/claim-old-version/release',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(wrapper.get('[data-testid="claim-claim-old-version-status"]').text()).toContain('Released');
  });
  it('does not release an active claim belonging to another session id', async () => {
    const foreignClaim = visibleClaim({
      claimId: 'claim-foreign-session',
      sourceId: 'session:other-session:6',
    });
    fetchMock.mockResolvedValueOnce(ok([foreignClaim]));
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.find('[data-testid="release-claim-claim-foreign-session"]').exists()).toBe(false);
  });

  it('keeps redacted claim identity and scope details hidden and offers no release control', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.get('[data-testid="restricted-claim"]').text()).toContain('details hidden');
    expect(wrapper.text()).not.toContain('claim-secret');
    expect(wrapper.text()).not.toContain('private-account');
    expect(wrapper.text()).not.toContain('2,500');
    expect(wrapper.find('[data-testid="release-claim-redacted"]').exists()).toBe(false);
  });

  it('does not expose a consume control because only trusted ledger evidence can consume a claim', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    expect(wrapper.text()).toContain('trusted ledger evidence');
    expect(wrapper.findAll('button').some((button) => /consume/i.test(button.text()))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/consume'))).toBe(false);
  });

  it('exposes refresh and an accessible retry error state', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    fetchMock.mockRejectedValueOnce(new Error('claims unavailable'));

    await wrapper.get('[data-testid="refresh-claims"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toContain('claims unavailable');
    expect(wrapper.get('[data-testid="retry-claims"]').attributes('type')).toBe('button');
    expect(wrapper.get('[data-testid="refresh-claims"]').attributes('aria-label')).toBe(
      'Refresh shared claims',
    );
  });
});
