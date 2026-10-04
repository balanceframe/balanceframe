import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore } from '../../../../packages/workflow-store/src/store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import type * as SpaceContext from '../../server/utils/space-context';
import type * as WorkflowUtils from '../../server/utils/workflow-store';

interface Request extends EventWithContext {
  headers: Record<string, string>;
  cookies: Record<string, string>;
}
// Exercise the current source authority rather than a previously built workspace package.
vi.mock('@balanceframe/workflow-store', () => ({ SqliteWorkflowStore }));
vi.mock('h3', () => ({
  getHeader: (event: Request, name: string) => event.headers[name.toLowerCase()],
  getCookie: (event: Request, name: string) => event.cookies[name],
  setResponseStatus: vi.fn(),
  setHeader: vi.fn(),
}));

const now = '2098-01-01T12:00:00.000Z';
const auth = (actorId: string) => ({ method: 'human-session' as const, actorId, sessionId: `session:${actorId}`, reauthenticatedAt: now });

describe('explicit selected space authority', () => {
  let store: SqliteWorkflowStore;
  let request: Request;
  let spaceId: string;
  let select: typeof SpaceContext.requireSelectedSpace;
  let authorize: typeof WorkflowUtils.requireAuthorization;

  beforeEach(async () => {
    // Dynamic imports reload the actual singleton; static imports would share closed stores.
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    request = {
      headers: {}, cookies: {},
      context: { runtimeConfig: { workflowDbPath: ':memory:' }, auth: {
        authenticated: true, actorId: 'owner', principalType: 'human', method: 'session',
        sessionId: 'session:owner', user: { id: 'owner' },
      } },
    };
    const utils = await import('../../server/utils/workflow-store');
    const result = utils.getWorkflowStore(request);
    if ('error' in result) throw new Error(result.error);
    store = result.store;
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'selected-space-fixture' });
    await store.finalizeBootstrap({ claimId: 'selected-space-fixture', ownerUserId: 'owner' });
    const space = store.governance.createSpace({ actorId: 'owner', name: 'Household', kind: 'shared', now, auth: auth('owner') });
    spaceId = space.id;
    store.governance.bindBudget({ spaceId, budgetId: 'budget', now, auth: auth('owner') });
    if (!store.governance.getPolicy({ spaceId })) store.governance.setPolicy({ spaceId, expectedVersion: null, policy: { minimumApprovers: 1, approvalThresholds: [] }, now, auth: auth('owner') });
    select = (await import('../../server/utils/space-context')).requireSelectedSpace;
    authorize = utils.requireAuthorization;
  });
  afterEach(() => { store?.close(); vi.useRealTimers(); });

  it('requires explicit selection; body or ambient owner rights cannot select a space', async () => {
    request.context.body = { spaceId, budgetId: 'budget' };
    expect(await select(request)).toMatchObject({ ok: false, response: { error: { code: 'SPACE_SELECTION_REQUIRED' } } });
  });

  it('resolves a selected header to the current membership and verified session', async () => {
    request.headers['x-balanceframe-space'] = spaceId;
    expect(await select(request)).toMatchObject({ ok: true, space: { id: spaceId, budgetId: 'budget' }, membership: { actorId: 'owner' }, auth: { method: 'session', actorId: 'owner', sessionId: 'session:owner' } });
  });

  it('accepts explicit cookie selection but never falls back from an invalid header', async () => {
    request.cookies.balanceframe_space = spaceId;
    expect(await select(request)).toMatchObject({ ok: true, space: { id: spaceId } });
    request.headers['x-balanceframe-space'] = 'unknown-space';
    expect(await select(request)).toMatchObject({ ok: false });
  });

  it('rechecks membership revocation on every request and never restores old grants on rejoin', async () => {
    await store.upsertActorMembership('member', 'active', ['*'], '*');
    const membership = store.governance.addMembership({ spaceId, actorId: 'member', validFrom: now, now, auth: auth('owner') });
    store.governance.provisionResourceGrant({ spaceId, actorId: 'member', membershipId: membership.id, budgetId: 'budget', capability: 'observe', resourceKind: 'budget', resourceId: 'budget', granted: true, now });
    request.context.auth = { authenticated: true, actorId: 'member', method: 'session', principalType: 'human', sessionId: 'session:member', user: { id: 'member' } };
    request.headers['x-balanceframe-space'] = spaceId;
    expect(await authorize(request, 'observe', 'budget:budget')).toMatchObject({ ok: true });
    store.governance.revokeMembership({ membershipId: membership.id, spaceId, now, auth: auth('owner') });
    expect(await select(request)).toMatchObject({ ok: false });
    store.governance.addMembership({ spaceId, actorId: 'member', validFrom: now, now, auth: auth('owner') });
    expect(await authorize(request, 'observe', 'budget:budget')).toMatchObject({ ok: false });
  });

  it('denies alternate budgets and registry wildcard capabilities even for the instance owner', async () => {
    request.headers['x-balanceframe-space'] = spaceId;
    expect(await authorize(request, 'observe', 'budget:other')).toMatchObject({ ok: false });
    expect(await authorize(request, 'observe', 'budget:budget')).toMatchObject({ ok: false });
    expect(await authorize(request, 'observe', '*')).toMatchObject({ ok: false });
  });

  it.each(['legacy-token', 'development'] as const)('cannot use %s authentication as governance authority', async (method) => {
    request.headers['x-balanceframe-space'] = spaceId;
    request.context.auth!.method = method;
    expect(await select(request)).toMatchObject({ ok: false });
  });
});

describe('whole financial reads use current selected-space grants', () => {
  let store: SqliteWorkflowStore;
  let actor: import('@balanceframe/workflow-store').LiquidityActor;
  let fullRead: typeof import('../../server/utils/legacy-financial-read').hasLegacyFullRead;
  beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(now);
    store = new SqliteWorkflowStore(':memory:');
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'full-read-fixture' });
    await store.finalizeBootstrap({ claimId: 'full-read-fixture', ownerUserId: 'owner' });
    const space = store.governance.createSpace({ actorId: 'owner', name: 'Household', kind: 'shared', now, auth: auth('owner') });
    store.governance.bindBudget({ spaceId: space.id, budgetId: 'budget', now, auth: auth('owner') });
    const membership = store.governance.getCurrentMembership({ spaceId: space.id, actorId: 'owner', now })!;
    actor = { actorId: 'owner', budgetId: 'budget', spaceId: space.id, membershipId: membership.id,
      governancePolicyVersion: store.governance.getPolicy({ spaceId: space.id })!.version,
      auth: { method: 'session', actorId: 'owner', sessionId: 'session:owner' }, now };
    fullRead = (await import('../../server/utils/legacy-financial-read')).hasLegacyFullRead;
  });
  afterEach(() => { store?.close(); vi.useRealTimers(); });
  function grant(capability: string, restrictions: import('@balanceframe/workflow-store').ResourceGrantRestrictions = {}) {
    return store.governance.provisionResourceGrant({
      spaceId: actor.spaceId!, membershipId: actor.membershipId!, actorId: actor.actorId,
      budgetId: actor.budgetId, capability, resourceKind: 'budget', resourceId: actor.budgetId,
      granted: true, now, restrictions,
    });
  }
  it('allows exact independent observe and full-read budget rights without an owner finance bypass', async () => {
    expect(await fullRead(store, actor)).toBe(false);
    grant('observe');
    expect(await fullRead(store, actor)).toBe(false);
    grant('full-read');
    expect(await fullRead(store, actor)).toBe(true);
  });
  it('retracts full raw read immediately after scoped rights revocation', async () => {
    grant('observe'); grant('full-read');
    expect(await fullRead(store, actor)).toBe(true);
    store.governance.setResourceGrant({
      spaceId: actor.spaceId!, actorId: actor.actorId, membershipId: actor.membershipId!,
      budgetId: actor.budgetId, resourceKind: 'budget', resourceId: actor.budgetId,
      capability: 'full-read', granted: false, now, auth: auth('owner'),
    });
    expect(await fullRead(store, actor)).toBe(false);
  });
  it('does not turn aggregate-only rights or an alternate budget into raw data authority', async () => {
    grant('observe'); grant('full-read', { aggregateOnly: true });
    expect(await fullRead(store, actor)).toBe(false);
    expect(await fullRead(store, { ...actor, budgetId: 'other' })).toBe(false);
  });
  it.each([{ accountIds: ['checking'] }, { categoryIds: ['groceries'] }])(
    'withholds whole raw ledgers from narrowed budget rights %j', async (restrictions) => {
      grant('observe'); grant('full-read', restrictions);
      expect(await fullRead(store, actor)).toBe(false);
    },
  );
});
