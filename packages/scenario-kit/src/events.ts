import * as actualApiModule from '@actual-app/api';
import type { Transaction } from '@balanceframe/protocol-generated';
import type {
  ImportCandidate,
  MaterializedScenario,
  ScenarioEventId,
  ScenarioEventRecipe,
} from './catalog.js';
import type { SeededActualBudget } from './actual-seed.js';
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

interface ActualRow extends Record<string, unknown> {
  readonly id?: unknown;
  readonly account?: unknown;
  readonly account_id?: unknown;
  readonly accountId?: unknown;
  readonly amount?: unknown;
  readonly category?: unknown;
  readonly date?: unknown;
  readonly imported_id?: unknown;
  readonly importedId?: unknown;
  readonly subtransactions?: unknown;
}

interface ActualBudgetRow extends Record<string, unknown> {
  readonly id?: unknown;
  readonly groupId?: unknown;
  readonly group_id?: unknown;
  readonly cloudFileId?: unknown;
}

interface ActualClientHandle {
  send(method: string, args?: unknown): Promise<unknown>;
}

interface ActualApi {
  init(options: {
    serverURL: string;
    password: string;
    dataDir: string;
  }): Promise<ActualClientHandle>;
  shutdown(): Promise<void>;
  downloadBudget(syncId: string): Promise<void>;
  getBudgets(): Promise<ActualBudgetRow[]>;
  updateTransaction(id: string, fields: Partial<ActualRow>): Promise<unknown[]>;
  getTransactions(accountId: string, startDate?: string, endDate?: string): Promise<unknown[]>;
  importTransactions(
    accountId: string,
    transactions: Array<Record<string, unknown>>,
    options?: { defaultCleared?: boolean; payeeNameNormalization?: string },
  ): Promise<unknown>;
}

const actualApi = actualApiModule as unknown as ActualApi;
const CLIENT_DIRECTORY_PREFIX = '.balanceframe-scenario-event-';
const SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);

export interface CategorizeScenarioEventResult {
  readonly eventId: 'categorize-uncategorized';
  readonly kind: 'categorize-uncategorized';
  readonly transactionId: string;
  readonly categoryId: string;
  readonly amount: number;
}

export interface ImportScenarioEventResult {
  readonly eventId: 'import-match' | 'import-ambiguous';
  readonly kind: 'import-match' | 'import-ambiguous';
  readonly importedIds: readonly string[];
  readonly transactionIds: readonly string[];
  readonly amounts: readonly number[];
}

export type EventResult = CategorizeScenarioEventResult | ImportScenarioEventResult;

export interface ApplyScenarioEventOptions {
  readonly scenario: MaterializedScenario;
  readonly seeded: SeededActualBudget;
  readonly root: string;
  readonly actualServerUrl: string;
  readonly actualSecretKey: string;
  readonly eventId: ScenarioEventId;
}

function assertLoopbackUrl(serverUrl: string): void {
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

function assertEventRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error('Scenario event root must be an absolute path');
  const absolute = resolve(root);
  if (!existsSync(absolute)) throw new Error('Scenario event root does not exist');
  const stats = lstatSync(absolute);
  if (!stats.isDirectory()) throw new Error('Scenario event root must be a directory');
  if (stats.isSymbolicLink()) throw new Error('Scenario event root must not be a symlink');
  return absolute;
}

function actualId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Scenario event is missing the Actual ${label}`);
  }
  return value;
}

function minorUnits(value: { minorUnits: string; currency: string }, label: string): number {
  if (value.currency !== 'USD') {
    throw new Error(`Scenario event ${label} must use the seeded USD ledger currency`);
  }
  if (!/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value.minorUnits)) {
    throw new Error(`Scenario event ${label} must use integer minor units`);
  }
  const parsed = BigInt(value.minorUnits);
  if (parsed < -SAFE_INTEGER_MAX || parsed > SAFE_INTEGER_MAX) {
    throw new Error(`Scenario event ${label} exceeds Actual's safe integer range`);
  }
  return Number(parsed);
}

function rowId(row: ActualRow): string | undefined {
  return typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined;
}

function rowAmount(row: ActualRow): number {
  if (typeof row.amount !== 'number' || !Number.isSafeInteger(row.amount)) {
    throw new Error('Actual event read-back returned a transaction without a safe integer amount');
  }
  return row.amount;
}

function rowCategory(row: ActualRow): string | null {
  if (row.category === null || row.category === undefined) return null;
  if (typeof row.category !== 'string') {
    throw new Error('Actual event read-back returned a transaction with an invalid category');
  }
  return row.category;
}

function rowImportedId(row: ActualRow): string | null {
  const importedId = row.imported_id ?? row.importedId;
  if (importedId === null || importedId === undefined) return null;
  if (typeof importedId !== 'string') {
    throw new Error('Actual event read-back returned a transaction with an invalid import identity');
  }
  return importedId;
}

function rowDate(row: ActualRow): string {
  if (typeof row.date !== 'string' || row.date.length === 0) {
    throw new Error('Actual event read-back returned a transaction without a date');
  }
  return row.date;
}

function flattenRows(values: readonly unknown[]): ActualRow[] {
  const rowsById = new Map<string, ActualRow>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const row = value as ActualRow;
    const id = rowId(row);
    if (id) rowsById.set(id, row);
    if (Array.isArray(row.subtransactions)) {
      for (const child of row.subtransactions) visit(child);
    }
  };
  for (const value of values) visit(value);
  return [...rowsById.values()];
}

const READ_START_DATE = '1900-01-01';
const READ_END_DATE = '2999-12-31';

async function readAccountRows(accountId: string): Promise<ActualRow[]> {
  return flattenRows(
    await actualApi.getTransactions(accountId, READ_START_DATE, READ_END_DATE),
  );
}

async function publishActualChanges(client: ActualClientHandle): Promise<void> {
  const result = await client.send('sync-budget');
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    throw new Error('Actual event publication failed');
  }
}


function transactionByLogicalId(scenario: MaterializedScenario, logicalId: string): Transaction {
  const visit = (transactions: readonly Transaction[]): Transaction | undefined => {
    for (const transaction of transactions) {
      if (transaction.id === logicalId) return transaction;
      const nested = visit(transaction.subtransactions);
      if (nested) return nested;
    }
    return undefined;
  };
  const transaction = visit(scenario.ledger.transactions);
  if (!transaction) throw new Error(`Scenario event references unknown transaction ${JSON.stringify(logicalId)}`);
  return transaction;
}

function accountByLogicalId(scenario: MaterializedScenario, logicalId: string): MaterializedScenario['ledger']['accounts'][number] {
  const account = scenario.ledger.accounts.find((candidate) => candidate.id === logicalId);
  if (!account) throw new Error(`Scenario event references unknown account ${JSON.stringify(logicalId)}`);
  return account;
}

function recipeForEvent(
  scenario: MaterializedScenario,
  eventId: ScenarioEventId,
): ScenarioEventRecipe {
  const recipe = scenario.events[eventId];
  if (!recipe || recipe.kind !== eventId) {
    throw new Error(`Scenario ${JSON.stringify(scenario.id)} does not list event ${JSON.stringify(eventId)}`);
  }
  return recipe;
}

function budgetMatches(row: ActualBudgetRow, seeded: SeededActualBudget): boolean {
  const groupId = row.groupId ?? row.group_id;
  if (groupId !== seeded.groupId) return false;
  const remoteId = row.cloudFileId;
  const localId = row.id;
  const remoteMatches = typeof remoteId === 'string' && remoteId === seeded.budgetId;
  const localMatches =
    typeof localId === 'string' &&
    (localId === seeded.budgetId || localId === seeded.localBudgetId);
  return remoteMatches || localMatches;
}

async function assertSelectedBudget(seeded: SeededActualBudget): Promise<void> {
  const budgets = (await actualApi.getBudgets()).map((row) => row as ActualBudgetRow);
  if (!budgets.some((row) => budgetMatches(row, seeded))) {
    throw new Error(
      `Actual event client selected the wrong budget (expected group ${JSON.stringify(seeded.groupId)} ` +
        `and budget ${JSON.stringify(seeded.budgetId)})`,
    );
  }
}

function accountActualId(seeded: SeededActualBudget, logicalId: string): string {
  return actualId(seeded.accountIds[logicalId], `account for ${JSON.stringify(logicalId)}`);
}

function categoryActualId(seeded: SeededActualBudget, logicalId: string): string {
  return actualId(seeded.categoryIds[logicalId], `category for ${JSON.stringify(logicalId)}`);
}

function candidatesForRecipe(recipe: ScenarioEventRecipe): readonly ImportCandidate[] {
  if (recipe.kind === 'import-match') return [recipe.candidate];
  if (recipe.kind === 'import-ambiguous') return recipe.candidates;
  throw new Error(`Event ${JSON.stringify(recipe.kind)} is not an import recipe`);
}

async function applyCategorization(
  scenario: MaterializedScenario,
  seeded: SeededActualBudget,
  recipe: Extract<ScenarioEventRecipe, { kind: 'categorize-uncategorized' }>,
  client: ActualClientHandle,
): Promise<CategorizeScenarioEventResult> {
  const source = transactionByLogicalId(scenario, recipe.transactionId);
  const accountId = accountActualId(seeded, source.accountId);
  const transactionId = actualId(
    seeded.transactionIds[recipe.transactionId],
    `transaction for ${JSON.stringify(recipe.transactionId)}`,
  );
  const categoryId = categoryActualId(seeded, recipe.categoryId);
  const amount = minorUnits(recipe.amount, 'categorization amount');
  if (amount !== minorUnits(source.amount, 'source transaction amount')) {
    throw new Error('Scenario categorization amount does not match its source transaction');
  }

  const rowsBefore = await readAccountRows(accountId);
  const sourceRow = rowsBefore.find((row) => rowId(row) === transactionId);
  if (!sourceRow) throw new Error(`Actual event read-back missing transaction ${JSON.stringify(transactionId)}`);
  if (rowAmount(sourceRow) !== amount) {
    throw new Error(`Actual event source amount mismatch for transaction ${JSON.stringify(transactionId)}`);
  }

  await actualApi.updateTransaction(transactionId, { category: categoryId });
  await publishActualChanges(client);

  const rowsAfter = await readAccountRows(accountId);
  const updated = rowsAfter.find((row) => rowId(row) === transactionId);
  if (!updated) throw new Error(`Actual event read-back lost transaction ${JSON.stringify(transactionId)}`);
  if (rowAmount(updated) !== amount || rowCategory(updated) !== categoryId) {
    throw new Error(`Actual event category read-back mismatch for transaction ${JSON.stringify(transactionId)}`);
  }
  return {
    eventId: 'categorize-uncategorized',
    kind: 'categorize-uncategorized',
    transactionId,
    categoryId,
    amount,
  };
}

async function applyImport(
  scenario: MaterializedScenario,
  seeded: SeededActualBudget,
  recipe: Extract<ScenarioEventRecipe, { kind: 'import-match' | 'import-ambiguous' }>,
  client: ActualClientHandle,
): Promise<ImportScenarioEventResult> {
  const candidates = candidatesForRecipe(recipe);
  if (candidates.length === 0) throw new Error('Scenario import event must include at least one candidate');
  const accountIds = candidates.map((candidate) => accountActualId(seeded, candidate.accountId));
  const accountId = accountIds[0]!;
  if (accountIds.some((candidateAccountId) => candidateAccountId !== accountId)) {
    throw new Error('Scenario import event candidates must use one Actual account');
  }
  const importedIds = candidates.map((candidate) => candidate.importedId);
  if (new Set(importedIds).size !== importedIds.length) {
    throw new Error('Scenario import event candidates must have unique imported IDs');
  }
  const amounts = candidates.map((candidate) => {
    const account = accountByLogicalId(scenario, candidate.accountId);
    if (account.clearedBalance.currency !== candidate.amount.currency) {
      throw new Error(`Scenario import ${candidate.importedId} has an incompatible currency`);
    }
    return minorUnits(candidate.amount, `import ${candidate.importedId} amount`);
  });

  const payload = candidates.map((candidate, index) => ({
    date: candidate.date,
    amount: amounts[index]!,
    payee_name: candidate.payeeName,
    imported_payee: candidate.payeeName,
    imported_id: candidate.importedId,
    cleared: true,
  }));
  await actualApi.importTransactions(accountId, payload, {
    defaultCleared: true,
    payeeNameNormalization: 'original',
  });
  await publishActualChanges(client);

  const rowsAfter = await readAccountRows(accountId);
  const transactionIds: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const matchingRows = rowsAfter.filter((row) => rowImportedId(row) === candidate.importedId);
    if (matchingRows.length !== 1) {
      throw new Error(
        `Actual event read-back expected one row for imported ID ${JSON.stringify(candidate.importedId)}`,
      );
    }
    const row = matchingRows[0]!;
    const transactionId = rowId(row);
    if (!transactionId) {
      throw new Error(`Actual event read-back returned an import without an ID`);
    }
    if (rowAmount(row) !== amounts[index] || rowDate(row) !== candidate.date) {
      throw new Error(
        `Actual event import read-back mismatch for imported ID ${JSON.stringify(candidate.importedId)}`,
      );
    }
    transactionIds.push(transactionId);
  }
  return {
    eventId: recipe.kind,
    kind: recipe.kind,
    importedIds,
    transactionIds,
    amounts,
  };
}

/** Applies one checked-in scenario event to a disposable Actual budget and verifies its read-back. */
export async function applyScenarioEvent(
  options: ApplyScenarioEventOptions,
): Promise<EventResult> {
  assertLoopbackUrl(options.actualServerUrl);
  if (
    typeof options.actualSecretKey !== 'string' ||
    options.actualSecretKey.trim().length === 0
  ) {
    throw new Error('Actual secret key must be a non-empty string');
  }
  const root = assertEventRoot(options.root);
  const recipe = recipeForEvent(options.scenario, options.eventId);
  const clientDir = mkdtempSync(join(root, CLIENT_DIRECTORY_PREFIX));
  let initialized = false;
  try {
    const client = await actualApi.init({
      serverURL: options.actualServerUrl,
      password: options.actualSecretKey,
      dataDir: clientDir,
    });
    initialized = true;
    await actualApi.downloadBudget(options.seeded.groupId);
    await assertSelectedBudget(options.seeded);
    if (recipe.kind === 'categorize-uncategorized') {
      return await applyCategorization(options.scenario, options.seeded, recipe, client);
    }
    return await applyImport(options.scenario, options.seeded, recipe, client);
  } finally {
    try {
      if (initialized) await actualApi.shutdown();
    } finally {
      rmSync(clientDir, { recursive: true, force: true });
    }
  }
}
