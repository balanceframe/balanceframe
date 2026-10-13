import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent } from 'h3';
import type * as H3 from 'h3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProtocolSnapshot, TransferPlan } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import type { ResourceGrantRestrictions, SqliteWorkflowStore } from '@balanceframe/workflow-store';
import representative from '../../../../protocol/fixtures/representative.json';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({ budgetId: '' })),
  withConnection: vi.fn(),
  nativeAttention: vi.fn(),
  afterProtocol: undefined as (() => void | Promise<void>) | undefined,
  afterAnalysis: undefined as (() => void | Promise<void>) | undefined,
  afterDisposal: undefined as (() => void | Promise<void>) | undefined,
  afterFinalConfig: undefined as (() => void | Promise<void>) | undefined,
}));

// Vitest hoists these package mocks, so their factories load Source modules instead of stale workspace exports.
// Keep Native governance and projections real; only avoid restoring an external Actual connection.
vi.mock('@balanceframe/application', async () => {
  const application = await import('../../../../packages/application/src/index');
  return {
    ...application,
    createDefaultConnectionManager: () => ({
      loadConfig: mocks.loadConfig,
      withConnection: mocks.withConnection,
    }),
    createNativeAnalysisProtocol: async (...args: Parameters<typeof application.createNativeAnalysisProtocol>) => {
      const protocol = await application.createNativeAnalysisProtocol(...args);
      await mocks.afterProtocol?.();
      return {
        ...protocol,
        attentionHome: async (...input: Parameters<NonNullable<typeof protocol.attentionHome>>) => {
          mocks.nativeAttention();
          const result = await protocol.attentionHome!(...input);
          await mocks.afterAnalysis?.();
          return result;
        },
      };
    },
  };
});
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));

import handler from '../../server/api/home/attention.get';

const OWNER = 'home-attention-owner';
const READER = 'home-attention-aggregate-reader';
const DENIED = 'home-attention-unobserved-reader';
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2026-09-06T10:00:00.000Z';
const EXPIRES_AT = '2026-09-06T11:00:00.000Z';
const SOURCE_ACCOUNT = 'private-source-account';
const DESTINATION_ACCOUNT = 'private-destination-account';
const ownerControl = {
  method: 'human-session' as const,
  actorId: OWNER,
  sessionId: 'home-attention-owner-session',
  reauthenticatedAt: NOW,
};
let directory = '';
let store: SqliteWorkflowStore;
let sequence = 0;
let budgetId = '';
let spaceId = '';
let ownerMembershipId = '';
let readerMembershipId = '';
let deniedMembershipId = '';
let snapshot: ProtocolSnapshot;
let connectionConfig: { version: 1; serverUrl: string; budgetId: string; budgetName: string; groupId: string };

function request(actorId = READER, selectedSpace = spaceId) {
  const req = new IncomingMessage(new Socket());
  req.url = '/api/home/attention';
  req.method = 'GET';
  req.headers = { origin: ORIGIN, 'x-balanceframe-space': selectedSpace };
  const event = createEvent(req, new ServerResponse(req)) as unknown as H3.H3Event & EventWithContext;
  event.context.auth = {
    authenticated: true,
    actorId,
    user: { id: actorId },
    method: 'session',
    principalType: 'human',
    sessionId: `session:${actorId}`,
    impersonatedBy: null,
  };
  event.context.runtimeConfig = {
    workflowDbPath: join(directory, 'workflow.sqlite'),
    devBypassAuth: false,
  };
  return event;
}

function ownerActor() {
  const policy = store.governance.getPolicy({ spaceId });
  if (!policy) throw new Error('Home attention governance policy unavailable');
  return {
    actorId: OWNER,
    budgetId,
    spaceId,
    membershipId: ownerMembershipId,
    governancePolicyVersion: policy.version,
    now: NOW,
    auth: ownerControl,
  };
}

function grant(
  actorId: string,
  membershipId: string,
  resourceKind: 'budget' | 'account' | 'space',
  resourceId: string,
  capability: string,
  restrictions?: ResourceGrantRestrictions,
) {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId,
    membershipId,
    budgetId,
    capability,
    resourceKind,
    resourceId,
    ...(restrictions ? { restrictions } : {}),
    granted: true,
    now: NOW,
    auth: ownerControl,
  });
}

function transferPlan(): TransferPlan {
  const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
  const before = (accountId: string) => ({
    accountId,
    recordedBalance: money('10000'),
    signedHeadroom: money('10000'),
    backingCapacity: money('10000'),
    baselineTransactionIds: [],
  });
  const snapshotId = 'private-transfer-snapshot';
  const contentHash = 'private-transfer-content-hash';
  const policyHash = 'private-transfer-policy-hash';
  return {
    version: '1',
    preconditionsHash: 'e'.repeat(64),
    scenario: { kind: 'none' },
    snapshotId,
    contentHash,
    policyVersion: '1',
    policyHash,
    claimSetRevision: '0',
    evaluatedAt: NOW,
    expiresAt: EXPIRES_AT,
    minimumAmount: money('2300'),
    payloadHash: 'a'.repeat(64),
    legs: [{
      id: 'private-transfer-leg',
      sourceAccountId: SOURCE_ACCOUNT,
      destinationAccountId: DESTINATION_ACCOUNT,
      amount: money('2300'),
      requiredBy: EXPIRES_AT,
      estimatedArrival: '2026-09-06T10:30:00.000Z',
      timingRouteId: 'private-transfer-route',
      sourceBefore: before(SOURCE_ACCOUNT),
      destinationBefore: before(DESTINATION_ACCOUNT),
      sourceAfter: money('7700'),
      destinationAfter: money('12300'),
    }],
    reservations: [{
      kind: 'account_debit',
      resourceId: SOURCE_ACCOUNT,
      amount: money('2300'),
      economicObligationId: 'private-economic-obligation',
      categoryId: null,
      includedInBalance: false,
      matchedTransactionIds: [],
    }],
    backingAfter: {
      version: '1',
      snapshotId,
      contentHash,
      policyVersion: '1',
      policyHash,
      claimSetRevision: '0',
      feasible: true,
      lines: [],
      reasons: [],
    },
  };
}

async function seedAttentionTransfer(ordinal = 0) {
  const owner = ownerActor();
  const policy = store.governance.getPolicy({ spaceId });
  if (!policy) throw new Error('Home attention governance policy unavailable');
  grant(OWNER, ownerMembershipId, 'budget', budgetId, 'policy');
  if (ordinal === 0) {
    store.liquidity.savePolicy({
      ...owner,
      expectedVersion: null,
      expectedGovernancePolicyVersion: policy.version,
      policy: { version: '1', policyHash: 'private-transfer-policy-hash', expiresAt: EXPIRES_AT, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 1 },
    });
  }
  const currentOwner = ownerActor();
  for (const [kind, id] of [
    ['budget', budgetId],
    ['account', SOURCE_ACCOUNT],
    ['account', DESTINATION_ACCOUNT],
  ] as const) {
    grant(OWNER, ownerMembershipId, kind, id, 'proposal');
    grant(OWNER, ownerMembershipId, kind, id, 'initiation-report');
    grant(OWNER, ownerMembershipId, kind, id, 'liquidity');
  }
  grant(OWNER, ownerMembershipId, 'account', SOURCE_ACCOUNT, 'source');
  const revision = store.liquidity.getClaimSet(currentOwner).revision;
  const plan = transferPlan();
  plan.claimSetRevision = plan.backingAfter.claimSetRevision = revision;
  plan.payloadHash = createHash('sha256').update(JSON.stringify({ ...plan, payloadHash: undefined })).digest('hex');
  const proposal = store.liquidity.admitTransferProposal({
    ...currentOwner,
    plan,
    expectedClaimSetRevision: revision,
    idempotencyKey: `home-attention-transfer-${sequence}:${ordinal}`,
  }, () => ({ valid: true }));
  const currentProposal = store.liquidity.revalidateTransfer({
    ...currentOwner,
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    expectedVersion: proposal.version,
    expectedClaimSetRevision: store.liquidity.getClaimSet(currentOwner).revision,
    idempotencyKey: `home-attention-recheck-${sequence}:${ordinal}`,
  }, () => ({ valid: false, reason: 'source_insufficient' }));
  return currentProposal;
}

function seedCategoryBudget() {
  const categoryId = snapshot.categories[0]!.id;
  snapshot.budgets = [{
    id: 'private-attention-risk-month', month: '2026-09',
    categories: { [categoryId]: {
      categoryId, amount: { minorUnits: '700', currency: 'USD' },
      carryover: { minorUnits: '0', currency: 'USD' },
      carryoverFromPrevious: { minorUnits: '0', currency: 'USD' }, carriesOver: false,
    } },
  }];
  return categoryId;
}

function delegatedRequest() {
  grant(READER, readerMembershipId, 'budget', budgetId, 'full-read');
  grant(READER, readerMembershipId, 'space', spaceId, 'delegation:manage');
  grant(READER, readerMembershipId, 'space', spaceId, 'credential:manage');
  const agentId = `agent:attention-${sequence}`;
  const credentialId = `credential:attention-${sequence}`;
  store.governance.registerAgent({ spaceId, agentId, now: NOW, auth: ownerControl });
  const issuerAuth = { method: 'human-session' as const, actorId: READER,
    sessionId: `session:${READER}`, reauthenticatedAt: NOW };
  const delegation = store.governance.delegate({
    spaceId, agentId, issuerMembershipId: readerMembershipId, expectedVersion: null,
    rights: ['observe', 'full-read', 'conclusion'].map((capability) => ({
      capability, resourceKind: 'budget' as const, resourceId: budgetId,
      ...(capability === 'conclusion' ? { restrictions: { aggregateOnly: true } } : {}),
    })),
    validFrom: NOW, validUntil: EXPIRES_AT, now: NOW, auth: issuerAuth,
  });
  store.governance.registerCredentialBinding({
    spaceId, credentialId, credentialOwnerId: READER, principalType: 'agent', principalId: agentId,
    delegationId: delegation.id, expectedDelegationVersion: delegation.version, now: NOW, auth: issuerAuth,
  });
  const event = request(agentId);
  event.context.auth = {
    authenticated: true, actorId: agentId, method: 'api-key', principalType: 'agent',
    credentialId, credentialOwnerId: READER, delegationId: delegation.id,
    delegationVersion: delegation.version, impersonatedBy: null,
  };
  return { event, agentId, credentialId, delegation, issuerAuth };
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'home-attention-native-'));
  const opened = getWorkflowStore(request(OWNER, '') as unknown as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({ name: 'Home attention owner', email: 'home-attention-owner@example.test', claimId: 'home-attention-fixture' });
  await store.finalizeBootstrap({ claimId: 'home-attention-fixture', ownerUserId: OWNER });
  await store.upsertActorMembership(READER, 'active', [], 'unscoped');
  await store.upsertActorMembership(DENIED, 'active', [], 'unscoped');
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  mocks.afterProtocol = mocks.afterAnalysis = mocks.afterDisposal = mocks.afterFinalConfig = undefined;
  vi.setSystemTime(new Date(NOW));
  sequence += 1;
  budgetId = `home-attention-budget-${sequence}`;
  const created = store.governance.createSpace({
    actorId: OWNER,
    name: `Home attention fixture ${sequence}`,
    kind: 'shared',
    now: NOW,
    auth: ownerControl,
  });
  spaceId = store.governance.bindBudget({
    spaceId: created.id,
    budgetId,
    now: NOW,
    auth: ownerControl,
  }).id;
  ownerMembershipId = store.governance.getCurrentMembership({ spaceId, actorId: OWNER, now: NOW })!.id;
  readerMembershipId = store.governance.addMembership({
    spaceId, actorId: READER, validFrom: NOW, now: NOW, auth: ownerControl,
  }).id;
  deniedMembershipId = store.governance.addMembership({
    spaceId, actorId: DENIED, validFrom: NOW, now: NOW, auth: ownerControl,
  }).id;
  grant(READER, readerMembershipId, 'budget', budgetId, 'observe');
  grant(READER, readerMembershipId, 'budget', budgetId, 'conclusion', { aggregateOnly: true });
  snapshot = canonicalProtocolSnapshotSchema.parse(structuredClone(representative));
  snapshot.snapshotDate = NOW;
  snapshot.accounts = [snapshot.accounts[0]!];
  snapshot.accounts[0]!.clearedBalance = { minorUnits: '0', currency: 'USD' };
  snapshot.accounts[0]!.importedBalance = { minorUnits: '0', currency: 'USD' };
  snapshot.categories = [snapshot.categories[0]!];
  snapshot.payees = [snapshot.payees[0]!];
  snapshot.payees[0]!.name = 'Private attention subscription';
  const transaction = snapshot.transactions[0]!;
  snapshot.transactions = ['2026-06-01', '2026-07-01', '2026-08-01'].map((date, index) => ({
    ...structuredClone(transaction), id: `private-attention-recurrence-${index}`, date,
    payeeName: snapshot.payees[0]!.name, importedPayee: null, importedId: null,
    amount: { minorUnits: '-100', currency: 'USD' },
  }));
  snapshot.budgets = [];
  snapshot.rules = [];
  snapshot.schedules = [];
  connectionConfig = { version: 1, serverUrl: 'https://actual-attention.test', budgetId,
    budgetName: 'Attention canonical fixture', groupId: 'attention-group' };
  mocks.loadConfig.mockImplementation(async () => {
    if (mocks.loadConfig.mock.calls.length > 1) await mocks.afterFinalConfig?.();
    return { ...connectionConfig };
  });
  mocks.withConnection.mockImplementation(async (operation) => {
    const synchronization = { snapshot };
    const result = await operation({
      config: { ...connectionConfig }, budget: { id: budgetId }, synchronization,
      connector: {
        synchronize: async () => synchronization,
        getLatestSynchronization: () => synchronization,
      },
    });
    await mocks.afterDisposal?.();
    return result;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('GET /api/home/attention', () => {
  it('projects a current aggregate-only transfer conclusion without private proposal or account fields', async () => {
    const proposal = await seedAttentionTransfer();

    const response = await handler(request());
    const visible = JSON.stringify(response);

    expect(response.status).toBe('ok');
    expect(response.result).toMatchObject({
      scopeLimited: true,
      blockers: [{
        code: 'transfer_needs_attention',
        classification: 'transfer_needs_attention',
        severity: 'warning',
        transferConclusion: {
          minimumAmount: { minorUnits: '2300', currency: 'USD' },
          requiredBy: EXPIRES_AT,
          authorizedHolderRequired: true,
        },
      }],
      alerts: [],
      recurrences: [],
      categoryRisks: [],
    });
    expect(response.result!.blockers).toHaveLength(1);
    expect(response.result!.blockers[0]!.transferConclusion).not.toHaveProperty('estimatedArrival');
    expect(visible).not.toContain(proposal.id);
    expect(visible).not.toContain(SOURCE_ACCOUNT);
    expect(visible).not.toContain(DESTINATION_ACCOUNT);
    expect(visible).not.toContain('source_insufficient');
    expect(visible).not.toContain('private-transfer-route');
    expect(visible).not.toContain('private-transfer-snapshot');
    expect(visible).not.toContain('private-transfer-content-hash');
    expect(visible).not.toContain('private-economic-obligation');
    expect(mocks.loadConfig).toHaveBeenCalledOnce();
    expect(mocks.withConnection).not.toHaveBeenCalled();
  });

  it('denies a space member without observe authority before connection access', async () => {
    const response = await handler(request(DENIED));

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('FORBIDDEN');
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(deniedMembershipId).not.toBe(readerMembershipId);
  });

  it('rejects a configured budget that differs from the selected space before restoring the connection', async () => {
    grant(READER, readerMembershipId, 'budget', budgetId, 'conclusion');
    mocks.loadConfig.mockResolvedValue({ budgetId: 'foreign-private-budget' });

    const response = await handler(request());

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('SPACE_CONNECTION_MISMATCH');
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain('foreign-private-budget');
  });
  it('returns real native recurrence Money and authorized private-transfer conclusions for an uncapped full reader', async () => {
    grant(READER, readerMembershipId, 'budget', budgetId, 'full-read');
    await seedAttentionTransfer();

    const response = await handler(request());

    expect(response.status).toBe('ok');
    expect(response.result!.recurrences).toEqual([expect.objectContaining({
      payeeName: 'Private attention subscription',
      amount: { minorUnits: '-100', currency: 'USD' },
      frequency: 'monthly', occurrences: 3, lastOccurrence: '2026-08-01',
    })]);
    expect(response.result!.blockers).toContainEqual(expect.objectContaining({
      transferConclusion: expect.objectContaining({ minimumAmount: { minorUnits: '2300', currency: 'USD' } }),
    }));
    expect(response.result).not.toHaveProperty('scopeLimited', true);
  });

  it('returns real native financial attention and current transfer conclusions for a valid bounded delegation', async () => {
    await seedAttentionTransfer();
    const { event } = delegatedRequest();

    const response = await handler(event);

    expect(response.status).toBe('ok');
    expect(response.result!.recurrences).toContainEqual(expect.objectContaining({
      payeeName: 'Private attention subscription', amount: { minorUnits: '-100', currency: 'USD' },
    }));
    expect(response.result!.blockers).toContainEqual(expect.objectContaining({
      transferConclusion: expect.objectContaining({ minimumAmount: { minorUnits: '2300', currency: 'USD' } }),
    }));
  });

  it('admits the exact complete source Money-slot count without merging it with outgoing slots', async () => {
    grant(READER, readerMembershipId, 'budget', budgetId, 'full-read', { maxOperationCount: 5 });

    const response = await handler(request());

    expect(response.status).toBe('ok');
    expect(response.result!.recurrences).toContainEqual(expect.objectContaining({
      amount: { minorUnits: '-100', currency: 'USD' }, occurrences: 3,
    }));
  });

  it('admits the exact complete outgoing recurrence and private-transfer gross collection', async () => {
    await seedAttentionTransfer();
    grant(READER, readerMembershipId, 'budget', budgetId, 'full-read', {
      maxGrossOutgoing: [{ minorUnits: '2400', currency: 'USD' }],
    });

    const response = await handler(request());

    expect(response.status).toBe('ok');
    expect(response.result!.recurrences).toContainEqual(expect.objectContaining({
      amount: { minorUnits: '-100', currency: 'USD' },
    }));
    expect(response.result!.blockers).toContainEqual(expect.objectContaining({
      transferConclusion: expect.objectContaining({ minimumAmount: { minorUnits: '2300', currency: 'USD' } }),
    }));
  });

  it.each([
    ['zero source slots', { maxOperationCount: 0 }],
    ['too few complete source slots', { maxOperationCount: 2 }],
    ['complete source gross, not recurrence output gross', { maxGrossOutgoing: [{ minorUnits: '299', currency: 'USD' }] }],
  ] as const)('denies %s before deriving financial attention for a valid full-budget actor', async (_name, restrictions) => {
    grant(READER, readerMembershipId, 'budget', budgetId, 'full-read', restrictions);

    const event = request();
    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(event.node.res.statusCode).toBe(403);
    expect(JSON.stringify(response)).not.toContain('Private attention subscription');
    expect(mocks.nativeAttention).not.toHaveBeenCalled();
  });

  it.each(['account balances', 'budget allocations and carryovers', 'scheduled amounts'] as const)(
    'admits the complete %s source manifest before derivation even with no transaction history',
    async (collection) => {
      snapshot.transactions = [];
      if (collection !== 'account balances') snapshot.accounts = [];
      if (collection === 'budget allocations and carryovers') {
        const categoryId = snapshot.categories[0]!.id;
        snapshot.budgets = [{
          id: 'private-attention-budget-month', month: '2026-09',
          categories: { [categoryId]: {
            categoryId, amount: { minorUnits: '500', currency: 'USD' },
            carryover: { minorUnits: '600', currency: 'USD' },
            carryoverFromPrevious: { minorUnits: '700', currency: 'USD' }, carriesOver: true,
          } },
        }];
      } else if (collection === 'scheduled amounts') {
        snapshot.schedules = [{
          id: 'private-attention-schedule', frequency: 'monthly', amount: { minorUnits: '-900', currency: 'USD' },
          payeeName: 'Private attention scheduled merchant', accountId: 'a_1', nextExpected: '2026-10-01',
        }];
      }
      grant(READER, readerMembershipId, 'budget', budgetId, 'full-read', { maxOperationCount: 0 });

      const event = request();
      const response = await handler(event);

      expect(response.status).toBe('error');
      expect(response.result).toBeNull();
      expect(event.node.res.statusCode).toBe(403);
      expect(mocks.nativeAttention).not.toHaveBeenCalled();
    },
  );

  it('admits the exact complete source gross independently of the smaller outgoing recurrence display', async () => {
    const categoryId = seedCategoryBudget();
    grant(READER, readerMembershipId, 'budget', budgetId, 'full-read', {
      maxGrossOutgoing: [{ minorUnits: '300', currency: 'USD' }],
    });

    const response = await handler(request());

    expect(response.status).toBe('ok');
    expect(response.result!.recurrences).toEqual([expect.objectContaining({
      amount: { minorUnits: '-100', currency: 'USD' }, occurrences: 3,
    })]);
    expect(response.result!.categoryRisks).toContainEqual(expect.objectContaining({
      categoryId, remainingBudget: { minorUnits: '400', currency: 'USD' },
    }));
  });

  it('counts incoming source Money without charging it as gross outgoing', async () => {
    snapshot.accounts[0]!.clearedBalance = { minorUnits: '-9223372036854775808', currency: 'USD' };
    snapshot.transactions.push({
      ...structuredClone(snapshot.transactions[0]!), id: 'private-attention-income',
      payeeId: null, payeeName: 'Private salary', amount: { minorUnits: '900000', currency: 'USD' },
    });
    grant(READER, readerMembershipId, 'budget', budgetId, 'full-read', {
      maxGrossOutgoing: [{ minorUnits: '300', currency: 'USD' }],
    });

    const response = await handler(request());

    expect(response.status).toBe('ok');
    expect(response.result!.recurrences).toContainEqual(expect.objectContaining({
      payeeName: 'Private attention subscription', amount: { minorUnits: '-100', currency: 'USD' },
    }));
  });

  it('discloses native category remaining budget alongside merchant recurrence Money for an uncapped full reader', async () => {
    const categoryId = seedCategoryBudget();
    grant(READER, readerMembershipId, 'budget', budgetId, 'full-read');

    const response = await handler(request());

    expect(response.status).toBe('ok');
    expect(response.result!.categoryRisks).toContainEqual(expect.objectContaining({
      categoryId, remainingBudget: { minorUnits: '400', currency: 'USD' },
    }));
    expect(response.result!.recurrences).toContainEqual(expect.objectContaining({
      amount: { minorUnits: '-100', currency: 'USD' },
    }));
  });

  it.each([3, 4])('independently counts category remaining budget and private transfer output at the %s-slot ceiling', async (maxOperationCount) => {
    const categoryId = seedCategoryBudget();
    snapshot.accounts = [];
    snapshot.transactions = [];
    snapshot.payees = [];
    for (let index = 0; index < 3; index++) await seedAttentionTransfer(index);
    grant(READER, readerMembershipId, 'budget', budgetId, 'full-read', { maxOperationCount });
    const event = request();

    const response = await handler(event);

    if (maxOperationCount === 3) {
      expect(response.status).toBe('error');
      expect(response.result).toBeNull();
      expect(event.node.res.statusCode).toBe(403);
    } else {
      expect(response.status).toBe('ok');
      expect(response.result!.categoryRisks).toContainEqual(expect.objectContaining({
        categoryId, remainingBudget: { minorUnits: '700', currency: 'USD' },
      }));
      expect(response.result!.blockers).toHaveLength(3);
      for (const blocker of response.result!.blockers)
        expect(blocker).toHaveProperty('transferConclusion.minimumAmount', { minorUnits: '2300', currency: 'USD' });
    }
  });

  it.each([
    ['zero outgoing slots', { maxOperationCount: 0 }, true],
    ['outgoing transfer gross exceeds independently admitted source', { maxGrossOutgoing: [{ minorUnits: '300', currency: 'USD' }] }, false],
  ] as const)('denies %s without aliasing the source and outgoing manifests', async (_name, restrictions, emptySource) => {
    await seedAttentionTransfer();
    grant(READER, readerMembershipId, 'budget', budgetId, 'full-read', restrictions);
    if (emptySource) {
      snapshot.accounts = [];
      snapshot.transactions = [];
      snapshot.categories = [];
      snapshot.payees = [];
    }
    const event = request();

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(event.node.res.statusCode).toBe(403);
    expect(JSON.stringify(response)).not.toContain('2300');
  });

  it('rechecks the admitted source and live credential after native protocol construction before derivation', async () => {
    grant(READER, readerMembershipId, 'budget', budgetId, 'full-read');
    const event = request();
    mocks.afterProtocol = async () => { event.context.auth!.authenticated = false; };

    const response = await handler(event);

    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(event.node.res.statusCode).toBe(403);
    expect(mocks.nativeAttention).not.toHaveBeenCalled();
  });

  it.each(['analysis', 'disposal', 'final-config'] as const)(
    'reprojects transfer conclusions revoked during %s rather than appending a captured private conclusion',
    async (boundary) => {
      grant(READER, readerMembershipId, 'budget', budgetId, 'full-read');
      await seedAttentionTransfer();
      let changed = false;
      const revoke = async () => {
        if (changed) return;
        changed = true;
        store.governance.setResourceGrant({
          spaceId, actorId: READER, membershipId: readerMembershipId, budgetId,
          capability: 'conclusion', resourceKind: 'budget', resourceId: budgetId,
          granted: false, now: NOW, auth: ownerControl,
        });
      };
      if (boundary === 'analysis') mocks.afterAnalysis = revoke;
      else if (boundary === 'disposal') mocks.afterDisposal = revoke;
      else mocks.afterFinalConfig = revoke;

      const response = await handler(request());

      expect(changed).toBe(true);
      expect(response.status).toBe('ok');
      expect(response.result!.recurrences).toContainEqual(expect.objectContaining({
        payeeName: 'Private attention subscription', amount: { minorUnits: '-100', currency: 'USD' },
      }));
      expect(response.result!.blockers).not.toContainEqual(expect.objectContaining({
        transferConclusion: expect.anything(),
      }));
      expect(JSON.stringify(response)).not.toContain('2300');
    },
  );

  it.each(['analysis', 'disposal', 'final-config'].flatMap((boundary) => [
    'observe grant', 'full-read grant', 'membership', 'policy version', 'credential lifetime', 'credential expiry',
    'request authentication', 'request identity', 'session identity', 'selected space', 'selected budget',
    'connection identity',
  ].map((change) => ({ boundary, change }))))(
    'withholds financial and private-transfer output after $change changes during $boundary',
    async ({ boundary, change }) => {
      grant(READER, readerMembershipId, 'budget', budgetId, 'full-read');
      await seedAttentionTransfer();
      const event = request();
      let validCredential = true;
      let changed = false;
      event.context.auth!.isCredentialValid = () => validCredential;
      event.context.auth!.credentialExpiresAt = EXPIRES_AT;
      const invalidate = async () => {
        if (changed) return;
        changed = true;
        switch (change) {
          case 'observe grant':
          case 'full-read grant':
            store.governance.setResourceGrant({
              spaceId, actorId: READER, membershipId: readerMembershipId, budgetId,
              capability: change === 'observe grant' ? 'observe' : 'full-read',
              resourceKind: 'budget', resourceId: budgetId,
              granted: false, now: NOW, auth: ownerControl,
            });
            break;
          case 'membership':
            store.governance.revokeMembership({ spaceId, membershipId: readerMembershipId, now: NOW, auth: ownerControl });
            break;
          case 'policy version': {
            const policy = store.governance.getPolicy({ spaceId })!;
            store.governance.setPolicy({
              spaceId, expectedVersion: policy.version,
              policy: { minimumApprovers: policy.minimumApprovers, approvalThresholds: policy.approvalThresholds,
                ...(policy.operationApprovers ? { operationApprovers: policy.operationApprovers } : {}) },
              now: NOW, auth: ownerControl,
            });
            break;
          }
          case 'credential lifetime':
            validCredential = false;
            break;
          case 'credential expiry':
            vi.setSystemTime(EXPIRES_AT);
            break;
          case 'request authentication':
            event.context.auth!.authenticated = false;
            break;
          case 'session identity':
            event.context.auth!.sessionId = 'changed-attention-session';
            break;
          case 'request identity':
            event.context.auth!.actorId = DENIED;
            event.context.auth!.user = { id: DENIED };
            break;
          case 'selected space':
            event.node.req.headers['x-balanceframe-space'] = 'unavailable-attention-space';
            break;
          case 'selected budget':
            store.governance.bindBudget({ spaceId, budgetId: `replaced-${budgetId}`, now: NOW, auth: ownerControl });
            break;
          case 'connection identity':
            connectionConfig.serverUrl = 'https://replaced-attention-source.test';
            break;
        }
      };
      if (boundary === 'analysis') mocks.afterAnalysis = invalidate;
      else if (boundary === 'disposal') mocks.afterDisposal = invalidate;
      else mocks.afterFinalConfig = invalidate;

      const response = await handler(event);

      expect(changed).toBe(true);
      expect(response.status).toBe('error');
      expect(response.result).toBeNull();
      const visible = JSON.stringify(response);
      expect(visible).not.toContain('Private attention subscription');
      expect(visible).not.toContain('2300');
      expect(visible).not.toContain(SOURCE_ACCOUNT);
      expect(visible).not.toContain(DESTINATION_ACCOUNT);
    },
  );

  it.each(['analysis', 'disposal', 'final-config'].flatMap((boundary) =>
    ['credential binding', 'delegation', 'agent registration', 'issuer membership'].map((change) => ({ boundary, change }))))(
    'withholds delegated financial and private-transfer output after $change revocation during $boundary',
    async ({ boundary, change }) => {
      await seedAttentionTransfer();
      const { event, agentId, credentialId, delegation, issuerAuth } = delegatedRequest();
      let changed = false;
      const invalidate = async () => {
        if (changed) return;
        changed = true;
        switch (change) {
          case 'credential binding':
            store.governance.revokeCredentialBinding({ spaceId, credentialId, now: NOW, auth: issuerAuth });
            break;
          case 'delegation':
            store.governance.revokeDelegation({
              spaceId, delegationId: delegation.id, expectedVersion: delegation.version, now: NOW, auth: issuerAuth,
            });
            break;
          case 'agent registration':
            store.governance.setAgentStatus({ spaceId, agentId, status: 'revoked', now: NOW, auth: ownerControl });
            break;
          case 'issuer membership':
            store.governance.revokeMembership({ spaceId, membershipId: readerMembershipId, now: NOW, auth: ownerControl });
            break;
        }
      };
      if (boundary === 'analysis') mocks.afterAnalysis = invalidate;
      else if (boundary === 'disposal') mocks.afterDisposal = invalidate;
      else mocks.afterFinalConfig = invalidate;

      const response = await handler(event);

      expect(changed).toBe(true);
      expect(response.status).toBe('error');
      expect(response.result).toBeNull();
      expect(JSON.stringify(response)).not.toContain('Private attention subscription');
      expect(JSON.stringify(response)).not.toContain('2300');
    },
  );
});
