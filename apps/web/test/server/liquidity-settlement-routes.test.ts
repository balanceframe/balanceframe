import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';
import type * as H3 from 'h3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FinancialSnapshot, LiquidityPolicy, TransferSettlementRecord } from '@balanceframe/protocol-generated';
import type { LiquidityActor, SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { LiquidityService } from '@balanceframe/application';
import { ConnectionManager, createLiquidityService } from '@balanceframe/application';
import {
  normalizeAccounts,
  normalizeActualLiquidityFacts,
  normalizeCategories,
  withLiquidityFacts,
} from '../../../../packages/actual-adapter/src/normalizer.js';
import type { ManualTransactionInput } from '@balanceframe/actual-adapter';
import { actualLiquidityRequest } from '../../../../tests/contract/fixtures/actual-liquidity.js';
import accountAwareLiquidityFixture from '../../../../protocol/fixtures/account-aware-liquidity.json';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { issueReauthentication } from '../../server/utils/reauthentication';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';
import transferReconcile from '../../server/api/transfer/[id]/reconcile.post';
import completionReconcile from '../../server/api/spend-sessions/[id]/completions/[proposalId]/reconcile.post';
import completionExecute from '../../server/api/spend-sessions/[id]/completions/[proposalId]/execute.post';
import spendability from '../../server/api/liquidity/spendability.get';
import proposeTransfer from '../../server/api/transfer/propose.post';

const fixture = vi.hoisted(() => ({
  manager: null as unknown,
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
}));

vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof H3>()),
  readBody: async (event: { body: unknown }) => event.body,
  getRouterParam: (event: { context: { params: Record<string, string> } }, name: string) =>
    event.context.params[name],
}));
vi.mock('../../lib/auth', () => ({
  auth: {
    api: {
      getSession: fixture.getSession,
      verifyPassword: fixture.verifyPassword,
    },
  },
}));
vi.mock('@balanceframe/workflow-store', async () =>
  await import('../../../../packages/workflow-store/src/index'));
vi.mock('@balanceframe/application', async () => ({
  ...(await import('../../../../packages/application/src/index')),
  createDefaultConnectionManager: () => fixture.manager as ConnectionManager,
}));
vi.mock('../../server/utils/mutation-executor', () => ({
  createMutationConnectionManager: () => fixture.manager as ConnectionManager,
}));

const actorId = 'settlement-route-human';
const sessionId = 'settlement-route-session';
const budgetId = 'fixture';
const now = '2026-09-06T10:01:00.000Z';
const arrival = '2026-09-06T10:02:00.000Z';
let clockNow = now;
let directory = '';
let store: SqliteWorkflowStore;
let service: LiquidityService;
let actor: LiquidityActor;
let current: FinancialSnapshot;
let settlementRecords: TransferSettlementRecord[] | undefined;
let spaceId = '';

const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const humanAuth = (userId: string, reauthenticatedAt = now) => ({
  method: 'human-session' as const,
  actorId: userId,
  sessionId: `session:${userId}`,
  reauthenticatedAt,
});

function snapshot(
  capturedAt = now,
  savingsBalance = 20000,
  checkingBalance = 9000,
): FinancialSnapshot {
  const base = actualLiquidityRequest(false).financialSnapshot;
  const accounts = [
    { id: 'checking', name: 'Checking', offbudget: false, closed: false, balance_current: checkingBalance },
    { id: 'savings', name: 'Private savings', offbudget: false, closed: false, balance_current: savingsBalance },
  ];
  const categories = [
    { id: 'food', name: 'Food', group_id: 'living', is_income: false, hidden: false },
    { id: 'other', name: 'Other', group_id: 'living', is_income: false, hidden: false },
  ];
  const ledger: FinancialSnapshot = {
    ...base,
    capturedAt,
    source: { ...base.source, budgetId },
    legacySnapshot: {
      ...base.legacySnapshot,
      snapshotDate: capturedAt,
      accounts: normalizeAccounts(accounts),
      categories: normalizeCategories(categories, [
        { id: 'living', name: 'Living', is_income: false, hidden: false },
      ]),
    },
  };
  return withLiquidityFacts(ledger, normalizeActualLiquidityFacts({
    capturedAt,
    ledgerContentHash: base.contentHash,
    currency: 'USD',
    accounts: { available: true, items: accounts },
    categories: { available: true, items: categories },
    budgetMonths: [{
      month: '2026-09',
      categoryGroups: [{ id: 'living', categories: [
        { id: 'food', balance: 2000 },
        { id: 'other', balance: 0 },
      ] }],
    }],
    transactions: accounts.map(({ id }) => ({ accountId: id, read: { available: true as const, items: [] } })),
    schedules: { available: true, items: [] },
  }));
}

function request(
  params: Record<string, string>,
  options: { cookie?: string; requestSessionId?: string; body?: unknown } = {},
) {
  const responseHeaders = new Map<string, string | number | readonly string[]>();
  return {
    body: options.body,
    context: {
      params,
      auth: {
        authenticated: true,
        actorId,
        user: { id: actorId },
        method: 'session' as const,
        principalType: 'human' as const,
        sessionId: options.requestSessionId ?? sessionId,
        impersonatedBy: null,
      },
      runtimeConfig: {
        workflowDbPath: ':memory:',
        devBypassAuth: false,
        reviewAndApply: true,
      },
    },
    node: {
      req: {
        method: 'POST',
        url: '/api/liquidity/settlement',
        headers: {
          origin: 'https://balanceframe.example.test',
          'x-balanceframe-space': spaceId,
          cookie: `better-auth.session_token=settlement-fixture${options.cookie ? `; ${options.cookie}` : ''}`,
        },
      },
      res: {
        statusCode: 200,
        statusMessage: '',
        setHeader: (key: string, value: string | number | readonly string[]) => {
          responseHeaders.set(key.toLowerCase(), value);
        },
        getHeader: (key: string) => responseHeaders.get(key.toLowerCase()),
      },
    },
  };
}

async function issueCookie(): Promise<string> {
  const event = request({ id: 'unused' });
  if (!(await issueReauthentication(event as unknown as ReauthenticationEvent, 'fixture-password')))
    throw new Error('Fixture human reauthentication failed');
  const header = event.node.res.getHeader('set-cookie');
  const values = Array.isArray(header) ? header : [header];
  const cookie = values.find((value): value is string => typeof value === 'string');
  if (!cookie) throw new Error('Fixture reauthentication cookie unavailable');
  return cookie.split(';', 1)[0]!;
}

function provisions(
  target: LiquidityActor,
  resourceKind: 'budget' | 'account' | 'category',
  resourceId: string,
  capability: string,
): void {
  store.governance.provisionResourceGrant({
    spaceId,
    actorId: target.actorId,
    membershipId: target.membershipId!,
    budgetId,
    resourceKind,
    resourceId,
    capability,
    granted: true,
    now,
    auth: humanAuth(actorId),
  });
}

function heldClaim(proposalId: string, at: string) {
  return store.liquidity.getClaimSet({
    ...actor,
    now: at,
    auth: { method: 'session', actorId, sessionId },
  }).bundles.find(({ id }) => id === proposalId);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  vi.stubEnv('BETTER_AUTH_SECRET', 'settlement-route-fixture-secret');
  vi.stubEnv('BETTER_AUTH_URL', 'https://balanceframe.example.test');
  vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
  fixture.getSession.mockResolvedValue({
    user: { id: actorId },
    session: { id: sessionId, userId: actorId },
  });
  fixture.verifyPassword.mockResolvedValue({ status: true });

  current = snapshot();
  directory = mkdtempSync(join(tmpdir(), 'liquidity-settlement-routes-'));
  const event = request({ id: 'unused' });
  const workflow = getWorkflowStore({
    ...event,
    context: { ...event.context, runtimeConfig: { ...event.context.runtimeConfig, workflowDbPath: join(directory, 'workflow.sqlite') } },
  } as unknown as EventWithContext);
  if ('error' in workflow) throw new Error(workflow.error);
  store = workflow.store;
  await store.claimBootstrap({ name: 'Settlement owner', email: 'settlement-owner@example.test', claimId: 'settlement-route-fixture' });
  await store.finalizeBootstrap({ claimId: 'settlement-route-fixture', ownerUserId: actorId });
  await store.upsertActorMembership(actorId, 'active', ['observe'], `budget:${budgetId}`);
  const space = store.governance.createSpace({
    actorId,
    name: 'Settlement route fixture',
    kind: 'shared',
    now,
    auth: humanAuth(actorId),
  });
  spaceId = store.governance.bindBudget({
    spaceId: space.id,
    budgetId,
    now,
    auth: humanAuth(actorId),
  }).id;
  const membership = store.governance.getCurrentMembership({ spaceId, actorId, now });
  if (!membership) throw new Error('Settlement fixture membership unavailable');
  const initialPolicy = store.governance.getPolicy({ spaceId });
  if (!initialPolicy) throw new Error('Settlement fixture policy unavailable');
  store.governance.setPolicy({
    spaceId,
    expectedVersion: initialPolicy.version,
    policy: { minimumApprovers: 1 },
    now,
    auth: humanAuth(actorId),
  });
  actor = {
    actorId,
    budgetId,
    spaceId,
    membershipId: membership.id,
    governancePolicyVersion: store.governance.getPolicy({ spaceId })!.version,
    now,
    auth: humanAuth(actorId),
  };

  const capabilities = [
    'conclusion', 'existence', 'name', 'balance', 'history', 'liquidity', 'source', 'category',
    'proposal', 'approval', 'initiation-report', 'confirmation', 'audit', 'policy', 'session', 'full-read',
  ] as const;
  const resources = [
    ['budget', budgetId],
    ['account', 'checking'],
    ['account', 'savings'],
    ['category', 'food'],
    ['category', 'other'],
  ] as const;
  for (const [resourceKind, resourceId] of resources)
    for (const capability of capabilities)
      if (capability !== 'full-read' || resourceKind === 'budget')
        provisions(actor, resourceKind, resourceId, capability);
  for (const capability of ['transfer:confirm', 'session:reconcile', 'session:execute'])
    provisions(actor, 'budget', budgetId, capability);

  const manager = new ConnectionManager({
    readFile: async () => JSON.stringify({
      version: 1,
      serverUrl: 'http://actual',
      budgetId,
      budgetName: 'Fixture',
      groupId: 'fixture-group',
    }),
    writeFile: async () => {},
    credentialStore: {
      load: async () => ({ serverUrl: 'http://actual', secretKey: 'fixture' }),
      store: async () => {},
    },
    connectorFactory: async () => ({
      connect: async () => [],
      selectBudget: async () => ({ id: budgetId, groupId: 'fixture-group', name: 'Fixture', encrypted: false }),
      synchronize: async () => ({
        financialSnapshot: current,
        snapshot: current.legacySnapshot,
        transferSettlementRecords: settlementRecords,
      }),
      createManualTransaction: async (input: ManualTransactionInput) => {
        current.legacySnapshot.transactions.push({
          id: input.parentId,
          accountId: input.accountId,
          date: input.date,
          payeeId: null,
          payeeName: input.payeeName ?? null,
          categoryId: input.categoryId ?? null,
          categoryName: input.categoryId === 'food' ? 'Food' : null,
          amount: money(String(input.amount)),
          cleared: false,
          reconciled: false,
          importedId: null,
          importedPayee: null,
          notes: input.notes ?? null,
          tags: [],
          transferAccountId: null,
          subtransactions: [],
        });
        const written = current.legacySnapshot.transactions.find((transaction) =>
          transaction.id === input.parentId &&
          transaction.accountId === input.accountId &&
          transaction.date === input.date &&
          transaction.amount.minorUnits === String(input.amount) &&
          transaction.amount.currency === 'USD' &&
          transaction.categoryId === (input.categoryId ?? null) &&
          transaction.importedId === null,
        );
        return written
          ? {
              success: true as const,
              parentId: input.parentId,
              correlationId: input.correlationId,
              transactionId: written.id,
              verified: true as const,
            }
          : {
              success: false as const,
              parentId: input.parentId,
              correlationId: input.correlationId,
              code: 'VERIFICATION_FAILED' as const,
              error: 'Actual parent transaction verification failed',
              reviewRequired: true as const,
            };
      },
      disconnect: async () => {},
    }),
  });
  fixture.manager = manager;
  service = await createLiquidityService({ connectionManager: manager, store });
  const policyFixture = accountAwareLiquidityFixture.liquidityPolicy as LiquidityPolicy;
  store.liquidity.savePolicy({
    ...actor,
    expectedVersion: null,
    expectedGovernancePolicyVersion: actor.governancePolicyVersion!,
    now,
    auth: actor.auth!,
    policy: policyFixture,
    approvalPolicy: { minimumApprovers: 1 },
  });
  actor = {
    ...actor,
    governancePolicyVersion: store.governance.getPolicy({ spaceId })!.version,
  };
  await service.saveObservations(actor, {
    expectedVersion: 0,
    expiresAt: policyFixture.expiresAt,
    observations: ['checking', 'savings'].map((accountId) => ({
      accountId,
      currentLedgerConfirmed: true,
      kind: 'cash',
      currency: 'USD',
      owned: true,
      holds: money('0'),
    })),
  });
  const configuredPolicy = (await service.configuration(actor)).policy!;
  await service.savePolicy(actor, {
    expectedVersion: configuredPolicy.version,
    expiresAt: configuredPolicy.expiresAt,
    accounts: configuredPolicy.accounts.map(({ resourceScope: _scope, ...accountPolicy }) => accountPolicy),
    transferRoutes: configuredPolicy.transferRoutes.map(({ evidence: _evidence, ...route }) => ({
      ...route,
      providerArrivalAt: arrival,
    })),
    approvalPolicy: { minimumApprovers: 1 },
  });
  actor = {
    ...actor,
    governancePolicyVersion: store.governance.getPolicy({ spaceId })!.version,
  };
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('fresh human settlement routes', () => {
  it('admits aggregate-only public conclusions but never private resource rows or revoked readers', async () => {
    const readerId = 'aggregate-only-route-reader';
    await store.upsertActorMembership(readerId, 'active', [], '');
    const membership = store.governance.addMembership({
      spaceId, actorId: readerId, validFrom: now, now, auth: humanAuth(actorId),
    });
    for (const capability of ['liquidity', 'conclusion', 'full-read']) store.governance.provisionResourceGrant({
      spaceId, actorId: readerId, membershipId: membership.id, budgetId,
      resourceKind: 'budget', resourceId: budgetId, capability, granted: true,
      restrictions: { aggregateOnly: true }, now, auth: humanAuth(actorId),
    });
    const expected = await service.spendability(actor);
    const event = request({});
    event.node.req.method = 'GET';
    event.node.req.url = '/api/liquidity/spendability';
    event.context.auth.actorId = readerId;
    event.context.auth.user.id = readerId;
    event.context.auth.sessionId = `session:${readerId}`;
    const response = await spendability(event as unknown as H3Event);
    expect(response.error).toBeNull();
    expect(response.result).toMatchObject({
      fundingStatus: expected.fundingStatus, paymentStatus: expected.paymentStatus,
      accounts: [], categories: [],
    });
    expect(JSON.stringify(response.result)).not.toMatch(/checking|savings|Private savings|food|Food|20000|9000|2000/);
    store.governance.setResourceGrant({
      spaceId, actorId: readerId, membershipId: membership.id, budgetId,
      resourceKind: 'budget', resourceId: budgetId, capability: 'liquidity',
      granted: false, now, auth: humanAuth(actorId),
    });
    const restoration = vi.spyOn(fixture.manager as ConnectionManager, 'withConnection');
    try {
      const denied = await spendability(event as unknown as H3Event);
      expect(denied.status).toBe('error');
      expect(denied.result).toBeNull();
      expect(restoration).not.toHaveBeenCalled();
    } finally {
      restoration.mockRestore();
    }
  });
  it('admits an exact transfer intent through proposal-only operation-scoped grants without initiating it', async () => {
    const preview = await service.previewTransfer(actor, {
      kind: 'purchase', categoryId: 'food', amount: money('2000'), accountId: 'checking',
      purchaseAt: '2026-09-06T12:00:00.000Z', requiredBy: '2026-09-06T12:00:00.000Z',
    });
    const proposalGrants = store.governance.listResourceGrants({ spaceId, actorId })
      .filter((grant) => grant.capability === 'proposal' && grant.granted);
    const privateGrants = store.governance.listResourceGrants({ spaceId, actorId })
      .filter((grant) => ['existence', 'name', 'balance', 'history', 'liquidity'].includes(grant.capability) && grant.granted);
    for (const grant of privateGrants)
      store.governance.setResourceGrant({
        ...grant, granted: false, now, auth: humanAuth(actorId),
      });
    for (const grant of proposalGrants) {
      store.governance.setResourceGrant({
        ...grant, spaceId, membershipId: actor.membershipId!,
        restrictions: { proposalOnly: true, operations: ['transfer'] },
        now, auth: humanAuth(actorId),
      });
    }
    try {
      const response = await proposeTransfer(request({}, {
        body: { previewId: preview.previewId, payloadHash: preview.payloadHash, idempotencyKey: 'proposal-only-source-transfer' },
      }) as unknown as H3Event);
      expect(response.error).toBeNull();
      expect(response.result).toMatchObject({
        phase: 'proposed', plan: null, canApprove: false, canGetInstructions: false,
        sourceObserved: false, destinationObserved: false,
      });
      const stored = await store.getProposal(response.result!.id);
      expect(stored).toMatchObject({
        operation: 'transfer', state: { phase: 'proposed', sourceObserved: false, destinationObserved: false },
      });
      const replay = await proposeTransfer(request({}, {
        body: { previewId: preview.previewId, payloadHash: preview.payloadHash, idempotencyKey: 'proposal-only-source-transfer' },
      }) as unknown as H3Event);
      expect(replay.error).toBeNull();
      expect(replay.result).toMatchObject({
        id: response.result!.id, phase: 'proposed', plan: null,
        sourceObserved: false, destinationObserved: false,
      });
      expect(JSON.stringify(replay.result)).not.toContain('Private savings');
    } finally {
      for (const grant of proposalGrants) {
        store.governance.setResourceGrant({
          ...grant, spaceId, membershipId: actor.membershipId!,
          restrictions: grant.restrictions, now, auth: humanAuth(actorId),
        });
      }
      for (const grant of privateGrants)
        store.governance.setResourceGrant({
          ...grant, now, auth: humanAuth(actorId),
        });
    }
  });
  it('denies unproved, stale and session-mismatched settlement routes, then settles only from exact Actual evidence', async () => {
    const grants = store.governance.listResourceGrants({ spaceId, actorId });
    for (const capability of ['transfer:confirm', 'session:reconcile', 'session:execute'])
      expect(grants).toContainEqual(expect.objectContaining({
        actorId,
        membershipId: actor.membershipId,
        budgetId,
        resourceKind: 'budget',
        resourceId: budgetId,
        capability,
        granted: true,
      }));
    expect(grants.some((grant) =>
      grant.resourceKind === 'space' &&
      ['transfer:confirm', 'session:reconcile', 'session:execute'].includes(grant.capability),
    )).toBe(false);
    const preview = await service.previewTransfer(actor, {
      kind: 'purchase',
      categoryId: 'food',
      amount: money('2000'),
      accountId: 'checking',
      purchaseAt: '2026-09-06T12:00:00.000Z',
      requiredBy: '2026-09-06T12:00:00.000Z',
    });
    const admitted = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'settlement-route-admission',
    });
    const approverId = 'settlement-route-approver';
    await store.upsertActorMembership(approverId, 'active', [], '');
    const approverMembership = store.governance.addMembership({
      spaceId,
      actorId: approverId,
      validFrom: now,
      now,
      auth: humanAuth(actorId),
    });
    const approverPolicy = store.governance.getPolicy({ spaceId });
    if (!approverPolicy) throw new Error('Settlement approver policy unavailable');
    const approver: LiquidityActor = {
      ...actor,
      actorId: approverId,
      membershipId: approverMembership.id,
      governancePolicyVersion: approverPolicy.version,
      auth: humanAuth(approverId),
    };
    for (const capability of ['proposal', 'approval', 'conclusion', 'liquidity'])
      provisions(approver, 'budget', budgetId, capability);
    for (const [resourceKind, resourceId] of [
      ['account', 'checking'], ['account', 'savings'], ['category', 'food'], ['category', 'other'],
    ] as const) {
      for (const capability of ['existence', 'name', 'balance', 'history', 'liquidity', 'proposal', 'approval'])
        provisions(approver, resourceKind, resourceId, capability);
      if (resourceKind === 'account' && resourceId === 'savings')
        provisions(approver, 'account', resourceId, 'source');
    }
    provisions(approver, 'budget', budgetId, 'session');
    const approved = await service.transferAction(approver, admitted.id, 'approve', {
      payloadHash: admitted.payloadHash,
      expectedVersion: admitted.version,
      idempotencyKey: 'settlement-route-approval',
    });
    const initiated = await service.transferAction(actor, admitted.id, 'report-initiated', {
      payloadHash: approved.payloadHash,
      expectedVersion: approved.version,
      idempotencyKey: 'settlement-route-initiation',
    });
    expect(initiated.phase).toBe('initiated');

    clockNow = '2026-09-06T10:03:00.000Z';
    vi.setSystemTime(new Date(clockNow));
    current = {
      ...snapshot(clockNow, 17000, 12000),
      coverage: { ...snapshot(clockNow, 17000, 12000).coverage, transactions: 'complete' },
    };
    settlementRecords = [
      {
        id: 'reported-source',
        accountId: 'savings',
        amount: money('-3000'),
        observedAt: clockNow,
        occurredAt: arrival,
        importedId: 'reported-bank-source',
        providerReference: null,
        pairId: 'reported-bank-pair',
        reconciled: true,
        reversed: false,
        provenance: 'actual_import',
      },
      {
        id: 'reported-destination',
        accountId: 'checking',
        amount: money('3000'),
        observedAt: clockNow,
        occurredAt: arrival,
        importedId: 'reported-bank-destination',
        providerReference: null,
        pairId: 'reported-bank-pair',
        reconciled: true,
        reversed: false,
        provenance: 'actual_import',
      },
    ];
    const params = { id: admitted.id };
    const command = {
      payloadHash: initiated.payloadHash,
      expectedVersion: initiated.version,
      idempotencyKey: 'h3-current-actual-settlement',
    };
    const noProof = await transferReconcile(request(params, { body: command }) as unknown as H3Event);
    expect(noProof).toMatchObject({ status: 'error', error: { code: 'REAUTHENTICATION_REQUIRED' } });
    expect(heldClaim(admitted.id, clockNow)).toMatchObject({ id: admitted.id, state: 'initiated' });

    const noProofCompletionReconcile = await completionReconcile(request(
      { id: 'missing-session', proposalId: 'missing-completion' }, { body: {} },
    ) as unknown as H3Event);
    const noProofCompletionExecute = await completionExecute(request(
      { id: 'missing-session', proposalId: 'missing-completion' }, { body: {} },
    ) as unknown as H3Event);
    for (const response of [noProofCompletionReconcile, noProofCompletionExecute])
      expect(response).toMatchObject({ status: 'error', error: { code: 'REAUTHENTICATION_REQUIRED' } });
    expect(heldClaim(admitted.id, clockNow)).toMatchObject({ id: admitted.id, state: 'initiated' });

    const staleCookie = await issueCookie();
    clockNow = '2026-09-06T10:08:01.000Z';
    vi.setSystemTime(new Date(clockNow));
    for (const route of [transferReconcile, completionReconcile, completionExecute]) {
      const response = await route(request(
        route === transferReconcile ? params : { id: 'missing-session', proposalId: 'missing-completion' },
        { cookie: staleCookie, body: command },
      ) as unknown as H3Event);
      expect(response).toMatchObject({ status: 'error', error: { code: 'REAUTHENTICATION_REQUIRED' } });
      expect(heldClaim(admitted.id, clockNow)).toMatchObject({ id: admitted.id, state: 'initiated' });
    }

    clockNow = '2026-09-06T10:03:00.000Z';
    vi.setSystemTime(new Date(clockNow));
    const boundCookie = await issueCookie();
    const wrongSession = await transferReconcile(request(params, {
      cookie: boundCookie,
      requestSessionId: 'different-human-session',
      body: { ...command, idempotencyKey: 'h3-session-binding-denial' },
    }) as unknown as H3Event);
    expect(wrongSession).toMatchObject({ status: 'error', error: { code: 'REAUTHENTICATION_REQUIRED' } });
    expect(heldClaim(admitted.id, clockNow)).toMatchObject({ id: admitted.id, state: 'initiated' });

    const currentCookie = await issueCookie();
    const settled = await transferReconcile(request(params, {
      cookie: currentCookie,
      body: command,
    }) as unknown as H3Event);
    expect(settled).toMatchObject({
      status: 'ok',
      result: {
        id: admitted.id,
        phase: 'confirmed',
        sourceObserved: true,
        destinationObserved: true,
        reconciled: true,
      },
    });
    expect(heldClaim(admitted.id, clockNow)).toBeUndefined();
    await service.saveObservations(actor, {
      expectedVersion: 1,
      expiresAt: '2026-09-07T00:00:00.000Z',
      observations: ['checking', 'savings'].map((accountId) => ({
        accountId,
        currentLedgerConfirmed: true,
        kind: 'cash',
        currency: 'USD',
        owned: true,
        holds: money('0'),
      })),
    });
    const session = await service.saveSession(actor, null, {
      accountId: 'checking',
      expiresAt: '2026-09-06T23:00:00.000Z',
      items: [{
        id: 'actual-paid-item',
        categoryId: 'food',
        accountId: 'checking',
        amount: money('1000'),
        purchaseAt: clockNow,
        requiredBy: clockNow,
      }],
    });
    expect(session.card.outcome).toBe('funded_now');
    const completion = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'h3-session-completion',
    });
    const approvedCompletion = await service.approveSessionCompletion(approver, completion.id, {
      payloadHash: completion.payloadHash!,
      expectedVersion: completion.version,
      idempotencyKey: 'h3-session-completion-approval',
    });
    const completionParams = { id: session.id, proposalId: completion.id };
    const completionCommand = {
      payloadHash: approvedCompletion.payloadHash!,
      expectedVersion: approvedCompletion.version,
      idempotencyKey: 'h3-session-completion-execute',
    };
    const unprovedCompletionExecute = await completionExecute(request(completionParams, {
      body: completionCommand,
    }) as unknown as H3Event);
    expect(unprovedCompletionExecute).toMatchObject({
      status: 'error',
      error: { code: 'REAUTHENTICATION_REQUIRED' },
    });
    expect(store.liquidity.getClaimSet({ ...actor, now: clockNow }).bundles).toHaveLength(1);
    const unprovedCompletionReconcile = await completionReconcile(request(completionParams, {
      body: completionCommand,
    }) as unknown as H3Event);
    expect(unprovedCompletionReconcile).toMatchObject({
      status: 'error',
      error: { code: 'REAUTHENTICATION_REQUIRED' },
    });

    clockNow = '2026-09-06T10:08:01.000Z';
    vi.setSystemTime(new Date(clockNow));
    for (const route of [completionReconcile, completionExecute]) {
      const response = await route(request(completionParams, {
        cookie: staleCookie,
        body: completionCommand,
      }) as unknown as H3Event);
      expect(response).toMatchObject({
        status: 'error',
        error: { code: 'REAUTHENTICATION_REQUIRED' },
      });
      expect(store.liquidity.getClaimSet({ ...actor, now: clockNow }).bundles).toHaveLength(1);
    }

    clockNow = '2026-09-06T10:03:00.000Z';
    vi.setSystemTime(new Date(clockNow));
    for (const route of [completionReconcile, completionExecute]) {
      const sessionMismatch = await route(request(completionParams, {
        cookie: boundCookie,
        requestSessionId: 'different-human-session',
        body: { ...completionCommand, idempotencyKey: 'h3-session-binding-denial' },
      }) as unknown as H3Event);
      expect(sessionMismatch).toMatchObject({
        status: 'error',
        error: { code: 'REAUTHENTICATION_REQUIRED' },
      });
      expect(store.liquidity.getClaimSet({ ...actor, now: clockNow }).bundles).toHaveLength(1);
    }

    const executedCompletion = await completionExecute(request(completionParams, {
      cookie: currentCookie,
      body: completionCommand,
    }) as unknown as H3Event);
    expect(executedCompletion).toMatchObject({
      status: 'ok',
      result: { id: completion.id, phase: 'verified' },
    });
    expect(store.liquidity.getClaimSet({ ...actor, now: clockNow }).bundles).toEqual([]);
    const completionAfterExecution = await service.sessionCompletion(actor, completion.id);
    const completionReconciled = await completionReconcile(request(completionParams, {
      cookie: currentCookie,
      body: {
        payloadHash: approvedCompletion.payloadHash,
        expectedVersion: completionAfterExecution.version,
        idempotencyKey: 'h3-session-completion-reconcile',
      },
    }) as unknown as H3Event);
    expect(completionReconciled).toMatchObject({
      status: 'ok',
      result: { id: completion.id, phase: 'verified' },
    });
  });
});
