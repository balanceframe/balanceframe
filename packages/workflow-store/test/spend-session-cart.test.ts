import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { LiquidityClaimBundle, TransferPlan } from '@balanceframe/protocol-generated';
import { SqliteWorkflowStore } from '../src/store.js';

const now = '2098-01-01T00:00:00.000Z';
const later = '2099-01-01T00:00:00.000Z';
const expiration = '2098-02-01T00:00:00.000Z';
const cancellation = '2098-01-02T00:00:00.000Z';
const budgetId = 'budget';
const ownerId = 'holder';
const readerId = 'reader';
const actor = { actorId: ownerId, budgetId };
type MoneyFixture = { minorUnits: string; currency: string };
const money = (minorUnits: string): MoneyFixture => ({ minorUnits, currency: 'USD' });
type RawItem = {
  id: string;
  categoryId: string;
  amount: MoneyFixture;
  quantity: number;
  priority: 'required' | 'planned' | 'optional';
  categoryAllocations: Array<{ categoryId: string; amount: MoneyFixture }>;
  priceProvenance: {
    kind: 'current_session_manual' | 'outside_price';
    source: string;
    store?: string | null;
    observedAt: string;
    estimate: boolean;
  };
  barcode: string;
  accountId: string | null;
  purchaseAt: string;
  requiredBy: string;
};
type RawAdjustment = {
  kind: 'tax' | 'fee' | 'discount';
  categoryId: string;
  amount: MoneyFixture;
};
type RawThreshold = {
  id: string;
  basis: 'cart_total' | 'category_charge';
  categoryId?: string;
  maximum: MoneyFixture;
};

function rawItem(quantity = 3): RawItem {
  return {
    id: 'groceries',
    categoryId: 'food',
    amount: money('40'),
    quantity,
    priority: 'required',
    categoryAllocations: [
      { categoryId: 'food', amount: money(quantity === 3 ? '90' : '120') },
      { categoryId: 'household', amount: money(quantity === 3 ? '30' : '40') },
    ],
    priceProvenance: {
      kind: 'outside_price',
      source: 'receipt-import',
      store: 'Market',
      observedAt: now,
      estimate: true,
    },
    barcode: '0123456789012',
    accountId: 'cash',
    purchaseAt: now,
    requiredBy: later,
  };
}
function rawAdjustments(): RawAdjustment[] {
  return [
    { kind: 'tax', categoryId: 'food', amount: money('4') },
    { kind: 'fee', categoryId: 'fees', amount: money('2') },
    { kind: 'discount', categoryId: 'food', amount: money('3') },
  ];
}
function rawThresholds(): RawThreshold[] {
  return [
    {
      id: 'food-cap',
      basis: 'category_charge',
      categoryId: 'food',
      maximum: money('150'),
    },
    { id: 'cart-cap', basis: 'cart_total', maximum: money('140') },
  ];
}
type SessionInputOverrides = {
  expiresAt?: string;
  accountId?: string | null;
  items?: RawItem[];
  adjustments?: RawAdjustment[];
  warningThresholds?: RawThreshold[];
  claim?: LiquidityClaimBundle;
};

function sessionInput(
  id: string,
  expectedVersion: number,
  idempotencyKey: string,
  overrides: SessionInputOverrides = {},
) {
  return {
    ...actor,
    id,
    expectedVersion,
    idempotencyKey,
    now,
    expiresAt: later,
    accountId: 'cash',
    items: [rawItem()],
    adjustments: rawAdjustments(),
    warningThresholds: rawThresholds(),
    ...overrides,
  };
}
function plan(
  payloadHash = 'a'.repeat(64),
  economicObligationId = 'proposal',
): TransferPlan {
  const before = (accountId: string) => ({
    accountId,
    recordedBalance: money('100'),
    signedHeadroom: money('100'),
    backingCapacity: money('100'),
    baselineTransactionIds: [],
  });
  return {
    version: '1',
    preconditionsHash: 'e'.repeat(64),
    scenario: { kind: 'none' },
    snapshotId: 'snapshot',
    contentHash: 'ledger',
    policyVersion: 'one',
    policyHash: 'hash',
    claimSetRevision: '0',
    evaluatedAt: now,
    expiresAt: later,
    minimumAmount: money('20'),
    payloadHash,
    legs: [
      {
        id: `leg-${economicObligationId}`,
        sourceAccountId: 'cash',
        destinationAccountId: 'backup',
        amount: money('20'),
        requiredBy: later,
        estimatedArrival: now,
        timingRouteId: 'route',
        sourceBefore: before('cash'),
        destinationBefore: before('backup'),
        sourceAfter: money('80'),
        destinationAfter: money('120'),
      },
    ],
    reservations: [
      {
        kind: 'account_debit',
        resourceId: 'cash',
        amount: money('20'),
        economicObligationId,
        categoryId: null,
        includedInBalance: false,
        matchedTransactionIds: [],
      },
    ],
    backingAfter: {
      version: '1',
      snapshotId: 'snapshot',
      contentHash: 'ledger',
      policyVersion: 'one',
      policyHash: 'hash',
      claimSetRevision: '0',
      feasible: true,
      lines: [],
      reasons: [],
    },
  };
}

function sessionClaim(): LiquidityClaimBundle {
  return {
    id: 'session-hold',
    creationSnapshotId: 'snapshot',
    creationPolicyVersion: 'one',
    state: 'active',
    expiresAt: later,
    initiated: false,
    effects: [
      {
        kind: 'category',
        resourceId: 'food',
        amount: money('5'),
        economicObligationId: 'session-hold',
        categoryId: 'food',
        includedInBalance: false,
        matchedTransactionIds: [],
      },
    ],
  };
}

describe('raw spend-session cart persistence and authorization', () => {
  let store: SqliteWorkflowStore;
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'spend-session-cart-'));
    path = join(directory, 'workflow.sqlite');
    store = new SqliteWorkflowStore(path);
    await store.claimBootstrap({ name: 'Holder', email: 'holder@example.com', claimId: 'claim' });
    await store.finalizeBootstrap({ claimId: 'claim', ownerUserId: ownerId });
    store.liquidity.provisionOwnerAccess({
      ...actor,
      now,
      resources: [
        { resourceKind: 'account', resourceId: 'cash' },
        { resourceKind: 'account', resourceId: 'backup' },
        { resourceKind: 'category', resourceId: 'food' },
        { resourceKind: 'category', resourceId: 'household' },
        { resourceKind: 'category', resourceId: 'fees' },
      ],
    });
    store.liquidity.savePolicy({
      ...actor,
      expectedVersion: null,
      now,
      policy: { version: 'one', policyHash: 'hash', expiresAt: later, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 1 },
    });
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function grantReaderResources(): Promise<void> {
    await store.upsertActorMembership(readerId, 'active', ['observe'], `budget:${budgetId}`);
    const reader = { actorId: readerId, budgetId };
    const grants = [
      { capability: 'session' as const, resourceKind: 'budget' as const, resourceId: budgetId },
      { capability: 'category' as const, resourceKind: 'category' as const, resourceId: 'food' },
      {
        capability: 'category' as const,
        resourceKind: 'category' as const,
        resourceId: 'household',
      },
      { capability: 'category' as const, resourceKind: 'category' as const, resourceId: 'fees' },
      { capability: 'liquidity' as const, resourceKind: 'account' as const, resourceId: 'cash' },
    ];
    for (const grant of grants)
      store.liquidity.manageResourceGrant({ ...reader, managerId: ownerId, granted: true, now, ...grant });
  }

  function revokeReaderCategory(resourceId: string): void {
    store.liquidity.manageResourceGrant({
      actorId: readerId,
      budgetId,
      managerId: ownerId,
      capability: 'category',
      resourceKind: 'category',
      resourceId,
      granted: false,
      now,
    });
  }

  function admitLinked(
    sessionId: string,
    transferPlan: TransferPlan,
    expectedClaimSetRevision: string,
    idempotencyKey: string,
  ) {
    return store.liquidity.admitTransferProposal(
      {
        ...actor,
        sessionId,
        plan: { ...transferPlan, claimSetRevision: expectedClaimSetRevision },
        expectedClaimSetRevision,
        idempotencyKey,
        now,
      },
      () => ({ valid: true }),
    );
  }

  function approveLinked(
    proposalId: string,
    payloadHash: string,
    expectedClaimSetRevision: string,
    idempotencyKey: string,
  ) {
    return store.liquidity.approveTransfer(
      {
        ...actor,
        proposalId,
        payloadHash,
        expectedVersion: 1,
        expectedClaimSetRevision,
        idempotencyKey,
        now,
      },
      () => ({ valid: true }),
    );
  }

  it('preserves rich raw cart fields through replay, reopen, CAS edits, and proposal invalidation', async () => {
    const create = sessionInput('session', 0, 'session-create', {
      claim: sessionClaim(),
      expectedClaimSetRevision: '0',
    });
    const created = store.liquidity.saveSpendSession(create, () => ({ valid: true }));
    expect(created).toMatchObject({
      id: 'session',
      version: 1,
      accountId: 'cash',
      adjustments: rawAdjustments(),
      warningThresholds: rawThresholds(),
    });
    expect(created.items).toEqual([rawItem()]);

    const replay = store.liquidity.saveSpendSession(create, () => {
      throw new Error('idempotent replay must not invoke validation');
    });
    expect(replay).toEqual(created);

    store.close();
    store = new SqliteWorkflowStore(path);
    const reopened = store.liquidity.getSpendSession({ ...actor, id: 'session', now });
    expect(reopened).toMatchObject({
      id: 'session',
      version: 1,
      accountId: 'cash',
      adjustments: rawAdjustments(),
      warningThresholds: rawThresholds(),
    });
    expect(reopened?.items).toEqual([rawItem()]);

    const db = new Database(path);
    const claimRow = db
      .prepare(
        "SELECT bundle FROM liquidity_claims WHERE budget_id=? AND owner_kind='session' AND owner_id=?",
      )
      .get(budgetId, 'session') as { bundle: string };
    const initiated = JSON.parse(claimRow.bundle) as LiquidityClaimBundle;
    db.prepare('UPDATE liquidity_claims SET bundle=? WHERE budget_id=? AND owner_kind=? AND owner_id=?').run(
      JSON.stringify({ ...initiated, state: 'initiated', initiated: true }),
      budgetId,
      'session',
      'session',
    );
    db.close();
    store.close();
    store = new SqliteWorkflowStore(path);

    const holdBeforeProposals = store.liquidity.getClaimSet({ ...actor, now });
    expect(holdBeforeProposals.bundles).toContainEqual(
      expect.objectContaining({ id: 'session-hold', state: 'initiated', initiated: true }),
    );

    const uninitiated = admitLinked(
      'session',
      plan('a'.repeat(64), 'uninitiated-proposal'),
      holdBeforeProposals.revision,
      'proposal-uninitiated',
    );
    const afterUninitiatedAdmission = store.liquidity.getClaimSet({ ...actor, now });
    approveLinked(
      uninitiated.id,
      uninitiated.payloadHash,
      afterUninitiatedAdmission.revision,
      'approval-uninitiated',
    );
    expect(await store.findActiveApprovals(uninitiated.id)).toHaveLength(1);

    const initiatedProposal = admitLinked(
      'session',
      plan('b'.repeat(64), 'initiated-proposal'),
      store.liquidity.getClaimSet({ ...actor, now }).revision,
      'proposal-initiated',
    );
    const afterInitiatedAdmission = store.liquidity.getClaimSet({ ...actor, now });
    approveLinked(
      initiatedProposal.id,
      initiatedProposal.payloadHash,
      afterInitiatedAdmission.revision,
      'approval-initiated',
    );
    const beforeInitiation = store.liquidity.getClaimSet({ ...actor, now });
    store.liquidity.reportTransferInitiated(
      {
        ...actor,
        proposalId: initiatedProposal.id,
        payloadHash: initiatedProposal.payloadHash,
        expectedVersion: 2,
        expectedClaimSetRevision: beforeInitiation.revision,
        idempotencyKey: 'initiate-proposal',
        now,
      },
      () => ({ valid: true }),
    );
    const beforeEdit = store.liquidity.getClaimSet({ ...actor, now });

    const editedItem: RawItem = {
      ...rawItem(4),
      categoryAllocations: [
        { categoryId: 'food', amount: money('120') },
        { categoryId: 'household', amount: money('40') },
      ],
    };
    const editedAdjustments: RawAdjustment[] = [
      { kind: 'tax', categoryId: 'food', amount: money('8') },
      { kind: 'fee', categoryId: 'fees', amount: money('1') },
      { kind: 'discount', categoryId: 'food', amount: money('4') },
    ];
    const editedThresholds: RawThreshold[] = [
      { id: 'food-cap', basis: 'category_charge', categoryId: 'food', maximum: money('170') },
      { id: 'cart-cap', basis: 'cart_total', maximum: money('160') },
    ];
    const edit = sessionInput('session', 1, 'session-edit', {
      items: [editedItem],
      adjustments: editedAdjustments,
      warningThresholds: editedThresholds,
    });
    const updated = store.liquidity.saveSpendSession(edit, () => ({ valid: true }));
    expect(updated).toMatchObject({
      id: 'session',
      version: 2,
      accountId: 'cash',
      adjustments: editedAdjustments,
      warningThresholds: editedThresholds,
    });
    expect(updated.items).toEqual([editedItem]);
    expect(() =>
      store.liquidity.saveSpendSession({ ...edit, idempotencyKey: 'stale', expectedVersion: 1 }, () => ({
        valid: true,
      })),
    ).toThrow(/version|conflict/i);

    expect(await store.findActiveApprovals(uninitiated.id)).toEqual([]);
    expect(
      store.liquidity.getTransferProposal({ ...actor, proposalId: uninitiated.id }).state.outcome,
    ).toBe('superseded');
    expect(
      store.liquidity.getTransferProposal({ ...actor, proposalId: initiatedProposal.id }).state,
    ).toMatchObject({ phase: 'initiated', outcome: 'superseded' });

    const afterEdit = store.liquidity.getClaimSet({ ...actor, now });
    expect(afterEdit.revision).toBe(String(Number(beforeEdit.revision) + 1));
    expect(afterEdit.bundles.find((bundle) => bundle.id === 'session-hold')).toEqual({
      ...sessionClaim(),
      state: 'initiated',
      initiated: true,
    });
    expect(
      afterEdit.bundles.some(
        (bundle) =>
          bundle.id === initiatedProposal.id &&
          bundle.state === 'initiated' &&
          bundle.initiated === true,
      ),
    ).toBe(true);
    expect(afterEdit.bundles).not.toContainEqual(expect.objectContaining({ id: uninitiated.id }));
  });

  it('checks every split category on save, get, and list while exposing only the owner session', async () => {
    await grantReaderResources();
    const ownerSession = store.liquidity.saveSpendSession(
      sessionInput('owner-session', 0, 'owner-create'),
      () => ({ valid: true }),
    );
    const readerInput = { ...sessionInput('reader-session', 0, 'reader-create'), actorId: readerId };
    const readerSession = store.liquidity.saveSpendSession(readerInput, () => ({ valid: true }));

    expect(store.liquidity.listSpendSessions({ ...actor, now })).toEqual([ownerSession]);
    expect(store.liquidity.listSpendSessions({ actorId: readerId, budgetId, now })).toEqual([
      readerSession,
    ]);
    expect(() =>
      store.liquidity.getSpendSession({ actorId: readerId, budgetId, id: ownerSession.id, now }),
    ).toThrow(/authoriz/i);
    expect(() =>
      store.liquidity.getSpendSession({ actorId: ownerId, budgetId, id: readerSession.id, now }),
    ).toThrow(/authoriz/i);

    revokeReaderCategory('household');
    expect(() =>
      store.liquidity.saveSpendSession(
        { ...readerInput, expectedVersion: 1, idempotencyKey: 'reader-split-edit' },
        () => ({ valid: true }),
      ),
    ).toThrow(/authoriz/i);
    expect(() =>
      store.liquidity.getSpendSession({ actorId: readerId, budgetId, id: readerSession.id, now }),
    ).toThrow(/authoriz/i);
    expect(() =>
      store.liquidity.listSpendSessions({ actorId: readerId, budgetId, now }),
    ).toThrow(/authoriz/i);
  });

  it('checks adjustment categories independently on save, get, and list after revoke', async () => {
    await grantReaderResources();
    const readerInput = { ...sessionInput('reader-adjustment-session', 0, 'reader-adjustment-create'), actorId: readerId };
    const readerSession = store.liquidity.saveSpendSession(readerInput, () => ({ valid: true }));

    revokeReaderCategory('fees');
    expect(() =>
      store.liquidity.saveSpendSession(
        { ...readerInput, expectedVersion: 1, idempotencyKey: 'reader-adjustment-edit' },
        () => ({ valid: true }),
      ),
    ).toThrow(/authoriz/i);
    expect(() =>
      store.liquidity.getSpendSession({ actorId: readerId, budgetId, id: readerSession.id, now }),
    ).toThrow(/authoriz/i);
    expect(() =>
      store.liquidity.listSpendSessions({ actorId: readerId, budgetId, now }),
    ).toThrow(/authoriz/i);
  });

  it('filters expired sessions and cancels with CAS while preserving all raw cart source fields', () => {
    const expiringInput = sessionInput('expiring', 0, 'expiring-create', {
      expiresAt: expiration,
      items: [{ ...rawItem(), requiredBy: '2098-01-15T00:00:00.000Z' }],
    });
    const expiring = store.liquidity.saveSpendSession(expiringInput, () => ({ valid: true }));
    expect(store.liquidity.getSpendSession({ ...actor, id: expiring.id, now })).toEqual(expiring);
    expect(store.liquidity.listSpendSessions({ ...actor, now })).toContainEqual(expiring);
    expect(() =>
      store.liquidity.getSpendSession({ ...actor, id: expiring.id, now: expiration }),
    ).toThrow(/expir/i);
    expect(store.liquidity.listSpendSessions({ ...actor, now: expiration })).toEqual([]);

    const cancellable = store.liquidity.saveSpendSession(
      sessionInput('cancellable', 0, 'cancellable-create'),
      () => ({ valid: true }),
    );
    const cancel = {
      ...actor,
      id: cancellable.id,
      expectedVersion: cancellable.version,
      idempotencyKey: 'cancellable-cancel',
      now: cancellation,
    };
    const cancelled = store.liquidity.cancelSpendSession(cancel);
    expect(cancelled).toMatchObject({
      id: 'cancellable',
      version: 2,
      expiresAt: cancellation,
      adjustments: rawAdjustments(),
      warningThresholds: rawThresholds(),
    });
    expect(cancelled.items).toEqual([rawItem()]);
    expect(store.liquidity.cancelSpendSession(cancel)).toEqual(cancelled);
    expect(() =>
      store.liquidity.getSpendSession({ ...actor, id: cancellable.id, now: cancellation }),
    ).toThrow(/expir/i);
    expect(store.liquidity.listSpendSessions({ ...actor, now: cancellation })).toEqual([expiring]);
  });
  it('round-trips an outside price without a known store and preserves a known store', () => {
    const unknownStore = rawItem();
    delete unknownStore.priceProvenance.store;
    const savedUnknown = store.liquidity.saveSpendSession(
      sessionInput('unknown-store', 0, 'unknown-store-create', { items: [unknownStore] }),
      () => ({ valid: true }),
    );
    const loadedUnknown = store.liquidity.getSpendSession({
      ...actor,
      id: savedUnknown.id,
      now,
    });
    expect(loadedUnknown?.items[0]?.priceProvenance).toEqual({
      kind: 'outside_price',
      source: 'receipt-import',
      observedAt: now,
      estimate: true,
    });
    expect(loadedUnknown?.items[0]?.priceProvenance).not.toHaveProperty('store');

    const known = store.liquidity.saveSpendSession(
      sessionInput('known-store', 0, 'known-store-create'),
      () => ({ valid: true }),
    );
    expect(known.items[0]?.priceProvenance).toEqual(rawItem().priceProvenance);
  });

  it('rejects a blank explicit outside price store', () => {
    const blankStore = rawItem();
    blankStore.priceProvenance.store = ' ';
    expect(() =>
      store.liquidity.saveSpendSession(
        sessionInput('blank-store', 0, 'blank-store-create', { items: [blankStore] }),
        () => ({ valid: true }),
      ),
    ).toThrow(/Invalid price provenance/);
  });


  it('marks legacy prices unknown and preserves derived payment routes as non-explicit', () => {
    const legacyItem = {
      id: 'legacy-item',
      categoryId: 'food',
      amount: money('30'),
      purchaseAt: now,
      requiredBy: later,
      routeSelection: {
        explicitAccountId: 'cash',
        sessionAccountId: null,
        approvedPreference: null,
        historicalRoute: null,
      },
    };
    store.close();
    const db = new Database(path);
    db.prepare('INSERT INTO spend_sessions (budget_id,id,record) VALUES (?,?,?)').run(
      budgetId,
      'legacy-session',
      JSON.stringify({
        actorId: ownerId,
        budgetId,
        id: 'legacy-session',
        version: 1,
        items: [legacyItem, {
          ...legacyItem, id: 'legacy-derived-route',
          routeSelection: {
            explicitAccountId: null,
            sessionAccountId: null,
            approvedPreference: { accountId: 'backup', preferenceId: 'old-preference' },
            historicalRoute: { accountId: 'backup' },
          },
        }],
        accountId: 'cash',
        expiresAt: later,
        createdAt: now,
        updatedAt: now,
      }),
    );
    db.close();
    store = new SqliteWorkflowStore(path);

    const legacy = store.liquidity.getSpendSession({ ...actor, id: 'legacy-session', now });
    expect(legacy).toMatchObject({ id: 'legacy-session', version: 1 });
    expect(legacy?.items[0]).toMatchObject({
      id: legacyItem.id,
      categoryId: legacyItem.categoryId,
      amount: legacyItem.amount,
      accountId: 'cash',
      purchaseAt: legacyItem.purchaseAt,
      requiredBy: legacyItem.requiredBy,
      priceProvenance: null,
    });
    expect(legacy?.items[0]).not.toHaveProperty('routeSelection');
    expect(legacy?.items[1]).toMatchObject({
      id: 'legacy-derived-route', accountId: null, priceProvenance: null,
    });

    const explicitEdit = sessionInput('legacy-session', 1, 'legacy-edit', {
      items: [{ ...rawItem(), id: 'legacy-item' }],
    });
    const edited = store.liquidity.saveSpendSession(explicitEdit, () => ({ valid: true }));
    expect(edited.items[0]?.priceProvenance).toEqual(rawItem().priceProvenance);
  });
});
