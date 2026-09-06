import { createHash } from 'node:crypto';
import type {
  AccountAwareSpendabilityRequest,
  FinancialSnapshot,
} from '@balanceframe/protocol-generated';
import {
  normalizeAccounts,
  normalizeCategories,
  normalizeBudgetMonth,
  normalizeActualLiquidityFacts,
  withLiquidityFacts,
  mergeUserAttestedLiquidityObservations,
  bindUserAttestedLiquidityObservations,
} from '../../../packages/actual-adapter/src/normalizer.js';

/** Real Actual source shapes run through production normalization; no evidence reasons are cleared. */
export function actualLiquidityRequest(
  attested: boolean,
  card = false,
): AccountAwareSpendabilityRequest {
  const capturedAt = '2026-09-06T10:00:00Z';
  const rawAccounts = [
    { id: 'cash', name: 'Cash account', offbudget: false, closed: false, balance_current: 15000 },
    ...(card
      ? [
          {
            id: 'card',
            name: 'Credit account',
            offbudget: false,
            closed: false,
            balance_current: 0,
          },
        ]
      : []),
  ];
  const rawCategories = [
    { id: 'food', name: 'Food', group_id: 'living', is_income: false, hidden: false },
    {
      id: 'income',
      name: 'Starting balances',
      group_id: 'income-group',
      is_income: true,
      hidden: false,
    },
    ...(card
      ? [
          {
            id: 'card-payment',
            name: 'Card payment',
            group_id: 'living',
            is_income: false,
            hidden: false,
          },
        ]
      : []),
  ];
  const rawGroups = [
    { id: 'living', name: 'Living', is_income: false, hidden: false },
    { id: 'income-group', name: 'Income', is_income: true, hidden: false },
  ];
  const rawMonth = {
    month: '2026-09',
    categoryGroups: [
      {
        id: 'living',
        categories: [
          { id: 'food', budgeted: 1000, spent: -100, balance: 2000 },
          ...(card ? [{ id: 'card-payment', budgeted: 0, spent: 0, balance: 0 }] : []),
        ],
      },
    ],
  };
  const legacySnapshot = {
    schemaVersion: '1',
    actualVersion: '26.7.0',
    snapshotDate: capturedAt,
    actualDownloadedAt: capturedAt,
    bankSyncedAt: null,
    encrypted: false,
    unlocked: true,
    accounts: normalizeAccounts(rawAccounts),
    categories: normalizeCategories(rawCategories, rawGroups),
    budgets: [
      normalizeBudgetMonth('2026-09', { food: 1000, ...(card ? { 'card-payment': 0 } : {}) }),
    ],
    transactions: [],
    payees: [],
    rules: [],
    schedules: [],
    tags: [],
  };
  const ledgerHash = `sha256:${createHash('sha256').update(JSON.stringify(legacySnapshot)).digest('hex')}`;
  const ledger: FinancialSnapshot = {
    contractVersion: '1.0',
    snapshotId: `actual:fixture:fixture:${ledgerHash}`,
    contentHash: ledgerHash,
    source: { ledgerBackend: 'actual', ledgerId: 'fixture', budgetId: 'fixture', spaceId: null },
    capturedAt,
    sourceNormalizationVersion: 'actual-normalizer/1',
    legacySnapshot,
    coverage: {
      accounts: 'complete',
      categories: 'complete',
      budgets: 'complete',
      transactions: 'empty',
      schedules: 'empty',
      rules: 'empty',
      payees: 'empty',
      tags: 'empty',
    },
    inclusionScope: { pendingActivity: 'included', unclearedActivity: 'included' },
    observations: [],
  };
  let financialSnapshot = withLiquidityFacts(
    ledger,
    normalizeActualLiquidityFacts({
      capturedAt,
      ledgerContentHash: ledgerHash,
      currency: 'USD',
      accounts: { available: true, items: rawAccounts },
      categories: { available: true, items: rawCategories },
      budgetMonths: [rawMonth],
      transactions: rawAccounts.map((account) => ({
        accountId: account.id,
        read: { available: true as const, items: [] },
      })),
      schedules: { available: true, items: [] },
    }),
  );
  if (attested) {
    financialSnapshot = mergeUserAttestedLiquidityObservations(
      financialSnapshot,
      bindUserAttestedLiquidityObservations(financialSnapshot, [
        {
          accountId: 'cash',
          observedAt: capturedAt,
          expiresAt: '2026-09-06T10:15:00Z',
          currentLedgerConfirmed: true,
          kind: 'cash',
          currency: 'USD',
          owned: true,
          holds: { minorUnits: '0', currency: 'USD' },
        },
        ...(card
          ? [
              {
                accountId: 'card',
                observedAt: capturedAt,
                expiresAt: '2026-09-06T10:15:00Z',
                currentLedgerConfirmed: true as const,
                kind: 'credit' as const,
                currency: 'USD',
                owned: true,
                holds: { minorUnits: '0', currency: 'USD' },
                credit: {
                  authorizationAvailable: { minorUnits: '5000', currency: 'USD' },
                  pendingIncludedInAuthorization: true,
                  paymentAccountId: 'cash',
                  paymentCategoryId: 'card-payment',
                  dueAt: '2026-09-06T18:00:00Z',
                  reservedCash: { minorUnits: '0', currency: 'USD' },
                  economicObligationId: 'card-cycle',
                },
              },
            ]
          : []),
      ]),
    );
  }
  return {
    financialSnapshot,
    context: {
      evaluatedAt: '2026-09-06T10:01:00Z',
      horizon: { startsAt: '2026-09-06T10:00:00Z', endsAt: '2026-09-07T00:00:00Z' },
      policy: {
        pendingMode: 'includeConservatively',
        uncategorizedMode: 'block',
        unclearedMode: 'include',
        maxBankSyncAgeMinutes: 15,
        maxBudgetSnapshotAgeMinutes: 15,
        accountOverrides: { includeOnly: null, exclude: [] },
      },
      policyVersion: 'policy-1',
      policyHash: 'policy-hash-1',
      snapshotId: financialSnapshot.snapshotId,
      contentHash: financialSnapshot.contentHash,
    },
    liquidityPolicy: {
      version: 'policy-1',
      policyHash: 'policy-hash-1',
      expiresAt: '2026-09-06T10:15:00Z',
      accounts: [
        {
          accountId: 'cash',
          role: 'daily_spending',
          protectedBuffer: { minorUnits: '10000', currency: 'USD' },
          paymentEligible: true,
          sourceEligible: true,
          backingEligible: true,
          eligibleCategoryIds: [],
          restrictedCashBucketIds: [],
          automationAllowed: false,
          resourceScope: 'cash',
        },
        ...(card
          ? [
              {
                accountId: 'card',
                role: 'daily_spending' as const,
                protectedBuffer: { minorUnits: '0', currency: 'USD' },
                paymentEligible: true,
                sourceEligible: false,
                backingEligible: false,
                eligibleCategoryIds: [],
                restrictedCashBucketIds: [],
                automationAllowed: false,
                resourceScope: 'card',
              },
            ]
          : []),
      ],
      transferRoutes: [],
    },
    claimSet: { revision: '0', bundles: [] },
    priorAllocation: null,
    scenario: {
      kind: 'purchases',
      items: [
        {
          id: 'buy-food',
          categoryId: 'food',
          amount: { minorUnits: '2000', currency: 'USD' },
          purchaseAt: '2026-09-06T10:02:00Z',
          requiredBy: '2026-09-06T10:02:00Z',
          routeSelection: {
            explicitAccountId: card ? 'card' : 'cash',
            sessionAccountId: null,
            approvedPreference: null,
            historicalRoute: null,
          },
        },
      ],
    },
    validUntil: '2026-09-06T10:15:00Z',
  };
}
