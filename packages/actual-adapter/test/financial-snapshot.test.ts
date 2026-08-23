import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  APIAccountEntity,
  APICategoryEntity,
  APICategoryGroupEntity,
  APIFileEntity,
  APIPayeeEntity,
  APIScheduleEntity,
  APITagEntity,
} from '@actual-app/api';
import type { RuleEntity, TransactionEntity } from '@actual-app/core/types/models';
import { ActualConnector } from '../src/connector';
import type { ActualClient } from '../src/connector';
import { NullCredentialStore } from '../src/credentials';
import type { LedgerSnapshotResult } from '../src/types';

const CAPTURED_AT = '2026-08-23T12:00:00.000Z';
const SERVER_URL = 'http://actual.test:5006';
const BUDGET: APIFileEntity = {
  id: 'budget-household',
  groupId: 'ledger-household',
  name: 'Household',
  cloudFileId: 'cloud-household',
  encrypted: false,
  state: 'remote',
};

type CoverageState = 'unknown' | 'unavailable' | 'empty' | 'partial' | 'complete';

type Observation = {
  kind: string;
  scope: { kind: string; id?: string };
  state: string;
  observedAt: string | null;
  evidence: Array<{
    evidenceId: string;
    kind: string;
    authorized: boolean;
    redaction: 'visible' | 'redacted';
  }>;
};

type CanonicalFinancialSnapshot = {
  contractVersion: string;
  snapshotId: string;
  contentHash: string;
  source: {
    ledgerBackend: string;
    ledgerId: string;
    budgetId: string;
    spaceId: string | null;
  };
  capturedAt: string;
  sourceNormalizationVersion: string;
  legacySnapshot: unknown;
  coverage: Record<
    | 'accounts'
    | 'transactions'
    | 'categories'
    | 'payees'
    | 'rules'
    | 'schedules'
    | 'budgets'
    | 'tags',
    CoverageState
  >;
  inclusionScope: {
    pendingActivity: 'included' | 'excluded' | 'unknown';
    unclearedActivity: 'included' | 'excluded' | 'unknown';
  };
  observations: Observation[];
};

type Synchronization = LedgerSnapshotResult;
type BalanceAwareActualClient = ActualClient & {
  getAccountBalance(accountId: string): Promise<number>;
};

function account(
  id: string,
  name: string,
  balance: number | null | undefined = 0,
): APIAccountEntity {
  return {
    id,
    name,
    offbudget: false,
    closed: false,
    ...(balance === undefined ? {} : { balance_current: balance }),
  };
}

function transaction(
  fields: Pick<TransactionEntity, 'id' | 'account' | 'date' | 'amount'> &
    Partial<TransactionEntity>,
): TransactionEntity {
  return {
    payee: null,
    category: null,
    cleared: true,
    reconciled: true,
    notes: null,
    imported_id: null,
    imported_payee: null,
    ...fields,
  } as TransactionEntity;
}

function schedule(
  fields: Pick<APIScheduleEntity, 'id' | 'name'> & Partial<APIScheduleEntity>,
): APIScheduleEntity {
  return {
    posts_transaction: true,
    completed: false,
    amountOp: 'is',
    date: { frequency: 'monthly', interval: 1, start: '2026-08-01', endMode: 'never' },
    ...fields,
  } as APIScheduleEntity;
}

function createActualClient(
  overrides: Partial<BalanceAwareActualClient> = {},
): BalanceAwareActualClient {
  return {
    init: vi.fn().mockResolvedValue({
      send: vi.fn(),
      getDataDir: vi.fn(),
      sendMessage: vi.fn(),
      amountToInteger: vi.fn(),
      integerToAmount: vi.fn(),
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getBudgets: vi.fn().mockResolvedValue([BUDGET]),
    downloadBudget: vi.fn().mockResolvedValue(undefined),
    loadBudget: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
    getAccounts: vi.fn().mockResolvedValue([]),
    getAccountBalance: vi.fn().mockResolvedValue(0),
    getTransactions: vi.fn().mockResolvedValue([]),
    getPayees: vi.fn().mockResolvedValue([]),
    getCategories: vi.fn().mockResolvedValue([]),
    getCategoryGroups: vi.fn().mockResolvedValue([]),
    getBudgetMonths: vi.fn().mockResolvedValue([]),
    getBudgetMonth: vi.fn().mockResolvedValue({ month: '2026-08', categoryGroups: [] }),
    getRules: vi.fn().mockResolvedValue([]),
    getSchedules: vi.fn().mockResolvedValue([]),
    getTags: vi.fn().mockResolvedValue([]),
    runBankSync: vi.fn().mockResolvedValue(undefined),
    addTransactions: vi.fn().mockResolvedValue('ok' as const),
    createAccount: vi.fn().mockResolvedValue('created-account'),
    updateTransaction: vi.fn().mockResolvedValue(undefined),
    createRule: vi.fn().mockResolvedValue({ id: 'created-rule' }),
    updateRule: vi.fn().mockResolvedValue(undefined),
    deleteRule: vi.fn().mockResolvedValue(true),
    setBudgetAmount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function synchronize(
  client: ActualClient,
  options: { budget?: APIFileEntity; currency?: string } = {},
): Promise<Synchronization> {
  const selectedBudget = options.budget ?? BUDGET;
  client.getBudgets = vi.fn().mockResolvedValue([selectedBudget]);
  const connector = new ActualConnector({
    client,
    credentialStore: new NullCredentialStore(),
    mode: 'observe',
    cacheDir: '/tmp/bf-financial-snapshot-test',
    currency: options.currency ?? 'USD',
  });
  await connector.connect({ serverUrl: SERVER_URL, secretKey: 'test-secret' });
  await connector.selectBudget(selectedBudget.id!);
  return connector.synchronize({ refresh: false });
}

function financialSnapshot(result: Synchronization): CanonicalFinancialSnapshot {
  expect(result).toHaveProperty('financialSnapshot');
  const snapshot = (
    result as Synchronization & {
      financialSnapshot?: CanonicalFinancialSnapshot;
    }
  ).financialSnapshot;
  if (!snapshot) throw new Error('synchronize() did not return financialSnapshot');
  return snapshot;
}

function observations(snapshot: CanonicalFinancialSnapshot, kind: string): Observation[] {
  return snapshot.observations.filter((observation) => observation.kind === kind);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(CAPTURED_AT));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ActualConnector FinancialSnapshot synchronization', () => {
  it('additively returns a source-namespaced canonical snapshot and retains the legacy snapshot', async () => {
    const client = createActualClient({
      getAccounts: vi.fn().mockResolvedValue([account('account-checking', 'Checking', 125_000)]),
    });

    const result = await synchronize(client);
    const canonical = financialSnapshot(result);

    expect(canonical).toMatchObject({
      contractVersion: '1.0',
      source: {
        ledgerBackend: 'actual',
        ledgerId: 'ledger-household',
        budgetId: 'budget-household',
        spaceId: null,
      },
      capturedAt: CAPTURED_AT,
    });
    expect(canonical.sourceNormalizationVersion).toMatch(/^actual-normalizer\/\d+$/);
    expect(canonical.snapshotId).toBeTruthy();
    expect(canonical.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(canonical.legacySnapshot).toEqual(result.snapshot);
    expect(result.snapshot.accounts).toHaveLength(1);
  });

  it('derives stable content identity from normalized content and source namespace', async () => {
    const makeClient = (amount: number) =>
      createActualClient({
        getAccounts: vi.fn().mockResolvedValue([account('account-checking', 'Checking', 125_000)]),
        getTransactions: vi.fn().mockResolvedValue([
          transaction({
            id: 'transaction-grocery',
            account: 'account-checking',
            date: '2026-08-23',
            amount,
          }),
        ]),
      });

    const first = financialSnapshot(await synchronize(makeClient(-1_250)));
    const replay = financialSnapshot(await synchronize(makeClient(-1_250)));
    const changed = financialSnapshot(await synchronize(makeClient(-1_251)));

    expect(replay.contentHash).toBe(first.contentHash);
    expect(replay.snapshotId).toBe(first.snapshotId);
    expect(changed.contentHash).not.toBe(first.contentHash);
    expect(changed.snapshotId).not.toBe(first.snapshotId);

    const otherBudget: APIFileEntity = {
      ...BUDGET,
      id: 'budget-household-copy',
      groupId: 'ledger-household-copy',
      cloudFileId: 'cloud-household-copy',
    };
    const otherSource = financialSnapshot(
      await synchronize(makeClient(-1_250), { budget: otherBudget }),
    );
    expect(otherSource.source).toEqual({
      ledgerBackend: 'actual',
      ledgerId: 'ledger-household-copy',
      budgetId: 'budget-household-copy',
      spaceId: null,
    });
    expect(otherSource.contentHash).not.toBe(first.contentHash);
    expect(otherSource.snapshotId).not.toBe(first.snapshotId);
  });

  it('distinguishes confirmed empty collections from complete populated collections', async () => {
    const populated = createActualClient({
      getAccounts: vi.fn().mockResolvedValue([account('account-1', 'Checking', 10_000)]),
      getTransactions: vi.fn().mockResolvedValue([
        transaction({
          id: 'transaction-1',
          account: 'account-1',
          date: '2026-08-23',
          amount: -100,
        }),
      ]),
      getPayees: vi.fn().mockResolvedValue([{ id: 'payee-1', name: 'Shop' } as APIPayeeEntity]),
      getCategories: vi.fn().mockResolvedValue([
        {
          id: 'category-1',
          name: 'Groceries',
          group_id: 'group-1',
          is_income: false,
          hidden: false,
        } as APICategoryEntity,
      ]),
      getCategoryGroups: vi.fn().mockResolvedValue([
        {
          id: 'group-1',
          name: 'Needs',
          is_income: false,
          hidden: false,
        } as APICategoryGroupEntity,
      ]),
      getRules: vi.fn().mockResolvedValue([
        {
          id: 'rule-1',
          stage: 'post',
          conditionsOp: 'and',
          conditions: [],
          actions: [],
          tombstone: false,
        } as RuleEntity,
      ]),
      getSchedules: vi.fn().mockResolvedValue([
        schedule({
          id: 'schedule-1',
          name: 'Rent',
          account: 'account-1',
          amount: -50_000,
          next_date: '2026-08-31',
        }),
      ]),
      getBudgetMonths: vi.fn().mockResolvedValue(['2026-08']),
      getBudgetMonth: vi.fn().mockResolvedValue({ month: '2026-08', categoryGroups: [] }),
      getTags: vi
        .fn()
        .mockResolvedValue([
          { id: 'tag-1', tag: 'review', color: '#000000', description: '' } as APITagEntity,
        ]),
    });

    expect(financialSnapshot(await synchronize(populated)).coverage).toEqual({
      accounts: 'partial',
      transactions: 'complete',
      categories: 'complete',
      payees: 'complete',
      rules: 'complete',
      schedules: 'complete',
      budgets: 'complete',
      tags: 'complete',
    });

    const empty = financialSnapshot(await synchronize(createActualClient()));
    expect(empty.coverage).toEqual({
      accounts: 'empty',
      transactions: 'empty',
      categories: 'empty',
      payees: 'empty',
      rules: 'empty',
      schedules: 'empty',
      budgets: 'empty',
      tags: 'empty',
    });
  });

  it('reports partial and unknown coverage without dropping the successfully normalized legacy data', async () => {
    const transactionsByAccount: Record<string, TransactionEntity[] | undefined> = {
      'account-readable': [
        transaction({
          id: 'transaction-readable',
          account: 'account-readable',
          date: '2026-08-23',
          amount: -500,
        }),
      ],
    };
    const client = createActualClient({
      getAccounts: vi
        .fn()
        .mockResolvedValue([
          account('account-readable', 'Readable', 10_000),
          account('account-unavailable', 'Unavailable', 20_000),
        ]),
      getTransactions: vi.fn(async (accountId: string) => {
        const rows = transactionsByAccount[accountId];
        if (!rows) throw new Error('transactions unavailable for account');
        return rows;
      }),
      getPayees: vi.fn().mockRejectedValue(new Error('payees unavailable')),
      getCategories: vi.fn().mockRejectedValue(new Error('categories unavailable')),
      getRules: vi.fn().mockResolvedValue([]),
      getSchedules: vi.fn().mockRejectedValue(new Error('schedules unavailable')),
      getBudgetMonths: vi.fn().mockResolvedValue(['2026-07', '2026-08']),
      getBudgetMonth: vi.fn(async (month: string) => {
        if (month === '2026-07') throw new Error('historical month unavailable');
        return { month, categoryGroups: [] };
      }),
      getTags: vi.fn().mockResolvedValue([]),
    });

    const result = await synchronize(client);
    const canonical = financialSnapshot(result);

    expect(canonical.coverage).toEqual({
      accounts: 'partial',
      transactions: 'partial',
      categories: 'unknown',
      payees: 'unknown',
      rules: 'empty',
      schedules: 'unknown',
      budgets: 'partial',
      tags: 'empty',
    });
    expect(result.snapshot.accounts.map(({ id }) => id)).toEqual([
      'account-readable',
      'account-unavailable',
    ]);
    expect(result.snapshot.transactions.map(({ id }) => id)).toEqual(['transaction-readable']);
    expect(canonical.legacySnapshot).toEqual(result.snapshot);
  });

  it('uses the computed ledger balance when the account list omits its current balance', async () => {
    const getAccountBalance = vi.fn().mockResolvedValue(125_000);
    const client = createActualClient({
      getAccounts: vi.fn().mockResolvedValue([
        {
          ...account('account-checking', 'Checking', null),
          type: 'checking',
        } as APIAccountEntity,
      ]),
      getAccountBalance,
    });

    const result = await synchronize(client);
    const canonical = financialSnapshot(result);

    expect(getAccountBalance).toHaveBeenCalledOnce();
    expect(getAccountBalance).toHaveBeenCalledWith('account-checking');
    expect(result.snapshot.accounts).toEqual([
      expect.objectContaining({
        id: 'account-checking',
        clearedBalance: { minorUnits: '125000', currency: 'USD' },
        importedBalance: { minorUnits: '125000', currency: 'USD' },
      }),
    ]);
    expect(canonical.coverage.accounts).toBe('complete');
    for (const kind of ['account_coverage', 'account_balance']) {
      expect(observations(canonical, kind)).toEqual([
        expect.objectContaining({
          scope: { kind: 'account', id: 'account-checking' },
          state: 'complete',
          observedAt: CAPTURED_AT,
        }),
      ]);
    }
  });

  it('isolates computed balance failures to the affected account', async () => {
    const getAccountBalance = vi.fn(async (accountId: string) => {
      if (accountId === 'account-readable') return 80_000;
      throw new Error('computed balance unavailable');
    });
    const client = createActualClient({
      getAccounts: vi.fn().mockResolvedValue([
        {
          ...account('account-readable', 'Readable', null),
          type: 'checking',
        } as APIAccountEntity,
        {
          ...account('account-unavailable', 'Unavailable', null),
          type: 'checking',
        } as APIAccountEntity,
      ]),
      getAccountBalance,
    });

    const result = await synchronize(client);
    const canonical = financialSnapshot(result);

    expect(getAccountBalance).toHaveBeenCalledTimes(2);
    expect(getAccountBalance).toHaveBeenCalledWith('account-readable');
    expect(getAccountBalance).toHaveBeenCalledWith('account-unavailable');
    expect(result.snapshot.accounts).toEqual([
      expect.objectContaining({
        id: 'account-readable',
        clearedBalance: { minorUnits: '80000', currency: 'USD' },
        importedBalance: { minorUnits: '80000', currency: 'USD' },
      }),
      expect.objectContaining({ id: 'account-unavailable' }),
    ]);
    expect(canonical.coverage.accounts).toBe('partial');
    for (const kind of ['account_coverage', 'account_balance']) {
      expect(
        observations(canonical, kind).map(({ scope, state, observedAt }) => ({
          scope,
          state,
          observedAt,
        })),
      ).toEqual([
        {
          scope: { kind: 'account', id: 'account-readable' },
          state: 'complete',
          observedAt: CAPTURED_AT,
        },
        {
          scope: { kind: 'account', id: 'account-unavailable' },
          state: 'unavailable',
          observedAt: null,
        },
      ]);
    }
  });

  it('returns an unknown snapshot and health when account reads keep failing', async () => {
    const getAccounts = vi.fn().mockRejectedValue(new Error('accounts unavailable'));
    const getAccountBalance = vi.fn().mockResolvedValue(125_000);
    const client = createActualClient({ getAccounts, getAccountBalance });

    const result = await synchronize(client);
    const canonical = financialSnapshot(result);

    expect(canonical.coverage.accounts).toBe('unknown');
    expect(canonical.coverage.transactions).toBe('unknown');
    expect(result.snapshot.accounts).toEqual([]);
    expect(result.snapshot.transactions).toEqual([]);
    expect(result.health.state).toBe('unknown');
    expect(result.health.coverage).toEqual({
      totalAccounts: 0,
      includedAccounts: 0,
      allExpectedAccountsPresent: false,
    });
    expect(getAccounts).toHaveBeenCalledTimes(1);
    expect(getAccountBalance).not.toHaveBeenCalled();
  });

  it('marks freshness and type unknown when successful account reads lack source metadata', async () => {
    const client = createActualClient({
      getAccounts: vi
        .fn()
        .mockResolvedValue([
          account('account-checking', 'Checking', 125_000),
          account('account-savings', 'Savings', 500_000),
        ]),
    });

    const canonical = financialSnapshot(await synchronize(client));
    const freshness = observations(canonical, 'account_freshness');
    const accountTypes = observations(canonical, 'account_type');
    const accountCoverage = observations(canonical, 'account_coverage');

    expect(canonical.coverage.accounts).toBe('partial');
    expect(freshness).toHaveLength(2);
    expect(freshness.map(({ scope }) => scope)).toEqual([
      { kind: 'account', id: 'account-checking' },
      { kind: 'account', id: 'account-savings' },
    ]);
    expect(freshness.map(({ state, observedAt }) => ({ state, observedAt }))).toEqual([
      { state: 'unknown', observedAt: null },
      { state: 'unknown', observedAt: null },
    ]);
    expect(accountTypes.map(({ state, observedAt }) => ({ state, observedAt }))).toEqual([
      { state: 'unknown', observedAt: null },
      { state: 'unknown', observedAt: null },
    ]);
    expect(accountCoverage.map(({ scope, state }) => ({ scope, state }))).toEqual([
      { scope: { kind: 'account', id: 'account-checking' }, state: 'complete' },
      { scope: { kind: 'account', id: 'account-savings' }, state: 'complete' },
    ]);
    for (const observation of [...freshness, ...accountTypes, ...accountCoverage]) {
      expect(observation.evidence).toEqual([
        {
          evidenceId: observation.scope.id,
          kind: 'account',
          authorized: true,
          redaction: 'visible',
        },
      ]);
    }
  });

  it('records pending and uncleared activity without treating unreconciled transactions as ambiguous', async () => {
    const client = createActualClient({
      getAccounts: vi.fn().mockResolvedValue([account('account-checking', 'Checking', 125_000)]),
      getTransactions: vi.fn().mockResolvedValue([
        transaction({
          id: 'transaction-pending',
          account: 'account-checking',
          date: '2026-08-23',
          amount: -1_250,
          cleared: false,
          reconciled: false,
        }),
        transaction({
          id: 'transaction-uncleared',
          account: 'account-checking',
          date: '2026-08-22',
          amount: -2_500,
          cleared: true,
          reconciled: false,
        }),
        transaction({
          id: 'transaction-reconciled',
          account: 'account-checking',
          date: '2026-08-21',
          amount: -3_000,
          cleared: true,
          reconciled: true,
        }),
      ]),
    });

    const canonical = financialSnapshot(await synchronize(client));

    expect(canonical.inclusionScope).toEqual({
      pendingActivity: 'included',
      unclearedActivity: 'included',
    });
    expect(observations(canonical, 'pending_activity')).toEqual([
      expect.objectContaining({
        scope: { kind: 'account', id: 'account-checking' },
        state: 'included',
        observedAt: CAPTURED_AT,
        evidence: [
          {
            evidenceId: 'transaction-pending',
            kind: 'transaction',
            authorized: true,
            redaction: 'visible',
          },
        ],
      }),
    ]);
    expect(observations(canonical, 'uncleared_activity')).toEqual([
      expect.objectContaining({
        scope: { kind: 'account', id: 'account-checking' },
        state: 'included',
        evidence: [
          {
            evidenceId: 'transaction-uncleared',
            kind: 'transaction',
            authorized: true,
            redaction: 'visible',
          },
        ],
      }),
    ]);
    expect(observations(canonical, 'reconciliation')).toEqual([]);
  });

  it('records complete schedule coverage without inferring card obligations from unknown account types', async () => {
    const client = createActualClient({
      getAccounts: vi
        .fn()
        .mockResolvedValue([
          account('account-checking', 'Checking', 125_000),
          account('account-card', 'Household Card', -25_000),
        ]),
      getSchedules: vi.fn().mockResolvedValue([
        schedule({
          id: 'schedule-card-payment',
          name: 'Household Card Payment',
          account: 'account-checking',
          amount: -25_000,
          next_date: '2026-08-31',
        }),
      ]),
    });

    const canonical = financialSnapshot(await synchronize(client));

    expect(canonical.coverage.schedules).toBe('complete');
    expect(observations(canonical, 'schedule_coverage')).toEqual([
      {
        kind: 'schedule_coverage',
        scope: { kind: 'schedule', id: 'schedule-card-payment' },
        state: 'complete',
        observedAt: CAPTURED_AT,
        evidence: [
          {
            evidenceId: 'schedule-card-payment',
            kind: 'schedule',
            authorized: true,
            redaction: 'visible',
          },
        ],
      },
    ]);
    expect(observations(canonical, 'credit_card_obligation_coverage')).toEqual([]);
  });

  it('emits duplicate, one-sided transfer, and currency observations without reconciliation noise', async () => {
    const payees: APIPayeeEntity[] = [
      { id: 'payee-shop', name: 'Fixture Shop', transfer_acct: undefined },
      { id: 'payee-transfer', name: 'Transfer to Card', transfer_acct: 'account-card' },
    ];
    const client = createActualClient({
      getAccounts: vi
        .fn()
        .mockResolvedValue([
          account('account-checking', 'Checking', 125_000),
          account('account-card', 'Card', -25_000),
        ]),
      getPayees: vi.fn().mockResolvedValue(payees),
      getTransactions: vi.fn(async (accountId: string) =>
        accountId === 'account-checking'
          ? [
              transaction({
                id: 'transaction-imported',
                account: accountId,
                date: '2026-08-23',
                amount: -1_250,
                payee: 'payee-shop',
                imported_id: 'import-1250',
                cleared: false,
                reconciled: false,
              }),
              transaction({
                id: 'transaction-existing',
                account: accountId,
                date: '2026-08-23',
                amount: -1_250,
                payee: 'payee-shop',
                cleared: true,
                reconciled: false,
              }),
              transaction({
                id: 'transaction-transfer-one-sided',
                account: accountId,
                date: '2026-08-23',
                amount: -10_000,
                payee: 'payee-transfer',
                cleared: true,
                reconciled: false,
              }),
            ]
          : [],
      ),
    });

    const canonical = financialSnapshot(await synchronize(client, { currency: 'USD' }));

    expect(observations(canonical, 'duplicate_candidate')).toEqual([
      expect.objectContaining({
        scope: { kind: 'transaction', id: 'transaction-imported' },
        state: 'present',
        evidence: expect.arrayContaining([
          expect.objectContaining({ evidenceId: 'transaction-imported', redaction: 'visible' }),
          expect.objectContaining({ evidenceId: 'transaction-existing', redaction: 'visible' }),
        ]),
      }),
    ]);
    expect(observations(canonical, 'transfer_ambiguity')).toEqual([
      expect.objectContaining({
        scope: { kind: 'transaction', id: 'transaction-transfer-one-sided' },
        state: 'ambiguous',
      }),
    ]);
    expect(observations(canonical, 'reconciliation')).toEqual([]);
    expect(observations(canonical, 'currency_compatibility')).toEqual([
      expect.objectContaining({
        scope: { kind: 'global' },
        state: 'complete',
        observedAt: CAPTURED_AT,
      }),
    ]);
  });

  it('marks missing account type unknown while keeping missing balance and schedule facts unavailable', async () => {
    const client = createActualClient({
      getAccounts: vi
        .fn()
        .mockResolvedValue([account('account-incomplete', 'Incomplete Account', null)]),
      getAccountBalance: vi.fn().mockRejectedValue(new Error('computed balance unavailable')),
      getSchedules: vi
        .fn()
        .mockResolvedValue([schedule({ id: 'schedule-incomplete', name: 'Incomplete Schedule' })]),
    });

    const result = await synchronize(client);
    const canonical = financialSnapshot(result);

    expect(canonical.coverage.accounts).toBe('partial');
    expect(canonical.coverage.schedules).toBe('partial');
    expect(observations(canonical, 'account_type')).toEqual([
      expect.objectContaining({
        scope: { kind: 'account', id: 'account-incomplete' },
        state: 'unknown',
        observedAt: null,
      }),
    ]);
    expect(observations(canonical, 'credit_card_obligation_coverage')).toEqual([]);
    expect(observations(canonical, 'account_balance')).toEqual([
      expect.objectContaining({
        scope: { kind: 'account', id: 'account-incomplete' },
        state: 'unavailable',
        observedAt: null,
      }),
    ]);
    expect(observations(canonical, 'schedule_coverage')).toEqual([
      expect.objectContaining({
        scope: { kind: 'schedule', id: 'schedule-incomplete' },
        state: 'unavailable',
        observedAt: null,
      }),
    ]);

    expect(canonical.observations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'account_balance',
          scope: { kind: 'account', id: 'account-incomplete' },
          state: 'complete',
        }),
        expect.objectContaining({
          kind: 'account_type',
          scope: { kind: 'account', id: 'account-incomplete' },
          state: 'complete',
        }),
        expect.objectContaining({
          kind: 'schedule_coverage',
          scope: { kind: 'schedule', id: 'schedule-incomplete' },
          state: 'complete',
        }),
      ]),
    );
    expect(canonical.legacySnapshot).toEqual(result.snapshot);
  });
});
