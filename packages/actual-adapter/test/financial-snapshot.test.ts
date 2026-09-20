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
import {
  mergeUserAttestedLiquidityObservations,
  normalizeActualScheduleLiquiditySource,
  normalizeActualTransferSettlementRecords,
  withLiquidityFacts,
} from '../src/liquidity-normalizer';
import * as liquidityNormalizer from '../src/liquidity-normalizer';

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
  it('records successful account enumeration independently from unavailable per-account facts', async () => {
    const result = await synchronize(
      createActualClient({
        getAccounts: vi
          .fn()
          .mockResolvedValue([
            account('known-balance', 'Known balance', 12000),
            account('missing-balance', 'Missing balance', null),
          ]),
        getAccountBalance: vi.fn().mockRejectedValue(new Error('balance unavailable')),
      }),
    );
    expect(result.financialSnapshot.coverage.accounts).toBe('partial');
    expect(
      result.financialSnapshot.observations.filter(
        (item) => item.kind === 'account_collection_coverage',
      ),
    ).toEqual([
      {
        kind: 'account_collection_coverage',
        scope: { kind: 'global' },
        state: 'complete',
        observedAt: CAPTURED_AT,
        evidence: [],
      },
    ]);
    expect(
      result.financialSnapshot.observations
        .filter((item) => item.kind === 'account_type')
        .map((item) => item.state),
    ).toEqual(['unknown', 'unknown']);
    expect(
      result.financialSnapshot.observations.find(
        (item) =>
          item.kind === 'account_balance' &&
          item.scope.kind === 'account' &&
          item.scope.id === 'missing-balance',
      )?.state,
    ).toBe('unavailable');
    expect(result.financialSnapshot.liquidity?.accounts[1]?.balanceEvidence.state).toBe(
      'unavailable',
    );
  });

  it('distinguishes confirmed empty account enumeration from an unavailable collection', async () => {
    const empty = (await synchronize(createActualClient())).financialSnapshot;
    expect(empty.coverage.accounts).toBe('empty');
    expect(
      empty.observations.filter((item) => item.kind === 'account_collection_coverage'),
    ).toEqual([
      {
        kind: 'account_collection_coverage',
        scope: { kind: 'global' },
        state: 'complete',
        observedAt: CAPTURED_AT,
        evidence: [],
      },
    ]);
    const failed = await synchronize(
      createActualClient({
        getAccounts: vi.fn().mockRejectedValue(new Error('account collection unavailable')),
      }),
    );
    expect(failed.financialSnapshot.coverage.accounts).toBe('unknown');
    expect(failed.snapshot.accounts).toEqual([]);
    expect(
      failed.financialSnapshot.observations.filter(
        (item) => item.kind === 'account_collection_coverage',
      ),
    ).toEqual([
      {
        kind: 'account_collection_coverage',
        scope: { kind: 'global' },
        state: 'unknown',
        observedAt: null,
        evidence: [],
      },
    ]);
  });

  it('returns trusted normalized Actual settlement sides before source transfer links are discarded', async () => {
    const source = [
      transaction({
        id: 'source-import',
        account: 'cash',
        date: '2026-08-23',
        amount: -2300,
        transfer_id: 'destination-import',
        imported_id: 'bank-debit',
        reconciled: true,
      }),
      transaction({
        id: 'destination-import',
        account: 'savings',
        date: '2026-08-23',
        amount: 2300,
        transfer_id: 'source-import',
        imported_id: 'bank-credit',
        reconciled: true,
      }),
      transaction({
        id: 'manual-source',
        account: 'cash',
        date: '2026-08-23',
        amount: -100,
        transfer_id: 'manual-destination',
        reconciled: true,
      }),
      transaction({
        id: 'manual-destination',
        account: 'savings',
        date: '2026-08-23',
        amount: 100,
        transfer_id: 'manual-source',
        reconciled: true,
      }),
    ];
    const result = await synchronize(
      createActualClient({
        getAccounts: vi
          .fn()
          .mockResolvedValue([
            account('cash', 'Cash', 15000),
            account('savings', 'Savings', 20000),
          ]),
        getTransactions: vi
          .fn()
          .mockImplementation(async (accountId: string) =>
            source.filter((item) => item.account === accountId),
          ),
      }),
    );
    expect(result.transferSettlementRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'source-import',
          accountId: 'cash',
          pairId: 'destination-import:source-import',
          amount: { minorUnits: '-2300', currency: 'USD' },
          importedId: 'bank-debit',
          reconciled: true,
          provenance: 'actual_import',
          occurredAt: '2026-08-23',
          observedAt: CAPTURED_AT,
        }),
        expect.objectContaining({
          id: 'destination-import',
          accountId: 'savings',
          pairId: 'destination-import:source-import',
          amount: { minorUnits: '2300', currency: 'USD' },
          importedId: 'bank-credit',
          reconciled: true,
          provenance: 'actual_import',
          occurredAt: '2026-08-23',
          observedAt: CAPTURED_AT,
        }),
        expect.objectContaining({
          id: 'manual-source',
          importedId: null,
          provenance: 'manual_ledger',
        }),
        expect.objectContaining({
          id: 'manual-destination',
          importedId: null,
          provenance: 'manual_ledger',
        }),
      ]),
    );
    expect(result.transferSettlementRecords).toHaveLength(4);
    expect(result.financialSnapshot.coverage.transactions).toBe('complete');
  });

  it('retains unverified linked transfer credits despite manual clearing and current-ledger confirmation', async () => {
    const original = (
      await synchronize(
        createActualClient({
          getAccounts: vi.fn().mockResolvedValue([account('cash', 'Cash', 15000)]),
          getTransactions: vi.fn().mockResolvedValue([
            transaction({
              id: 'manual-credit',
              account: 'cash',
              date: '2026-08-23',
              amount: 1000,
              transfer_id: 'manual-debit',
              cleared: true,
              reconciled: true,
            }),
            transaction({
              id: 'imported-credit',
              account: 'cash',
              date: '2026-08-23',
              amount: 2000,
              transfer_id: 'imported-debit',
              imported_id: 'bank-import',
              cleared: true,
              reconciled: true,
            }),
            transaction({
              id: 'unreconciled-credit',
              account: 'cash',
              date: '2026-08-23',
              amount: 3000,
              transfer_id: 'unreconciled-debit',
              imported_id: 'unreconciled-import',
              cleared: true,
              reconciled: false,
            }),
            transaction({
              id: 'ordinary-manual-income',
              account: 'cash',
              date: '2026-08-23',
              amount: 4000,
              cleared: true,
              reconciled: true,
            }),
          ]),
        }),
      )
    ).financialSnapshot;
    expect(original.liquidity?.accounts[0]?.unsettledFlows).toEqual([
      expect.objectContaining({
        id: 'manual-credit',
        direction: 'inflow',
        includedInBalance: true,
        amount: { minorUnits: '1000', currency: 'USD' },
        provenance: 'manual_ledger',
      }),
      expect.objectContaining({
        id: 'unreconciled-credit',
        direction: 'inflow',
        includedInBalance: true,
        amount: { minorUnits: '3000', currency: 'USD' },
        provenance: 'actual_import',
      }),
    ]);
    expect(original.liquidity?.accounts[0]?.activityEvidence.reasons).toContain(
      'manual_transfer_credit_unverified',
    );
    const bound = liquidityNormalizer.bindUserAttestedLiquidityObservations(original, [
      {
        accountId: 'cash',
        observedAt: CAPTURED_AT,
        expiresAt: '2026-08-23T12:15:00Z',
        currentLedgerConfirmed: true,
        unsettledFlows: [],
      },
    ]);
    const merged = mergeUserAttestedLiquidityObservations(original, bound);
    expect(merged.liquidity?.accounts[0]?.unsettledFlows).toEqual(
      original.liquidity?.accounts[0]?.unsettledFlows,
    );
    expect(merged.liquidity?.accounts[0]?.activityEvidence.reasons).toContain(
      'manual_transfer_credit_unverified',
    );
  });

  it('keeps plain Actual freshness unknown and confirms current ledger freshness without replacing authoritative money', async () => {
    const original = (
      await synchronize(
        createActualClient({
          getAccounts: vi.fn().mockResolvedValue([account('cash', 'Cash', 15000)]),
        }),
      )
    ).financialSnapshot;
    expect(original.liquidity?.accounts[0]?.freshnessEvidence).toMatchObject({
      state: 'unknown',
      source: 'actual_ledger',
      observedAt: null,
    });
    const merged = mergeUserAttestedLiquidityObservations(
      original,
      liquidityNormalizer.bindUserAttestedLiquidityObservations(original, [
        {
          accountId: 'cash',
          observedAt: CAPTURED_AT,
          expiresAt: '2026-08-23T12:15:00Z',
          currentLedgerConfirmed: true,
          kind: 'cash',
          currency: 'USD',
          owned: true,
          holds: { minorUnits: '0', currency: 'USD' },
        },
      ]),
    );
    expect(merged.liquidity?.accounts[0]?.freshnessEvidence).toMatchObject({
      state: 'known',
      source: 'user_attested',
      observedAt: CAPTURED_AT,
      expiresAt: '2026-08-23T12:15:00Z',
    });
    expect(merged.liquidity?.accounts[0]?.recordedBalance).toEqual(
      original.liquidity?.accounts[0]?.recordedBalance,
    );
    expect(merged.liquidity?.accounts[0]?.balanceEvidence).toEqual(
      original.liquidity?.accounts[0]?.balanceEvidence,
    );
    expect(merged.liquidity?.accounts[0]?.balanceEvidence.source).toBe('actual_ledger');
    expect(merged.liquidity?.accounts[0]?.balanceEvidence.reasons).toContain(
      'ledger_balance_not_institution_freshness',
    );
  });

  it('binds ledger confirmation to account material, not capture time or caller-supplied hashes', async () => {
    const snapshot = async (balance: number, pending = false) =>
      (
        await synchronize(
          createActualClient({
            getAccounts: vi.fn().mockResolvedValue([account('cash', 'Cash', balance)]),
            getTransactions: vi.fn().mockResolvedValue(
              pending
                ? [
                    transaction({
                      id: 'new-pending',
                      account: 'cash',
                      date: '2026-08-23',
                      amount: -100,
                      cleared: false,
                    }),
                  ]
                : [],
            ),
          }),
        )
      ).financialSnapshot;
    const original = await snapshot(15000);
    const input = {
      accountId: 'cash',
      observedAt: CAPTURED_AT,
      expiresAt: '2026-08-23T12:15:00Z',
      currentLedgerConfirmed: true as const,
    };
    const bound = liquidityNormalizer.bindUserAttestedLiquidityObservations(original, [input]);
    expect(
      liquidityNormalizer.userAttestedLiquidityObservationSchema.safeParse(bound[0]).success,
    ).toBe(false);
    expect(() => mergeUserAttestedLiquidityObservations(original, [input])).toThrow();
    expect(
      mergeUserAttestedLiquidityObservations(original, bound).liquidity?.accounts[0]
        ?.freshnessEvidence.state,
    ).toBe('known');
    vi.setSystemTime(new Date('2026-08-23T12:01:00Z'));
    const recaptured = await snapshot(15000);
    expect(
      mergeUserAttestedLiquidityObservations(recaptured, bound).liquidity?.accounts[0]
        ?.freshnessEvidence,
    ).toMatchObject({
      source: 'user_attested',
      observedAt: CAPTURED_AT,
      expiresAt: input.expiresAt,
    });
    const changedBalance = await snapshot(15001);
    const changedActivity = await snapshot(15000, true);
    expect(() => mergeUserAttestedLiquidityObservations(changedBalance, bound)).toThrow();
    expect(() => mergeUserAttestedLiquidityObservations(changedActivity, bound)).toThrow();
  });

  it('does not let user attestations overwrite ledger balances or erase ledger flow and schedule evidence', async () => {
    const original = (
      await synchronize(
        createActualClient({
          getAccounts: vi.fn().mockResolvedValue([account('cash', 'Cash', 12000)]),
          getTransactions: vi.fn().mockResolvedValue([
            transaction({
              id: 'debit',
              account: 'cash',
              date: '2026-08-23',
              amount: -2000,
              cleared: false,
            }),
          ]),
          getSchedules: vi.fn().mockResolvedValue([
            schedule({
              id: 'bill',
              name: 'Bill',
              account: 'cash',
              amount: -3000,
              next_date: '2026-08-25',
            }),
          ]),
        }),
      )
    ).financialSnapshot;
    const attestation = {
      accountId: 'cash',
      observedAt: CAPTURED_AT,
      expiresAt: '2026-08-24T12:00:00Z',
    };
    expect(() =>
      mergeUserAttestedLiquidityObservations(original, [
        {
          ...attestation,
          recordedBalance: { minorUnits: '999999', currency: 'USD' },
        } as never,
      ]),
    ).toThrow();
    expect(() =>
      mergeUserAttestedLiquidityObservations(original, [
        {
          ...attestation,
          source: 'institution_provider',
        } as never,
      ]),
    ).toThrow();
    const merged = mergeUserAttestedLiquidityObservations(original, [
      {
        ...attestation,
        kind: 'cash',
        currency: 'USD',
        unsettledFlows: [],
        obligations: [],
      },
    ]);
    expect(merged.liquidity?.accounts[0]?.recordedBalance).toEqual(
      original.liquidity?.accounts[0]?.recordedBalance,
    );
    expect(merged.liquidity?.accounts[0]?.unsettledFlows).toEqual(
      original.liquidity?.accounts[0]?.unsettledFlows,
    );
    expect(merged.liquidity?.accounts[0]?.obligations).toEqual(
      original.liquidity?.accounts[0]?.obligations,
    );
    expect(merged.liquidity?.accounts[0]?.scheduleEvidence.state).toBe('unknown');
    expect(merged.liquidity?.accounts[0]?.kindEvidence).toMatchObject({
      source: 'user_attested',
      expiresAt: attestation.expiresAt,
    });
    expect(merged.contentHash).not.toBe(original.contentHash);
    expect(merged.liquidity?.ledgerContentHash).toBe(original.liquidity?.ledgerContentHash);
    expect(original.liquidity?.accounts[0]?.kind).toBe('unknown');
  });

  it('preserves signed Actual schedule ranges without claiming exact coverage', () => {
    expect(
      normalizeActualScheduleLiquiditySource(
        schedule({
          id: 'variable-bill',
          name: 'Variable',
          account: 'cash',
          amountOp: 'isbetween',
          amount: { num1: -4000, num2: -2000 },
          next_date: '2026-08-25',
        }),
        'USD',
      ),
    ).toMatchObject({
      id: 'variable-bill',
      certainty: 'range',
      amount: null,
      minimum: { minorUnits: '-4000', currency: 'USD' },
      maximum: { minorUnits: '-2000', currency: 'USD' },
    });
    const records = normalizeActualTransferSettlementRecords(
      [
        transaction({
          id: 'debit',
          account: 'cash',
          date: '2026-08-23',
          amount: -2000,
          transfer_id: 'credit',
          imported_id: 'user-set-id',
          reconciled: true,
        }),
      ],
      CAPTURED_AT,
      'USD',
    );
    expect(records[0]).toMatchObject({
      importedId: 'user-set-id',
      reconciled: true,
      provenance: 'actual_import',
    });
  });

  it('does not turn a manual linked transfer into imported evidence without independent import IDs', () => {
    const records = normalizeActualTransferSettlementRecords(
      [
        transaction({
          id: 'manual-debit',
          account: 'cash',
          date: '2026-08-23',
          amount: -2000,
          transfer_id: 'manual-credit',
          reconciled: true,
        }),
        transaction({
          id: 'manual-credit',
          account: 'savings',
          date: '2026-08-23',
          amount: 2000,
          transfer_id: 'manual-debit',
          reconciled: true,
        }),
      ],
      CAPTURED_AT,
      'USD',
    );
    expect(records.map((record) => record.provenance)).toEqual(['manual_ledger', 'manual_ledger']);
  });

  it('keeps uncertain schedule amounts in typed facts, never in public reason codes', async () => {
    const result = await synchronize(
      createActualClient({
        getAccounts: vi.fn().mockResolvedValue([account('cash', 'Cash', 12000)]),
        getSchedules: vi.fn().mockResolvedValue([
          schedule({
            id: 'private-variable-bill',
            name: 'Variable',
            account: 'cash',
            rule: 'private-rule',
            amountOp: 'isbetween',
            amount: { num1: -4321, num2: -2345 },
            date: '2026-08-25',
            next_date: '2026-08-25',
          }),
        ]),
      }),
    );
    expect(result.financialSnapshot.liquidity?.schedules).toEqual([
      {
        id: 'private-variable-bill',
        accountId: 'cash',
        categoryId: null,
        ruleId: 'private-rule',
        dueDate: '2026-08-25',
        certainty: 'range',
        amount: null,
        recurrence: null,
        minimum: { minorUnits: '-4321', currency: 'USD' },
        maximum: { minorUnits: '-2345', currency: 'USD' },
      },
    ]);
    expect(result.financialSnapshot.liquidity?.accounts[0]?.scheduleEvidence).toMatchObject({
      state: 'unknown',
      reasons: ['schedule_uncertain'],
    });
    const changedAmount = structuredClone(result.financialSnapshot.liquidity!);
    changedAmount.schedules[0]!.minimum!.minorUnits = '-4322';
    expect(withLiquidityFacts(result.financialSnapshot, changedAmount).contentHash).not.toBe(
      result.financialSnapshot.contentHash,
    );
  });

  it('keeps an exact one-time Actual bill usable while preserving recurring configuration as unsupported coverage', async () => {
    const result = await synchronize(
      createActualClient({
        getAccounts: vi
          .fn()
          .mockResolvedValue([
            account('cash', 'Cash', 12000),
            account('recurring', 'Recurring', 12000),
          ]),
        getSchedules: vi.fn().mockResolvedValue([
          schedule({
            id: 'once',
            name: 'One-time bill',
            account: 'cash',
            amount: -3456,
            date: '2026-08-25',
            next_date: '2026-08-25',
          }),
          schedule({
            id: 'monthly',
            name: 'Monthly bill',
            account: 'recurring',
            amount: -2000,
            date: {
              frequency: 'monthly',
              interval: 2,
              patterns: [{ type: 'day', value: 15 }],
              start: '2026-08-15',
              endMode: 'on_date',
              endDate: '2027-08-15',
              skipWeekend: true,
              weekendSolveMode: 'before',
            },
            next_date: '2026-10-15',
          }),
        ]),
      }),
    );
    expect(result.financialSnapshot.liquidity?.accounts[0]).toMatchObject({
      scheduleEvidence: { state: 'known', reasons: [] },
      obligations: [
        { id: 'once', amount: { minorUnits: '3456', currency: 'USD' }, dueAt: '2026-08-25' },
      ],
    });
    expect(result.financialSnapshot.liquidity?.accounts[1]?.scheduleEvidence).toMatchObject({
      state: 'unknown',
      reasons: ['schedule_recurrence_unsupported'],
    });
    expect(result.financialSnapshot.liquidity?.schedules[1]?.recurrence).toMatchObject({
      frequency: 'monthly',
      interval: 2,
      patterns: [{ kind: 'day', value: 15 }],
      start: '2026-08-15',
      endMode: 'on_date',
      endDate: '2027-08-15',
      skipWeekend: true,
      weekendSolveMode: 'before',
    });
  });

  it.each([
    { label: 'partial posted amount', parts: [{ id: 'part', amount: -400, cleared: true }] },
    { label: 'overpayment', parts: [{ id: 'over', amount: -1200, cleared: true }] },
    { label: 'wrong-sign linked amount', parts: [{ id: 'refund', amount: 1000, cleared: true }] },
    {
      label: 'offsetting wrong-sign links',
      parts: [
        { id: 'over', amount: -1200, cleared: true },
        { id: 'refund', amount: 200, cleared: true },
      ],
    },
    {
      label: 'duplicate row identity',
      parts: [
        { id: 'duplicate', amount: -500, cleared: true },
        { id: 'duplicate', amount: -500, cleared: true },
      ],
    },
    {
      label: 'duplicate imported identity',
      parts: [
        { id: 'row-a', imported_id: 'same-import', amount: -500, cleared: true },
        { id: 'row-b', imported_id: 'same-import', amount: -500, cleared: true },
      ],
    },
  ])('fails closed rather than discharging a scheduled bill from $label', async ({ parts }) => {
    const result = await synchronize(
      createActualClient({
        getAccounts: vi.fn().mockResolvedValue([account('cash', 'Cash', 9000)]),
        getSchedules: vi.fn().mockResolvedValue([
          schedule({
            id: 'bill',
            name: 'Bill',
            account: 'cash',
            date: '2026-08-25',
            next_date: '2026-08-25',
            amount: -1000,
          }),
        ]),
        getTransactions: vi
          .fn()
          .mockResolvedValue(
            parts.map((part) =>
              transaction({ account: 'cash', date: '2026-08-25', schedule: 'bill', ...part }),
            ),
          ),
      }),
    );
    expect(result.financialSnapshot.liquidity?.accounts[0]).toMatchObject({
      scheduleEvidence: { state: 'unknown', reasons: ['schedule_linked_amount_ambiguous'] },
      obligations: [
        {
          id: 'bill',
          amount: { minorUnits: '1000', currency: 'USD' },
          paid: false,
          includedInBalance: false,
        },
      ],
    });
  });

  it('requires the full exact cleared total for payment, independently of exact total ledger inclusion', async () => {
    const result = async (secondCleared: boolean) =>
      synchronize(
        createActualClient({
          getAccounts: vi.fn().mockResolvedValue([account('cash', 'Cash', 9000)]),
          getSchedules: vi.fn().mockResolvedValue([
            schedule({
              id: 'bill',
              name: 'Bill',
              account: 'cash',
              date: '2026-08-25',
              next_date: '2026-08-25',
              amount: -1000,
            }),
          ]),
          getTransactions: vi.fn().mockResolvedValue([
            transaction({
              id: 'first',
              account: 'cash',
              date: '2026-08-25',
              schedule: 'bill',
              amount: -600,
              cleared: true,
            }),
            transaction({
              id: 'second',
              account: 'cash',
              date: '2026-08-25',
              schedule: 'bill',
              amount: -400,
              cleared: secondCleared,
            }),
          ]),
        }),
      );
    expect((await result(false)).financialSnapshot.liquidity?.accounts[0]).toMatchObject({
      scheduleEvidence: { state: 'known' },
      obligations: [{ includedInBalance: true, paid: false }],
    });
    expect((await result(true)).financialSnapshot.liquidity?.accounts[0]).toMatchObject({
      scheduleEvidence: { state: 'known' },
      obligations: [{ includedInBalance: true, paid: true }],
    });
  });

  it('excludes source-declared income from cash buckets without hiding missing expense availability', async () => {
    const result = await synchronize(
      createActualClient({
        getCategories: vi.fn().mockResolvedValue([
          { id: 'food', name: 'Food', is_income: false },
          { id: 'missing-expense', name: 'Missing expense', is_income: false },
          { id: 'starting-balances', name: 'Starting balances', is_income: true },
          { id: 'income-row', name: 'Income row', is_income: true },
        ]),
        getBudgetMonths: vi.fn().mockResolvedValue(['2026-08']),
        getBudgetMonth: vi.fn().mockResolvedValue({
          month: '2026-08',
          categoryGroups: [
            {
              id: 'all',
              categories: [
                { id: 'food', budgeted: 1000, spent: -100, balance: 3000 },
                {
                  id: 'income-row',
                  is_income: true,
                  budgeted: 10000,
                  received: 10000,
                  balance: 10000,
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(result.financialSnapshot.liquidity?.categories).toEqual([
      expect.objectContaining({
        categoryId: 'food',
        availability: { minorUnits: '3000', currency: 'USD' },
        evidence: expect.objectContaining({ state: 'known' }),
      }),
      expect.objectContaining({
        categoryId: 'missing-expense',
        evidence: expect.objectContaining({ state: 'unavailable' }),
      }),
    ]);
    expect(
      result.snapshot.categories
        .filter((category) => category.isIncome)
        .map((category) => category.id),
    ).toEqual(['starting-balances', 'income-row']);
  });

  it('keeps current authoritative balance separate from future additional assignments, excluding rolled carryover', async () => {
    const result = await synchronize(
      createActualClient({
        getCategories: vi.fn().mockResolvedValue([{ id: 'food', name: 'Food', is_income: false }]),
        getBudgetMonths: vi.fn().mockResolvedValue(['2026-08', '2026-09', '2026-10']),
        getBudgetMonth: vi.fn().mockImplementation(async (month: string) => ({
          month,
          categoryGroups: [
            {
              id: 'living',
              categories: [
                {
                  id: 'food',
                  ...(month !== '2026-10' ? { budgeted: 1000 } : {}),
                  spent: 0,
                  balance: month === '2026-08' ? 3000 : 4000,
                  carryover: false,
                },
              ],
            },
          ],
        })),
      }),
    );
    expect(result.financialSnapshot.liquidity?.categories).toEqual([
      expect.objectContaining({
        categoryId: 'food',
        cashBucketId: 'actual:category:food:2026-08',
        periodKind: 'current',
        availability: { minorUnits: '3000', currency: 'USD' },
        evidence: expect.objectContaining({ state: 'known' }),
      }),
      expect.objectContaining({
        categoryId: 'food',
        cashBucketId: 'actual:category:food:2026-09',
        periodKind: 'future',
        availability: { minorUnits: '1000', currency: 'USD' },
        evidence: expect.objectContaining({ state: 'known' }),
      }),
      expect.objectContaining({
        categoryId: 'food',
        cashBucketId: 'actual:category:food:2026-10',
        periodKind: 'future',
        evidence: expect.objectContaining({ state: 'unavailable' }),
      }),
    ]);
  });

  it('preserves authoritative Actual category balance independently of assigned budget and month', async () => {
    const result = await synchronize(
      createActualClient({
        getCategories: vi.fn().mockResolvedValue([{ id: 'food', name: 'Food', is_income: false }]),
        getBudgetMonths: vi.fn().mockResolvedValue(['2026-08', '2026-09']),
        getBudgetMonth: vi.fn().mockImplementation(async (month: string) => ({
          month,
          categoryGroups: [
            {
              id: 'essentials',
              categories: [
                {
                  id: 'food',
                  budgeted: month === '2026-08' ? 10000 : 0,
                  spent: month === '2026-08' ? -2000 : 0,
                  balance: 13700,
                },
              ],
            },
          ],
        })),
      }),
    );
    expect(result.financialSnapshot).toHaveProperty('liquidity');
    expect(result.financialSnapshot.liquidity?.categories).toEqual([
      expect.objectContaining({
        categoryId: 'food',
        asOfMonth: '2026-08',
        kind: 'ordinary',
        periodKind: 'current',
        cashBucketId: 'actual:category:food:2026-08',
        availability: { minorUnits: '13700', currency: 'USD' },
        evidence: expect.objectContaining({ state: 'known', source: 'actual_ledger' }),
      }),
      expect.objectContaining({
        categoryId: 'food',
        asOfMonth: '2026-09',
        kind: 'ordinary',
        periodKind: 'future',
        cashBucketId: 'actual:category:food:2026-09',
        availability: { minorUnits: '0', currency: 'USD' },
      }),
    ]);
  });

  it('retains signed unsettled inclusion and source links with Actual import provenance distinct from bank confirmation', async () => {
    const result = await synchronize(
      createActualClient({
        getAccounts: vi.fn().mockResolvedValue([account('cash', 'Cash', 12000)]),
        getTransactions: vi.fn().mockResolvedValue([
          transaction({
            id: 'incoming',
            account: 'cash',
            date: '2026-08-23',
            amount: 5000,
            cleared: false,
          }),
          transaction({
            id: 'outgoing',
            account: 'cash',
            date: '2026-08-23',
            amount: -2000,
            cleared: false,
            schedule: 'bill',
            transfer_id: 'other-side',
            imported_id: 'user-set-id',
          }),
        ]),
      }),
    );
    const facts = result.financialSnapshot.liquidity?.accounts[0];
    expect(facts?.unsettledFlows).toEqual([
      expect.objectContaining({
        id: 'incoming',
        direction: 'inflow',
        amount: { minorUnits: '5000', currency: 'USD' },
        includedInBalance: true,
      }),
      expect.objectContaining({
        id: 'outgoing',
        direction: 'outflow',
        amount: { minorUnits: '2000', currency: 'USD' },
        includedInBalance: true,
        scheduleId: 'bill',
        transferTransactionId: 'other-side',
        importedId: 'user-set-id',
        provenance: 'actual_import',
      }),
    ]);
    expect(facts).toMatchObject({
      kind: 'unknown',
      balanceEvidence: { source: 'actual_ledger' },
      currencyEvidence: { state: 'unknown' },
      holdsEvidence: { state: 'unknown' },
    });
  });

  it('distinguishes unavailable balance and activity from explicit ledger zero and known empty activity', async () => {
    const missing = await synchronize(
      createActualClient({
        getAccounts: vi.fn().mockResolvedValue([account('cash', 'Cash', null)]),
        getAccountBalance: vi.fn().mockRejectedValue(new Error('unavailable')),
        getTransactions: vi.fn().mockRejectedValue(new Error('unavailable')),
      }),
    );
    const empty = await synchronize(
      createActualClient({
        getAccounts: vi.fn().mockResolvedValue([account('cash', 'Cash', 0)]),
      }),
    );
    expect(missing.financialSnapshot.liquidity?.accounts[0]).toMatchObject({
      balanceEvidence: { state: 'unavailable' },
      activityEvidence: { state: 'unavailable' },
    });
    expect(empty.financialSnapshot.liquidity?.accounts[0]).toMatchObject({
      recordedBalance: { minorUnits: '0', currency: 'USD' },
      balanceEvidence: { state: 'known' },
      activityEvidence: { state: 'known' },
      unsettledFlows: [],
    });
  });

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
