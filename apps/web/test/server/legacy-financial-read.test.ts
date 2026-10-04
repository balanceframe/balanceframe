import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GENERIC_MUTATION_POLICY_VERSION,
  SqliteWorkflowStore,
} from '../../../../packages/workflow-store/src/index';
import type { ResourceCapability } from '../../../../packages/workflow-store/src/index';
import { getWorkflowStore, requireAuthorization } from '../../server/utils/workflow-store';
import type { EventWithContext } from '../../server/utils/workflow-store';
import type { ReauthenticationEvent } from '../../server/utils/reauthentication';
import type { TransactionEntity } from '@actual-app/core/types/models';
import type { FinancialSnapshot } from '@balanceframe/protocol-generated';
import { actualLiquidityRequest } from '../../../../tests/contract/fixtures/actual-liquidity.js';
import {
  normalizeAccounts,
  normalizeActualLiquidityFacts,
  normalizeBudgetMonth,
  normalizeCategories,
  normalizeTransactions,
  withLiquidityFacts,
} from '../../../../packages/actual-adapter/src/normalizer.js';

const {
  getSession,
  verifyPassword,
  query,
  body,
  mockActualConnector,
  mockCreateActualClient,
  sdkConnector,
} = vi.hoisted(() => ({
  getSession: vi.fn(),
  verifyPassword: vi.fn(),
  query: vi.fn(),
  body: vi.fn(),
  mockActualConnector: vi.fn(),
  mockCreateActualClient: vi.fn(),
  sdkConnector: {
    connect: vi.fn(),
    selectBudget: vi.fn(),
    synchronize: vi.fn(),
    disconnect: vi.fn(),
  },
}));
vi.mock('h3', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  getCookie: (event: { cookies?: Record<string, string> }, name: string) => event.cookies?.[name],
  getHeader: (event: { headers?: Record<string, string> }, name: string) =>
    event.headers?.[name.toLowerCase()],
  getQuery: query,
  getRequestHeaders: (event: { headers?: Record<string, string> }) => event.headers ?? {},
  readBody: body,
  getRouterParam: (event: { context: { params?: Record<string, string> } }, name: string) =>
    event.context.params?.[name],
  setHeader: vi.fn(),
  setResponseStatus: vi.fn(),
  setCookie: (event: { cookies?: Record<string, string> }, name: string, value: string) => {
    event.cookies ??= {};
    event.cookies[name] = value;
  },
}));
vi.mock('better-auth/node', () => ({
  fromNodeHeaders: (headers: ConstructorParameters<typeof Headers>[0]) => new Headers(headers),
}));
vi.mock('../../lib/auth', () => ({
  auth: { api: { getSession, verifyPassword } },
}));
vi.mock('@balanceframe/actual-adapter', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ActualConnector: mockActualConnector,
  createDefaultActualClient: mockCreateActualClient,
}));
import { issueReauthentication } from '../../server/utils/reauthentication';
import handler from '../../server/api/liquidity.get';
import historyHandler from '../../server/api/reports/history.get';
import viewHandler from '../../server/api/reports/views/[id].get';
import duplicateViewHandler from '../../server/api/reports/views/[id]/duplicate.post';
import reviewHandler from '../../server/api/review/index.get';
import proposalHandler from '../../server/api/proposal/index.get';
import discoveryHandler from '../../server/api/connection/budgets.get';
import selectionHandler from '../../server/api/connection/index.post';
import cashFlowHandler from '../../server/api/cash-flow/project.get';
import reportGenerateHandler from '../../server/api/reports/generate.get';

const actorId = 'reader';
const ownerId = 'registered-owner';
let budgetId = 'selected-private-budget';
let foreignBudgetId = 'foreign-budget';
const secret = 'private-source-balance-and-routing-proof';
const now = '2026-10-03T12:00:00.000Z';
function financialSnapshotForBudget(selectedBudgetId: string): FinancialSnapshot {
  const base = actualLiquidityRequest(false).financialSnapshot;
  const rawAccounts = [{
    id: 'selected-account',
    name: 'Checking',
    offbudget: false,
    closed: false,
    balance_current: 1000,
  }];
  const rawCategories = [{
    id: 'food',
    name: 'Food',
    group_id: 'living',
    is_income: false,
    hidden: false,
  }];
  const sourceTransaction = {
    id: 'selected-transaction',
    account: 'selected-account',
    date: now.slice(0, 10),
    payee: null,
    category: 'food',
    amount: -1000,
    cleared: true,
    reconciled: true,
    imported_id: 'selected-import',
    imported_payee: null,
    notes: null,
  } as TransactionEntity;
  const budgetMonth = {
    month: now.slice(0, 7),
    categoryGroups: [{
      id: 'living',
      categories: [{ id: 'food', budgeted: 1000, spent: -100, balance: 2000 }],
    }],
  };
  const legacySnapshot: FinancialSnapshot['legacySnapshot'] = {
    ...base.legacySnapshot,
    snapshotDate: now,
    actualDownloadedAt: now,
    accounts: normalizeAccounts(rawAccounts),
    categories: normalizeCategories(rawCategories, [
      { id: 'living', name: 'Living', is_income: false, hidden: false },
    ]),
    budgets: [normalizeBudgetMonth(now.slice(0, 7), { food: 1000 })],
    transactions: normalizeTransactions(
      [sourceTransaction],
      {},
      { food: { name: 'Food', groupName: 'Living' } },
      {},
    ),
  };
  const ledgerContentHash = `sha256:${createHash('sha256').update(JSON.stringify(legacySnapshot)).digest('hex')}`;
  const ledger: FinancialSnapshot = {
    ...base,
    snapshotId: `actual:${selectedBudgetId}:${selectedBudgetId}:${ledgerContentHash}`,
    contentHash: ledgerContentHash,
    source: {
      ...base.source,
      ledgerId: selectedBudgetId,
      budgetId: selectedBudgetId,
    },
    capturedAt: now,
    legacySnapshot,
    coverage: { ...base.coverage, transactions: 'complete' },
    liquidity: null,
  };
  return withLiquidityFacts(ledger, normalizeActualLiquidityFacts({
    capturedAt: now,
    ledgerContentHash,
    currency: 'USD',
    accounts: { available: true, items: rawAccounts },
    categories: { available: true, items: rawCategories },
    budgetMonths: [budgetMonth],
    transactions: [{
      accountId: 'selected-account',
      read: { available: true, items: [sourceTransaction] },
    }],
    schedules: { available: true, items: [] },
  }));
}
const fullRead: ResourceCapability = 'full-read';
const controlAuth = {
  method: 'human-session' as const,
  actorId: ownerId,
  sessionId: `session:${ownerId}`,
  reauthenticatedAt: now,
};
let spaceIds: Record<string, string> = {};
let memberships: Record<string, Record<string, string>> = {};
const sessionAuth = (id: string) => ({
  method: 'session' as const,
  actorId: id,
  sessionId: `session:${id}`,
});
const event = (id = actorId) => ({
  headers: {
    'x-balanceframe-space': spaceIds[budgetId],
    origin: 'http://localhost:3000',
  },
  node: {
    req: {
      headers: {
        'x-balanceframe-space': spaceIds[budgetId],
        origin: 'http://localhost:3000',
        cookie: 'better-auth.session_token=authorized-test-session',
      },
    },
  },
  cookies: {},
  context: {
    runtimeConfig: { workflowDbPath: ':memory:', devBypassAuth: false },
    auth: {
      authenticated: true,
      actorId: id,
      principalType: 'human',
      method: 'session',
      sessionId: `session:${id}`,
      user: { id },
    },
  },
});


describe('legacy whole-budget financial read authorization', () => {
  let configDirectory = '';
  let configPath = '';
  let store: SqliteWorkflowStore;
  let fixtureSequence = 0;
  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    configDirectory = mkdtempSync(join(tmpdir(), 'balanceframe-legacy-read-'));
    configPath = join(configDirectory, 'connection.json');
    const workflow = getWorkflowStore(event() as EventWithContext);
    if ('error' in workflow) throw new Error(workflow.error);
    store = workflow.store;
    await store.claimBootstrap({ name: 'Owner', email: 'owner@example.com', claimId: 'legacy-read-fixture' });
    await store.finalizeBootstrap({ claimId: 'legacy-read-fixture', ownerUserId: ownerId });
    await store.upsertActorMembership(actorId, 'active', [], '');
  });
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    budgetId = `selected-private-budget-${++fixtureSequence}`;
    foreignBudgetId = `foreign-budget-${fixtureSequence}`;
    vi.stubEnv('BALANCEFRAME_CONFIG_PATH', configPath);
    vi.stubEnv('ACTUAL_SERVER_URL', 'http://actual');
    vi.stubEnv('ACTUAL_SECRET_KEY', 'legacy-read-test-secret');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      serverUrl: 'http://actual',
      budgetId,
      budgetName: 'Selected budget',
      groupId: 'group',
    }));
    memberships = {};
    for (const budget of [budgetId, foreignBudgetId]) {
      const space = store.governance.createSpace({
        actorId: ownerId,
        name: budget === budgetId ? 'Selected space' : 'Foreign space',
        kind: 'shared',
        now,
        auth: controlAuth,
      });
      store.governance.bindBudget({ spaceId: space.id, budgetId: budget, now, auth: controlAuth });
      if (!store.governance.getPolicy({ spaceId: space.id })) {
        store.governance.setPolicy({
          spaceId: space.id,
          expectedVersion: null,
          policy: { minimumApprovers: 1, approvalThresholds: [] },
          now,
          auth: controlAuth,
        });
      }
      const ownerMembership = store.governance.getCurrentMembership({
        spaceId: space.id,
        actorId: ownerId,
        now,
      });
      const readerMembership = store.governance.addMembership({
        spaceId: space.id,
        actorId,
        validFrom: now,
        now,
        auth: controlAuth,
      });
      spaceIds[budget] = space.id;
      memberships[budget] = {
        [ownerId]: ownerMembership!.id,
        [actorId]: readerMembership.id,
      };
    }
    mockCreateActualClient.mockResolvedValue({});
    mockActualConnector.mockImplementation(() => sdkConnector);
    sdkConnector.connect.mockResolvedValue([
      { id: foreignBudgetId, groupId: 'group', name: secret, encrypted: false },
    ]);
    sdkConnector.selectBudget.mockImplementation(async () => ({
      id: budgetId,
      groupId: 'group',
      name: 'Selected budget',
      encrypted: false,
    }));
    const financialSnapshot = financialSnapshotForBudget(budgetId);
    sdkConnector.synchronize.mockResolvedValue({
      snapshot: financialSnapshot.legacySnapshot,
      financialSnapshot,
      health: {
        state: 'healthy',
        compatibility: {
          supported: true,
          serverVersion: '26.7.0',
          supportedVersion: '26.7.0',
          blockers: [],
        },
        freshness: {
          lastDownloadedAt: now,
          lastBankSyncedAt: null,
          pendingTransactionsIncluded: true,
        },
        coverage: {
          totalAccounts: 1,
          includedAccounts: 1,
          allExpectedAccountsPresent: true,
        },
        incidents: [],
      },
      watermark: {
        budgetId,
        lastTransactionDate: '2026-09-01',
        lastTransactionCount: 1,
        lastSyncCompletedAt: now,
        overlapDays: 3,
      },
    });
    sdkConnector.disconnect.mockResolvedValue(undefined);

    query.mockReturnValue({ currentMonth: '2026-09' });
    body.mockResolvedValue({ budgetId: foreignBudgetId });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    store.close();
    rmSync(configDirectory, { recursive: true, force: true });
  });

  function provisionGrant(
    targetActorId: string,
    budget: string,
    capability: ResourceCapability,
    resourceKind: 'budget' | 'account' | 'transaction' | 'category',
    resourceId: string,
  ) {
    const targetSpaceId = spaceIds[budget];
    const membershipId = memberships[budget]?.[targetActorId];
    if (!targetSpaceId || !membershipId) throw new Error('Missing current selected-space fixture');
    return store.governance.provisionResourceGrant({
      spaceId: targetSpaceId,
      actorId: targetActorId,
      membershipId,
      budgetId: budget,
      capability,
      resourceKind,
      resourceId,
      granted: true,
      now,
      auth: controlAuth,
    });
  }

  async function grant(
    capabilities: ResourceCapability[] = ['observe', 'full-read'],
    grantedBudget = budgetId,
    targetActorId = actorId,
  ) {
    for (const capability of capabilities)
      provisionGrant(targetActorId, grantedBudget, capability, 'budget', grantedBudget);
  }

  async function expectDenied(request = event()) {
    const response = await handler(request);
    expect(response.status).toBe('error');
    expect(response.result).toBeNull();
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain('selected-account');
    expect(JSON.stringify(response)).not.toContain('selected-transaction');
    expect(mockActualConnector).not.toHaveBeenCalled();
    expect(mockCreateActualClient).not.toHaveBeenCalled();
  }

  it.each([
    ['observe-only', ['observe'] as ResourceCapability[]],
    ['conclusion-only', ['observe', 'conclusion'] as ResourceCapability[]],
  ])(
    'denies %s before restoring any connection or exposing private evidence',
    async (_label, capabilities) => {
      for (const capability of capabilities)
        provisionGrant(actorId, budgetId, capability, 'budget', budgetId);
      await expectDenied();
    },
  );
  it('returns the source liquidity analysis to a member with exact observe and full-read grants', async () => {
    await grant();
    const response = await handler(event());
    expect(response.status).toBe('ok');
    expect(response.authorization).toMatchObject({
      actorId,
      capability: 'full-read',
      allowed: true,
    });
    expect(response.result).toHaveProperty('coverage', expect.any(Array));
  });
  it('requires observe as well as the separate full-read grant', async () => {
    await grant(['full-read']);
    await expectDenied();
  });
  it('does not grant the registered owner a financial-read bypass', async () => {
    await expectDenied(event(ownerId));
    await grant(['observe', 'full-read'], budgetId, ownerId);
    expect((await handler(event(ownerId))).status).toBe('ok');
    store.governance.revokeMembership({
      membershipId: memberships[budgetId][ownerId]!,
      spaceId: spaceIds[budgetId]!,
      now,
      auth: controlAuth,
    });
    vi.clearAllMocks();
    await expectDenied(event(ownerId));
  });
  it('reauthorizes a previously allowed reader after the resource grant is revoked', async () => {
    await grant();
    expect((await handler(event())).status).toBe('ok');
    store.governance.setResourceGrant({
      spaceId: spaceIds[budgetId]!,
      actorId,
      membershipId: memberships[budgetId][actorId]!,
      budgetId,
      capability: fullRead,
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now,
      auth: controlAuth,
    });
    vi.clearAllMocks();
    await expectDenied();
  });
  it('reauthorizes a previously allowed reader after the current membership is revoked', async () => {
    await grant();
    expect((await handler(event())).status).toBe('ok');
    store.governance.revokeMembership({
      membershipId: memberships[budgetId][actorId]!,
      spaceId: spaceIds[budgetId]!,
      now,
      auth: controlAuth,
    });
    vi.clearAllMocks();
    await expectDenied();
  });
  it('uses the selected server budget and authenticated actor rather than forged query identities', async () => {
    await grant(['observe', 'full-read'], foreignBudgetId);
    query.mockReturnValue({ budgetId: foreignBudgetId, actorId: ownerId });
    await expectDenied();
  });
  it('rejects invalid cash-flow months after selected-space full-read authorization', async () => {
    await grant();
    query.mockReturnValue({ months: '25' });
    const response = await cashFlowHandler(event());

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('INVALID_MONTHS');
    expect(response.authorization).toMatchObject({
      actorId,
      capability: 'full-read',
      allowed: true,
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain('selected-account');
    expect(JSON.stringify(response)).not.toContain('selected-transaction');
    expect(mockActualConnector).not.toHaveBeenCalled();
    expect(mockCreateActualClient).not.toHaveBeenCalled();
  });
  it('rejects invalid report types after selected-space full-read authorization', async () => {
    await grant();
    query.mockReturnValue({ reportType: 'invalid_type', monthRange: '2026-07' });
    const response = await reportGenerateHandler(event());

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('INVALID_REPORT_TYPE');
    expect(response.authorization).toMatchObject({
      actorId,
      capability: 'full-read',
      allowed: true,
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain('selected-account');
    expect(JSON.stringify(response)).not.toContain('selected-transaction');
    expect(mockActualConnector).not.toHaveBeenCalled();
    expect(mockCreateActualClient).not.toHaveBeenCalled();
  });
  it('rejects invalid report month ranges after selected-space full-read authorization', async () => {
    await grant();
    query.mockReturnValue({ reportType: 'spending', monthRange: 'not-a-range' });
    const response = await reportGenerateHandler(event());

    expect(response.status).toBe('error');
    expect(response.error?.code).toBe('INVALID_MONTH_RANGE');
    expect(response.authorization).toMatchObject({
      actorId,
      capability: 'full-read',
      allowed: true,
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain('selected-account');
    expect(JSON.stringify(response)).not.toContain('selected-transaction');
    expect(mockActualConnector).not.toHaveBeenCalled();
    expect(mockCreateActualClient).not.toHaveBeenCalled();
  });
  it('pins report history to the selected budget even when a foreign budget is requested', async () => {
    await grant();
    await store.createReportRecord({
      budgetId,
      reportType: 'summary',
      config: { label: 'selected' },
      policyVersion: '1',
    });
    await store.createReportRecord({
      budgetId: foreignBudgetId,
      reportType: 'summary',
      config: { label: secret },
      policyVersion: '1',
    });
    query.mockReturnValue({ budgetId: foreignBudgetId });
    const response = await historyHandler(event());
    expect(JSON.stringify(response)).not.toContain(secret);
    if (response.status === 'ok')
      expect(
        response.result.entries.every((entry: { budgetId: string }) => entry.budgetId === budgetId),
      ).toBe(true);
  });
  it('never returns another member saved-view metadata through an arbitrary stored ID', async () => {
    await grant();
    await store.upsertActorMembership('other-actor', 'active', [], '');
    const otherMembership = store.governance.addMembership({
      spaceId: spaceIds[budgetId]!,
      actorId: 'other-actor',
      validFrom: now,
      now,
      auth: controlAuth,
    });
    const foreign = await store.createSavedView({
      authority: {
        actorId: 'other-actor',
        spaceId: spaceIds[budgetId]!,
        budgetId,
        membershipId: otherMembership.id,
      },
      name: secret,
      viewType: 'budget_summary',
      scope: {},
    });
    const response = await viewHandler({
      ...event(),
      context: { ...event().context, params: { id: foreign.viewId } },
    });
    expect(response.status).toBe('error');
    expect(JSON.stringify(response)).not.toContain(secret);
  });
  it('duplicates a current saved view but refuses a view from another member', async () => {
    await grant();
    body.mockResolvedValue({ name: 'Owned copy' });
    const owned = await store.createSavedView({
      authority: {
        actorId,
        spaceId: spaceIds[budgetId]!,
        budgetId,
        membershipId: memberships[budgetId]![actorId]!,
      },
      name: 'Owned original',
      viewType: 'budget_summary',
      scope: {},
    });
    const duplicated = await duplicateViewHandler({
      ...event(),
      context: { ...event().context, params: { id: owned.viewId } },
    });
    expect(duplicated.status).toBe('ok');
    expect(duplicated.result).toMatchObject({
      name: 'Owned copy',
      actorId,
      spaceId: spaceIds[budgetId],
      budgetId,
    });

    await store.upsertActorMembership('other-actor', 'active', [], '');
    const otherMembership = store.governance.addMembership({
      spaceId: spaceIds[budgetId]!,
      actorId: 'other-actor',
      validFrom: now,
      now,
      auth: controlAuth,
    });
    const foreign = await store.createSavedView({
      authority: {
        actorId: 'other-actor',
        spaceId: spaceIds[budgetId]!,
        budgetId,
        membershipId: otherMembership.id,
      },
      name: secret,
      viewType: 'budget_summary',
      scope: {},
    });
    const denied = await duplicateViewHandler({
      ...event(),
      context: { ...event().context, params: { id: foreign.viewId } },
    });
    expect(denied.status).toBe('error');
    expect(JSON.stringify(denied)).not.toContain(secret);
  });
  it('records each admitted selected-space read with current actor, membership, policy, and request correlation without private fields', async () => {
    await grant();
    const request = event() as EventWithContext;
    request.context.requestId = 'selected-read-request';
    const authorization = await requireAuthorization(request, 'full-read', `budget:${budgetId}`);
    expect(authorization.ok).toBe(true);
    const audit = (await store.queryAuditRecords('authorization_check', 100))
      .find((row) => row.requestId === 'selected-read-request');
    expect(audit).toMatchObject({
      actorId, budgetId, requestId: 'selected-read-request',
      policyVersion: store.governance.getPolicy({ spaceId: spaceIds[budgetId]! })!.version,
      authorizationDisposition: { kind: 'authorized_without_approval' },
    });
    expect(JSON.parse(audit!.result)).toMatchObject({
      kind: 'read_admission', spaceId: spaceIds[budgetId],
      membershipId: memberships[budgetId]![actorId], capability: 'full-read',
      resourceKind: 'budget', resourceId: budgetId,
    });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain('session_token');
    const denied = event() as EventWithContext;
    denied.context.requestId = 'ungranted-read-request';
    expect((await requireAuthorization(denied, 'full-read', 'account:unknown-private-account')).ok).toBe(false);
    expect((await store.queryAuditRecords('authorization_check', 100))
      .some((row) => row.requestId === 'ungranted-read-request' &&
        row.authorizationDisposition?.kind === 'authorized_without_approval')).toBe(false);
  });

  it('does not mix persisted review or proposal rows from a different budget into authorized lists', async () => {
    await grant();
    for (const [capability, resourceKind, resourceId] of [
      ['existence', 'account', 'selected-account'],
      ['history', 'account', 'selected-account'],
      ['existence', 'category', 'food'],
      ['name', 'category', 'food'],
    ] as const) {
      provisionGrant(actorId, budgetId, capability, resourceKind, resourceId);
    }
    for (const selectedBudget of [budgetId, foreignBudgetId]) {
      const transactionId = selectedBudget === budgetId ? 'selected-transaction' : secret;
      const accountId = selectedBudget === budgetId ? 'selected-account' : 'foreign-account';
      const categoryId = selectedBudget === budgetId ? 'food' : 'foreign-food';
      const review = await store.createReviewItem({
        budgetId: selectedBudget,
        transactionId,
        categoryId,
        classifier: 'manual',
        provenance: 'human',
      });
      const suggested = await store.transitionInternalReviewItem(review.id, {
        toStatus: 'suggestion_generated',
        actor: 'trusted-fixture',
        expectedVersion: review.version,
      });
      await store.transitionInternalReviewItem(suggested.id, {
        toStatus: 'pending_review',
        actor: 'trusted-fixture',
        expectedVersion: suggested.version,
      });
      for (const [resourceKind, resourceId] of [
        ['budget', selectedBudget],
        ['account', accountId],
        ['transaction', transactionId],
        ['category', categoryId],
      ] as const) {
        provisionGrant(actorId, selectedBudget, 'categorization:propose', resourceKind, resourceId);
      }
      await store.createProposal({
        operation: 'set_category',
        budgetId: selectedBudget,
        spaceId: spaceIds[selectedBudget]!,
        payload: { kind: 'set_category', transactionId, categoryId },
        policyVersion: GENERIC_MUTATION_POLICY_VERSION,
        preconditions: JSON.stringify({
          transaction: {
            id: transactionId,
            accountId,
            direction: 'outgoing',
            amount: { minorUnits: '500', currency: 'USD' },
          },
        }),
        expiresAt: '2099-01-01T00:00:00.000Z',
        actorId,
        auth: sessionAuth(actorId),
        provenance: 'server-fixture',
      });
    }
    const reviews = await reviewHandler(event());
    const proposals = await proposalHandler(event());
    expect(reviews.status).toBe('ok');
    expect(proposals.status).toBe('ok');
    expect(JSON.stringify(reviews)).not.toContain(secret);
    expect(JSON.stringify(proposals)).not.toContain(secret);
    expect(reviews.result.total).toBe(1);
    expect(proposals.result.total).toBe(1);
  });

  it('does not treat selected-budget full-read as server-wide budget discovery or selection authority', async () => {
    await grant();
    expect((await discoveryHandler(event())).status).toBe('error');
    expect((await selectionHandler(event())).status).toBe('error');
    expect(mockActualConnector).not.toHaveBeenCalled();
    expect(mockCreateActualClient).not.toHaveBeenCalled();
  });
  it('permits first-setup discovery only for the current active registered owner with fresh human proof', async () => {
    store.upsertActorMembership(ownerId, 'active', [], 'budget:setup');
    rmSync(configPath, { force: true });
    provisionGrant(ownerId, budgetId, 'connection:manage', 'budget', budgetId);
    vi.stubEnv('BETTER_AUTH_SECRET', 'legacy-read-test-secret');
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3000');
    vi.stubEnv('BALANCEFRAME_DEV_BYPASS_AUTH', 'false');
    getSession.mockResolvedValue({
      user: { id: ownerId },
      session: { id: `session:${ownerId}`, userId: ownerId },
    });
    verifyPassword.mockResolvedValue({ status: true });
    const activeRequest = event(ownerId);
    expect(await issueReauthentication(activeRequest as ReauthenticationEvent, 'correct-password')).toBe(true);
    const discovered = await discoveryHandler(activeRequest);
    expect(mockActualConnector).toHaveBeenCalled();
    expect(discovered.result.budgets[0].name).toBe(secret);

    store.upsertActorMembership(ownerId, 'suspended', [], 'budget:setup');
    const suspendedRequest = event(ownerId);
    expect(await issueReauthentication(suspendedRequest as ReauthenticationEvent, 'correct-password')).toBe(true);
    vi.clearAllMocks();
    expect((await discoveryHandler(suspendedRequest)).status).toBe('error');
    expect(mockActualConnector).not.toHaveBeenCalled();
    expect(mockCreateActualClient).not.toHaveBeenCalled();
  });
});
