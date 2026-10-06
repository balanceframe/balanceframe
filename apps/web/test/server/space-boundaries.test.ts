import type * as H3 from 'h3';
import type { ConnectionManager } from '@balanceframe/application';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent } from 'h3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import fixture from '../../../../protocol/fixtures/representative.json';
import groupHandler from '../../server/api/review/group.post';
import { completeNativeRuleSourceAvailability } from './native-rule-source.fixture';

const mocks = vi.hoisted(() => ({
  manager: null as unknown,
  loadConfig: vi.fn(),
  withConnection: vi.fn(async (operation: (connected: unknown) => Promise<unknown>) => operation({})),
}));

vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));
// The hoisted package mock loads the Source manager implementation, not a stale workspace dist export.
vi.mock('@balanceframe/application', async () => {
  const application = await import('../../../../packages/application/src/index');
  return {
    ...application,
    createDefaultConnectionManager: () => mocks.manager as ConnectionManager,
  };
});


const OWNER = 'space-boundary-owner';
const ACTOR = 'space-boundary-human';
const NOW = '2026-09-06T10:00:00.000Z';
const SERVER_URL = 'https://actual.space-boundaries.example.test';
const PRIVATE_EVIDENCE = 'private-review-model-evidence-4e08';
const ownerAuth = {
  method: 'human-session' as const,
  actorId: OWNER,
  sessionId: `session:${OWNER}`,
  reauthenticatedAt: NOW,
};
const canonical = canonicalProtocolSnapshotSchema.parse(fixture);
const transactions = canonical.transactions.slice(0, 2);
const targetCategoryId = canonical.transactions[1]!.categoryId!;
let directory = '';
let store: SqliteWorkflowStore;
let sequence = 0;
let budgetId = '';
let spaceId = '';
let membershipId = '';
let reviewIds: string[] = [];

function request(body: unknown, selectedSpace = spaceId) {
  const req = new IncomingMessage(new Socket());
  req.url = '/api/review/group';
  req.method = 'POST';
  const bodyText = JSON.stringify(body);
  req.headers = {
    'x-balanceframe-space': selectedSpace,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(bodyText)),
  };
  req.push(Buffer.from(bodyText));
  req.push(null);
  const event = createEvent(req, new ServerResponse(req)) as unknown as H3.H3Event & EventWithContext;
  event.context.auth = {
    authenticated: true,
    actorId: 'forged-legacy-actor',
    user: { id: ACTOR },
    method: 'session',
    principalType: 'human',
    sessionId: `session:${ACTOR}`,
    impersonatedBy: null,
  };
  event.context.runtimeConfig = { workflowDbPath: join(directory, 'workflow.sqlite'), devBypassAuth: false };
  return event;
}

function grant(capability: string, resourceKind: 'budget' | 'account' | 'category', resourceId: string) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: ACTOR,
    membershipId,
    budgetId,
    capability,
    resourceKind,
    resourceId,
    granted: true,
    now: NOW,
    auth: ownerAuth,
  });
}

function grantProjectionResources(withholdHistoryFor?: string) {
  grant('observe', 'budget', budgetId);
  for (const accountId of new Set(transactions.map(({ accountId }) => accountId))) {
    grant('existence', 'account', accountId);
    if (accountId !== withholdHistoryFor) grant('history', 'account', accountId);
    grant('name', 'account', accountId);
  }
  const categories = new Set<string>([targetCategoryId]);
  for (const transaction of transactions)
    if (transaction.categoryId) categories.add(transaction.categoryId);
  for (const categoryId of categories) {
    grant('existence', 'category', categoryId);
    grant('name', 'category', categoryId);
  }
}

async function seedReview(transactionId: string) {
  const source = canonical.transactions.find(({ id }) => id === transactionId)!;
  const signedAmount = BigInt(source.amount.minorUnits);
  let review = await store.createReviewItem({
    budgetId,
    transactionId,
    categoryId: targetCategoryId,
    classifier: 'current-classifier',
    provenance: 'space-boundary-fixture',
    evidence: { confidence: 0.9, rawModelInput: PRIVATE_EVIDENCE },
    sourceTransaction: {
      id: source.id,
      accountId: source.accountId,
      categoryId: source.categoryId ?? null,
      direction: signedAmount < 0n ? 'outgoing' : 'incoming',
      amount: {
        minorUnits: (signedAmount < 0n ? -signedAmount : signedAmount).toString(),
        currency: source.amount.currency,
      },
    },
  });
  for (const toStatus of ['suggestion_generated', 'pending_review'] as const)
    review = await store.transitionInternalReviewItem(review.id, {
      toStatus,
      actor: 'trusted-fixture',
      expectedVersion: review.version,
    });
  return review;
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  directory = mkdtempSync(join(tmpdir(), 'space-boundaries-native-'));
  const req = new IncomingMessage(new Socket());
  req.url = '/api/review/group';
  req.headers = { 'x-balanceframe-space': '' };
  const opened = getWorkflowStore({
    node: { req, res: new ServerResponse(req) },
    context: { runtimeConfig: { workflowDbPath: join(directory, 'workflow.sqlite') } },
  } as unknown as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({
    name: 'Space boundary owner',
    email: 'space-boundary-owner@example.test',
    claimId: 'space-boundary-native-fixture',
  });
  await store.finalizeBootstrap({ claimId: 'space-boundary-native-fixture', ownerUserId: OWNER });
  await store.upsertActorMembership(ACTOR, 'active', [], '');
});

beforeEach(async () => {
  vi.clearAllMocks();
  budgetId = `space-boundary-budget-${++sequence}`;
  const baseSpace = store.governance.createSpace({
    actorId: OWNER,
    name: `Space boundary ${sequence}`,
    kind: 'shared',
    now: NOW,
    auth: ownerAuth,
  });
  spaceId = store.governance.bindBudget({
    spaceId: baseSpace.id,
    budgetId,
    now: NOW,
    auth: ownerAuth,
  }).id;
  if (!store.governance.getPolicy({ spaceId }))
    store.governance.setPolicy({
      spaceId,
      expectedVersion: null,
      policy: { minimumApprovers: 1, approvalThresholds: [] },
      now: NOW,
      auth: ownerAuth,
    });
  membershipId = store.governance.addMembership({
    spaceId,
    actorId: ACTOR,
    validFrom: NOW,
    now: NOW,
    auth: ownerAuth,
  }).id;
  reviewIds = [];
  for (const transaction of transactions)
    reviewIds.push((await seedReview(transaction.id)).id);
  mocks.manager = {
    loadConfig: mocks.loadConfig,
    withConnection: mocks.withConnection,
  };
  mocks.loadConfig.mockResolvedValue({ budgetId, serverUrl: SERVER_URL });
  mocks.withConnection.mockImplementation(async (operation) => operation({
    config: { budgetId, serverUrl: SERVER_URL },
    budget: { id: budgetId },
    connector: {
      synchronize: async () => ({
        snapshot: canonical,
        financialSnapshot: { legacySnapshot: canonical },
        rulePlanningSourceAvailability: completeNativeRuleSourceAvailability(canonical),
      }),
    },
  }));
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('selected-space Native review group projection', () => {
  it('returns one complete group from independently authorized current ledger facts', async () => {
    grantProjectionResources();

    const response = await groupHandler(request({ ids: reviewIds }));
    const expectedMinorUnits = transactions.reduce(
      (total, transaction) => total + BigInt(transaction.amount.minorUnits),
      0n,
    );

    expect(response.status).toBe('ok');
    expect(response.authorization).toMatchObject({ actorId: ACTOR, capability: 'observe', allowed: true });
    expect(response.result).toMatchObject({
      homogeneous: true,
      itemCount: 2,
      totalAmount: { minorUnits: expectedMinorUnits.toString(), currency: transactions[0]!.amount.currency },
    });
    expect(response.result.items).toHaveLength(2);
    expect(JSON.stringify(response)).not.toContain(PRIVATE_EVIDENCE);
    expect(JSON.stringify(response)).not.toContain('confidence');
  });

  it('withholds the entire group when one account-history grant is missing', async () => {
    grantProjectionResources(transactions[0]!.accountId);

    const event = request({ ids: reviewIds });
    const response = await groupHandler(event);
    const serialized = JSON.stringify(response);

    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(event.node.res.statusCode).toBe(404);
    expect(serialized).not.toContain(PRIVATE_EVIDENCE);
    expect(serialized).not.toContain(canonical.transactions[0]!.payeeName);
    expect(serialized).not.toContain(canonical.transactions[1]!.payeeName);
    expect(serialized).not.toContain(transactions[0]!.amount.minorUnits);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.withConnection).not.toHaveBeenCalled();
  });
  it('conceals a private review group like an unknown ID before config or SDK access', async () => {
    grantProjectionResources(transactions[0]!.accountId);
    const inaccessibleEvent = request({ ids: [reviewIds[0]!] });
    const inaccessible = await groupHandler(inaccessibleEvent);
    const unknownEvent = request({ ids: ['review-item-that-does-not-exist'] });
    const unknown = await groupHandler(unknownEvent);

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
  });


  it('denies an unselected member before connection access even when the request names a group', async () => {
    const foreign = store.governance.createSpace({
      actorId: OWNER,
      name: `Foreign boundary space ${sequence}`,
      kind: 'shared',
      now: NOW,
      auth: ownerAuth,
    });
    const foreignBudget = `space-boundary-foreign-${sequence}`;
    const foreignSpace = store.governance.bindBudget({
      spaceId: foreign.id,
      budgetId: foreignBudget,
      now: NOW,
      auth: ownerAuth,
    });

    const response = await groupHandler(request({ ids: reviewIds }, foreignSpace.id));

    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(JSON.stringify(response)).not.toContain(foreignBudget);
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.withConnection).not.toHaveBeenCalled();
  });
});
