/**
 * helpers.ts — Test Utilities for Actual API Integration Tests
 *
 * Provides factory functions for creating disposable test budgets, seeding
 * fixture data, cleanup, and obtaining an initialized Actual API client.
 *
 * All functions assume ACTUAL_SERVER_URL and ACTUAL_SECRET_KEY are set in
 * environment variables (or process.env by vitest config).
 */

import { init, shutdown, createBudget, deleteBudget, downloadBudget,
         getAccounts, getPayees, getCategories, addTransactions,
         createAccount, createPayee, createCategory, createCategoryGroup,
         createRule, createSchedule, sync as actualSync } from './actual-client.js';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---- Types ----------------------------------------------------------------

export interface ClientConfig {
  serverURL: string;
  password: string;
  dataDir: string;
}

export interface SeededBudget {
  budgetId: string;
  groupId: string;
  budgetName: string;
}

// ---- Environment -----------------------------------------------------------

/**
 * Read required environment variables, throwing if missing.
 */
export function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}. `
      + `Set it directly or run setup-fixture-server.sh first.`);
  }
  return val;
}

/**
 * Build a client configuration from environment variables.
 */
export function buildClientConfig(dataDir?: string): ClientConfig {
  return {
    serverURL: requireEnv('ACTUAL_SERVER_URL'),
    password: requireEnv('ACTUAL_SECRET_KEY'),
    dataDir: dataDir ?? mkdtempSync(join(tmpdir(), 'bf-actual-test-')),
  };
}

// ---- Client Lifecycle -----------------------------------------------------

/**
 * Initialize the Actual API client and return the config used.
 * Caller MUST call `shutdown()` (or use `withActualClient`).
 */
export async function getActualClient(
  config?: Partial<ClientConfig>,
): Promise<ClientConfig> {
  const base = buildClientConfig();
  const merged: ClientConfig = {
    serverURL: config?.serverURL ?? base.serverURL,
    password: config?.password ?? base.password,
    dataDir: config?.dataDir ?? base.dataDir,
  };

  await init({
    serverURL: merged.serverURL,
    password: merged.password,
    dataDir: merged.dataDir,
  });

  return merged;
}

/**
 * Wrapper that initializes a client, runs `fn`, and always shuts down.
 */
export async function withActualClient<T>(
  fn: (..._args: [ClientConfig]) => Promise<T>,
  config?: Partial<ClientConfig>,
): Promise<T> {
  const cfg = await getActualClient(config);
  try {
    return await fn(cfg);
  } finally {
    await shutdown().catch(() => {});
  }
}

// ---- Budget Lifecycle -----------------------------------------------------

/**
 * Create a disposable test budget, returning its id and group id.
 */
export async function createTestBudget(
  name?: string,
): Promise<SeededBudget> {
  const budgetName = name ?? `BalanceFrame-Test-${Date.now()}`;
  const result = await createBudget({
    name: budgetName,
    avoidUpload: false,
  });

  return {
    budgetId: result.id,
    groupId: result.groupId,
    budgetName,
  };
}

/**
 * Delete a budget and clean up its data directory.
 */
export async function cleanupBudget(
  budgetId: string,
  groupId: string,
  dataDir?: string,
): Promise<void> {
  try {
    await deleteBudget(groupId, budgetId);
  } catch {
    // Budget may already be gone; ignore.
  }

  if (dataDir && existsSync(dataDir)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Wrapper that creates a disposable budget, runs `fn`, and cleans up.
 */
export async function withTestBudget<T>(
  fn: (..._args: [SeededBudget]) => Promise<T>,
  name?: string,
): Promise<T> {
  const budget = await createTestBudget(name);
  try {
    return await fn(budget);
  } finally {
    await cleanupBudget(budget.budgetId, budget.groupId).catch(() => {});
  }
}

// ---- Fixture Data ---------------------------------------------------------

/**
 * Locate the fixture data JSON file.
 * Searches relative to the test directory and the monorepo root.
 */
function findFixtureFile(): string {
  const candidates = [
    // Relative to tests/actual-integration/
    '../../protocol/fixtures/representative.json',
    './representative.json',
    // Absolute fallback from env
    process.env.FIXTURE_DATA_PATH ?? '',
  ];

  for (const p of candidates) {
    if (!p) continue;
    try {
      // Resolve relative to the test directory using the module URL
      const dirUrl = new URL('.', import.meta.url);
      const dirPath = fileURLToPath(dirUrl);
      const resolved = join(dirPath, p);
      if (existsSync(resolved)) return resolved;
    } catch {
      // resolve failure — try next
    }
  }

  throw new Error(
    'Fixture data file not found. Run setup-fixture-server.sh first, '
    + 'or set FIXTURE_DATA_PATH environment variable.',
  );
}

/**
 * Read and parse the representative fixture data.
 */
export function loadFixtureData(): Record<string, unknown> {
  const filePath = findFixtureFile();
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Seed a budget with representative fixture data.
 *
 * Creates category groups, categories, accounts, payees, transactions,
 * rules, and schedules as defined in the fixture JSON.
 * Adapts the canonical protocol snapshot shape (camelCase fields, Money objects,
 * flat categories with groupName, ID-based references) to Actual API calls.
 *
 * @param fixture — Optional fixture data; loaded from disk if omitted.
 */
export async function seedFixtureData(
  fixture?: Record<string, unknown>,
): Promise<void> {
  const data = fixture ?? loadFixtureData();

  // ---- Extract canonical fixture entities ----
  const fixtureAccounts = (data.accounts ?? []) as Array<{
    id: string; name: string; accountType: string;
    offBudget?: boolean; isClosed?: boolean;
    mtid?: string | null;
  }>;
  const fixtureCategories = (data.categories ?? []) as Array<{
    id: string; name: string; groupName: string;
    isIncome?: boolean; deleted?: boolean;
    mtid?: string | null;
  }>;
  const fixturePayees = (data.payees ?? []) as Array<{
    id: string; name: string;
    transferAccountId?: string | null;
    mtid?: string | null;
  }>;

  // Map fixture ID → display name (used to resolve references after Actual assigns new IDs)
  const acctNameByFixId: Record<string, string> = {};
  for (const a of fixtureAccounts) acctNameByFixId[a.id] = a.name;
  const payeeNameByFixId: Record<string, string> = {};
  for (const p of fixturePayees) payeeNameByFixId[p.id] = p.name;
  const catNameByFixId: Record<string, string> = {};
  for (const c of fixtureCategories) catNameByFixId[c.id] = c.name;

  // ---- Category Groups & Categories (flat → grouped) ----
  const groupByName: Record<string, string> = {};
  const groupsSeen = new Set<string>();
  for (const cat of fixtureCategories) {
    if (cat.deleted) continue;
    if (!groupsSeen.has(cat.groupName)) {
      groupsSeen.add(cat.groupName);
      const groupId = await createCategoryGroup({ name: cat.groupName });
      if (!groupId) {
        throw new Error(`Actual did not create category group "${cat.groupName}"`);
      }
      groupByName[cat.groupName] = groupId;
    }
    await createCategory({
      name: cat.name,
      groupId: groupByName[cat.groupName],
      isIncome: cat.isIncome ?? false,
      hidden: false,
    });
  }

  // ---- Accounts (adapt accountType/offBudget/isClosed) ----
  function mapAccountType(t: string): 'checking' | 'savings' | 'credit' | 'other' {
    switch (t) {
      case 'checking': return 'checking';
      case 'savings': return 'savings';
      case 'creditCard': return 'credit';
      default: return 'other';
    }
  }
  for (const acct of fixtureAccounts) {
    await createAccount({
      name: acct.name,
      type: mapAccountType(acct.accountType),
      offbudget: acct.offBudget ?? false,
      closed: acct.isClosed ?? false,
    });
  }

  // ---- Payees (resolve transferAccountId fixture refs) ----
  const allAccounts = await getAccounts();
  const acctIdByFixId: Record<string, string> = {};
  for (const a of allAccounts) {
    const aObj = a as { name?: string; id?: string };
    if (aObj.name && aObj.id) {
      // Find the fixture account with this name to build fixture-id → actual-id map
      for (const fa of fixtureAccounts) {
        if (fa.name === aObj.name) {
          acctIdByFixId[fa.id] = aObj.id;
          break;
        }
      }
    }
  }

  for (const payee of fixturePayees) {
    let transferAcct: string | null = null;
    if (payee.transferAccountId) {
      transferAcct = acctIdByFixId[payee.transferAccountId] ?? null;
    }
    await createPayee({
      name: payee.name,
      transferAcct,
    });
  }

  // ---- Transactions (resolve ID references via name, parse Money amounts) ----
  const allPayees = await getPayees();
  const allCategories = await getCategories();

  const payeeIdByName: Record<string, string> = {};
  for (const p of allPayees) {
    const pObj = p as { name?: string; id?: string };
    if (pObj.name && pObj.id) payeeIdByName[pObj.name] = pObj.id;
  }
  const catIdByName: Record<string, string> = {};
  for (const c of allCategories) {
    const cObj = c as { name?: string; id?: string };
    if (cObj.name && cObj.id) catIdByName[cObj.name] = cObj.id;
  }

  const transactions = (data.transactions ?? []) as Array<{
    accountId: string;
    date: string;
    payeeId: string | null;
    payeeName: string | null;
    categoryId: string | null;
    categoryName: string | null;
    amount: { minorUnits: string; currency: string } | null;
    cleared?: boolean;
    notes?: string | null;
    reconciled?: boolean;
    importedId?: string | null;
    importedPayee?: string | null;
    transferAccountId?: string | null;
    subtransactions?: unknown[];
  }>;

  for (const txn of transactions) {
    const acctId = acctIdByFixId[txn.accountId];
    if (!acctId) continue;

    // Resolve payee by payeeName (or payeeId → fixture name → actual ID)
    const payeeNameStr = txn.payeeName ?? (txn.payeeId ? payeeNameByFixId[txn.payeeId] : null);
    const payee = payeeNameStr ? (payeeIdByName[payeeNameStr] ?? null) : null;

    // Resolve category by categoryName (or categoryId → fixture name → actual ID)
    const catNameStr = txn.categoryName ?? (txn.categoryId ? catNameByFixId[txn.categoryId] : null);
    const cat = catNameStr ? (catIdByName[catNameStr] ?? null) : null;

    // Parse Money amount: minorUnits is a string integer in the canonical shape
    let amount = 0;
    if (txn.amount != null && txn.amount.minorUnits != null) {
      amount = parseInt(txn.amount.minorUnits, 10);
      if (Number.isNaN(amount)) amount = 0;
    }

    await addTransactions(acctId, [{
      date: txn.date,
      amount,
      payee,
      category: cat,
      notes: txn.notes ?? '',
      cleared: txn.cleared ?? true,
    }]);
  }

  // ---- Rules ----
  interface RuleData {
    stage: string | null;
    conditionsOp: string;
    conditions: unknown[];
    actions: unknown[];
  }
  const rules = (data.rules ?? []) as Array<Record<string, unknown>>;
  for (const rule of rules) {
    await createRule({
      stage: (rule as RuleData).stage ?? null,
      conditionsOp: (rule as RuleData).conditionsOp ?? 'and',
      conditions: (rule as RuleData).conditions ?? [],
      actions: (rule as RuleData).actions ?? [],
    });
  }

  // ---- Schedules ----
  interface ScheduleData {
    name: string;
    type: string;
    amount: number;
    startDate: string;
    frequency: string;
    payee: string;
  }
  const schedules = (data.schedules ?? []) as Array<Record<string, unknown>>;
  for (const sched of schedules) {
    await createSchedule({
      name: (sched as ScheduleData).name,
      type: (sched as ScheduleData).type ?? 'bill',
      amount: (sched as ScheduleData).amount ?? 0,
      startDate: (sched as ScheduleData).startDate,
      frequency: (sched as ScheduleData).frequency ?? 'monthly',
      payee: payeeIdByName[(sched as ScheduleData).payee] ?? (sched as ScheduleData).payee,
    });
  }

  // Sync so data persists on the server.
  await actualSync();
}

// ---- Sync Helpers ---------------------------------------------------------

/**
 * Download a budget (encrypted or unencrypted).
 */
export async function downloadBudgetWithOpts(
  groupId: string,
  budgetId: string,
  options?: { password?: string },
): Promise<void> {
  await downloadBudget(groupId, budgetId, options);
}

/**
 * Sync with the server.
 */
export async function syncWithServer(): Promise<void> {
  await actualSync();
}

// ---- Assertion Helpers ----------------------------------------------------

/**
 * Assert that an API call rejects with an error matching a predicate.
 */
export async function expectRejection(
  fn: () => Promise<unknown>,
  predicate?: (..._args: [Error]) => boolean | void,
): Promise<void> {
  let thrown = false;
  try {
    await fn();
  } catch (err: unknown) {
    thrown = true;
    if (predicate) {
      const errObj = err as Error;
      const result = predicate(errObj);
      // If predicate returns false explicitly, fail.
      if (result === false) {
        throw new Error(
          `Expected rejection matching predicate, but got: ${errObj.message}`,
        );
      }
    }
  }
  if (!thrown) {
    throw new Error('Expected function to reject, but it resolved successfully.');
  }
}
