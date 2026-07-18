/**
 * Normalization: maps Actual Budget API entities into the canonical
 * protocol snapshot shape (camelCase, typed Money values).
 *
 * All stable Actual IDs are retained as backend references.
 */

import type {
  Account,
  Transaction,
  Category,
  Payee,
  Rule,
  Schedule,
  BudgetMonth,
  Money,
  BudgetCategory,
  Tag,
} from '@balanceframe/protocol-generated';
import type {
  APIAccountEntity,
  APICategoryEntity,
  APICategoryGroupEntity,
  APIPayeeEntity,
  APIScheduleEntity,
  APITagEntity,
  APIFileEntity,
} from '@actual-app/api/models';
import type { TransactionEntity, RuleEntity } from '@actual-app/core/types/models';

// ---------------------------------------------------------------------------
// Money conversion
// ---------------------------------------------------------------------------

/** Actual stores monetary values as integer cents. */
export function integerToMoney(value: number, currency = 'USD'): Money {
  return { minorUnits: String(value), currency };
}

// ---------------------------------------------------------------------------
// Account normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an Actual account to a protocol Account.
 *
 * Maps: offbudget→offBudget, closed→isClosed, balance_current→clearedBalance.
 * importedBalance defaults to clearedBalance when not provided (Actual doesn't
 * expose imported balance through the getAccounts API).
 */
export function normalizeAccount(account: APIAccountEntity, currency = 'USD'): Account {
  return {
    id: account.id,
    name: account.name,
    accountType: deriveAccountType(account),
    offBudget: account.offbudget ?? false,
    isClosed: account.closed ?? false,
    clearedBalance: integerToMoney(account.balance_current ?? 0, currency),
    importedBalance: integerToMoney(account.balance_current ?? 0, currency),
    mtid: null,
  };
}

/**
 * Best-effort account type derivation from the API entity.
 * Actual's API doesn't expose account type directly through getAccounts;
 * we default to "checking" and expect callers to enrich from other sources.
 */
function deriveAccountType(account: APIAccountEntity): Account['accountType'] {
  // The name may contain hints, but we keep it conservative.
  // Integrations with full schema data can override this.
  return 'checking';
}

export function normalizeAccounts(accounts: APIAccountEntity[], currency = 'USD'): Account[] {
  return accounts.map(a => normalizeAccount(a, currency));
}

// ---------------------------------------------------------------------------
// Transaction normalization
// ---------------------------------------------------------------------------

export function normalizeTransaction(
  txn: TransactionEntity,
  payeeMap: Record<string, string>,
  categoryMap: Record<string, { name: string; groupName: string | null }>,
  currency = 'USD',
): Transaction {
  const payeeId = txn.payee ?? null;
  const payeeName = payeeId ? (payeeMap[payeeId] ?? null) : null;
  const categoryId = txn.category ?? null;
  const category = categoryId ? categoryMap[categoryId] : null;

  return {
    id: txn.id,
    accountId: txn.account,
    date: txn.date,
    payeeId,
    payeeName,
    categoryId,
    categoryName: category?.name ?? null,
    amount: integerToMoney(txn.amount ?? 0, currency),
    cleared: txn.cleared ?? false,
    reconciled: txn.reconciled ?? false,
    importedId: txn.imported_id ?? null,
    importedPayee: txn.imported_payee ?? null,
    notes: txn.notes ?? null,
    tags: [],
    transferAccountId: txn.transfer_id ?? null,
    subtransactions: [],
  };
}

export function normalizeTransactions(
  transactions: TransactionEntity[],
  payeeMap: Record<string, string>,
  categoryMap: Record<string, { name: string; groupName: string | null }>,
  currency = 'USD',
): Transaction[] {
  return transactions
    .filter(txn => !txn.is_child && !txn.tombstone)
    .map(txn => normalizeTransaction(txn, payeeMap, categoryMap, currency));
}

// ---------------------------------------------------------------------------
// Category normalization
// ---------------------------------------------------------------------------

export function normalizeCategory(
  cat: APICategoryEntity,
  groupsByName: Record<string, string>,
): Category {
  const groupName = cat.group_id ? (groupsByName[cat.group_id] ?? null) : null;
  return {
    id: cat.id,
    name: cat.name,
    groupName,
    isIncome: cat.is_income ?? false,
    mtid: null,
    deleted: cat.hidden ?? false,
  };
}

export function normalizeCategories(
  categories: APICategoryEntity[],
  groups: APICategoryGroupEntity[],
): Category[] {
  const groupsById: Record<string, string> = {};
  for (const g of groups) {
    groupsById[g.id] = g.name;
  }
  return categories.map(cat => normalizeCategory(cat, groupsById));
}

// ---------------------------------------------------------------------------
// Payee normalization
// ---------------------------------------------------------------------------

export function normalizePayee(payee: APIPayeeEntity): Payee {
  return {
    id: payee.id,
    name: payee.name,
    transferAccountId: payee.transfer_acct ?? null,
    mtid: null,
  };
}

export function normalizePayees(payees: APIPayeeEntity[]): Payee[] {
  return payees.map(normalizePayee);
}

// ---------------------------------------------------------------------------
// Rule normalization
// ---------------------------------------------------------------------------

export function normalizeRule(rule: RuleEntity): Rule {
  return {
    id: rule.id,
    name: '',
    order: 0,
    trigger: rule.conditions,
    actions: rule.actions,
    inactive: rule.tombstone ?? false,
  };
}

export function normalizeRules(rules: RuleEntity[]): Rule[] {
  return rules.filter(r => !r.tombstone).map(normalizeRule);
}

// ---------------------------------------------------------------------------
// Schedule normalization
// ---------------------------------------------------------------------------

export function normalizeSchedule(schedule: APIScheduleEntity, currency = 'USD'): Schedule {
  return {
    id: schedule.id,
    frequency: String(schedule.date ?? ''),
    amount: integerToMoney(
      typeof schedule.amount === 'number' ? schedule.amount : 0,
      currency,
    ),
    payeeName: schedule.payee ?? null,
    accountId: schedule.account ?? '',
    nextExpected: schedule.next_date ?? '',
  };
}

export function normalizeSchedules(schedules: APIScheduleEntity[], currency = 'USD'): Schedule[] {
  return schedules
    .filter(s => !s.completed)
    .map(s => normalizeSchedule(s, currency));
}

// ---------------------------------------------------------------------------
// Budget month normalization
// ---------------------------------------------------------------------------

export function normalizeBudgetCategory(
  categoryId: string,
  amount: number,
  carryover = 0,
  currency = 'USD',
): BudgetCategory {
  return {
    categoryId,
    amount: integerToMoney(amount, currency),
    carryover: integerToMoney(carryover, currency),
    carryoverFromPrevious: integerToMoney(0, currency),
    carriesOver: false,
  };
}

export function normalizeBudgetMonth(
  month: string,
  categoryBudgets: Record<string, number>,
  currency = 'USD',
): BudgetMonth {
  const categories: Record<string, BudgetCategory> = {};
  for (const [catId, amount] of Object.entries(categoryBudgets)) {
    categories[catId] = normalizeBudgetCategory(catId, amount, 0, currency);
  }
  return {
    id: `budget_${month}`,
    month,
    categories,
  };
}

// ---------------------------------------------------------------------------
// Tag normalization
// ---------------------------------------------------------------------------

export function normalizeTag(tag: APITagEntity): Tag {
  return { id: tag.id, name: tag.tag };
}

// ---------------------------------------------------------------------------
// Build payee / category lookup maps from normalized arrays
// ---------------------------------------------------------------------------

export function buildPayeeNameMap(payees: Payee[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of payees) map[p.id] = p.name;
  return map;
}

export function buildCategoryInfoMap(
  categories: Category[],
): Record<string, { name: string; groupName: string | null }> {
  const map: Record<string, { name: string; groupName: string | null }> = {};
  for (const c of categories) map[c.id] = { name: c.name, groupName: c.groupName };
  return map;
}
