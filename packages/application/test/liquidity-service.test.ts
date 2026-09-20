import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SqliteWorkflowStore } from '@balanceframe/workflow-store';
import type { TransferSettlementRecord } from '@balanceframe/protocol-generated';
import {
  normalizeAccounts,
  normalizeCategories,
  normalizeActualLiquidityFacts,
  withLiquidityFacts,
} from '../../actual-adapter/src/normalizer.js';
import { actualLiquidityRequest } from '../../../tests/contract/fixtures/actual-liquidity.js';
import { ConnectionManager } from '../src/connection-manager.js';
import { LiquidityService } from '../src/liquidity-service.js';
import { LiquidityProjector } from '../src/liquidity-projector.js';

const native = createRequire(import.meta.url)('@balanceframe/native');
const now = '2026-09-06T10:01:00.000Z';
const expiresAt = '2026-09-06T10:15:00.000Z';
const actor = { actorId: 'holder', budgetId: 'fixture' };
const money = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
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
                { id: 'other', balance: 0 },
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
    const manager = new ConnectionManager({
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

  it('separates funded category from account shortfall and previews exact 30 without claims', async () => {
    const result = await service.evaluatePurchase(actor, purchase);
    expect(result.allowable).toBe(false);
    expect(result.liquidity.purchases[0]).toMatchObject({
      fundingStatus: 'funded',
      paymentStatus: 'transfer_required',
      transfer: { minimumAmount: money('3000') },
    });
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
  it('redacts private source identities, hashes and legacy nested financial payloads', async () => {
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
    expect(result.liquidity.purchases[0]?.transfer).toMatchObject({
      minimumAmount: money('3000'),
      authorizedHolderRequired: true,
    });
    const encoded = JSON.stringify(result);
    for (const hidden of [
      'savings',
      'Private savings',
      '20000',
      'payloadHash',
      'entityLabels',
      'accountAware',
      'preconditionsHash',
    ])
      expect(encoded).not.toContain(hidden);
    expect(result.liquidity.purchases[0]?.canPlanTransfer).toBe(false);
    await expect(service.previewTransfer(reader, purchase)).rejects.toThrow();
  });
  it('denies invited observe-only actors without inherited liquidity grants', async () => {
    await store.upsertActorMembership('observer', 'active', ['observe'], 'budget:fixture');
    await expect(
      service.evaluatePurchase({ actorId: 'observer', budgetId: 'fixture' }, purchase),
    ).rejects.toThrow();
    expect(store.liquidity.getClaimSet({ ...actor, now }).bundles).toEqual([]);
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
    expect(session.evaluation.purchases.map((item) => item.fundingStatus)).toEqual([
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
    expect(
      (await service.evaluatePurchase(actor, unselected)).liquidity.purchases[0],
    ).toMatchObject({ selectedAccountId: 'checking', routeOrigin: 'approved_preference' });
    expect(
      (await service.evaluatePurchase(actor, { ...purchase, accountId: 'savings' })).liquidity
        .purchases[0]?.selectedAccountId,
    ).toBe('savings');
    await expect(
      service.savePreference(actor, {
        categoryId: 'food',
        accountId: 'savings',
        expectedVersion: 0,
        expiresAt,
      }),
    ).rejects.toThrow(/version|conflict/i);
  });
  it('omits history-scoped quality metadata without suppressing authorized capacity', async () => {
    const before = (await service.evaluatePurchase(actor, purchase)).liquidity.accounts.find(
      (account) => account.id === 'checking',
    )!;
    expect(before.quality?.some((evidence) => evidence.source === 'user_attested')).toBe(true);
    store.liquidity.setResourceGrant({
      ...actor,
      resourceKind: 'account',
      resourceId: 'checking',
      capability: 'history',
      granted: false,
      now,
    });
    const after = (await service.evaluatePurchase(actor, purchase)).liquidity.accounts.find(
      (account) => account.id === 'checking',
    )!;
    expect(after).not.toHaveProperty('quality');
    expect(after.safeSpendingBefore).toEqual(before.safeSpendingBefore);
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
    expect(
      (await service.evaluatePurchase(actor, unselected)).liquidity.purchases[0]?.routeOrigin,
    ).not.toBe('approved_preference');
    const renewed = await service.savePreference(actor, {
      categoryId: 'food',
      accountId: 'checking',
      expectedVersion: 1,
      expiresAt,
    });
    expect(renewed.items).toMatchObject([{ version: 2, accountId: 'checking', expiresAt }]);
    expect(
      (await service.evaluatePurchase(actor, unselected)).liquidity.purchases[0]?.routeOrigin,
    ).toBe('approved_preference');
  });
  it('preserves explicit owner revocations when discovering existing and new accounts', async () => {
    store.liquidity.setResourceGrant({
      ...actor,
      resourceKind: 'account',
      resourceId: 'savings',
      capability: 'existence',
      granted: false,
      now,
    });
    expect(
      (await service.evaluatePurchase(actor, purchase)).liquidity.accounts.map(
        (account) => account.id,
      ),
    ).not.toContain('savings');
    store.liquidity.setResourceGrant({
      ...actor,
      resourceKind: 'budget',
      resourceId: actor.budgetId,
      capability: 'balance',
      granted: false,
      now,
    });
    current = snapshot(20000, '2026-09-06T10:00:30.000Z', true);
    const discovered = (await service.evaluatePurchase(actor, purchase)).liquidity;
    expect(discovered.accounts.map((account) => account.id)).toContain('new-account');
    expect(discovered.accounts.map((account) => account.id)).not.toContain('savings');
    expect(discovered.fundingStatus).toBeNull();
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
  it('includes required instants inside the exclusive horizon boundary', async () => {
    const instant = '2026-10-10T12:00:00.000Z';
    const result = await service.evaluatePurchase(actor, {
      ...purchase,
      purchaseAt: instant,
      requiredBy: instant,
    });
    expect(Date.parse(result.liquidity.horizon.endsAt)).toBeGreaterThan(Date.parse(instant));
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
  it('resolves missing immediate dates at the post-synchronization trusted capture', async () => {
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
    advanceDuringSync = '2026-09-06T10:03:00.000Z';
    const result = await service.evaluatePurchase(actor, {
      kind: 'purchase',
      categoryId: 'food',
      amount: money('2000'),
      accountId: 'checking',
    });
    expect(result.liquidity.evaluatedAt).toBe(advanceDuringSync);
    expect(result.liquidity.horizon.startsAt).toBe(advanceDuringSync);
    expect(result.allowable).toBe(true);
    expect(result.liquidity.purchases[0]).toMatchObject({
      fundingStatus: 'funded',
      paymentStatus: 'ready',
    });
  });
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
      expect(evaluation.liquidity.purchases[0]).toMatchObject({
        fundingStatus: 'funded',
        paymentStatus: 'transfer_required',
        transfer: { minimumAmount: money('3000') },
        canPlanTransfer: false,
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
