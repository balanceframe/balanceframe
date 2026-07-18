// Generated TypeScript declarations for the Rust-owned BalanceFrame protocol.
// The JSON wire format is camelCase, matching Rust's serde(rename_all = "camelCase").

export interface Money {
  minorUnits: string;
  currency: string;
}

export type AccountType =
  | "checking"
  | "savings"
  | "creditCard"
  | "cash"
  | "investment"
  | "mortgage"
  | "loan"
  | "other";

export interface Account {
  id: string;
  name: string;
  accountType: AccountType;
  offBudget: boolean;
  isClosed: boolean;
  clearedBalance: Money;
  importedBalance: Money;
  mtid: string | null;
}

export interface Transaction {
  id: string;
  accountId: string;
  date: string;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  amount: Money;
  cleared: boolean;
  reconciled: boolean;
  importedId: string | null;
  importedPayee: string | null;
  notes: string | null;
  tags: string[];
  transferAccountId: string | null;
  subtransactions: Transaction[];
}

export interface Category {
  id: string;
  name: string;
  groupName: string | null;
  isIncome: boolean;
  mtid: string | null;
  deleted: boolean;
}

export interface Payee {
  id: string;
  name: string;
  transferAccountId: string | null;
  mtid: string | null;
}

export interface Rule {
  id: string;
  name: string;
  order: number;
  trigger: unknown;
  actions: unknown;
  inactive: boolean;
}

export interface Schedule {
  id: string;
  frequency: string;
  amount: Money;
  payeeName: string | null;
  accountId: string;
  nextExpected: string;
}

export interface BudgetCategory {
  categoryId: string;
  amount: Money;
  carryover: Money;
  carryoverFromPrevious: Money;
  carriesOver: boolean;
}

export interface BudgetMonth {
  id: string;
  month: string;
  categories: Record<string, BudgetCategory>;
}

export interface Tag {
  id: string;
  name: string;
}

export interface ProtocolSnapshot {
  schemaVersion: string;
  actualVersion: string;
  snapshotDate: string;
  accounts: Account[];
  transactions: Transaction[];
  categories: Category[];
  payees: Payee[];
  rules: Rule[];
  schedules: Schedule[];
  budgets: BudgetMonth[];
  tags: Tag[];
}
