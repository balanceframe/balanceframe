import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActualConnector, type ActualClient } from '../src/connector';
import { NullCredentialStore } from '../src/credentials';
import type { ManualTransactionInput, ManualTransactionResult } from '../src/types';
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

const BUDGET_ID = 'budget_phase9';
const BUDGET_GROUP_ID = 'budget_group_phase9';
const CATEGORY_ID = 'category_groceries';
const CATEGORY_GROUP_ID = 'group_expenses';
const SOURCE_ACCOUNT_ID = 'account_checking';
const DESTINATION_ACCOUNT_ID = 'account_savings';
const SOURCE_TRANSFER_PAYEE_ID = 'payee_transfer_to_checking';
const DESTINATION_TRANSFER_PAYEE_ID = 'payee_transfer_to_savings';
const INITIAL_ASSIGNMENT = 12_500;
const TRANSFER_ID = 'transfer_phase9_001';
const TRANSFER_CORRELATION_ID = 'transfer-correlation-001';
const TRANSFER_MARKER = `balanceframe:transfer:${TRANSFER_ID}:${TRANSFER_CORRELATION_ID}`;

/** Exact adapter-side compare-and-set authority expected by an approved plan. */
interface BudgetAssignmentPrecondition {
  readonly budgetId: string;
  /** Current assigned minor-unit value captured by the source plan, not the target. */
  readonly expectedAmount: number;
  readonly currency: string;
  /** Synchronous final authority fence, called immediately before the SDK write. */
  readonly assertExecutionCurrent: () => void;
}

type BudgetAssignmentResult =
  | { success: true; id: string }
  | { success: false; error: string; code: string; reviewRequired?: true };

type BudgetAssignmentPort = {
  setBudgetAmount(
    month: string,
    categoryId: string,
    amount: number,
    precondition: BudgetAssignmentPrecondition,
  ): Promise<BudgetAssignmentResult>;
};

interface ManualTransactionPrecondition {
  readonly budgetId: string;
  readonly assertExecutionCurrent: () => void;
}

type ManualTransactionPort = {
  createManualTransaction(
    input: ManualTransactionInput,
    precondition: ManualTransactionPrecondition,
  ): Promise<ManualTransactionResult>;
};
interface WalletAccountInput {
  readonly walletId: string;
  readonly accountName: string;
  readonly currency: string;
}

interface WalletAccountPrecondition {
  readonly budgetId: string;
  readonly assertExecutionCurrent: () => void;
}

type WalletAccountResult =
  | { success: true; walletId: string; accountId: string; verified: true }
  | { success: false; code: string; reviewRequired?: true };

type WalletAccountPort = {
  createWalletAccount(
    input: WalletAccountInput,
    precondition: WalletAccountPrecondition,
  ): Promise<WalletAccountResult>;
};

interface LedgerTransferInput {
  readonly transferId: string;
  readonly correlationId: string;
  readonly sourceAccountId: string;
  readonly destinationAccountId: string;
  /** Positive exact amount in source-currency minor units. */
  readonly amount: number;
  readonly date: string;
}

interface LedgerTransferPrecondition {
  readonly budgetId: string;
  readonly sourceBalance: number;
  readonly destinationBalance: number;
  readonly currency: string;
  readonly assertExecutionCurrent: () => void;
}

type LedgerTransferResult =
  | {
      success: true;
      transferId: string;
      sourceTransactionId: string;
      destinationTransactionId: string;
      verified: true;
    }
  | { success: false; code: string; reviewRequired?: true };

type LedgerTransferPort = {
  createLedgerTransfer(
    input: LedgerTransferInput,
    precondition: LedgerTransferPrecondition,
  ): Promise<LedgerTransferResult>;
};

const budget: APIFileEntity = {
  id: BUDGET_ID,
  groupId: BUDGET_GROUP_ID,
  name: 'Phase 9 test budget',
  cloudFileId: 'cloud_phase9',
  encrypted: false,
  state: 'remote',
};
const category: APICategoryEntity = {
  id: CATEGORY_ID,
  name: 'Groceries',
  group_id: CATEGORY_GROUP_ID,
  is_income: false,
  hidden: false,
};
const categoryGroup: APICategoryGroupEntity = {
  id: CATEGORY_GROUP_ID,
  name: 'Expenses',
  is_income: false,
  hidden: false,
};

interface Harness {
  connector: ActualConnector;
  client: ActualClient;
  events: string[];
  accounts: APIAccountEntity[];
  transactions: TransactionEntity[];
  payees: APIPayeeEntity[];
  assignment(): number;
  setAssignment(value: number): void;
  balance(accountId: string): number;
  setBalance(accountId: string, value: number): void;
}

const liveConnectors: ActualConnector[] = [];

afterEach(async () => {
  for (const connector of liveConnectors.splice(0)) await connector.disconnect();
});

function createHarness(
  options: { currency?: string; mode?: 'observe' | 'reviewAndApply' } = {},
): Harness {
  let budgeted = INITIAL_ASSIGNMENT;
  const events: string[] = [];
  const accounts: APIAccountEntity[] = [];
  const transactions: TransactionEntity[] = [];
  const payees: APIPayeeEntity[] = [];
  const balances = new Map<string, number>();
  const getBudgetMonth = vi.fn(async (month: string) => {
    events.push('read');
    return {
      month,
      incomeAvailable: 0,
      lastMonthOverspent: 0,
      forNextMonth: 0,
      totalBudgeted: budgeted,
      toBudget: 0,
      fromLastMonth: 0,
      totalIncome: 0,
      totalSpent: 0,
      totalBalance: budgeted,
      categoryGroups: [{ ...categoryGroup, categories: [{ ...category, budgeted }] }],
    };
  });
  const createAccount = vi.fn(
    async (input: Omit<APIAccountEntity, 'id'>, initialBalance?: number) => {
      events.push('createAccount');
      const id = 'actual-generated-account-id';
      accounts.push({ id, ...input, balance_current: null });
      balances.set(id, initialBalance ?? 0);
      return id;
    },
  );
  const client: ActualClient = {
    init: vi.fn().mockResolvedValue({
      send: vi.fn(),
      getDataDir: vi.fn(),
      sendMessage: vi.fn(),
      amountToInteger: vi.fn(),
      integerToAmount: vi.fn(),
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getBudgets: vi.fn().mockResolvedValue([budget]),
    downloadBudget: vi.fn().mockResolvedValue(undefined),
    loadBudget: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn(async () => {
      events.push('sync');
    }),
    getServerVersion: vi.fn().mockResolvedValue({ version: '26.10.0' }),
    getAccounts: vi.fn(async () => {
      events.push('accounts');
      return accounts.map((account) => ({ ...account }));
    }),
    getAccountBalance: vi.fn(async (accountId: string) => {
      events.push(`balance:${accountId}`);
      return balances.get(accountId) ?? 0;
    }),
    getTransactions: vi.fn(async (accountId: string, start: string, end: string) => {
      events.push(`transactions:${accountId}`);
      return transactions
        .filter(
          (transaction) =>
            transaction.account === accountId &&
            transaction.date >= start &&
            transaction.date <= end,
        )
        .map((transaction) => ({ ...transaction }));
    }),
    getPayees: vi.fn(async () => {
      events.push('payees');
      return payees.map((payee) => ({ ...payee }));
    }),
    getCategories: vi.fn().mockResolvedValue([category]),
    getCategoryGroups: vi.fn().mockResolvedValue([categoryGroup]),
    getBudgetMonths: vi.fn().mockResolvedValue([] as string[]),
    getBudgetMonth,
    getRules: vi.fn().mockResolvedValue([] as RuleEntity[]),
    getSchedules: vi.fn().mockResolvedValue([] as APIScheduleEntity[]),
    getTags: vi.fn().mockResolvedValue([] as APITagEntity[]),
    runBankSync: vi.fn().mockResolvedValue(undefined),
    addTransactions: vi.fn(async () => {
      events.push('addTransactions');
      return 'ok' as const;
    }),
    createAccount,
    updateTransaction: vi.fn().mockResolvedValue(undefined),
    createRule: vi.fn().mockResolvedValue({ id: 'new-rule-id' }),
    deleteRule: vi.fn().mockResolvedValue(true),
    setBudgetAmount: vi.fn(async (_month: string, _categoryId: string, amount: number) => {
      events.push('write');
      budgeted = amount;
    }),
  };
  const connector = new ActualConnector({
    client,
    credentialStore: new NullCredentialStore(),
    mode: options.mode ?? 'reviewAndApply',
    currency: options.currency ?? 'USD',
    cacheDir: '/tmp/bf-consequential-action-test',
  });
  liveConnectors.push(connector);
  return {
    connector,
    client,
    events,
    accounts,
    transactions,
    payees,
    assignment: () => budgeted,
    setAssignment: (value) => {
      budgeted = value;
    },
    balance: (accountId) => balances.get(accountId) ?? 0,
    setBalance: (accountId, value) => {
      balances.set(accountId, value);
    },
  };
}

async function connect(harness: Harness, select = true): Promise<void> {
  await harness.connector.connect({
    serverUrl: 'http://actual.test:5006',
    secretKey: 'test-secret',
  });
  if (select) await harness.connector.selectBudget(BUDGET_ID);
}

function authority(
  overrides: Partial<BudgetAssignmentPrecondition> = {},
): BudgetAssignmentPrecondition {
  return {
    budgetId: BUDGET_ID,
    expectedAmount: INITIAL_ASSIGNMENT,
    currency: 'USD',
    assertExecutionCurrent: () => {},
    ...overrides,
  };
}

function setBudgetAmount(
  connector: ActualConnector,
  month: string,
  categoryId: string,
  amount: number,
  precondition: BudgetAssignmentPrecondition = authority(),
): Promise<BudgetAssignmentResult> {
  return (connector as unknown as BudgetAssignmentPort).setBudgetAmount(
    month,
    categoryId,
    amount,
    precondition,
  );
}

function createManualTransaction(
  connector: ActualConnector,
  input: ManualTransactionInput,
  precondition: ManualTransactionPrecondition,
): Promise<ManualTransactionResult> {
  return (connector as unknown as ManualTransactionPort).createManualTransaction(
    input,
    precondition,
  );
}

function createWalletAccount(
  connector: ActualConnector,
  input: WalletAccountInput,
  precondition: WalletAccountPrecondition,
): Promise<WalletAccountResult> {
  return (connector as unknown as WalletAccountPort).createWalletAccount(input, precondition);
}

function createLedgerTransfer(
  connector: ActualConnector,
  input: LedgerTransferInput,
  precondition: LedgerTransferPrecondition,
): Promise<LedgerTransferResult> {
  return (connector as unknown as LedgerTransferPort).createLedgerTransfer(input, precondition);
}

function transferPrecondition(
  overrides: Partial<LedgerTransferPrecondition> = {},
): LedgerTransferPrecondition {
  return {
    budgetId: BUDGET_ID,
    sourceBalance: 100_000,
    destinationBalance: 40_000,
    currency: 'USD',
    assertExecutionCurrent: () => {},
    ...overrides,
  };
}

const TRANSFER_AMOUNT = 2_500;
const TRANSFER_DATE = '2026-07-20';
const SOURCE_BALANCE = 100_000;
const DESTINATION_BALANCE = 40_000;

function walletAuthority(
  overrides: Partial<WalletAccountPrecondition> = {},
): WalletAccountPrecondition {
  return {
    budgetId: BUDGET_ID,
    assertExecutionCurrent: () => {},
    ...overrides,
  };
}

function walletPortInput(overrides: Partial<WalletAccountInput> = {}): WalletAccountInput {
  return {
    walletId: 'wallet-stable-001',
    accountName: 'Food wallet',
    currency: 'USD',
    ...overrides,
  };
}

function ledgerTransferInput(overrides: Partial<LedgerTransferInput> = {}): LedgerTransferInput {
  return {
    transferId: TRANSFER_ID,
    correlationId: TRANSFER_CORRELATION_ID,
    sourceAccountId: SOURCE_ACCOUNT_ID,
    destinationAccountId: DESTINATION_ACCOUNT_ID,
    amount: TRANSFER_AMOUNT,
    date: TRANSFER_DATE,
    ...overrides,
  };
}

function seedTransferSource(harness: Harness): void {
  harness.accounts.push(
    { id: SOURCE_ACCOUNT_ID, name: 'Checking', offbudget: false, closed: false },
    { id: DESTINATION_ACCOUNT_ID, name: 'Savings', offbudget: false, closed: false },
  );
  harness.payees.push(
    { id: SOURCE_TRANSFER_PAYEE_ID, name: 'Checking', transfer_acct: SOURCE_ACCOUNT_ID },
    { id: DESTINATION_TRANSFER_PAYEE_ID, name: 'Savings', transfer_acct: DESTINATION_ACCOUNT_ID },
  );
  harness.setBalance(SOURCE_ACCOUNT_ID, SOURCE_BALANCE);
  harness.setBalance(DESTINATION_ACCOUNT_ID, DESTINATION_BALANCE);
}

function appendTransferPair(
  harness: Harness,
  input: LedgerTransferInput,
  sourceId = 'actual-transfer-source-001',
  destinationId = 'actual-transfer-destination-001',
): void {
  harness.transactions.push(
    {
      id: sourceId,
      account: input.sourceAccountId,
      date: input.date,
      amount: -input.amount,
      payee: DESTINATION_TRANSFER_PAYEE_ID,
      notes: `balanceframe:transfer:${input.transferId}:${input.correlationId}`,
      transfer_id: destinationId,
      cleared: true,
    } as TransactionEntity,
    {
      id: destinationId,
      account: input.destinationAccountId,
      date: input.date,
      amount: input.amount,
      payee: SOURCE_TRANSFER_PAYEE_ID,
      notes: `balanceframe:transfer:${input.transferId}:${input.correlationId}`,
      transfer_id: sourceId,
      cleared: false,
    } as TransactionEntity,
  );
  harness.setBalance(input.sourceAccountId, SOURCE_BALANCE - input.amount);
  harness.setBalance(input.destinationAccountId, DESTINATION_BALANCE + input.amount);
}

describe('ActualConnector.createWalletAccount consequential effect', () => {
  it('creates an on-budget account without opening cash and returns only the generated, read-back ID', async () => {
    const harness = createHarness();
    await connect(harness);
    const assertExecutionCurrent = vi.fn(() => {
      harness.events.push('authorize');
    });

    const result = await createWalletAccount(
      harness.connector,
      walletPortInput(),
      walletAuthority({ assertExecutionCurrent }),
    );

    expect(result).toEqual({
      success: true,
      walletId: 'wallet-stable-001',
      accountId: 'actual-generated-account-id',
      verified: true,
    });
    expect(assertExecutionCurrent).toHaveBeenCalledTimes(1);
    expect(harness.events.indexOf('authorize')).toBe(harness.events.indexOf('createAccount') - 1);
    expect(harness.client.createAccount).toHaveBeenCalledTimes(1);
    const [actualAccount, initialBalance] = vi.mocked(harness.client.createAccount).mock.calls[0]!;
    expect(actualAccount).toEqual({ name: 'Food wallet', offbudget: false, closed: false });
    expect(initialBalance).toBeUndefined();
    expect(harness.client.getAccountBalance).toHaveBeenCalledWith('actual-generated-account-id');
    expect(harness.balance('actual-generated-account-id')).toBe(0);
    expect(harness.transactions).toHaveLength(0);
    expect(harness.client.addTransactions).not.toHaveBeenCalled();
  });

  it('rejects wrong selected budget or source currency before account creation', async () => {
    const harness = createHarness();
    await connect(harness);
    const wrongBudget = await createWalletAccount(
      harness.connector,
      walletPortInput(),
      walletAuthority({ budgetId: 'another-budget' }),
    );
    const wrongCurrency = await createWalletAccount(
      harness.connector,
      walletPortInput({ currency: 'EUR' }),
      walletAuthority(),
    );

    expect(wrongBudget).toMatchObject({ success: false });
    expect(wrongCurrency).toMatchObject({ success: false });
    expect(harness.client.createAccount).not.toHaveBeenCalled();
  });

  it('does not retry or claim verification when post-create synchronization is uncertain', async () => {
    const harness = createHarness();
    await connect(harness);
    vi.mocked(harness.client.sync)
      .mockImplementationOnce(async () => {
        harness.events.push('sync');
      })
      .mockImplementationOnce(async () => {
        harness.events.push('sync');
        throw new Error('sync unavailable');
      });

    const result = await createWalletAccount(
      harness.connector,
      walletPortInput(),
      walletAuthority(),
    );

    expect(result).toMatchObject({ success: false, code: 'WRITE_UNCERTAIN', reviewRequired: true });
    expect(harness.client.createAccount).toHaveBeenCalledTimes(1);
    expect(harness.accounts).toHaveLength(1);
  });

  it('does not substitute the SDK-returned ID for a different account in Actual readback', async () => {
    const harness = createHarness();
    await connect(harness);
    vi.mocked(harness.client.createAccount).mockImplementationOnce(async (input) => {
      harness.events.push('createAccount');
      harness.accounts.push({
        id: 'actual-readback-account-id',
        ...input,
        balance_current: null,
      });
      harness.setBalance('actual-readback-account-id', 0);
      return 'different-sdk-result-id';
    });

    const result = await createWalletAccount(
      harness.connector,
      walletPortInput(),
      walletAuthority(),
    );

    expect(result).toMatchObject({ success: false, code: 'WRITE_UNCERTAIN', reviewRequired: true });
    expect(harness.client.createAccount).toHaveBeenCalledTimes(1);
  });

  it('never recovers an unknown stable wallet mapping by matching an existing account name', async () => {
    const harness = createHarness();
    harness.accounts.push({
      id: 'actual-existing-same-name',
      name: 'Food wallet',
      offbudget: false,
      closed: false,
    });
    harness.setBalance('actual-existing-same-name', 0);
    await connect(harness);

    const result = await createWalletAccount(
      harness.connector,
      walletPortInput(),
      walletAuthority(),
    );

    expect(result).toMatchObject({ success: false });
    expect(harness.client.createAccount).not.toHaveBeenCalled();
  });

  it('honors the final wallet authorization fence without creating an account', async () => {
    const harness = createHarness();
    await connect(harness);

    await expect(
      createWalletAccount(
        harness.connector,
        walletPortInput(),
        walletAuthority({
          assertExecutionCurrent: () => {
            harness.events.push('authorize');
            throw new Error('write ownership lost');
          },
        }),
      ),
    ).rejects.toThrow('write ownership lost');

    expect(harness.events.at(-1)).toBe('authorize');
    expect(harness.client.createAccount).not.toHaveBeenCalled();
  });
});

describe('ActualConnector.createWalletAccount guards', () => {
  it('rejects Observe-mode wallet creation before any Actual account write', async () => {
    const harness = createHarness({ mode: 'observe' });
    await connect(harness);

    await expect(
      createWalletAccount(harness.connector, walletPortInput(), walletAuthority()),
    ).rejects.toThrow(/observe|not permitted/i);
    expect(harness.client.createAccount).not.toHaveBeenCalled();
  });

  it.each(['', ' '])('rejects an invalid stable wallet ID %j', async (walletId) => {
    const harness = createHarness();
    await connect(harness);

    const result = await createWalletAccount(
      harness.connector,
      walletPortInput({ walletId }),
      walletAuthority(),
    );

    expect(result).toMatchObject({ success: false });
    expect(harness.client.createAccount).not.toHaveBeenCalled();
  });
});

describe('ActualConnector.createLedgerTransfer consequential effect', () => {
  it('writes one exact Actual-linked transfer pair with a recovery marker and no settlement claim', async () => {
    const harness = createHarness();
    seedTransferSource(harness);
    await connect(harness);
    const assertExecutionCurrent = vi.fn(() => {
      harness.events.push('authorize');
    });
    vi.mocked(harness.client.addTransactions).mockImplementationOnce(
      async (accountId, rows, options) => {
        harness.events.push('addTransactions');
        expect(accountId).toBe(SOURCE_ACCOUNT_ID);
        expect(options).toEqual({ learnCategories: false, runTransfers: true });
        expect(rows).toEqual([
          expect.objectContaining({
            amount: -TRANSFER_AMOUNT,
            date: TRANSFER_DATE,
            notes: TRANSFER_MARKER,
            payee: DESTINATION_TRANSFER_PAYEE_ID,
            cleared: false,
          }),
        ]);
        appendTransferPair(harness, ledgerTransferInput());
        return 'ok';
      },
    );

    const result = await createLedgerTransfer(
      harness.connector,
      ledgerTransferInput(),
      transferPrecondition({ assertExecutionCurrent }),
    );

    expect(result).toEqual({
      success: true,
      transferId: TRANSFER_ID,
      sourceTransactionId: 'actual-transfer-source-001',
      destinationTransactionId: 'actual-transfer-destination-001',
      verified: true,
    });
    expect(assertExecutionCurrent).toHaveBeenCalledTimes(1);
    expect(harness.events.indexOf('authorize')).toBe(harness.events.indexOf('addTransactions') - 1);
    expect(harness.client.addTransactions).toHaveBeenCalledTimes(1);
    const pair = harness.transactions;
    expect(pair).toHaveLength(2);
    expect(pair[0]).toMatchObject({
      account: SOURCE_ACCOUNT_ID,
      amount: -TRANSFER_AMOUNT,
      payee: DESTINATION_TRANSFER_PAYEE_ID,
      notes: TRANSFER_MARKER,
      transfer_id: 'actual-transfer-destination-001',
    });
    expect(pair[1]).toMatchObject({
      account: DESTINATION_ACCOUNT_ID,
      amount: TRANSFER_AMOUNT,
      payee: SOURCE_TRANSFER_PAYEE_ID,
      notes: TRANSFER_MARKER,
      transfer_id: 'actual-transfer-source-001',
    });
    expect(result).not.toHaveProperty('settled');
  });

  it('rejects stale account balances, same-account transfers, and source-currency mismatch', async () => {
    const harness = createHarness();
    seedTransferSource(harness);
    await connect(harness);

    const staleBalance = await createLedgerTransfer(
      harness.connector,
      ledgerTransferInput(),
      transferPrecondition({ sourceBalance: SOURCE_BALANCE - 1 }),
    );
    const sameAccount = await createLedgerTransfer(
      harness.connector,
      ledgerTransferInput({ destinationAccountId: SOURCE_ACCOUNT_ID }),
      transferPrecondition(),
    );
    const wrongCurrency = await createLedgerTransfer(
      harness.connector,
      ledgerTransferInput(),
      transferPrecondition({ currency: 'EUR' }),
    );

    expect(staleBalance).toMatchObject({ success: false });
    expect(sameAccount).toMatchObject({ success: false });
    expect(wrongCurrency).toMatchObject({ success: false });
    expect(harness.client.addTransactions).not.toHaveBeenCalled();
  });

  it('does not dispatch if the final synchronous authorization fence fails', async () => {
    const harness = createHarness();
    seedTransferSource(harness);
    await connect(harness);

    await expect(
      createLedgerTransfer(
        harness.connector,
        ledgerTransferInput(),
        transferPrecondition({
          assertExecutionCurrent: () => {
            harness.events.push('authorize');
            throw new Error('approval expired');
          },
        }),
      ),
    ).rejects.toThrow('approval expired');

    expect(harness.client.addTransactions).not.toHaveBeenCalled();
    expect(harness.events).not.toContain('addTransactions');
  });

  it('marks a partial transfer write uncertain and does not retry the unmatched pair', async () => {
    const harness = createHarness();
    seedTransferSource(harness);
    await connect(harness);
    vi.mocked(harness.client.addTransactions).mockImplementationOnce(async (_accountId, rows) => {
      harness.events.push('addTransactions');
      const row = rows[0] as Record<string, unknown>;
      harness.transactions.push({
        id: 'actual-transfer-source-only',
        account: SOURCE_ACCOUNT_ID,
        amount: Number(row.amount),
        date: String(row.date),
        payee: DESTINATION_TRANSFER_PAYEE_ID,
        notes: String(row.notes),
      } as TransactionEntity);
      harness.setBalance(SOURCE_ACCOUNT_ID, SOURCE_BALANCE - TRANSFER_AMOUNT);
      return 'ok';
    });

    const result = await createLedgerTransfer(
      harness.connector,
      ledgerTransferInput(),
      transferPrecondition(),
    );

    expect(result).toMatchObject({ success: false, code: 'WRITE_UNCERTAIN', reviewRequired: true });
    expect(harness.client.addTransactions).toHaveBeenCalledTimes(1);
    expect(harness.transactions).toHaveLength(1);
  });

  it('does not treat unlinked same-date opposite entries as a verified transfer pair', async () => {
    const harness = createHarness();
    seedTransferSource(harness);
    harness.transactions.push(
      {
        id: 'unlinked-debit',
        account: SOURCE_ACCOUNT_ID,
        date: TRANSFER_DATE,
        amount: -TRANSFER_AMOUNT,
        notes: 'unrelated debit',
      } as TransactionEntity,
      {
        id: 'unlinked-credit',
        account: DESTINATION_ACCOUNT_ID,
        date: TRANSFER_DATE,
        amount: TRANSFER_AMOUNT,
        notes: 'unrelated credit',
      } as TransactionEntity,
    );
    await connect(harness);

    const result = await createLedgerTransfer(
      harness.connector,
      ledgerTransferInput(),
      transferPrecondition(),
    );

    expect(result).toMatchObject({ success: false, code: 'WRITE_UNCERTAIN', reviewRequired: true });
    expect(harness.client.addTransactions).toHaveBeenCalledTimes(1);
    expect(harness.transactions).toHaveLength(2);
  });

  it('keeps a complete pair uncertain if post-write synchronization fails, without retrying', async () => {
    const harness = createHarness();
    seedTransferSource(harness);
    await connect(harness);
    vi.mocked(harness.client.sync)
      .mockImplementationOnce(async () => {
        harness.events.push('sync');
      })
      .mockImplementationOnce(async () => {
        harness.events.push('sync');
        throw new Error('sync unavailable');
      });
    vi.mocked(harness.client.addTransactions).mockImplementationOnce(async () => {
      harness.events.push('addTransactions');
      appendTransferPair(harness, ledgerTransferInput());
      return 'ok';
    });

    const result = await createLedgerTransfer(
      harness.connector,
      ledgerTransferInput(),
      transferPrecondition(),
    );

    expect(result).toMatchObject({ success: false, code: 'WRITE_UNCERTAIN', reviewRequired: true });
    expect(harness.client.addTransactions).toHaveBeenCalledTimes(1);
    expect(harness.transactions).toHaveLength(2);
  });
});

describe('ActualConnector.createLedgerTransfer guards', () => {
  it('rejects Observe-mode ledger transfer before Actual transaction writes', async () => {
    const harness = createHarness({ mode: 'observe' });
    seedTransferSource(harness);
    await connect(harness);

    await expect(
      createLedgerTransfer(harness.connector, ledgerTransferInput(), transferPrecondition()),
    ).rejects.toThrow(/observe|not permitted/i);
    expect(harness.client.addTransactions).not.toHaveBeenCalled();
  });

  it.each([
    { transferId: '' },
    { correlationId: ' ' },
    { sourceAccountId: '' },
    { destinationAccountId: 'missing-account' },
    { amount: 0 },
    { amount: -1 },
    { amount: 1.5 },
    { amount: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    'rejects invalid transfer identity, target, or amount: $transferId $amount',
    async (overrides) => {
      const harness = createHarness();
      seedTransferSource(harness);
      await connect(harness);

      const result = await createLedgerTransfer(
        harness.connector,
        ledgerTransferInput(overrides),
        transferPrecondition(),
      );

      expect(result).toMatchObject({ success: false });
      expect(harness.client.addTransactions).not.toHaveBeenCalled();
    },
  );
});
function expectFailure(result: BudgetAssignmentResult): void {
  expect(result.success).toBe(false);
}

describe('ActualConnector.setBudgetAmount consequential assignment', () => {
  it('compares the selected source assignment, fences authorization, writes once, and verifies the readback', async () => {
    const harness = createHarness();
    await connect(harness);
    const assertExecutionCurrent = vi.fn(() => {
      harness.events.push('authorize');
    });

    const result = await setBudgetAmount(
      harness.connector,
      '2026-07',
      CATEGORY_ID,
      18_000,
      authority({ assertExecutionCurrent }),
    );

    expect(result).toMatchObject({ success: true, id: CATEGORY_ID });
    expect(assertExecutionCurrent).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual(['sync', 'read', 'authorize', 'write', 'sync', 'read']);
    expect(harness.client.setBudgetAmount).toHaveBeenCalledTimes(1);
    expect(harness.client.setBudgetAmount).toHaveBeenCalledWith('2026-07', CATEGORY_ID, 18_000);
    expect(harness.assignment()).toBe(18_000);
  });

  it('requires a selected budget and binds authority to that exact budget', async () => {
    const unselected = createHarness();
    await connect(unselected, false);
    const result = await setBudgetAmount(unselected.connector, '2026-07', CATEGORY_ID, 18_000);
    expect(result).toMatchObject({ success: false, code: 'BUDGET_NOT_SELECTED' });
    expect(unselected.client.setBudgetAmount).not.toHaveBeenCalled();

    const wrongBudget = createHarness();
    await connect(wrongBudget);
    const mismatch = await setBudgetAmount(
      wrongBudget.connector,
      '2026-07',
      CATEGORY_ID,
      18_000,
      authority({ budgetId: 'another-budget' }),
    );
    expectFailure(mismatch);
    expect(wrongBudget.client.setBudgetAmount).not.toHaveBeenCalled();
  });

  it('rejects an externally changed source assignment without overwriting it', async () => {
    const harness = createHarness();
    await connect(harness);
    harness.setAssignment(INITIAL_ASSIGNMENT + 1);

    const result = await setBudgetAmount(harness.connector, '2026-07', CATEGORY_ID, 18_000);

    expectFailure(result);
    expect(harness.client.setBudgetAmount).not.toHaveBeenCalled();
    expect(harness.assignment()).toBe(INITIAL_ASSIGNMENT + 1);
  });

  it('serializes concurrent local assignments and admits only one matching source version', async () => {
    const harness = createHarness();
    await connect(harness);

    const [first, second] = await Promise.all([
      setBudgetAmount(harness.connector, '2026-07', CATEGORY_ID, 18_000),
      setBudgetAmount(harness.connector, '2026-07', CATEGORY_ID, 19_000),
    ]);

    expect(first).toMatchObject({ success: true, id: CATEGORY_ID });
    expectFailure(second);
    expect(harness.client.setBudgetAmount).toHaveBeenCalledTimes(1);
    expect(harness.assignment()).toBe(18_000);
  });

  it.each(['2026-00', '2026-13', '2026-7', 'not-a-month'])(
    'rejects invalid month %s before dispatch',
    async (month) => {
      const harness = createHarness();
      await connect(harness);

      const result = await setBudgetAmount(harness.connector, month, CATEGORY_ID, 18_000);

      expectFailure(result);
      expect(harness.client.setBudgetAmount).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'missing-category'])(
    'rejects invalid or missing category ID %j',
    async (categoryId) => {
      const harness = createHarness();
      await connect(harness);

      const result = await setBudgetAmount(harness.connector, '2026-07', categoryId, 18_000);

      expectFailure(result);
      expect(harness.client.setBudgetAmount).not.toHaveBeenCalled();
    },
  );

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe target assignment %s',
    async (amount) => {
      const harness = createHarness();
      await connect(harness);

      const result = await setBudgetAmount(harness.connector, '2026-07', CATEGORY_ID, amount);

      expectFailure(result);
      expect(harness.client.setBudgetAmount).not.toHaveBeenCalled();
    },
  );

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe expected source assignment %s',
    async (expectedAmount) => {
      const harness = createHarness();
      await connect(harness);

      const result = await setBudgetAmount(
        harness.connector,
        '2026-07',
        CATEGORY_ID,
        18_000,
        authority({ expectedAmount }),
      );

      expectFailure(result);
      expect(harness.client.setBudgetAmount).not.toHaveBeenCalled();
    },
  );

  it('rejects a currency different from the selected Actual source currency', async () => {
    const harness = createHarness({ currency: 'USD' });
    await connect(harness);

    const result = await setBudgetAmount(
      harness.connector,
      '2026-07',
      CATEGORY_ID,
      18_000,
      authority({ currency: 'EUR' }),
    );

    expectFailure(result);
    expect(harness.client.setBudgetAmount).not.toHaveBeenCalled();
  });

  it('does not dispatch when the final synchronous authorization fence fails', async () => {
    const harness = createHarness();
    await connect(harness);

    await expect(
      setBudgetAmount(
        harness.connector,
        '2026-07',
        CATEGORY_ID,
        18_000,
        authority({
          assertExecutionCurrent: () => {
            harness.events.push('authorize');
            throw new Error('approval expired');
          },
        }),
      ),
    ).rejects.toThrow('approval expired');

    expect(harness.events).toEqual(['sync', 'read', 'authorize']);
    expect(harness.client.setBudgetAmount).not.toHaveBeenCalled();
  });

  it('marks a possibly applied write uncertain and never retries it', async () => {
    const harness = createHarness();
    await connect(harness);
    vi.mocked(harness.client.setBudgetAmount).mockImplementationOnce(
      async (_month, _categoryId, amount) => {
        harness.events.push('write');
        harness.setAssignment(amount);
        throw new Error('connection lost after dispatch');
      },
    );

    const result = await setBudgetAmount(harness.connector, '2026-07', CATEGORY_ID, 18_000);

    expect(result).toMatchObject({ success: false, code: 'WRITE_UNCERTAIN', reviewRequired: true });
    expect(harness.client.setBudgetAmount).toHaveBeenCalledTimes(1);
    expect(harness.assignment()).toBe(18_000);
  });

  it('does not report success or retry when post-write sync fails', async () => {
    const harness = createHarness();
    await connect(harness);
    vi.mocked(harness.client.sync)
      .mockImplementationOnce(async () => {
        harness.events.push('sync');
      })
      .mockImplementationOnce(async () => {
        harness.events.push('sync');
        throw new Error('sync unavailable');
      });

    const result = await setBudgetAmount(harness.connector, '2026-07', CATEGORY_ID, 18_000);

    expect(result).toMatchObject({ success: false, code: 'WRITE_UNCERTAIN', reviewRequired: true });
    expect(harness.client.setBudgetAmount).toHaveBeenCalledTimes(1);
    expect(harness.assignment()).toBe(18_000);
  });

  it('does not report success when Actual readback differs from the requested assignment', async () => {
    const harness = createHarness();
    await connect(harness);
    vi.mocked(harness.client.setBudgetAmount).mockImplementationOnce(async () => {
      harness.events.push('write');
    });

    const result = await setBudgetAmount(harness.connector, '2026-07', CATEGORY_ID, 18_000);

    expect(result).toMatchObject({ success: false, code: 'WRITE_UNCERTAIN', reviewRequired: true });
    expect(harness.client.setBudgetAmount).toHaveBeenCalledTimes(1);
    expect(harness.assignment()).toBe(INITIAL_ASSIGNMENT);
  });
});

describe('ActualConnector.createManualTransaction shared action fence', () => {
  it('reuses the existing manual write port and rejects authority revoked after its awaited source reads', async () => {
    const harness = createHarness();
    harness.accounts.push({
      id: SOURCE_ACCOUNT_ID,
      name: 'Checking',
      offbudget: false,
      closed: false,
    });
    await connect(harness);
    const input: ManualTransactionInput = {
      parentId: 'manual-parent-phase9',
      correlationId: 'manual-correlation-phase9',
      accountId: SOURCE_ACCOUNT_ID,
      amount: -TRANSFER_AMOUNT,
      date: TRANSFER_DATE,
      categoryId: CATEGORY_ID,
    };
    const assertExecutionCurrent = vi.fn(() => {
      harness.events.push('authorize');
      throw new Error('approval expired during Actual reads');
    });

    await expect(
      createManualTransaction(harness.connector, input, {
        budgetId: BUDGET_ID,
        assertExecutionCurrent,
      }),
    ).rejects.toThrow('approval expired during Actual reads');

    expect(assertExecutionCurrent).toHaveBeenCalledTimes(1);
    expect(harness.events.indexOf('authorize')).toBe(
      harness.events.indexOf(`transactions:${SOURCE_ACCOUNT_ID}`) + 1,
    );
    expect(harness.client.addTransactions).not.toHaveBeenCalled();
  });
});
