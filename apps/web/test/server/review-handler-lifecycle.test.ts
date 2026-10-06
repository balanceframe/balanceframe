import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import type { ResourceGrantRestrictions, SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type * as Application from '@balanceframe/application';
import type * as MutationExecutor from '../../server/utils/mutation-executor';
import type * as Workflow from '../../server/utils/workflow-store';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { createNativeCategorizationMutationProtocol } from '../../../../packages/application/src/mutation';
import fixture from '../../../../protocol/fixtures/representative.json';
import { createDefaultExecutorFactory } from '../../server/utils/mutation-executor';
import {
  getWorkflowStore,
  setReviewMutationExecutorFactory,
} from '../../server/utils/workflow-store';
import approve from '../../server/api/review/approve.post';
import correct from '../../server/api/review/correct.post';
import reject from '../../server/api/review/reject.post';
import skip from '../../server/api/review/skip.post';
import undo from '../../server/api/review/undo.post';
import { merchantConnectionId } from '@balanceframe/application';
import { nativeReviewFixture } from './native-review.fixture';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  withConnection: vi.fn(),
  synchronize: vi.fn(),
  setTransactionCategory: vi.fn(),
}));

vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof H3>()),
  readBody: async (event: { body: unknown }) => {
    if (event.body instanceof Error) throw event.body;
    return event.body;
  },
}));
// Vitest hoists workspace mocks; source Native is required instead of stale package output.
vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal<typeof Application>()),
  createNativeCategorizationMutationProtocol:
    (await import('../../../../packages/application/src/mutation')).createNativeCategorizationMutationProtocol,
}));
vi.mock('../../server/utils/mutation-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof MutationExecutor>()),
  createMutationConnectionManager: () => ({
    loadConfig: mocks.loadConfig,
    withConnection: mocks.withConnection,
  }),
}));

const OWNER = 'review-lifecycle-owner';
const ACTOR = 'review-lifecycle-human';
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2026-10-03T12:00:00.000Z';
const snapshot = canonicalProtocolSnapshotSchema.parse({ ...fixture, snapshotDate: NOW });
const transaction = snapshot.transactions[0]!;
const currentCategoryId = transaction.categoryId!;
const categoryId = fixture.transactions[1]!.categoryId!;
const sourceAmount = BigInt(transaction.amount.minorUnits);
const sourceTransaction = {
  id: transaction.id,
  accountId: transaction.accountId,
  categoryId: transaction.categoryId ?? null,
  direction: sourceAmount < 0n ? 'outgoing' as const : 'incoming' as const,
  amount: {
    minorUnits: (sourceAmount < 0n ? -sourceAmount : sourceAmount).toString(),
    currency: transaction.amount.currency,
  },
};
const correctedCategoryId = snapshot.categories.find(({ id }) =>
  id !== currentCategoryId && id !== categoryId,
)!.id;
const routes = { approve, correct, reject, skip, undo };
type Route = keyof typeof routes;
interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}
type RequestEvent = H3.H3Event & Workflow.EventWithContext & { body: unknown };

let store: SqliteWorkflowStore;
let selectedSpaceId = '';
let budgetId = '';
let membershipId = '';
let policyVersion = '';
let ownerAuth: {
  method: 'human-session';
  actorId: string;
  sessionId: string;
  reauthenticatedAt: string;
};
let bootstrapped = false;
let spaceSequence = 0;

function response(): TestResponse {
  const headers = new Map<string, string | string[]>();
  const result: TestResponse = {
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return result;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
  };
  return result;
}

function event(
  body: unknown,
  options: { actorId?: string; spaceId?: string; reviewAndApply?: boolean; authenticated?: boolean } = {},
): RequestEvent {
  const actorId = options.actorId ?? ACTOR;
  const selectedSpace = options.spaceId === undefined ? selectedSpaceId : options.spaceId;
  const headers: Record<string, string> = { origin: ORIGIN };
  if (selectedSpace) headers['x-balanceframe-space'] = selectedSpace;
  return {
    body,
    node: { req: { headers }, res: response() },
    context: {
      auth: {
        authenticated: options.authenticated ?? true,
        user: { id: actorId },
        actorId: 'spoofed-legacy-actor',
        method: 'session',
        principalType: 'human',
        sessionId: `session:${actorId}`,
        impersonatedBy: null,
      },
      runtimeConfig: {
        workflowDbPath: ':memory:',
        devBypassAuth: false,
        ...(options.reviewAndApply ? { reviewAndApply: true } : {}),
      },
    },
  } as unknown as RequestEvent;
}

async function pending(
  includeSourceTransaction = true,
  recommendationCategoryId = categoryId,
  evidence?: Record<string, unknown>,
) {
  let item = await store.createReviewItem({
    budgetId,
    transactionId: transaction.id,
    categoryId: recommendationCategoryId,
    classifier: 'fixture-classifier',
    provenance: 'canonical-protocol-fixture',
    ...(includeSourceTransaction ? { sourceTransaction } : {}),
    ...(evidence === undefined ? {} : { evidence }),
  });
  for (const toStatus of ['suggestion_generated', 'pending_review'] as const) {
    item = await store.transitionInternalReviewItem(item.id, {
      toStatus,
      actor: 'trusted-fixture',
      expectedVersion: item.version,
    });
  }
  return item;
}

function grant(
  capability: 'categorization:execute' | 'categorization:propose',
  targetCategoryId = categoryId,
  restrictions: ResourceGrantRestrictions = {},
) {
  const resources: { resourceKind: 'budget' | 'transaction' | 'account' | 'category'; resourceId: string }[] = [
    { resourceKind: 'budget', resourceId: budgetId },
    { resourceKind: 'transaction', resourceId: transaction.id },
    { resourceKind: 'account', resourceId: transaction.accountId },
    { resourceKind: 'category', resourceId: currentCategoryId },
    { resourceKind: 'category', resourceId: categoryId },
    { resourceKind: 'category', resourceId: targetCategoryId },
  ];
  for (const resource of resources) {
    store.governance.setResourceGrant({
      spaceId: selectedSpaceId,
      actorId: ACTOR,
      budgetId,
      membershipId,
      ...resource,
      capability,
      restrictions,
      granted: true,
      now: NOW,
      auth: ownerAuth,
    });
  }
}
function grantResource(
  capability: 'categorization:execute' | 'categorization:propose',
  resourceKind: 'budget' | 'transaction' | 'account' | 'category',
  resourceId: string,
  restrictions: ResourceGrantRestrictions = {},
) {
  store.governance.setResourceGrant({
    spaceId: selectedSpaceId,
    actorId: ACTOR,
    budgetId,
    membershipId,
    resourceKind,
    resourceId,
    capability,
    restrictions,
    granted: true,
    now: NOW,
    auth: ownerAuth,
  });
}

function connectionManager() {
  return {
    loadConfig: async () => mocks.loadConfig(),
    withConnection: async <T>(
      operation: (connected: unknown) => Promise<T>,
      options?: Application.ConnectionUseOptions,
    ) => mocks.withConnection(operation, options),
  } as unknown as Application.ConnectionManager;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  vi.clearAllMocks();

  budgetId = `review-lifecycle-budget-${++spaceSequence}`;
  const workflow = getWorkflowStore(event({}) as unknown as Workflow.EventWithContext);
  if ('error' in workflow) throw new Error(workflow.error);
  store = workflow.store;
  ownerAuth = {
    method: 'human-session',
    actorId: OWNER,
    sessionId: `session:${OWNER}`,
    reauthenticatedAt: NOW,
  };
  if (!bootstrapped) {
    await store.claimBootstrap({
      name: 'Review lifecycle owner',
      email: 'review-lifecycle-owner@example.test',
      claimId: 'review-lifecycle-fixture',
    });
    await store.finalizeBootstrap({ claimId: 'review-lifecycle-fixture', ownerUserId: OWNER });
    bootstrapped = true;
  }
  const space = store.governance.createSpace({
    actorId: OWNER,
    name: 'Review lifecycle fixture',
    kind: 'shared',
    now: NOW,
    auth: ownerAuth,
  });
  selectedSpaceId = store.governance.bindBudget({
    spaceId: space.id,
    budgetId,
    now: NOW,
    auth: ownerAuth,
  }).id;
  await store.upsertActorMembership(ACTOR, 'active', [], '');
  membershipId = store.governance.addMembership({
    spaceId: selectedSpaceId,
    actorId: ACTOR,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  }).id;
  const policy = store.governance.getPolicy({ spaceId: selectedSpaceId });
  if (!policy) throw new Error('Current review governance policy is unavailable');
  policyVersion = policy.version;

  const connected = {
    config: { budgetId, serverUrl: 'https://actual.lifecycle.test' },
    budget: { id: budgetId },
    connector: {
      synchronize: mocks.synchronize,
      setTransactionCategory: mocks.setTransactionCategory,
    },
  };
  mocks.loadConfig.mockResolvedValue({ budgetId, serverUrl: 'https://actual.lifecycle.test' });
  mocks.synchronize.mockResolvedValue({ snapshot });
  mocks.withConnection.mockImplementation(async (operation) => operation(connected));
  setReviewMutationExecutorFactory(createDefaultExecutorFactory(connectionManager()));
});

afterEach(() => {
  setReviewMutationExecutorFactory(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(() => store.close());

describe('nested canonical Review source identity', () => {
  it.each(['approve', 'correct'] as const)('%s proposes the exact nested split child through real Native planning', async (route) => {
    const target = route === 'correct' ? correctedCategoryId : categoryId;
    grant('categorization:propose', target);
    const item = await pending();
    mocks.synchronize.mockResolvedValue({
      snapshot: { ...snapshot, transactions: [{ ...transaction, id: 'nested-parent', subtransactions: [{ ...transaction, id: 'nested-intermediate', subtransactions: [transaction] }] }] },
    });
    const response = await routes[route](event(
      { reviewId: item.id, ...(route === 'correct' ? { categoryId: target } : {}) }, { reviewAndApply: true },
    ));
    expect(response.status).toBe('ok');
    const proposal = await store.getProposal(response.result!.proposal.id);
    if (!proposal || proposal.operation !== 'set_category') throw new Error('Nested child proposal unavailable');
    const native = await createNativeCategorizationMutationProtocol();
    const plan = native.planSetCategory(transaction, snapshot.categories.find((category) => category.id === target)!);
    expect(proposal.payload).toMatchObject({ transactionId: transaction.id, categoryId: target, composite: { nativePayloadHash: plan.hash } });
    expect(JSON.parse(proposal.preconditions)).toMatchObject({ reviewId: item.id, nativePlan: plan });
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });

  it.each(['reject', 'skip', 'undo'] as const)('%s uses the exact nested split child for nonfinancial triage', async (route) => {
    grant('categorization:execute');
    const item = await pending();
    if (route === 'undo') expect((await routes.skip(event({ reviewId: item.id }))).status).toBe('ok');
    mocks.synchronize.mockResolvedValue({
      snapshot: { ...snapshot, transactions: [{ ...transaction, id: 'triage-parent', subtransactions: [{ ...transaction, id: 'triage-intermediate', subtransactions: [transaction] }] }] },
    });
    const response = await routes[route](event({ reviewId: item.id }));
    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({ itemId: item.id, categorizationExecuted: false, applied: false });
    expect((await store.getReviewItem(item.id))?.status).toBe(route === 'reject' ? 'rejected' : route === 'skip' ? 'skipped' : 'pending_review');
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });

  it.each(Object.keys(routes) as Route[])('%s rejects duplicate top-level/nested source identities without publishing a proposal or action', async (route) => {
    grant(route === 'approve' || route === 'correct' ? 'categorization:propose' : 'categorization:execute', correctedCategoryId);
    const item = await pending();
    if (route === 'undo') expect((await routes.skip(event({ reviewId: item.id }))).status).toBe('ok');
    const before = await store.getReviewItem(item.id);
    const actions = await store.getReviewActions(item.id);
    const proposals = (await store.listProposals()).map((proposal) => proposal.id);
    mocks.synchronize.mockResolvedValue({
      snapshot: { ...snapshot, transactions: [transaction, { ...transaction, id: 'duplicate-parent', subtransactions: [transaction] }] },
    });
    const response = await routes[route](event(
      { reviewId: item.id, ...(route === 'correct' ? { categoryId: correctedCategoryId } : {}) }, { reviewAndApply: true },
    ));
    expect(response.status).toBe('error');
    expect(await store.getReviewItem(item.id)).toEqual(before);
    expect(await store.getReviewActions(item.id)).toEqual(actions);
    expect((await store.listProposals()).map((proposal) => proposal.id)).toEqual(proposals);
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });
});

describe('native Review action namespace provenance', () => {
  it.each(['wrong-connection', 'wrong-space', 'historical', 'missing', 'malformed'] as const)('direct proposal executor refuses %s native provenance before SDK synchronization', async (source) => {
    grant('categorization:propose', correctedCategoryId);
    const currentConnection = merchantConnectionId({ budgetId, serverUrl: 'https://actual.lifecycle.test' });
    const spaceId = source === 'wrong-space'
      ? store.governance.createSpace({ actorId: OWNER, name: 'Old direct source namespace', kind: 'shared', now: NOW, auth: ownerAuth }).id
      : selectedSpaceId;
    const item = await nativeReviewFixture(store, {
      scope: { spaceId, budgetId, connectionId: source === 'wrong-connection'
        ? merchantConnectionId({ budgetId, serverUrl: 'https://actual.other.test' }) : currentConnection },
      transaction, categoryId,
      ...(source === 'historical' ? { historicalStatus: 'skipped' as const } : {}),
      ...(source === 'missing' || source === 'malformed' ? { invalidReference: source } : {}),
    });
    const executor = createDefaultExecutorFactory(connectionManager())(event({}, { reviewAndApply: true }));
    if (!executor) throw new Error('Direct native executor unavailable');
    const proposals = (await store.listProposals()).map((proposal) => proposal.id);
    const result = await executor(
      { reviewId: item.id, actorId: ACTOR, categoryId: correctedCategoryId, requestId: 'direct-native-scope' }, store, item,
    );
    expect(result).toMatchObject({ success: false, applied: false, proposalId: null });
    expect((await store.listProposals()).map((proposal) => proposal.id)).toEqual(proposals);
    expect(await store.getReviewItem(item.id)).toEqual(item);
    expect(mocks.synchronize).not.toHaveBeenCalled();
    if (source !== 'wrong-connection') expect(mocks.withConnection).not.toHaveBeenCalled();
  });

  it.each((Object.keys(routes) as Route[]).flatMap((route) =>
    (['wrong-connection', 'wrong-space', 'historical', 'missing', 'malformed'] as const).map((source) => ({ route, source })),
  ))('$route cannot act on $source native provenance through a coincident transaction ID', async ({ route, source }) => {
    grant(route === 'approve' || route === 'correct' ? 'categorization:propose' : 'categorization:execute', correctedCategoryId);
    const selectedScope = {
      spaceId: selectedSpaceId, budgetId,
      connectionId: merchantConnectionId({ budgetId, serverUrl: 'https://actual.lifecycle.test' }),
    };
    const foreignSpace = source === 'wrong-space'
      ? store.governance.createSpace({ actorId: OWNER, name: 'Previous native namespace', kind: 'shared', now: NOW, auth: ownerAuth }).id
      : selectedSpaceId;
    const item = await nativeReviewFixture(store, {
      scope: { ...selectedScope, spaceId: foreignSpace, connectionId: source === 'wrong-connection'
        ? merchantConnectionId({ budgetId, serverUrl: 'https://actual.other.test' }) : selectedScope.connectionId },
      transaction, categoryId,
      ...(source === 'historical' ? { historicalStatus: route === 'undo' ? 'skipped' as const : 'rejected' as const } : {}),
      ...(source === 'missing' || source === 'malformed' ? { invalidReference: source } : {}),
    });
    if (route === 'undo' && source !== 'historical')
      store['db'].prepare('UPDATE review_items SET status=? WHERE id=?').run('skipped', item.id);
    const before = await store.getReviewItem(item.id);
    const actions = await store.getReviewActions(item.id);
    const proposals = (await store.listProposals()).map((proposal) => proposal.id);
    const response = await routes[route](event(
      { reviewId: item.id, ...(route === 'correct' ? { categoryId: correctedCategoryId } : {}) }, { reviewAndApply: true },
    ));
    expect(response.status).toBe('error');
    expect(await store.getReviewItem(item.id)).toEqual(before);
    expect(await store.getReviewActions(item.id)).toEqual(actions);
    expect((await store.listProposals()).map((proposal) => proposal.id)).toEqual(proposals);
    expect(mocks.synchronize).not.toHaveBeenCalled();
    if (source !== 'wrong-connection') {
      expect(mocks.loadConfig).not.toHaveBeenCalled();
      expect(mocks.withConnection).not.toHaveBeenCalled();
    }
  });

  it.each(Object.keys(routes) as Route[])('%s retains authorized current native rows in the exact connection namespace', async (route) => {
    grant(route === 'approve' || route === 'correct' ? 'categorization:propose' : 'categorization:execute', correctedCategoryId);
    const item = await nativeReviewFixture(store, {
      scope: { spaceId: selectedSpaceId, budgetId, connectionId: merchantConnectionId({ budgetId, serverUrl: 'https://actual.lifecycle.test' }) },
      transaction, categoryId,
    });
    if (route === 'undo') expect((await routes.skip(event({ reviewId: item.id }))).status).toBe('ok');
    const response = await routes[route](event(
      { reviewId: item.id, ...(route === 'correct' ? { categoryId: correctedCategoryId } : {}) }, { reviewAndApply: true },
    ));
    expect(response.status).toBe('ok');
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });
});

describe('review financial proposals', () => {
  it.each([
    ['approve', categoryId],
    ['correct', correctedCategoryId],
  ] as const)('%s persists a Native proposal only', async (route, proposedCategoryId) => {
    grant('categorization:propose', proposedCategoryId);
    const item = await pending();
    const actionHistory = await store.getReviewActions(item.id);
    const request = event(
      route === 'correct'
        ? { reviewId: item.id, categoryId: proposedCategoryId }
        : { reviewId: item.id },
      { reviewAndApply: true },
    );

    const result = await routes[route](request);
    expect(result.error).toBeNull();

    expect(request.node.res.statusCode).toBe(200);
    expect(result.status).toBe('ok');
    expect(result.result).toMatchObject({
      itemId: item.id,
      status: 'pending_review',
      mutationStatus: 'approval_required',
      disposition: 'approval_required',
      approvalRequired: true,
      categorizationExecuted: false,
      success: false,
      applied: false,
      verified: false,
    });
    const proposal = await store.getProposal(result.result!.proposal.id);
    if (!proposal || proposal.operation !== 'set_category') throw new Error('Expected persisted Native proposal');
    const native = await createNativeCategorizationMutationProtocol();
    const targetCategory = snapshot.categories.find(({ id }) => id === proposedCategoryId)!;
    const plan = native.planSetCategory(transaction, targetCategory);
    expect(proposal.actorId).toBe(ACTOR);
    expect(proposal.governancePolicyVersion).toBe(policyVersion);
    expect(proposal.payload).toMatchObject({
      kind: 'set_category',
      transactionId: transaction.id,
      categoryId: proposedCategoryId,
      composite: { nativePayloadHash: plan.hash },
    });
    expect(JSON.parse(proposal.preconditions)).toMatchObject({ reviewId: item.id, nativePlan: plan });
    expect(await store.findActiveApprovals(proposal.id)).toEqual([]);
    expect((await store.getReviewItem(item.id))?.status).toBe('pending_review');
    expect(await store.getReviewActions(item.id)).toEqual(actionHistory);
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });
  it('admits set-category proposal through operation-restricted grants on its canonical resources', async () => {
    grant('categorization:propose', categoryId, { operations: ['set_category'] });
    const item = await pending();
    const request = event({ reviewId: item.id }, { reviewAndApply: true });

    const result = await approve(request);

    expect(request.node.res.statusCode).toBe(200);
    expect(result.status).toBe('ok');
    expect(result.result).toMatchObject({
      itemId: item.id,
      status: 'pending_review',
      mutationStatus: 'approval_required',
      disposition: 'approval_required',
    });
  });
  it('admits correction through proposal-only set_category grants without granting private proposal reads', async () => {
    grant('categorization:propose', correctedCategoryId, {
      operations: ['set_category'],
      proposalOnly: true,
    });
    const item = await pending();
    const request = event(
      { reviewId: item.id, categoryId: correctedCategoryId },
      { reviewAndApply: true },
    );

    const result = await correct(request);

    expect(request.node.res.statusCode).toBe(200);
    expect(result.status).toBe('ok');
    expect(result.result?.mutationStatus).toBe('approval_required');
    expect(result.result?.proposal.privateEnvelopeVisible).toBe(false);
    expect(result.result?.proposal.payload).toBeNull();
    expect(JSON.stringify(result)).not.toContain(transaction.payeeName);
    expect(mocks.withConnection).toHaveBeenCalledOnce();
  });

  it.each([
    ['persisted source facts', 'source', null],
    ['source account', 'account', null],
    ['prior category', 'category', null],
    ['gross outgoing amount', null, { maxGrossOutgoing: [{ currency: 'USD', minorUnits: '1499' }] }],
    ['operation count', null, { maxOperationCount: 0 }],
  ] as const)('conceals a correction without exact %s authority before connection access', async (_name, missing, restrictions) => {
    const selectedTarget = correctedCategoryId;
    const common = [
      { resourceKind: 'budget' as const, resourceId: budgetId },
      { resourceKind: 'transaction' as const, resourceId: transaction.id },
      { resourceKind: 'category' as const, resourceId: selectedTarget },
      { resourceKind: 'category' as const, resourceId: categoryId },
    ];
    const resources = [
      ...common,
      ...(missing === 'account' ? [] : [{ resourceKind: 'account' as const, resourceId: transaction.accountId }]),
      ...(missing === 'category' ? [] : [{ resourceKind: 'category' as const, resourceId: currentCategoryId }]),
    ];
    for (const resource of resources)
      grantResource('categorization:propose', resource.resourceKind, resource.resourceId,
        resource.resourceKind === 'budget' ? restrictions ?? {} : {});

    const item = missing === 'source'
      ? await pending(false, categoryId, {
          sourceTransaction: { ...sourceTransaction, accountId: 'evidence-only-account' },
        })
      : await pending();
    const inaccessibleEvent = event(
      { reviewId: item.id, categoryId: selectedTarget },
      { reviewAndApply: true },
    );
    const inaccessible = await correct(inaccessibleEvent);
    const unknownEvent = event(
      { reviewId: 'review-item-that-does-not-exist', categoryId: selectedTarget },
      { reviewAndApply: true },
    );
    const unknown = await correct(unknownEvent);

    expect({
      status: inaccessibleEvent.node.res.statusCode,
      code: inaccessible.error?.code,
      message: inaccessible.error?.message,
      authorization: inaccessible.authorization,
    }).toEqual({
      status: unknownEvent.node.res.statusCode,
      code: unknown.error?.code,
      message: unknown.error?.message,
      authorization: unknown.authorization,
    });
    expect(inaccessibleEvent.node.res.statusCode).toBe(404);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect((await store.getReviewItem(item.id))?.status).toBe('pending_review');
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });
  it('rechecks persisted source authority in the executor before native or connection access', async () => {
    grant('categorization:propose', correctedCategoryId);
    const item = await pending();
    let executorFactoryReached = false;
    setReviewMutationExecutorFactory((executorEvent) => {
      executorFactoryReached = true;
      store.governance.setResourceGrant({
        spaceId: selectedSpaceId,
        actorId: ACTOR,
        budgetId,
        membershipId,
        resourceKind: 'account',
        resourceId: transaction.accountId,
        capability: 'categorization:propose',
        granted: false,
        now: NOW,
        auth: ownerAuth,
      });
      return createDefaultExecutorFactory(connectionManager())(executorEvent);
    });
    const deniedEvent = event(
      { reviewId: item.id, categoryId: correctedCategoryId },
      { reviewAndApply: true },
    );
    const denied = await correct(deniedEvent);
    const unknownEvent = event(
      { reviewId: 'review-item-that-does-not-exist', categoryId: correctedCategoryId },
      { reviewAndApply: true },
    );
    const unknown = await correct(unknownEvent);

    expect(executorFactoryReached).toBe(true);
    expect({
      status: deniedEvent.node.res.statusCode,
      code: denied.error?.code,
      message: denied.error?.message,
      authorization: denied.authorization,
    }).toEqual({
      status: unknownEvent.node.res.statusCode,
      code: unknown.error?.code,
      message: unknown.error?.message,
      authorization: unknown.authorization,
    });
    expect(deniedEvent.node.res.statusCode).toBe(404);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(mocks.synchronize).not.toHaveBeenCalled();
    expect((await store.getReviewItem(item.id))?.status).toBe('pending_review');
  });
});

describe('review proposal request privacy', () => {
  it.each([true, false])('hides an inaccessible review proposal before config or SDK access (stored source facts: %s)', async (includeSourceTransaction) => {
    store.governance.setResourceGrant({
      spaceId: selectedSpaceId,
      actorId: ACTOR,
      budgetId,
      membershipId,
      resourceKind: 'budget',
      resourceId: budgetId,
      capability: 'categorization:propose',
      granted: true,
      now: NOW,
      auth: ownerAuth,
    });
    const item = await pending(includeSourceTransaction);
    const inaccessibleEvent = event({ reviewId: item.id });
    const inaccessible = await approve(inaccessibleEvent);
    const unknownEvent = event({ reviewId: 'review-item-that-does-not-exist' });
    const unknown = await approve(unknownEvent);

    expect({
      status: inaccessibleEvent.node.res.statusCode,
      code: inaccessible.error?.code,
      message: inaccessible.error?.message,
    }).toEqual({
      status: unknownEvent.node.res.statusCode,
      code: unknown.error?.code,
      message: unknown.error?.message,
    });
    expect(inaccessibleEvent.node.res.statusCode).toBe(404);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(mocks.synchronize).not.toHaveBeenCalled();
    expect((await store.getReviewItem(item.id))?.status).toBe('pending_review');
    const body = JSON.stringify(inaccessible);
    expect(body).not.toContain(transaction.id);
    expect(body).not.toContain(transaction.accountId);
    expect(body).not.toContain(categoryId);
    if (transaction.categoryId) expect(body).not.toContain(transaction.categoryId);
    if (transaction.payeeName) expect(body).not.toContain(transaction.payeeName);
  });
});

describe('human review triage', () => {
  it.each([
    ['reject', 'rejected', 'reject_review'],
    ['skip', 'skipped', 'skip_review'],
  ] as const)('%s performs the exact authorized non-ledger transition', async (route, status, operation) => {
    grant('categorization:execute', categoryId, { operations: [operation] });
    const item = await pending();
    const request = event({ reviewId: item.id });

    const result = await routes[route](request);

    expect(request.node.res.statusCode).toBe(200);
    expect(result.result).toMatchObject({ itemId: item.id, applied: false, categorizationExecuted: false });
    expect((await store.getReviewItem(item.id))?.status).toBe(status);
    expect((await store.getReviewActions(item.id)).at(-1)?.actor).toBe(ACTOR);
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });

  it.each([
    ['reject', 'rejected', 'reject_review'],
    ['skip', 'skipped', 'skip_review'],
  ] as const)('%s admits an uncategorized recommendation without an empty category grant', async (route, status, operation) => {
    grant('categorization:execute', categoryId, { operations: [operation] });
    const item = await pending(true, '');
    const request = event({ reviewId: item.id });

    const result = await routes[route](request);

    expect(request.node.res.statusCode).toBe(200);
    expect(result.result?.itemId).toBe(item.id);
    expect((await store.getReviewItem(item.id))?.categoryId).toBe('');
    expect((await store.getReviewItem(item.id))?.status).toBe(status);
  });

  it('undo restores a skipped item to the queue under current exact authority', async () => {
    grant('categorization:execute', categoryId, { operations: ['skip_review', 'undo_review'] });
    const item = await pending(true, '');
    await routes.skip(event({ reviewId: item.id }));
    const request = event({ reviewId: item.id });

    const result = await routes.undo(request);

    expect(request.node.res.statusCode).toBe(200);
    expect(result.status).toBe('ok');
    expect((await store.getReviewItem(item.id))?.status).toBe('pending_review');
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });

  it('rechecks exact resource grants after the trusted ledger snapshot is captured', async () => {
    grant('categorization:execute');
    const item = await pending();
    mocks.synchronize.mockImplementationOnce(async () => {
      store.governance.setResourceGrant({
        spaceId: selectedSpaceId,
        actorId: ACTOR,
        budgetId,
        membershipId,
        resourceKind: 'account',
        resourceId: transaction.accountId,
        capability: 'categorization:execute',
        granted: false,
        now: NOW,
        auth: ownerAuth,
      });
      return { snapshot };
    });
    const request = event({ reviewId: item.id });

    const result = await routes.skip(request);

    expect(request.node.res.statusCode).toBe(403);
    expect(result.error.code).toBe('FORBIDDEN');
    expect(mocks.synchronize).toHaveBeenCalledTimes(1);
    expect(await store.getReviewItem(item.id)).toEqual(item);
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });
});

describe('review request boundaries', () => {
  it.each(Object.keys(routes) as Route[])('%s rejects body-supplied actor authority', async (route) => {
    grant(route === 'approve' || route === 'correct' ? 'categorization:propose' : 'categorization:execute');
    const item = await pending();
    const body = {
      reviewId: item.id,
      ...(route === 'correct' ? { categoryId: correctedCategoryId } : {}),
      actorId: ACTOR,
    };
    const request = event(body);

    const result = await routes[route](request);

    expect(request.node.res.statusCode).toBe(400);
    expect(result.status).toBe('error');
    expect(result.error.code).toBe({
      approve: 'INVALID_REVIEW_ID',
      correct: 'INVALID_REVIEW_CORRECTION',
      reject: 'INVALID_REVIEW_ACTION',
      skip: 'INVALID_REVIEW_ACTION',
      undo: 'INVALID_REVIEW_ACTION',
    }[route]);
    expect(await store.getReviewItem(item.id)).toEqual(item);
    expect(mocks.synchronize).not.toHaveBeenCalled();
  });

  it('requires an explicit selected space before reading review state', async () => {
    grant('categorization:propose');
    const item = await pending();
    const request = event({ reviewId: item.id }, { spaceId: '' });

    const result = await routes.approve(request);

    expect(request.node.res.statusCode).toBe(400);
    expect(result.error.code).toBe('SPACE_SELECTION_REQUIRED');
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });

  it('denies a membership revoked in the selected space before connecting to Actual', async () => {
    grant('categorization:execute');
    const item = await pending();
    const revokedAt = new Date(Date.parse(NOW) + 1000).toISOString();
    store.governance.revokeMembership({
      spaceId: selectedSpaceId,
      membershipId,
      now: revokedAt,
      auth: ownerAuth,
    });
    vi.setSystemTime(new Date(revokedAt));
    const request = event({ reviewId: item.id });

    const result = await routes.skip(request);

    expect(request.node.res.statusCode).toBe(403);
    expect(result.error.code).toBe('FORBIDDEN');
    expect(mocks.synchronize).not.toHaveBeenCalled();
    expect(await store.getReviewItem(item.id)).toEqual(item);
  });

  it('does not turn a trusted superseded fixture into a successful action', async () => {
    grant('categorization:execute');
    let item = await pending();
    item = await store.transitionInternalReviewItem(item.id, {
      toStatus: 'superseded',
      actor: 'trusted-fixture',
      expectedVersion: item.version,
    });
    const request = event({ reviewId: item.id });

    const result = await routes.skip(request);

    expect(request.node.res.statusCode).toBe(500);
    expect(result.error.code).toBe('ACTION_FAILED');
    expect((await store.getReviewItem(item.id))?.status).toBe('superseded');
  });
});
