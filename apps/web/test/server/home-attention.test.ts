import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent } from 'h3';
import type * as H3 from 'h3';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TransferPlan } from '@balanceframe/protocol-generated';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({ budgetId: '' })),
  withConnection: vi.fn(),
}));

// Vitest hoists these package mocks, so their factories load Source modules instead of stale workspace exports.
// Keep Native governance and projections real; only avoid restoring an external Actual connection.
vi.mock('@balanceframe/application', async () => ({
  ...(await import('../../../../packages/application/src/index')),
  createDefaultConnectionManager: () => ({
    loadConfig: mocks.loadConfig,
    withConnection: mocks.withConnection,
  }),
}));
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
  resourceKind: 'budget' | 'account',
  resourceId: string,
  capability: string,
  restrictions?: { aggregateOnly?: boolean },
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

async function seedAttentionTransfer() {
  const owner = ownerActor();
  const policy = store.governance.getPolicy({ spaceId });
  if (!policy) throw new Error('Home attention governance policy unavailable');
  grant(OWNER, ownerMembershipId, 'budget', budgetId, 'policy');
  store.liquidity.savePolicy({
    ...owner,
    expectedVersion: null,
    expectedGovernancePolicyVersion: policy.version,
    policy: { version: '1', policyHash: 'private-transfer-policy-hash', expiresAt: EXPIRES_AT, accounts: [], transferRoutes: [] },
    approvalPolicy: { minimumApprovers: 1 },
  });
  const currentOwner = ownerActor();
  for (const [kind, id] of [
    ['budget', budgetId],
    ['account', SOURCE_ACCOUNT],
    ['account', DESTINATION_ACCOUNT],
  ] as const) {
    grant(OWNER, ownerMembershipId, kind, id, 'proposal');
    grant(OWNER, ownerMembershipId, kind, id, 'initiation-report');
  }
  grant(OWNER, ownerMembershipId, 'account', SOURCE_ACCOUNT, 'source');
  const proposal = store.liquidity.admitTransferProposal({
    ...currentOwner,
    plan: transferPlan(),
    expectedClaimSetRevision: '0',
    idempotencyKey: `home-attention-transfer-${sequence}`,
  }, () => ({ valid: true }));
  const currentProposal = store.liquidity.revalidateTransfer({
    ...currentOwner,
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    expectedVersion: proposal.version,
    expectedClaimSetRevision: '1',
    idempotencyKey: `home-attention-recheck-${sequence}`,
  }, () => ({ valid: false, reason: 'source_insufficient' }));
  return currentProposal;
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
  mocks.loadConfig.mockResolvedValue({ budgetId });
  mocks.withConnection.mockClear();
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
});
