import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import { SqliteWorkflowStore } from '../../../../packages/workflow-store/src/store';
import type { ConnectionManager } from '@balanceframe/application';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import fixture from '../../../../protocol/fixtures/representative.json';
import { createDefaultExecutorFactory } from '../../server/utils/mutation-executor';
import approveReview from '../../server/api/review/approve.post';
import { setReviewMutationExecutorFactory } from '../../server/utils/workflow-store';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
  proofCookie: { value: undefined as string | undefined },
  readBody: vi.fn(),
  setResponseStatus: vi.fn(),
  setHeader: vi.fn(),
  setTransactionCategory: vi.fn(),
}));

vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  readBody: mocks.readBody,
  getRouterParam: (event: { context: { params?: Record<string, string> } }, name: string) =>
    event.context.params?.[name],
  getHeader: (event: { node: { req: { headers: Record<string, string | undefined> } } }, name: string) =>
    event.node.req.headers[name.toLowerCase()],
  getCookie: (event: { node: { req: { headers: Record<string, string | undefined> } } }, name: string) =>
    event.node.req.headers.cookie?.split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1),
  setCookie: (
    event: { node: { res: { setHeader(name: string, value: string | string[]): unknown } } },
    name: string,
    value: string,
  ) => {
    mocks.proofCookie.value = value;
    event.node.res.setHeader('Set-Cookie', `${name}=${value}`);
  },
  setResponseStatus: (event: { node: { res: { statusCode: number } } }, status: number) => {
    mocks.setResponseStatus(event, status);
    event.node.res.statusCode = status;
  },
  setHeader: (event: { node: { res: { setHeader(name: string, value: string | string[]): unknown } } }, name: string, value: string | string[]) => {
    mocks.setHeader(event, name, value);
    event.node.res.setHeader(name, value);
  },
}));

vi.mock('better-auth/node', () => ({
  fromNodeHeaders: (headers: ConstructorParameters<typeof Headers>[0]) => new Headers(headers),
}));

vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession: mocks.getSession, verifyPassword: mocks.verifyPassword } },
}));
// The hoisted workspace mock needs the source facade so these proposals carry real Native plans.
vi.mock('@balanceframe/application', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createNativeCategorizationMutationProtocol:
      (await import('../../../../packages/application/src/mutation')).createNativeCategorizationMutationProtocol,
  };
});


import { issueReauthentication, REAUTH_COOKIE_NAME } from '../../server/utils/reauthentication';

import approveBulk from '../../server/api/review/approve-bulk.post';
import proposalDetail from '../../server/api/proposal/[id].get';


let selectedSpaceId: string;
let BUDGET_ID: string;
let budgetSequence = 0;
let bootstrapInitialized = false;
const PROPOSER_ID = 'proposal-author';
const APPROVER_ID = 'review-approver';
const ACTOR_SESSION = `session:${APPROVER_ID}`;
const snapshot = canonicalProtocolSnapshotSchema.parse(fixture);
const firstTransaction = snapshot.transactions[0]!;
const secondTransaction = snapshot.transactions[1]!;
type ProposalScope = {
  spaceId: string;
  budgetId: string;
  proposerMembershipId: string;
  approverMembershipId?: string;
};
interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}


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
let store: SqliteWorkflowStore;
let proposerMembershipId: string;
let approverMembershipId: string;
let currentTime: string;
let ownerAuth: {
  method: 'human-session';
  actorId: string;
  sessionId: string;
  reauthenticatedAt: string;
};
const proposalHashes = new Map<string, string>();
function request(
  body: unknown,
  options: { proof?: boolean; actorId?: string; spaceId?: string; reviewAndApply?: boolean } = {},
) {
  mocks.readBody.mockResolvedValue(body);
  if (options.proof === false) mocks.proofCookie.value = undefined;
  const requestSpace = options.spaceId ?? selectedSpaceId;
  const requestActor = options.actorId ?? APPROVER_ID;
  return {
    body,
    node: {
      req: {
        headers: {
          'x-balanceframe-space': requestSpace,
          cookie: [
            'better-auth.session_token=authoritative-test-session',
            ...(mocks.proofCookie.value ? [`${REAUTH_COOKIE_NAME}=${mocks.proofCookie.value}`] : []),
          ].join('; '),
          origin: 'https://balanceframe.example.test',
        },
      },
      res: response(),
    },
    context: {
      auth: {
        authenticated: true,
        actorId: requestActor,
        method: 'session' as const,
        principalType: 'human' as const,
        sessionId: `session:${requestActor}`,
        user: { id: requestActor },
      },
      params: {} as Record<string, string>,
      runtimeConfig: {
        workflowDbPath: ':memory:',
        devBypassAuth: false,
        ...(options.reviewAndApply ? { reviewAndApply: true } : {}),
      },
    },
  };
}


function grant(
  scope: ProposalScope,
  actorId: string,
  membershipId: string,
  capability: string,
  resourceKind: 'budget' | 'account' | 'category' | 'transaction',
  resourceId: string,
  restrictions: { operations?: readonly string[] } = {},
) {
  store.governance.setResourceGrant({
    spaceId: scope.spaceId,
    actorId,
    budgetId: scope.budgetId,
    membershipId,
    capability,
    resourceKind,
    resourceId,
    restrictions,
    granted: true,
    now: currentTime,
    auth: ownerAuth,
  });
}

function sourceTransaction(transaction: (typeof snapshot.transactions)[number]) {
  const amount = BigInt(transaction.amount.minorUnits);
  return {
    id: transaction.id,
    accountId: transaction.accountId,
    categoryId: transaction.categoryId ?? null,
    direction: amount < 0n ? 'outgoing' as const : 'incoming' as const,
    amount: {
      minorUnits: (amount < 0n ? -amount : amount).toString(),
      currency: transaction.amount.currency,
    },
  };
}
async function addProposal(
  transaction: (typeof snapshot.transactions)[number],
  scope: ProposalScope = {
    spaceId: selectedSpaceId,
    budgetId: BUDGET_ID,
    proposerMembershipId,
    approverMembershipId,
  },
) {
  const categoryId = snapshot.categories.find(({ id }) => id !== transaction.categoryId)!.id;
  let item = await store.createReviewItem({
    transactionId: transaction.id,
    budgetId: scope.budgetId,
    categoryId,
    classifier: 'fixture-classifier',
    provenance: 'test-fixture',
    sourceTransaction: sourceTransaction(transaction),
  });
  for (const toStatus of ['suggestion_generated', 'pending_review'] as const) {
    item = await store.transitionInternalReviewItem(item.id, {
      toStatus,
      actor: 'trusted-fixture',
      expectedVersion: item.version,
    });
  }

  const resources = [
    { resourceKind: 'budget' as const, resourceId: scope.budgetId },
    { resourceKind: 'transaction' as const, resourceId: transaction.id },
    { resourceKind: 'account' as const, resourceId: transaction.accountId },
    ...(transaction.categoryId
      ? [{ resourceKind: 'category' as const, resourceId: transaction.categoryId }]
      : []),
    { resourceKind: 'category' as const, resourceId: categoryId },
  ];
  for (const resource of resources) {
    grant(scope, PROPOSER_ID, scope.proposerMembershipId, 'categorization:propose', resource.resourceKind, resource.resourceId);
    if (scope.approverMembershipId) {
      grant(scope, APPROVER_ID, scope.approverMembershipId, 'categorization:approve', resource.resourceKind, resource.resourceId);
    }
  }

  const previousBudgetId = BUDGET_ID;
  BUDGET_ID = scope.budgetId;
  try {
    const created = await approveReview(request(
      { reviewId: item.id },
      { actorId: PROPOSER_ID, spaceId: scope.spaceId, reviewAndApply: true },
    ) as unknown as ReauthenticationEvent);
    if (created.status !== 'ok' || !created.result)
      throw new Error(`Native review proposal creation failed: ${created.error?.code ?? 'unknown'}`);
    const proposal = await store.getProposal(created.result.proposal.id);
    if (!proposal || proposal.operation !== 'set_category')
      throw new Error('Review route did not persist its Native categorization proposal');
    proposalHashes.set(item.id, proposal.payloadHash);
    return { item, proposal };
  } finally {
    BUDGET_ID = previousBudgetId;
  }
}

function bodyFor(ids: readonly string[]) {
  return {
    ids,
    payloadHashes: Object.fromEntries(ids.map((id) => [id, proposalHashes.get(id)!])),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  currentTime = new Date().toISOString();
  proposalHashes.clear();
  BUDGET_ID = `budget-review-bulk-${++budgetSequence}`;
  const providerEvent = {
    node: { req: { headers: {} }, res: { statusCode: 200 } },
    context: {
      auth: {
        authenticated: true,
        actorId: PROPOSER_ID,
        method: 'session' as const,
        principalType: 'human' as const,
        sessionId: `session:${PROPOSER_ID}`,
        user: { id: PROPOSER_ID },
      },
      runtimeConfig: { workflowDbPath: ':memory:' },
    },
  } as unknown as EventWithContext;
  const workflow = getWorkflowStore(providerEvent);
  if ('error' in workflow) throw new Error(workflow.error);
  store = workflow.store;
  ownerAuth = {
    method: 'human-session',
    actorId: PROPOSER_ID,
    sessionId: `session:${PROPOSER_ID}`,
    reauthenticatedAt: currentTime,
  };
  if (!bootstrapInitialized) {
    await store.claimBootstrap({
      name: 'Proposal author',
      email: 'proposal-author@example.test',
      claimId: 'review-bulk-approval-fixture',
    });
    await store.finalizeBootstrap({ claimId: 'review-bulk-approval-fixture', ownerUserId: PROPOSER_ID });
    bootstrapInitialized = true;
  }
  const selectedSpace = store.governance.createSpace({
    actorId: PROPOSER_ID,
    name: 'Review approval test',
    kind: 'shared',
    now: currentTime,
    auth: ownerAuth,
  });
  selectedSpaceId = selectedSpace.id;
  store.governance.bindBudget({ spaceId: selectedSpaceId, budgetId: BUDGET_ID, now: currentTime, auth: ownerAuth });
  const proposerMembership = store.governance.getCurrentMembership({
    spaceId: selectedSpaceId,
    actorId: PROPOSER_ID,
    now: currentTime,
  });
  if (!proposerMembership) throw new Error('Proposal author membership was not created');
  proposerMembershipId = proposerMembership.id;
  await store.upsertActorMembership(APPROVER_ID, 'active', [], '');

  const approverMembership = store.governance.addMembership({
    spaceId: selectedSpaceId,
    actorId: APPROVER_ID,
    validFrom: currentTime,
    now: currentTime,
    auth: ownerAuth,
  });
  approverMembershipId = approverMembership.id;
  const connectionManager = {
    loadConfig: async () => ({ budgetId: BUDGET_ID }),
    withConnection: async (operation: (connected: {
      config: { budgetId: string };
      budget: { id: string };
      connector: { synchronize: () => Promise<{ snapshot: typeof snapshot }> };
    }) => Promise<unknown>) => operation({
      config: { budgetId: BUDGET_ID },
      budget: { id: BUDGET_ID },
      connector: {
        synchronize: async () => ({ snapshot }),
        setTransactionCategory: mocks.setTransactionCategory,
      },
    }),
  } as unknown as ConnectionManager;
  setReviewMutationExecutorFactory(createDefaultExecutorFactory(connectionManager));
  vi.stubEnv('BETTER_AUTH_SECRET', 'review-bulk-test-secret');
  vi.stubEnv('NUXT_BETTER_AUTH_SECRET', 'review-bulk-test-secret');
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.example.test');
  vi.stubEnv('NUXT_DEV_BYPASS_AUTH', 'false');
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  mocks.proofCookie.value = undefined;
  mocks.getSession.mockResolvedValue({
    user: { id: APPROVER_ID },
    session: { id: ACTOR_SESSION, userId: APPROVER_ID },
  });
  mocks.verifyPassword.mockResolvedValue({ status: true });
  await issueReauthentication(
    request(null) as unknown as ReauthenticationEvent,
    'correct-password',
  );
});

afterEach(() => {
  setReviewMutationExecutorFactory(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => store.close());
describe('POST /api/review/approve-bulk', () => {

  it('atomically approves exact typed current proposals under fresh human control without executing them', async () => {
    const first = await addProposal(firstTransaction);
    const second = await addProposal(secondTransaction);
    expect(first.proposal.payload).toMatchObject({
      kind: 'set_category',
      transactionId: firstTransaction.id,
    });

    const response = await approveBulk(request(bodyFor([first.item.id, second.item.id])));

    expect(response.status).toBe('ok');
    if (!response.result) throw new Error('Bulk approval returned no result');
    expect(response.result.items.map((item: { reviewId: string; proposalId: string }) => [item.reviewId, item.proposalId])).toEqual([
      [first.item.id, first.proposal.id],
      [second.item.id, second.proposal.id],
    ]);
    expect((await store.findActiveApprovals(first.proposal.id))).toMatchObject([
      { actorId: APPROVER_ID, status: 'active', payloadHash: first.proposal.payloadHash },
    ]);
    expect((await store.findActiveApprovals(second.proposal.id))).toMatchObject([
      { actorId: APPROVER_ID, status: 'active', payloadHash: second.proposal.payloadHash },
    ]);
    expect((await store.getReviewItem(first.item.id))?.status).toBe('pending_review');
    expect((await store.getReviewItem(second.item.id))?.status).toBe('pending_review');
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });
  it('admits an exact set-category approval through operation-restricted grants on its real resource IDs', async () => {
    const proposal = await addProposal(firstTransaction);
    const scope = {
      spaceId: selectedSpaceId,
      budgetId: BUDGET_ID,
      proposerMembershipId,
      approverMembershipId,
    };
    const targetCategoryId = proposal.proposal.payload.categoryId;
    for (const resource of [
      { resourceKind: 'budget' as const, resourceId: BUDGET_ID },
      { resourceKind: 'transaction' as const, resourceId: firstTransaction.id },
      { resourceKind: 'account' as const, resourceId: firstTransaction.accountId },
      ...(firstTransaction.categoryId
        ? [{ resourceKind: 'category' as const, resourceId: firstTransaction.categoryId }]
        : []),
      { resourceKind: 'category' as const, resourceId: targetCategoryId },
    ]) {
      grant(scope, APPROVER_ID, approverMembershipId, 'categorization:approve',
        resource.resourceKind, resource.resourceId, { operations: ['set_category'] });
    }
    const response = await approveBulk(request(bodyFor([proposal.item.id])));

    expect(response.status).toBe('ok');
    expect(await store.findActiveApprovals(proposal.proposal.id)).toMatchObject([
      { actorId: APPROVER_ID, status: 'active', payloadHash: proposal.proposal.payloadHash },
    ]);
  });

  it('does not issue a partial approval when any displayed proposal hash differs', async () => {
    const first = await addProposal(firstTransaction);
    const second = await addProposal(secondTransaction);
    const body = bodyFor([first.item.id, second.item.id]);
    body.payloadHashes[second.item.id] = 'f'.repeat(64);

    const response = await approveBulk(request(body));

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('REVIEW_UNAVAILABLE');
    expect(await store.findActiveApprovals(first.proposal.id)).toEqual([]);
    expect(await store.findActiveApprovals(second.proposal.id)).toEqual([]);
  });
  it('admits every exact proposal before comparing review status or displayed hashes', async () => {
    const first = await addProposal(firstTransaction);
    const second = await addProposal(secondTransaction);
    store.governance.setResourceGrant({
      spaceId: selectedSpaceId,
      actorId: APPROVER_ID,
      budgetId: BUDGET_ID,
      membershipId: approverMembershipId,
      resourceKind: 'transaction',
      resourceId: secondTransaction.id,
      capability: 'categorization:approve',
      granted: false,
      now: currentTime,
      auth: ownerAuth,
    });
    const ids = [first.item.id, second.item.id];
    const wrongHashBody = bodyFor(ids);
    wrongHashBody.payloadHashes[first.item.id] =
      first.proposal.payloadHash === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const wrongHashEvent = request(wrongHashBody);
    const wrongHash = await approveBulk(wrongHashEvent);
    const validHashEvent = request(bodyFor(ids));
    const validHash = await approveBulk(validHashEvent);

    expect({
      status: wrongHashEvent.node.res.statusCode,
      code: wrongHash.error?.code,
      message: wrongHash.error?.message,
    }).toEqual({
      status: validHashEvent.node.res.statusCode,
      code: validHash.error?.code,
      message: validHash.error?.message,
    });
    expect(await store.findActiveApprovals(first.proposal.id)).toEqual([]);
    expect(await store.findActiveApprovals(second.proposal.id)).toEqual([]);
    expect(JSON.stringify(wrongHash)).not.toContain(first.proposal.payloadHash);
    expect(JSON.stringify(wrongHash)).not.toContain(second.proposal.payloadHash);

    const firstCurrent = await store.getReviewItem(first.item.id);
    if (!firstCurrent) throw new Error('The first review fixture disappeared');
    await store.transitionInternalReviewItem(first.item.id, {
      toStatus: 'rejected',
      actor: 'trusted-fixture',
      expectedVersion: firstCurrent.version,
    });
    const staleStateEvent = request(wrongHashBody);
    const staleState = await approveBulk(staleStateEvent);

    expect({
      status: staleStateEvent.node.res.statusCode,
      code: staleState.error?.code,
      message: staleState.error?.message,
    }).toEqual({
      status: wrongHashEvent.node.res.statusCode,
      code: wrongHash.error?.code,
      message: wrongHash.error?.message,
    });
    expect(await store.findActiveApprovals(first.proposal.id)).toEqual([]);
    expect(await store.findActiveApprovals(second.proposal.id)).toEqual([]);
  });

  it('returns the same denial for an existing inaccessible review and an unknown ID', async () => {
    const proposal = await addProposal(firstTransaction);
    store.governance.setResourceGrant({
      spaceId: selectedSpaceId,
      actorId: APPROVER_ID,
      budgetId: BUDGET_ID,
      membershipId: approverMembershipId,
      resourceKind: 'transaction',
      resourceId: firstTransaction.id,
      capability: 'categorization:approve',
      granted: false,
      now: currentTime,
      auth: ownerAuth,
    });
    const inaccessibleEvent = request(bodyFor([proposal.item.id]));
    const inaccessible = await approveBulk(inaccessibleEvent);
    const unknownId = 'review-item-that-does-not-exist';
    const unknownEvent = request({ ids: [unknownId], payloadHashes: { [unknownId]: 'a'.repeat(64) } });
    const unknown = await approveBulk(unknownEvent);

    expect({
      status: inaccessibleEvent.node.res.statusCode,
      code: inaccessible.error?.code,
      message: inaccessible.error?.message,
    }).toEqual({
      status: unknownEvent.node.res.statusCode,
      code: unknown.error?.code,
      message: unknown.error?.message,
    });
    expect(JSON.stringify(inaccessible)).not.toContain(proposal.proposal.payloadHash);
    expect(await store.findActiveApprovals(proposal.proposal.id)).toEqual([]);
    const hidden = JSON.stringify(inaccessible);
    expect(hidden).not.toContain(firstTransaction.id);
    expect(hidden).not.toContain(firstTransaction.accountId);
    expect(hidden).not.toContain(proposal.proposal.payload.categoryId);
    if (firstTransaction.categoryId) expect(hidden).not.toContain(firstTransaction.categoryId);
    if (firstTransaction.payeeName) expect(hidden).not.toContain(firstTransaction.payeeName);
  });
  it('does not approve a review from a different selected space', async () => {
    const selected = await addProposal(firstTransaction);
    const foreignBudget = `budget-foreign-${budgetSequence}`;
    const foreignSpace = store.governance.createSpace({
      actorId: PROPOSER_ID,
      name: 'Foreign test space',
      kind: 'shared',
      now: currentTime,
      auth: ownerAuth,
    });
    store.governance.bindBudget({
      spaceId: foreignSpace.id,
      budgetId: foreignBudget,
      now: currentTime,
      auth: ownerAuth,
    });
    const foreignMembership = store.governance.getCurrentMembership({
      spaceId: foreignSpace.id,
      actorId: PROPOSER_ID,
      now: currentTime,
    });
    if (!foreignMembership) throw new Error('Foreign proposal author membership was not created');
    const foreign = await addProposal(secondTransaction, {
      spaceId: foreignSpace.id,
      budgetId: foreignBudget,
      proposerMembershipId: foreignMembership.id,
    });
    const foreignReview = foreign.item;

    const response = await approveBulk(request(bodyFor([selected.item.id, foreignReview.id])));

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('REVIEW_UNAVAILABLE');
    expect(await store.findActiveApprovals(selected.proposal.id)).toEqual([]);
    expect(await store.findActiveApprovals(foreign.proposal.id)).toEqual([]);
  });

  it('rejects duplicate review IDs before creating approvals', async () => {
    const proposal = await addProposal(firstTransaction);

    const response = await approveBulk(request(bodyFor([proposal.item.id, proposal.item.id])));

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('INVALID_REQUEST');
    expect(await store.findActiveApprovals(proposal.proposal.id)).toEqual([]);
  });

  it('denies a missing selected-budget approval grant without creating approvals', async () => {
    const proposal = await addProposal(firstTransaction);
    const membership = store.governance.getCurrentMembership({
      spaceId: selectedSpaceId,
      actorId: APPROVER_ID,
      now: currentTime,
    });
    if (!membership) throw new Error('Review approver membership was not created');
    store.governance.setResourceGrant({
      spaceId: selectedSpaceId,
      actorId: APPROVER_ID,
      membershipId: membership.id,
      budgetId: BUDGET_ID,
      capability: 'categorization:approve',
      resourceKind: 'budget',
      resourceId: BUDGET_ID,
      granted: false,
      now: currentTime,
      auth: ownerAuth,
    });
    const response = await approveBulk(request(bodyFor([proposal.item.id])));

    expect(response.status).toBe('error');
    expect(await store.findActiveApprovals(proposal.proposal.id)).toEqual([]);
  });

  it('does not create approvals when a fresh human control proof is absent', async () => {
    const proposal = await addProposal(firstTransaction);

    const response = await approveBulk(request(bodyFor([proposal.item.id]), { proof: false }));

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('REAUTHENTICATION_REQUIRED');
    expect(await store.findActiveApprovals(proposal.proposal.id)).toEqual([]);
  });

});

describe('GET /api/proposal/:id approval view', () => {
  it('returns safe operation metadata without private baselines or simulation for an operation-only reader', async () => {
    const { proposal } = await addProposal(firstTransaction);
    const event = request(null);
    event.context.params.id = proposal.id;

    const response = await proposalDetail(event);

    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({
      proposal: {
        id: proposal.id,
        payloadHash: proposal.payloadHash,
        privateEnvelopeVisible: false,
        payload: null,
        preconditions: null,
        canApprove: false,
      },
      simulation: null,
      simulationStatus: 'missing',
    });
    expect(JSON.stringify(response)).not.toContain(firstTransaction.accountId);
  });

  it('returns the exact persisted payload and only current approval facts to an authorized selected-space reader', async () => {
    const { item, proposal } = await addProposal(firstTransaction);
    store.governance.setResourceGrant({
      spaceId: selectedSpaceId, budgetId: BUDGET_ID,
      actorId: APPROVER_ID, membershipId: approverMembershipId,
      capability: 'full-read', resourceKind: 'budget', resourceId: BUDGET_ID,
      granted: true, now: currentTime, auth: ownerAuth,
    });
    const ownerMembership = store.governance.getCurrentMembership({
      spaceId: selectedSpaceId,
      actorId: PROPOSER_ID,
      now: currentTime,
    });
    if (!ownerMembership) throw new Error('Proposal author membership was not created');
    const approvalResponse = await approveBulk(request(bodyFor([item.id])));
    expect(approvalResponse.status).toBe('ok');
    const approval = (await store.findActiveApprovals(proposal.id))[0];
    if (!approval) throw new Error('Fresh human approval route did not persist an approval');
    const event = request(null);
    event.context.params.id = proposal.id;

    const response = await proposalDetail(event);

    expect(response.status).toBe('ok');
    if (!response.result) throw new Error('Authorized proposal view returned no result');
    expect(response.result.proposal).toMatchObject({
      id: proposal.id,
      operation: 'set_category',
      spaceId: selectedSpaceId,
      budgetId: BUDGET_ID,
      requesterActorId: PROPOSER_ID,
      requesterMembershipId: ownerMembership.id,
      governancePolicyVersion: proposal.governancePolicyVersion,
      policyVersion: proposal.policyVersion,
      payloadHash: proposal.payloadHash,
      payload: proposal.payload,
      preconditions: JSON.parse(proposal.preconditions),
      expiresAt: proposal.expiresAt,
      requiredApprovers: 1,
      approvers: [{
        actorId: APPROVER_ID,
        issuedAt: approval.createdAt,
        expiresAt: approval.expiresAt,
      }],
      disposition: 'authorized_without_approval',
      canApprove: true,
      canExecute: false,
    });
    expect((await store.getReviewItem(item.id))?.status).toBe('pending_review');
  });

  it('does not disclose a proposal after its original requester membership period ends', async () => {
    const { proposal } = await addProposal(firstTransaction);
    const ownerMembership = store.governance.getCurrentMembership({
      spaceId: selectedSpaceId,
      actorId: PROPOSER_ID,
      now: currentTime,
    });
    if (!ownerMembership) throw new Error('Proposal author membership was not created');
    const now = new Date(Date.parse(currentTime) + 1000).toISOString();
    store.governance.revokeMembership({
      spaceId: selectedSpaceId,
      membershipId: ownerMembership.id,
      now,
      auth: ownerAuth,
    });
    const event = request(null);
    event.context.params.id = proposal.id;

    const response = await proposalDetail(event);

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('NOT_FOUND');
    expect(response.result).toBeNull();
    expect(JSON.stringify(response)).not.toContain(proposal.payloadHash);
  });
});
