import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { ResourceCapability, ResourceKind } from '@balanceframe/workflow-store';
import { accountAwareSpendabilityResultSchema } from '@balanceframe/protocol-generated/validators';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
import { withLiquidityFacts } from '../../actual-adapter/src/normalizer.js';
import { LiquidityProjector } from '../src/liquidity-projector.js';
import type { AccountAwareSpendabilityRequest, Transaction } from '@balanceframe/protocol-generated';

const native = createRequire(import.meta.url)('@balanceframe/native');
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
type SpaceActor = {
  actorId: string;
  budgetId: string;
  spaceId: string;
  membershipId: string;
  governancePolicyVersion: string;
  now: string;
  auth: {
    readonly method: 'human-session';
    readonly actorId: string;
    readonly sessionId: string;
    readonly reauthenticatedAt: string;
  };
};
const actorAuth = (actorId: string, now: string) => ({
  method: 'human-session' as const,
  actorId,
  sessionId: `session:${actorId}`,
  reauthenticatedAt: now,
});

async function createActor(
  store: SqliteWorkflowStore,
  actorId: string,
  budgetId: string,
  now: string,
): Promise<SpaceActor> {
  const claimId = `claim:${actorId}`;
  await store.claimBootstrap({
    name: actorId,
    email: `${actorId}@example.test`,
    claimId,
  });
  await store.finalizeBootstrap({ claimId, ownerUserId: actorId });
  await store.upsertActorMembership(actorId, 'active', ['observe'], `budget:${budgetId}`);
  const auth = actorAuth(actorId, now);
  const space = store.governance.createSpace({
    actorId,
    name: `${actorId} fixture`,
    kind: 'personal',
    now,
    auth,
  });
  const currentPolicy = store.governance.getPolicy({ spaceId: space.id });
  if (!currentPolicy) throw new Error('Fixture governance policy required');
  store.governance.setPolicy({
    spaceId: space.id,
    expectedVersion: currentPolicy.version,
    policy: { minimumApprovers: 1 },
    now,
    auth,
  });
  store.governance.bindBudget({ spaceId: space.id, budgetId, now, auth });
  const membership = store.governance.getCurrentMembership({ spaceId: space.id, actorId, now });
  const policy = store.governance.getPolicy({ spaceId: space.id });
  if (!membership || !policy) throw new Error('Fixture governance context required');
  return {
    actorId,
    budgetId,
    spaceId: space.id,
    membershipId: membership.id,
    governancePolicyVersion: policy.version,
    now,
    auth,
  };
}

function setGrant(
  store: SqliteWorkflowStore,
  actor: SpaceActor,
  resourceKind: ResourceKind,
  resourceId: string,
  capability: ResourceCapability,
  now: string,
  granted = true,
  restrictions?: Record<string, unknown>,
): void {
  store.governance.setResourceGrant({
    spaceId: actor.spaceId,
    actorId: actor.actorId,
    budgetId: actor.budgetId,
    membershipId: actor.membershipId,
    resourceKind,
    resourceId,
    capability,
    granted,
    ...(restrictions === undefined ? {} : { restrictions }),
    now,
    auth: actorAuth(actor.actorId, now),
  });
}

function transferRequest(card = true) {
  const request = actualLiquidityRequest(true, card);
  const legacyCash = request.financialSnapshot.legacySnapshot.accounts.find(
    (account) => account.id === 'cash',
  )!;
  request.financialSnapshot.legacySnapshot.accounts.push({
    ...structuredClone(legacyCash),
    id: 'savings',
    name: 'Private savings',
  });
  const facts = structuredClone(request.financialSnapshot.liquidity!);
  const cash = facts.accounts.find((account) => account.accountId === 'cash')!;
  facts.accounts.push({ ...structuredClone(cash), accountId: 'savings' });
  request.liquidityPolicy.accounts[0]!.protectedBuffer = money(card ? '15000' : '10000');
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

function actualSourceRequest() {
  const request = transferRequest(false);
  const snapshot = structuredClone(request.financialSnapshot);
  snapshot.legacySnapshot.transactions.push({
    id: 'private-source-transaction-884',
    accountId: 'cash',
    date: snapshot.capturedAt.slice(0, 10),
    payeeId: null,
    payeeName: null,
    categoryId: 'food',
    categoryName: 'Food',
    amount: money('0'),
    cleared: true,
    reconciled: true,
    importedId: null,
    importedPayee: null,
    notes: null,
    tags: [],
    transferAccountId: null,
    subtransactions: [],
  } satisfies Transaction);
  snapshot.coverage.transactions = 'complete';
  snapshot.observations = snapshot.legacySnapshot.accounts.map((account) => ({
    kind: 'account_coverage' as const,
    scope: { kind: 'account' as const, id: account.id },
    state: 'complete' as const,
    observedAt: snapshot.capturedAt,
    evidence: [{
      evidenceId: account.id,
      kind: 'account' as const,
      authorized: true,
      redaction: 'visible' as const,
    }],
  }));
  const facts = structuredClone(snapshot.liquidity!);
  facts.ledgerContentHash = `sha256:${createHash('sha256')
    .update(JSON.stringify(snapshot.legacySnapshot))
    .digest('hex')}`;
  request.financialSnapshot = withLiquidityFacts({ ...snapshot, liquidity: facts }, facts);
  request.context.snapshotId = request.financialSnapshot.snapshotId;
  request.context.contentHash = request.financialSnapshot.contentHash;
  return request;
}

function evaluate(request: AccountAwareSpendabilityRequest) {
  return accountAwareSpendabilityResultSchema.parse(
    JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(request))),
  );
}

describe('account-aware liquidity projection', () => {
  it('keeps current availability separate from future backing and honors current account grants', async () => {
    const request = actualLiquidityRequest(true);
    const now = request.context.evaluatedAt;
    const facts = structuredClone(request.financialSnapshot.liquidity!);
    const food = facts.categories.find((category) => category.categoryId === 'food')!;
    facts.categories.push({
      ...food,
      cashBucketId: '000-future-food',
      asOfMonth: '2026-10',
      periodKind: 'future',
      availability: money('1000'),
    });
    request.financialSnapshot = withLiquidityFacts(request.financialSnapshot, facts);
    request.context.snapshotId = request.financialSnapshot.snapshotId;
    request.context.contentHash = request.financialSnapshot.contentHash;
    if (request.scenario.kind !== 'purchases') throw new Error('Purchase fixture required');
    request.scenario.items[0]!.amount = money('1000');
    const result = accountAwareSpendabilityResultSchema.parse(
      JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(request))),
    );
    expect(result.budgetFundingStatus).toBe('funded');
    const directory = mkdtempSync(join(tmpdir(), 'liquidity-bucket-projection-'));
    const store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
    const actorIdentity = { actorId: 'reader', budgetId: request.financialSnapshot.source.budgetId };
    try {
      const actor = await createActor(store, actorIdentity.actorId, actorIdentity.budgetId, now);
      for (const [resourceKind, resourceId] of [
        ['budget', actor.budgetId],
        ['category', 'food'],
        ['account', 'cash'],
      ] as const)
        for (const capability of [
          'existence',
          'name',
          'balance',
          'history',
          'liquidity',
          'conclusion',
        ] as const)
          setGrant(store, actor, resourceKind, resourceId, capability, now);
      const projector = new LiquidityProjector(store, actor, request.financialSnapshot);
      const category = projector
        .view(request, result, now, request.scenario.items)
        .categories.find((value) => value.id === 'food')!;
      expect(category.availabilityBefore).toEqual(money('2000'));
      expect(category.availabilityAfter).toEqual(money('1000'));
      expect(category.backing).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: 'cash',
            asOfMonth: '2026-09',
            periodKind: 'current',
            amount: money('1000'),
          }),
          expect.objectContaining({
            accountId: 'cash',
            asOfMonth: '2026-10',
            periodKind: 'future',
            amount: money('1000'),
          }),
        ]),
      );
      expect(category.backing).toHaveLength(2);
      setGrant(store, actor, 'category', 'food', 'history', now, false);
      expect(
        projector.view(request, result, now).categories.find((value) => value.id === 'food')!
          .backing,
      ).toEqual([]);
      setGrant(store, actor, 'category', 'food', 'history', now);
      setGrant(store, actor, 'account', 'cash', 'balance', now, false);
      expect(
        projector.view(request, result, now).categories.find((value) => value.id === 'food')!
          .backing,
      ).toEqual([]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves the exact aggregate transfer deadline without exposing source rows', async () => {
    const request = transferRequest();
    if (request.scenario.kind !== 'purchases') throw new Error('Purchase fixture required');
    const result = accountAwareSpendabilityResultSchema.parse(
      JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(request))),
    );
    expect(result.paymentLiquidityStatus).toBe('transfer_required');
    const store = new SqliteWorkflowStore(':memory:');
    const actorIdentity = {
      actorId: 'conclusion-reader',
      budgetId: request.financialSnapshot.source.budgetId,
    };
    const now = request.context.evaluatedAt;
    try {
      const actor = await createActor(store, actorIdentity.actorId, actorIdentity.budgetId, now);
      setGrant(
        store,
        actor,
        'budget',
        actor.budgetId,
        'conclusion',
        now,
        true,
        { aggregateOnly: true },
      );
      const projector = new LiquidityProjector(store, actor, request.financialSnapshot);
      const projection = projector.view(request, result, now, request.scenario.items);
      const transferPlan = result.purchases[0]?.transferPlan;
      if (!transferPlan) throw new Error('Native transfer plan required');
      const conclusion = projector.transferConclusion(transferPlan);
      expect(conclusion).toEqual({
        minimumAmount: money('2000'),
        requiredBy: '2026-09-06T18:00:00Z',
        authorizedHolderRequired: true,
      });
      expect(projection.accounts).toEqual([]);
      expect(projection.categories).toEqual([]);
      expect(projection.purchases).toEqual([]);
      const serialized = JSON.stringify({ projection, conclusion });
      for (const hidden of ['cash', 'savings', 'Private savings'])
        expect(serialized).not.toContain(hidden);
      setGrant(store, actor, 'category', 'food', 'existence', now);
      const withCategoryIdentity = projector.view(request, result, now, request.scenario.items);
      const visiblePurchase = withCategoryIdentity.purchases[0];
      expect(visiblePurchase).toBeDefined();
      expect(visiblePurchase).not.toHaveProperty('id');
      expect(visiblePurchase).not.toHaveProperty('amount');
      expect(withCategoryIdentity.expiresAt).not.toBe(result.expiresAt);
    } finally {
      store.close();
    }
  });

  it('keeps balance, liquidity, history, and transfer-source rights independent', async () => {
    const request = transferRequest();
    if (request.scenario.kind !== 'purchases') throw new Error('Purchase fixture required');
    const result = accountAwareSpendabilityResultSchema.parse(
      JSON.parse(native.evaluateAccountAwareSpendability(JSON.stringify(request))),
    );
    const store = new SqliteWorkflowStore(':memory:');
    const actorId = 'capability-reader';
    const budgetId = request.financialSnapshot.source.budgetId;
    const now = request.context.evaluatedAt;
    try {
      const actor = await createActor(store, actorId, budgetId, now);
      setGrant(store, actor, 'budget', budgetId, 'conclusion', now);
      for (const [resourceKind, resourceId, capabilities] of [
        ['category', 'food', ['existence', 'name']],
        ['account', 'cash', ['existence', 'name', 'balance']],
        ['account', 'savings', ['existence', 'name', 'source']],
      ] as const)
        for (const capability of capabilities)
          setGrant(store, actor, resourceKind, resourceId, capability, now);

      const projector = new LiquidityProjector(store, actor, request.financialSnapshot);
      const partial = projector.view(request, result, now, request.scenario.items);
      const cash = partial.accounts.find((account) => account.id === 'cash')!;
      const savings = partial.accounts.find((account) => account.id === 'savings')!;
      const cashFact = request.financialSnapshot.liquidity!.accounts.find(
        (account) => account.accountId === 'cash',
      )!;
      expect(cash.balance).toEqual(cashFact.recordedBalance);
      expect(cash.safeSpendingBefore).toBeUndefined();
      expect(cash.quality).toBeUndefined();
      expect(cash.role).toBeUndefined();
      expect(savings.role).toBeUndefined();
      expect(savings.balance).toBeUndefined();
      expect(savings.safeSpendingBefore).toBeUndefined();
      expect(savings.quality).toBeUndefined();
      expect(partial.categories.find((category) => category.id === 'food')!.availabilityBefore)
        .toBeUndefined();
      expect(partial.purchases[0]!.transfer).toEqual({
        minimumAmount: money('2000'),
        requiredBy: '2026-09-06T18:00:00Z',
        authorizedHolderRequired: true,
      });
      expect(partial.purchases[0]!.canPlanTransfer).toBe(false);
      setGrant(store, actor, 'account', 'savings', 'liquidity', now);
      const withLiquidity = projector.view(request, result, now, request.scenario.items);
      const savingsWithLiquidity = withLiquidity.accounts.find(
        (account) => account.id === 'savings',
      )!;
      expect(savingsWithLiquidity.role).toBe('savings');
      expect(savingsWithLiquidity.balance).toBeUndefined();
      setGrant(store, actor, 'account', 'savings', 'balance', now);
      const withoutHistory = projector.view(request, result, now, request.scenario.items);
      const savingsFact = request.financialSnapshot.liquidity!.accounts.find(
        (account) => account.accountId === 'savings',
      )!;
      const savingsWithNumbers = withoutHistory.accounts.find((account) => account.id === 'savings')!;
      expect(savingsWithNumbers.balance).toEqual(savingsFact.recordedBalance);
      expect(savingsWithNumbers.quality).toBeUndefined();

      const plan = result.purchases[0]?.transferPlan;
      if (!plan) throw new Error('Native transfer plan required');
      const resources = new Map<string, [ResourceKind, string]>([
        [`budget:${budgetId}`, ['budget', budgetId]],
      ]);
      for (const leg of plan.legs) {
        resources.set(`account:${leg.sourceAccountId}`, ['account', leg.sourceAccountId]);
        resources.set(`account:${leg.destinationAccountId}`, ['account', leg.destinationAccountId]);
      }
      for (const reservation of plan.reservations) {
        const kind = reservation.kind === 'category' ? 'category' : 'account';
        resources.set(`${kind}:${reservation.resourceId}`, [kind, reservation.resourceId]);
        if (reservation.categoryId)
          resources.set(`category:${reservation.categoryId}`, ['category', reservation.categoryId]);
      }
      for (const line of plan.backingAfter.lines) {
        resources.set(`account:${line.accountId}`, ['account', line.accountId]);
        resources.set(`category:${line.categoryId}`, ['category', line.categoryId]);
      }
      if (plan.scenario.kind === 'purchases')
        for (const item of plan.scenario.items) {
          resources.set(`category:${item.categoryId}`, ['category', item.categoryId]);
          for (const accountId of [
            item.routeSelection.explicitAccountId,
            item.routeSelection.sessionAccountId,
            item.routeSelection.approvedPreference?.accountId,
            item.routeSelection.historicalRoute?.accountId,
          ])
            if (accountId) resources.set(`account:${accountId}`, ['account', accountId]);
        }
      for (const [resourceKind, resourceId] of resources.values()) {
        const capabilities: readonly ResourceCapability[] = resourceKind === 'budget'
          ? ['proposal']
          : ['existence', 'name', 'balance', 'history', 'liquidity', 'proposal'];
        for (const capability of capabilities)
          setGrant(store, actor, resourceKind, resourceId, capability, now);
      }
      const sourceAccounts = new Set(plan.legs.map(({ sourceAccountId }) => sourceAccountId));
      for (const accountId of sourceAccounts)
        setGrant(store, actor, 'account', accountId, 'source', now, false);
      expect(
        projector.view(request, result, now, request.scenario.items).purchases[0]!.canPlanTransfer,
      ).toBe(false);
      for (const accountId of sourceAccounts)
        setGrant(store, actor, 'account', accountId, 'source', now);
      expect(
        projector.view(request, result, now, request.scenario.items).purchases[0]!.canPlanTransfer,
      ).toBe(true);
    } finally {
      store.close();
    }
  });
  it('projects Actual aggregate conclusions without releasing source records', async () => {
    const request = actualSourceRequest();
    if (request.scenario.kind !== 'purchases') throw new Error('Purchase fixture required');
    const result = evaluate(request);
    expect(result.budgetFundingStatus).toBe('funded');

    const store = new SqliteWorkflowStore(':memory:');
    const now = request.context.evaluatedAt;
    const actor = await createActor(
      store,
      'aggregate-source-reader',
      request.financialSnapshot.source.budgetId,
      now,
    );
    try {
      setGrant(store, actor, 'budget', actor.budgetId, 'conclusion', now, true, { aggregateOnly: true });
      const projection = new LiquidityProjector(store, actor, request.financialSnapshot)
        .view(request, result, now, request.scenario.items);
      expect(projection.fundingStatus).toBe(result.budgetFundingStatus);
      expect(projection.paymentStatus).toBe(result.paymentLiquidityStatus);
      expect(projection.accounts).toEqual([]);
      expect(projection.categories).toEqual([]);
      expect(projection.purchases).toEqual([]);
      const serialized = JSON.stringify(projection);
      expect(serialized).not.toContain('private-source-transaction-884');
      expect(serialized).not.toContain('Private savings');
    } finally {
      store.close();
    }
  });

  it('projects Native shared-claim spendability to aggregate readers without raw sources', async () => {
    const request = actualSourceRequest();
    if (request.scenario.kind !== 'purchases') throw new Error('Purchase fixture required');
    const snapshot = structuredClone(request.financialSnapshot);
    snapshot.legacySnapshot.rules.push({
      id: 'private-source-rule-884',
      name: 'Private schedule rule',
      order: 1,
      trigger: { type: 'schedule' },
      actions: { type: 'category', categoryId: 'food' },
      inactive: false,
    });
    snapshot.legacySnapshot.schedules.push({
      id: 'private-source-schedule-884',
      frequency: '2026-09-06',
      amount: money('-500'),
      payeeName: 'Private scheduled payee',
      accountId: 'cash',
      nextExpected: '2026-09-06',
    });
    snapshot.coverage.rules = 'complete';
    snapshot.coverage.schedules = 'complete';
    const facts = structuredClone(snapshot.liquidity!);
    facts.schedules.push({
      id: 'private-source-schedule-884',
      accountId: 'cash',
      categoryId: null,
      ruleId: 'private-source-rule-884',
      dueDate: '2026-09-06',
      certainty: 'exact',
      amount: money('-500'),
      minimum: null,
      maximum: null,
      recurrence: null,
    });
    facts.accounts.find((account) => account.accountId === 'cash')!.obligations.push({
      id: 'private-source-schedule-884',
      economicObligationId: 'schedule:private-source-schedule-884:2026-09-06',
      categoryId: null,
      amount: money('500'),
      dueAt: '2026-09-06',
      paid: false,
      includedInBalance: false,
      matchedTransactionIds: [],
    });
    facts.ledgerContentHash = `sha256:${createHash('sha256')
      .update(JSON.stringify(snapshot.legacySnapshot))
      .digest('hex')}`;
    request.financialSnapshot = withLiquidityFacts({ ...snapshot, liquidity: facts }, facts);
    request.context.snapshotId = request.financialSnapshot.snapshotId;
    request.context.contentHash = request.financialSnapshot.contentHash;
    const unreserved = evaluate(request);
    const claimedRequest = structuredClone(request);
    claimedRequest.claimSet = {
      revision: 'shared-claims-1',
      bundles: [{
        id: 'private-shared-reservation-884',
        creationSnapshotId: claimedRequest.context.snapshotId,
        creationPolicyVersion: claimedRequest.liquidityPolicy.version,
        state: 'active',
        expiresAt: '2026-09-06T10:15:00Z',
        initiated: false,
        effects: [{
          kind: 'account_debit',
          resourceId: 'cash',
          amount: money('7000'),
          economicObligationId: 'private-shared-claim-obligation-884',
          categoryId: 'food',
          includedInBalance: false,
          matchedTransactionIds: [],
        }],
      }],
    };
    const result = evaluate(claimedRequest);
    const unreservedCash = unreserved.accountsBefore.find((account) => account.accountId === 'cash')!;
    const reservedCash = result.accountsBefore.find((account) => account.accountId === 'cash')!;
    expect(reservedCash.safeSpendingCapacity).not.toEqual(unreservedCash.safeSpendingCapacity);
    expect(result.paymentLiquidityStatus).not.toBe(unreserved.paymentLiquidityStatus);

    const store = new SqliteWorkflowStore(':memory:');
    const now = claimedRequest.context.evaluatedAt;
    const actor = await createActor(
      store,
      'aggregate-shared-claim-reader',
      claimedRequest.financialSnapshot.source.budgetId,
      now,
    );
    try {
      setGrant(store, actor, 'budget', actor.budgetId, 'conclusion', now, true, { aggregateOnly: true });
      const projection = new LiquidityProjector(store, actor, claimedRequest.financialSnapshot)
        .view(claimedRequest, result, now, claimedRequest.scenario.items);
      expect(projection.fundingStatus).toBe(result.budgetFundingStatus);
      expect(projection.paymentStatus).toBe(result.paymentLiquidityStatus);
      expect(projection.accounts).toEqual([]);
      expect(projection.categories).toEqual([]);
      expect(projection.purchases).toEqual([]);
      const serialized = JSON.stringify(projection);
      for (const hidden of [
        'private-source-transaction-884',
        'private-source-rule-884',
        'private-source-schedule-884',
        'schedule:private-source-schedule-884:2026-09-06',
        'Private scheduled payee',
        'private-shared-reservation-884',
        'private-shared-claim-obligation-884',
      ])
        expect(serialized).not.toContain(hidden);
    } finally {
      store.close();
    }
  });

  it('withholds global feasibility and details when a scoped conclusion excludes source resources', async () => {
    const request = actualSourceRequest();
    if (request.scenario.kind !== 'purchases') throw new Error('Purchase fixture required');
    const result = evaluate(request);
    const changedRequest = structuredClone(request);
    const changedSnapshot = structuredClone(changedRequest.financialSnapshot);
    const changedFacts = structuredClone(changedSnapshot.liquidity!);
    const savings = changedFacts.accounts.find((account) => account.accountId === 'savings')!;
    savings.recordedBalance = money('0');
    const legacySavings = changedSnapshot.legacySnapshot.accounts.find((account) => account.id === 'savings')!;
    legacySavings.clearedBalance = money('0');
    legacySavings.importedBalance = money('0');
    changedFacts.ledgerContentHash = `sha256:${createHash('sha256')
      .update(JSON.stringify(changedSnapshot.legacySnapshot))
      .digest('hex')}`;
    changedRequest.financialSnapshot = withLiquidityFacts({
      ...changedSnapshot,
      liquidity: changedFacts,
    }, changedFacts);
    changedRequest.context.snapshotId = changedRequest.financialSnapshot.snapshotId;
    changedRequest.context.contentHash = changedRequest.financialSnapshot.contentHash;
    const changedResult = evaluate(changedRequest);
    expect(
      changedRequest.financialSnapshot.liquidity!.accounts.find((account) => account.accountId === 'savings')!
        .recordedBalance,
    ).not.toEqual(
      request.financialSnapshot.liquidity!.accounts.find((account) => account.accountId === 'savings')!
        .recordedBalance,
    );

    const store = new SqliteWorkflowStore(':memory:');
    const now = request.context.evaluatedAt;
    const actor = await createActor(store, 'scoped-source-reader', request.financialSnapshot.source.budgetId, now);
    try {
      setGrant(store, actor, 'budget', actor.budgetId, 'conclusion', now, true, { accountIds: ['cash'] });
      for (const capability of ['balance', 'liquidity'] as const)
        setGrant(store, actor, 'budget', actor.budgetId, capability, now);
      for (const capability of ['existence', 'balance', 'liquidity', 'conclusion'] as const)
        setGrant(store, actor, 'category', 'food', capability, now);

      const projector = new LiquidityProjector(store, actor, request.financialSnapshot);
      const view = projector.view(request, result, now, request.scenario.items);
      const changedView = new LiquidityProjector(store, actor, changedRequest.financialSnapshot)
        .view(changedRequest, changedResult, now, changedRequest.scenario.items);
      const visibleCategory = view.categories.find((category) => category.id === 'food');
      const changedVisibleCategory = changedView.categories.find((category) => category.id === 'food');
      expect(visibleCategory?.availabilityBefore).toBeDefined();
      expect(visibleCategory?.feasible).toBeNull();
      expect(changedVisibleCategory?.feasible).toBeNull();
      for (const [projection, evaluated] of [[view, result], [changedView, changedResult]] as const) {
        expect(projection.fundingStatus).toBeNull();
        expect(projection.paymentStatus).toBeNull();
        expect(projection.horizon).not.toEqual(evaluated.horizon);
        expect(projection.expiresAt).toBe(now);
        expect(projection).not.toHaveProperty('snapshotId');
        expect(projection).not.toHaveProperty('policyVersion');
        expect(projection.reasons).toEqual([]);
        expect(projection.assumptions).toEqual([]);
      }
    } finally {
      store.close();
    }
  });
});
