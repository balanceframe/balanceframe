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

// ---------------------------------------------------------------------------
// Suggestion / Provenance — inference output from Rust (camelCase)
// ---------------------------------------------------------------------------

export interface Provenance {
  /** Hash of the suggestion payload for integrity verification. */
  payloadHash: string;
  /** Inference provider identifier (e.g. "openai", "local"). */
  provider?: string | null;
  /** Model identifier used for inference. */
  model?: string | null;
  /** Version of the prompt template used. */
  promptVersion?: string | null;
  /** Version of the inference policy document at time of creation. */
  inferencePolicyVersion?: string | null;
  /** ISO-8601 timestamp of suggestion creation. */
  createdAt: string;
  /** Identifier of the originating actor (user or system). */
  actorId?: string | null;
}

export interface HistoryRecord {
  transactionId: string;
  payeeName: string;
  categoryId: string;
  categoryName: string;
  amount: Money;
  date: string;
}

export interface Suggestion {
  /** Stable transaction identifier within the Actual budget. */
  transactionId: string;
  /** Proposed category identifier (empty string = uncategorize/remove). */
  proposedCategoryId: string;
  /** Human-readable name of the proposed category. */
  categoryName: string;
  /** Model confidence score (metadata only, never authorization). */
  confidence: number;
  /** Machine-readable reason codes for this suggestion. */
  reasonCodes: string[];
  /** Evidence strings supporting the suggestion. */
  evidence: string[];

  // ---- Phase 2: Suggestion-only classifier fields (all optional) ----

  /** Stable space identifier for multi-space deployments. */
  spaceId?: string | null;
  /** Connection identifier for the data source. */
  connectionId?: string | null;
  /** Budget identifier for the current budget cycle. */
  budgetId?: string | null;
  /** Version identifier for the transaction, used for staleness detection. */
  transactionVersion?: string | null;
  /** Raw merchant name as recorded in the transaction. */
  rawMerchant?: string | null;
  /** Normalized merchant name for cross-reference matching. */
  normalizedMerchant?: string | null;
  /** Optional research summary from merchant research provider. */
  researchSummary?: string | null;
  /** Alternative category identifiers that were considered. */
  alternativeCategoryIds?: string[];
  /** Free-text rationale for the suggestion. */
  rationale?: string | null;
  /** Inference provider identifier (e.g. "openai", "local"). */
  provider?: string | null;
  /** Model identifier used for this suggestion. */
  model?: string | null;
  /** Version of the prompt template used. */
  promptVersion?: string | null;
  /** Version of the inference policy at time of suggestion. */
  inferencePolicyVersion?: string | null;
  /** ISO-8601 timestamp of suggestion creation. */
  createdAt?: string | null;
  /** Originating actor identifier (user or system). */
  actorId?: string | null;
  /** Hash of the suggestion payload for integrity verification. */
  payloadHash?: string | null;
  /** Provenance metadata (provider, model, version chain). */
  provenance?: Provenance | null;
  /** Historical categorization records considered. */
  history?: HistoryRecord[];
}
