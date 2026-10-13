import type * as H3 from 'h3';
import type { GenericActionProposal, ResourceGrantRestrictions } from '@balanceframe/workflow-store';
import type { ConnectionManager } from '@balanceframe/application';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore, canonicalProposalHash, GENERIC_MUTATION_POLICY_VERSION } from '@balanceframe/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { createNativeCategorizationMutationProtocol } from '../../../../packages/application/src/mutation';
import { merchantConnectionId } from '../../../../packages/application/src/merchant-service';
import fixture from '../../../../protocol/fixtures/representative.json';
import createProposal from '../../server/api/proposal/index.post';
import proposalDetail from '../../server/api/proposal/[id].get';
import { createDefaultExecutorFactory } from '../../server/utils/mutation-executor';
import { nativeReviewFixture } from './native-review.fixture';
import { completeNativeRuleSourceAvailability } from './native-rule-source.fixture';

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
// Vitest hoists package mocks; load the source constructor here to avoid the stale workspace dist export.
vi.mock('@balanceframe/application', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createNativeCategorizationMutationProtocol:
    (await import('../../../../packages/application/src/mutation')).createNativeCategorizationMutationProtocol,
}));
vi.mock('../../server/utils/mutation-executor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createMutationConnectionManager: () => ({ loadConfig: mocks.loadConfig, withConnection: mocks.withConnection }),
}));
vi.mock('@balanceframe/workflow-store', async () =>
  await import('../../../../packages/workflow-store/src/index'));


const OWNER_ID = 'proposal-create-owner';
const ACTOR_ID = 'proposal-create-human';
const NOW = '2026-10-01T12:00:00.000Z';
const SERVER_URL = 'https://actual.proposal-create.example.test';
const snapshot = canonicalProtocolSnapshotSchema.parse(fixture);
const TX = snapshot.transactions[0]!;
const TARGET_CATEGORY_ID = snapshot.transactions[1]!.categoryId!;
const TARGET_CATEGORY = snapshot.categories.find(({ id }) => id === TARGET_CATEGORY_ID)!;
const MINOR_UNITS = BigInt(TX.amount.minorUnits);
const EXPECTED_AMOUNT = {
  minorUnits: (MINOR_UNITS < 0n ? -MINOR_UNITS : MINOR_UNITS).toString(),
  currency: TX.amount.currency,
};

interface TestResponse {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  setHeader(name: string, value: string | string[]): TestResponse;
  getHeader(name: string): string | string[] | undefined;
  removeHeader(name: string): void;
}
type RequestEvent = H3.H3Event & EventWithContext & { body: unknown };

let store: SqliteWorkflowStore;
let bootstrapped = false;
let sequence = 0;
let spaceId = '';
let budgetId = '';
let membershipId = '';
let connectedBudgetId = '';

function event(body: unknown = {}, proposalId = '', reviewAndApply = false): RequestEvent {
  const headers = new Map<string, string | string[]>();
  const response: TestResponse = {
    statusCode: 200,
    statusMessage: '',
    headersSent: false,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return response;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
  };
  return {
    body,
    node: {
      req: { headers: { 'x-balanceframe-space': spaceId } },
      res: response,
    },
    context: {
      params: proposalId ? { id: proposalId } : {},
      auth: {
        authenticated: true,
        user: { id: ACTOR_ID },
        actorId: 'forged-legacy-actor',
        method: 'session',
        principalType: 'human',
        sessionId: `session:${ACTOR_ID}`,
      },
      runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false, ...(reviewAndApply ? { reviewAndApply: true } : {}) },
    },
  } as unknown as RequestEvent;
}

function grant(
  capability: string,
  resourceKind: 'budget' | 'account' | 'category' | 'transaction',
  resourceId: string,
  restrictions: ResourceGrantRestrictions = {},
) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: ACTOR_ID,
    membershipId,
    budgetId,
    capability,
    resourceKind,
    resourceId,
    granted: true,
    restrictions,
    now: NOW,
  });
}

function grantProposal(restrictions: ResourceGrantRestrictions = {}, allowRead = false) {
  for (const [resourceKind, resourceId] of [
    ['budget', budgetId],
    ['transaction', TX.id],
    ['account', TX.accountId],
    ['category', TX.categoryId!],
    ['category', TARGET_CATEGORY_ID],
  ] as const)
    grant('categorization:propose', resourceKind, resourceId, restrictions);
  if (allowRead) {
    grant('full-read', 'budget', budgetId);
    grant('full-read', 'account', TX.accountId);
    grant('full-read', 'transaction', TX.id);
    grant('full-read', 'category', TX.categoryId!);
    grant('full-read', 'category', TARGET_CATEGORY_ID);
  }
}

async function storedProposals(): Promise<GenericActionProposal[]> {
  return (await store.listProposals({ budgetId, operations: ['set_category'] }))
    .filter((proposal): proposal is GenericActionProposal => proposal.operation === 'set_category');
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  vi.stubEnv('BALANCEFRAME_SEED_ALLOWED', 'false');
  spaceId = '';
  budgetId = `proposal-create-budget-${++sequence}`;
  const provider = getWorkflowStore(event() as EventWithContext);
  if ('error' in provider) throw new Error(provider.error);
  store = provider.store;
  if (!bootstrapped) {
    await store.claimBootstrap({
      name: 'Proposal owner',
      email: 'proposal-create-owner@example.test',
      claimId: 'proposal-create-handler-fixture',
    });
    await store.finalizeBootstrap({ claimId: 'proposal-create-handler-fixture', ownerUserId: OWNER_ID });
    bootstrapped = true;
  }

  const ownerAuth = {
    method: 'human-session' as const,
    actorId: OWNER_ID,
    sessionId: `session:${OWNER_ID}`,
    reauthenticatedAt: NOW,
  };
  const space = store.governance.createSpace({
    actorId: OWNER_ID,
    name: `Proposal create space ${sequence}`,
    kind: 'shared',
    now: NOW,
    auth: ownerAuth,
  });
  spaceId = space.id;
  store.governance.bindBudget({ spaceId, budgetId, now: NOW, auth: ownerAuth });
  if (!store.governance.getPolicy({ spaceId }))
    store.governance.setPolicy({
      spaceId,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [] },
      now: NOW,
      auth: ownerAuth,
    });
  await store.upsertActorMembership(ACTOR_ID, 'active', [], '');
  membershipId = store.governance.addMembership({
    spaceId,
    actorId: ACTOR_ID,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  }).id;

  connectedBudgetId = budgetId;
  mocks.loadConfig.mockResolvedValue({ budgetId, serverUrl: SERVER_URL });
  mocks.synchronize.mockResolvedValue({
    snapshot,
    rulePlanningSourceAvailability: completeNativeRuleSourceAvailability(snapshot),
  });
  mocks.withConnection.mockImplementation(async (callback: (connection: unknown) => Promise<unknown>) =>
    callback({
      config: { budgetId: connectedBudgetId, serverUrl: SERVER_URL },
      budget: { id: connectedBudgetId },
      connector: {
        synchronize: mocks.synchronize,
        setTransactionCategory: mocks.setTransactionCategory,
      },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
afterAll(() => store.close());

describe('standalone categorization proposal creation', () => {
  it.each([
    [TX.id, TARGET_CATEGORY_ID],
    ['private-transaction-not-present', TARGET_CATEGORY_ID],
    [TX.id, 'private-category-not-present'],
  ])('does not reveal submitted resource existence or restore the ledger with budget-only proposal rights (%s, %s)', async (transactionId, categoryId) => {
    grant('categorization:propose', 'budget', budgetId);
    const response = await createProposal(event({ transactionId, categoryId }));
    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(response.result).toBeNull();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(await storedProposals()).toEqual([]);
  });
  it('returns one non-enumerating denial for unreadable resources after exact submitted-ID admission', async () => {
    grant('categorization:propose', 'budget', budgetId);
    let firstError: unknown;
    for (const [transactionId, categoryId] of [
      [TX.id, TARGET_CATEGORY_ID],
      ['private-transaction-not-present', TARGET_CATEGORY_ID],
      [TX.id, 'private-category-not-present'],
    ] as const) {
      grant('categorization:propose', 'transaction', transactionId);
      grant('categorization:propose', 'category', categoryId);
      const response = await createProposal(event({ transactionId, categoryId }));
      expect(response.error?.code).toBe('FORBIDDEN');
      if (firstError === undefined) firstError = response.error;
      else expect(response.error).toEqual(firstError);
      expect(response.result).toBeNull();
    }
    expect(await storedProposals()).toEqual([]);
  });
  it('creates one exact pending Native proposal from current Actual facts, without approval or ledger writes', async () => {
    grantProposal({
      proposalOnly: true,
      operations: ['set_category'],
      maxOperationCount: 1,
      maxGrossOutgoing: [{ currency: TX.amount.currency, minorUnits: '2000' }],
    });
    const native = await createNativeCategorizationMutationProtocol();
    const nativePlan = native.planSetCategory(TX, TARGET_CATEGORY);
    const response = await createProposal(event({
      transactionId: TX.id,
      categoryId: TARGET_CATEGORY_ID,
      message: 'Classify the transaction',
      reason: 'Reviewed the imported merchant',
    }));
    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({
      state: 'approval_required',
      applied: false,
      verified: false,
      proposal: { payloadHash: expect.any(String) },
    });
    const [proposal] = await storedProposals();
    expect(proposal).toBeDefined();
    expect(response.result!.proposal.id).toBe(proposal!.id);
    expect(response.result!.proposal.payloadHash).toBe(proposal!.payloadHash);
    expect(proposal!.actorId).toBe(ACTOR_ID);
    expect(proposal!.payload).toMatchObject({
      kind: 'set_category',
      transactionId: TX.id,
      categoryId: TARGET_CATEGORY_ID,
      composite: {
        operations: [{
          operation: 'set_category',
          transactionId: TX.id,
          accountId: TX.accountId,
          direction: 'outgoing',
          amount: EXPECTED_AMOUNT,
          categoryId: TARGET_CATEGORY_ID,
        }],
        reallocations: [],
        transferRecommendations: [],
        ledgerProjections: [],
        evidenceReferences: [],
        nativePayloadHash: nativePlan.hash,
      },
    });
    const preconditions = JSON.parse(proposal!.preconditions) as Record<string, unknown>;
    expect(preconditions).toMatchObject({
      currentCategoryId: TX.categoryId,
      actualVersion: snapshot.actualVersion,
      snapshotSchemaVersion: snapshot.schemaVersion,
      transaction: {
        id: TX.id,
        accountId: TX.accountId,
        categoryId: TX.categoryId,
        direction: 'outgoing',
        amount: EXPECTED_AMOUNT,
      },
    });
    expect(preconditions).not.toHaveProperty('reviewId');
    expect(preconditions.nativePlan).toEqual(nativePlan);
    expect(proposal!.payloadHash).toBe(canonicalProposalHash({
      operation: 'set_category',
      budgetId,
      payload: proposal!.payload,
      preconditions,
      actorId: ACTOR_ID,
      policyVersion: GENERIC_MUTATION_POLICY_VERSION,
      expiresAt: proposal!.expiresAt,
    }));
    expect(await store.findActiveApprovals(proposal!.id)).toEqual([]);
    expect(await store.listReviewItems({ budgetId })).toEqual([]);
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });

  it('shows the exact pending intent to an authorized human without creating approval', async () => {
    grantProposal({}, true);
    const created = await createProposal(event({ transactionId: TX.id, categoryId: TARGET_CATEGORY_ID }));
    expect(created.status).toBe('ok');
    const [proposal] = await storedProposals();
    expect(proposal).toBeDefined();
    expect(await store.findActiveApprovals(proposal!.id)).toEqual([]);

    const detail = await proposalDetail(event({}, proposal!.id));
    expect(detail.status).toBe('ok');
    expect(detail.result!.proposal).toMatchObject({
      id: proposal!.id,
      payloadHash: proposal!.payloadHash,
      payload: proposal!.payload,
    });
    expect(await store.findActiveApprovals(proposal!.id)).toEqual([]);
  });
  it('denies the sibling Review producer before SDK restoration when exact transaction or target-category proposal rights are absent', async () => {
    grant('categorization:propose', 'budget', budgetId);
    const discovered = await store.createReviewItem({
      transactionId: TX.id, budgetId, categoryId: TX.categoryId!,
      classifier: 'fixture', provenance: 'scoped-review-admission',
    });
    const suggestion = await store.transitionInternalReviewItem(discovered.id, {
      toStatus: 'suggestion_generated', actor: ACTOR_ID, expectedVersion: discovered.version,
    });
    const pending = await store.transitionInternalReviewItem(discovered.id, {
      toStatus: 'pending_review', actor: ACTOR_ID, expectedVersion: suggestion.version,
    });
    const manager = { loadConfig: mocks.loadConfig, withConnection: mocks.withConnection } as unknown as ConnectionManager;
    const executor = createDefaultExecutorFactory(manager)(event({}, '', true));
    if (!executor) throw new Error('Review producer is unavailable');
    const result = await executor({
      reviewId: pending.id, actorId: ACTOR_ID, requestId: 'review-scope-admission',
      categoryId: TARGET_CATEGORY_ID,
    }, store, pending);
    expect(result.disposition).toBe('denied');
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(await storedProposals()).toEqual([]);
  });

  it('shares real Native executable facts with the Review producer and retains its source pointer', async () => {
    grantProposal();
    const standaloneResponse = await createProposal(event({ transactionId: TX.id, categoryId: TARGET_CATEGORY_ID }));
    expect(standaloneResponse.status).toBe('ok');
    const [standalone] = await storedProposals();
    expect(standalone).toBeDefined();
    const pending = await nativeReviewFixture(store, {
      scope: { spaceId, budgetId, connectionId: merchantConnectionId({ budgetId, serverUrl: SERVER_URL }) },
      transaction: TX,
      categoryId: TX.categoryId!,
    });
    const manager = { loadConfig: mocks.loadConfig, withConnection: mocks.withConnection } as unknown as ConnectionManager;
    const executor = createDefaultExecutorFactory(manager)(event({}, '', true) as EventWithContext);
    expect(executor).not.toBeNull();
    const result = await executor!({
      reviewId: pending.id,
      actorId: ACTOR_ID,
      requestId: 'review-proposal-create-test',
      categoryId: TARGET_CATEGORY_ID,
    }, store, pending);
    if (result.disposition !== 'approval_required')
      throw new Error('Review producer did not create a pending Native proposal');
    const reviewProposal = await store.getProposal(result.proposalId);
    if (!reviewProposal || reviewProposal.operation !== 'set_category')
      throw new Error('Review producer proposal was not persisted');

    const native = await createNativeCategorizationMutationProtocol();
    const nativePlan = native.planSetCategory(TX, TARGET_CATEGORY);
    const directFacts = JSON.parse(standalone!.preconditions) as Record<string, unknown>;
    const reviewFacts = JSON.parse(reviewProposal.preconditions) as Record<string, unknown>;
    expect(reviewFacts).toMatchObject({ reviewId: pending.id });
    expect(directFacts).not.toHaveProperty('reviewId');
    expect(standalone!.payload).toEqual(reviewProposal.payload);
    for (const key of ['actualVersion', 'snapshotSchemaVersion', 'currentCategoryId', 'transaction'])
      expect(directFacts[key]).toEqual(reviewFacts[key]);
    expect(directFacts.nativePlan).toEqual(nativePlan);
    expect(reviewFacts.nativePlan).toEqual(nativePlan);
    expect(standalone!.payloadHash).toBe(canonicalProposalHash({
      operation: 'set_category', budgetId, payload: standalone!.payload, preconditions: directFacts,
      actorId: ACTOR_ID, policyVersion: GENERIC_MUTATION_POLICY_VERSION, expiresAt: standalone!.expiresAt,
    }));
    expect(reviewProposal.payloadHash).toBe(canonicalProposalHash({
      operation: 'set_category', budgetId, payload: reviewProposal.payload, preconditions: reviewFacts,
      actorId: ACTOR_ID, policyVersion: GENERIC_MUTATION_POLICY_VERSION, expiresAt: reviewProposal.expiresAt,
    }));
    expect(await store.findActiveApprovals(reviewProposal.id)).toEqual([]);
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });

  it.each([
    { categoryId: TARGET_CATEGORY_ID },
    { transactionId: TX.id },
    { transactionId: '', categoryId: TARGET_CATEGORY_ID },
  ])('rejects missing transaction/category fields before restoring Actual', async (body) => {
    const request = event(body);
    const response = await createProposal(request);
    expect(response.status).toBe('error');
    expect(request.node.res.statusCode).toBe(400);
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(await storedProposals()).toEqual([]);
  });


  it.each([
    { transactionId: TX.id, categoryId: TARGET_CATEGORY_ID, actorId: OWNER_ID },
    { transactionId: TX.id, categoryId: TARGET_CATEGORY_ID, spaceId: 'foreign-space' },
    { transactionId: TX.id, categoryId: TARGET_CATEGORY_ID, budgetId: 'foreign-budget' },
    { transactionId: TX.id, categoryId: TARGET_CATEGORY_ID, payload: { kind: 'set_category' } },
    { transactionId: TX.id, categoryId: TARGET_CATEGORY_ID, approval: true },
    { transactionId: TX.id, categoryId: TARGET_CATEGORY_ID, message: 'm'.repeat(10_000) },
    { transactionId: TX.id, categoryId: TARGET_CATEGORY_ID, reason: 'r'.repeat(10_000) },
  ])('rejects body authority fields and unbounded presentation text', async (body) => {
    const request = event(body);
    const response = await createProposal(request);
    expect(response.status).toBe('error');
    expect(request.node.res.statusCode).toBe(400);
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(await storedProposals()).toEqual([]);
  });

  it('rejects unsupported operations instead of treating rule creation as categorization', async () => {
    const request = event({ transactionId: TX.id, categoryId: TARGET_CATEGORY_ID, operation: 'create_rule' });
    const response = await createProposal(request);
    expect(response.status).toBe('error');
    expect(request.node.res.statusCode).toBe(400);
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(await storedProposals()).toEqual([]);
  });

  it('rejects a configured budget mismatch before opening an Actual connection', async () => {
    grantProposal();
    mocks.loadConfig.mockResolvedValue({ budgetId: 'other-budget' });
    const request = event({ transactionId: TX.id, categoryId: TARGET_CATEGORY_ID });
    const response = await createProposal(request);
    expect(response.status).toBe('error');
    expect(request.node.res.statusCode).toBe(409);
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(mocks.synchronize).not.toHaveBeenCalled();
    expect(await storedProposals()).toEqual([]);
  });

  it('enforces current operation and gross limits against the Native transaction', async () => {
    grantProposal({
      proposalOnly: true,
      operations: ['set_category'],
      maxOperationCount: 1,
      maxGrossOutgoing: [{ currency: TX.amount.currency, minorUnits: '1499' }],
    });
    const response = await createProposal(event({ transactionId: TX.id, categoryId: TARGET_CATEGORY_ID }));
    expect(response.status).toBe('error');
    expect(await storedProposals()).toEqual([]);
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });

  it('denies a proposal-only grant restricted to another operation', async () => {
    grantProposal({ proposalOnly: true, operations: ['create_rule'] });
    const response = await createProposal(event({ transactionId: TX.id, categoryId: TARGET_CATEGORY_ID }));
    expect(response.status).toBe('error');
    expect(await storedProposals()).toEqual([]);
    expect(mocks.setTransactionCategory).not.toHaveBeenCalled();
  });
});
