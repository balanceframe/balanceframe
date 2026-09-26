/**
 * Red tests for the bounded Actual manual-transaction write port.
 *
 * These tests deliberately exercise the write-enabled adapter directly. The
 * application owns authorization/approval; the adapter owns current Actual
 * preconditions, the write, synchronization, and postcondition verification.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActualConnector } from '../src/connector';
import { NullCredentialStore } from '../src/credentials';
import type { ActualClient } from '../src/connector';
import type {
  APIAccountEntity,
  APICategoryEntity,
  APICategoryGroupEntity,
  APIFileEntity,
  APIPayeeEntity,
} from '@actual-app/api';
import type { RuleEntity, TransactionEntity } from '@actual-app/core/types/models';

// ---------------------------------------------------------------------------
// Typed manual-write request used by the adapter contract
// ---------------------------------------------------------------------------

type ManualTransactionSplit = {
  amount: number;
  accountId: string;
  date: string;
  categoryId: string;
};

type ManualTransactionInput = {
  parentId: string;
  correlationId: string;
  accountId: string;
  amount: number;
  date: string;
  categoryId?: string | null;
  payeeName?: string;
  notes?: string;
  splits?: ManualTransactionSplit[];
};

// ---------------------------------------------------------------------------
// Deterministic ActualClient stub
// ---------------------------------------------------------------------------

const BUDGET_ID = 'budget_manual_test';
const ACCOUNT_ID = 'account_checking';
const GROCERIES_ID = 'category_groceries';
const DINING_ID = 'category_dining';
const GROUP_ID = 'group_expenses';

const mockBudget: APIFileEntity = {
  id: BUDGET_ID,
  groupId: 'group_manual_test',
  name: 'Manual transaction test budget',
  cloudFileId: 'cloud_manual_test',
  encrypted: false,
  state: 'remote',
};

const mockAccount: APIAccountEntity = {
  id: ACCOUNT_ID,
  name: 'Checking',
  offbudget: false,
  closed: false,
  balance_current: 100000,
};

const mockCategories: APICategoryEntity[] = [
  { id: GROCERIES_ID, name: 'Groceries', group_id: GROUP_ID, is_income: false, hidden: false },
  { id: DINING_ID, name: 'Dining', group_id: GROUP_ID, is_income: false, hidden: false },
];

const mockCategoryGroups: APICategoryGroupEntity[] = [
  { id: GROUP_ID, name: 'Expenses', is_income: false, hidden: false },
];

const mockPayees: APIPayeeEntity[] = [
  { id: 'payee_existing', name: 'Existing Merchant', transfer_acct: undefined },
];

const mockRules: RuleEntity[] = [];

function cloneTransaction(transaction: TransactionEntity): TransactionEntity {
  return {
    ...transaction,
    ...(transaction.subtransactions
      ? { subtransactions: transaction.subtransactions.map((child) => ({ ...child })) }
      : {}),
  };
}

function appendAddedRows(
  transactions: TransactionEntity[],
  accountId: string,
  rows: unknown[],
  payees: APIPayeeEntity[],
): void {
  for (const rawRow of rows) {
    const row = rawRow as Record<string, unknown>;
    const parentId =
      typeof row.id === 'string' ? row.id : `actual-generated-parent-${transactions.length + 1}`;
    const rawChildren = Array.isArray(row.subtransactions) ? row.subtransactions : [];
    const children = rawChildren.map((rawChild, index) => {
      const child = rawChild as Record<string, unknown>;
      return {
        id: typeof child.id === 'string' ? child.id : `${parentId}-child-${index + 1}`,
        account: typeof child.account === 'string' ? child.account : accountId,
        date: String(child.date),
        amount: Number(child.amount),
        ...(typeof child.category === 'string' ? { category: child.category } : {}),
        parent_id: parentId,
        is_child: true,
        is_parent: false,
        error: null,
      } as TransactionEntity;
    });

    let resolvedPayeeId = typeof row.payee === 'string' ? row.payee : undefined;
    const rawPayeeName = typeof row.payee_name === 'string' ? row.payee_name.trim() : '';
    if (rawPayeeName.length > 0) {
      let payee = payees.find(
        (candidate) => candidate.name.trim().toLowerCase() === rawPayeeName.toLowerCase(),
      );
      if (!payee) {
        payee = {
          id: `payee-manual-${payees.length + 1}`,
          name: rawPayeeName,
          transfer_acct: undefined,
        };
        payees.push(payee);
      }
      resolvedPayeeId = payee.id;
    }

    transactions.push({
      id: parentId,
      account: accountId,
      date: String(row.date),
      amount: Number(row.amount),
      ...(typeof row.category === 'string' ? { category: row.category } : {}),
      ...(typeof row.notes === 'string' ? { notes: row.notes } : {}),
      ...(resolvedPayeeId ? { payee: resolvedPayeeId } : {}),
      ...(row.is_parent === true ? { is_parent: true } : {}),
      ...(children.length > 0 ? { subtransactions: children } : {}),
      error: null,
    } as TransactionEntity);
  }
}

function createMockClient(overrides: Partial<ActualClient> = {}): ActualClient {
  return {
    init: vi.fn().mockResolvedValue({
      send: vi.fn(),
      getDataDir: vi.fn(),
      sendMessage: vi.fn(),
      amountToInteger: vi.fn(),
      integerToAmount: vi.fn(),
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getBudgets: vi.fn().mockResolvedValue([mockBudget]),
    downloadBudget: vi.fn().mockResolvedValue(undefined),
    loadBudget: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue(undefined),
    getServerVersion: vi.fn().mockResolvedValue({ version: '26.7.0' }),
    getAccounts: vi.fn().mockResolvedValue([mockAccount]),
    getAccountBalance: vi.fn().mockResolvedValue(mockAccount.balance_current),
    getTransactions: vi.fn().mockResolvedValue([]),
    getPayees: vi.fn().mockResolvedValue(mockPayees),
    getCategories: vi.fn().mockResolvedValue(mockCategories),
    getCategoryGroups: vi.fn().mockResolvedValue(mockCategoryGroups),
    getBudgetMonths: vi.fn().mockResolvedValue([]),
    getBudgetMonth: vi.fn().mockResolvedValue({ month: '2026-09', categoryGroups: [] }),
    getRules: vi.fn().mockResolvedValue(mockRules),
    getSchedules: vi.fn().mockResolvedValue([]),
    getTags: vi.fn().mockResolvedValue([]),
    runBankSync: vi.fn().mockResolvedValue(undefined),
    // Actual 26.7's addTransactions resolves "ok"; it is not a dedupe or ID API.
    addTransactions: vi.fn().mockResolvedValue('ok' as const),
    createAccount: vi.fn().mockResolvedValue('new-account-id'),
    updateTransaction: vi.fn().mockResolvedValue(undefined),
    createRule: vi.fn().mockResolvedValue({ id: 'new-rule-id' }),
    updateRule: vi.fn().mockResolvedValue(undefined),
    deleteRule: vi.fn().mockResolvedValue(true),
    setBudgetAmount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

interface Harness {
  connector: ActualConnector;
  client: ActualClient;
  transactions: TransactionEntity[];
}

const liveConnectors: ActualConnector[] = [];

afterEach(async () => {
  for (const connector of liveConnectors.splice(0)) {
    await connector.disconnect();
  }
});

function createHarness(
  options: {
    mode?: 'observe' | 'reviewAndApply' | 'managedAutomation' | 'disposableSandbox';
    accounts?: APIAccountEntity[];
    categories?: APICategoryEntity[];
    transactions?: TransactionEntity[];
    sync?: ActualClient['sync'];
  } = {},
): Harness {
  const transactions = (options.transactions ?? []).map(cloneTransaction);
  const accounts = options.accounts ?? [mockAccount];
  const categories = options.categories ?? mockCategories;
  const payees = mockPayees.map((payee) => ({ ...payee }));

  const defaultAddTransactions = vi.fn(
    async (accountId: string, rows: unknown[]): Promise<'ok'> => {
      appendAddedRows(transactions, accountId, rows, payees);
      return 'ok';
    },
  );

  const client = createMockClient({
    getAccounts: vi.fn().mockImplementation(async () => accounts),
    getCategories: vi.fn().mockImplementation(async () => categories),
    getPayees: vi.fn().mockImplementation(async () => payees.map((payee) => ({ ...payee }))),
    getTransactions: vi
      .fn()
      .mockImplementation(async (accountId: string, start: string, end: string) =>
        transactions
          .filter(
            (transaction) =>
              transaction.account === accountId &&
              transaction.date >= start &&
              transaction.date <= end,
          )
          .map(cloneTransaction),
      ),
    addTransactions: defaultAddTransactions,
    sync: options.sync ?? vi.fn().mockResolvedValue(undefined),
  });

  const connector = new ActualConnector({
    client,
    credentialStore: new NullCredentialStore(),
    mode: options.mode ?? 'reviewAndApply',
    cacheDir: '/tmp/bf-manual-transaction-test',
  });
  liveConnectors.push(connector);
  return { connector, client, transactions };
}

async function selectTestBudget(harness: Harness): Promise<void> {
  await harness.connector.connect({
    serverUrl: 'http://actual.test:5006',
    secretKey: 'test-secret',
  });
  await harness.connector.selectBudget(BUDGET_ID);
}

function singleInput(overrides: Partial<ManualTransactionInput> = {}): ManualTransactionInput {
  return {
    parentId: 'manual-parent-001',
    correlationId: 'manual-correlation-001',
    accountId: ACCOUNT_ID,
    amount: -12500,
    date: '2026-09-25',
    categoryId: GROCERIES_ID,
    ...overrides,
  };
}

function expectVerified(result: unknown, input: ManualTransactionInput): void {
  expect(result).toMatchObject({
    success: true,
    parentId: input.parentId,
    transactionId: input.parentId,
    correlationId: input.correlationId,
    verified: true,
  });
}

function expectFailure(result: unknown, code: RegExp, reviewRequired?: boolean): void {
  expect(result).toMatchObject({ success: false });
  const failure = result as { code?: unknown; reviewRequired?: unknown };
  expect(String(failure.code)).toMatch(code);
  if (reviewRequired !== undefined) {
    expect(failure.reviewRequired).toBe(reviewRequired);
  }
}

function importedTransaction(
  id: string,
  importedId: string,
  overrides: Partial<TransactionEntity> = {},
): TransactionEntity {
  return {
    id,
    account: ACCOUNT_ID,
    date: '2026-09-25',
    amount: -12500,
    category: GROCERIES_ID,
    imported_id: importedId,
    ...overrides,
  } as TransactionEntity;
}

// ---------------------------------------------------------------------------
// Write-enabled manual transaction behavior
// ---------------------------------------------------------------------------

describe('ActualConnector.createManualTransaction', () => {
  it('writes a single manual transaction with the stable parent ID and verifies exact fields', async () => {
    const harness = createHarness();
    await selectTestBudget(harness);

    const input = singleInput();
    const result = await harness.connector.createManualTransaction(input);

    expectVerified(result, input);

    const addTransactions = vi.mocked(harness.client.addTransactions);
    expect(addTransactions).toHaveBeenCalledTimes(1);
    const [accountId, rows] = addTransactions.mock.calls[0]!;
    expect(accountId).toBe(ACCOUNT_ID);
    expect(rows).toHaveLength(1);

    const submittedParent = rows[0] as Record<string, unknown>;
    expect(submittedParent).toMatchObject({
      id: input.parentId,
      amount: input.amount,
      date: input.date,
      category: input.categoryId,
    });
    expect(submittedParent).not.toHaveProperty('imported_id');
    expect(submittedParent).not.toHaveProperty('subtransactions');

    const reread = await harness.client.getTransactions(ACCOUNT_ID, '1970-01-01', '2099-12-31');
    expect(reread).toHaveLength(1);
    expect(reread[0]).toMatchObject({
      id: input.parentId,
      account: input.accountId,
      amount: input.amount,
      date: input.date,
      category: input.categoryId,
    });
    expect(reread[0]?.error ?? null).toBeNull();
  });

  it('writes a split with exact parent/child fields, conserved negative amounts, and no split error after re-read', async () => {
    const harness = createHarness();
    await selectTestBudget(harness);

    const input: ManualTransactionInput = {
      parentId: 'manual-split-parent-001',
      correlationId: 'manual-split-correlation-001',
      accountId: ACCOUNT_ID,
      amount: -12500,
      date: '2026-09-25',
      splits: [
        {
          amount: -7500,
          accountId: ACCOUNT_ID,
          date: '2026-09-25',
          categoryId: GROCERIES_ID,
        },
        {
          amount: -5000,
          accountId: ACCOUNT_ID,
          date: '2026-09-25',
          categoryId: DINING_ID,
        },
      ],
    };

    const result = await harness.connector.createManualTransaction(input);
    expectVerified(result, input);

    const addTransactions = vi.mocked(harness.client.addTransactions);
    expect(addTransactions).toHaveBeenCalledTimes(1);
    const [accountId, rows] = addTransactions.mock.calls[0]!;
    expect(accountId).toBe(ACCOUNT_ID);
    const submittedParent = rows[0] as Record<string, unknown>;
    expect(submittedParent).toMatchObject({
      id: input.parentId,
      amount: input.amount,
      date: input.date,
      is_parent: true,
    });
    expect(submittedParent).not.toHaveProperty('imported_id');

    const submittedChildren = submittedParent.subtransactions as Array<Record<string, unknown>>;
    expect(submittedChildren).toHaveLength(2);
    expect(submittedChildren[0]).toMatchObject({
      amount: -7500,
      account: ACCOUNT_ID,
      date: '2026-09-25',
      category: GROCERIES_ID,
      parent_id: input.parentId,
      is_child: true,
      is_parent: false,
    });
    expect(submittedChildren[1]).toMatchObject({
      amount: -5000,
      account: ACCOUNT_ID,
      date: '2026-09-25',
      category: DINING_ID,
      parent_id: input.parentId,
      is_child: true,
      is_parent: false,
    });
    for (const child of submittedChildren) {
      expect(child).not.toHaveProperty('imported_id');
    }
    expect(submittedChildren.reduce((sum, child) => sum + Number(child.amount), 0)).toBe(
      input.amount,
    );

    const reread = await harness.client.getTransactions(ACCOUNT_ID, '1970-01-01', '2099-12-31');
    const rereadParent = reread.find((transaction) => transaction.id === input.parentId);
    expect(rereadParent).toMatchObject({
      id: input.parentId,
      account: input.accountId,
      amount: input.amount,
      date: input.date,
      is_parent: true,
    });
    const rereadChildren = (rereadParent?.subtransactions ?? []) as TransactionEntity[];
    expect(rereadChildren).toHaveLength(2);
    expect(rereadChildren).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amount: -7500,
          account: ACCOUNT_ID,
          date: '2026-09-25',
          category: GROCERIES_ID,
          parent_id: input.parentId,
          is_child: true,
          is_parent: false,
        }),
        expect.objectContaining({
          amount: -5000,
          account: ACCOUNT_ID,
          date: '2026-09-25',
          category: DINING_ID,
          parent_id: input.parentId,
          is_child: true,
          is_parent: false,
        }),
      ]),
    );
    expect(rereadChildren.reduce((sum, child) => sum + child.amount, 0)).toBe(input.amount);
    expect(rereadParent?.error ?? null).toBeNull();
  });

  it('rejects a split whose child amounts do not conserve the parent before writing', async () => {
    const harness = createHarness();
    await selectTestBudget(harness);

    const input: ManualTransactionInput = {
      parentId: 'manual-invalid-split-001',
      correlationId: 'manual-invalid-split-correlation-001',
      accountId: ACCOUNT_ID,
      amount: -10000,
      date: '2026-09-25',
      splits: [
        {
          amount: -6000,
          accountId: ACCOUNT_ID,
          date: '2026-09-25',
          categoryId: GROCERIES_ID,
        },
        {
          amount: -3000,
          accountId: ACCOUNT_ID,
          date: '2026-09-25',
          categoryId: DINING_ID,
        },
      ],
    };

    const result = await harness.connector.createManualTransaction(input);
    expectFailure(result, /SPLIT|CONSERVATION|AMOUNT/i);
    expect(vi.mocked(harness.client.addTransactions)).not.toHaveBeenCalled();
  });

  it('rejects Observe mode without calling the Actual write method', async () => {
    const harness = createHarness({ mode: 'observe' });
    await selectTestBudget(harness);

    await expect(harness.connector.createManualTransaction(singleInput())).rejects.toThrow(
      /observe|not permitted/i,
    );
    expect(vi.mocked(harness.client.addTransactions)).not.toHaveBeenCalled();
  });

  it('requires a selected budget before checking or writing any transaction', async () => {
    const harness = createHarness();
    await harness.connector.connect({
      serverUrl: 'http://actual.test:5006',
      secretKey: 'test-secret',
    });

    const result = await harness.connector.createManualTransaction(singleInput());
    expectFailure(result, /BUDGET_NOT_SELECTED/i);
    expect(vi.mocked(harness.client.addTransactions)).not.toHaveBeenCalled();
  });

  it('requires a fresh open account precondition and does not write a missing account', async () => {
    const harness = createHarness({ accounts: [] });
    await selectTestBudget(harness);

    const result = await harness.connector.createManualTransaction(singleInput());
    expectFailure(result, /ACCOUNT|PRECONDITION/i);
    expect(vi.mocked(harness.client.addTransactions)).not.toHaveBeenCalled();
  });

  it('requires a fresh live category precondition and does not write a missing category', async () => {
    const harness = createHarness({ categories: [] });
    await selectTestBudget(harness);

    const result = await harness.connector.createManualTransaction(singleInput());
    expectFailure(result, /CATEGORY|PRECONDITION/i);
    expect(vi.mocked(harness.client.addTransactions)).not.toHaveBeenCalled();
  });

  it('does not write when a pre-existing unique imported transaction is the candidate', async () => {
    const harness = createHarness({
      transactions: [importedTransaction('imported-existing-001', 'bank-import-001')],
    });
    await selectTestBudget(harness);

    const result = await harness.connector.createManualTransaction(singleInput());
    expectFailure(result, /DUPLICATE|IMPORT|REVIEW/i, true);
    expect(vi.mocked(harness.client.addTransactions)).not.toHaveBeenCalled();

    const reread = await harness.client.getTransactions(ACCOUNT_ID, '1970-01-01', '2099-12-31');
    expect(reread).toHaveLength(1);
    expect(reread[0]?.imported_id).toBe('bank-import-001');
  });

  it('does not write when matching imported candidates are ambiguous', async () => {
    const harness = createHarness({
      transactions: [
        importedTransaction('imported-candidate-a', 'bank-import-a'),
        importedTransaction('imported-candidate-b', 'bank-import-b'),
      ],
    });
    await selectTestBudget(harness);

    const result = await harness.connector.createManualTransaction(singleInput());
    expectFailure(result, /AMBIGUOUS|REVIEW/i, true);
    expect(vi.mocked(harness.client.addTransactions)).not.toHaveBeenCalled();
  });

  it('does not treat the same amount as transaction identity without an imported match', async () => {
    const harness = createHarness({
      transactions: [
        {
          id: 'ordinary-existing-001',
          account: ACCOUNT_ID,
          date: '2026-09-25',
          amount: -12500,
          category: DINING_ID,
          imported_id: null,
          payee: 'payee_existing',
        } as TransactionEntity,
      ],
    });
    await selectTestBudget(harness);

    const input = singleInput({ payeeName: 'New Merchant' });
    const result = await harness.connector.createManualTransaction(input);
    expectVerified(result, input);
    expect(vi.mocked(harness.client.addTransactions)).toHaveBeenCalledTimes(1);

    const reread = await harness.client.getTransactions(ACCOUNT_ID, '1970-01-01', '2099-12-31');
    expect(reread).toHaveLength(2);
    expect(reread.some((transaction) => transaction.id === input.parentId)).toBe(true);
  });

  it('synchronizes remote imports before deciding whether a manual debit is safe to create', async () => {
    const harness = createHarness();
    const importFromRemote = vi.fn(async () => {
      harness.transactions.push(importedTransaction('remote-import-001', 'bank-reference-001'));
    });
    harness.client.sync = importFromRemote;
    await selectTestBudget(harness);

    const result = await harness.connector.createManualTransaction(singleInput());

    expectFailure(result, /IMPORT|REVIEW/i, true);
    expect(importFromRemote).toHaveBeenCalled();
    expect(vi.mocked(harness.client.addTransactions)).not.toHaveBeenCalled();
  });

  it('includes the requested future date in preflight and post-write verification', async () => {
    const harness = createHarness();
    await selectTestBudget(harness);
    const input = singleInput({ date: '2100-01-01', parentId: 'manual-future-001' });

    const result = await harness.connector.createManualTransaction(input);

    expectVerified(result, input);
    expect(vi.mocked(harness.client.addTransactions)).toHaveBeenCalledTimes(1);
  });

  it('reports write_uncertain after a failed sync without retrying or claiming verified success', async () => {
    const sync = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('Actual sync unavailable'));
    const harness = createHarness({ sync });
    await selectTestBudget(harness);

    const input = singleInput({
      parentId: 'manual-uncertain-001',
      correlationId: 'manual-uncertain-correlation-001',
    });
    const result = await harness.connector.createManualTransaction(input);

    expectFailure(result, /^WRITE_UNCERTAIN$/i, true);
    expect(result).toMatchObject({
      parentId: input.parentId,
      correlationId: input.correlationId,
    });
    expect(vi.mocked(harness.client.addTransactions)).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(harness.transactions.some((transaction) => transaction.id === input.parentId)).toBe(
      true,
    );
  });

  it('does not report split success when re-read contains only a parent or a split error', async () => {
    const harness = createHarness();
    const addTransactions = vi.fn(async (accountId: string, rows: unknown[]): Promise<'ok'> => {
      const row = rows[0] as Record<string, unknown>;
      harness.transactions.push({
        id: String(row.id),
        account: accountId,
        date: String(row.date),
        amount: Number(row.amount),
        is_parent: true,
        subtransactions: [],
        error: { type: 'SplitTransactionError', version: 1, difference: -500 },
      } as TransactionEntity);
      return 'ok';
    });
    harness.client.addTransactions = addTransactions;
    await selectTestBudget(harness);

    const input: ManualTransactionInput = {
      parentId: 'manual-parent-only-001',
      correlationId: 'manual-parent-only-correlation-001',
      accountId: ACCOUNT_ID,
      amount: -12500,
      date: '2026-09-25',
      splits: [
        {
          amount: -7500,
          accountId: ACCOUNT_ID,
          date: '2026-09-25',
          categoryId: GROCERIES_ID,
        },
        {
          amount: -5000,
          accountId: ACCOUNT_ID,
          date: '2026-09-25',
          categoryId: DINING_ID,
        },
      ],
    };

    const result = await harness.connector.createManualTransaction(input);
    expectFailure(result, /VERIFICATION|SPLIT/i);
    expect(result).not.toMatchObject({ success: true, verified: true });
    expect(addTransactions).toHaveBeenCalledTimes(1);
  });
  it('does not report success when Actual re-read changes requested notes', async () => {
    const harness = createHarness();
    const addTransactions = vi.fn(async (accountId: string, rows: unknown[]): Promise<'ok'> => {
      const row = rows[0] as Record<string, unknown>;
      harness.transactions.push({
        id: String(row.id),
        account: accountId,
        date: String(row.date),
        amount: Number(row.amount),
        ...(typeof row.category === 'string' ? { category: row.category } : {}),
        notes: 'persisted-different-note',
        error: null,
      } as TransactionEntity);
      return 'ok';
    });
    harness.client.addTransactions = addTransactions;
    await selectTestBudget(harness);

    const input = singleInput({ notes: 'requested-note' });
    const result = await harness.connector.createManualTransaction(input);

    expectFailure(result, /VERIFICATION/i, true);
    expect(result).not.toMatchObject({ success: true, verified: true });
    expect(addTransactions).toHaveBeenCalledTimes(1);
  });

  it('does not report success when Actual re-read resolves the payee to a different name', async () => {
    const harness = createHarness();
    const addTransactions = vi.fn(async (accountId: string, rows: unknown[]): Promise<'ok'> => {
      const row = rows[0] as Record<string, unknown>;
      harness.transactions.push({
        id: String(row.id),
        account: accountId,
        date: String(row.date),
        amount: Number(row.amount),
        ...(typeof row.category === 'string' ? { category: row.category } : {}),
        payee: 'payee_existing',
        error: null,
      } as TransactionEntity);
      return 'ok';
    });
    harness.client.addTransactions = addTransactions;
    await selectTestBudget(harness);

    const input = singleInput({ payeeName: 'Requested Merchant' });
    const result = await harness.connector.createManualTransaction(input);

    expectFailure(result, /VERIFICATION/i, true);
    expect(result).not.toMatchObject({ success: true, verified: true });
    expect(addTransactions).toHaveBeenCalledTimes(1);
    expect(vi.mocked(harness.client.getPayees)).toHaveBeenCalledTimes(2);
  });
});
