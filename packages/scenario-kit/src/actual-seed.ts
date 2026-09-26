import * as actualApiModule from '@actual-app/api';
import type { ProtocolSnapshot, Transaction } from '@balanceframe/protocol-generated';
import { canonicalProtocolSnapshotSchema } from '@balanceframe/protocol-generated/validators';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path';

const SIGNED_I64_MIN = -(2n ** 63n);
const SIGNED_I64_MAX = 2n ** 63n - 1n;
const JS_SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const JS_SAFE_INTEGER_MIN = -JS_SAFE_INTEGER_MAX;
const SIGNED_INTEGER_PATTERN = /^(?:0|-[1-9]\d*|[1-9]\d*)$/;
const CLIENT_OWNER_MARKER = '.balanceframe-scenario-kit-owner';

export interface SeededEntityIds {
  readonly accountIds: Readonly<Record<string, string>>;
  readonly categoryGroupIds: Readonly<Record<string, string>>;
  readonly categoryIds: Readonly<Record<string, string>>;
  readonly payeeIds: Readonly<Record<string, string>>;
  readonly transactionIds: Readonly<Record<string, string>>;
}

export interface SeededActualBudget extends SeededEntityIds {
  /** The remote budget/file id (not the sync group id). */
  readonly budgetId: string;
  /** The Actual sync group id used by downloadBudget. */
  readonly groupId: string;
  readonly budgetName: string;
  readonly name: string;
  /** Local cache id, retained only as diagnostic metadata. */
  readonly localBudgetId?: string;
}

export interface SeedActualBudgetOptions {
  readonly serverUrl: string;
  readonly secretKey: string;
  readonly clientDir: string;
  readonly budgetName: string;
  readonly ledger: ProtocolSnapshot;
}

type ActualRow = Record<string, unknown>;

type ActualClient = {
  send(method: string, args?: unknown): Promise<unknown>;
};

type ActualApi = {
  init(options: { serverURL: string; password: string; dataDir: string }): Promise<ActualClient>;
  shutdown(): Promise<void>;
  sync(): Promise<void>;
  getBudgets(): Promise<unknown[]>;
  getAccounts(): Promise<unknown[]>;
  getAccountBalance(accountId: string): Promise<unknown>;
  createAccount(input: Record<string, unknown>, initialBalance?: number): Promise<unknown>;
  getCategoryGroups(): Promise<unknown[]>;
  createCategoryGroup(input: Record<string, unknown>): Promise<unknown>;
  getCategories(): Promise<unknown[]>;
  createCategory(input: Record<string, unknown>): Promise<unknown>;
  getPayees(): Promise<unknown[]>;
  createPayee(input: Record<string, unknown>): Promise<unknown>;
  addTransactions(
    accountId: string,
    transactions: Array<Record<string, unknown>>,
    options?: { runTransfers?: boolean; learnCategories?: boolean },
  ): Promise<unknown>;
  importTransactions(
    accountId: string,
    transactions: Array<Record<string, unknown>>,
    options?: { defaultCleared?: boolean; payeeNameNormalization?: string },
  ): Promise<unknown>;
  updateTransaction(id: string, fields: Record<string, unknown>): Promise<unknown>;
  getTransactions(accountId: string): Promise<unknown[]>;
  setBudgetAmount(month: string, categoryId: string, amount: number): Promise<unknown>;
  setBudgetCarryover?(month: string, categoryId: string, carriesOver: boolean): Promise<unknown>;
  getBudgetMonth(month: string): Promise<unknown>;
};

const actualApi = actualApiModule as unknown as ActualApi;

interface ParsedMoney {
  readonly bigint: bigint;
  readonly number: number;
  readonly currency: string;
}

interface PreparedLedger {
  readonly snapshot: ProtocolSnapshot;
  readonly categoryById: Map<string, ProtocolSnapshot['categories'][number]>;
  readonly deletedCategoryIds: ReadonlySet<string>;
  readonly duplicateImportedIds: ReadonlySet<string>;
  readonly amountByTransactionId: Map<string, number>;
  readonly initialBalanceByAccountId: Map<string, number>;
  readonly clearedBalanceByAccountId: Map<string, number>;
}

interface TransactionOperation {
  readonly source: Transaction;
  readonly accountId: string;
  readonly amount: number;
  readonly imported: boolean;
  readonly split: boolean;
  directId?: string;
}

interface ReadTransaction extends ActualRow {
  id: string;
  accountId: string;
}

function fail(message: string): never {
  throw new Error(`Actual fixture validation failed: ${message}`);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function idFromResult(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = value.id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

function idListFromResult(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const id = idFromResult(entry);
    return id ? [id] : [];
  });
}

function parseMoney(
  value: unknown,
  label: string,
  expectedCurrency: string | undefined,
): ParsedMoney {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} has malformed money; minorUnits must be a signed integer decimal string`);
  }
  if (!('minorUnits' in value) || !('currency' in value)) {
    fail(`${label} has malformed money; minorUnits must be a signed integer decimal string`);
  }
  const minorUnits = value.minorUnits;
  const currency = value.currency;
  if (typeof minorUnits !== 'string' || typeof currency !== 'string') {
    fail(`${label} has malformed money; minorUnits must be a signed integer decimal string`);
  }
  if (!SIGNED_INTEGER_PATTERN.test(minorUnits)) {
    fail(`${label} has malformed minorUnits ${JSON.stringify(minorUnits)}`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    fail(`${label} has malformed currency ${JSON.stringify(currency)}`);
  }

  let bigint: bigint;
  try {
    bigint = BigInt(minorUnits);
  } catch {
    fail(`${label} has malformed minorUnits ${JSON.stringify(minorUnits)}`);
  }
  if (bigint < SIGNED_I64_MIN || bigint > SIGNED_I64_MAX) {
    fail(`${label} overflows the signed 64-bit integer range`);
  }
  if (expectedCurrency !== undefined && currency !== expectedCurrency) {
    fail(`${label} uses currency ${currency}; expected ${expectedCurrency}`);
  }
  const number = Number(bigint);
  if (
    bigint < JS_SAFE_INTEGER_MIN ||
    bigint > JS_SAFE_INTEGER_MAX ||
    !Number.isSafeInteger(number)
  ) {
    fail(`${label} is outside JavaScript's safe integer range`);
  }
  return { bigint, number, currency };
}

function checkedI64(value: bigint, label: string): bigint {
  if (value < SIGNED_I64_MIN || value > SIGNED_I64_MAX) {
    fail(`${label} overflows the signed 64-bit integer range`);
  }
  if (value < JS_SAFE_INTEGER_MIN || value > JS_SAFE_INTEGER_MAX) {
    fail(`${label} is outside JavaScript's safe integer range`);
  }
  return value;
}

function assertUniqueIds<T extends { id: string }>(
  entries: readonly T[],
  label: string,
): Map<string, T> {
  const byId = new Map<string, T>();
  for (const [index, entry] of entries.entries()) {
    const id = readString(entry.id, `${label}[${index}].id`);
    if (byId.has(id)) fail(`duplicate ${label} logical id ${JSON.stringify(id)}`);
    byId.set(id, entry);
  }
  return byId;
}

function assertUniqueNames<T extends { name: string }>(entries: readonly T[], label: string): void {
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const name = readString(entry.name, `${label}[${index}].name`);
    if (names.has(name)) fail(`duplicate ${label} name ${JSON.stringify(name)}`);
    names.add(name);
  }
}

function mapAccountType(accountType: ProtocolSnapshot['accounts'][number]['accountType']): string {
  switch (accountType) {
    case 'checking':
      return 'checking';
    case 'savings':
      return 'savings';
    case 'creditCard':
      return 'credit';
    case 'cash':
    case 'investment':
    case 'mortgage':
    case 'loan':
    case 'other':
      return 'other';
  }
}

function accountRef(
  accountId: string,
  accountIds: Readonly<Record<string, string>>,
  label: string,
): string {
  const actualId = accountIds[accountId];
  if (!actualId) fail(`${label} references unresolved account ${JSON.stringify(accountId)}`);
  return actualId;
}

function categoryRef(
  categoryId: string | null,
  categoryIds: Readonly<Record<string, string>>,
  label: string,
  deletedCategoryIds?: ReadonlySet<string>,
): string | null {
  if (categoryId === null) return null;
  if (deletedCategoryIds?.has(categoryId)) return null;
  const actualId = categoryIds[categoryId];
  if (!actualId) fail(`${label} references unresolved category ${JSON.stringify(categoryId)}`);
  return actualId;
}

function payeeRef(
  payeeId: string | null,
  payeeIds: Readonly<Record<string, string>>,
  label: string,
): string | null {
  if (payeeId === null) return null;
  const actualId = payeeIds[payeeId];
  if (!actualId) fail(`${label} references unresolved payee ${JSON.stringify(payeeId)}`);
  return actualId;
}

function transactionPayeeRef(
  transaction: Transaction,
  payeeIds: Readonly<Record<string, string>>,
  payeeNameIds: Readonly<Record<string, string>>,
): string | null {
  if (transaction.payeeId !== null) {
    return payeeRef(transaction.payeeId, payeeIds, `transaction ${transaction.id}`);
  }
  if (transaction.payeeName !== null) {
    return payeeNameIds[transaction.payeeName] ?? null;
  }
  return null;
}

function rowId(row: ActualRow): string | undefined {
  return typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined;
}

function rowReference(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = value.id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

function rowAccount(row: ActualRow, fallback?: string): string | undefined {
  const value = row.account ?? row.account_id;
  return rowReference(value) ?? fallback;
}

function rowPayee(row: ActualRow): string | null {
  const value = row.payee ?? row.payee_id;
  return rowReference(value) ?? null;
}

function rowCategory(row: ActualRow): string | null {
  const value = row.category ?? row.category_id;
  return rowReference(value) ?? null;
}

function rowImportedId(row: ActualRow): string | null {
  const value = row.imported_id ?? row.importedId;
  return typeof value === 'string' ? value : null;
}

function rowImportedPayee(row: ActualRow): string | null {
  const value = row.imported_payee ?? row.importedPayee;
  return typeof value === 'string' ? value : null;
}

function rowAmount(row: ActualRow): number | undefined {
  const value = row.amount;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && SIGNED_INTEGER_PATTERN.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function rowIsChild(row: ActualRow): boolean {
  return row.is_child === true || typeof row.parent_id === 'string';
}

function monthIsValid(month: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(month)) return false;
  const numericMonth = Number(month.slice(5));
  return numericMonth >= 1 && numericMonth <= 12;
}

function validateLedger(input: ProtocolSnapshot): PreparedLedger {
  let snapshot: ProtocolSnapshot;
  try {
    snapshot = canonicalProtocolSnapshotSchema.parse(input);
  } catch (error) {
    throw new Error(
      `Actual fixture validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (snapshot.rules.length > 0) fail('rules are not supported by the Actual scenario seeder');
  if (snapshot.schedules.length > 0) {
    fail('schedules are not supported by the Actual scenario seeder');
  }
  if (snapshot.tags.length > 0) fail('tags are not supported by the Actual scenario seeder');

  const accountById = assertUniqueIds(snapshot.accounts, 'accounts');
  const categoryById = assertUniqueIds(snapshot.categories, 'categories');
  const payeeById = assertUniqueIds(snapshot.payees, 'payees');
  assertUniqueNames(snapshot.accounts, 'account');
  assertUniqueNames(snapshot.payees, 'payee');

  let currency: string | undefined;
  const setCurrency = (money: unknown, label: string): ParsedMoney => {
    const parsed = parseMoney(money, label, currency);
    currency ??= parsed.currency;
    return parsed;
  };

  const clearedBalanceByAccountId = new Map<string, bigint>();
  for (const account of snapshot.accounts) {
    const cleared = setCurrency(account.clearedBalance, `account ${account.id} clearedBalance`);
    setCurrency(account.importedBalance, `account ${account.id} importedBalance`);
    clearedBalanceByAccountId.set(account.id, cleared.bigint);
  }

  const activeCategoryById = new Map(
    [...categoryById.entries()].filter(([, category]) => !category.deleted),
  );
  const deletedCategoryIds = new Set(
    [...categoryById.entries()].filter(([, category]) => category.deleted).map(([id]) => id),
  );
  const activeCategories = [...activeCategoryById.values()];
  assertUniqueNames(activeCategories, 'category');
  for (const category of activeCategories) {
    if (category.groupName === null || category.groupName.length === 0) {
      fail(`category ${JSON.stringify(category.id)} has no category group`);
    }
  }

  for (const payee of snapshot.payees) {
    if (payee.transferAccountId !== null && !accountById.has(payee.transferAccountId)) {
      fail(
        `payee ${JSON.stringify(payee.id)} references unresolved transfer account ` +
          `${JSON.stringify(payee.transferAccountId)}`,
      );
    }
  }

  const amountByTransactionId = new Map<string, number>();
  const transactionIds = new Set<string>();
  const transactionImportedIds = new Map<string, number>();
  const transactionSumsByAccount = new Map<string, bigint>();
  const visitTransaction = (transaction: Transaction, path: string, nested: boolean): void => {
    if (transactionIds.has(transaction.id)) {
      fail(`duplicate transaction logical id ${JSON.stringify(transaction.id)}`);
    }
    transactionIds.add(transaction.id);
    const amount = setCurrency(transaction.amount, `${path}.amount`);
    amountByTransactionId.set(transaction.id, amount.number);
    if (!accountById.has(transaction.accountId)) {
      fail(`${path} references unresolved account ${JSON.stringify(transaction.accountId)}`);
    }
    if (transaction.tags.length > 0) {
      fail(`${path} uses unsupported transaction tags`);
    }

    if (transaction.payeeId !== null && !payeeById.has(transaction.payeeId)) {
      fail(`${path} references unresolved payee ${JSON.stringify(transaction.payeeId)}`);
    }
    if (transaction.categoryId !== null && !categoryById.has(transaction.categoryId)) {
      fail(`${path} references unresolved category ${JSON.stringify(transaction.categoryId)}`);
    }
    if (transaction.transferAccountId !== null && !accountById.has(transaction.transferAccountId)) {
      fail(
        `${path} references unresolved transfer account ${JSON.stringify(transaction.transferAccountId)}`,
      );
    }
    if (transaction.importedId !== null) {
      transactionImportedIds.set(
        transaction.importedId,
        (transactionImportedIds.get(transaction.importedId) ?? 0) + 1,
      );
    }

    if (!nested) {
      const previous = transactionSumsByAccount.get(transaction.accountId) ?? 0n;
      transactionSumsByAccount.set(
        transaction.accountId,
        checkedI64(previous + amount.bigint, `account ${transaction.accountId} transaction sum`),
      );
    }

    if (transaction.subtransactions.length > 0 && nested) {
      fail(`${path} contains nested split transactions, which Actual does not support`);
    }
    let splitSum = 0n;
    for (const [index, child] of transaction.subtransactions.entries()) {
      if (child.accountId !== transaction.accountId) {
        fail(`${path}.subtransactions[${index}] must use the parent account`);
      }
      visitTransaction(child, `${path}.subtransactions[${index}]`, true);
      splitSum = checkedI64(
        splitSum + BigInt(amountByTransactionId.get(child.id)!),
        `${path} split sum`,
      );
    }
    if (transaction.subtransactions.length > 0 && splitSum !== amount.bigint) {
      fail(
        `${path} split amount ${amount.bigint.toString()} does not equal child sum ${splitSum.toString()}`,
      );
    }
  };
  for (const [index, transaction] of snapshot.transactions.entries()) {
    visitTransaction(transaction, `transactions[${index}]`, false);
  }
  const duplicateImportedIds = new Set(
    [...transactionImportedIds.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  );

  const initialBalanceByAccountId = new Map<string, number>();
  const clearedBalanceNumbers = new Map<string, number>();
  for (const account of snapshot.accounts) {
    const cleared = clearedBalanceByAccountId.get(account.id)!;
    const sum = transactionSumsByAccount.get(account.id) ?? 0n;
    const initial = checkedI64(
      cleared - sum,
      `account ${JSON.stringify(account.id)} initial balance`,
    );
    initialBalanceByAccountId.set(account.id, Number(initial));
    clearedBalanceNumbers.set(account.id, Number(cleared));
  }

  const budgetIds = new Set<string>();
  const budgetMonths = new Set<string>();
  for (const [index, budget] of snapshot.budgets.entries()) {
    if (budgetIds.has(budget.id)) fail(`duplicate budget logical id ${JSON.stringify(budget.id)}`);
    budgetIds.add(budget.id);
    if (budgetMonths.has(budget.month)) {
      fail(`duplicate budget month ${JSON.stringify(budget.month)}`);
    }
    budgetMonths.add(budget.month);
    if (!monthIsValid(budget.month)) fail(`invalid budget month ${JSON.stringify(budget.month)}`);
    for (const [key, categoryBudget] of Object.entries(budget.categories)) {
      if (key !== categoryBudget.categoryId) {
        fail(
          `budgets[${index}] category key ${JSON.stringify(key)} does not match ` +
            `categoryId ${JSON.stringify(categoryBudget.categoryId)}`,
        );
      }
      if (!activeCategoryById.has(categoryBudget.categoryId)) {
        fail(
          `budget ${JSON.stringify(budget.id)} references unresolved category ` +
            `${JSON.stringify(categoryBudget.categoryId)}`,
        );
      }
      const amount = setCurrency(
        categoryBudget.amount,
        `budget ${budget.month} category ${categoryBudget.categoryId} amount`,
      );
      const carryover = setCurrency(
        categoryBudget.carryover,
        `budget ${budget.month} category ${categoryBudget.categoryId} carryover`,
      );
      const carryoverFromPrevious = setCurrency(
        categoryBudget.carryoverFromPrevious,
        `budget ${budget.month} category ${categoryBudget.categoryId} carryoverFromPrevious`,
      );
      if (carryover.bigint !== 0n || carryoverFromPrevious.bigint !== 0n) {
        fail(
          `budget ${budget.month} category ${categoryBudget.categoryId} has unsupported non-zero carryover`,
        );
      }
      // Keep the amount conversion in the validation pass so every value sent
      // through Actual is checked for both i64 and JavaScript-safe bounds.
      void amount;
    }
  }

  if (currency === undefined) fail('snapshot contains no monetary values');
  return {
    snapshot,
    categoryById: activeCategoryById,
    deletedCategoryIds,
    duplicateImportedIds,
    amountByTransactionId,
    initialBalanceByAccountId,
    clearedBalanceByAccountId: clearedBalanceNumbers,
  };
}

function categoryGroupId(row: ActualRow): string | undefined {
  return typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined;
}

async function resolveCategoryGroupId(name: string, result: unknown): Promise<string> {
  const direct = idFromResult(result);
  if (direct) return direct;
  const groups = (await actualApi.getCategoryGroups()).map((row) => row as ActualRow);
  const matches = groups
    .filter((row) => row.name === name)
    .flatMap((row) => {
      const id = categoryGroupId(row);
      return id ? [id] : [];
    });
  const id = matches.at(-1);
  if (!id) fail(`Actual did not return a category group id for ${JSON.stringify(name)}`);
  return id;
}

async function resolveCreatedEntityId(
  result: unknown,
  read: () => Promise<unknown[]>,
  matches: (row: ActualRow) => boolean,
  label: string,
): Promise<string> {
  const direct = idFromResult(result);
  if (direct) return direct;
  const rows = (await read()).map((row) => row as ActualRow).filter(matches);
  const id = rows.at(-1)?.id;
  if (typeof id !== 'string' || id.length === 0) {
    fail(`Actual did not return an id for ${label}`);
  }
  return id;
}

function buildAccountIds(rows: readonly ActualRow[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.name === 'string' && typeof row.id === 'string') byName.set(row.name, row.id);
  }
  return byName;
}

function actualCategoryGroup(row: ActualRow): string | null {
  const value = row.group_id ?? row.groupId;
  return typeof value === 'string' ? value : null;
}

function actualBudgeted(row: ActualRow): number | undefined {
  const value = row.budgeted;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && SIGNED_INTEGER_PATTERN.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

async function readTransactionRows(accountIds: readonly string[]): Promise<ReadTransaction[]> {
  const rows: ReadTransaction[] = [];
  for (const accountId of accountIds) {
    const transactions = await actualApi.getTransactions(accountId);
    for (const value of transactions) {
      const row = value as ActualRow;
      const id = rowId(row);
      if (id) rows.push({ ...row, id, accountId: rowAccount(row, accountId) ?? accountId });
    }
  }
  return rows;
}

function flattenSubtransactions(parent: ReadTransaction): ReadTransaction[] {
  const nested = Array.isArray(parent.subtransactions) ? parent.subtransactions : [];
  return nested.flatMap((value) => {
    const row = value as ActualRow;
    const id = rowId(row);
    return id
      ? [{ ...row, id, accountId: rowAccount(row, parent.accountId) ?? parent.accountId }]
      : [];
  });
}

function transactionMatches(
  source: Transaction,
  operation: TransactionOperation,
  row: ReadTransaction,
  categoryIds: Readonly<Record<string, string>>,
  payeeIds: Readonly<Record<string, string>>,
  payeeNameIds: Readonly<Record<string, string>>,
  deletedCategoryIds: ReadonlySet<string>,
): boolean {
  if (rowIsChild(row)) return false;
  if ((row.account ?? row.account_id ?? row.accountId) !== operation.accountId) return false;
  if (row.date !== source.date || rowAmount(row) !== operation.amount) return false;
  const expectedPayee = transactionPayeeRef(source, payeeIds, payeeNameIds);
  const actualPayee = rowPayee(row);
  if (expectedPayee !== null && actualPayee !== expectedPayee) return false;
  const expectedCategory = categoryRef(
    source.categoryId,
    categoryIds,
    `transaction ${source.id}`,
    deletedCategoryIds,
  );
  const actualCategory = rowCategory(row);
  if (expectedCategory !== null && actualCategory !== expectedCategory) return false;
  if (source.importedId !== null && rowImportedId(row) !== source.importedId) {
    return false;
  }
  return true;
}

function transactionPayload(
  transaction: Transaction,
  accountIds: Readonly<Record<string, string>>,
  categoryIds: Readonly<Record<string, string>>,
  payeeIds: Readonly<Record<string, string>>,
  payeeNameIds: Readonly<Record<string, string>>,
  deletedCategoryIds: ReadonlySet<string>,
  amount: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    date: transaction.date,
    amount,
    payee: transactionPayeeRef(transaction, payeeIds, payeeNameIds),
    category: categoryRef(
      transaction.categoryId,
      categoryIds,
      `transaction ${transaction.id}`,
      deletedCategoryIds,
    ),
    notes: transaction.notes ?? '',
    cleared: transaction.cleared,
  };
  if (transaction.payeeId === null && transaction.payeeName !== null && payload.payee === null) {
    fail(
      `transaction ${JSON.stringify(transaction.id)} has unresolved payee name ` +
        `${JSON.stringify(transaction.payeeName)}`,
    );
  }
  if (transaction.importedId !== null) payload.imported_id = transaction.importedId;
  if (transaction.importedPayee !== null) payload.imported_payee = transaction.importedPayee;
  if (transaction.transferAccountId !== null) {
    accountRef(transaction.transferAccountId, accountIds, `transaction ${transaction.id}`);
  }
  return payload;
}

async function populatePrepared(ledger: PreparedLedger): Promise<SeededEntityIds> {
  const snapshot = ledger.snapshot;
  const accountIds: Record<string, string> = {};
  const categoryGroupIds: Record<string, string> = {};
  const categoryIds: Record<string, string> = {};
  const payeeIds: Record<string, string> = {};
  const transactionIds: Record<string, string> = {};

  const groupNames = new Set<string>();
  for (const category of ledger.categoryById.values()) {
    const groupName = category.groupName!;
    if (groupNames.has(groupName)) continue;
    groupNames.add(groupName);
    const result = await actualApi.createCategoryGroup({ name: groupName });
    categoryGroupIds[groupName] = await resolveCategoryGroupId(groupName, result);
  }

  for (const account of snapshot.accounts) {
    const result = await actualApi.createAccount(
      {
        name: account.name,
        type: mapAccountType(account.accountType),
        offbudget: account.offBudget,
        closed: account.isClosed,
      },
      ledger.initialBalanceByAccountId.get(account.id)!,
    );
    accountIds[account.id] = await resolveCreatedEntityId(
      result,
      actualApi.getAccounts,
      (row) => row.name === account.name,
      `account ${JSON.stringify(account.id)}`,
    );
  }

  for (const category of ledger.categoryById.values()) {
    const groupId = categoryGroupIds[category.groupName!];
    const result = await actualApi.createCategory({
      name: category.name,
      group_id: groupId,
      is_income: category.isIncome,
      hidden: false,
    });
    categoryIds[category.id] = await resolveCreatedEntityId(
      result,
      actualApi.getCategories,
      (row) => row.name === category.name && actualCategoryGroup(row) === groupId,
      `category ${JSON.stringify(category.id)}`,
    );
  }

  for (const payee of snapshot.payees) {
    if (payee.transferAccountId !== null) continue;
    const result = await actualApi.createPayee({ name: payee.name });
    payeeIds[payee.id] = await resolveCreatedEntityId(
      result,
      actualApi.getPayees,
      (row) => row.name === payee.name,
      `payee ${JSON.stringify(payee.id)}`,
    );
  }

  const actualPayees = (await actualApi.getPayees()).map((row) => row as ActualRow);
  for (const payee of snapshot.payees) {
    if (payee.transferAccountId === null) continue;
    const targetAccount = accountIds[payee.transferAccountId];
    const transferPayee = actualPayees.find(
      (row) => (row.transfer_acct ?? row.transferAcct) === targetAccount,
    );
    const transferId = transferPayee ? rowId(transferPayee) : undefined;
    if (!transferId) {
      fail(
        `Actual did not return a transfer payee for ${JSON.stringify(payee.id)} ` +
          `(account ${JSON.stringify(payee.transferAccountId)})`,
      );
    }
    payeeIds[payee.id] = transferId;
  }
  const payeeNameIds: Record<string, string> = {};
  for (const payee of snapshot.payees) {
    payeeNameIds[payee.name] = payeeIds[payee.id]!;
  }
  const freeTextPayeeNames = new Set<string>();
  for (const transaction of snapshot.transactions) {
    for (const entry of [transaction, ...transaction.subtransactions]) {
      if (entry.payeeId === null && entry.payeeName !== null) {
        freeTextPayeeNames.add(entry.payeeName);
      }
    }
  }
  for (const name of freeTextPayeeNames) {
    if (payeeNameIds[name]) continue;
    const result = await actualApi.createPayee({ name });
    payeeNameIds[name] = await resolveCreatedEntityId(
      result,
      actualApi.getPayees,
      (row) => row.name === name,
      `transaction payee name ${JSON.stringify(name)}`,
    );
  }

  for (const budget of [...snapshot.budgets].sort((a, b) => a.month.localeCompare(b.month))) {
    for (const categoryBudget of Object.values(budget.categories)) {
      const categoryId = categoryIds[categoryBudget.categoryId];
      const amount = Number(BigInt(categoryBudget.amount.minorUnits));
      await actualApi.setBudgetAmount(budget.month, categoryId, amount);
      if (categoryBudget.carriesOver) {
        const setCarryover = actualApi.setBudgetCarryover;
        if (!setCarryover) {
          fail('Actual does not publish setBudgetCarryover for carriesOver budget categories');
        }
        await setCarryover(budget.month, categoryId, true);
      }
    }
  }

  const operations: TransactionOperation[] = [];
  for (const transaction of snapshot.transactions) {
    const accountId = accountRef(
      transaction.accountId,
      accountIds,
      `transaction ${transaction.id}`,
    );
    const amount = ledger.amountByTransactionId.get(transaction.id)!;
    const operation: TransactionOperation = {
      source: transaction,
      accountId,
      amount,
      imported:
        transaction.importedId !== null &&
        !ledger.duplicateImportedIds.has(transaction.importedId) &&
        transaction.subtransactions.length === 0,
      split: transaction.subtransactions.length > 0,
    };
    operations.push(operation);

    const payload = transactionPayload(
      transaction,
      accountIds,
      categoryIds,
      payeeIds,
      payeeNameIds,
      ledger.deletedCategoryIds,
      amount,
    );
    if (operation.split) {
      // Actual's addTransactions API creates a split parent and its children
      // atomically, assigning all ids itself. Passing the canonical children
      // here avoids a parent-only placeholder followed by an update, which
      // older Actual versions may return without grouped child rows.
      payload.subtransactions = transaction.subtransactions.map((child) =>
        transactionPayload(
          child,
          accountIds,
          categoryIds,
          payeeIds,
          payeeNameIds,
          ledger.deletedCategoryIds,
          ledger.amountByTransactionId.get(child.id)!,
        ),
      );
      const result = await actualApi.addTransactions(accountId, [payload], {
        runTransfers: false,
      });
      operation.directId = idListFromResult(result)[0] ?? idFromResult(result);
    } else if (operation.imported) {
      const result = await actualApi.importTransactions(accountId, [payload], {
        defaultCleared: transaction.cleared,
        payeeNameNormalization: 'original',
      });
      operation.directId = idListFromResult(result)[0];
      if (!operation.directId && result && typeof result === 'object' && 'added' in result) {
        const added = idListFromResult(result.added);
        operation.directId = added[0];
      }
    } else {
      const result = await actualApi.addTransactions(accountId, [payload]);
      operation.directId = idListFromResult(result)[0] ?? idFromResult(result);
    }
  }

  const actualAccountIds = Object.values(accountIds);
  let rows = await readTransactionRows(actualAccountIds);
  const usedRows = new Set<string>();
  for (const operation of operations) {
    const matches = (row: ReadTransaction): boolean =>
      !usedRows.has(row.id) &&
      transactionMatches(
        operation.source,
        operation,
        row,
        categoryIds,
        payeeIds,
        payeeNameIds,
        ledger.deletedCategoryIds,
      );
    let matched: ReadTransaction | undefined;
    if (operation.directId) {
      // A published add/import result is only a candidate. Verify it against
      // the canonical transaction before accepting it; duplicate imported IDs
      // must never make an arbitrary row look like the requested transaction.
      matched = rows.find((row) => row.id === operation.directId && matches(row));
    }
    if (!matched) {
      matched = rows.find(matches);
    }
    if (!matched) {
      fail(
        `Actual read-back could not identify transaction ${JSON.stringify(operation.source.id)}`,
      );
    }
    usedRows.add(matched.id);
    transactionIds[operation.source.id] = matched.id;
  }

  rows = await readTransactionRows(actualAccountIds);
  for (const operation of operations.filter((entry) => entry.split)) {
    const parentId = transactionIds[operation.source.id]!;
    const parent = rows.find((row) => row.id === parentId);
    if (!parent) fail(`Actual read-back lost split parent ${JSON.stringify(operation.source.id)}`);
    const nestedChildren = flattenSubtransactions(parent);
    const flatChildren = rows.filter(
      (row) =>
        rowIsChild(row) && row.parent_id === parentId && row.accountId === operation.accountId,
    );
    // Actual's grouped query normally returns children under
    // `parent.subtransactions`; older API builds may return child rows in the
    // flat result without preserving parent_id. Keep those rows as a
    // read-back fallback, still matching every canonical child field below.
    const ungroupedChildren = rows.filter(
      (row) => rowIsChild(row) && row.accountId === operation.accountId,
    );
    const availableChildren = [...nestedChildren, ...flatChildren, ...ungroupedChildren].filter(
      (row, index, all) => all.findIndex((candidate) => candidate.id === row.id) === index,
    );
    const usedChildren = new Set<string>();
    for (const child of operation.source.subtransactions) {
      const childAmount = ledger.amountByTransactionId.get(child.id)!;
      const childRow = availableChildren.find(
        (row) =>
          !usedChildren.has(row.id) &&
          row.accountId === operation.accountId &&
          row.date === child.date &&
          rowAmount(row) === childAmount &&
          rowCategory(row) ===
            categoryRef(
              child.categoryId,
              categoryIds,
              `transaction ${child.id}`,
              ledger.deletedCategoryIds,
            ) &&
          (transactionPayeeRef(child, payeeIds, payeeNameIds) === null ||
            rowPayee(row) === transactionPayeeRef(child, payeeIds, payeeNameIds)),
      );
      if (!childRow)
        fail(`Actual read-back could not identify split child ${JSON.stringify(child.id)}`);
      usedChildren.add(childRow.id);
      transactionIds[child.id] = childRow.id;
    }
  }

  const metadata = operations.flatMap((operation) => [
    { source: operation.source, actualId: transactionIds[operation.source.id]! },
    ...operation.source.subtransactions.map((source) => ({
      source,
      actualId: transactionIds[source.id]!,
    })),
  ]);
  for (const { source, actualId } of metadata) {
    const fields: Record<string, unknown> = {};
    if (source.reconciled) fields.reconciled = true;
    if (
      source.importedId !== null &&
      !operations.some((entry) => entry.source === source && entry.imported)
    ) {
      fields.imported_id = source.importedId;
    }
    if (source.importedPayee !== null && source.importedId === null) {
      fields.imported_payee = source.importedPayee;
    }
    if (Object.keys(fields).length > 0) await actualApi.updateTransaction(actualId, fields);
  }

  await readBack(ledger, accountIds, categoryIds, payeeIds, transactionIds);
  return { accountIds, categoryGroupIds, categoryIds, payeeIds, transactionIds };
}

async function readBack(
  ledger: PreparedLedger,
  accountIds: Readonly<Record<string, string>>,
  categoryIds: Readonly<Record<string, string>>,
  payeeIds: Readonly<Record<string, string>>,
  transactionIds: Readonly<Record<string, string>>,
): Promise<void> {
  const accounts = (await actualApi.getAccounts()).map((row) => row as ActualRow);
  for (const account of ledger.snapshot.accounts) {
    const actualId = accountIds[account.id];
    const row = accounts.find((candidate) => candidate.id === actualId);
    if (!row) fail(`Actual read-back missing account ${JSON.stringify(account.id)}`);
    const balanceValue = await actualApi.getAccountBalance(actualId);
    const balance =
      typeof balanceValue === 'number' && Number.isSafeInteger(balanceValue)
        ? balanceValue
        : undefined;
    if (balance === undefined) {
      fail(`Actual read-back account ${JSON.stringify(account.id)} has no safe computed balance`);
    }
    if (balance !== ledger.clearedBalanceByAccountId.get(account.id)) {
      fail(
        `Actual read-back account ${JSON.stringify(account.id)} balance ${balance} ` +
          `does not equal checked cleared balance ${ledger.clearedBalanceByAccountId.get(account.id)}`,
      );
    }
  }

  const categories = (await actualApi.getCategories()).map((row) => row as ActualRow);
  for (const category of ledger.categoryById.values()) {
    const actualId = categoryIds[category.id];
    if (!categories.some((row) => row.id === actualId && row.name === category.name)) {
      fail(`Actual read-back missing category ${JSON.stringify(category.id)}`);
    }
  }

  const payees = (await actualApi.getPayees()).map((row) => row as ActualRow);
  for (const payee of ledger.snapshot.payees) {
    if (!payees.some((row) => row.id === payeeIds[payee.id])) {
      fail(`Actual read-back missing payee ${JSON.stringify(payee.id)}`);
    }
  }

  for (const budget of [...ledger.snapshot.budgets].sort((a, b) =>
    a.month.localeCompare(b.month),
  )) {
    const monthValue = await actualApi.getBudgetMonth(budget.month);
    if (monthValue === null || typeof monthValue !== 'object' || Array.isArray(monthValue)) {
      fail(`Actual read-back missing budget month ${JSON.stringify(budget.month)}`);
    }
    const month = monthValue as ActualRow;
    const monthGroups = Array.isArray(month.categoryGroups) ? month.categoryGroups : [];
    const monthCategories = monthGroups.flatMap((group) => {
      const groupRow = group as ActualRow;
      return Array.isArray(groupRow.categories)
        ? groupRow.categories.map((category) => category as ActualRow)
        : [];
    });
    for (const categoryBudget of Object.values(budget.categories)) {
      const row = monthCategories.find(
        (candidate) => candidate.id === categoryIds[categoryBudget.categoryId],
      );
      const expected = Number(BigInt(categoryBudget.amount.minorUnits));
      if (!row || actualBudgeted(row) !== expected) {
        fail(
          `Actual read-back budget ${budget.month}/${categoryBudget.categoryId} ` +
            `does not equal ${expected}`,
        );
      }
    }
  }

  const rows = await readTransactionRows(Object.values(accountIds));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const nestedById = new Map<string, ReadTransaction>();
  for (const row of rows) {
    if (rowIsChild(row)) nestedById.set(row.id, row);
    for (const child of flattenSubtransactions(row)) nestedById.set(child.id, child);
  }
  for (const transaction of ledger.snapshot.transactions) {
    const row = byId.get(transactionIds[transaction.id]);
    if (!row) fail(`Actual read-back missing transaction ${JSON.stringify(transaction.id)}`);
    if (rowAmount(row) !== Number(BigInt(transaction.amount.minorUnits))) {
      fail(`Actual read-back amount mismatch for transaction ${JSON.stringify(transaction.id)}`);
    }
    if (rowImportedId(row) !== transaction.importedId) {
      fail(
        `Actual read-back imported id mismatch for transaction ${JSON.stringify(transaction.id)}`,
      );
    }
    if (transaction.importedPayee !== null && rowImportedPayee(row) !== transaction.importedPayee) {
      fail(
        `Actual read-back imported payee mismatch for transaction ${JSON.stringify(transaction.id)}`,
      );
    }
    if (transaction.reconciled && row.reconciled !== true) {
      fail(
        `Actual read-back reconciliation mismatch for transaction ${JSON.stringify(transaction.id)}`,
      );
    }
    for (const child of transaction.subtransactions) {
      const childRow = nestedById.get(transactionIds[child.id]);
      if (!childRow || rowAmount(childRow) !== Number(BigInt(child.amount.minorUnits))) {
        fail(`Actual read-back split child mismatch for transaction ${JSON.stringify(child.id)}`);
      }
      if (child.importedId !== null && rowImportedId(childRow) !== child.importedId) {
        fail(`Actual read-back imported id mismatch for split child ${JSON.stringify(child.id)}`);
      }
      if (child.importedPayee !== null && rowImportedPayee(childRow) !== child.importedPayee) {
        fail(
          `Actual read-back imported payee mismatch for split child ${JSON.stringify(child.id)}`,
        );
      }
      if (child.reconciled && childRow.reconciled !== true) {
        fail(
          `Actual read-back reconciliation mismatch for split child ${JSON.stringify(child.id)}`,
        );
      }
    }
  }
}

function assertLoopbackServerUrl(serverUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error('Actual server URL must be a valid HTTP(S) loopback URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Actual server URL must use HTTP(S) on a loopback host');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Actual server URL must not contain credentials');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '[::1]') {
    throw new Error('Actual server URL must use localhost, 127.0.0.1, or ::1');
  }
}

function assertNoSymlinkPath(pathname: string): void {
  const absolute = resolve(pathname);
  const root = parsePath(absolute).root;
  let cursor = root;
  const relative = absolute.slice(root.length);
  for (const component of relative.split('/').filter(Boolean)) {
    cursor = join(cursor, component);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`Scenario client path contains a symlink: ${cursor}`);
    }
  }
}

function createOwnedClientDir(clientDir: string): string {
  if (!isAbsolute(clientDir)) throw new Error('Scenario clientDir must be an absolute path');
  const absolute = resolve(clientDir);
  assertNoSymlinkPath(dirname(absolute));
  let existing: Stats | undefined;
  try {
    existing = lstatSync(absolute);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error('Scenario clientDir must not be a symlink');
    }
    throw new Error('Scenario clientDir must be a new, owned disposable directory');
  }
  const parent = dirname(absolute);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory()) {
    throw new Error('Scenario clientDir parent must already be an owned directory');
  }
  mkdirSync(absolute, { recursive: false, mode: 0o700 });
  try {
    writeFileSync(
      join(absolute, CLIENT_OWNER_MARKER),
      JSON.stringify({ version: 1, owner: 'balanceframe-scenario-kit', token: randomUUID() }) +
        '\n',
      { mode: 0o600, flag: 'wx' },
    );
  } catch (error) {
    rmSync(absolute, { recursive: true, force: true });
    throw error;
  }
  return absolute;
}

export async function populateActualBudget(ledger: ProtocolSnapshot): Promise<SeededEntityIds> {
  const prepared = validateLedger(ledger);
  return populatePrepared(prepared);
}

export async function seedActualBudget(
  options: SeedActualBudgetOptions,
): Promise<SeededActualBudget> {
  assertLoopbackServerUrl(options.serverUrl);
  if (typeof options.secretKey !== 'string' || options.secretKey.trim().length === 0) {
    throw new Error('Actual secretKey must be a non-empty string');
  }
  if (typeof options.budgetName !== 'string' || options.budgetName.trim().length === 0) {
    throw new Error('Actual budgetName must be a non-empty string');
  }
  const prepared = validateLedger(options.ledger);
  const clientDir = createOwnedClientDir(options.clientDir);
  let initialized = false;
  try {
    const client = await actualApi.init({
      serverURL: options.serverUrl,
      password: options.secretKey,
      dataDir: clientDir,
    });
    initialized = true;
    await client.send('create-budget', { budgetName: options.budgetName, avoidUpload: false });
    const budgets = (await actualApi.getBudgets()).map((row) => row as ActualRow);
    const localBudget = budgets.find(
      (row) => row.name === options.budgetName && typeof row.id === 'string' && row.id.length > 0,
    );
    const cloudBudget = budgets.find(
      (row) =>
        row.name === options.budgetName &&
        typeof row.groupId === 'string' &&
        row.groupId.length > 0,
    );
    if (!cloudBudget) {
      throw new Error(`Created budget ${JSON.stringify(options.budgetName)} has no sync group id`);
    }
    const groupIdValue = cloudBudget.groupId;
    if (typeof groupIdValue !== 'string' || groupIdValue.length === 0) {
      throw new Error(`Created budget ${JSON.stringify(options.budgetName)} has no sync group id`);
    }
    const budgetId =
      (typeof cloudBudget.cloudFileId === 'string' && cloudBudget.cloudFileId) ||
      (typeof cloudBudget.id === 'string' && cloudBudget.id) ||
      (typeof localBudget?.id === 'string' && localBudget.id) ||
      '';
    const groupId = groupIdValue;
    if (!budgetId)
      throw new Error(`Created budget ${JSON.stringify(options.budgetName)} has no remote id`);

    const ids = await populatePrepared(prepared);
    // Initial create-budget uploads an empty archive. Publish the populated
    // SQLite snapshot before another Actual client downloads the new budget.
    const publication = await client.send('upload-budget');
    if (publication && typeof publication === 'object' && 'error' in publication && publication.error) {
      throw new Error('Actual rejected the seeded budget publication');
    }
    return {
      ...ids,
      budgetId,
      groupId,
      budgetName: options.budgetName,
      name: options.budgetName,
      ...(typeof localBudget?.id === 'string' ? { localBudgetId: localBudget.id } : {}),
    };
  } finally {
    if (initialized) await actualApi.shutdown().catch(() => {});
  }
}
