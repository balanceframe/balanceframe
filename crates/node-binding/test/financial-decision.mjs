import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const native = createRequire(import.meta.url)(path.resolve(here, '..', 'balanceframe.node'));

assert.equal(typeof native.evaluateProspectivePurchase, 'function');
assert.equal(typeof native.evaluatePurchase, 'function');

const MONEY = (minorUnits, currency = 'USD') => ({ minorUnits, currency });
const CATEGORY_ID = 'fd-category-groceries';
const ACCOUNT_ID = 'fd-account-checking';

const PROPOSED_TRANSACTION = {
  id: 'fd-proposed-purchase',
  accountId: ACCOUNT_ID,
  date: '2026-08-23',
  payeeId: null,
  payeeName: 'Fixture Grocer',
  categoryId: CATEGORY_ID,
  categoryName: 'Groceries',
  amount: MONEY('-2500'),
  cleared: false,
  reconciled: false,
  importedId: null,
  importedPayee: null,
  notes: null,
  tags: [],
  transferAccountId: null,
  subtransactions: [],
};

const LEGACY_SNAPSHOT = {
  schemaVersion: '1.0',
  actualVersion: '26.8.0',
  snapshotDate: '2026-08-23T12:00:00Z',
  accounts: [
    {
      id: ACCOUNT_ID,
      name: 'Household Checking',
      accountType: 'checking',
      offBudget: false,
      isClosed: false,
      clearedBalance: MONEY('50000'),
      importedBalance: MONEY('50000'),
      mtid: 'fd-mtid-checking',
    },
  ],
  transactions: [],
  categories: [
    {
      id: CATEGORY_ID,
      name: 'Groceries',
      groupName: 'Everyday',
      isIncome: false,
      mtid: null,
      deleted: false,
    },
  ],
  payees: [],
  rules: [],
  schedules: [],
  budgets: [
    {
      id: 'fd-budget-2026-08',
      month: '2026-08',
      categories: {
        [CATEGORY_ID]: {
          categoryId: CATEGORY_ID,
          amount: MONEY('10000'),
          carryover: MONEY('0'),
          carryoverFromPrevious: MONEY('0'),
          carriesOver: false,
        },
      },
    },
  ],
  tags: [],
  actualDownloadedAt: '2026-08-23T12:00:00Z',
  encrypted: false,
  bankSyncedAt: '2026-08-23T12:00:00Z',
};

const CONTEXT = {
  evaluatedAt: '2026-08-23T12:00:00Z',
  horizon: {
    startsAt: '2026-08-23T12:00:00Z',
    endsAt: '2026-09-22T12:00:00Z',
  },
  policy: {
    pendingMode: 'includeConservatively',
    uncategorizedMode: 'reserveFullAmount',
    unclearedMode: 'include',
    maxBankSyncAgeMinutes: null,
    maxBudgetSnapshotAgeMinutes: null,
    accountOverrides: { includeOnly: null, exclude: [] },
  },
  policyVersion: 'fd-policy-v1',
  policyHash: 'sha256:fd-policy-v1',
  snapshotId: 'fd-snapshot-2026-08-23',
  contentHash: 'sha256:fd-snapshot-2026-08-23',
};

const FINANCIAL_SNAPSHOT = {
  contractVersion: '1.0',
  snapshotId: CONTEXT.snapshotId,
  contentHash: CONTEXT.contentHash,
  source: {
    ledgerBackend: 'actual',
    ledgerId: 'fd-ledger-household',
    budgetId: 'fd-budget-household',
    spaceId: 'fd-space-family',
  },
  capturedAt: '2026-08-23T12:00:00Z',
  sourceNormalizationVersion: 'fd-fixture/1',
  legacySnapshot: LEGACY_SNAPSHOT,
  coverage: {
    accounts: 'complete',
    transactions: 'empty',
    categories: 'complete',
    payees: 'empty',
    rules: 'empty',
    schedules: 'empty',
    budgets: 'complete',
    tags: 'empty',
  },
  inclusionScope: {
    pendingActivity: 'included',
    unclearedActivity: 'included',
  },
  observations: [
    {
      kind: 'account_freshness',
      scope: { kind: 'account', id: ACCOUNT_ID },
      state: 'fresh',
      observedAt: '2026-08-23T11:58:00Z',
      evidence: [
        {
          evidenceId: 'fd-bank-sync-checking-884',
          kind: 'bank_sync',
          authorized: true,
          redaction: 'visible',
        },
      ],
    },
  ],
};

const REQUEST = {
  financialSnapshot: FINANCIAL_SNAPSHOT,
  context: CONTEXT,
  claims: [],
  proposedTransaction: PROPOSED_TRANSACTION,
  categoryId: CATEGORY_ID,
  requestId: 'fd-request-ready',
  correlationId: 'fd-correlation-2026-08-23',
  decisionId: 'fd-decision-ready',
  validUntil: '2026-08-23T12:15:00Z',
  redaction: 'visible',
};

const LEGACY_EXPECTED = {
  allowable: true,
  reasonCodes: ['within_budget', 'budget_sufficient'],
  categoryBudget: MONEY('10000'),
  categorySpent: MONEY('0'),
  categoryRemaining: MONEY('10000'),
  projectedBalance: MONEY('50000'),
};

const EXPECTED_DECISION = {
  metadata: {
    contractVersion: '1.0',
    decisionId: REQUEST.decisionId,
    decisionKind: 'purchase',
    requestId: REQUEST.requestId,
    correlationId: REQUEST.correlationId,
    context: CONTEXT,
  },
  readiness: 'ready',
  before: {
    amounts: [
      {
        label: 'envelopeAvailability',
        scope: { kind: 'category', id: CATEGORY_ID },
        amount: MONEY('10000'),
      },
    ],
  },
  after: {
    amounts: [
      {
        label: 'envelopeAvailability',
        scope: { kind: 'category', id: CATEGORY_ID },
        amount: MONEY('7500'),
      },
    ],
  },
  issues: [],
  evidence: [
    {
      evidenceId: 'fd-bank-sync-checking-884',
      kind: 'bank_sync',
      authorized: true,
      redaction: 'visible',
    },
  ],
  alternatives: [],
  expiresAt: REQUEST.validUntil,
  redaction: REQUEST.redaction,
  payload: LEGACY_EXPECTED,
};

const decisionWire = native.evaluateProspectivePurchase(JSON.stringify(REQUEST));
assert.equal(typeof decisionWire, 'string');
assert.deepStrictEqual(JSON.parse(decisionWire), EXPECTED_DECISION);

assert.throws(() => native.evaluateProspectivePurchase('{not-json'));

const missingMoney = structuredClone(REQUEST);
delete missingMoney.proposedTransaction.amount;
assert.throws(() => native.evaluateProspectivePurchase(JSON.stringify(missingMoney)));

const malformedMoney = structuredClone(REQUEST);
malformedMoney.proposedTransaction.amount.minorUnits = 0;
assert.throws(() => native.evaluateProspectivePurchase(JSON.stringify(malformedMoney)));

const legacyWire = native.evaluatePurchase(
  JSON.stringify({
    snapshot: LEGACY_SNAPSHOT,
    proposedTransaction: PROPOSED_TRANSACTION,
    categoryId: CATEGORY_ID,
  }),
);
assert.equal(typeof legacyWire, 'string');
assert.deepStrictEqual(JSON.parse(legacyWire), LEGACY_EXPECTED);

console.log('financial decision native smoke passed');
