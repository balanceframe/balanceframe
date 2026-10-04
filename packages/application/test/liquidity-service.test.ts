import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import type { Transaction, TransferSettlementRecord } from '@balanceframe/protocol-generated';
import {
  normalizeAccounts,
  normalizeCategories,
  normalizeActualLiquidityFacts,
  withLiquidityFacts,
} from '../../actual-adapter/src/normalizer.js';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
import { ConnectionManager } from '../src/connection-manager.js';
import type { ManualTransactionInput } from '@balanceframe/actual-adapter';
import { LiquidityService, createLiquidityService } from '../src/liquidity-service.js';
import { LiquidityProjector } from '../src/liquidity-projector.js';
import {
  InAppChannelAdapter,
  NotificationRuntime,
} from '../src/notifications.js';
import type { NotificationPolicy } from '../src/notifications.js';

const native = createRequire(import.meta.url)('@balanceframe/native');
const now = '2026-09-06T10:01:00.000Z';
const expiresAt = '2026-09-06T10:15:00.000Z';
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
const actorAuth = (actorId: string, reauthenticatedAt = now) => ({
  method: 'human-session' as const,
  actorId,
  sessionId: `session:${actorId}`,
  reauthenticatedAt,
});
const financialCapabilities = [
  'conclusion', 'existence', 'name', 'balance', 'history', 'liquidity', 'source', 'category',
  'proposal', 'approval', 'initiation-report', 'confirmation', 'audit', 'policy', 'session',
  'full-read',
] as const;
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
const canonicalFixture = canonicalProtocolSnapshotSchema.parse(
  JSON.parse(readFileSync(new URL('../../../protocol/fixtures/representative.json', import.meta.url), 'utf8')),
);
const importedRowFixture: Transaction = canonicalFixture.transactions[0]!;
const purchase = {
  kind: 'purchase' as const,
  categoryId: 'food',
  amount: money('2000'),
  accountId: 'checking',
  purchaseAt: '2026-09-06T12:00:00.000Z',
  requiredBy: '2026-09-06T12:00:00.000Z',
};

/** Normalize real Actual-shaped source records; only the connector transport is substituted. */
function snapshot(
  sourceBalance = 20000,
  capturedAt = '2026-09-06T10:00:00.000Z',
  discoverAccount = false,
  checkingBalance = 9000,
  otherBalance = 0,
) {
  const base = actualLiquidityRequest(false).financialSnapshot;
  const accounts = [
    {
      id: 'checking',
      name: 'Checking',
      offbudget: false,
      closed: false,
      balance_current: checkingBalance,
    },
    {
      id: 'savings',
      name: 'Private savings',
      offbudget: false,
      closed: false,
      balance_current: sourceBalance,
    },
  ];
  if (discoverAccount)
    accounts.push({
      id: 'new-account',
      name: 'New account',
      offbudget: false,
      closed: false,
      balance_current: 0,
    });
  const categories = [
    { id: 'food', name: 'Food', group_id: 'living', is_income: false, hidden: false },
    { id: 'other', name: 'Other', group_id: 'living', is_income: false, hidden: false },
  ];
  const ledger = {
    ...base,
    capturedAt,
    legacySnapshot: {
      ...base.legacySnapshot,
      snapshotDate: capturedAt,
      accounts: normalizeAccounts(accounts),
      categories: normalizeCategories(categories, [
        { id: 'living', name: 'Living', is_income: false, hidden: false },
      ]),
    },
  };
  return withLiquidityFacts(
    ledger,
    normalizeActualLiquidityFacts({
      capturedAt,
      ledgerContentHash: base.contentHash,
      currency: 'USD',
      accounts: { available: true, items: accounts },
      categories: { available: true, items: categories },
      budgetMonths: [
        {
          month: '2026-09',
          categoryGroups: [
            {
              id: 'living',
              categories: [
                { id: 'food', balance: 2000 },
                { id: 'other', balance: otherBalance },
              ],
            },
          ],
        },
      ],
      transactions: accounts.map((a) => ({
        accountId: a.id,
        read: { available: true, items: [] },
      })),
      schedules: { available: true, items: [] },
    }),
  );
}

function connectorSourceObservations(accountIds: readonly string[]) {
  return [
    {
      kind: 'account_collection_coverage' as const,
      scope: { kind: 'global' as const },
      state: 'complete' as const,
      observedAt: '2026-09-06T10:00:00.000Z',
      evidence: [],
    },
    ...accountIds.flatMap((accountId) => {
      const scope = { kind: 'account' as const, id: accountId };
      const evidence = [{
        evidenceId: accountId, kind: 'account', authorized: true, redaction: 'visible' as const,
      }];
      return [
        { kind: 'account_freshness' as const, scope, state: 'unknown' as const, observedAt: null, evidence },
        { kind: 'account_coverage' as const, scope, state: 'complete' as const, observedAt: now, evidence },
        { kind: 'account_type' as const, scope, state: 'unknown' as const, observedAt: null, evidence },
        { kind: 'account_balance' as const, scope, state: 'complete' as const, observedAt: now, evidence },
      ];
    }),
  ];
}

describe('authoritative application liquidity service', () => {
  let store: SqliteWorkflowStore;
  let directory: string;
  let service: LiquidityService;
  let manager: ConnectionManager;
  let actor: SpaceActor;
  let current = snapshot();
  let clockNow = now;
  let advanceDuringSync: string | null = null;
  let settlementRecords: TransferSettlementRecord[] | undefined;

  function grant(
    target: SpaceActor,
    resourceKind: 'budget' | 'account' | 'category' | 'session' | 'transfer' | 'evidence',
    resourceId: string,
    capability: string,
    granted = true,
    restrictions?: Record<string, unknown>,
  ): void {
    store.governance.setResourceGrant({
      spaceId: target.spaceId,
      actorId: target.actorId,
      budgetId: target.budgetId,
      membershipId: target.membershipId,
      resourceKind,
      resourceId,
      capability,
      granted,
      ...(restrictions === undefined ? {} : { restrictions }),
      now: clockNow,
      auth: actorAuth(actor.actorId, clockNow),
    });
  }
  function grantAllResources(target: SpaceActor): void {
    const resources = [
      ['budget', target.budgetId],
      ['account', 'checking'],
      ['account', 'savings'],
      ['category', 'food'],
      ['category', 'other'],
    ] as const;
    for (const [resourceKind, resourceId] of resources)
      for (const capability of financialCapabilities)
        if (capability !== 'full-read' || resourceKind === 'budget')
          grant(target, resourceKind, resourceId, capability);
  }

  async function addMember(actorId: string): Promise<SpaceActor> {
    await store.upsertActorMembership(actorId, 'active', ['observe'], `budget:${actor.budgetId}`);
    const membership = store.governance.addMembership({
      spaceId: actor.spaceId,
      actorId,
      validFrom: clockNow,
      now: clockNow,
      auth: actorAuth(actor.actorId, clockNow),
    });
    const governancePolicy = store.governance.getPolicy({ spaceId: actor.spaceId });
    if (!governancePolicy) throw new Error('Fixture governance policy required');
    return {
      actorId,
      budgetId: actor.budgetId,
      spaceId: actor.spaceId,
      now: clockNow,
      membershipId: membership.id,
      governancePolicyVersion: governancePolicy.version,
      auth: actorAuth(actorId, clockNow),
    };
  }
  async function saveLiquidityPolicy(value: unknown) {
    const configuration = await service.savePolicy(actor, value);
    const governancePolicy = store.governance.getPolicy({ spaceId: actor.spaceId });
    if (!governancePolicy) throw new Error('Fixture governance policy required');
    actor = { ...actor, governancePolicyVersion: governancePolicy.version, now: clockNow };
    return configuration;
  }
  async function addCompletionApprover(
    completion: {
      debit: { accountId: string; categoryCharges: readonly { categoryId: string }[] } | null;
    },
    actorId: string,
  ): Promise<SpaceActor> {
    const debit = completion.debit;
    if (!debit) throw new Error('Fixture completion debit required');
    const approver = await addMember(actorId);
    for (const capability of ['proposal', 'approval', 'session', 'conclusion', 'liquidity'] as const)
      grant(approver, 'budget', approver.budgetId, capability);
    for (const [resourceKind, resourceId] of [
      ['account', debit.accountId],
      ...debit.categoryCharges.map(({ categoryId }) => ['category', categoryId] as const),
    ] as const) {
      for (const capability of ['existence', 'liquidity', 'proposal', 'approval'] as const)
        grant(approver, resourceKind, resourceId, capability);
      if (resourceKind === 'account') grant(approver, 'account', resourceId, 'balance');
    }
    return approver;
  }
  async function addTransferApprover(proposalId: string, actorId: string): Promise<SpaceActor> {
    const proposal = store.liquidity.getTransferProposal({ ...actor, proposalId, now: clockNow });
    const plan = proposal.payload.plan;
    const resources = new Map<string, ['account' | 'category', string]>();
    const add = (kind: 'account' | 'category', id: string) => resources.set(`${kind}:${id}`, [kind, id]);
    const sources = new Set(plan.legs.map(({ sourceAccountId }) => sourceAccountId));
    for (const leg of plan.legs) {
      add('account', leg.sourceAccountId);
      add('account', leg.destinationAccountId);
    }
    for (const effect of plan.reservations) {
      add(effect.kind === 'category' ? 'category' : 'account', effect.resourceId);
      if (effect.categoryId) add('category', effect.categoryId);
    }
    for (const line of plan.backingAfter.lines) {
      add('account', line.accountId);
      add('category', line.categoryId);
    }
    if (plan.scenario.kind === 'purchases')
      for (const item of plan.scenario.items) {
        add('category', item.categoryId);
        for (const accountId of [
          item.routeSelection.explicitAccountId,
          item.routeSelection.sessionAccountId,
          item.routeSelection.approvedPreference?.accountId,
          item.routeSelection.historicalRoute?.accountId,
        ])
          if (accountId) add('account', accountId);
      }
    else
      for (const move of plan.scenario.moves) {
        add('category', move.sourceCategoryId);
        add('category', move.destinationCategoryId);
      }
    const approver = await addMember(actorId);
    for (const capability of ['proposal', 'approval', 'conclusion', 'liquidity'] as const)
      grant(approver, 'budget', approver.budgetId, capability);
    for (const [resourceKind, resourceId] of resources.values()) {
      for (const capability of [
        'existence', 'name', 'balance', 'history', 'liquidity', 'proposal', 'approval',
      ] as const)
        grant(approver, resourceKind, resourceId, capability);
      if (resourceKind === 'account' && sources.has(resourceId))
        grant(approver, 'account', resourceId, 'source');
    }
    return approver;
  }
  beforeEach(async () => {
    actor = {
      actorId: 'holder',
      budgetId: 'fixture',
      spaceId: '',
      membershipId: '',
      governancePolicyVersion: '',
      now,
      auth: actorAuth('holder'),
    };
    current = snapshot();
    clockNow = now;
    advanceDuringSync = null;
    settlementRecords = undefined;
    directory = mkdtempSync(join(tmpdir(), 'liquidity-service-'));
    store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
    await store.claimBootstrap({ name: 'Holder', email: 'holder@example.com', claimId: 'claim' });
    await store.finalizeBootstrap({ claimId: 'claim', ownerUserId: actor.actorId });
    await store.upsertActorMembership(actor.actorId, 'active', ['observe'], 'budget:fixture');
    const space = store.governance.createSpace({
      actorId: actor.actorId,
      name: 'Fixture',
      kind: 'personal',
      now,
      auth: actorAuth(actor.actorId),
    });
    const membership = store.governance.getCurrentMembership({
      spaceId: space.id,
      actorId: actor.actorId,
      now,
    });
    if (!membership) throw new Error('Fixture owner membership required');
    actor = { ...actor, spaceId: space.id, membershipId: membership.id, auth: actorAuth(actor.actorId) };
    const initialGovernancePolicy = store.governance.getPolicy({ spaceId: space.id });
    if (!initialGovernancePolicy) throw new Error('Fixture governance policy required');
    store.governance.setPolicy({
      spaceId: space.id,
      expectedVersion: initialGovernancePolicy.version,
      policy: { minimumApprovers: 1 },
      now,
      auth: actorAuth(actor.actorId),
    });
    store.governance.bindBudget({
      spaceId: space.id,
      budgetId: actor.budgetId,
      now,
      auth: actorAuth(actor.actorId),
    });
    const configuredGovernancePolicy = store.governance.getPolicy({ spaceId: space.id });
    if (!configuredGovernancePolicy) throw new Error('Fixture governance policy required');
    actor = { ...actor, governancePolicyVersion: configuredGovernancePolicy.version };
    grantAllResources(actor);
    const policy = JSON.parse(
      readFileSync(
        new URL('../../../protocol/fixtures/account-aware-liquidity.json', import.meta.url),
        'utf8',
      ),
    ).liquidityPolicy;
    store.liquidity.savePolicy({
      ...actor,
      expectedVersion: null,
      expectedGovernancePolicyVersion: configuredGovernancePolicy.version,
      now,
      auth: actor.auth,
      policy,
      approvalPolicy: { minimumApprovers: 1 },
    });
    const currentGovernancePolicy = store.governance.getPolicy({ spaceId: space.id });
    if (!currentGovernancePolicy) throw new Error('Fixture governance policy required');
    actor = { ...actor, governancePolicyVersion: currentGovernancePolicy.version, now: clockNow };
    manager = new ConnectionManager({
      readFile: async () =>
        JSON.stringify({
          version: 1,
          serverUrl: 'http://actual',
          budgetId: 'fixture',
          budgetName: 'Fixture',
          groupId: 'fixture',
        }),
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'fixture' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        connect: async () => [],
        selectBudget: async () => ({
          id: 'fixture',
          groupId: 'fixture',
          name: 'Fixture',
          encrypted: false,
        }),
        synchronize: async () => {
          if (advanceDuringSync) clockNow = advanceDuringSync;
          return {
            financialSnapshot: current,
            snapshot: current.legacySnapshot,
            transferSettlementRecords: settlementRecords,
          };
        },
        disconnect: async () => {},
      }),
    });
    service = new LiquidityService({
      connectionManager: manager,
      store,
      native,
      clock: () => new Date(clockNow),
    });
    await service.saveObservations(actor, {
      expectedVersion: 0,
      expiresAt,
      observations: ['checking', 'savings'].map((accountId) => ({
        accountId,
        currentLedgerConfirmed: true,
        kind: 'cash',
        currency: 'USD',
        owned: true,
        holds: money('0'),
      })),
    });
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function saveFundedObservations(): Promise<void> {
    current = snapshot(20000, '2026-09-06T10:00:00.000Z', false, 15000);
    await service.saveObservations(actor, {
      expectedVersion: 1,
      expiresAt,
      observations: ['checking', 'savings'].map((accountId) => ({
        accountId, currentLedgerConfirmed: true, kind: 'cash', currency: 'USD',
        owned: true, holds: money('0'),
      })),
    });
  }
  async function saveFundedSession(amount = '1000') {
    await saveFundedObservations();
    const session = await service.saveSession(actor, null, {
      accountId: 'checking',
      expiresAt,
      items: [{ id: 'one', categoryId: 'food', accountId: 'checking', amount: money(amount),
        purchaseAt: now, requiredBy: now }],
    });
    expect(session).toMatchObject({
      spaceId: actor.spaceId,
      membershipId: actor.membershipId,
      governancePolicyVersion: actor.governancePolicyVersion,
    });
    expect(session.card.outcome).toBe('funded_now');
    return session;
  }

  it('serves the canonical immutable Card for a quick check without claiming a ledger mutation', async () => {
    const result = await service.evaluatePurchase(actor, purchase);
    expect(result.card).toMatchObject({
      outcome: 'safe_after_date',
      budgetFundingStatus: 'funded',
      paymentLiquidityStatus: 'transfer_required',
      selectedAccountId: 'checking',
      before: {
        categories: expect.arrayContaining([
          expect.objectContaining({
            categoryId: 'food',
            asOfMonth: '2026-09',
            availability: money('2000'),
          }),
        ]),
      },
      after: {
        categories: expect.arrayContaining([
          expect.objectContaining({ categoryId: 'food', availability: money('0') }),
        ]),
      },
      fundingPaths: expect.arrayContaining([
        expect.objectContaining({
          kind: 'account_transfer',
          minimumAmount: money('3000'),
        }),
      ]),
    });
    expect(result.card).not.toHaveProperty('planHash');
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
  });

  it('turns Actual partial account metadata into a funded ready Card only after dated attestations', async () => {
    current = snapshot(20000, '2026-09-06T10:00:00.000Z', false, 15000);
    current.coverage = { ...current.coverage, accounts: 'partial' };
    current.observations = connectorSourceObservations(['checking', 'savings']);
    await service.saveObservations(actor, {
      expectedVersion: 1,
      expiresAt,
      observations: ['checking', 'savings'].map((accountId) => ({
        accountId, currentLedgerConfirmed: true, kind: 'cash',
        currency: 'USD', owned: true, holds: money('0'),
      })),
    });

    const result = await service.evaluatePurchase(actor, {
      ...purchase, purchaseAt: now, requiredBy: now,
    });

    expect(result.card).toMatchObject({
      outcome: 'funded_now',
      budgetFundingStatus: 'funded',
      paymentLiquidityStatus: 'ready',
      before: {
        categories: expect.arrayContaining([
          expect.objectContaining({ categoryId: 'food', availability: money('2000') }),
        ]),
        accounts: expect.arrayContaining([
          expect.objectContaining({ accountId: 'checking', safeSpendingCapacity: money('5000') }),
        ]),
      },
      after: {
        categories: expect.arrayContaining([
          expect.objectContaining({ categoryId: 'food', availability: money('0') }),
        ]),
        accounts: expect.arrayContaining([
          expect.objectContaining({ accountId: 'checking', safeSpendingCapacity: money('3000') }),
        ]),
      },
    });
  });

  it('reserves exact native cart charges and restores availability on authorized release', async () => {
    const originalPolicy = store.liquidity.getPolicy(actor)!;
    await saveLiquidityPolicy({
      expectedVersion: originalPolicy.policy.version,
      expiresAt: originalPolicy.policy.expiresAt,
      accounts: originalPolicy.policy.accounts.map(({ resourceScope: _scope, ...account }) => account),
      transferRoutes: originalPolicy.policy.transferRoutes.map(({ evidence: _evidence, ...route }) => route),
      approvalPolicy: originalPolicy.approvalPolicy,
      reservationMode: 'block',
    });
    const session = await saveFundedSession();
    const reservation = await service.createProspectiveClaim(actor, {
      sessionId: session.id,
      expectedSessionVersion: session.version,
      kind: 'reservation',
      scope: { kind: 'category', id: 'food' },
      idempotencyKey: 'reserve-food',
    });
    expect(reservation).toMatchObject({
      kind: 'reservation',
      sourceId: `session:${session.id}:${session.version}`,
      amount: money('1000'),
      lifecycleState: 'active',
      status: 'active',
    });
    const competing = await service.saveSession(actor, null, {
      accountId: 'checking', expiresAt,
      items: [{ id: 'competing', categoryId: 'food', accountId: 'checking', amount: money('1500'),
        purchaseAt: now, requiredBy: now }],
    });
    expect(competing.card.outcome).not.toBe('funded_now');
    expect((await service.prospectiveClaims(actor)).some((claim) =>
      claim.claimId === reservation.claimId)).toBe(true);
    const released = await service.releaseProspectiveClaim(actor, reservation.claimId!, {
      idempotencyKey: 'release-food',
    });
    expect(released).toMatchObject({ lifecycleState: 'released', status: 'released' });
    expect((await service.session(actor, competing.id)).card.outcome).toBe('funded_now');
  });

  it('does not charge a saved session twice for its own category and account commitments', async () => {
    const session = await saveFundedSession('1500');
    const category = await service.createProspectiveClaim(actor, {
      sessionId: session.id, expectedSessionVersion: session.version,
      kind: 'commitment', scope: { kind: 'category', id: 'food' },
      idempotencyKey: 'own-category-commitment',
    });
    const account = await service.createProspectiveClaim(actor, {
      sessionId: session.id, expectedSessionVersion: session.version,
      kind: 'commitment', scope: { kind: 'account', id: 'checking' },
      idempotencyKey: 'own-account-commitment',
    });
    expect(category).toMatchObject({ mode: 'block', amount: money('1500'), lifecycleState: 'active' });
    expect(account).toMatchObject({ mode: 'block', amount: money('1500'), lifecycleState: 'active' });
    expect((await service.session(actor, session.id)).card).toMatchObject({
      outcome: 'funded_now',
      before: { categories: expect.arrayContaining([
        expect.objectContaining({ categoryId: 'food', availability: money('2000') }),
      ]) },
      after: { categories: expect.arrayContaining([
        expect.objectContaining({ categoryId: 'food', availability: money('500') }),
      ]) },
    });
  });

  it('reevaluates a still-open same-day cart at the current instant before reserving its exact charge', async () => {
    const session = await saveFundedSession();
    clockNow = '2026-09-06T10:03:00.000Z';
    current = snapshot(20000, '2026-09-06T10:02:59.000Z', false, 15000);
    expect((await service.session(actor, session.id)).card.outcome).toBe('funded_now');
    const claim = await service.createProspectiveClaim(actor, {
      sessionId: session.id,
      expectedSessionVersion: session.version,
      kind: 'commitment',
      scope: { kind: 'category', id: 'food' },
      idempotencyKey: 'later-same-day-commitment',
    });
    expect(claim).toMatchObject({ amount: money('1000'), lifecycleState: 'active' });
  });

  it('replays prospective creation after a lost response without reserving the cart twice', async () => {
    const session = await saveFundedSession();
    const intent = {
      sessionId: session.id, expectedSessionVersion: session.version,
      kind: 'reservation' as const, scope: { kind: 'category' as const, id: 'food' },
      idempotencyKey: 'prospective-lost-response',
    };
    const first = await service.createProspectiveClaim(actor, intent);
    const revision = store.liquidity.getClaimSet({ ...actor, now }).revision;
    expect(await service.createProspectiveClaim(actor, intent)).toMatchObject({
      claimId: first.claimId, amount: first.amount, lifecycleState: 'active',
    });
    expect(store.liquidity.getClaimSet({ ...actor, now }).revision).toBe(revision);
    await expect(service.createProspectiveClaim(actor, {
      ...intent, kind: 'commitment',
    })).rejects.toThrow(/Idempotency replay mismatch/);
  });

  it('persists category protection and joy policy for subsequent exact Cards', async () => {
    const existing = store.liquidity.getPolicy(actor);
    if (!existing) throw new Error('Fixture liquidity policy required');
    const configuration = await saveLiquidityPolicy({
      expectedVersion: existing.policy.version,
      expiresAt: existing.policy.expiresAt,
      accounts: existing.policy.accounts.map(({ resourceScope: _scope, ...account }) => account),
      transferRoutes: existing.policy.transferRoutes.map(({ evidence: _evidence, ...route }) => route),
      approvalPolicy: existing.approvalPolicy,
      categoryPolicies: [
        {
          categoryId: 'food',
          kind: 'protected',
          donorEligible: false,
          minimumRetained: money('1000'),
          projectedRemainingNeed: money('0'),
        },
        {
          categoryId: 'other',
          kind: 'guilt_free',
          donorEligible: true,
          minimumRetained: money('0'),
          projectedRemainingNeed: money('0'),
        },
      ],
    });
    expect(configuration.policy?.categoryPolicies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          categoryId: 'food',
          kind: 'protected',
          minimumRetained: money('1000'),
        }),
        expect.objectContaining({ categoryId: 'other', kind: 'guilt_free' }),
      ]),
    );
    expect((await service.evaluatePurchase(actor, purchase)).card).toMatchObject({
      outcome: 'plan_breaking',
      before: {
        categories: expect.arrayContaining([
          expect.objectContaining({ categoryId: 'food', policyKind: 'protected' }),
        ]),
      },
    });
  });

  it('persists the policy choice that makes reservations block competing decisions', async () => {
    const existing = store.liquidity.getPolicy(actor)!;
    const configured = await saveLiquidityPolicy({
      expectedVersion: existing.policy.version,
      expiresAt: existing.policy.expiresAt,
      accounts: existing.policy.accounts.map(({ resourceScope: _scope, ...account }) => account),
      transferRoutes: existing.policy.transferRoutes.map(({ evidence: _evidence, ...route }) => route),
      approvalPolicy: existing.approvalPolicy,
      reservationMode: 'block',
    });
    expect(configured.policy?.reservationMode).toBe('block');
  });

  it('round-trips an optional discretionary cooldown without changing the native Card policy', async () => {
    const existing = store.liquidity.getPolicy(actor);
    if (!existing) throw new Error('Fixture liquidity policy required');
    const configuration = await saveLiquidityPolicy({
      expectedVersion: existing.policy.version,
      expiresAt: existing.policy.expiresAt,
      accounts: existing.policy.accounts.map(({ resourceScope: _scope, ...account }) => account),
      transferRoutes: existing.policy.transferRoutes.map(({ evidence: _evidence, ...route }) => route),
      approvalPolicy: existing.approvalPolicy,
      categoryPolicies: [{
        categoryId: 'food',
        kind: 'discretionary',
        donorEligible: false,
        minimumRetained: money('0'),
        projectedRemainingNeed: money('0'),
        cooldownMinutes: 60,
      }],
    });
    expect(configuration.policy?.categoryPolicies).toEqual([
      expect.objectContaining({ categoryId: 'food', cooldownMinutes: 60 }),
    ]);
    expect((await service.evaluatePurchase(actor, purchase)).card.outcome).not.toBe('insufficient_data');
    await expect(saveLiquidityPolicy({
      expectedVersion: configuration.policy!.version,
      expiresAt: configuration.policy!.expiresAt,
      accounts: configuration.policy!.accounts.map(({ resourceScope: _scope, ...account }) => account),
      transferRoutes: configuration.policy!.transferRoutes.map(({ evidence: _evidence, ...route }) => route),
      approvalPolicy: configuration.approvalPolicy!,
      categoryPolicies: [{
        ...configuration.policy!.categoryPolicies![0]!,
        kind: 'protected',
      }],
    })).rejects.toThrow();
  });

  it('proposes completion from the native quantity-adjusted cart rather than per-unit session prices', async () => {
    current = snapshot(20000, '2026-09-06T10:00:00.000Z', false, 15000);
    await service.saveObservations(actor, {
      expectedVersion: 1,
      expiresAt,
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
      expiresAt,
      items: [{
        id: 'purchase-1',
        categoryId: 'food',
        accountId: 'checking',
        amount: money('800'),
        quantity: 2,
        priority: 'required',
        purchaseAt: now,
        requiredBy: now,
      }],
      adjustments: [
        { kind: 'tax', categoryId: 'food', amount: money('70') },
        { kind: 'fee', categoryId: 'food', amount: money('30') },
        { kind: 'discount', categoryId: 'food', amount: money('100') },
      ],
    });
    expect(session.card.outcome).toBe('funded_now');
    expect(session.card.cart?.total).toEqual(money('1600'));
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'finish-1',
      payeeName: 'Fixture shop',
      notes: 'Order 1',
    });
    expect(proposed).toMatchObject({
      phase: 'proposed',
      debit: {
        accountId: 'checking',
        amount: -1600,
        date: '2026-09-06',
        categoryCharges: [{ categoryId: 'food', amount: money('1600') }],
        payeeName: 'Fixture shop',
        notes: 'Order 1',
      },
    });
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([
      expect.objectContaining({
        state: 'active',
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'category', amount: money('1600') }),
          expect.objectContaining({ kind: 'account_debit', amount: money('1600') }),
        ]),
      }),
    ]);
  });
  it('redacts completion payee and notes until transaction-history rights are present', async () => {
    const session = await saveFundedSession();
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'private-completion-fields',
      payeeName: 'Private shop marker',
      notes: 'Private note marker',
    });
    const reader = await addMember('completion-reader');
    for (const [resourceKind, resourceId, capability] of [
      ['budget', reader.budgetId, 'proposal'],
      ['budget', reader.budgetId, 'session'],
      ['budget', reader.budgetId, 'conclusion'],
      ['account', 'checking', 'existence'],
      ['account', 'checking', 'balance'],
      ['account', 'checking', 'liquidity'],
      ['account', 'checking', 'proposal'],
      ['category', 'food', 'existence'],
      ['category', 'food', 'liquidity'],
      ['category', 'food', 'proposal'],
    ] as const)
      grant(reader, resourceKind, resourceId, capability);

    const restricted = await service.sessionCompletion(reader, proposed.id);
    expect(restricted.debit).toMatchObject({
      accountId: 'checking',
      amount: -1000,
      payeeName: null,
      notes: null,
    });
    expect(JSON.stringify(restricted)).not.toContain('Private shop marker');
    expect(JSON.stringify(restricted)).not.toContain('Private note marker');

    for (const [resourceKind, resourceId] of [
      ['budget', reader.budgetId],
      ['account', 'checking'],
      ['category', 'food'],
    ] as const)
      grant(reader, resourceKind, resourceId, 'history');
    expect((await service.sessionCompletion(reader, proposed.id)).debit).toMatchObject({
      payeeName: 'Private shop marker',
      notes: 'Private note marker',
    });
  });

  it('fails closed before a completion write when the native liquidity capability disappears', async () => {
    const session = await saveFundedSession();
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'native-unavailable-proposal',
    });
    const approver = await addCompletionApprover(proposed, 'completion-approver');
    const approved = await service.approveSessionCompletion(approver, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'native-unavailable-approval',
    });
    const holdsBefore = store.liquidity.getClaimSet({ ...actor, now }).bundles;

    const evaluateDecisionCard = native.evaluateDecisionCard;
    try {
      native.evaluateDecisionCard = undefined;
      await expect(createLiquidityService({
        connectionManager: manager,
        mutationConnectionManager: manager,
        store,
      })).rejects.toThrow('Native liquidity capabilities unavailable');
    } finally {
      native.evaluateDecisionCard = evaluateDecisionCard;
    }
    expect((await service.sessionCompletion(actor, approved.id)).phase).toBe('approved');
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual(holdsBefore);
  });

  it('replays a lost completion proposal response without creating a second held debit', async () => {
    const session = await saveFundedSession();
    const intent = {
      expectedSessionVersion: session.version,
      idempotencyKey: 'completion-lost-response',
      payeeName: 'Fixture shop',
    };
    const first = await service.proposeSessionCompletion(actor, session.id, intent);
    const revision = store.liquidity.getClaimSet({ ...actor, now }).revision;
    expect(await service.proposeSessionCompletion(actor, session.id, intent)).toMatchObject({
      id: first.id, payloadHash: first.payloadHash, debit: first.debit,
    });
    expect(store.liquidity.getClaimSet({ ...actor, now }).revision).toBe(revision);
    await expect(service.proposeSessionCompletion(actor, session.id, {
      ...intent, payeeName: 'Different payee',
    })).rejects.toThrow(/Idempotency replay mismatch/);
  });

  it.each(['category', 'account'] as const)(
    'completes a %s-reserved cart without counting its own hold twice or leaving a second hold after verified write',
    async (kind) => {
    const originalPolicy = store.liquidity.getPolicy(actor)!;
    await saveLiquidityPolicy({
      expectedVersion: originalPolicy.policy.version,
      expiresAt: originalPolicy.policy.expiresAt,
      accounts: originalPolicy.policy.accounts.map(({ resourceScope: _scope, ...account }) => account),
      transferRoutes: originalPolicy.policy.transferRoutes.map(({ evidence: _evidence, ...route }) => route),
      approvalPolicy: originalPolicy.approvalPolicy,
      reservationMode: 'block',
    });
    const funded = await saveFundedSession();
    const session = await service.saveSession(actor, funded.id, {
      accountId: 'checking', expectedVersion: funded.version, expiresAt,
      items: [{ id: 'one', categoryId: 'food', accountId: 'checking', amount: money('2000'),
        purchaseAt: now, requiredBy: now }],
    });
    const reservation = await service.createProspectiveClaim(actor, {
      sessionId: session.id, expectedSessionVersion: session.version,
      kind: 'reservation', scope: { kind, id: kind === 'category' ? 'food' : 'checking' },
      idempotencyKey: 'own-cart-reservation',
    });
    const proposal = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version, idempotencyKey: 'own-cart-completion',
    });
    expect(proposal).toMatchObject({ phase: 'proposed', debit: { amount: -2000 } });
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([
      expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'category', amount: money('2000') }),
          expect.objectContaining({ kind: 'account_debit', amount: money('2000') }),
        ]),
      }),
    ]);
    const approver = await addCompletionApprover(proposal, 'cart-approver');
    const approved = await service.approveSessionCompletion(approver, proposal.id, {
      payloadHash: proposal.payloadHash!, expectedVersion: proposal.version,
      idempotencyKey: 'own-cart-approval',
    });
    const mutationManager = new ConnectionManager({
      readFile: async () => JSON.stringify({
        version: 1, serverUrl: 'http://actual', budgetId: 'fixture',
        budgetName: 'Fixture', groupId: 'fixture',
      }),
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'fixture' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        connect: async () => [],
        selectBudget: async () => ({ id: 'fixture', groupId: 'fixture', name: 'Fixture', encrypted: false }),
        synchronize: async () => ({ financialSnapshot: current, snapshot: current.legacySnapshot }),
        createManualTransaction: async (input: ManualTransactionInput) => ({
          success: true as const, parentId: input.parentId, correlationId: input.correlationId,
          transactionId: input.parentId, verified: true as const,
        }),
        disconnect: async () => {},
      }),
    });
    const writable = new LiquidityService({
      connectionManager: manager, mutationConnectionManager: mutationManager,
      store, native, clock: () => new Date(clockNow),
    });
    expect(await writable.executeSessionCompletion(actor, proposal.id, {
      payloadHash: proposal.payloadHash!, expectedVersion: approved.version,
      idempotencyKey: 'own-cart-execution',
    })).toMatchObject({ phase: 'verified' });
    expect((await service.prospectiveClaims(actor)).find(
      (claim) => claim.claimId === reservation.claimId,
    )).toMatchObject({ lifecycleState: 'consumed' });
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
    await expect(service.createProspectiveClaim(actor, {
      sessionId: session.id, expectedSessionVersion: session.version,
      kind: 'reservation', scope: { kind, id: kind === 'category' ? 'food' : 'checking' },
      idempotencyKey: 'late-hold-after-verification',
    })).rejects.toThrow(/already completed/);
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
    },
  );

  it('holds a reserved completed cart only once while unrelated purchases remain fundable', async () => {
    const funded = await saveFundedSession();
    await service.createProspectiveClaim(actor, {
      sessionId: funded.id, expectedSessionVersion: funded.version,
      kind: 'reservation', scope: { kind: 'category', id: 'food' },
      idempotencyKey: 'net-reservation',
    });
    await service.proposeSessionCompletion(actor, funded.id, {
      expectedSessionVersion: funded.version, idempotencyKey: 'net-completion',
    });
    expect((await service.evaluatePurchase(actor, {
      kind: 'purchase', categoryId: 'food', accountId: 'checking',
      amount: money('900'), purchaseAt: now, requiredBy: now,
    })).card.outcome).toBe('funded_now');
  });

  it('keeps two separately scoped reservations for a split session usable in native Cards', async () => {
    current = snapshot(20000, '2026-09-06T10:00:00.000Z', false, 15000, 2000);
    await service.saveObservations(actor, {
      expectedVersion: 1, expiresAt,
      observations: ['checking', 'savings'].map((accountId) => ({
        accountId, currentLedgerConfirmed: true, kind: 'cash', currency: 'USD',
        owned: true, holds: money('0'),
      })),
    });
    const session = await service.saveSession(actor, null, {
      accountId: 'checking', expiresAt,
      items: [
        { id: 'food', categoryId: 'food', accountId: 'checking',
          amount: money('800'), purchaseAt: now, requiredBy: now },
        { id: 'other', categoryId: 'other', accountId: 'checking',
          amount: money('400'), purchaseAt: now, requiredBy: now },
      ],
    });
    for (const categoryId of ['food', 'other'])
      await service.createProspectiveClaim(actor, {
        sessionId: session.id, expectedSessionVersion: session.version,
        kind: 'reservation', scope: { kind: 'category', id: categoryId },
        idempotencyKey: `split-${categoryId}`,
      });
    await service.createProspectiveClaim(actor, {
      sessionId: session.id, expectedSessionVersion: session.version,
      kind: 'reservation', scope: { kind: 'account', id: 'checking' },
      idempotencyKey: 'split-account',
    });
    expect((await service.evaluatePurchase(actor, {
      kind: 'purchase', categoryId: 'food', accountId: 'checking',
      amount: money('1000'), purchaseAt: now, requiredBy: now,
    })).card.outcome).toBe('funded_now');
  });

  it('keeps unrelated purchase Cards valid while a split completion holds two categories', async () => {
    current = snapshot(20000, '2026-09-06T10:00:00.000Z', false, 15000, 2000);
    await service.saveObservations(actor, {
      expectedVersion: 1,
      expiresAt,
      observations: ['checking', 'savings'].map((id) => ({
        accountId: id, currentLedgerConfirmed: true,
        kind: 'cash', currency: 'USD', owned: true, holds: money('0'),
      })),
    });
    const session = await service.saveSession(actor, null, {
      accountId: 'checking', expiresAt,
      items: [
        { id: 'food-item', categoryId: 'food', accountId: 'checking', amount: money('800'),
          purchaseAt: now, requiredBy: now },
        { id: 'other-item', categoryId: 'other', accountId: 'checking', amount: money('400'),
          purchaseAt: now, requiredBy: now },
      ],
    });
    expect(session.card.outcome).toBe('funded_now');
    await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'split-economic-identity',
    });
    const unrelated = await service.evaluatePurchase(actor, {
      kind: 'purchase', categoryId: 'food', accountId: 'checking',
      amount: money('100'), purchaseAt: now, requiredBy: now,
    });
    expect(unrelated.card.outcome).toBe('funded_now');
    expect(unrelated.card.blockers).not.toContain('ambiguous_claim_match');
  });

  it('can propose and approve a same-day saved cart after time has advanced', async () => {
    const session = await saveFundedSession();
    clockNow = '2026-09-06T10:03:00.000Z';
    current = snapshot(20000, '2026-09-06T10:02:59.000Z', false, 15000);
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'same-day-propose',
    });
    expect(proposed).toMatchObject({
      phase: 'proposed',
      debit: { accountId: 'checking', date: '2026-09-06', amount: -1000 },
    });
    clockNow = '2026-09-06T10:04:00.000Z';
    const approver = await addCompletionApprover(proposed, 'same-day-approver');
    const approved = await service.approveSessionCompletion(approver, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'same-day-approve',
    });
    expect(approved.phase).toBe('approved');
    expect(approved.canExecute).toBe(false);
    expect((await service.sessionCompletion(actor, proposed.id)).canExecute).toBe(true);
  });

  it('approves an exact completion after a harmless recapture, but rejects changed ledger material', async () => {
    const session = await saveFundedSession();
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'proposal-one',
    });
    current = snapshot(20000, '2026-09-06T10:00:30.000Z', false, 15000);
    const approver = await addCompletionApprover(proposed, 'ledger-approver');
    const approved = await service.approveSessionCompletion(approver, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'approval-one',
    });
    expect(approved).toMatchObject({ phase: 'approved', approvalCount: 1 });
    expect(approved.canExecute).toBe(false);
    expect((await service.sessionCompletion(actor, proposed.id)).canExecute).toBe(true);
    const second = await service.saveSession(actor, null, {
      accountId: 'checking', expiresAt,
      items: [{ id: 'another', categoryId: 'food', accountId: 'checking', amount: money('1500'),
        purchaseAt: now, requiredBy: now }],
    });
    expect(second.card.outcome).not.toBe('funded_now');
    current = snapshot(20000, '2026-09-06T10:00:40.000Z', false, 14999);
    const changedLedgerApprover = await addCompletionApprover(proposed, 'changed-ledger-approver');
    await expect(service.approveSessionCompletion(changedLedgerApprover, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: approved.version,
      idempotencyKey: 'approval-changed-ledger',
    })).rejects.toThrow();
  });

  it('delays discretionary approval then re-evaluates the same cart after cooldown', async () => {
    const existing = store.liquidity.getPolicy(actor)!;
    await saveLiquidityPolicy({
      expectedVersion: existing.policy.version,
      expiresAt: existing.policy.expiresAt,
      accounts: existing.policy.accounts.map(({ resourceScope: _scope, ...account }) => account),
      transferRoutes: existing.policy.transferRoutes.map(({ evidence: _evidence, ...route }) => route),
      approvalPolicy: existing.approvalPolicy,
      categoryPolicies: [{
        categoryId: 'food', kind: 'discretionary', donorEligible: false,
        minimumRetained: money('0'), projectedRemainingNeed: money('0'), cooldownMinutes: 1,
      }],
    });
    await saveFundedObservations();
    const session = await service.saveSession(actor, null, {
      accountId: 'checking',
      expiresAt,
      items: [{ id: 'one', categoryId: 'food', accountId: 'checking', amount: money('1000'),
        purchaseAt: '2026-09-06T10:02:00.000Z', requiredBy: '2026-09-06T10:02:00.000Z' }],
    });
    expect(session.card.outcome).toBe('funded_now');
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'cooldown-proposal',
    });
    expect(proposed.cooldownUntil).toBe('2026-09-06T10:02:00.000Z');
    const approver = await addCompletionApprover(proposed, 'cooldown-approver');
    await expect(service.approveSessionCompletion(approver, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'early-approval',
    })).rejects.toThrow(/cooldown/i);
    clockNow = '2026-09-06T10:02:00.000Z';
    current = snapshot(20000, '2026-09-06T10:01:30.000Z', false, 15000);
    const approved = await service.approveSessionCompletion(approver, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'after-cooldown',
    });
    expect(approved.phase).toBe('approved');
    expect(approved.canExecute).toBe(false);
    expect((await service.sessionCompletion(actor, proposed.id)).canExecute).toBe(true);
  });

  it('rejects execution without a mutation-mode connector before touching a proposal', async () => {
    await expect(service.executeSessionCompletion(actor, 'any-proposal', {}))
      .rejects.toThrow(/mutation connection/i);
  });

  it('lets a scoped peer approve the exact debit without granting access to the owner cart', async () => {
    const policy = store.liquidity.getPolicy(actor)!;
    await saveLiquidityPolicy({
      expectedVersion: policy.policy.version, expiresAt: policy.policy.expiresAt,
      accounts: policy.policy.accounts.map(({ resourceScope: _scope, ...account }) => account),
      transferRoutes: policy.policy.transferRoutes.map(({ evidence: _evidence, ...route }) => route),
      approvalPolicy: { minimumApprovers: 2 },
    });
    const original = await saveFundedSession();
    const session = await service.saveSession(actor, original.id, {
      expectedVersion: original.version, accountId: 'checking', expiresAt,
      items: [{
        ...original.items[0]!, categoryId: 'other',
        categoryAllocations: [{ categoryId: 'food', amount: money('1000') }],
      }],
    });
    expect(session.card.outcome).toBe('funded_now');
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version, idempotencyKey: 'scoped-proposal',
    });
    const selfApproval = await service.approveSessionCompletion(actor, proposed.id, {
      payloadHash: proposed.payloadHash!, expectedVersion: proposed.version,
      idempotencyKey: 'scoped-owner-approval',
    });
    expect(selfApproval).toMatchObject({ phase: 'proposed', approvalCount: 0 });
    const peer = await addCompletionApprover(proposed, 'coapprover');
    const secondPeer = await addCompletionApprover(proposed, 'second-coapprover');
    expect((await service.sessionCompletion(peer, proposed.id)).canApprove).toBe(true);
    await expect(service.session(peer, session.id)).rejects.toThrow();
    const peerApproved = await service.approveSessionCompletion(peer, proposed.id, {
      payloadHash: proposed.payloadHash!, expectedVersion: selfApproval.version,
      idempotencyKey: 'scoped-peer-approval',
    });
    expect(peerApproved).toMatchObject({ phase: 'proposed', approvalCount: 1 });
    const approved = await service.approveSessionCompletion(secondPeer, proposed.id, {
      payloadHash: proposed.payloadHash!, expectedVersion: peerApproved.version,
      idempotencyKey: 'scoped-second-peer-approval',
    });
    expect((await service.sessionCompletion(peer, proposed.id)).canExecute).toBe(false);
  });

  it('requires an explicit mutation manager and calls Actual once after a durable approval', async () => {
    const session = await saveFundedSession();
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'manual-proposal',
      payeeName: 'Fixture shop',
    });
    const approver = await addCompletionApprover(proposed, 'manual-completion-approver');
    const approved = await service.approveSessionCompletion(approver, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'manual-approval',
    });
    const command = {
      payloadHash: proposed.payloadHash!,
      expectedVersion: approved.version,
      idempotencyKey: 'manual-execute',
    };
    await expect(service.executeSessionCompletion(actor, approved.id, command))
      .rejects.toThrow(/mutation connection/i);

    const writes: ManualTransactionInput[] = [];
    const mutationManager = new ConnectionManager({
      readFile: async () => JSON.stringify({
        version: 1, serverUrl: 'http://actual', budgetId: 'fixture',
        budgetName: 'Fixture', groupId: 'fixture',
      }),
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'fixture' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        connect: async () => [],
        selectBudget: async () => ({
          id: 'fixture', groupId: 'fixture', name: 'Fixture', encrypted: false,
        }),
        synchronize: async () => ({ financialSnapshot: current, snapshot: current.legacySnapshot }),
        createManualTransaction: async (input: ManualTransactionInput) => {
          writes.push(input);
          return {
            success: true as const, parentId: input.parentId,
            correlationId: input.correlationId, transactionId: input.parentId,
            verified: true as const,
          };
        },
        disconnect: async () => {},
      }),
    });
    const writable = new LiquidityService({
      connectionManager: manager,
      mutationConnectionManager: mutationManager,
      store, native, clock: () => new Date(clockNow),
    });
    const executed = await writable.executeSessionCompletion(actor, approved.id, command);
    expect(executed).toMatchObject({ phase: 'verified' });
    expect(executed.manualTransactionId).toBe(writes[0]?.parentId);
    expect(writes).toEqual([
      expect.objectContaining({
        accountId: 'checking', amount: -1000, categoryId: 'food',
        payeeName: 'Fixture shop', date: '2026-09-06',
      }),
    ]);
    await expect(writable.executeSessionCompletion(actor, approved.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: executed.version,
      idempotencyKey: 'manual-execute-again',
    })).resolves.toMatchObject({ phase: 'verified' });
    expect(writes).toHaveLength(1);
    const actualParent = writes[0]!;
    current = {
      ...current,
      coverage: { ...current.coverage, accounts: 'partial', transactions: 'complete' },
      observations: [{
        kind: 'account_collection_coverage',
        scope: { kind: 'global' },
        state: 'complete',
        observedAt: clockNow,
        evidence: [],
      }],
      legacySnapshot: {
        ...current.legacySnapshot,
        transactions: [{
          ...importedRowFixture,
          id: actualParent.parentId,
          accountId: actualParent.accountId,
          date: actualParent.date,
          amount: money(String(actualParent.amount)),
          categoryId: actualParent.categoryId ?? null,
          payeeName: 'Fixture shop',
          importedId: 'bank-001',
          reconciled: false,
          subtransactions: [],
        }],
      },
    };
    const linked = await writable.reconcileSessionCompletion(actor, executed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: executed.version,
      idempotencyKey: 'later-bank-import',
    });
    expect(linked).toMatchObject({
      phase: 'verified',
      manualTransactionId: actualParent.parentId,
      importedTransactionId: actualParent.parentId,
    });
    current = {
      ...current,
      legacySnapshot: {
        ...current.legacySnapshot,
        transactions: [
          ...current.legacySnapshot.transactions,
          { ...current.legacySnapshot.transactions[0]!, id: 'different-imported-row', importedId: 'bank-002' },
        ],
      },
    };
    await expect(writable.reconcileSessionCompletion(actor, executed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: linked.version,
      idempotencyKey: 'ambiguous-bank-candidate',
    })).rejects.toThrow(/Ambiguous Actual reconciliation/);
    expect(writes).toHaveLength(1);
  });

  it('closes for imported candidate review before invoking an Actual write', async () => {
    const session = await saveFundedSession();
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'imported-candidate-proposal',
    });
    const approver = await addCompletionApprover(proposed, 'import-review-approver');
    const approved = await service.approveSessionCompletion(approver, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'imported-candidate-approval',
    });

    const refreshed = snapshot(20000, '2026-09-06T10:01:30.000Z', false, 15000);
    const candidate: Transaction = {
      ...importedRowFixture,
      id: 'imported-candidate-001',
      accountId: 'checking',
      date: '2026-09-06',
      payeeId: null,
      payeeName: 'Fixture shop',
      categoryId: 'food',
      categoryName: 'Food',
      amount: money('-1000'),
      cleared: true,
      reconciled: false,
      importedId: 'bank-import-001',
      importedPayee: 'Fixture shop',
      notes: null,
      tags: [],
      transferAccountId: null,
      subtransactions: [],
    };
    current = {
      ...refreshed,
      legacySnapshot: {
        ...refreshed.legacySnapshot,
        transactions: [candidate],
      },
    };

    const attempts: ManualTransactionInput[] = [];
    const mutationManager = new ConnectionManager({
      readFile: async () => JSON.stringify({
        version: 1,
        serverUrl: 'http://actual',
        budgetId: 'fixture',
        budgetName: 'Fixture',
        groupId: 'fixture',
      }),
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'fixture' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        connect: async () => [],
        selectBudget: async () => ({
          id: 'fixture',
          groupId: 'fixture',
          name: 'Fixture',
          encrypted: false,
        }),
        synchronize: async () => ({ financialSnapshot: current, snapshot: current.legacySnapshot }),
        createManualTransaction: async (input: ManualTransactionInput) => {
          attempts.push(input);
          return {
            success: false as const,
            verified: false as const,
            parentId: input.parentId,
            correlationId: input.correlationId,
            code: 'IMPORTED_CANDIDATE_REVIEW' as const,
            error: 'Fixture imported candidate requires review.',
            reviewRequired: true as const,
          };
        },
        disconnect: async () => {},
      }),
    });
    const writable = new LiquidityService({
      connectionManager: manager,
      mutationConnectionManager: mutationManager,
      store,
      native,
      clock: () => new Date(clockNow),
    });

    const result = await writable.executeSessionCompletion(actor, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: approved.version,
      idempotencyKey: 'imported-candidate-execute',
    });
    expect(result).toMatchObject({
      phase: 'closed',
      outcome: 'reconciliation_required',
      manualTransactionId: null,
      importedTransactionId: null,
    });
    expect(attempts).toHaveLength(0);
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
  });

  it.each([
    ['IMPORTED_CANDIDATE_REVIEW', 'closed'],
    ['AMBIGUOUS_IMPORTED_CANDIDATE', 'closed'],
    ['WRITE_UNCERTAIN', 'review_required'],
  ] as const)('distinguishes %s before and after Actual write attempts', async (code, phase) => {
    const session = await saveFundedSession();
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: `import-first:${code}`,
      ...(code === 'WRITE_UNCERTAIN'
        ? {
            payeeName: 'private-counterparty-sentinel',
            notes: 'private-payment-note-sentinel',
          }
        : {}),
    });
    const approver = await addCompletionApprover(proposed, `completion-approver:${code}`);
    const approved = await service.approveSessionCompletion(approver, proposed.id, {
      payloadHash: proposed.payloadHash!, expectedVersion: proposed.version,
      idempotencyKey: `import-approve:${code}`,
    });
    const attempts: ManualTransactionInput[] = [];
    const mutationManager = new ConnectionManager({
      readFile: async () => JSON.stringify({
        version: 1, serverUrl: 'http://actual', budgetId: 'fixture',
        budgetName: 'Fixture', groupId: 'fixture',
      }),
      writeFile: async () => {},
      credentialStore: {
        load: async () => ({ serverUrl: 'http://actual', secretKey: 'fixture' }),
        store: async () => {},
      },
      connectorFactory: async () => ({
        connect: async () => [],
        selectBudget: async () => ({ id: 'fixture', groupId: 'fixture', name: 'Fixture', encrypted: false }),
        synchronize: async () => ({ financialSnapshot: current, snapshot: current.legacySnapshot }),
        createManualTransaction: async (input: ManualTransactionInput) => {
          attempts.push(input);
          return {
            success: false as const, parentId: input.parentId, correlationId: input.correlationId,
            code, error: 'Fixture candidate review', reviewRequired: true as const,
          };
        },
        disconnect: async () => {},
      }),
    });
    const writable = new LiquidityService({
      connectionManager: manager, mutationConnectionManager: mutationManager,
      store, native, clock: () => new Date(clockNow),
    });
    if (code === 'WRITE_UNCERTAIN') grant(actor, 'budget', actor.budgetId, 'history', false);
    const result = await writable.executeSessionCompletion(actor, proposed.id, {
      payloadHash: proposed.payloadHash!, expectedVersion: approved.version,
      idempotencyKey: `import-execute:${code}`,
    });
    expect(result.phase).toBe(phase);
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles.map((bundle) => bundle.state))
      .toEqual(phase === 'closed' ? [] : ['initiated']);
    if (code === 'WRITE_UNCERTAIN') {
      const review = await service.sessionCompletion(actor, result.id);
      expect(review).toMatchObject({ phase: 'review_required', reviewRequired: true });
      const serializedReview = JSON.stringify([result, review]);
      expect(serializedReview).not.toContain('private-counterparty-sentinel');
      expect(serializedReview).not.toContain('private-payment-note-sentinel');
      const input = attempts[0]!;
      current = {
        ...current,
        coverage: { ...current.coverage, transactions: 'partial' },
        legacySnapshot: {
          ...current.legacySnapshot,
          transactions: [{
            ...importedRowFixture, id: input.parentId, accountId: input.accountId,
            date: input.date, amount: money(String(input.amount)),
            categoryId: input.categoryId ?? null, payeeName: null,
            importedId: null, reconciled: false, subtransactions: [],
          }],
        },
      };
      await expect(writable.reconcileSessionCompletion(actor, result.id, {
        payloadHash: proposed.payloadHash!, expectedVersion: result.version,
        idempotencyKey: 'partial-manual-parent',
      })).rejects.toThrow(/Complete account and transaction coverage/);
      expect(store.liquidity.getClaimSet({ ...actor, now }).bundles.map((bundle) => bundle.state))
        .toEqual(['initiated']);
    }
  });

  it('previews the fixture-specific exact $30 transfer without claims', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    expect(preview.plan.minimumAmount).toEqual(money('3000'));
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
    expect(store.liquidity.listTransferProposals(actor)).toEqual([]);
  });
  it('admits the original displayed plan after an unchanged refreshed capture', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    current = snapshot(20000, '2026-09-06T10:00:30.000Z');
    const proposal = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'admit',
    });
    expect(proposal.payloadHash).toBe(preview.payloadHash);
    expect(
      store.liquidity.getTransferProposal({ ...actor, proposalId: proposal.id }).payload.plan
        .snapshotId,
    ).toBe(preview.plan.snapshotId);
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles[0]?.effects[0]?.amount).toEqual(
      money('3000'),
    );
  });
  it('rejects changed material source before admitting a claim', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    current = snapshot(1000, '2026-09-06T10:00:30.000Z');
    await expect(
      service.proposeTransfer(actor, {
        previewId: preview.previewId,
        payloadHash: preview.payloadHash,
        idempotencyKey: 'changed',
      }),
    ).rejects.toThrow();
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
  });
  it('returns a generic Card for restricted actors without private source identities or hashes', async () => {
    const reader = await addMember('reader');
    for (const capability of ['conclusion', 'existence', 'name'] as const)
      for (const [resourceKind, resourceId] of [
        ['budget', reader.budgetId],
        ['category', 'food'],
        ['account', 'checking'],
      ] as const)
        grant(reader, resourceKind, resourceId, capability);
    const result = await service.evaluatePurchase(reader, purchase);
    expect(result.card).toMatchObject({
      outcome: 'insufficient_data',
      budgetFundingStatus: 'insufficient_data',
      paymentLiquidityStatus: 'insufficient_data',
      selectedAccountId: null,
      before: null,
      after: null,
      fundingPaths: [],
      evidence: [],
      cart: null,
    });
    const encoded = JSON.stringify(result);
    for (const hidden of [
      'savings',
      'Private savings',
      'checking',
      'food',
      '20000',
      '2000',
      '3000',
      'purchase',
      'payloadHash',
      'entityLabels',
      'accountAware',
      'preconditionsHash',
    ])
      expect(encoded).not.toContain(hidden);
    await expect(service.previewTransfer(reader, purchase)).rejects.toThrow();
  });
  it('returns authorized public aggregates to an aggregate-only member without private resource fields', async () => {
    const reader = await addMember('aggregate-reader');
    for (const capability of ['conclusion', 'liquidity', 'full-read'] as const)
      grant(reader, 'budget', reader.budgetId, capability, true, { aggregateOnly: true });
    const result = await service.spendability(reader);
    expect(result.fundingStatus).not.toBeNull();
    expect(result.paymentStatus).not.toBeNull();
    expect(result.accounts).toEqual([]);
    expect(result.categories).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(
      /checking|savings|Private savings|food|Food|20000|9000|2000/,
    );
  });
  it('hides global liquidity conclusions when an aggregate restriction excludes an input account', async () => {
    const reader = await addMember('restricted-aggregate-reader');
    const restrictions = { aggregateOnly: true, accountIds: ['checking'] };
    for (const capability of ['conclusion', 'liquidity', 'full-read'] as const)
      grant(reader, 'budget', reader.budgetId, capability, true, restrictions);

    const projection = await service.spendability(reader);
    expect(projection.fundingStatus).toBeNull();
    expect(projection.paymentStatus).toBeNull();
    expect(projection.accounts).toEqual([]);
    expect(projection.categories).toEqual([]);
  });

  it('denies invited observe-only actors without inherited liquidity grants', async () => {
    const observer = await addMember('observer');
    await expect(service.evaluatePurchase(observer, purchase)).rejects.toThrow();
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
  });

  it('does not substitute registered ownership for revoked full-read or account grants', async () => {
    grant(actor, 'budget', actor.budgetId, 'full-read', false);
    const withoutFullRead = await service.configuration(actor).catch(() => null);
    expect(withoutFullRead?.policy).toBeNull();

    grant(actor, 'budget', actor.budgetId, 'full-read');
    grant(actor, 'account', 'savings', 'existence', false);
    const projection = await service.spendability(actor);
    expect(projection.accounts.map(({ id }) => id)).not.toContain('savings');
    expect(JSON.stringify(projection)).not.toContain('Private savings');
  });

  it('does not provision resource grants to a newly discovered account during capture or read', async () => {
    current = snapshot(20000, '2026-09-06T10:00:00.000Z', true, 9000);
    const spendability = await service.spendability(actor);
    expect(spendability.accounts.map(({ id }) => id)).not.toContain('new-account');
    const configuration = await service.configuration(actor);
    expect(configuration.accounts.map(({ id }) => id)).not.toContain('new-account');
    expect(JSON.stringify([spendability, configuration])).not.toContain('New account');
  });

  it('does not restore departed membership sessions or previews after explicit grants to a new epoch', async () => {
    const former = await addMember('former-member');
    grantAllResources(former);
    const preview = await service.previewTransfer(former, purchase);
    current = snapshot(20000, '2026-09-06T10:00:00.000Z', false, 20000);
    await saveFundedObservations();
    const session = await service.saveSession(former, null, {
      accountId: 'checking',
      expiresAt,
      items: [{
        id: 'private-session-item',
        categoryId: 'food',
        accountId: 'checking',
        amount: money('1000'),
        purchaseAt: now,
        requiredBy: now,
      }],
    });
    const completion = await service.proposeSessionCompletion(former, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'former-completion',
    });

    clockNow = '2026-09-06T10:02:00.000Z';
    store.governance.revokeMembership({
      spaceId: former.spaceId,
      membershipId: former.membershipId,
      now: clockNow,
      auth: actorAuth(actor.actorId, clockNow),
    });
    const rejoined = await addMember('former-member');
    grantAllResources(rejoined);
    await expect(service.session(rejoined, session.id)).rejects.toThrow();
    await expect(service.proposeTransfer(rejoined, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'departed-preview',
    })).rejects.toThrow();

    grant(rejoined, 'session', session.id, 'session');
    grant(rejoined, 'transfer', preview.previewId, 'proposal');
    await expect(service.session(rejoined, session.id)).rejects.toThrow();
    await expect(service.proposeTransfer(rejoined, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'explicitly-shared-preview',
    })).rejects.toThrow();
    await expect(service.sessionCompletion(rejoined, completion.id))
      .rejects.toThrow();
    await expect(service.approveSessionCompletion(rejoined, completion.id, {
      payloadHash: completion.payloadHash!,
      expectedVersion: completion.version,
      idempotencyKey: 'rejoined-completion',
    })).rejects.toThrow();
  });

  it('retains rich cart intent and evaluates quantity, split charges, adjustments, and thresholds natively', async () => {
    const session = await service.saveSession(actor, null, {
      accountId: 'checking',
      expiresAt: '2026-09-06T12:15:00.000Z',
      items: [{
        id: 'groceries',
        categoryId: 'food',
        amount: money('800'),
        quantity: 2,
        priority: 'planned',
        categoryAllocations: [
          { categoryId: 'food', amount: money('600') },
          { categoryId: 'other', amount: money('1000') },
        ],
        priceProvenance: {
          kind: 'current_session_manual',
          observedAt: now,
          estimate: false,
        },
        barcode: '0123456789012',
        purchaseAt: purchase.purchaseAt,
        requiredBy: purchase.requiredBy,
        accountId: 'checking',
      }],
      adjustments: [
        { kind: 'tax', categoryId: 'food', amount: money('100') },
        { kind: 'fee', categoryId: 'food', amount: money('50') },
        { kind: 'discount', categoryId: 'food', amount: money('25') },
      ],
      warningThresholds: [
        { id: 'cart-warning', basis: 'cart_total', maximum: money('1500') },
      ],
    });
    expect(session.items[0]).toMatchObject({
      quantity: 2,
      priority: 'planned',
      categoryAllocations: [
        { categoryId: 'food', amount: money('600') },
        { categoryId: 'other', amount: money('1000') },
      ],
      priceProvenance: { kind: 'current_session_manual', estimate: false },
      barcode: '0123456789012',
    });
    expect(session.card.cart).toMatchObject({
      subtotal: money('1600'),
      tax: money('100'),
      fee: money('50'),
      discount: money('25'),
      total: money('1725'),
    });
    expect(session.card.warnings).toEqual([
      expect.objectContaining({
        thresholdId: 'cart-warning',
        threshold: money('1500'),
        actual: money('1725'),
        excess: money('225'),
      }),
    ]);
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
  });
  it('uses the full quantity when previewing a session transfer', async () => {
    const item = {
      id: 'bulk-groceries',
      categoryId: 'food',
      amount: money('2000'),
      quantity: 2,
      purchaseAt: purchase.purchaseAt,
      requiredBy: purchase.requiredBy,
      accountId: 'checking',
    };
    current = snapshot();
    current.liquidity!.categories = current.liquidity!.categories.map((category) =>
      category.categoryId === 'food'
        ? { ...category, availability: money('4000') }
        : category,
    );

    const session = await service.saveSession(actor, null, {
      accountId: 'checking',
      expiresAt: '2026-09-06T12:15:00.000Z',
      items: [item],
    });
    const cardPath = session.card.fundingPaths.find(
      (path) => path.kind === 'account_transfer',
    );
    if (!cardPath || cardPath.kind !== 'account_transfer')
      throw new Error('Expected a session account-transfer funding path');
    const preview = await service.previewTransfer(actor, {
      kind: 'session',
      sessionId: session.id,
      expectedSessionVersion: session.version,
      purchaseItemId: item.id,
    });
    expect(preview.plan.minimumAmount).toEqual(cardPath.minimumAmount);
  });
  it('blocks a transfer preview for an unfunded quantity-expanded session', async () => {
    const item = {
      id: 'underfunded-bulk-groceries',
      categoryId: 'food',
      amount: money('2000'),
      quantity: 2,
      purchaseAt: purchase.purchaseAt,
      requiredBy: purchase.requiredBy,
      accountId: 'checking',
    };
    const session = await service.saveSession(actor, null, {
      accountId: 'checking',
      expiresAt: '2026-09-06T12:15:00.000Z',
      items: [item],
    });
    expect(session.card.outcome).not.toBe('safe_after_date');
    await expect(
      service.previewTransfer(actor, {
        kind: 'session',
        sessionId: session.id,
        expectedSessionVersion: session.version,
        purchaseItemId: item.id,
      }),
    ).rejects.toThrow();
  });

  it('jointly evaluates unreserved manual sessions and keeps reallocation cash neutral', async () => {
    const items = ['one', 'two'].map((id) => ({
      id,
      categoryId: 'food',
      amount: money('1500'),
      purchaseAt: purchase.purchaseAt,
      requiredBy: purchase.requiredBy,
      accountId: 'checking',
    }));
    const session = await service.saveSession(actor, null, {
      accountId: 'checking',
      expiresAt: '2026-09-06T12:15:00.000Z',
      items,
    });
    expect(session.card.items?.map((item) => item.budgetFundingStatus)).toEqual([
      'funded',
      'unfunded',
    ]);
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
    const before = await service.spendability(actor);
    const after = await service.previewReallocation(actor, {
      moves: [
        {
          id: 'move',
          sourceCategoryId: 'food',
          destinationCategoryId: 'other',
          amount: money('1000'),
        },
      ],
    });
    expect(after.accounts.map((a) => a.balance)).toEqual(before.accounts.map((a) => a.balance));
    expect(after.categories.find((c) => c.id === 'other')?.availabilityAfter).toEqual(
      money('1000'),
    );
  });
  it('acknowledges user initiation without treating it as settlement or releasing holds', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    const p = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'propose',
    });
    const approver = await addTransferApprover(p.id, 'transfer-approver');
    const approved = await service.transferAction(approver, p.id, 'approve', {
      payloadHash: preview.payloadHash,
      expectedVersion: p.version,
      idempotencyKey: 'approve',
    });
    const initiated = await service.transferAction(actor, p.id, 'report-initiated', {
      payloadHash: preview.payloadHash,
      expectedVersion: approved.version,
      idempotencyKey: 'initiate',
    });
    expect(initiated).toMatchObject({
      phase: 'initiated',
      sourceObserved: false,
      destinationObserved: false,
      reconciled: false,
    });
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles[0]?.state).toBe('initiated');
  });
  it('projects findings as current redacted conclusions and denies stale actors', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    const proposal = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'finding-proposal',
    });
    const privateSourceMarker = 'PRIVATE-SOURCE-MARKER-9d7c';
    const provenance = store.liquidity.getTransferProposal({
      ...actor,
      proposalId: proposal.id,
    });
    const requiredBy = proposal.plan.requiredBy;
    const finding = await store.createFinding({
      budgetId: actor.budgetId,
      classification: 'transfer_needs_attention',
      description: privateSourceMarker,
      evidence: {
        transferId: proposal.id,
        transferConclusion: {
          minimumAmount: money('999999'),
          requiredBy: '2026-10-01T00:00:00.000Z',
          authorizedHolderRequired: false,
        },
        spaceId: provenance.spaceId,
        requesterMembershipId: provenance.requesterMembershipId,
        governancePolicyVersion: provenance.governancePolicyVersion,
        privateSourceMarker,
      },
      actorId: provenance.actorId,
    });
    const initial = LiquidityProjector.projectFinding(store, actor, finding);
    expect(initial?.transferConclusion).toMatchObject({
      minimumAmount: proposal.plan.minimumAmount,
      requiredBy,
      authorizedHolderRequired: false,
    });
    expect(JSON.stringify(initial)).not.toContain(privateSourceMarker);

    const aggregateReader = await addMember('aggregate-finding-reader');
    grant(aggregateReader, 'budget', aggregateReader.budgetId, 'conclusion', true, {
      aggregateOnly: true,
    });
    const aggregateConclusion = LiquidityProjector.projectFinding(store, aggregateReader, finding);
    expect(aggregateConclusion?.transferConclusion).toEqual({
      minimumAmount: proposal.plan.minimumAmount,
      requiredBy: proposal.plan.requiredBy,
      authorizedHolderRequired: true,
    });
    expect(aggregateConclusion?.transferConclusion).not.toHaveProperty('estimatedArrival');
    const encodedConclusion = JSON.stringify(aggregateConclusion);
    const planAccountIds = proposal.plan.legs.flatMap(({ sourceAccountId, destinationAccountId }) => [
      sourceAccountId,
      destinationAccountId,
    ]);
    for (const hidden of [...planAccountIds, '20000', '9000', privateSourceMarker])
      expect(encodedConclusion).not.toContain(hidden);
    const sourceAccountId = proposal.plan.legs[0]!.sourceAccountId;
    const allowedAccountIds = [...new Set(planAccountIds)].filter((id) => id !== sourceAccountId);
    grant(aggregateReader, 'budget', aggregateReader.budgetId, 'conclusion', true, {
      aggregateOnly: true,
      accountIds: allowedAccountIds,
    });
    expect(LiquidityProjector.projectFinding(store, aggregateReader, finding)).toBeNull();
    grant(aggregateReader, 'budget', aggregateReader.budgetId, 'conclusion', false);
    expect(LiquidityProjector.projectFinding(store, aggregateReader, finding)).toBeNull();

    grant(actor, 'account', 'savings', 'proposal', false);
    const redacted = LiquidityProjector.projectFinding(store, actor, finding);
    expect(redacted?.transferConclusion).toMatchObject({
      minimumAmount: proposal.plan.minimumAmount,
      requiredBy,
      authorizedHolderRequired: true,
    });
    expect(redacted?.transferConclusion?.estimatedArrival).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain(privateSourceMarker);

    expect(LiquidityProjector.projectFinding(store, {
      ...actor,
      membershipId: 'stale-membership-period',
    }, finding)).toBeNull();
    expect(LiquidityProjector.projectFinding(store, {
      ...actor,
      auth: actorAuth('different-actor'),
    }, finding)).toBeNull();
  });
  it('persists an approved category route while explicit selection remains authoritative', async () => {
    const saved = await service.savePreference(actor, {
      categoryId: 'food',
      accountId: 'checking',
      expectedVersion: 0,
      expiresAt,
    });
    expect(saved.items).toMatchObject([{ categoryId: 'food', accountId: 'checking', version: 1 }]);
    expect((await service.preferences(actor)).items).toEqual(saved.items);
    const { accountId: _accountId, ...unselected } = purchase;
    expect((await service.evaluatePurchase(actor, unselected)).card).toMatchObject({
      selectedAccountId: 'checking',
      selectionSource: 'approved_preference',
    });
    expect(
      (await service.evaluatePurchase(actor, { ...purchase, accountId: 'savings' })).card,
    ).toMatchObject({
      selectedAccountId: 'savings',
      selectionSource: 'explicit',
    });
    await expect(
      service.savePreference(actor, {
        categoryId: 'food',
        accountId: 'savings',
        expectedVersion: 0,
        expiresAt,
      }),
    ).rejects.toThrow(/version|conflict/i);
  });
  it('retains expired preference versions for explicit renewal without using the expired route', async () => {
    const preferenceExpiry = '2026-09-06T10:02:00.000Z';
    await service.savePreference(actor, {
      categoryId: 'food',
      accountId: 'checking',
      expectedVersion: 0,
      expiresAt: preferenceExpiry,
    });
    clockNow = '2026-09-06T10:03:00.000Z';
    expect((await service.preferences(actor)).items).toMatchObject([
      { version: 1, accountId: 'checking', expiresAt: preferenceExpiry },
    ]);
    const { accountId: _accountId, ...unselected } = purchase;
    expect((await service.evaluatePurchase(actor, unselected)).card.selectionSource).not.toBe(
      'approved_preference',
    );
    const renewed = await service.savePreference(actor, {
      categoryId: 'food',
      accountId: 'checking',
      expectedVersion: 1,
      expiresAt,
    });
    expect(renewed.items).toMatchObject([{ version: 2, accountId: 'checking', expiresAt }]);
    expect((await service.evaluatePurchase(actor, unselected)).card.selectionSource).toBe(
      'approved_preference',
    );
  });
  it.each([
    { resourceKind: 'account' as const, resourceId: 'checking', capability: 'balance' as const },
    { resourceKind: 'account' as const, resourceId: 'checking', capability: 'history' as const },
    { resourceKind: 'account' as const, resourceId: 'savings', capability: 'existence' as const },
    { resourceKind: 'category' as const, resourceId: 'food', capability: 'existence' as const },
  ])(
    'withholds observation fields after related $resourceId $capability revocation',
    async (revoked) => {
      const facts = store.liquidity.getSupplementalFacts({ ...actor, now })!;
      store.liquidity.saveSupplementalFacts({
        ...actor,
        expectedVersion: facts.version,
        now,
        expiresAt,
        observations: facts.observations.map((observation) =>
          observation.accountId === 'checking'
            ? {
                ...observation,
                credit: {
                  authorizationAvailable: money('1000'),
                  pendingIncludedInAuthorization: true,
                  paymentAccountId: 'savings',
                  paymentCategoryId: 'food',
                  dueAt: '2026-09-07T00:00:00.000Z',
                  reservedCash: money('100'),
                  economicObligationId: 'payment',
                },
              }
            : observation,
        ),
      });
      grant(actor, revoked.resourceKind, revoked.resourceId, revoked.capability, false);
      expect(
        (await service.configuration(actor)).observations.map(
          (observation) => observation.accountId,
        ),
      ).not.toContain('checking');
    },
  );
  it('rejects observation replacement that removes an account outside current policy authority', async () => {
    grant(actor, 'account', 'savings', 'policy', false);
    await expect(
      service.saveObservations(actor, {
        expectedVersion: 1,
        expiresAt,
        observations: [
          {
            accountId: 'checking',
            currentLedgerConfirmed: true,
            kind: 'cash',
            currency: 'USD',
            owned: true,
            holds: money('0'),
          },
        ],
      }),
    ).rejects.toThrow(/authoriz/i);
    expect(
      store.liquidity
        .getSupplementalFacts({ ...actor, now })
        ?.observations.map((observation) => observation.accountId),
    ).toContain('savings');
  });
  it('rejects policy replacement that removes an account outside current policy authority', async () => {
    const policy = (await service.configuration(actor)).policy!;
    grant(actor, 'account', 'savings', 'policy', false);
    await expect(
      saveLiquidityPolicy({
        expectedVersion: policy.version,
        expiresAt: policy.expiresAt,
        accounts: policy.accounts
          .filter((account) => account.accountId !== 'savings')
          .map(({ resourceScope: _resourceScope, ...account }) => account),
        transferRoutes: [],
        approvalPolicy: { minimumApprovers: 1 },
      }),
    ).rejects.toThrow(/authoriz/i);
  });
  it('admits and approves the immutable preview after trusted wall time advances', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    clockNow = '2026-09-06T10:01:01.000Z';
    const proposal = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'later-admission',
    });
    clockNow = '2026-09-06T10:01:02.000Z';
    const approver = await addTransferApprover(proposal.id, 'later-transfer-approver');
    const approved = await service.transferAction(approver, proposal.id, 'approve', {
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      idempotencyKey: 'later-approval',
    });
    expect(approved.phase).toBe('approved');
  });
  it('persists expired proposal state on production capture', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    const proposal = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'expiring-proposal',
    });
    clockNow = new Date(Date.parse(preview.plan.expiresAt) + 1).toISOString();
    expect((await service.transfer(actor, proposal.id)).outcome).toBe('expired');
    expect(
      store.liquidity.getTransferProposal({ ...actor, proposalId: proposal.id }).state.outcome,
    ).toBe('expired');
  });
  it.each(['instructions', 'report-initiated'])(
    'persists changed-source-evidence revalidation before %s and supersedes stale approvals',
    async (action) => {
      const preview = await service.previewTransfer(actor, purchase);
      const proposal = await service.proposeTransfer(actor, {
        previewId: preview.previewId,
        payloadHash: preview.payloadHash,
        idempotencyKey: `${action}-proposal`,
      });
      const approver = await addTransferApprover(proposal.id, `${action}-transfer-approver`);
      const approved = await service.transferAction(approver, proposal.id, 'approve', {
        payloadHash: proposal.payloadHash,
        expectedVersion: proposal.version,
        idempotencyKey: `${action}-approval`,
      });
      current = snapshot(0);
      await service
        .transferAction(actor, proposal.id, action, {
          payloadHash: approved.payloadHash,
          expectedVersion: approved.version,
          idempotencyKey: `${action}-changed`,
        })
        .catch(() => undefined);
      const rechecked = await service.transfer(actor, proposal.id);
      expect(rechecked.outcome).toBe('reconciliation_required');
      expect(rechecked.approvalCount).toBe(0);
      expect(rechecked.canGetInstructions).toBe(false);
      expect(rechecked.phase).toBe(action === 'instructions' ? 'proposed' : 'initiated');
      if (action === 'report-initiated')
        expect(store.liquidity.getClaimSet({ ...actor, now }).bundles[0]?.state).toBe('initiated');
    },
  );
  it.each([undefined, now])(
    'requires an explicit future purchase instant before persisting a transfer preview (%s)',
    async (purchaseAt) => {
      const policy = (await service.configuration(actor)).policy!;
      await saveLiquidityPolicy({
        expectedVersion: policy.version,
        expiresAt: policy.expiresAt,
        accounts: policy.accounts.map(({ resourceScope: _scope, ...account }) => account),
        transferRoutes: policy.transferRoutes.map(({ evidence: _evidence, ...route }) => ({
          ...route,
          providerArrivalAt: now,
        })),
        approvalPolicy: { minimumApprovers: 1 },
      });
      const immediate = { ...purchase, purchaseAt, requiredBy: purchaseAt };
      const evaluation = await service.evaluatePurchase(actor, immediate);
      expect(evaluation.card).toMatchObject({
        budgetFundingStatus: 'funded',
        paymentLiquidityStatus: 'transfer_required',
        fundingPaths: expect.arrayContaining([
          expect.objectContaining({
            kind: 'account_transfer',
            minimumAmount: money('3000'),
          }),
        ]),
      });
      await expect(service.previewTransfer(actor, immediate)).rejects.toThrow();
      const Database = createRequire(
        createRequire(import.meta.url).resolve('@balanceframe/workflow-store'),
      )('better-sqlite3');
      const database = new Database(join(directory, 'workflow.sqlite'), { readonly: true });
      try {
        expect(database.prepare('SELECT COUNT(*) AS count FROM transfer_previews').get()).toEqual({
          count: 0,
        });
      } finally {
        database.close();
      }
    },
  );
  it('confirms reconciled imported pairs with partial metadata only after complete account enumeration evidence', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    const proposal = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'partial-collection-proposal',
    });
    const approver = await addTransferApprover(proposal.id, 'partial-collection-approver');
    const approved = await service.transferAction(approver, proposal.id, 'approve', {
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      idempotencyKey: 'partial-collection-approval',
    });
    await service.transferAction(actor, proposal.id, 'report-initiated', {
      payloadHash: approved.payloadHash,
      expectedVersion: approved.version,
      idempotencyKey: 'partial-collection-initiation',
    });
    clockNow = '2026-09-06T11:01:00.000Z';
    current = snapshot(17000, clockNow, false, 12000);
    current = {
      ...current,
      coverage: { ...current.coverage, accounts: 'partial', transactions: 'complete' },
    };
    settlementRecords = [
      {
        id: 'settled-source',
        accountId: 'savings',
        amount: money('-3000'),
        observedAt: clockNow,
        occurredAt: '2026-09-06T11:00:00.000Z',
        importedId: 'bank-source',
        providerReference: null,
        pairId: 'bank-pair',
        reconciled: true,
        reversed: false,
        provenance: 'actual_import',
      },
      {
        id: 'settled-destination',
        accountId: 'checking',
        amount: money('3000'),
        observedAt: clockNow,
        occurredAt: '2026-09-06T11:00:00.000Z',
        importedId: 'bank-destination',
        providerReference: null,
        pairId: 'bank-pair',
        reconciled: true,
        reversed: false,
        provenance: 'actual_import',
      },
    ];
    expect((await service.transfer(actor, proposal.id)).phase).toBe('initiated');
    current.observations = [
      {
        kind: 'account_collection_coverage',
        scope: { kind: 'global' },
        state: 'unknown',
        observedAt: null,
        evidence: [],
      },
    ];
    expect((await service.transfer(actor, proposal.id)).phase).toBe('initiated');
    current.observations = [
      {
        kind: 'account_collection_coverage',
        scope: { kind: 'global' },
        state: 'complete',
        observedAt: clockNow,
        evidence: [],
      },
    ];
    const read = await service.transfer(actor, proposal.id);
    expect(read.phase).toBe('initiated');
    expect(store.liquidity.getClaimSet({ ...actor, now: clockNow }).bundles)
      .toContainEqual(expect.objectContaining({ id: proposal.id, state: 'initiated' }));
    const reconciled = await service.transferAction({
      ...actor,
      now: clockNow,
      auth: actorAuth(actor.actorId, clockNow),
    }, proposal.id, 'reconcile', {
      payloadHash: read.payloadHash!,
      expectedVersion: read.version,
      idempotencyKey: 'partial-collection-explicit-reconcile',
    });
    expect(reconciled).toMatchObject({
      phase: 'confirmed',
      sourceObserved: true,
      destinationObserved: true,
      reconciled: true,
    });
    expect(store.liquidity.getClaimSet({ ...actor, now: clockNow }).bundles).toEqual([]);
  });
  it.each(['flow-match', 'transfer', 'obligation-match', 'unresolved'])(
    'withholds and preserves observations containing inaccessible %s history references',
    async (reference) => {
      current.legacySnapshot.transactions = [
        {
          id: 'private-transaction',
          accountId: 'savings',
          date: '2026-09-06',
          payeeId: null,
          payeeName: null,
          categoryId: 'food',
          categoryName: 'Food',
          amount: money('-100'),
          cleared: true,
          reconciled: true,
          importedId: 'private-import',
          importedPayee: null,
          notes: null,
          tags: [],
          transferAccountId: null,
          subtransactions: [],
        },
      ];
      const facts = store.liquidity.getSupplementalFacts({ ...actor, now })!;
      const observations = facts.observations.map((observation) =>
        observation.accountId !== 'checking'
          ? observation
          : {
              ...observation,
              unsettledFlows:
                reference === 'obligation-match'
                  ? []
                  : [
                      {
                        id: 'pending',
                        economicObligationId: 'pending',
                        direction: 'outflow' as const,
                        amount: money('100'),
                        includedInBalance: false,
                        matchedTransactionIds:
                          reference === 'flow-match' ? ['private-transaction'] : [],
                        scheduleId: null,
                        transferTransactionId:
                          reference === 'transfer'
                            ? 'private-transaction'
                            : reference === 'unresolved'
                              ? 'missing-transaction'
                              : null,
                        importedId: null,
                        reconciled: false,
                        provenance: 'manual_ledger' as const,
                      },
                    ],
              obligations:
                reference === 'obligation-match'
                  ? [
                      {
                        id: 'obligation',
                        economicObligationId: 'obligation',
                        categoryId: 'food',
                        amount: money('100'),
                        dueAt: purchase.requiredBy,
                        paid: false,
                        includedInBalance: false,
                        matchedTransactionIds: ['private-transaction'],
                      },
                    ]
                  : [],
            },
      );
      store.liquidity.saveSupplementalFacts({
        ...actor,
        expectedVersion: facts.version,
        now,
        expiresAt,
        observations,
      });
      if (reference !== 'unresolved')
        grant(actor, 'account', 'savings', 'history', false);
      expect(
        (await service.configuration(actor)).observations.map(
          (observation) => observation.accountId,
        ),
      ).not.toContain('checking');
      await expect(
        service.saveObservations(actor, {
          expectedVersion: facts.version + 1,
          expiresAt,
          observations: [],
        }),
      ).rejects.toThrow();
      expect(
        store.liquidity
          .getSupplementalFacts({ ...actor, now })
          ?.observations.map((observation) => observation.accountId),
      ).toContain('checking');
    },
  );
  it('rejects whole-document replacement when existing history references cannot be authorized', async () => {
    const facts = store.liquidity.getSupplementalFacts({ ...actor, now })!;
    store.liquidity.saveSupplementalFacts({
      ...actor,
      expectedVersion: facts.version,
      now,
      expiresAt,
      observations: facts.observations.map((observation) =>
        observation.accountId !== 'checking'
          ? observation
          : {
              ...observation,
              obligations: [
                {
                  id: 'pending',
                  economicObligationId: 'pending',
                  categoryId: 'food',
                  amount: money('100'),
                  dueAt: purchase.requiredBy,
                  paid: false,
                  includedInBalance: false,
                  matchedTransactionIds: ['missing-history-reference'],
                },
              ],
            },
      ),
    });
    await expect(
      service.saveObservations(actor, {
        expectedVersion: facts.version + 1,
        expiresAt,
        observations: [],
      }),
    ).rejects.toThrow();
    expect((await service.configuration(actor)).observationVersion).toBe(facts.version + 1);
  });
  it('settles an authorized initiation report only through imported proof captured after approval', async () => {
    const arrival = '2026-09-06T10:02:00.000Z';
    const policy = (await service.configuration(actor)).policy!;
    await saveLiquidityPolicy({
      expectedVersion: policy.version,
      expiresAt: policy.expiresAt,
      accounts: policy.accounts.map(({ resourceScope: _scope, ...account }) => account),
      transferRoutes: policy.transferRoutes.map(({ evidence: _evidence, ...route }) => ({
        ...route,
        providerArrivalAt: arrival,
      })),
      approvalPolicy: { minimumApprovers: 1 },
    });
    const preview = await service.previewTransfer(actor, purchase);
    const proposal = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'already-transferred-proposal',
    });
    const approver = await addTransferApprover(proposal.id, 'settlement-approver');
    const approved = await service.transferAction(approver, proposal.id, 'approve', {
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      idempotencyKey: 'already-transferred-approval',
    });
    clockNow = '2026-09-06T10:03:00.000Z';
    current = snapshot(17000, clockNow, false, 12000);
    current.coverage.transactions = 'complete';
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
    const command = {
      payloadHash: approved.payloadHash,
      expectedVersion: approved.version,
      idempotencyKey: 'already-transferred-report',
    };
    expect(
      await service.transferAction(actor, proposal.id, 'report-initiated', command),
    ).toMatchObject({
      phase: 'confirmed',
      sourceObserved: true,
      destinationObserved: true,
      reconciled: true,
    });
    expect(
      (await service.transferAction(actor, proposal.id, 'report-initiated', command)).phase,
    ).toBe('confirmed');
    expect(store.liquidity.getClaimSet({ ...actor, now: clockNow }).bundles).toEqual([]);
  });
  it('keeps approval controls available to a current human before password control, without approving by session alone', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    const transfer = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'ordinary-session-transfer',
    });
    const transferApprover = await addTransferApprover(transfer.id, 'ordinary-transfer-approver');
    const ordinaryTransferApprover = {
      ...transferApprover,
      auth: {
        method: 'session' as const,
        actorId: transferApprover.actorId,
        sessionId: `session:${transferApprover.actorId}`,
      },
    };
    expect((await service.transfer(ordinaryTransferApprover, transfer.id)).canApprove).toBe(true);
    await expect(service.transferAction(ordinaryTransferApprover, transfer.id, 'approve', {
      payloadHash: transfer.payloadHash,
      expectedVersion: transfer.version,
      idempotencyKey: 'ordinary-session-transfer-approval',
    })).rejects.toThrow();

    const session = await saveFundedSession();
    const completion = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'ordinary-session-completion',
    });
    const completionApprover = await addCompletionApprover(completion, 'ordinary-completion-approver');
    const ordinaryCompletionApprover = {
      ...completionApprover,
      auth: {
        method: 'session' as const,
        actorId: completionApprover.actorId,
        sessionId: `session:${completionApprover.actorId}`,
      },
    };
    expect((await service.sessionCompletion(ordinaryCompletionApprover, completion.id)).canApprove).toBe(true);
    await expect(service.approveSessionCompletion(ordinaryCompletionApprover, completion.id, {
      payloadHash: completion.payloadHash!,
      expectedVersion: completion.version,
      idempotencyKey: 'ordinary-session-completion-approval',
    })).rejects.toThrow(/Fresh human-session authorization required/);
  });
  it('does not settle captured transfer evidence during reads without fresh human control', async () => {
    const arrival = '2026-09-06T10:02:00.000Z';
    const policy = (await service.configuration(actor)).policy!;
    await saveLiquidityPolicy({
      expectedVersion: policy.version,
      expiresAt: policy.expiresAt,
      accounts: policy.accounts.map(({ resourceScope: _scope, ...account }) => account),
      transferRoutes: policy.transferRoutes.map(({ evidence: _evidence, ...route }) => ({
        ...route,
        providerArrivalAt: arrival,
      })),
      approvalPolicy: { minimumApprovers: 1 },
    });
    const preview = await service.previewTransfer(actor, purchase);
    const proposal = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'read-reconciliation-transfer',
    });
    const approver = await addTransferApprover(proposal.id, 'read-reconciliation-approver');
    const approved = await service.transferAction(approver, proposal.id, 'approve', {
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      idempotencyKey: 'read-reconciliation-approval',
    });
    const initiated = await service.transferAction(actor, proposal.id, 'report-initiated', {
      payloadHash: approved.payloadHash,
      expectedVersion: approved.version,
      idempotencyKey: 'read-reconciliation-initiation',
    });
    expect(initiated.phase).toBe('initiated');

    clockNow = '2026-09-06T10:03:00.000Z';
    current = snapshot(17000, clockNow, false, 12000);
    current.coverage.transactions = 'complete';
    settlementRecords = [
      {
        id: 'read-source-proof',
        accountId: 'savings',
        amount: money('-3000'),
        observedAt: clockNow,
        occurredAt: arrival,
        importedId: 'read-bank-source',
        providerReference: null,
        pairId: 'read-bank-pair',
        reconciled: true,
        reversed: false,
        provenance: 'actual_import',
      },
      {
        id: 'read-destination-proof',
        accountId: 'checking',
        amount: money('3000'),
        observedAt: clockNow,
        occurredAt: arrival,
        importedId: 'read-bank-destination',
        providerReference: null,
        pairId: 'read-bank-pair',
        reconciled: true,
        reversed: false,
        provenance: 'actual_import',
      },
    ];
    const ordinarySession = {
      ...actor,
      now: clockNow,
      auth: {
        method: 'session' as const,
        actorId: actor.actorId,
        sessionId: `session:${actor.actorId}`,
      },
    };
    expect((await service.transfer(ordinarySession, proposal.id)).phase).toBe('initiated');
    const staleHuman = {
      ...actor,
      now: clockNow,
      auth: actorAuth(actor.actorId, '2026-09-06T09:57:59.999Z'),
    };
    expect((await service.transfer(staleHuman, proposal.id)).phase).toBe('initiated');
    expect(store.liquidity.getClaimSet({ ...actor, now: clockNow }).bundles)
      .toMatchObject([{ id: proposal.id, state: 'initiated' }]);

    const freshHuman = {
      ...actor,
      now: clockNow,
      auth: actorAuth(actor.actorId, clockNow),
    };
    expect(await service.transferAction(freshHuman, proposal.id, 'reconcile', {
      payloadHash: initiated.payloadHash,
      expectedVersion: initiated.version,
      idempotencyKey: 'fresh-human-actual-transfer-settlement',
    })).toMatchObject({
      phase: 'confirmed',
      sourceObserved: true,
      destinationObserved: true,
      reconciled: true,
    });
    expect(store.liquidity.getClaimSet({ ...actor, now: clockNow }).bundles).toEqual([]);
  });
  it('creates a real space-scoped transfer notice from current governance grants', async () => {
    const recipientId = 'notification-only-grant-recipient';
    await store.upsertActorMembership(recipientId, 'active', [], '');
    const membership = store.governance.addMembership({
      spaceId: actor.spaceId,
      actorId: recipientId,
      validFrom: clockNow,
      now: clockNow,
      auth: actorAuth(actor.actorId, clockNow),
    });
    const recipient = {
      ...actor,
      actorId: recipientId,
      membershipId: membership.id,
      auth: actorAuth(recipientId, clockNow),
    };
    grant(recipient, 'budget', actor.budgetId, 'conclusion', true, { aggregateOnly: true });
    grant(recipient, 'budget', actor.budgetId, 'notification:receive');
    const notificationPolicy: NotificationPolicy = {
      policyVersion: 'transfer-notification-policy',
      eligibility: [{
        classifications: ['transfer_needs_attention'],
        minSeverity: 'normal',
        requiredCapability: 'notification:receive',
        requiredScope: `budget:${actor.budgetId}`,
      }],
      recipients: [{ actorId: recipientId, channels: ['in_app'], quietHours: null }],
      channels: [{ type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In app' }],
      redaction: { restricted: { visibleFields: ['title', 'summary'] } },
      maxRetries: 3,
      defaultRedactionClass: 'restricted',
    };
    await store.saveNotificationPolicy({
      spaceId: actor.spaceId,
      policyKey: 'notification',
      policyVersion: notificationPolicy.policyVersion,
      policy: { ...notificationPolicy },
    });

    const preview = await service.previewTransfer(actor, purchase);
    const proposal = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'notice-transfer',
    });
    const approver = await addTransferApprover(proposal.id, 'notice-transfer-approver');
    const approved = await service.transferAction(approver, proposal.id, 'approve', {
      payloadHash: proposal.payloadHash,
      expectedVersion: proposal.version,
      idempotencyKey: 'notice-transfer-approval',
    });
    current = snapshot(12000, '2026-09-06T10:01:30.000Z');
    clockNow = '2026-09-06T10:01:30.000Z';
    const initiated = await service.transferAction(actor, proposal.id, 'report-initiated', {
      payloadHash: approved.payloadHash,
      expectedVersion: approved.version,
      idempotencyKey: 'notice-transfer-initiation-after-change',
    });
    expect(initiated).toMatchObject({ phase: 'initiated', outcome: 'reconciliation_required' });

    const outbox = await store.listOutboxRecords();
    expect(outbox).toHaveLength(1);
    const event = await store.getNotificationEvent(outbox[0]!.eventId);
    const findings = await store.listFindings({
      budgetId: actor.budgetId,
      classification: 'transfer_needs_attention',
    });
    expect(findings).toHaveLength(1);
    expect(event).toMatchObject({
      recipientId,
      recipientMembershipId: membership.id,
      spaceId: actor.spaceId,
      correlationId: `liquidity-finding:${findings[0]!.id}`,
    });
  });
  it('keeps own-account bank identifiers readable and writable despite same-text private imports', async () => {
    current.legacySnapshot.transactions = ['checking', 'savings'].map((accountId) => ({
      id: `${accountId}-row`,
      accountId,
      date: '2026-09-06',
      payeeId: null,
      payeeName: null,
      categoryId: 'food',
      categoryName: 'Food',
      amount: money('-100'),
      cleared: true,
      reconciled: true,
      importedId: 'shared-bank-id',
      importedPayee: null,
      notes: null,
      tags: [],
      transferAccountId: null,
      subtransactions: [],
    }));
    const facts = store.liquidity.getSupplementalFacts({ ...actor, now })!;
    store.liquidity.saveSupplementalFacts({
      ...actor,
      expectedVersion: facts.version,
      now,
      expiresAt,
      observations: facts.observations
        .filter((observation) => observation.accountId === 'checking')
        .map((observation) => ({
          ...observation,
          unsettledFlows: [
            {
              id: 'own-pending',
              economicObligationId: 'own-pending',
              direction: 'outflow',
              amount: money('100'),
              includedInBalance: false,
              matchedTransactionIds: ['shared-bank-id'],
              scheduleId: null,
              transferTransactionId: null,
              importedId: 'shared-bank-id',
              reconciled: false,
              provenance: 'manual_ledger',
            },
          ],
        })),
    });
    grant(actor, 'account', 'savings', 'history', false);
    expect((await service.configuration(actor)).observations).toMatchObject([
      {
        accountId: 'checking',
        unsettledFlows: [
          { importedId: 'shared-bank-id', matchedTransactionIds: ['shared-bank-id'] },
        ],
      },
    ]);
    expect(
      (
        await service.saveObservations(actor, {
          expectedVersion: facts.version + 1,
          expiresAt,
          observations: [],
        })
      ).observationVersion,
    ).toBe(facts.version + 2);
  });
  it('projects captured transfer authority and only original-period eligible human votes', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    const proposed = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'transfer-metadata-proposal',
    });
    const peer = await addTransferApprover(proposed.id, 'metadata-transfer-peer');
    const approved = await service.transferAction(peer, proposed.id, 'approve', {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'transfer-metadata-approval',
    });
    const persisted = store.liquidity.getTransferProposal({ ...actor, proposalId: proposed.id, now: clockNow });
    expect(approved).toMatchObject({
      expiresAt: persisted.expiresAt,
      approvalMetadata: {
        requesterActorId: actor.actorId,
        requesterMembershipId: actor.membershipId,
        governancePolicyVersion: persisted.governancePolicyVersion,
        financialPolicyVersion: persisted.policyVersion,
        approvers: [{ actorId: peer.actorId, issuedAt: now, expiresAt: persisted.expiresAt }],
      },
    });

    clockNow = '2026-09-06T10:02:00.000Z';
    store.governance.revokeMembership({
      spaceId: actor.spaceId, membershipId: peer.membershipId, now: clockNow,
      auth: actorAuth(actor.actorId, clockNow),
    });
    const rejoined = await addTransferApprover(proposed.id, peer.actorId);
    expect(rejoined.membershipId).not.toBe(peer.membershipId);
    expect(await service.transfer(rejoined, proposed.id)).toMatchObject({
      approvalCount: 0,
      approvalMetadata: { requesterActorId: actor.actorId, approvers: [] },
    });
    grant(rejoined, 'account', 'savings', 'balance', false);
    await expect(service.transfer(rejoined, proposed.id)).rejects.toThrow('Resource authorization denied');
  });

  it('projects captured completion authority without reviving a departed human vote', async () => {
    const session = await saveFundedSession();
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'completion-metadata-proposal',
    });
    const peer = await addCompletionApprover(proposed, 'metadata-completion-peer');
    const approved = await service.approveSessionCompletion(peer, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'completion-metadata-approval',
    });
    const persisted = store.liquidity.getSessionCompletionProposal({
      ...actor, proposalId: proposed.id, now: clockNow,
    });
    expect(approved).toMatchObject({
      approvalMetadata: {
        requesterActorId: actor.actorId,
        requesterMembershipId: actor.membershipId,
        governancePolicyVersion: persisted.governancePolicyVersion,
        financialPolicyVersion: persisted.policyVersion,
        approvers: [{ actorId: peer.actorId, issuedAt: now, expiresAt: persisted.expiresAt }],
      },
    });
    clockNow = '2026-09-06T10:02:00.000Z';
    store.governance.revokeMembership({
      spaceId: actor.spaceId, membershipId: peer.membershipId, now: clockNow,
      auth: actorAuth(actor.actorId, clockNow),
    });
    const rejoined = await addCompletionApprover(proposed, peer.actorId);
    expect(await service.sessionCompletion(rejoined, proposed.id)).toMatchObject({
      approvalCount: 0,
      approvalMetadata: { requesterActorId: actor.actorId, approvers: [] },
    });
    expect(store.liquidity.getClaimSet({ ...actor, now: clockNow }).bundles).toMatchObject([
      { state: 'active' },
    ]);
  });
});
