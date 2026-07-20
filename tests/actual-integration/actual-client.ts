import {
  createCategory as createActualCategory,
  downloadBudget as downloadActualBudget,
  getBudgetMonths as getActualBudgetMonths,
  getBudgets,
  getTransactions as getActualTransactions,
  internal,
  loadBudget as loadActualBudget,
  q as actualQuery,
  runQuery as runActualQuery,
} from '@actual-app/api';

export * from '@actual-app/api';

interface BudgetOptions {
  name?: string;
  budgetName?: string;
  avoidUpload?: boolean;
}

interface BudgetIdentity {
  id: string;
  groupId: string;
}

interface ActualClient {
  send(_method: string, _args?: unknown): Promise<unknown>;
}


function requireClient(): ActualClient {
  if (!internal) {
    throw new Error('Actual API client is not initialized');
  }

  return internal as ActualClient;
}
interface CategoryOptions {
  name: string;
  groupId: string;
  isIncome?: boolean;
  hidden?: boolean;
}

/** Creates a category with the camel-case fields used by this test suite. */
export function createCategory(options: CategoryOptions): Promise<string> {
  return createActualCategory({
    name: options.name,
    group_id: options.groupId,
    is_income: options.isIncome,
    hidden: options.hidden,
  });
}


interface TransactionDateRange {
  startDate?: string;
  endDate?: string;
}

/** Reads account transactions, accepting the test suite's range object. */
export function getTransactions(
  accountId: string,
  range?: TransactionDateRange,
): Promise<unknown[]> {
  return getActualTransactions(accountId, range?.startDate, range?.endDate);
}

/** Reads budget months, optionally restricting the result to an inclusive range. */
export async function getBudgetMonths(startMonth?: string, endMonth?: string): Promise<string[]> {
  const months = await getActualBudgetMonths();
  return months.filter(
    (month) =>
      (!startMonth || month >= startMonth) &&
      (!endMonth || month <= endMonth),
  );
}

/** Creates and uploads a budget through Actual's initialized local client. */
export async function createBudget(options: BudgetOptions): Promise<BudgetIdentity> {
  const budgetName = options.budgetName ?? options.name;
  if (!budgetName) {
    throw new Error('A budget name is required');
  }

  await requireClient().send('create-budget', {
    budgetName,
    avoidUpload: options.avoidUpload ?? false,
  });

  const budgets = await getBudgets();
  const localBudget = budgets.find(
    (candidate) => candidate.name === budgetName && 'id' in candidate && Boolean(candidate.id),
  );
  const cloudBudget = budgets.find(
    (candidate) => candidate.name === budgetName && Boolean(candidate.groupId),
  );
  if (!localBudget || !('id' in localBudget) || !localBudget.id || !cloudBudget?.groupId) {
    throw new Error(`Created budget "${budgetName}" was not fully synchronized with Actual`);
  }

  return { id: localBudget.id, groupId: cloudBudget.groupId };
}
interface LegacyQueryFilter {
  field: string;
  op: 'eq' | 'is' | 'lt';
  value: string | number | null;
}

interface LegacyQuery {
  select: 'transactions';
  filters: LegacyQueryFilter[];
}

/** Executes the simple object-shaped ActualQL queries used by these tests. */
export function runQuery(query: LegacyQuery): Promise<{ data: unknown[] }> {
  const filters = Object.fromEntries(
    query.filters.map(({ field, op, value }) => [
      field,
      op === 'eq' || op === 'is' ? value : { [`$${op}`]: value },
    ]),
  );
  return runActualQuery(actualQuery(query.select).filter(filters).select('*')) as Promise<{
    data: unknown[];
  }>;
}

interface ExportResult {
  data: Uint8Array;
}

/** Exports the currently loaded budget as Actual's native archive bytes. */
export async function exportBudget(): Promise<Buffer> {
  const result = await requireClient().send('export-budget') as ExportResult;
  return Buffer.from(result.data);
}

/** Restores an Actual native archive and opens the imported budget. */
export async function importBudgetArchive(filepath: string): Promise<void> {
  const result = await requireClient().send('import-budget', {
    filepath,
    type: 'actual',
  }) as { error?: string };
  if (result?.error) {
    throw new Error(`Actual budget import failed: ${result.error}`);
  }
}

interface DownloadOptions {
  password?: string;
}

/**
 * Selects a local budget when its ID is provided, otherwise downloads the
 * server budget identified by its group sync ID.
 */
export async function downloadBudget(
  groupId: string,
  budgetIdOrOptions?: string | DownloadOptions,
  options?: DownloadOptions,
): Promise<void> {
  if (typeof budgetIdOrOptions === 'string') {
    await loadActualBudget(budgetIdOrOptions);
    return;
  }

  const remoteBudget = (await getBudgets()).find(
    (budget) => budget.groupId === groupId,
  );
  if (!remoteBudget) {
    throw new Error(`No remote budget exists for group "${groupId}"`);
  }

  await downloadActualBudget(groupId, budgetIdOrOptions ?? options);
}

/** Deletes a budget through Actual's initialized local client. */
export async function deleteBudget(groupId: string, budgetId: string): Promise<void> {
  const remoteBudget = (await getBudgets()).find(
    (budget) => budget.groupId === groupId && Boolean(budget.cloudFileId),
  );
  await requireClient().send('delete-budget', {
    id: budgetId,
    cloudFileId: remoteBudget?.cloudFileId,
  });
}
