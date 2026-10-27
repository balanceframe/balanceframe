import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '../src/store.js';

const now = '2098-01-01T12:00:00.000Z';
const auth = (at = now) => ({ method: 'human-session' as const, actorId: 'owner', sessionId: 'owner-session', reauthenticatedAt: at });
const cap = (maxOperations = 2, minorUnits = '100') => ({
  window: 'day' as const, maxOperations, maxMagnitude: [{ currency: 'USD', minorUnits }],
});

describe('durable categorization delegation controls', () => {
  let store: SqliteWorkflowStore;
  let root: string;
  let spaceId: string;
  beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    root = mkdtempSync(join(tmpdir(), 'balanceframe-category-controls-'));
    store = new SqliteWorkflowStore(join(root, 'workflow.sqlite'));
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'category-controls' });
    await store.finalizeBootstrap({ claimId: 'category-controls', ownerUserId: 'owner' });
    const space = store.governance.createSpace({ actorId: 'owner', name: 'Fixture', kind: 'personal', now, auth: auth() });
    spaceId = space.id;
    store.governance.bindBudget({ spaceId, budgetId: 'budget', now, auth: auth() });
    for (const agentId of ['agent-one', 'agent-two']) store.governance.registerAgent({ spaceId, agentId, now, auth: auth() });
  });
  afterEach(() => { store.close(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
  function policy(agentId: string | null, overrides = {}, at = now) {
    const current = store.governance.listCategorizationControls({ spaceId, actorId: 'owner', now: at })
      .find((p) => p.agentId === agentId);
    return store.governance.setCategorizationControls({ spaceId, agentId, expectedVersion: current?.version ?? null,
      policy: { enabled: true, stopped: false, cooldownSeconds: 0, caps: [cap()], ...overrides }, now: at, auth: auth(at) });
  }
  function enable(overrides = {}) { policy(null, overrides); policy('agent-one'); policy('agent-two'); }
  function dispatch(proposalId = 'proposal-one', overrides = {}) {
    return store.governance.admitCategorizationDispatch({ spaceId, budgetId: 'budget', agentId: 'agent-one',
      delegationId: 'delegation', delegationVersion: '1', proposalId, payloadHash: proposalId + ':hash',
      idempotencyKey: proposalId + ':key', amount: { minorUnits: '40', currency: 'USD' }, now, ...overrides });
  }
  function verify(proposalId = 'proposal-one') { store.governance.recordCategorizationVerified(proposalId + ':key'); }

  it('defaults absent parent and agent policies to denied', () => {
    expect(() => dispatch()).toThrow(/disabled/i);
    policy(null); expect(() => dispatch()).toThrow(/disabled/i);
  });
  it('requires recent human management authority and compare-and-swap version', () => {
    const current = policy(null);
    expect(() => store.governance.setCategorizationControls({ spaceId, agentId: null, expectedVersion: null,
      policy: current.policy, now, auth: auth() })).toThrow(/version conflict/i);
    expect(() => store.governance.setCategorizationControls({ spaceId, agentId: null, expectedVersion: current.version,
      policy: current.policy, now: '2098-01-01T12:06:00.000Z', auth: auth() })).toThrow(/reauthenticated/i);
  });
  it('serializes admission with parent and per-agent stops', () => {
    enable(); policy(null, { stopped: true }); expect(() => dispatch()).toThrow(/stopped/i);
    policy(null); policy('agent-one', { stopped: true }); expect(() => dispatch()).toThrow(/stopped/i);
    policy('agent-one'); dispatch(); policy(null, { stopped: true });
    expect(() => dispatch('proposal-two')).toThrow(/stopped/i);
  });
  it('keeps uncertain handoffs held after reopen and UTC rollover', () => {
    enable(); dispatch(); store.close(); store = new SqliteWorkflowStore(join(root, 'workflow.sqlite'));
    expect(() => dispatch('proposal-two', { now: '2098-01-02T12:00:00.000Z' })).toThrow(/uncertain/i);
    verify(); expect(() => dispatch('proposal-two', { now: '2098-01-02T12:00:00.000Z' })).not.toThrow();
  });
  it('shares parent counters across agents, versions and credentials', () => {
    enable({ caps: [cap(1)] }); dispatch(); verify(); policy(null, { caps: [cap(1)] });
    expect(() => dispatch('proposal-two', { agentId: 'agent-two', delegationId: 'replacement', delegationVersion: '2' })).toThrow(/limit/i);
  });
  it('never resets per-agent usage when delegation or parent policy changes', () => {
    enable({ caps: [cap(10, '1000')] }); policy('agent-one', { caps: [cap(1)] }); dispatch(); verify();
    policy('agent-one', { caps: [cap(1)] });
    expect(() => dispatch('proposal-two', { delegationId: 'replacement', delegationVersion: '2' })).toThrow(/limit/i);
  });
  it('charges absolute incoming and outgoing magnitudes without netting', () => {
    enable(); dispatch('first', { amount: { minorUnits: '-60', currency: 'USD' } });
    store.governance.recordCategorizationVerified('first:key');
    expect(() => dispatch('second', { amount: { minorUnits: '41', currency: 'USD' } })).toThrow(/limit/i);
    expect(() => dispatch('second', { amount: { minorUnits: '40', currency: 'USD' } })).not.toThrow();
  });
  it('requires an explicit currency cap without cross-currency conversion', () => {
    enable(); expect(() => dispatch('one', { amount: { minorUnits: '1', currency: 'EUR' } })).toThrow(/currency/i);
  });
  it.each(['day', 'week', 'month'] as const)('enforces the UTC %s window', (window) => {
    enable({ caps: [{ ...cap(1), window }] }); dispatch(); verify();
    const at = window === 'day' ? '2098-01-02T00:00:00.000Z' : window === 'week' ? '2098-01-06T00:00:00.000Z' : '2098-02-01T00:00:00.000Z';
    expect(() => dispatch('second', { agentId: 'agent-two', now: at })).not.toThrow();
  });
  it('intersects configured day, week and month limits', () => {
    enable({ caps: [{ ...cap(5), window: 'day' }, { ...cap(1), window: 'week' }, { ...cap(5), window: 'month' }] });
    dispatch(); verify(); expect(() => dispatch('two', { now: '2098-01-02T12:00:00.000Z' })).toThrow(/limit/i);
  });
  it('checks cooldown across replacement policies and calendar rollover', () => {
    enable(); policy('agent-one', { cooldownSeconds: 120 }); dispatch(); verify();
    policy('agent-one', { cooldownSeconds: 120 });
    expect(() => dispatch('two', { now: '2098-01-01T12:01:59.999Z' })).toThrow(/cooldown/i);
    expect(() => dispatch('two', { now: '2098-01-01T12:02:00.000Z' })).not.toThrow();
  });
  it('deduplicates only identical admitted effects and refuses a second dispatch', () => {
    enable(); dispatch(); expect(() => dispatch()).toThrow(/already admitted/i);
    expect(() => dispatch('proposal-one', { payloadHash: 'different' })).toThrow(/identity/i);
    verify(); expect(() => dispatch()).toThrow(/already admitted/i);
  });
  it.each(['9223372036854775808', '1.5', '01', 'NaN'])('rejects noncanonical or overflowing input %s', (minorUnits) => {
    enable(); expect(() => dispatch('one', { amount: { minorUnits, currency: 'USD' } })).toThrow(/amount/i);
  });
  it('retains and discloses charged policy/accounting records during scoped deletion', async () => {
    enable(); dispatch();
    const result = await store.deleteScopeData('workflow', { spaceId, budgetId: 'budget', actorId: 'owner' });
    expect(result.retained.reasons).toContain('3 categorization control policy record(s) retained with administrator attribution');
    expect(result.retained.reasons).toContain('1 delegated categorization dispatch record(s) retained to preserve shared limits and uncertain outcomes');
    expect(() => dispatch('two')).toThrow(/uncertain/i);
  });
  it('quarantines restored automation without clearing charged or uncertain history', () => {
    enable(); dispatch();
    const restored = SqliteWorkflowStore.restoreFromBackup({ backupPath: join(root, 'workflow.sqlite'),
      destinationPath: join(root, 'restored.sqlite'), now, authorize: () => true });
    try {
      const policies = restored.governance.listCategorizationControls({ spaceId, actorId: 'owner', now });
      expect(policies).toHaveLength(3);
      expect(policies.every((value) => !value.policy.enabled && value.policy.stopped)).toBe(true);
      expect(store.governance.listCategorizationControls({ spaceId, actorId: 'owner', now }).every((value) => value.policy.enabled)).toBe(true);
      expect(() => restored.governance.admitCategorizationDispatch({ spaceId, budgetId: 'budget', agentId: 'agent-one',
        delegationId: 'delegation', delegationVersion: '1', proposalId: 'two', payloadHash: 'two:hash', idempotencyKey: 'two:key',
        amount: { minorUnits: '1', currency: 'USD' }, now })).toThrow(/disabled/i);
    } finally { restored.close(); }
  });
  it('shares atomic charges between independent SQLite connections', () => {
    enable({ caps: [cap(1)] });
    const second = new SqliteWorkflowStore(join(root, 'workflow.sqlite'));
    try {
      dispatch(); verify();
      expect(() => second.governance.admitCategorizationDispatch({ spaceId, budgetId: 'budget', agentId: 'agent-two',
        delegationId: 'second', delegationVersion: '2', proposalId: 'two', payloadHash: 'two:hash', idempotencyKey: 'two:key',
        amount: { minorUnits: '1', currency: 'USD' }, now })).toThrow(/limit/i);
    } finally { second.close(); }
  });
  it('does not reset an ISO week at the year boundary', () => {
    enable({ caps: [{ ...cap(1), window: 'week' }] });
    dispatch('first', { now: '2098-12-31T23:59:59.999Z' }); store.governance.recordCategorizationVerified('first:key');
    expect(() => dispatch('two', { now: '2099-01-01T00:00:00.000Z' })).toThrow(/limit/i);
  });
  it('counts zero-valued operations and never permits a zero operation cap', () => {
    enable({ caps: [cap(0)] }); expect(() => dispatch('zero', { amount: { minorUnits: '0', currency: 'USD' } })).toThrow(/limit/i);
    policy(null, { caps: [cap(1, '0')] }); expect(() => dispatch('zero', { amount: { minorUnits: '0', currency: 'USD' } })).not.toThrow();
  });
  it('preserves used magnitude when a human lowers or replaces a policy', () => {
    enable(); dispatch(); verify(); policy(null, { caps: [cap(10, '20')] });
    expect(() => dispatch('two', { amount: { minorUnits: '0', currency: 'USD' } })).toThrow(/limit/i);
  });
  it.each([
    { enabled: true, caps: [] },
    { caps: [cap(), cap()] },
    { caps: [{ ...cap(), maxMagnitude: [{ currency: 'USD', minorUnits: '1' }, { currency: 'USD', minorUnits: '2' }] }] },
    { cooldownSeconds: -1 }, { arbitraryAllowance: '1000000000' },
  ])('rejects malformed control policies without creating a new version: %j', (invalid) => {
    expect(() => policy(null, invalid)).toThrow();
    expect(store.governance.listCategorizationControls({ spaceId, actorId: 'owner', now })).toEqual([]);
  });
  it('accepts the exact supported maximum without rounding or overflowing', () => {
    const minorUnits = '9223372036854775807';
    enable({ caps: [cap(1, minorUnits)] }); policy('agent-one', { caps: [cap(1, minorUnits)] });
    expect(() => dispatch('maximum', { amount: { minorUnits, currency: 'USD' } })).not.toThrow();
  });
  it('does not disclose financial admissions through the control-policy listing', () => {
    enable(); dispatch(); const rows = store.governance.listCategorizationControls({ spaceId, actorId: 'owner', now });
    expect(JSON.stringify(rows)).not.toContain('proposal-one');
    expect(JSON.stringify(rows)).not.toContain('admittedAt');
  });
});
