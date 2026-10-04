import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteWorkflowStore, type NotificationEvent } from '@balanceframe/workflow-store';
import type { FinancialSnapshot, SourceObservation } from '@balanceframe/protocol-generated';
import {
  NotificationRuntime,
  createNativeAnalysisProtocol,
  createObserveComposition,
  financialDecisionDedupKey,
  type AttentionHomeResult,
  type ChannelAdapter,
  type CreateNotificationInput,
  type NativeBindingShim,
  type NotificationPolicy,
} from '../src';

const CAPTURED_AT = '2026-08-23T12:00:00Z';
const STALE_AT = '2026-08-20T09:00:00Z';
const SNAPSHOT_ID = 'snapshot-attention-2026-08-23';
const REVISION_ONE = 'sha256:attention-revision-1';
const REVISION_TWO = 'sha256:attention-revision-2';
const POLICY_VERSION = 'financial-attention-v1';
const BUDGET_ID = 'budget-attention';
const ACTOR_ID = 'actor-attention';
const AUTHORITY_NOW = CAPTURED_AT;
const AUTHORITY_LATER = '2026-08-24T12:00:00.000Z';
const ADMIN_ACTOR_ID = 'actor-attention-admin';
const RECIPIENT_ACTOR_ID = 'actor-attention-recipient';

const authorityStores: SqliteWorkflowStore[] = [];
afterEach(() => {
  for (const store of authorityStores) store.close();
  authorityStores.length = 0;
  vi.useRealTimers();
});

const FINANCIAL_CLASSIFICATIONS = [
  'account_readiness_blocker',
  'transfer_needs_attention',
  'reservation_conflict',
  'commitment_conflict',
  'evidence_connector_degradation',
  'unresolved_material_evidence',
] as const;

const LEGACY_SNAPSHOT = {
  schemaVersion: '1.0',
  actualVersion: '26.8.0',
  snapshotDate: '2026-08-23',
  accounts: [],
  transactions: [],
  categories: [],
  payees: [],
  rules: [],
  schedules: [],
  budgets: [],
  tags: [],
};

const OBSERVATIONS: SourceObservation[] = [
  {
    kind: 'account_freshness',
    scope: { kind: 'account', id: 'account-card' },
    state: 'stale',
    observedAt: STALE_AT,
    evidence: [
      {
        evidenceId: 'bank-sync-card-119',
        kind: 'bank_sync',
        authorized: true,
        redaction: 'visible',
      },
    ],
  },
  {
    kind: 'account_freshness',
    scope: { kind: 'account', id: 'account-cash' },
    state: 'unavailable',
    observedAt: null,
    evidence: [
      {
        evidenceId: 'connector-error-cash-7',
        kind: 'connector_error',
        authorized: false,
        redaction: 'redacted',
      },
    ],
  },
  {
    kind: 'transfer_ambiguity',
    scope: { kind: 'transaction', id: 'transfer-one-sided' },
    state: 'ambiguous',
    observedAt: CAPTURED_AT,
    evidence: [
      {
        evidenceId: 'transfer-counterpart-card',
        kind: 'transfer_candidate',
        authorized: false,
        redaction: 'redacted',
      },
    ],
  },
  {
    kind: 'reconciliation',
    scope: { kind: 'account', id: 'account-checking' },
    state: 'unreconciled',
    observedAt: CAPTURED_AT,
    evidence: [
      {
        evidenceId: 'transaction-pending',
        kind: 'transaction',
        authorized: true,
        redaction: 'visible',
      },
    ],
  },
];

const PRODUCTION_ACCOUNTS = [
  { id: 'account-checking', name: 'Household Checking', accountType: 'checking' },
  { id: 'account-card', name: 'Household Card', accountType: 'creditCard' },
  { id: 'account-cash', name: 'Travel Cash', accountType: 'cash' },
  { id: 'account-joint', name: 'Joint Checking', accountType: 'checking' },
  { id: 'account-wallet', name: 'Spending Wallet', accountType: 'other' },
  { id: 'account-brokerage', name: 'Brokerage', accountType: 'other' },
  { id: 'account-loan', name: 'Car Loan', accountType: 'other' },
] as const;

const UNKNOWN_SOURCE_CAPABILITY_OBSERVATIONS: SourceObservation[] = PRODUCTION_ACCOUNTS.map(
  (account, index) => ({
    kind: index < 4 ? 'account_freshness' : 'account_type',
    scope: { kind: 'account', id: account.id },
    state: 'unavailable',
    observedAt: null,
    evidence: [
      {
        evidenceId: account.id,
        kind: 'account',
        authorized: true,
        redaction: 'visible',
      },
    ],
  }),
);

function financialSnapshot(contentHash = REVISION_ONE): FinancialSnapshot {
  return {
    contractVersion: '1.0',
    snapshotId: SNAPSHOT_ID,
    contentHash,
    source: {
      ledgerBackend: 'actual',
      ledgerId: 'ledger-attention',
      budgetId: BUDGET_ID,
      spaceId: 'space-attention',
    },
    capturedAt: CAPTURED_AT,
    sourceNormalizationVersion: 'normalization-1',
    legacySnapshot: LEGACY_SNAPSHOT,
    coverage: {
      accounts: 'complete',
      transactions: 'empty',
      categories: 'empty',
      payees: 'empty',
      rules: 'empty',
      schedules: 'empty',
      budgets: 'empty',
      tags: 'empty',
    },
    inclusionScope: {
      pendingActivity: 'included',
      unclearedActivity: 'included',
    },
    observations: OBSERVATIONS,
  };
}

function productionShapeSnapshot(): FinancialSnapshot {
  const transactions = Array.from({ length: 101 }, (_, index) => {
    const ordinal = index + 1;
    const isUncategorized = ordinal <= 51;
    return {
      id: `transaction-${ordinal}`,
      accountId: 'account-checking',
      date: '2026-08-23',
      payeeId: null,
      payeeName: ordinal === 99 || ordinal === 101 ? 'Duplicate Merchant' : `Merchant ${ordinal}`,
      categoryId: isUncategorized ? null : 'category-groceries',
      categoryName: isUncategorized ? null : 'Groceries',
      amount: { minorUnits: '-1000', currency: 'USD' },
      cleared: true,
      reconciled: ordinal !== 51,
      importedId: ordinal === 99 || ordinal === 101 ? `import-${ordinal}` : null,
      importedPayee: null,
      notes: null,
      tags: [],
      transferAccountId: ordinal === 100 ? 'account-card' : null,
      subtransactions: [],
    };
  });
  const outageObservation: SourceObservation = {
    kind: 'account_balance',
    scope: { kind: 'account', id: 'account-savings' },
    state: 'unavailable',
    observedAt: null,
    evidence: [
      {
        evidenceId: 'connector-error-savings',
        kind: 'connector_error',
        authorized: true,
        redaction: 'visible',
      },
    ],
  };
  const ordinaryUnclearedActivity: SourceObservation = {
    kind: 'uncleared_activity',
    scope: { kind: 'account', id: 'account-checking' },
    state: 'included',
    observedAt: CAPTURED_AT,
    evidence: [
      {
        evidenceId: 'transaction-51',
        kind: 'transaction',
        authorized: true,
        redaction: 'visible',
      },
    ],
  };
  const trueTransferAndDuplicateAlerts: SourceObservation[] = [
    {
      kind: 'transfer_ambiguity',
      scope: { kind: 'transaction', id: 'transaction-100' },
      state: 'ambiguous',
      observedAt: CAPTURED_AT,
      evidence: [
        {
          evidenceId: 'transaction-100',
          kind: 'transaction',
          authorized: true,
          redaction: 'visible',
        },
      ],
    },
    {
      kind: 'duplicate_candidate',
      scope: { kind: 'transaction', id: 'transaction-101' },
      state: 'present',
      observedAt: CAPTURED_AT,
      evidence: [
        {
          evidenceId: 'transaction-101',
          kind: 'transaction',
          authorized: true,
          redaction: 'visible',
        },
        {
          evidenceId: 'transaction-99',
          kind: 'transaction',
          authorized: true,
          redaction: 'visible',
        },
      ],
    },
  ];

  return {
    ...financialSnapshot(),
    legacySnapshot: {
      ...LEGACY_SNAPSHOT,
      accounts: [
        ...PRODUCTION_ACCOUNTS.map((account) => ({
          ...account,
          offBudget: false,
          isClosed: false,
          clearedBalance: { minorUnits: '100000', currency: 'USD' },
          importedBalance: { minorUnits: '100000', currency: 'USD' },
          mtid: null,
        })),
        {
          id: 'account-savings',
          name: 'Emergency Savings',
          accountType: 'savings',
          offBudget: false,
          isClosed: false,
          clearedBalance: { minorUnits: '250000', currency: 'USD' },
          importedBalance: { minorUnits: '250000', currency: 'USD' },
          mtid: null,
        },
      ],
      transactions,
      categories: [
        {
          id: 'category-groceries',
          name: 'Groceries',
          groupName: 'Everyday Spending',
          isIncome: false,
          mtid: null,
          deleted: false,
        },
      ],
    },
    coverage: {
      accounts: 'complete',
      transactions: 'complete',
      categories: 'complete',
      payees: 'empty',
      rules: 'empty',
      schedules: 'empty',
      budgets: 'empty',
      tags: 'empty',
    },
    observations: [
      ...UNKNOWN_SOURCE_CAPABILITY_OBSERVATIONS,
      ordinaryUnclearedActivity,
      outageObservation,
      ...trueTransferAndDuplicateAlerts,
    ],
  };
}

function nativeShim(overrides: Partial<NativeBindingShim> = {}): NativeBindingShim {
  return {
    evaluateTargetHealth: vi.fn(() =>
      JSON.stringify({
        categories: [],
        overallLabel: 'healthy',
        healthyCount: 0,
        atRiskCount: 0,
        sinkingFundCount: 0,
      }),
    ),
    evaluateFinancialState: vi.fn(() =>
      JSON.stringify({
        overallLabel: 'healthy',
        netWorth: { minorUnits: '0', currency: 'USD' },
        monthlyCashFlow: { minorUnits: '0', currency: 'USD' },
        budgetAdherencePercent: 100,
        categoriesAtRisk: 0,
        sinkingFundsUnderfunded: 0,
        advice: [],
        freshness: null,
      }),
    ),
    ...overrides,
  } as unknown as NativeBindingShim;
}

function ledgerWithFinancialSnapshot(snapshot = financialSnapshot()) {
  const synchronization = { snapshot: snapshot.legacySnapshot, financialSnapshot: snapshot };
  return {
    getLatestSynchronization: vi.fn(() => synchronization),
    synchronize: vi.fn(async () => synchronization),
  };
}

function notificationPolicy(
  channels: NotificationPolicy['channels'] = [
    { type: 'in_app', enabled: true, rateLimitPerMinute: 60, displayName: 'In app' },
  ],
): NotificationPolicy {
  return {
    policyVersion: POLICY_VERSION,
    eligibility: [
      {
        classifications: [...FINANCIAL_CLASSIFICATIONS],
        minSeverity: 'normal',
        requiredCapability: 'notification:receive',
        requiredScope: `budget:${BUDGET_ID}`,
      },
    ],
    recipients: [
      {
        actorId: ACTOR_ID,
        channels: channels.map(({ type }) => type),
        quietHours: null,
      },
    ],
    channels,
    redaction: {
      restricted: { visibleFields: ['title', 'summary', 'classification', 'scope', 'snapshotId'] },
    },
    maxRetries: 3,
    defaultRedactionClass: 'restricted',
  };
}

interface NotificationAuthorityOptions {
  readonly actors?: readonly string[];
  readonly receiveActors?: readonly string[];
  readonly adminActors?: readonly string[];
}

function humanAuth(actorId: string, now = AUTHORITY_NOW) {
  return {
    method: 'human-session' as const,
    actorId,
    sessionId: `fixture-session-${actorId}`,
    reauthenticatedAt: now,
  };
}

async function createNotificationAuthority(options: NotificationAuthorityOptions = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(AUTHORITY_NOW));
  const store = new SqliteWorkflowStore(':memory:');
  authorityStores.push(store);
  const claimId = 'financial-attention-notification-fixture';
  await store.claimBootstrap({ name: 'Attention owner', email: 'attention@example.test', claimId });
  await store.finalizeBootstrap({ claimId, ownerUserId: ACTOR_ID });
  const auth = humanAuth(ACTOR_ID);
  const unboundSpace = store.governance.createSpace({
    actorId: ACTOR_ID,
    name: 'Financial attention fixture',
    kind: 'shared',
    now: AUTHORITY_NOW,
    auth,
  });
  const space = store.governance.bindBudget({
    spaceId: unboundSpace.id,
    budgetId: BUDGET_ID,
    now: AUTHORITY_NOW,
    auth,
  });
  const actors = new Set([
    ACTOR_ID,
    ...(options.actors ?? []),
    ...(options.receiveActors ?? []),
    ...(options.adminActors ?? []),
  ]);
  const memberships = new Map<string, string>();
  for (const actorId of actors) {
    if (actorId !== ACTOR_ID) {
      await store.upsertActorMembership(actorId, 'active', [], '');
      store.governance.addMembership({
        spaceId: space.id,
        actorId,
        validFrom: AUTHORITY_NOW,
        now: AUTHORITY_NOW,
        auth,
      });
    }
    const membership = store.governance.getCurrentMembership({
      spaceId: space.id,
      actorId,
      now: AUTHORITY_NOW,
    });
    if (!membership) throw new Error(`Notification fixture membership missing for ${actorId}`);
    memberships.set(actorId, membership.id);
  }

  for (const actorId of options.receiveActors ?? []) {
    const membershipId = memberships.get(actorId);
    if (!membershipId) throw new Error(`Notification fixture membership missing for ${actorId}`);
    store.governance.provisionResourceGrant({
      spaceId: space.id,
      membershipId,
      actorId,
      budgetId: BUDGET_ID,
      resourceKind: 'budget',
      resourceId: BUDGET_ID,
      capability: 'notification:receive',
      granted: true,
      now: AUTHORITY_NOW,
    });
  }
  for (const actorId of options.adminActors ?? []) {
    const membershipId = memberships.get(actorId);
    if (!membershipId) throw new Error(`Notification fixture membership missing for ${actorId}`);
    store.governance.provisionResourceGrant({
      spaceId: space.id,
      membershipId,
      actorId,
      budgetId: BUDGET_ID,
      resourceKind: 'budget',
      resourceId: BUDGET_ID,
      capability: 'notification:admin',
      granted: true,
      now: AUTHORITY_NOW,
    });
  }
  return { store, spaceId: space.id, memberships };
}

function financialNotificationInput(
  overrides: Partial<CreateNotificationInput> = {},
): CreateNotificationInput {
  return {
    budgetId: BUDGET_ID,
    classification: 'reservation_conflict',
    severity: 'high',
    payload: { title: 'Decision attention', summary: 'Review required' },
    recipientId: ACTOR_ID,
    scope: `budget:${BUDGET_ID}`,
    redactionClass: 'restricted',
    ...overrides,
  };
}

interface NotificationEventOptions {
  readonly classification?: string;
  readonly recipientId?: string;
  readonly scope?: string;
  readonly payload?: Record<string, unknown>;
  readonly redactionClass?: string;
}

async function notificationEvent(
  store: SqliteWorkflowStore,
  options: NotificationEventOptions = {},
) {
  const classification = options.classification ?? 'reservation_conflict';
  const scope = options.scope ?? `budget:${BUDGET_ID}`;
  return store.createNotificationEvent({
    budgetId: BUDGET_ID,
    classification,
    recipientId: options.recipientId ?? ACTOR_ID,
    scope,
    redactionClass: options.redactionClass ?? 'restricted',
    policyVersion: POLICY_VERSION,
    correlationId: 'financial-decision-key',
    payload: {
      title: 'Decision attention',
      summary: 'Review required',
      classification,
      scope,
      snapshotId: SNAPSHOT_ID,
      ...options.payload,
    },
  });
}

async function enqueueNotification(
  store: SqliteWorkflowStore,
  event: NotificationEvent,
) {
  return store.enqueueNotification({
    eventId: event.id,
    deliveryKey: `delivery-${event.id}`,
    channelType: 'in_app',
    maxAttempts: 3,
    correlationId: event.correlationId,
  });
}

async function createNotificationDelivery(
  store: SqliteWorkflowStore,
  options: NotificationEventOptions = {},
) {
  const event = await notificationEvent(store, options);
  const record = await enqueueNotification(store, event);
  return { event, record };
}
function notificationRowCounts(store: SqliteWorkflowStore) {
  const eventRows = store['db']
    .prepare('SELECT COUNT(*) AS count FROM notification_events')
    .get() as { count: number };
  const outboxRows = store['db']
    .prepare('SELECT COUNT(*) AS count FROM notification_outbox')
    .get() as { count: number };
  return { events: eventRows.count, outbox: outboxRows.count };
}

function channelAdapter(deliver: ChannelAdapter['deliver']): ChannelAdapter {
  return { channelType: 'in_app', isHealthy: () => true, deliver };
}

describe('canonical financial observations on the existing attention home result', () => {
  it('keeps complete account enumeration quiet while unresolved enumeration still blocks', async () => {
    const protocol = await createNativeAnalysisProtocol(async () => nativeShim());
    const snapshot = financialSnapshot();
    snapshot.observations = [
      {
        kind: 'account_collection_coverage',
        scope: { kind: 'global' },
        state: 'complete',
        observedAt: CAPTURED_AT,
        evidence: [],
      },
    ];
    const complete = await protocol.attentionHome!(ledgerWithFinancialSnapshot(snapshot), {});
    expect(complete.blockers).toEqual([]);
    expect(complete.alerts).toEqual([]);
    snapshot.observations[0] = { ...snapshot.observations[0]!, state: 'unknown', observedAt: null };
    const unknown = await protocol.attentionHome!(ledgerWithFinancialSnapshot(snapshot), {});
    expect(unknown.blockers).toEqual([
      expect.objectContaining({
        code: 'account_freshness_coverage',
        classification: 'unresolved_material_evidence',
        severity: 'warning',
        issue: expect.objectContaining({ effect: 'blocks', scope: { kind: 'global' } }),
      }),
    ]);
  });

  it('classifies actionable observations and carries one shared issue plus finding metadata', async () => {
    const protocol = await createNativeAnalysisProtocol(async () => nativeShim());
    const result = await protocol.attentionHome!(ledgerWithFinancialSnapshot(), {});

    const byClassification = new Map(
      result.blockers.map((blocker) => [blocker.classification, blocker]),
    );

    expect([...byClassification.keys()]).toEqual(
      expect.arrayContaining([
        'account_readiness_blocker',
        'evidence_connector_degradation',
        'unresolved_material_evidence',
      ]),
    );
    expect([...byClassification.keys()]).not.toContain('transfer_needs_attention');

    expect(byClassification.get('account_readiness_blocker')).toEqual(
      expect.objectContaining({
        code: 'account_freshness_coverage',
        snapshotId: SNAPSHOT_ID,
        policyVersion: POLICY_VERSION,
        revision: REVISION_ONE,
        findingStatus: 'open',
        findingVersion: 1,
        issue: {
          code: 'account_freshness_coverage',
          severity: 'warning',
          effect: 'blocks',
          scope: { kind: 'account', id: 'account-card' },
          evidence: OBSERVATIONS[0].evidence,
          remediation: expect.any(Object),
          redaction: 'visible',
        },
      }),
    );
    expect(
      result.alerts.filter(({ classification }) => classification === 'transfer_needs_attention'),
    ).toEqual([
      expect.objectContaining({
        code: 'duplicate_transfer_ambiguity',
        message: 'A possible duplicate or incomplete transfer needs review.',
        severity: 'warning',
        scopeLabel: 'Transfers',
        occurrenceCount: 1,
        snapshotId: SNAPSHOT_ID,
        revision: REVISION_ONE,
        issue: expect.objectContaining({
          code: 'duplicate_transfer_ambiguity',
          effect: 'qualifies',
          scope: { kind: 'global' },
          evidence: [],
          redaction: 'redacted',
        }),
      }),
    ]);
    expect(byClassification.get('evidence_connector_degradation')).toEqual(
      expect.objectContaining({
        issue: expect.objectContaining({
          scope: { kind: 'account', id: 'account-cash' },
          evidence: OBSERVATIONS[1].evidence,
          redaction: 'redacted',
        }),
      }),
    );
  });

  it('keeps production-shaped source capability gaps quiet while preserving material attention', async () => {
    const protocol = await createNativeAnalysisProtocol(async () =>
      nativeShim({
        evaluateTargetHealth: vi.fn(() =>
          JSON.stringify({
            categories: [
              {
                categoryId: 'category-groceries',
                categoryName: 'category-groceries',
                budgeted: { minorUnits: '50000', currency: 'USD' },
                spent: { minorUnits: '55000', currency: 'USD' },
                remaining: { minorUnits: '-5000', currency: 'USD' },
                healthLabel: 'overspent',
                isSinkingFund: false,
                targetAmount: null,
                targetProgress: null,
              },
            ],
            overallLabel: 'at_risk',
            healthyCount: 0,
            atRiskCount: 1,
            sinkingFundCount: 0,
          }),
        ),
      }),
    );
    const snapshot = productionShapeSnapshot();
    expect(snapshot.legacySnapshot.transactions).toHaveLength(101);
    expect(UNKNOWN_SOURCE_CAPABILITY_OBSERVATIONS).toHaveLength(7);
    const result = await protocol.attentionHome!(ledgerWithFinancialSnapshot(snapshot), {});
    const unknownCapabilityScopes = new Set(
      UNKNOWN_SOURCE_CAPABILITY_OBSERVATIONS.map(({ scope }) => ('id' in scope ? scope.id : '')),
    );
    const noisyUnknownCapabilityBlockers = result.blockers.filter(
      ({ classification, entityId }) =>
        entityId !== undefined &&
        unknownCapabilityScopes.has(entityId) &&
        (classification === 'evidence_connector_degradation' ||
          classification === 'unresolved_material_evidence'),
    );

    expect(noisyUnknownCapabilityBlockers).toHaveLength(0);
    expect(result.blockers).toHaveLength(2);
    expect(result.blockers.filter(({ code }) => code === 'uncategorized_transactions')).toEqual([
      expect.objectContaining({
        message: '51 transaction(s) lack categories',
      }),
    ]);
    expect(
      result.blockers.filter(({ classification }) => classification === 'transfer_needs_attention'),
    ).toHaveLength(0);
    const trueTransferAlerts = result.alerts.filter(
      ({ classification }) => classification === 'transfer_needs_attention',
    );
    expect(trueTransferAlerts).toEqual([
      expect.objectContaining({
        code: 'duplicate_transfer_ambiguity',
        message: '2 possible duplicate or incomplete transfers need review',
        severity: 'warning',
        scopeLabel: 'Transfers',
        occurrenceCount: 2,
        issue: expect.objectContaining({
          effect: 'qualifies',
          scope: { kind: 'global' },
          evidence: snapshot.observations
            .filter(({ kind }) => kind === 'transfer_ambiguity' || kind === 'duplicate_candidate')
            .flatMap(({ evidence }) => evidence),
        }),
      }),
    ]);

    const scopedOutage = result.blockers.find(({ entityId }) => entityId === 'account-savings');
    expect(scopedOutage).toEqual(
      expect.objectContaining({
        classification: 'evidence_connector_degradation',
        scopeLabel: 'Emergency Savings',
        entityId: 'account-savings',
        issue: expect.objectContaining({
          scope: { kind: 'account', id: 'account-savings' },
        }),
      }),
    );
    expect(result.alerts).toContainEqual(
      expect.objectContaining({
        code: 'category_overspent',
        scopeLabel: 'Groceries',
        categoryId: 'category-groceries',
      }),
    );
  });

  it('counts only actionable on-budget purchases while preserving transfer attention', async () => {
    const base = productionShapeSnapshot();
    const checkingAccount = base.legacySnapshot.accounts[0];
    const transaction = base.legacySnapshot.transactions[0];
    const focusedSnapshot: FinancialSnapshot = {
      ...base,
      legacySnapshot: {
        ...base.legacySnapshot,
        accounts: [
          checkingAccount,
          {
            ...checkingAccount,
            id: 'account-off-budget',
            name: 'Off-budget Account',
            offBudget: true,
          },
        ],
        transactions: [
          {
            ...transaction,
            id: 'purchase-on-budget',
            payeeName: 'Actionable Purchase',
            categoryId: null,
            categoryName: null,
            cleared: true,
            reconciled: true,
            transferAccountId: null,
          },
          {
            ...transaction,
            id: 'purchase-off-budget',
            accountId: 'account-off-budget',
            payeeName: 'Off-budget Purchase',
            categoryId: null,
            categoryName: null,
            cleared: true,
            reconciled: true,
            transferAccountId: null,
          },
          {
            ...transaction,
            id: 'transfer-between-accounts',
            payeeName: 'Transfer to Card',
            categoryId: null,
            categoryName: null,
            cleared: true,
            reconciled: true,
            transferAccountId: 'account-card',
          },
          {
            ...transaction,
            id: 'categorized-purchase',
            payeeName: 'Categorized Purchase',
            categoryId: 'category-groceries',
            categoryName: 'Groceries',
            cleared: true,
            reconciled: true,
            transferAccountId: null,
          },
          {
            ...transaction,
            id: 'pending-on-budget',
            payeeName: 'Pending Actionable Purchase',
            categoryId: null,
            categoryName: null,
            cleared: false,
            reconciled: false,
            transferAccountId: null,
          },
        ],
      },
      observations: [
        {
          kind: 'transfer_ambiguity',
          scope: { kind: 'transaction', id: 'transfer-between-accounts' },
          state: 'ambiguous',
          observedAt: CAPTURED_AT,
          evidence: [
            {
              evidenceId: 'transfer-between-accounts',
              kind: 'transaction',
              authorized: true,
              redaction: 'visible',
            },
          ],
        },
      ],
    };
    const protocol = await createNativeAnalysisProtocol(async () => nativeShim());
    const result = await protocol.attentionHome!(ledgerWithFinancialSnapshot(focusedSnapshot), {});

    expect(result.blockers.filter(({ code }) => code === 'uncategorized_transactions')).toEqual([
      {
        code: 'uncategorized_transactions',
        message: '2 transaction(s) lack categories',
        severity: 'warning',
        entityType: 'transaction',
      },
    ]);
    expect(
      result.blockers.filter(({ classification }) => classification === 'transfer_needs_attention'),
    ).toHaveLength(0);
    expect(
      result.alerts.filter(({ classification }) => classification === 'transfer_needs_attention'),
    ).toEqual([
      expect.objectContaining({
        message: 'A possible duplicate or incomplete transfer needs review.',
        severity: 'warning',
        scopeLabel: 'Transfers',
        occurrenceCount: 1,
        issue: expect.objectContaining({
          effect: 'qualifies',
          scope: { kind: 'global' },
          evidence: focusedSnapshot.observations[0].evidence,
          redaction: 'visible',
        }),
      }),
    ]);
  });

  it('groups transfer and duplicate observations into one bounded qualifying alert', async () => {
    const observations = Array.from(
      { length: 5 },
      (_, observationIndex) =>
        ({
          kind: observationIndex === 4 ? 'duplicate_candidate' : 'transfer_ambiguity',
          scope: { kind: 'transaction', id: `transfer-${observationIndex + 1}` },
          state: observationIndex === 4 ? 'present' : 'ambiguous',
          observedAt: CAPTURED_AT,
          evidence: Array.from({ length: 3 }, (_, evidenceIndex) => ({
            evidenceId: `transfer-${observationIndex + 1}-evidence-${evidenceIndex + 1}`,
            kind: 'transaction',
            authorized: observationIndex !== 0 || evidenceIndex !== 0,
            redaction: observationIndex === 0 && evidenceIndex === 0 ? 'redacted' : 'visible',
          })),
        }) satisfies SourceObservation,
    );
    const snapshot: FinancialSnapshot = {
      ...productionShapeSnapshot(),
      observations,
    };
    const combinedEvidence = observations
      .flatMap(({ evidence }) => evidence)
      .filter(({ authorized, redaction }) => authorized && redaction === 'visible')
      .slice(0, 10);
    const protocol = await createNativeAnalysisProtocol(async () => nativeShim());
    const result = await protocol.attentionHome!(ledgerWithFinancialSnapshot(snapshot), {});

    expect(
      result.blockers.filter(({ classification }) => classification === 'transfer_needs_attention'),
    ).toHaveLength(0);
    expect(
      result.blockers.filter(({ code }) => code === 'uncategorized_transactions'),
    ).toHaveLength(1);
    expect(
      result.alerts.filter(({ classification }) => classification === 'transfer_needs_attention'),
    ).toEqual([
      expect.objectContaining({
        code: 'duplicate_transfer_ambiguity',
        message: '5 possible duplicate or incomplete transfers need review',
        severity: 'warning',
        scopeLabel: 'Transfers',
        occurrenceCount: 5,
        issue: expect.objectContaining({
          code: 'duplicate_transfer_ambiguity',
          severity: 'warning',
          effect: 'qualifies',
          scope: { kind: 'global' },
          evidence: combinedEvidence,
          redaction: 'redacted',
        }),
      }),
    ]);
    expect(combinedEvidence).toHaveLength(10);
  });

  it('reports the representative actionable backlog as 31 instead of raw null-category totals', async () => {
    const base = productionShapeSnapshot();
    const checkingAccount = base.legacySnapshot.accounts[0];
    const transactions = base.legacySnapshot.transactions.map((transaction, index) => {
      const ordinal = index + 1;
      if (ordinal >= 32 && ordinal <= 51) {
        return { ...transaction, accountId: 'account-off-budget' };
      }
      if (ordinal >= 52 && ordinal <= 54) {
        return {
          ...transaction,
          categoryId: null,
          categoryName: null,
          transferAccountId: 'account-card',
        };
      }
      return transaction;
    });
    const representativeSnapshot: FinancialSnapshot = {
      ...base,
      legacySnapshot: {
        ...base.legacySnapshot,
        accounts: [
          ...base.legacySnapshot.accounts,
          {
            ...checkingAccount,
            id: 'account-off-budget',
            name: 'Off-budget Account',
            offBudget: true,
          },
        ],
        transactions,
      },
    };
    const nullCategoryTransactions = transactions.filter(({ categoryId }) => categoryId === null);
    const nonTransferNullCategoryTransactions = nullCategoryTransactions.filter(
      ({ transferAccountId }) => transferAccountId === null,
    );
    const protocol = await createNativeAnalysisProtocol(async () => nativeShim());
    const result = await protocol.attentionHome!(
      ledgerWithFinancialSnapshot(representativeSnapshot),
      {},
    );

    expect(transactions).toHaveLength(101);
    expect(nullCategoryTransactions).toHaveLength(54);
    expect(nonTransferNullCategoryTransactions).toHaveLength(51);
    expect(result.blockers.filter(({ code }) => code === 'uncategorized_transactions')).toEqual([
      expect.objectContaining({
        message: '31 transaction(s) lack categories',
      }),
    ]);
  });

  it('derives recurrences only from ordinary same-account purchases', async () => {
    const base = productionShapeSnapshot();
    const template = base.legacySnapshot.transactions[0];
    const recurrenceTransaction = (
      id: string,
      accountId: string,
      payeeId: string,
      payeeName: string,
      date: string,
      minorUnits: string,
      transferAccountId: string | null = null,
    ) => ({
      ...template,
      id,
      accountId,
      payeeId,
      payeeName,
      date,
      amount: { minorUnits, currency: 'USD' },
      categoryId: 'category-groceries',
      categoryName: 'Groceries',
      transferAccountId,
    });
    const snapshot: FinancialSnapshot = {
      ...base,
      legacySnapshot: {
        ...base.legacySnapshot,
        transactions: [
          recurrenceTransaction(
            'starting-balance-1',
            'account-checking',
            'payee-starting-balance',
            '  Starting Balance  ',
            '2026-08-01',
            '100000',
          ),
          recurrenceTransaction(
            'starting-balance-2',
            'account-checking',
            'payee-starting-balance',
            'starting balance',
            '2026-08-02',
            '200000',
          ),
          recurrenceTransaction(
            'starting-balance-3',
            'account-checking',
            'payee-starting-balance',
            ' STARTING   BALANCE ',
            '2026-08-03',
            '300000',
          ),
          ...Array.from({ length: 3 }, (_, index) =>
            recurrenceTransaction(
              `transfer-${index + 1}`,
              'account-checking',
              'payee-transfer',
              'Transfer to Card',
              `2026-08-${String(index + 4).padStart(2, '0')}`,
              '-2500',
              'account-card',
            ),
          ),
          recurrenceTransaction(
            'coffee-1',
            'account-checking',
            'payee-coffee',
            'Coffee Club',
            '2026-08-08',
            '-1100',
          ),
          recurrenceTransaction(
            'coffee-2',
            'account-checking',
            'payee-coffee',
            'Coffee Club',
            '2026-08-14',
            '-1200',
          ),
          recurrenceTransaction(
            'coffee-3',
            'account-checking',
            'payee-coffee',
            'Coffee Club',
            '2026-08-20',
            '-1300',
          ),
          recurrenceTransaction(
            'shared-payee-checking-1',
            'account-checking',
            'payee-shared',
            'Shared Merchant',
            '2026-08-09',
            '-1000',
          ),
          recurrenceTransaction(
            'shared-payee-checking-2',
            'account-checking',
            'payee-shared',
            'Shared Merchant',
            '2026-08-16',
            '-1000',
          ),
          recurrenceTransaction(
            'shared-payee-card-1',
            'account-card',
            'payee-shared',
            'Shared Merchant',
            '2026-08-10',
            '-1000',
          ),
          recurrenceTransaction(
            'shared-payee-card-2',
            'account-card',
            'payee-shared',
            'Shared Merchant',
            '2026-08-17',
            '-1000',
          ),
        ],
        payees: [
          {
            id: 'payee-starting-balance',
            name: 'Starting Balance',
            transferAccountId: null,
            mtid: null,
          },
          {
            id: 'payee-transfer',
            name: 'Transfer to Card',
            transferAccountId: 'account-card',
            mtid: null,
          },
          {
            id: 'payee-coffee',
            name: 'Coffee Club',
            transferAccountId: null,
            mtid: null,
          },
          {
            id: 'payee-shared',
            name: 'Shared Merchant',
            transferAccountId: null,
            mtid: null,
          },
        ],
      },
      observations: [],
    };
    const protocol = await createNativeAnalysisProtocol(async () => nativeShim());
    const result = await protocol.attentionHome!(ledgerWithFinancialSnapshot(snapshot), {});

    expect(result.recurrences).toEqual([
      {
        payeeName: 'Coffee Club',
        amount: { minorUnits: '-1300', currency: 'USD' },
        frequency: 'irregular',
        occurrences: 3,
        lastOccurrence: '2026-08-20',
        isEstimated: false,
      },
    ]);
  });

  it('deduplicates repeat observations but emits a new identity for a changed revision', async () => {
    const protocol = await createNativeAnalysisProtocol(async () => nativeShim());
    const first = await protocol.attentionHome!(ledgerWithFinancialSnapshot(), {});
    const repeated = await protocol.attentionHome!(ledgerWithFinancialSnapshot(), {});
    const revised = await protocol.attentionHome!(
      ledgerWithFinancialSnapshot(financialSnapshot(REVISION_TWO)),
      {},
    );

    const keyFor = (result: AttentionHomeResult) =>
      result.blockers.find(({ classification }) => classification === 'account_readiness_blocker')
        ?.dedupKey;

    expect(keyFor(repeated)).toBe(keyFor(first));
    expect(keyFor(revised)).not.toBe(keyFor(first));
  });
});

describe('financial decision notification identity and policy', () => {
  it('uses classification, canonical scope, snapshot, policy, and revision as its full identity', () => {
    const identity = {
      classification: 'reservation_conflict',
      scope: { kind: 'category' as const, id: 'category-groceries' },
      snapshotId: SNAPSHOT_ID,
      policyVersion: POLICY_VERSION,
      revision: REVISION_ONE,
    };

    const first = financialDecisionDedupKey(identity);
    const repeated = financialDecisionDedupKey({ ...identity });

    expect(repeated).toBe(first);
    for (const changed of [
      { ...identity, classification: 'commitment_conflict' },
      { ...identity, scope: { kind: 'category' as const, id: 'category-rent' } },
      { ...identity, snapshotId: 'snapshot-next' },
      { ...identity, policyVersion: 'financial-attention-v2' },
      { ...identity, revision: REVISION_TWO },
    ]) {
      expect(financialDecisionDedupKey(changed)).not.toBe(first);
    }
  });

  it('makes every financial finding classification eligible in the default composition policy', async () => {
    const store = {
      cancelPendingJobs: vi.fn(),
      deleteActorMembership: vi.fn(),
      recordExport: vi.fn(),
      getLastExport: vi.fn(),
      deleteScopeData: vi.fn(),
      createNotificationEvent: vi.fn(),
      getNotificationEvent: vi.fn(),
      enqueueNotification: vi.fn(),
      claimNotificationDelivery: vi.fn(),
      completeNotificationDelivery: vi.fn(),
      failNotificationDelivery: vi.fn(),
      acknowledgeNotification: vi.fn(),
      suppressNotification: vi.fn(),
      getOutboxRecord: vi.fn(),
      getPendingNotifications: vi.fn(),
      getRetryableNotifications: vi.fn(),
      getDeliveryAttempts: vi.fn(),
      listOutboxRecords: vi.fn(),
      getNotificationPolicy: vi.fn(),
      appendAuditRecord: vi.fn(),
    };
    const composition = await createObserveComposition({
      analysisProtocol: {} as never,
      workflowStore: store as never,
      actorId: ACTOR_ID,
      requestId: 'request-attention-2026-08-23',
    });

    expect(composition.notificationRuntime).not.toBeNull();
    for (const classification of FINANCIAL_CLASSIFICATIONS) {
      expect(composition.notificationRuntime!.evaluateEligibility(classification, 'high')).toBe(
        true,
      );
    }
  });

  it('rejects an explicitly targeted recipient outside the active notification policy', async () => {
    const { store } = await createNotificationAuthority({ receiveActors: [ACTOR_ID] });
    const runtime = new NotificationRuntime(store, notificationPolicy(), []);

    await expect(
      runtime.create(
        financialNotificationInput({ recipientId: 'actor-outside-policy' }),
      ),
    ).rejects.toMatchObject({ code: 'RECIPIENT_MISMATCH' });

    expect(notificationRowCounts(store)).toEqual({ events: 0, outbox: 0 });
  });

  it('rejects a notification scope that differs from the active policy before persistence', async () => {
    const { store } = await createNotificationAuthority({ receiveActors: [ACTOR_ID] });
    const runtime = new NotificationRuntime(store, notificationPolicy(), []);

    await expect(
      runtime.create(
        financialNotificationInput({ scope: 'budget:budget-outside-policy' }),
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' });

    expect(notificationRowCounts(store)).toEqual({ events: 0, outbox: 0 });
  });

  it('requires a current scoped grant; registry wildcard capabilities and hooks cannot grant delivery', async () => {
    const withoutGrant = await createNotificationAuthority();
    const ungrantedRuntime = new NotificationRuntime(
      withoutGrant.store,
      notificationPolicy(),
      [],
    );
    ungrantedRuntime.setReAuthorizationHook(async () => true);

    await expect(
      ungrantedRuntime.create(financialNotificationInput()),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(await withoutGrant.store.getActorMembership(ACTOR_ID)).toMatchObject({
      status: 'active',
      capabilities: expect.arrayContaining(['notification:receive', 'notification:admin']),
      scope: '*',
    });
    expect(notificationRowCounts(withoutGrant.store)).toEqual({ events: 0, outbox: 0 });
    const withGrant = await createNotificationAuthority({ receiveActors: [ACTOR_ID] });
    const additionallyDenied = new NotificationRuntime(
      withGrant.store,
      notificationPolicy(),
      [],
    );
    additionallyDenied.setReAuthorizationHook(async () => false);

    await expect(
      additionallyDenied.create(financialNotificationInput()),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(notificationRowCounts(withGrant.store)).toEqual({ events: 0, outbox: 0 });
  });

  it('creates a policy recipient through the current budget-bound membership and resource grant', async () => {
    const { store, spaceId, memberships } = await createNotificationAuthority({
      receiveActors: [ACTOR_ID],
    });
    const runtime = new NotificationRuntime(store, notificationPolicy(), []);

    const result = await runtime.create(financialNotificationInput());

    expect(result.event).toMatchObject({
      budgetId: BUDGET_ID,
      spaceId,
      recipientId: ACTOR_ID,
      recipientMembershipId: memberships.get(ACTOR_ID),
      scope: `budget:${BUDGET_ID}`,
    });
    expect(result.outboxRecords).toHaveLength(1);
    expect((await store.listOutboxRecords()).map(({ id }) => id)).toEqual([
      result.outboxRecords[0]!.id,
    ]);
    expect(notificationRowCounts(store)).toEqual({ events: 1, outbox: 1 });
  });

  it('uses only a current exact notification:admin grant for unredacted event reads', async () => {
    const { store } = await createNotificationAuthority({
      actors: [ADMIN_ACTOR_ID],
      receiveActors: [ACTOR_ID],
      adminActors: [ADMIN_ACTOR_ID],
    });
    const event = await notificationEvent(store, {
      payload: { internalFinding: 'private finding' },
    });
    const runtime = new NotificationRuntime(store, notificationPolicy(), []);

    expect(await runtime.redactForActor(event, ACTOR_ID)).toEqual({
      title: 'Decision attention',
      summary: 'Review required',
      classification: 'reservation_conflict',
      scope: `budget:${BUDGET_ID}`,
      snapshotId: SNAPSHOT_ID,
    });
    expect(await runtime.redactForActor(event, ADMIN_ACTOR_ID)).toEqual({
      title: 'Decision attention',
      summary: 'Review required',
      classification: 'reservation_conflict',
      scope: `budget:${BUDGET_ID}`,
      snapshotId: SNAPSHOT_ID,
      internalFinding: 'private finding',
    });
  });
});

describe('financial decision notification delivery isolation', () => {
  it('rechecks the current scoped grant at dispatch and suppresses a revoked recipient', async () => {
    const { store, spaceId, memberships } = await createNotificationAuthority({
      receiveActors: [ACTOR_ID],
    });
    const { record } = await createNotificationDelivery(store);
    const membershipId = memberships.get(ACTOR_ID);
    if (!membershipId) throw new Error('Recipient membership missing');
    store.governance.provisionResourceGrant({
      spaceId,
      membershipId,
      actorId: ACTOR_ID,
      budgetId: BUDGET_ID,
      resourceKind: 'budget',
      resourceId: BUDGET_ID,
      capability: 'notification:receive',
      granted: false,
      now: AUTHORITY_NOW,
    });
    const deliver = vi.fn(async () => ({ ok: true, code: 'accepted' }));
    const runtime = new NotificationRuntime(
      store,
      notificationPolicy(),
      [channelAdapter(deliver)],
    );

    const result = await runtime.dispatch(record.id, 'claim-revoked');
    const current = await store.getOutboxRecord(record.id);

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('Recipient authorization revoked');
    expect(current).toMatchObject({
      status: 'failed',
      failureReason: 'Recipient authorization revoked',
    });
    expect(await store.getDeliveryAttempts(record.id)).toHaveLength(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rejects an event whose scope no longer matches the classification policy', async () => {
    const { store } = await createNotificationAuthority({ receiveActors: [ACTOR_ID] });
    const { record } = await createNotificationDelivery(store, {
      scope: 'budget:budget-outside-policy',
    });
    const deliver = vi.fn(async () => ({ ok: true, code: 'accepted' }));
    const runtime = new NotificationRuntime(
      store,
      notificationPolicy(),
      [channelAdapter(deliver)],
    );

    const result = await runtime.dispatch(record.id, 'claim-scope-mismatch');

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('Notification classification is no longer eligible');
    expect(await store.getOutboxRecord(record.id)).toMatchObject({ status: 'failed' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not deliver a prior membership period to a recipient who rejoins with a new epoch', async () => {
    const { store, spaceId, memberships } = await createNotificationAuthority({
      actors: [RECIPIENT_ACTOR_ID],
      receiveActors: [RECIPIENT_ACTOR_ID],
    });
    const { event, record } = await createNotificationDelivery(store, {
      recipientId: RECIPIENT_ACTOR_ID,
    });
    const oldMembershipId = memberships.get(RECIPIENT_ACTOR_ID);
    if (!oldMembershipId) throw new Error('Original recipient membership missing');
    expect(event.recipientMembershipId).toBe(oldMembershipId);

    vi.setSystemTime(new Date(AUTHORITY_LATER));
    const auth = humanAuth(ACTOR_ID, AUTHORITY_LATER);
    store.governance.revokeMembership({
      spaceId,
      membershipId: oldMembershipId,
      now: AUTHORITY_LATER,
      auth,
    });
    const rejoined = store.governance.addMembership({
      spaceId,
      actorId: RECIPIENT_ACTOR_ID,
      validFrom: AUTHORITY_LATER,
      now: AUTHORITY_LATER,
      auth,
    });
    store.governance.provisionResourceGrant({
      spaceId,
      membershipId: rejoined.id,
      actorId: RECIPIENT_ACTOR_ID,
      budgetId: BUDGET_ID,
      resourceKind: 'budget',
      resourceId: BUDGET_ID,
      capability: 'notification:receive',
      granted: true,
      now: AUTHORITY_LATER,
    });
    const deliver = vi.fn(async () => ({ ok: true, code: 'accepted' }));
    const runtime = new NotificationRuntime(
      store,
      notificationPolicy(),
      [channelAdapter(deliver)],
    );

    const result = await runtime.dispatch(record.id, 'claim-rejoined');

    expect(rejoined.id).not.toBe(oldMembershipId);
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe('Recipient authorization revoked');
    expect(await store.getOutboxRecord(record.id)).toMatchObject({ status: 'failed' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('redacts private payload fields before an authorized adapter receives them', async () => {
    const secret = 'provider-secret-that-must-not-reach-an-adapter';
    const { store } = await createNotificationAuthority({ receiveActors: [ACTOR_ID] });
    const { record } = await createNotificationDelivery(store, {
      payload: {
        rawEvidence: { accountId: 'account-restricted', value: secret },
        rawPayload: { providerResponse: secret },
        secrets: { accessToken: secret },
      },
    });
    const deliver = vi.fn(async () => ({ ok: true, code: 'accepted' }));
    const runtime = new NotificationRuntime(
      store,
      notificationPolicy(),
      [channelAdapter(deliver)],
    );

    const result = await runtime.dispatch(record.id, 'claim-restricted');

    expect(result.status).toBe('delivered');
    expect(deliver).toHaveBeenCalledWith(
      {
        title: 'Decision attention',
        summary: 'Review required',
        classification: 'reservation_conflict',
        scope: `budget:${BUDGET_ID}`,
        snapshotId: SNAPSHOT_ID,
      },
      ACTOR_ID,
    );
    const adapterPayload = deliver.mock.calls[0]?.[0];
    expect(adapterPayload).not.toHaveProperty('rawEvidence');
    expect(adapterPayload).not.toHaveProperty('rawPayload');
    expect(adapterPayload).not.toHaveProperty('secrets');
    expect(JSON.stringify(adapterPayload)).not.toContain(secret);
  });

  it('allows one delivery to fail and retry without blocking an independent delivery', async () => {
    const { store } = await createNotificationAuthority({ receiveActors: [ACTOR_ID] });
    const failed = await createNotificationDelivery(store, {
      classification: 'reservation_conflict',
    });
    const delivered = await createNotificationDelivery(store, {
      classification: 'commitment_conflict',
    });
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'email provider unavailable' })
      .mockResolvedValueOnce({ ok: true, code: 'accepted' })
      .mockResolvedValueOnce({ ok: true, code: 'accepted' });
    const runtime = new NotificationRuntime(
      store,
      notificationPolicy(),
      [channelAdapter(deliver)],
    );

    const failedResult = await runtime.dispatch(failed.record.id, 'claim-failed');
    const deliveredResult = await runtime.dispatch(delivered.record.id, 'claim-delivered');

    expect(failedResult.status).toBe('retryable');
    expect(deliveredResult.status).toBe('delivered');
    expect((await store.getRetryableNotifications()).map(({ id }) => id)).toEqual([failed.record.id]);
    expect(await runtime.processRetries()).toMatchObject([{ status: 'delivered' }]);
    expect(await store.getOutboxRecord(failed.record.id)).toMatchObject({
      status: 'delivered',
      attemptCount: 2,
    });
    expect(await store.getOutboxRecord(delivered.record.id)).toMatchObject({
      status: 'delivered',
      attemptCount: 1,
    });
  });

  it.each(['inactive', 'suspended'] as const)(
    'composition denies delivery when the registered recipient is %s',
    async (status) => {
      const { store } = await createNotificationAuthority({ receiveActors: [ACTOR_ID] });
      const { record } = await createNotificationDelivery(store);
      await store.upsertActorMembership(
        ACTOR_ID,
        status,
        ['notification:receive', 'notification:admin'],
        '*',
      );
      const composition = await createObserveComposition({
        analysisProtocol: {} as never,
        workflowStore: store,
        notificationPolicy: notificationPolicy(),
        actorId: ACTOR_ID,
      });

      const result = await composition.notificationRuntime!.dispatch(record.id, 'claim-current');

      expect(result.status).toBe('failed');
      expect(result.errorMessage).toBe('Recipient authorization revoked');
      expect(await store.getOutboxRecord(record.id)).toMatchObject({ status: 'failed' });
    },
  );
});
