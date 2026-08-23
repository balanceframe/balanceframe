import { describe, expect, it, vi } from 'vitest';
import type { FinancialSnapshot, SourceObservation } from '@balanceframe/protocol-generated';
import {
  NotificationRuntime,
  createNativeAnalysisProtocol,
  createObserveComposition,
  financialDecisionDedupKey,
  type ChannelAdapter,
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

function notificationEvent(classification = 'reservation_conflict') {
  return {
    id: `event-${classification}`,
    eventVersion: 1,
    budgetId: BUDGET_ID,
    classification,
    recipientId: ACTOR_ID,
    scope: `budget:${BUDGET_ID}`,
    redactionClass: 'restricted',
    channelConfigVersion: null,
    policyVersion: POLICY_VERSION,
    correlationId: 'financial-decision-key',
    payload: JSON.stringify({ title: 'Decision attention', summary: 'Review required' }),
    createdAt: CAPTURED_AT,
  };
}

function outbox(id: string, eventId: string) {
  return {
    id,
    eventId,
    deliveryKey: `delivery-${id}`,
    channelType: 'in_app',
    channelConfigVersion: null,
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    claimToken: null,
    claimExpiresAt: null,
    lastAttemptedAt: null,
    nextAttemptAt: null,
    acknowledgedAt: null,
    failedAt: null,
    failureReason: null,
    suppressedAt: null,
    suppressedReason: null,
    correlationId: 'financial-decision-key',
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
  };
}

describe('canonical financial observations on the existing attention home result', () => {
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

    const keyFor = (result: Awaited<ReturnType<NonNullable<typeof protocol.attentionHome>>>) =>
      result.blockers.find(({ classification }) => classification === 'account_readiness_blocker')
        ?.dedupKey;

    expect(keyFor(first)).toEqual(expect.any(String));
    expect(keyFor(first)?.length).toBeGreaterThan(0);
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
      getActorMembership: vi.fn(),
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

  it('rejects an explicitly targeted recipient that is not a recipient in the active policy', async () => {
    const store = {
      createNotificationEvent: vi.fn(),
      enqueueNotification: vi.fn(),
      appendAuditRecord: vi.fn(),
      getActorMembership: vi.fn(),
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), []);
    runtime.setReAuthorizationHook(async () => true);

    await expect(
      runtime.create({
        budgetId: BUDGET_ID,
        classification: 'reservation_conflict',
        severity: 'high',
        payload: JSON.stringify({ title: 'Decision attention' }),
        recipientId: 'actor-outside-policy',
        scope: `budget:${BUDGET_ID}`,
        redactionClass: 'restricted',
      }),
    ).rejects.toThrow();

    expect(store.createNotificationEvent).not.toHaveBeenCalled();
    expect(store.enqueueNotification).not.toHaveBeenCalled();
  });

  it('rejects creation before persistence when the requested scope is not the exact policy scope', async () => {
    const store = {
      createNotificationEvent: vi.fn(),
      enqueueNotification: vi.fn(),
      appendAuditRecord: vi.fn(),
      getActorMembership: vi.fn(),
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), []);
    const reauthorize = vi.fn(
      async (_actorId: string, _capability: string, scope: string) =>
        scope === `budget:${BUDGET_ID}`,
    );
    runtime.setReAuthorizationHook(reauthorize);

    await expect(
      runtime.create({
        budgetId: BUDGET_ID,
        classification: 'reservation_conflict',
        severity: 'high',
        payload: JSON.stringify({ title: 'Decision attention' }),
        recipientId: ACTOR_ID,
        scope: 'budget:budget-outside-policy',
        redactionClass: 'restricted',
      }),
    ).rejects.toThrow();

    expect(store.createNotificationEvent).not.toHaveBeenCalled();
    expect(store.enqueueNotification).not.toHaveBeenCalled();
  });

  it('creates the matching policy recipient only after exact-scope authorization succeeds', async () => {
    const event = notificationEvent();
    const record = outbox('outbox-authorized', event.id);
    const store = {
      createNotificationEvent: vi.fn(async () => event),
      enqueueNotification: vi.fn(async () => record),
      appendAuditRecord: vi.fn(),
      getActorMembership: vi.fn(),
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), []);
    const reauthorize = vi.fn(async () => true);
    runtime.setReAuthorizationHook(reauthorize);

    const result = await runtime.create({
      budgetId: BUDGET_ID,
      classification: 'reservation_conflict',
      severity: 'high',
      payload: event.payload,
      recipientId: ACTOR_ID,
      scope: `budget:${BUDGET_ID}`,
      redactionClass: 'restricted',
    });

    expect(reauthorize).toHaveBeenCalledWith(
      ACTOR_ID,
      'notification:receive',
      `budget:${BUDGET_ID}`,
    );
    expect(store.createNotificationEvent).toHaveBeenCalledTimes(1);
    expect(store.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(result.outboxRecords).toEqual([record]);
  });

  it.each([`budget:${BUDGET_ID}`, '*'])(
    'accepts an active store membership scoped to %s without a custom re-authorization hook',
    async (membershipScope) => {
      const event = notificationEvent();
      const record = outbox(`outbox-membership-${membershipScope}`, event.id);
      const store = {
        createNotificationEvent: vi.fn(async () => event),
        enqueueNotification: vi.fn(async () => record),
        appendAuditRecord: vi.fn(),
        getActorMembership: vi.fn(async () => ({
          actorId: ACTOR_ID,
          status: 'active',
          capabilities: ['notification:receive'],
          scope: membershipScope,
        })),
      };
      const runtime = new NotificationRuntime(store as never, notificationPolicy(), []);

      const result = await runtime.create({
        budgetId: BUDGET_ID,
        classification: 'reservation_conflict',
        severity: 'high',
        payload: event.payload,
        recipientId: ACTOR_ID,
        scope: `budget:${BUDGET_ID}`,
        redactionClass: 'restricted',
      });

      expect(result.outboxRecords).toEqual([record]);
      expect(store.createNotificationEvent).toHaveBeenCalledTimes(1);
      expect(store.enqueueNotification).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects creation before persistence when store membership has a different scope', async () => {
    const store = {
      createNotificationEvent: vi.fn(),
      enqueueNotification: vi.fn(),
      appendAuditRecord: vi.fn(),
      getActorMembership: vi.fn(async () => ({
        actorId: ACTOR_ID,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: 'budget:budget-other',
      })),
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), []);

    await expect(
      runtime.create({
        budgetId: BUDGET_ID,
        classification: 'reservation_conflict',
        severity: 'high',
        payload: notificationEvent().payload,
        recipientId: ACTOR_ID,
        scope: `budget:${BUDGET_ID}`,
        redactionClass: 'restricted',
      }),
    ).rejects.toThrow();

    expect(store.createNotificationEvent).not.toHaveBeenCalled();
    expect(store.enqueueNotification).not.toHaveBeenCalled();
  });
});

describe('financial decision notification delivery isolation', () => {
  it('re-authorizes the recipient capability and exact scope again at dispatch', async () => {
    const event = notificationEvent();
    const record = outbox('outbox-revoked', event.id);
    const store = {
      claimNotificationDelivery: vi.fn(async () => record),
      getNotificationEvent: vi.fn(async () => event),
      failNotificationDelivery: vi.fn(async () => ({ ...record, status: 'failed' })),
      appendAuditRecord: vi.fn(),
    };
    const deliver = vi.fn();
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      isHealthy: () => true,
      deliver,
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), [adapter]);
    const reauthorize = vi.fn(async () => false);
    runtime.setReAuthorizationHook(reauthorize);

    const result = await runtime.dispatch(record.id, 'claim-revoked');

    expect(reauthorize).toHaveBeenCalledWith(
      ACTOR_ID,
      'notification:receive',
      `budget:${BUDGET_ID}`,
    );
    expect(result.status).toBe('failed');
    expect(store.failNotificationDelivery).toHaveBeenCalledWith(
      record.id,
      'claim-revoked',
      'Recipient authorization revoked',
      false,
    );
    expect(deliver).not.toHaveBeenCalled();
  });

  it('denies dispatch when store membership is not scoped to the event', async () => {
    const event = notificationEvent();
    const record = outbox('outbox-membership-scope-mismatch', event.id);
    const store = {
      claimNotificationDelivery: vi.fn(async () => record),
      getNotificationEvent: vi.fn(async () => event),
      getActorMembership: vi.fn(async () => ({
        actorId: ACTOR_ID,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: 'budget:budget-other',
      })),
      completeNotificationDelivery: vi.fn(async () => ({ ...record, status: 'delivered' })),
      failNotificationDelivery: vi.fn(async () => ({ ...record, status: 'failed' })),
      appendAuditRecord: vi.fn(),
    };
    const deliver = vi.fn(async () => ({ ok: true, code: 'accepted' }));
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      isHealthy: () => true,
      deliver,
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), [adapter]);

    const result = await runtime.dispatch(record.id, 'claim-membership-scope-mismatch');

    expect(result.status).toBe('failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(store.completeNotificationDelivery).not.toHaveBeenCalled();
  });

  it('denies dispatch when the classification rule required scope differs from the event scope', async () => {
    const event = {
      ...notificationEvent(),
      scope: 'budget:budget-outside-policy',
    };
    const record = outbox('outbox-rule-scope-mismatch', event.id);
    const store = {
      claimNotificationDelivery: vi.fn(async () => record),
      getNotificationEvent: vi.fn(async () => event),
      getActorMembership: vi.fn(async () => ({
        actorId: ACTOR_ID,
        status: 'active',
        capabilities: ['notification:receive'],
        scope: '*',
      })),
      completeNotificationDelivery: vi.fn(async () => ({ ...record, status: 'delivered' })),
      failNotificationDelivery: vi.fn(async () => ({ ...record, status: 'failed' })),
      appendAuditRecord: vi.fn(),
    };
    const deliver = vi.fn(async () => ({ ok: true, code: 'accepted' }));
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      isHealthy: () => true,
      deliver,
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), [adapter]);

    const result = await runtime.dispatch(record.id, 'claim-rule-scope-mismatch');

    expect(result.status).toBe('failed');
    expect(deliver).not.toHaveBeenCalled();
    expect(store.completeNotificationDelivery).not.toHaveBeenCalled();
  });

  it('applies the restricted policy before the adapter sees a delivery payload', async () => {
    const secret = 'provider-secret-that-must-not-reach-an-adapter';
    const event = {
      ...notificationEvent(),
      payload: JSON.stringify({
        title: 'Decision attention',
        summary: 'Review required',
        classification: 'reservation_conflict',
        scope: `budget:${BUDGET_ID}`,
        snapshotId: SNAPSHOT_ID,
        rawEvidence: { accountId: 'account-restricted', value: secret },
        rawPayload: { providerResponse: secret },
        secrets: { accessToken: secret },
      }),
    };
    const record = outbox('outbox-restricted', event.id);
    const store = {
      claimNotificationDelivery: vi.fn(async () => record),
      getNotificationEvent: vi.fn(async () => event),
      completeNotificationDelivery: vi.fn(async () => ({ ...record, status: 'delivered' })),
      failNotificationDelivery: vi.fn(),
      appendAuditRecord: vi.fn(),
    };
    const deliver = vi.fn(async () => ({ ok: true, code: 'accepted' }));
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      isHealthy: () => true,
      deliver,
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), [adapter]);
    const reauthorize = vi.fn(async () => true);
    runtime.setReAuthorizationHook(reauthorize);

    const result = await runtime.dispatch(record.id, 'claim-restricted');

    expect(result.status).toBe('delivered');
    expect(reauthorize).toHaveBeenCalledWith(
      ACTOR_ID,
      'notification:receive',
      `budget:${BUDGET_ID}`,
    );
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
    expect(deliver.mock.calls[0]?.[1]).toBe(ACTOR_ID);
    expect(deliver.mock.calls[0]?.[1]).not.toBe(record.deliveryKey);
    const adapterPayload = deliver.mock.calls[0]?.[0];
    expect(adapterPayload).not.toHaveProperty('rawEvidence');
    expect(adapterPayload).not.toHaveProperty('rawPayload');
    expect(adapterPayload).not.toHaveProperty('secrets');
    expect(JSON.stringify(adapterPayload)).not.toContain(secret);
  });

  it('allows one delivery to fail without preventing an independent delivery', async () => {
    const failedEvent = notificationEvent('reservation_conflict');
    const deliveredEvent = {
      ...notificationEvent('commitment_conflict'),
      id: 'event-commitment-conflict',
    };
    const failedOutbox = outbox('outbox-failed', failedEvent.id);
    const deliveredOutbox = outbox('outbox-delivered', deliveredEvent.id);
    const records = new Map([
      [failedOutbox.id, failedOutbox],
      [deliveredOutbox.id, deliveredOutbox],
    ]);
    const events = new Map([
      [failedEvent.id, failedEvent],
      [deliveredEvent.id, deliveredEvent],
    ]);
    const store = {
      claimNotificationDelivery: vi.fn(async (id: string) => records.get(id) ?? null),
      getNotificationEvent: vi.fn(async (id: string) => events.get(id) ?? null),
      failNotificationDelivery: vi.fn(async () => ({ ...failedOutbox, status: 'pending' })),
      completeNotificationDelivery: vi.fn(async () => ({
        ...deliveredOutbox,
        status: 'delivered',
      })),
      appendAuditRecord: vi.fn(),
    };
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'email provider unavailable' })
      .mockResolvedValueOnce({ ok: true, code: 'accepted' });
    const adapter: ChannelAdapter = {
      channelType: 'in_app',
      isHealthy: () => true,
      deliver,
    };
    const runtime = new NotificationRuntime(store as never, notificationPolicy(), [adapter]);
    runtime.setReAuthorizationHook(async () => true);

    const failed = await runtime.dispatch(failedOutbox.id, 'claim-failed');
    const delivered = await runtime.dispatch(deliveredOutbox.id, 'claim-delivered');

    expect(failed.status).toBe('retryable');
    expect(delivered.status).toBe('delivered');
    expect(store.failNotificationDelivery).toHaveBeenCalledWith(
      failedOutbox.id,
      'claim-failed',
      'email provider unavailable',
      true,
    );
    expect(store.completeNotificationDelivery).toHaveBeenCalledWith(
      deliveredOutbox.id,
      'claim-delivered',
      { code: 'accepted', body: undefined },
    );
  });
});
