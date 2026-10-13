// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import type * as Application from '@balanceframe/application';
import type { ResourceGrantRestrictions, SqliteWorkflowStore } from '@balanceframe/workflow-store';
import fixture from '../../../../protocol/fixtures/representative.json';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import type { ApiEnvelope, EventWithContext } from '../../server/utils/workflow-store';
import { merchantConnectionId } from '@balanceframe/application';
import { nativeReviewFixture } from './native-review.fixture';

const sdk = vi.hoisted(() => ({ loadConfig: vi.fn(), withConnection: vi.fn() }));
vi.mock('h3', async (original) => ({
  ...(await original<typeof H3>()),
  readBody: async (event: { body: unknown }) => event.body,
}));
vi.mock('@balanceframe/application', async (original) => ({
  ...(await original<typeof Application>()),
  createDefaultConnectionManager: () => ({ loadConfig: sdk.loadConfig, withConnection: sdk.withConnection }),
}));
import list from '../../server/api/review/index.get';
import detail from '../../server/api/review/[id].get';
import group from '../../server/api/review/group.post';

const T0 = '2026-10-05T12:00:00.000Z';
const T1 = '2026-10-05T12:01:00.000Z';
const MEMBERSHIP_END = '2026-10-05T12:02:00.000Z';
const OWNER = 'baseline-review-owner';
const ACTOR = 'baseline-review-reader';
const canonical = canonicalProtocolSnapshotSchema.parse(fixture);
const transaction = canonical.transactions[0]!;
const targetCategoryId = canonical.transactions[1]!.categoryId!;
const ownerAuth = { method: 'human-session' as const, actorId: OWNER, sessionId: 'baseline-owner-session', reauthenticatedAt: T0 };
let store: SqliteWorkflowStore;
let bootstrapped = false;
let sequence = 0;
let spaceId: string;
let budgetId: string;
let membershipId: string;
let snapshot: typeof canonical;

type Request = H3.H3Event & EventWithContext & { body: unknown };
interface ConnectedReviewSource {
  config: { budgetId: string; serverUrl: string };
  budget: { id: string };
  connector: { synchronize(): Promise<ConnectedReviewSource['synchronization']> };
  synchronization: { snapshot: typeof canonical; financialSnapshot: { legacySnapshot: typeof canonical } };
}
function request(ids: readonly string[] = []): Request {
  return {
    body: { ids },
    node: {
      req: { headers: { 'x-balanceframe-space': spaceId } },
      res: { statusCode: 200, statusMessage: '', setHeader: vi.fn(), getHeader: vi.fn() },
    },
    context: {
      params: { id: ids[0] },
      runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false },
      auth: { authenticated: true, method: 'session', principalType: 'human', user: { id: ACTOR }, sessionId: 'baseline-reader-session', impersonatedBy: null },
    },
  } as unknown as Request;
}
function grant(resourceKind: 'budget' | 'account' | 'category', resourceId: string, capability: string, restrictions: ResourceGrantRestrictions = {}) {
  store.governance.setResourceGrant({ spaceId, actorId: ACTOR, membershipId, budgetId, resourceKind, resourceId, capability, granted: true, restrictions, now: T0, auth: ownerAuth });
}
async function pending(row = transaction, classifier = 'baseline') {
  const signed = BigInt(row.amount.minorUnits);
  let item = await store.createReviewItem({
    budgetId, transactionId: row.id, categoryId: targetCategoryId, classifier, provenance: 'canonical-fixture',
    sourceTransaction: { id: row.id, accountId: row.accountId, categoryId: row.categoryId, direction: signed < 0n ? 'outgoing' : 'incoming', amount: { currency: row.amount.currency, minorUnits: (signed < 0n ? -signed : signed).toString() } },
    evidence: { merchantEvidence: { rawText: 'PRIVATE-MERCHANT-SENTINEL' } },
  });
  for (const toStatus of ['suggestion_generated', 'pending_review'] as const)
    item = await store.transitionInternalReviewItem(item.id, { toStatus, actor: 'trusted-fixture', expectedVersion: item.version });
  return item;
}
function connected(): ConnectedReviewSource {
  return {
    config: { budgetId, serverUrl: 'https://actual.baseline.test' }, budget: { id: budgetId },
    connector: { synchronize: async () => ({ snapshot, financialSnapshot: { legacySnapshot: snapshot } }) },
    synchronization: { snapshot, financialSnapshot: { legacySnapshot: snapshot } },
  };
}
const routes = { list, detail, group };
type Route = keyof typeof routes;
async function call(route: Route, ids: readonly string[], event = request(ids)) {
  return routes[route](event);
}
function expectWithheld(route: Route, response: ApiEnvelope<unknown>) {
  if (route === 'list') expect(response).toMatchObject({ status: 'ok', result: { items: [], total: 0 } });
  else expect(response).toMatchObject({ status: 'error', result: null });
  expect(JSON.stringify(response)).not.toContain('PRIVATE-MERCHANT-SENTINEL');
  expect(JSON.stringify(response.result)).not.toContain('minorUnits');
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0);
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  sdk.loadConfig.mockReset(); sdk.withConnection.mockReset();
  const workflow = getWorkflowStore(request() as EventWithContext);
  if ('error' in workflow) throw new Error(workflow.error);
  store = workflow.store;
  if (!bootstrapped) {
    await store.claimBootstrap({ name: 'Baseline Review', email: 'baseline-review@example.test', claimId: 'baseline-review' });
    await store.finalizeBootstrap({ claimId: 'baseline-review', ownerUserId: OWNER });
    bootstrapped = true;
  }
  budgetId = `baseline-review-budget-${++sequence}`;
  spaceId = store.governance.createSpace({ actorId: OWNER, name: 'Baseline Review', kind: 'shared', now: T0, auth: ownerAuth }).id;
  store.governance.bindBudget({ spaceId, budgetId, now: T0, auth: ownerAuth });
  await store.upsertActorMembership(ACTOR, 'active', [], '');
  membershipId = store.governance.addMembership({ spaceId, actorId: ACTOR, validFrom: T0, validUntil: MEMBERSHIP_END, now: T0, auth: ownerAuth }).id;
  grant('budget', budgetId, 'observe');
  for (const capability of ['existence', 'history', 'name']) grant('account', transaction.accountId, capability);
  for (const id of new Set([transaction.categoryId!, targetCategoryId]))
    for (const capability of ['existence', 'name']) grant('category', id, capability);
  snapshot = { ...canonical, transactions: [{ ...transaction, amount: { currency: 'USD', minorUnits: '-60' } }] };
  sdk.loadConfig.mockImplementation(async () => ({ budgetId, serverUrl: 'https://actual.baseline.test' }));
  sdk.withConnection.mockImplementation(async (callback: (value: ConnectedReviewSource) => Promise<unknown>) => callback(connected()));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(() => store.close());

describe('ordinary Review financial and live-authority disclosure', () => {
  it.each(['list', 'detail', 'group'] as const)('%s cannot publish an obsolete native Review captured before SDK cleanup supersession', async (route) => {
    const item = await nativeReviewFixture(store, {
      scope: { spaceId, budgetId, connectionId: merchantConnectionId(connected().config) },
      transaction: snapshot.transactions[0]!, categoryId: targetCategoryId,
    });
    sdk.withConnection.mockImplementationOnce(async (callback: (value: ConnectedReviewSource) => Promise<unknown>) => {
      const result = await callback(connected());
      await store.transitionInternalReviewItem(item.id, {
        toStatus: 'superseded', actor: 'trusted-fixture', expectedVersion: item.version,
      });
      return result;
    });
    expectWithheld(route, await call(route, [item.id]));
    expect((await store.getReviewItem(item.id))?.status).toBe('superseded');
  });

  it('baseline queue and detail isolate exact native connection/space provenance without merchant capability', async () => {
    const row = snapshot.transactions[0]!;
    const selectedScope = { spaceId, budgetId, connectionId: merchantConnectionId(connected().config) };
    const foreignConnection = await nativeReviewFixture(store, {
      scope: { ...selectedScope, connectionId: merchantConnectionId({ budgetId, serverUrl: 'https://actual.other.test' }) },
      transaction: row, categoryId: targetCategoryId,
    });
    const oldSpace = store.governance.createSpace({ actorId: OWNER, name: 'Previous source space', kind: 'shared', now: T0, auth: ownerAuth });
    const foreignSpace = await nativeReviewFixture(store, {
      scope: { ...selectedScope, spaceId: oldSpace.id }, transaction: row, categoryId: targetCategoryId,
    });
    const current = await nativeReviewFixture(store, { scope: selectedScope, transaction: row, categoryId: targetCategoryId });
    expect(new Set([foreignConnection.id, foreignSpace.id, current.id]).size).toBe(3);
    expect(await list(request())).toMatchObject({ status: 'ok', result: { items: [{ reviewItem: { id: current.id } }], total: 1 } });
    expect((await detail(request([current.id]))).status).toBe('ok');
    for (const unavailable of [foreignConnection, foreignSpace])
      expect(await detail(request([unavailable.id]))).toMatchObject({ status: 'error', result: null, error: { code: 'NOT_FOUND' } });
    expect(JSON.stringify((await list(request())).result)).not.toContain('fixture-native-rule-z');
  });

  it('group refuses mixed native connection namespaces rather than disclosing partial sums/counts', async () => {
    const row = snapshot.transactions[0]!;
    const scope = { spaceId, budgetId, connectionId: merchantConnectionId(connected().config) };
    const current = await nativeReviewFixture(store, { scope, transaction: row, categoryId: targetCategoryId });
    const other = await nativeReviewFixture(store, {
      scope: { ...scope, connectionId: merchantConnectionId({ budgetId, serverUrl: 'https://actual.other.test' }) },
      transaction: row, categoryId: targetCategoryId,
    });
    expectWithheld('group', await group(request([current.id, other.id])));
  });

  it.each(['rejected', 'skipped'] as const)('historical native %s detail/group remain unavailable before SDK access', async (historicalStatus) => {
    const row = await nativeReviewFixture(store, {
      scope: { spaceId, budgetId, connectionId: merchantConnectionId(connected().config) },
      transaction: snapshot.transactions[0]!, categoryId: targetCategoryId, historicalStatus,
    });
    expectWithheld('detail', await detail(request([row.id])));
    expectWithheld('group', await group(request([row.id])));
    expect(sdk.loadConfig).not.toHaveBeenCalled();
    expect(sdk.withConnection).not.toHaveBeenCalled();
    expect(await store.getReviewItem(row.id)).toEqual(row);
  });

  it.each(['missing', 'malformed'] as const)('native %s references are unavailable before ledger reads while ordinary deterministic Review remains usable', async (invalidReference) => {
    const row = await nativeReviewFixture(store, {
      scope: { spaceId, budgetId, connectionId: merchantConnectionId(connected().config) },
      transaction: snapshot.transactions[0]!, categoryId: targetCategoryId, invalidReference,
    });
    expectWithheld('list', await list(request()));
    expectWithheld('detail', await detail(request([row.id])));
    expect(sdk.loadConfig).not.toHaveBeenCalled();
    expect(sdk.withConnection).not.toHaveBeenCalled();
    const ordinary = await pending(snapshot.transactions[0]!, 'deterministic');
    expect((await detail(request([ordinary.id]))).status).toBe('ok');
  });

  it('deterministic rows explicitly marked as native rules cannot borrow a different current namespace', async () => {
    const row = await nativeReviewFixture(store, {
      scope: { spaceId, budgetId, connectionId: merchantConnectionId({ budgetId, serverUrl: 'https://actual.other.test' }) },
      transaction: snapshot.transactions[0]!, categoryId: targetCategoryId, classifier: 'deterministic',
    });
    expectWithheld('detail', await detail(request([row.id])));
  });

  it.each(['list', 'detail', 'group'] as const)('%s remains functional without merchant capability and preserves exact large Money', async (route) => {
    const money = { currency: 'JPY', minorUnits: '-9223372036854775807' };
    snapshot = { ...canonical, transactions: [{ ...transaction, amount: money }] };
    const item = await pending(snapshot.transactions[0]!);
    const response = await call(route, [item.id]);
    expect(response.status).toBe('ok');
    expect(JSON.stringify(response.result)).toContain(money.minorUnits);
    expect(JSON.stringify(response.result)).not.toContain('PRIVATE-MERCHANT-SENTINEL');
    expect(store.liquidity.isAuthorized({ actorId: ACTOR, budgetId, spaceId, membershipId, governancePolicyVersion: store.governance.getPolicy({ spaceId })!.version, auth: { method: 'session', actorId: ACTOR, sessionId: 'baseline-reader-session' }, now: T0, resourceKind: 'budget', resourceId: budgetId, capability: 'merchant:analyze' })).toBe(false);
  });

  it.each(['list', 'detail', 'group'] as const)('%s withholds Money under a zero outgoing history ceiling', async (route) => {
    grant('account', transaction.accountId, 'history', { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '0' }] });
    const item = await pending(snapshot.transactions[0]!);
    expectWithheld(route, await call(route, [item.id]));
  });

  it.each(['gross', 'count'] as const)('group caps every actual returned Money slot including repeated item and derived total for %s', async (bound) => {
    const row = snapshot.transactions[0]!;
    const signed = BigInt(row.amount.minorUnits);
    if (bound === 'gross') grant('account', row.accountId, 'history', {
      maxGrossOutgoing: [{ currency: row.amount.currency, minorUnits: (signed < 0n ? -signed : signed).toString() }],
    });
    else grant('budget', budgetId, 'observe', { maxOperationCount: 2 });
    const item = await pending(row);
    const ids = [item.id];
    // Subtotals are derived: only duplicated ledger item slots have outgoing direction.
    if (bound === 'gross') ids.push((await pending(row, 'repeated-ledger-group-item')).id);
    expectWithheld('group', await group(request(ids)));
  });

  it.each((['list', 'group'] as const).flatMap((route) => [
    { route, bound: 'gross', restrictions: { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '100' }] } },
    { route, bound: 'count', restrictions: { maxOperationCount: 1 } },
  ]))('$route enforces the complete collection $bound ceiling, not independent row ceilings', async ({ route, restrictions }) => {
    grant('account', transaction.accountId, 'history', restrictions);
    const first = snapshot.transactions[0]!;
    const second = { ...first, id: 'baseline-second-transaction' };
    snapshot = { ...snapshot, transactions: [first, second] };
    const ids = [(await pending(first)).id, (await pending(second)).id];
    expectWithheld(route, await call(route, ids));
  });

  it.each((['list', 'group'] as const).flatMap((route) => [
    { route, bound: 'gross', restrictions: { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '100' }] } },
    { route, bound: 'count', restrictions: { maxOperationCount: 1 } },
  ]))('$route enforces $bound for repeated disclosure through distinct Review IDs of one source transaction', async ({ route, restrictions }) => {
    grant('account', transaction.accountId, 'history', restrictions);
    const row = snapshot.transactions[0]!;
    const ids = [(await pending(row)).id, (await pending(row, 'second-baseline-classifier')).id];
    expect(ids[0]).not.toBe(ids[1]);
    expect((await store.listReviewItems({ budgetId, status: 'pending_review' })).map((item) => item.id)).toEqual(expect.arrayContaining(ids));
    expectWithheld(route, await call(route, ids));
  });

  it('group withholds an overlapping split parent and child total above the outgoing ceiling', async () => {
    grant('account', transaction.accountId, 'history', {
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '150' }],
    });
    const first = snapshot.transactions[0]!;
    const second = { ...first, id: 'baseline-overlap-split-child-two' };
    const parent = { ...first, id: 'baseline-overlap-split-parent', amount: { currency: 'USD', minorUnits: '-120' }, subtransactions: [first, second] };
    snapshot = { ...snapshot, transactions: [parent] };
    const ids = [(await pending(parent)).id, (await pending(first)).id];
    expectWithheld('group', await call('group', ids));
  });

  it.each((['list', 'detail', 'group'] as const).flatMap((route) => [
    { route, bound: 'gross', restrictions: { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '100' }] } },
    { route, bound: 'count', restrictions: { maxOperationCount: 1 } },
  ]))('$route split source closure enforces $bound without counting only the requested child', async ({ route, restrictions }) => {
    grant('account', transaction.accountId, 'history', restrictions);
    const first = snapshot.transactions[0]!;
    const second = { ...first, id: 'baseline-split-child-two' };
    const parent = { ...first, id: 'baseline-split-parent', amount: { currency: 'USD', minorUnits: '-120' }, subtransactions: [first, second] };
    snapshot = { ...snapshot, transactions: [parent] };
    const ids = [(await pending(first)).id, (await pending(second)).id];
    expectWithheld(route, await call(route, route === 'detail' ? [ids[0]!] : ids));
  });

  it.each(['list', 'detail', 'group'] as const)('%s admits exact split leaf Money at the complete source ceiling without double-counting the parent', async (route) => {
    grant('account', transaction.accountId, 'history', {
      maxGrossOutgoing: [{ currency: 'USD', minorUnits: '120' }],
      maxOperationCount: route === 'group' ? 5 : 2,
    });
    const first = snapshot.transactions[0]!;
    const second = { ...first, id: 'baseline-admitted-split-child-two' };
    const parent = { ...first, id: 'baseline-admitted-split-parent', amount: { currency: 'USD', minorUnits: '-120' }, subtransactions: [first, second] };
    snapshot = { ...snapshot, transactions: [parent] };
    const ids = [(await pending(first)).id, (await pending(second)).id];
    const response = await call(route, route === 'detail' ? [ids[0]!] : ids);
    expect(response.status).toBe('ok');
    if (route === 'group') expect(response.result).toMatchObject({ totalAmount: { currency: 'USD', minorUnits: '-120' }, itemCount: 2 });
    else expect(JSON.stringify(response.result)).toContain('"minorUnits":"-60"');
  });

  it.each(['list', 'detail', 'group'] as const)('%s rechecks credential expiry after the deferred SDK source callback', async (route) => {
    const item = await pending(snapshot.transactions[0]!);
    const event = request([item.id]);
    Object.assign(event.context.auth!, { credentialExpiresAt: T1 });
    let resume!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    sdk.withConnection.mockImplementationOnce(async (callback: (value: ConnectedReviewSource) => Promise<unknown>) => {
      entered(); await barrier; return callback(connected());
    });
    const response = call(route, [item.id], event);
    await ready; vi.setSystemTime(T1); resume();
    expectWithheld(route, await response);
  });

  it.each(['list', 'detail', 'group'] as const)('%s rechecks finite membership after the deferred SDK source callback', async (route) => {
    const item = await pending(snapshot.transactions[0]!);
    let resume!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    sdk.withConnection.mockImplementationOnce(async (callback: (value: ConnectedReviewSource) => Promise<unknown>) => {
      entered(); await barrier; return callback(connected());
    });
    const response = call(route, [item.id]);
    await ready; vi.setSystemTime(MEMBERSHIP_END); resume();
    expectWithheld(route, await response);
  });

  it.each(['list', 'detail', 'group'] as const)('%s rechecks finite delegated authority after the deferred SDK source callback', async (route) => {
    const item = await pending(snapshot.transactions[0]!);
    const agentId = `agent:${budgetId}`;
    const credentialId = `key:${budgetId}`;
    const issuerAuth = { method: 'human-session' as const, actorId: ACTOR, sessionId: 'baseline-reader-session', reauthenticatedAt: T0 };
    for (const capability of ['delegation:manage', 'credential:manage'])
      store.governance.setResourceGrant({
        spaceId, actorId: ACTOR, membershipId, budgetId, resourceKind: 'space', resourceId: spaceId,
        capability, granted: true, now: T0, auth: ownerAuth,
      });
    store.governance.registerAgent({ spaceId, agentId, now: T0, auth: ownerAuth });
    const rights = [
      { resourceKind: 'budget' as const, resourceId: budgetId, capability: 'observe' },
      ...['existence', 'history', 'name'].map((capability) => ({ resourceKind: 'account' as const, resourceId: transaction.accountId, capability })),
      ...[...new Set([transaction.categoryId!, targetCategoryId])].flatMap((resourceId) => ['existence', 'name'].map((capability) => ({ resourceKind: 'category' as const, resourceId, capability }))),
    ];
    const delegation = store.governance.delegate({ spaceId, agentId, issuerMembershipId: membershipId, expectedVersion: null, rights, validFrom: T0, validUntil: T1, now: T0, auth: issuerAuth });
    store.governance.registerCredentialBinding({ spaceId, credentialId, credentialOwnerId: ACTOR, principalType: 'agent', principalId: agentId, delegationId: delegation.id, expectedDelegationVersion: delegation.version, now: T0, auth: issuerAuth });
    const event = request([item.id]);
    event.context.auth = { authenticated: true, actorId: agentId, user: { id: ACTOR }, method: 'api-key', principalType: 'agent', credentialId, credentialOwnerId: ACTOR, delegationId: delegation.id, delegationVersion: delegation.version, impersonatedBy: null };
    let resume!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    sdk.withConnection.mockImplementationOnce(async (callback: (value: ConnectedReviewSource) => Promise<unknown>) => {
      entered(); await barrier; return callback(connected());
    });
    const response = call(route, [item.id], event);
    await ready; vi.setSystemTime(T1); resume();
    expectWithheld(route, await response);
  });
});
