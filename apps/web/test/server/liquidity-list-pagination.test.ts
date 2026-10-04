import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as H3 from 'h3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { accountAwareSpendabilityResultSchema } from '@balanceframe/protocol-generated/validators';
import { actualLiquidityRequest } from '../../../../tests/contract/fixtures/actual-liquidity.js';
import { withLiquidityFacts } from '../../../../packages/actual-adapter/src/normalizer.js';
import type { EventWithContext } from '../../server/utils/workflow-store';
import { getWorkflowStore } from '../../server/utils/workflow-store';
import findings from '../../server/api/findings/index.get';
import inbox from '../../server/api/notifications/inbox.get';
import acknowledge from '../../server/api/notifications/acknowledge.post';
const native = createRequire(import.meta.url)('@balanceframe/native') as {
  evaluateAccountAwareSpendability(input: string): string;
};
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(async () => ({ budgetId: '' })),
}));
vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof H3>()),
  getQuery: (event: { query?: unknown }) => event.query ?? {},
  readBody: async (event: { body?: unknown }) => event.body,
}));
// Load Source Native modules in Vitest's hoisted mock factories, not stale workspace dist exports.
vi.mock('@balanceframe/application', async () => ({
  ...(await import('../../../../packages/application/src/index')),
  createDefaultConnectionManager: () => ({ loadConfig: mocks.loadConfig }),
}));
vi.mock('@balanceframe/workflow-store', async () =>
  import('../../../../packages/workflow-store/src/index'));

const OWNER = 'pagination-space-owner';
const READER = 'pagination-reader';
const OTHER = 'pagination-other-recipient';
const ORIGIN = 'https://balanceframe.example.test';
const NOW = '2026-09-06T10:00:00.000Z';
const ownerControl = {
  method: 'human-session' as const,
  actorId: OWNER,
  sessionId: 'pagination-owner-session',
  reauthenticatedAt: NOW,
};
let directory = '';
let store: SqliteWorkflowStore;
let sequence = 0;
let budgetId = '';
let spaceId = '';
let membershipId = '';
let ownerMembershipId = '';
let privateBudgetId = '';
let privateSpaceId = '';

function request(options: { offset?: string; selectedSpace?: string; body?: unknown } = {}) {
  const headers = new Map<string, string | number | readonly string[]>();
  return {
    body: options.body,
    query: { limit: '1', offset: options.offset ?? '0' },
    node: {
      req: {
        headers: {
          origin: ORIGIN,
          'x-balanceframe-space': options.selectedSpace ?? spaceId,
        },
      },
      res: {
        statusCode: 200,
        statusMessage: '',
        headersSent: false,
        setHeader(name: string, value: string | number | readonly string[]) {
          headers.set(name.toLowerCase(), value);
        },
        getHeader(name: string) {
          return headers.get(name.toLowerCase());
        },
        removeHeader(name: string) {
          headers.delete(name.toLowerCase());
        },
      },
    },
    context: {
      auth: {
        authenticated: true,
        actorId: READER,
        user: { id: READER },
        method: 'session' as const,
        principalType: 'human' as const,
        sessionId: 'pagination-reader-session',
        impersonatedBy: null,
      },
      runtimeConfig: { workflowDbPath: join(directory, 'workflow.sqlite'), devBypassAuth: false },
    },
  } as unknown as H3.H3Event & EventWithContext;
}

function createScope(selectedBudget: string) {
  const created = store.governance.createSpace({
    actorId: OWNER,
    name: `Pagination fixture ${sequence}`,
    kind: 'shared',
    now: NOW,
    auth: ownerControl,
  });
  const space = store.governance.bindBudget({
    spaceId: created.id,
    budgetId: selectedBudget,
    now: NOW,
    auth: ownerControl,
  });
  const owner = store.governance.getCurrentMembership({ spaceId: space.id, actorId: OWNER, now: NOW });
  if (!owner) throw new Error('Pagination owner membership unavailable');
  const reader = store.governance.addMembership({
    spaceId: space.id,
    actorId: READER,
    validFrom: NOW,
    now: NOW,
    auth: ownerControl,
  });
  store.governance.addMembership({
    spaceId: space.id,
    actorId: OTHER,
    validFrom: NOW,
    now: NOW,
    auth: ownerControl,
  });
  return { spaceId: space.id, membershipId: reader.id, ownerMembershipId: owner.id };
}

function grant(
  actorId: string,
  grantMembershipId: string,
  grantBudgetId: string,
  capability: string,
  restrictions?: { aggregateOnly?: boolean },
) {
  store.governance.provisionResourceGrant({
    spaceId: spaceId,
    actorId,
    membershipId: grantMembershipId,
    budgetId: grantBudgetId,
    capability,
    ...(restrictions ? { restrictions } : {}),
    resourceKind: 'budget',
    resourceId: grantBudgetId,
    granted: true,
    now: NOW,
  });
}

function nativeTransferRequest() {
  const request = actualLiquidityRequest(true, true);
  const legacyCash = request.financialSnapshot.legacySnapshot.accounts.find((account) => account.id === 'cash');
  if (!legacyCash) throw new Error('Actual cash account fixture unavailable');
  request.financialSnapshot.legacySnapshot.accounts.push({
    ...structuredClone(legacyCash),
    id: 'savings',
    name: 'Private savings',
  });
  const facts = structuredClone(request.financialSnapshot.liquidity!);
  const cash = facts.accounts.find((account) => account.accountId === 'cash');
  if (!cash) throw new Error('Actual cash facts unavailable');
  facts.accounts.push({ ...structuredClone(cash), accountId: 'savings' });
  request.liquidityPolicy.accounts[0]!.protectedBuffer = money('15000');
  request.liquidityPolicy.accounts.push({
    ...request.liquidityPolicy.accounts[0]!,
    accountId: 'savings',
    resourceScope: 'savings',
    role: 'savings',
    paymentEligible: false,
    protectedBuffer: money('0'),
  });
  request.liquidityPolicy.transferRoutes.push({
    id: 'savings-cash',
    sourceAccountId: 'savings',
    destinationAccountId: 'cash',
    providerArrivalAt: '2026-09-06T17:00:00Z',
    calendarMode: null,
    delayDays: 0,
    utcOffsetMinutes: null,
    cutoffMinute: null,
    weekendsAvailable: null,
    holidaysComplete: false,
    holidays: [],
    evidence: cash.balanceEvidence,
  });
  request.financialSnapshot = withLiquidityFacts(request.financialSnapshot, facts);
  request.context.snapshotId = request.financialSnapshot.snapshotId;
  request.context.contentHash = request.financialSnapshot.contentHash;
  return request;
}

async function createNativeTransferIntent() {
  const source = nativeTransferRequest();
  if (source.scenario.kind !== 'purchases') throw new Error('Native purchase fixture required');
  const result = accountAwareSpendabilityResultSchema.parse(
    JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(source))),
  );
  const plan = result.purchases[0]?.transferPlan;
  if (!plan) throw new Error('Native transfer plan unavailable');

  const currentGovernancePolicy = store.governance.getPolicy({ spaceId });
  if (!currentGovernancePolicy) throw new Error('Pagination governance policy unavailable');
  const provision = (
    resourceKind: 'budget' | 'account' | 'category',
    resourceId: string,
    capability: string,
  ) => store.governance.provisionResourceGrant({
    spaceId,
    actorId: OWNER,
    membershipId: ownerMembershipId,
    budgetId,
    capability,
    resourceKind,
    resourceId,
    granted: true,
    now: NOW,
  });
  provision('budget', budgetId, 'policy');
  provision('budget', budgetId, 'proposal');
  store.liquidity.savePolicy({
    actorId: OWNER,
    budgetId,
    spaceId,
    membershipId: ownerMembershipId,
    governancePolicyVersion: currentGovernancePolicy.version,
    expectedVersion: null,
    expectedGovernancePolicyVersion: currentGovernancePolicy.version,
    policy: source.liquidityPolicy,
    approvalPolicy: { minimumApprovers: 1 },
    now: NOW,
    auth: ownerControl,
  });

  const accountIds = new Set(source.financialSnapshot.legacySnapshot.accounts.map(({ id }) => id));
  const categoryIds = new Set(source.financialSnapshot.legacySnapshot.categories.map(({ id }) => id));
  for (const leg of plan.legs) {
    accountIds.add(leg.sourceAccountId);
    accountIds.add(leg.destinationAccountId);
  }
  for (const effect of plan.reservations) {
    (effect.kind === 'category' ? categoryIds : accountIds).add(effect.resourceId);
    if (effect.categoryId) categoryIds.add(effect.categoryId);
  }
  for (const line of plan.backingAfter.lines) {
    accountIds.add(line.accountId);
    categoryIds.add(line.categoryId);
  }
  for (const accountId of accountIds) {
    provision('account', accountId, 'proposal');
    provision('account', accountId, 'source');
  }
  for (const categoryId of categoryIds) provision('category', categoryId, 'proposal');

  const latestGovernancePolicy = store.governance.getPolicy({ spaceId });
  if (!latestGovernancePolicy) throw new Error('Pagination governance policy unavailable');
  const proposal = store.liquidity.admitTransferProposal({
    actorId: OWNER,
    budgetId,
    spaceId,
    membershipId: ownerMembershipId,
    governancePolicyVersion: latestGovernancePolicy.version,
    now: NOW,
    auth: ownerControl,
    plan,
    expectedClaimSetRevision: '0',
    idempotencyKey: `pagination-native-transfer-${sequence}`,
  }, () => ({ valid: true }));
  return { plan, proposal };
}

async function createNotification(
  selectedBudget: string,
  input: {
    recipientId: string;
    classification?: string;
    correlationId?: string;
    title: string;
    secondOffset: number;
  },
) {
  const createdAt = new Date(Date.parse(NOW) + input.secondOffset * 1000).toISOString();
  vi.setSystemTime(new Date(createdAt));
  const event = await store.createNotificationEvent({
    budgetId: selectedBudget,
    classification: input.classification ?? 'budget_alert',
    recipientId: input.recipientId,
    scope: `budget:${selectedBudget}`,
    policyVersion: 'notification-policy-v1',
    correlationId: input.correlationId,
    payload: { title: input.title, summary: 'Visible summary', rawEvidence: 'private event payload' },
    now: createdAt,
  });
  return store.enqueueNotification({ eventId: event.id, deliveryKey: event.id, channelType: 'in_app' });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'liquidity-pagination-'));
  const opened = getWorkflowStore(request({ selectedSpace: '' }) as unknown as EventWithContext);
  if ('error' in opened) throw new Error(opened.error);
  store = opened.store;
  await store.claimBootstrap({ name: 'Pagination owner', email: 'pagination-owner@example.test', claimId: 'liquidity-pagination-fixture' });
  await store.finalizeBootstrap({ claimId: 'liquidity-pagination-fixture', ownerUserId: OWNER });
  await store.upsertActorMembership(READER, 'active', [], 'unscoped');
  await store.upsertActorMembership(OTHER, 'active', [], 'unscoped');
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('BETTER_AUTH_URL', ORIGIN);
  budgetId = `pagination-budget-${++sequence}`;
  privateBudgetId = `pagination-private-budget-${sequence}`;
  mocks.loadConfig.mockResolvedValue({ budgetId });
  const selected = createScope(budgetId);
  spaceId = selected.spaceId;
  membershipId = selected.membershipId;
  ownerMembershipId = selected.ownerMembershipId;
  const privateScope = createScope(privateBudgetId);
  privateSpaceId = privateScope.spaceId;

  for (const capability of ['observe', 'history', 'notification:receive', 'full-read'])
    grant(READER, membershipId, budgetId, capability);
  await store.saveNotificationPolicy({
    spaceId,
    policyKey: 'notification',
    policyVersion: 'notification-policy-v1',
    policy: {
      policyVersion: 'notification-policy-v1',
      eligibility: [],
      recipients: [{ actorId: READER, channels: ['in_app'], quietHours: null }],
      channels: [{ type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' }],
      redaction: {
        public: { visibleFields: ['title', 'summary'] },
        restricted: { visibleFields: ['title', 'summary'] },
      },
      maxRetries: 3,
      defaultRedactionClass: 'public',
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

afterAll(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('authorized financial list pagination', () => {
  it('filters current selected-space finding projections before visible page positions', async () => {
    const first = await store.createFinding({
      budgetId,
      classification: 'budget_alert',
      severity: 'high',
      description: 'private first finding description',
      evidence: { rawEvidence: 'private finding evidence' },
      actorId: READER,
    });
    const second = await store.createFinding({
      budgetId,
      classification: 'budget_alert',
      severity: 'medium',
      description: 'private second finding description',
      evidence: { rawEvidence: 'private finding evidence' },
      actorId: READER,
    });
    const hiddenTransfer = await store.createFinding({
      budgetId,
      classification: 'transfer_needs_attention',
      severity: 'critical',
      description: 'private transfer finding description',
      evidence: { transferId: 'not-a-current-proposal', rawEvidence: 'private transfer evidence' },
      actorId: READER,
    });
    await store.createFinding({
      budgetId: privateBudgetId,
      classification: 'budget_alert',
      severity: 'critical',
      description: 'other budget finding description',
      evidence: {},
      actorId: READER,
    });

    const page = async (offset: string) => findings(request({ offset }));
    const firstPage = await page('0');
    const secondPage = await page('1');
    expect(firstPage.status).toBe('ok');
    expect(firstPage.result.map((finding: { id: string }) => finding.id)).toEqual([first.id]);
    expect(secondPage.status).toBe('ok');
    expect(secondPage.result.map((finding: { id: string }) => finding.id)).toEqual([second.id]);
    const serialized = JSON.stringify([firstPage, secondPage]);
    expect(serialized).not.toContain('private first finding description');
    expect(serialized).not.toContain('private second finding description');
    expect(serialized).not.toContain('private finding evidence');
    expect(serialized).not.toContain('private transfer evidence');
    expect(serialized).not.toContain(hiddenTransfer.id);
    expect(serialized).not.toContain('other budget finding description');
    expect(serialized).not.toContain(privateSpaceId);
  });

  it('filters current recipient, selected budget and projectable transfer events before inbox page positions', async () => {
    const first = await createNotification(budgetId, {
      recipientId: READER,
      title: 'Visible first notification',
      secondOffset: 0,
    });
    await createNotification(privateBudgetId, {
      recipientId: READER,
      title: 'Other space notification secret',
      secondOffset: 1,
    });
    await createNotification(budgetId, {
      recipientId: OTHER,
      title: 'Other recipient notification secret',
      secondOffset: 2,
    });
    const privateFinding = await store.createFinding({
      budgetId,
      classification: 'transfer_needs_attention',
      severity: 'critical',
      description: 'private transfer source',
      evidence: { transferId: 'not-a-current-proposal' },
      actorId: READER,
    });
    await createNotification(budgetId, {
      recipientId: READER,
      classification: 'transfer_needs_attention',
      correlationId: `liquidity-finding:${privateFinding.id}`,
      title: 'Private transfer notification secret',
      secondOffset: 3,
    });
    const second = await createNotification(budgetId, {
      recipientId: READER,
      title: 'Visible second notification',
      secondOffset: 4,
    });

    const firstPage = await inbox(request({ offset: '0' }));
    const secondPage = await inbox(request({ offset: '1' }));
    const emptyPage = await inbox(request({ offset: '2' }));
    expect(firstPage.status).toBe('ok');
    expect(firstPage.result.items.map((item: { outbox: { id: string } }) => item.outbox.id)).toEqual([second.id]);
    expect(firstPage.result.count).toBe(1);
    expect(secondPage.status).toBe('ok');
    expect(secondPage.result.items.map((item: { outbox: { id: string } }) => item.outbox.id)).toEqual([first.id]);
    expect(secondPage.result.count).toBe(1);
    expect(emptyPage.status).toBe('ok');
    expect(emptyPage.result.items).toEqual([]);
    expect(emptyPage.result.count).toBe(0);
    const serialized = JSON.stringify([firstPage, secondPage, emptyPage]);
    expect(serialized).not.toContain('private event payload');
    expect(serialized).not.toContain('Other space notification secret');
    expect(serialized).not.toContain('Other recipient notification secret');
    expect(serialized).not.toContain('Private transfer notification secret');
    expect(serialized).not.toContain(privateSpaceId);
    expect(serialized).not.toContain(privateFinding.id);
  });
  it('lists and acknowledges a finding-correlated transfer notice using current aggregate conclusion and recipient-period grants', async () => {
    store.governance.setResourceGrant({
      spaceId,
      actorId: READER,
      membershipId,
      budgetId,
      capability: 'full-read',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now: NOW,
      auth: ownerControl,
    });
    grant(READER, membershipId, budgetId, 'conclusion', { aggregateOnly: true });
    const { plan, proposal } = await createNativeTransferIntent();
    const privateTransferId = proposal.id;
    const privateAccountName = 'Private checking account name';
    const finding = await store.createFinding({
      budgetId,
      classification: 'transfer_needs_attention',
      severity: 'medium',
      description: 'Private transfer narrative.',
      evidence: {
        transferId: privateTransferId,
        transferConclusion: {
          minimumAmount: money('999999'),
          requiredBy: '2099-09-06T11:00:00.000Z',
          estimatedArrival: 'private-arrival-detail',
          accountName: privateAccountName,
          outcome: 'private-outcome-detail',
        },
        rawEvidence: 'private-transfer-evidence',
      },
      actorId: OWNER,
    });
    const event = await store.createNotificationEvent({
      budgetId,
      classification: 'transfer_needs_attention',
      recipientId: READER,
      scope: `budget:${budgetId}`,
      redactionClass: 'restricted',
      policyVersion: 'notification-policy-v1',
      correlationId: `liquidity-finding:${finding.id}`,
      payload: {
        title: 'A transfer needs authorized review',
        summary: 'Open your authorized attention view.',
        rawEvidence: 'private-notification-evidence',
      },
      now: NOW,
    });
    const outbox = await store.enqueueNotification({
      eventId: event.id,
      deliveryKey: event.id,
      channelType: 'in_app',
    });
    const deliveryToken = `deliver:${outbox.id}`;
    await store.claimNotificationDelivery(outbox.id, deliveryToken);
    await store.completeNotificationDelivery(outbox.id, deliveryToken);

    const findingPage = await findings(request());
    const visibleInbox = await inbox(request());
    const safeFinding = findingPage.result[0]!;
    expect(findingPage.status).toBe('ok');
    expect(safeFinding).toMatchObject({
      id: finding.id,
      transferConclusion: {
        minimumAmount: plan.minimumAmount,
        requiredBy: plan.legs.map(({ requiredBy }) => requiredBy).sort()[0],
        authorizedHolderRequired: true,
      },
    });
    expect(safeFinding.transferConclusion).not.toHaveProperty('estimatedArrival');
    expect(visibleInbox.status).toBe('ok');
    expect(visibleInbox.result.items).toHaveLength(1);
    expect(visibleInbox.result.items[0]).toMatchObject({
      event: { correlationId: `liquidity-finding:${finding.id}` },
      redactedPayload: {
        title: 'A transfer needs authorized review',
        summary: 'Open your authorized attention view.',
      },
    });
    const safeVisible = JSON.stringify([findingPage, visibleInbox]);
    expect(safeVisible).not.toContain(privateTransferId);
    expect(safeVisible).not.toContain(privateAccountName);
    expect(safeVisible).not.toContain('private-arrival-detail');
    expect(safeVisible).not.toContain('private-outcome-detail');
    expect(safeVisible).not.toContain('private-transfer-evidence');
    expect(safeVisible).not.toContain('private-notification-evidence');

    const acknowledged = await acknowledge(request({ body: { outboxId: outbox.id } }));
    expect(acknowledged.status).toBe('ok');
    expect(acknowledged.result).toMatchObject({ outboxId: outbox.id, status: 'delivered' });
    const acknowledgedInbox = await inbox(request());
    expect(acknowledgedInbox.result.items[0]).toMatchObject({
      outbox: { id: outbox.id, status: 'delivered', acknowledgedAt: NOW },
    });

    store.governance.revokeMembership({
      spaceId,
      membershipId,
      now: NOW,
      auth: ownerControl,
    });
    membershipId = store.governance.addMembership({
      spaceId,
      actorId: READER,
      validFrom: NOW,
      now: NOW,
      auth: ownerControl,
    }).id;
    for (const capability of ['observe', 'history', 'notification:receive'])
      grant(READER, membershipId, budgetId, capability);
    grant(READER, membershipId, budgetId, 'conclusion', { aggregateOnly: true });

    const oldPeriodInbox = await inbox(request());
    const oldPeriodAck = await acknowledge(request({ body: { outboxId: outbox.id } }));
    expect(oldPeriodInbox.status).toBe('ok');
    expect(oldPeriodInbox.result.items).toEqual([]);
    expect(oldPeriodAck.status).toBe('error');
    expect(oldPeriodAck.error?.code).toBe('NOT_FOUND');

    store.governance.setResourceGrant({
      spaceId,
      actorId: READER,
      membershipId,
      budgetId,
      capability: 'notification:receive',
      resourceKind: 'budget',
      resourceId: budgetId,
      granted: false,
      now: NOW,
      auth: ownerControl,
    });
    const revokedInbox = await inbox(request());
    const revokedAck = await acknowledge(request({ body: { outboxId: outbox.id } }));
    expect(revokedInbox.status).toBe('error');
    expect(revokedInbox.error?.code).toBe('FORBIDDEN');
    expect(revokedAck.status).toBe('error');
    expect(revokedAck.error?.code).toBe('FORBIDDEN');
  });
});