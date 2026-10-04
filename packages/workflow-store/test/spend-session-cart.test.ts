import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { LiquidityClaimBundle, TransferPlan } from '@balanceframe/protocol-generated';
import type { HumanControlContext } from '../src/governance-types.js';
import type { ClaimValidator, SaveSpendSessionInput } from '../src/liquidity-types.js';
import { SqliteWorkflowStore } from '../src/store.js';

const now = '2098-01-01T00:00:00.000Z';
const later = '2099-01-01T00:00:00.000Z';
const expiration = '2098-02-01T00:00:00.000Z';
const cancellation = '2098-01-02T00:00:00.000Z';
const budgetId = 'budget';
const ownerId = 'holder';
const readerId = 'reader';
const approverId = 'approver';
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
    actorId: ownerId,
    budgetId,
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
  let spaceId: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'spend-session-cart-'));
    path = join(directory, 'workflow.sqlite');
    store = new SqliteWorkflowStore(path);
    await store.claimBootstrap({ name: 'Holder', email: 'holder@example.com', claimId: 'claim' });
    await store.finalizeBootstrap({ claimId: 'claim', ownerUserId: ownerId });
    const space = store.governance.createSpace({
      actorId: ownerId,
      name: 'Governed budget',
      kind: 'shared',
      now,
      auth: human(ownerId),
    });
    spaceId = store.governance.bindBudget({
      spaceId: space.id,
      budgetId,
      now,
      auth: human(ownerId),
    }).id;
    provisionGrant(ownerId, 'policy', 'budget', budgetId);
    const governancePolicy = store.governance.getPolicy({ spaceId })!;
    store.liquidity.savePolicy({
      ...liquidityContext(ownerId),
      expectedVersion: null,
      expectedGovernancePolicyVersion: governancePolicy.version,
      policy: { version: 'one', policyHash: 'hash', expiresAt: later, accounts: [], transferRoutes: [] },
      approvalPolicy: { minimumApprovers: 1 },
    });

    const ownerGrants = [
      ['session', 'budget', budgetId],
      ['liquidity', 'budget', budgetId],
      ['liquidity', 'account', 'cash'],
      ['liquidity', 'account', 'backup'],
      ['existence', 'account', 'cash'],
      ['existence', 'account', 'backup'],
      ['name', 'account', 'cash'],
      ['name', 'account', 'backup'],
      ['balance', 'account', 'cash'],
      ['balance', 'account', 'backup'],
      ['history', 'account', 'cash'],
      ['history', 'account', 'backup'],
      ['liquidity', 'category', 'food'],
      ['category', 'category', 'food'],
      ['category', 'category', 'household'],
      ['category', 'category', 'fees'],
      ['proposal', 'budget', budgetId],
      ['proposal', 'account', 'cash'],
      ['proposal', 'account', 'backup'],
      ['source', 'account', 'cash'],
      ['initiation-report', 'budget', budgetId],
      ['initiation-report', 'account', 'cash'],
      ['initiation-report', 'account', 'backup'],
    ] as const;
    for (const [capability, resourceKind, resourceId] of ownerGrants)
      provisionGrant(ownerId, capability, resourceKind, resourceId);

    await store.upsertActorMembership(approverId, 'active', [], '');
    store.governance.addMembership({
      spaceId,
      actorId: approverId,
      validFrom: now,
      now,
      auth: human(ownerId),
    });
    for (const [capability, resourceKind, resourceId] of [
      ['approval', 'budget', budgetId],
      ['approval', 'account', 'cash'],
      ['approval', 'account', 'backup'],
      ['source', 'account', 'cash'],
    ] as const)
      provisionGrant(approverId, capability, resourceKind, resourceId);
  });

  function human(actorId: string, reauthenticatedAt = now): HumanControlContext {
    return {
      method: 'human-session',
      actorId,
      sessionId: `session:${actorId}`,
      reauthenticatedAt,
    };
  }

  function liquidityContext(actorId = ownerId, at = now) {
    const membership = store.governance.getCurrentMembership({ spaceId, actorId, now: at });
    const policy = store.governance.getPolicy({ spaceId });
    if (!membership || !policy) throw new Error('Current governed fixture membership unavailable');
    return {
      actorId,
      budgetId,
      spaceId,
      membershipId: membership.id,
      governancePolicyVersion: policy.version,
      now: at,
      auth: human(actorId, at),
    };
  }

  function provisionGrant(
    actorId: string,
    capability: string,
    resourceKind: 'budget' | 'account' | 'category',
    resourceId: string,
    granted = true,
    at = now,
  ): void {
    const membership = store.governance.getCurrentMembership({ spaceId, actorId, now: at });
    if (!membership) throw new Error('Current governed fixture membership unavailable');
    store.governance.provisionResourceGrant({
      spaceId,
      actorId,
      budgetId,
      membershipId: membership.id,
      capability,
      resourceKind,
      resourceId,
      granted,
      now: at,
    });
  }

  function saveSession(input: SaveSpendSessionInput, validator: ClaimValidator) {
    return store.liquidity.saveSpendSession(
      { ...input, ...liquidityContext(input.actorId, input.now) },
      validator,
    );
  }

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function grantReaderResources(): Promise<void> {
    await store.upsertActorMembership(readerId, 'active', ['observe'], `budget:${budgetId}`);
    store.governance.addMembership({
      spaceId,
      actorId: readerId,
      validFrom: now,
      now,
      auth: human(ownerId),
    });
    const grants = [
      ['session', 'budget', budgetId],
      ['category', 'category', 'food'],
      ['category', 'category', 'household'],
      ['category', 'category', 'fees'],
      ['liquidity', 'account', 'cash'],
    ] as const;
    for (const [capability, resourceKind, resourceId] of grants)
      provisionGrant(readerId, capability, resourceKind, resourceId);
  }

  function revokeReaderCategory(resourceId: string): void {
    provisionGrant(readerId, 'category', 'category', resourceId, false);
  }

  function admitLinked(
    sessionId: string,
    transferPlan: TransferPlan,
    expectedClaimSetRevision: string,
    idempotencyKey: string,
  ) {
    return store.liquidity.admitTransferProposal(
      {
        ...liquidityContext(ownerId),
        sessionId,
        plan: { ...transferPlan, claimSetRevision: expectedClaimSetRevision },
        expectedClaimSetRevision,
        idempotencyKey,
      },
      () => ({ valid: true }),
    );
  }

  function approveLinked(
    proposalId: string,
    payloadHash: string,
    expectedClaimSetRevision: string,
    idempotencyKey: string,
    actorId = approverId,
  ) {
    return store.liquidity.approveTransfer(
      {
        ...liquidityContext(actorId),
        proposalId,
        payloadHash,
        expectedVersion: 1,
        expectedClaimSetRevision,
        idempotencyKey,
      },
      () => ({ valid: true }),
    );
  }


  it('preserves rich raw cart fields through replay, reopen, CAS edits, and proposal invalidation', async () => {
    const create = sessionInput('session', 0, 'session-create', {
      claim: sessionClaim(),
      expectedClaimSetRevision: '0',
    });
    const created = saveSession(create, () => ({ valid: true }));
    expect(created).toMatchObject({
      id: 'session',
      version: 1,
      accountId: 'cash',
      adjustments: rawAdjustments(),
      warningThresholds: rawThresholds(),
    });
    expect(created.items).toEqual([rawItem()]);

    const replay = saveSession(create, () => {
      throw new Error('idempotent replay must not invoke validation');
    });
    expect(replay).toEqual(created);

    store.close();
    store = new SqliteWorkflowStore(path);
    const reopened = store.liquidity.getSpendSession({ ...liquidityContext(ownerId), id: 'session' });
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

    const holdBeforeProposals = store.liquidity.getClaimSet(liquidityContext(ownerId));
    expect(holdBeforeProposals.bundles).toContainEqual(
      expect.objectContaining({ id: 'session-hold', state: 'initiated', initiated: true }),
    );

    const uninitiated = admitLinked(
      'session',
      plan('a'.repeat(64), 'uninitiated-proposal'),
      holdBeforeProposals.revision,
      'proposal-uninitiated',
    );
    const afterUninitiatedAdmission = store.liquidity.getClaimSet(liquidityContext(ownerId));
    approveLinked(
      uninitiated.id,
      uninitiated.payloadHash,
      afterUninitiatedAdmission.revision,
      'approval-uninitiated',
    );
    const activeApprovals = await store.findActiveApprovals(uninitiated.id);
    expect(activeApprovals).toHaveLength(1);
    expect(activeApprovals[0]).toMatchObject({
      actorId: approverId,
      membershipId: store.governance.getCurrentMembership({
        spaceId,
        actorId: approverId,
        now,
      })!.id,
      governancePolicyVersion: store.governance.getPolicy({ spaceId })!.version,
      reauthenticatedSessionId: `session:${approverId}`,
      reauthenticatedAt: now,
    });

    const initiatedProposal = admitLinked(
      'session',
      plan('b'.repeat(64), 'initiated-proposal'),
      store.liquidity.getClaimSet(liquidityContext(ownerId)).revision,
      'proposal-initiated',
    );
    const afterInitiatedAdmission = store.liquidity.getClaimSet(liquidityContext(ownerId));
    approveLinked(
      initiatedProposal.id,
      initiatedProposal.payloadHash,
      afterInitiatedAdmission.revision,
      'approval-initiated',
    );
    const beforeInitiation = store.liquidity.getClaimSet(liquidityContext(ownerId));
    store.liquidity.reportTransferInitiated(
      {
        ...liquidityContext(ownerId),
        proposalId: initiatedProposal.id,
        payloadHash: initiatedProposal.payloadHash,
        expectedVersion: 2,
        expectedClaimSetRevision: beforeInitiation.revision,
        idempotencyKey: 'initiate-proposal',
      },
      () => ({ valid: true }),
    );
    const beforeEdit = store.liquidity.getClaimSet(liquidityContext(ownerId));

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
    const updated = saveSession(edit, () => ({ valid: true }));
    expect(updated).toMatchObject({
      id: 'session',
      version: 2,
      accountId: 'cash',
      adjustments: editedAdjustments,
      warningThresholds: editedThresholds,
    });
    expect(updated.items).toEqual([editedItem]);
    expect(() =>
      saveSession({ ...edit, idempotencyKey: 'stale', expectedVersion: 1 }, () => ({
        valid: true,
      })),
    ).toThrow();

    expect(await store.findActiveApprovals(uninitiated.id)).toEqual([]);
    expect(
      store.liquidity.getTransferProposal({ ...liquidityContext(ownerId), proposalId: uninitiated.id }).state.outcome,
    ).toBe('superseded');
    expect(
      store.liquidity.getTransferProposal({ ...liquidityContext(ownerId), proposalId: initiatedProposal.id }).state,
    ).toMatchObject({ phase: 'initiated', outcome: 'superseded' });

    const afterEdit = store.liquidity.getClaimSet(liquidityContext(ownerId));
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
    const ownerSession = saveSession(
      sessionInput('owner-session', 0, 'owner-create'),
      () => ({ valid: true }),
    );
    const readerInput = { ...sessionInput('reader-session', 0, 'reader-create'), actorId: readerId };
    const readerSession = saveSession(readerInput, () => ({ valid: true }));

    expect(store.liquidity.listSpendSessions(liquidityContext(ownerId))).toEqual([ownerSession]);
    expect(store.liquidity.listSpendSessions(liquidityContext(readerId))).toEqual([
      readerSession,
    ]);
    expect(() =>
      store.liquidity.getSpendSession({ ...liquidityContext(readerId), id: ownerSession.id }),
    ).toThrow();
    expect(() =>
      store.liquidity.getSpendSession({ ...liquidityContext(ownerId), id: readerSession.id }),
    ).toThrow();

    revokeReaderCategory('household');
    expect(() =>
      saveSession(
        { ...readerInput, expectedVersion: 1, idempotencyKey: 'reader-split-edit' },
        () => ({ valid: true }),
      ),
    ).toThrow();
    expect(() =>
      store.liquidity.getSpendSession({ ...liquidityContext(readerId), id: readerSession.id }),
    ).toThrow();
    expect(() =>
      store.liquidity.listSpendSessions(liquidityContext(readerId)),
    ).toThrow();
  });

  it('checks adjustment categories independently on save, get, and list after revoke', async () => {
    await grantReaderResources();
    const readerInput = { ...sessionInput('reader-adjustment-session', 0, 'reader-adjustment-create'), actorId: readerId };
    const readerSession = saveSession(readerInput, () => ({ valid: true }));

    revokeReaderCategory('fees');
    expect(() =>
      saveSession(
        { ...readerInput, expectedVersion: 1, idempotencyKey: 'reader-adjustment-edit' },
        () => ({ valid: true }),
      ),
    ).toThrow();
    expect(() =>
      store.liquidity.getSpendSession({ ...liquidityContext(readerId), id: readerSession.id }),
    ).toThrow();
    expect(() =>
      store.liquidity.listSpendSessions(liquidityContext(readerId)),
    ).toThrow();
  });

  it('filters expired sessions and cancels with CAS while preserving all raw cart source fields', () => {
    const expiringInput = sessionInput('expiring', 0, 'expiring-create', {
      expiresAt: expiration,
      items: [{ ...rawItem(), requiredBy: '2098-01-15T00:00:00.000Z' }],
    });
    const expiring = saveSession(expiringInput, () => ({ valid: true }));
    expect(store.liquidity.getSpendSession({ ...liquidityContext(ownerId), id: expiring.id })).toEqual(expiring);
    expect(store.liquidity.listSpendSessions(liquidityContext(ownerId))).toContainEqual(expiring);
    expect(() =>
      store.liquidity.getSpendSession({ ...liquidityContext(ownerId, expiration), id: expiring.id }),
    ).toThrow();
    expect(store.liquidity.listSpendSessions(liquidityContext(ownerId, expiration))).toEqual([]);

    const cancellable = saveSession(
      sessionInput('cancellable', 0, 'cancellable-create'),
      () => ({ valid: true }),
    );
    const cancel = {
      ...liquidityContext(ownerId, cancellation),
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
      store.liquidity.getSpendSession({ ...liquidityContext(ownerId, cancellation), id: cancellable.id }),
    ).toThrow();
    expect(store.liquidity.listSpendSessions(liquidityContext(ownerId, cancellation))).toEqual([expiring]);
  });
  it('round-trips an outside price without a known store and preserves a known store', () => {
    const unknownStore = rawItem();
    delete unknownStore.priceProvenance.store;
    const savedUnknown = saveSession(
      sessionInput('unknown-store', 0, 'unknown-store-create', { items: [unknownStore] }),
      () => ({ valid: true }),
    );
    const loadedUnknown = store.liquidity.getSpendSession({
      ...liquidityContext(ownerId),
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

    const known = saveSession(
      sessionInput('known-store', 0, 'known-store-create'),
      () => ({ valid: true }),
    );
    expect(known.items[0]?.priceProvenance).toEqual(rawItem().priceProvenance);
  });

  it('rejects a blank explicit outside price store', () => {
    const blankStore = rawItem();
    blankStore.priceProvenance.store = ' ';
    expect(() =>
      saveSession(
        sessionInput('blank-store', 0, 'blank-store-create', { items: [blankStore] }),
        () => ({ valid: true }),
      ),
    ).toThrow();
  });


  it('normalizes known-scope legacy carts but leaves unprovenanced sessions private', () => {
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
    const ownerContext = liquidityContext(ownerId);
    const legacyItems = [legacyItem, {
      ...legacyItem,
      id: 'legacy-derived-route',
      routeSelection: {
        explicitAccountId: null,
        sessionAccountId: null,
        approvedPreference: { accountId: 'backup', preferenceId: 'old-preference' },
        historicalRoute: { accountId: 'backup' },
      },
    }];
    const legacyRecord = (id: string) => ({
      actorId: ownerId,
      budgetId,
      id,
      version: 1,
      items: legacyItems,
      accountId: 'cash',
      expiresAt: later,
      createdAt: now,
      updatedAt: now,
    });
    const knownScopeRecord = {
      ...legacyRecord('legacy-cart'),
      spaceId: ownerContext.spaceId,
      membershipId: ownerContext.membershipId,
      governancePolicyVersion: ownerContext.governancePolicyVersion,
    };
    const unprovenancedRecord = legacyRecord('unprovenanced-legacy-session');
    store.close();
    const db = new Database(path);
    db.prepare('INSERT INTO spend_sessions (budget_id,id,record,space_id,membership_id) VALUES (?,?,?,?,?)').run(
      budgetId,
      'legacy-cart',
      JSON.stringify(knownScopeRecord),
      ownerContext.spaceId,
      ownerContext.membershipId,
    );
    db.prepare('INSERT INTO spend_sessions (budget_id,id,record,space_id,membership_id) VALUES (?,?,?,?,?)').run(
      budgetId,
      'unprovenanced-legacy-session',
      JSON.stringify(unprovenancedRecord),
      null,
      null,
    );
    db.close();
    store = new SqliteWorkflowStore(path);

    const legacy = store.liquidity.getSpendSession({ ...liquidityContext(ownerId), id: 'legacy-cart' });
    expect(legacy).toMatchObject({ id: 'legacy-cart', version: 1 });
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
    expect(() => store.liquidity.getSpendSession({
      ...liquidityContext(ownerId), id: 'unprovenanced-legacy-session',
    })).toThrow();

    const rawDb = new Database(path);
    const unprovenancedRow = rawDb
      .prepare('SELECT record,space_id,membership_id FROM spend_sessions WHERE budget_id=? AND id=?')
      .get(budgetId, 'unprovenanced-legacy-session') as
      { record: string; space_id: string | null; membership_id: string | null } | undefined;
    rawDb.close();
    expect(unprovenancedRow).toEqual({
      record: JSON.stringify(unprovenancedRecord),
      space_id: null,
      membership_id: null,
    });

    const explicitEdit = sessionInput('legacy-cart', 1, 'legacy-edit', {
      items: [{ ...rawItem(), id: 'legacy-item' }],
    });
    const edited = saveSession(explicitEdit, () => ({ valid: true }));
    expect(edited.items[0]?.priceProvenance).toEqual(rawItem().priceProvenance);
  });
});
