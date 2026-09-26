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
import { LiquidityService } from '../src/liquidity-service.js';
import { LiquidityProjector } from '../src/liquidity-projector.js';

const native = createRequire(import.meta.url)('@balanceframe/native');
const now = '2026-09-06T10:01:00.000Z';
const expiresAt = '2026-09-06T10:15:00.000Z';
const actor = { actorId: 'holder', budgetId: 'fixture' };
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

describe('authoritative application liquidity service', () => {
  let store: SqliteWorkflowStore;
  let directory: string;
  let service: LiquidityService;
  let manager: ConnectionManager;
  let current = snapshot();
  let clockNow = now;
  let advanceDuringSync: string | null = null;
  let settlementRecords: TransferSettlementRecord[] | undefined;
  beforeEach(async () => {
    current = snapshot();
    clockNow = now;
    advanceDuringSync = null;
    settlementRecords = undefined;
    directory = mkdtempSync(join(tmpdir(), 'liquidity-service-'));
    store = new SqliteWorkflowStore(join(directory, 'workflow.sqlite'));
    await store.claimBootstrap({ name: 'Holder', email: 'holder@example.com', claimId: 'claim' });
    await store.finalizeBootstrap({ claimId: 'claim', ownerUserId: actor.actorId });
    await store.upsertActorMembership(actor.actorId, 'active', ['observe'], 'budget:fixture');
    store.liquidity.provisionOwnerAccess({
      ...actor,
      now,
      resources: [
        ...['checking', 'savings'].map((resourceId) => ({
          resourceKind: 'account' as const,
          resourceId,
        })),
        ...['food', 'other'].map((resourceId) => ({
          resourceKind: 'category' as const,
          resourceId,
        })),
      ],
    });
    const policy = JSON.parse(
      readFileSync(
        new URL('../../../protocol/fixtures/account-aware-liquidity.json', import.meta.url),
        'utf8',
      ),
    ).liquidityPolicy;
    store.liquidity.savePolicy({
      ...actor,
      expectedVersion: null,
      now,
      policy,
      approvalPolicy: { minimumApprovers: 1 },
    });
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

  async function saveFundedSession() {
    current = snapshot(20000, '2026-09-06T10:00:00.000Z', false, 15000);
    await service.saveObservations(actor, {
      expectedVersion: 1,
      expiresAt,
      observations: ['checking', 'savings'].map((accountId) => ({
        accountId, currentLedgerConfirmed: true, kind: 'cash', currency: 'USD',
        owned: true, holds: money('0'),
      })),
    });
    const session = await service.saveSession(actor, null, {
      accountId: 'checking',
      expiresAt,
      items: [{ id: 'one', categoryId: 'food', accountId: 'checking', amount: money('1000'),
        purchaseAt: now, requiredBy: now }],
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

  it('reserves exact native cart charges and restores availability on authorized release', async () => {
    const originalPolicy = store.liquidity.getPolicy(actor)!;
    await service.savePolicy(actor, {
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
    const configuration = await service.savePolicy(actor, {
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
    const configured = await service.savePolicy(actor, {
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
    const configuration = await service.savePolicy(actor, {
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
    await expect(service.savePolicy(actor, {
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
    await service.savePolicy(actor, {
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
    const approved = await service.approveSessionCompletion(actor, proposal.id, {
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
    const approved = await service.approveSessionCompletion(actor, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'same-day-approve',
    });
    expect(approved).toMatchObject({ phase: 'approved', canExecute: true });
  });

  it('approves an exact completion after a harmless recapture, but rejects changed ledger material', async () => {
    const session = await saveFundedSession();
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'proposal-one',
    });
    current = snapshot(20000, '2026-09-06T10:00:30.000Z', false, 15000);
    const approved = await service.approveSessionCompletion(actor, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'approval-one',
    });
    expect(approved).toMatchObject({ phase: 'approved', approvalCount: 1, canExecute: true });
    const second = await service.saveSession(actor, null, {
      accountId: 'checking', expiresAt,
      items: [{ id: 'another', categoryId: 'food', accountId: 'checking', amount: money('1500'),
        purchaseAt: now, requiredBy: now }],
    });
    expect(second.card.outcome).not.toBe('funded_now');
    current = snapshot(20000, '2026-09-06T10:00:40.000Z', false, 14999);
    await expect(service.approveSessionCompletion(actor, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: approved.version,
      idempotencyKey: 'approval-changed-ledger',
    })).rejects.toThrow();
  });

  it('delays discretionary approval then re-evaluates the same cart after cooldown', async () => {
    const initial = await saveFundedSession();
    const session = await service.saveSession(actor, initial.id, {
      accountId: 'checking',
      expectedVersion: initial.version,
      expiresAt,
      items: [{ id: 'one', categoryId: 'food', accountId: 'checking', amount: money('1000'),
        purchaseAt: '2026-09-06T10:02:00.000Z', requiredBy: '2026-09-06T10:02:00.000Z' }],
    });
    expect(session.card.outcome).toBe('funded_now');
    const existing = store.liquidity.getPolicy(actor)!;
    await service.savePolicy(actor, {
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
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'cooldown-proposal',
    });
    expect(proposed.cooldownUntil).toBe('2026-09-06T10:02:00.000Z');
    await expect(service.approveSessionCompletion(actor, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'early-approval',
    })).rejects.toThrow(/cooldown/i);
    clockNow = '2026-09-06T10:02:00.000Z';
    current = snapshot(20000, '2026-09-06T10:01:30.000Z', false, 15000);
    const approved = await service.approveSessionCompletion(actor, proposed.id, {
      payloadHash: proposed.payloadHash!,
      expectedVersion: proposed.version,
      idempotencyKey: 'after-cooldown',
    });
    expect(approved).toMatchObject({ phase: 'approved', canExecute: true });
  });

  it('rejects execution without a mutation-mode connector before touching a proposal', async () => {
    await expect(service.executeSessionCompletion(actor, 'any-proposal', {}))
      .rejects.toThrow(/mutation connection/i);
  });

  it('lets a scoped peer approve the exact debit without granting access to the owner cart', async () => {
    const policy = store.liquidity.getPolicy(actor)!;
    await service.savePolicy(actor, {
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
    const ownerApproved = await service.approveSessionCompletion(actor, proposed.id, {
      payloadHash: proposed.payloadHash!, expectedVersion: proposed.version,
      idempotencyKey: 'scoped-owner-approval',
    });
    const peer = { actorId: 'coapprover', budgetId: actor.budgetId };
    const capabilities = ['session', 'proposal', 'approval', 'liquidity', 'existence', 'balance', 'conclusion', 'category', 'initiation-report'] as const;
    await store.upsertActorMembership(
      peer.actorId, 'active', capabilities.map((capability) => `liquidity:${capability}`),
      `budget:${peer.budgetId}`,
    );
    for (const capability of capabilities)
      for (const [resourceKind, resourceId] of [
        ['budget', peer.budgetId], ['account', 'checking'], ['category', 'food'],
      ] as const)
        if ((capability !== 'conclusion' || resourceKind === 'budget') &&
            (capability !== 'category' || resourceKind === 'category') &&
            (capability !== 'liquidity' || resourceKind !== 'budget'))
          store.liquidity.setResourceGrant({
            ...peer, resourceKind, resourceId, capability, granted: true, now,
          });
    expect((await service.sessionCompletion(peer, proposed.id)).canApprove).toBe(true);
    await expect(service.session(peer, session.id)).rejects.toThrow();
    const approved = await service.approveSessionCompletion(peer, proposed.id, {
      payloadHash: proposed.payloadHash!, expectedVersion: ownerApproved.version,
      idempotencyKey: 'scoped-peer-approval',
    });
    expect(approved).toMatchObject({ phase: 'approved', approvalCount: 2 });
    expect((await service.sessionCompletion(peer, proposed.id)).canExecute).toBe(false);
  });

  it('requires an explicit mutation manager and calls Actual once after a durable approval', async () => {
    const session = await saveFundedSession();
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version,
      idempotencyKey: 'manual-proposal',
      payeeName: 'Fixture shop',
    });
    const approved = await service.approveSessionCompletion(actor, proposed.id, {
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
      coverage: { ...current.coverage, accounts: 'complete', transactions: 'complete' },
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
          reconciled: true,
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

  it.each([
    ['IMPORTED_CANDIDATE_REVIEW', 'closed'],
    ['AMBIGUOUS_IMPORTED_CANDIDATE', 'closed'],
    ['WRITE_UNCERTAIN', 'review_required'],
  ] as const)('distinguishes %s before and after Actual write attempts', async (code, phase) => {
    const session = await saveFundedSession();
    const proposed = await service.proposeSessionCompletion(actor, session.id, {
      expectedSessionVersion: session.version, idempotencyKey: `import-first:${code}`,
    });
    const approved = await service.approveSessionCompletion(actor, proposed.id, {
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
    const result = await writable.executeSessionCompletion(actor, proposed.id, {
      payloadHash: proposed.payloadHash!, expectedVersion: approved.version,
      idempotencyKey: `import-execute:${code}`,
    });
    expect(result.phase).toBe(phase);
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles.map((bundle) => bundle.state))
      .toEqual(phase === 'closed' ? [] : ['initiated']);
    if (code === 'WRITE_UNCERTAIN') {
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
    const reader = { actorId: 'reader', budgetId: 'fixture' };
    await store.upsertActorMembership('reader', 'active', ['observe'], 'budget:fixture');
    for (const capability of ['conclusion', 'existence', 'name'] as const)
      for (const [resourceKind, resourceId] of [
        ['budget', 'fixture'],
        ['category', 'food'],
        ['account', 'checking'],
      ] as const)
        store.liquidity.manageResourceGrant({
          managerId: actor.actorId,
          ...reader,
          capability,
          resourceKind,
          resourceId,
          granted: true,
          now,
        });
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
  it('denies invited observe-only actors without inherited liquidity grants', async () => {
    await store.upsertActorMembership('observer', 'active', ['observe'], 'budget:fixture');
    await expect(
      service.evaluatePurchase({ actorId: 'observer', budgetId: 'fixture' }, purchase),
    ).rejects.toThrow();
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
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
    const approved = await service.transferAction(actor, p.id, 'approve', {
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
  it('withholds linked finding evidence after current source grants are revoked', async () => {
    const preview = await service.previewTransfer(actor, purchase);
    const proposal = await service.proposeTransfer(actor, {
      previewId: preview.previewId,
      payloadHash: preview.payloadHash,
      idempotencyKey: 'finding-proposal',
    });
    const finding = await store.createFinding({
      budgetId: actor.budgetId,
      classification: 'transfer_needs_attention',
      description: 'Transfer review',
      evidence: { transferId: proposal.id },
      actorId: actor.actorId,
    });
    expect(LiquidityProjector.canReadFinding(store, actor.actorId, finding)).toBe(true);
    store.liquidity.setResourceGrant({
      ...actor,
      resourceKind: 'account',
      resourceId: 'savings',
      capability: 'proposal',
      granted: false,
      now,
    });
    expect(LiquidityProjector.canReadFinding(store, actor.actorId, finding)).toBe(false);
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
      store.liquidity.setResourceGrant({ ...actor, ...revoked, granted: false, now });
      expect(
        (await service.configuration(actor)).observations.map(
          (observation) => observation.accountId,
        ),
      ).not.toContain('checking');
    },
  );
  it('rejects observation replacement that removes an account outside current policy authority', async () => {
    store.liquidity.setResourceGrant({
      ...actor,
      resourceKind: 'account',
      resourceId: 'savings',
      capability: 'policy',
      granted: false,
      now,
    });
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
    store.liquidity.setResourceGrant({
      ...actor,
      resourceKind: 'account',
      resourceId: 'savings',
      capability: 'policy',
      granted: false,
      now,
    });
    await expect(
      service.savePolicy(actor, {
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
    const approved = await service.transferAction(actor, proposal.id, 'approve', {
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
      const approved = await service.transferAction(actor, proposal.id, 'approve', {
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
      await service.savePolicy(actor, {
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
    const approved = await service.transferAction(actor, proposal.id, 'approve', {
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
    expect((await service.transfer(actor, proposal.id)).phase).toBe('confirmed');
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
        store.liquidity.setResourceGrant({
          ...actor,
          resourceKind: 'account',
          resourceId: 'savings',
          capability: 'history',
          granted: false,
          now,
        });
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
    await service.savePolicy(actor, {
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
    const approved = await service.transferAction(actor, proposal.id, 'approve', {
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
    store.liquidity.setResourceGrant({
      ...actor,
      resourceKind: 'account',
      resourceId: 'savings',
      capability: 'history',
      granted: false,
      now,
    });
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
});
