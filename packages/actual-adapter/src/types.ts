/**
 * Core types for the BalanceFrame Actual Budget gateway.
 *
 * Defines the BudgetLedger contract, capability/health/compatibility reporting,
 * credential interfaces, cache/watermark state, and Observe-only mode enforcement.
 *
 * All stable JSON contracts use camelCase to match the protocol schema.
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
} from '@balanceframe/protocol-generated';
export type { Money } from '@balanceframe/protocol-generated';

// ---------------------------------------------------------------------------
// Connection mode
// ---------------------------------------------------------------------------

/**
 * The access mode governing what BalanceFrame may do with a connected Actual budget.
 * - **Observe** (default): read-only; never modifies Actual.
 * - **ReviewAndApply** (Phase 4): explicit approved writes only.
 * - **ManagedAutomation** (post-MVP): configured low-risk deterministic actions.
 * - **DisposableSandbox**: isolated budget for safe mutation testing.
 */
export type ConnectionMode = 'observe' | 'reviewAndApply' | 'managedAutomation' | 'disposableSandbox';

/** Default mode for Phase 1 — no writes permitted. */
export const DEFAULT_MODE: ConnectionMode = 'observe';

// ---------------------------------------------------------------------------
// Ledger ID (stable Actual backend reference)
// ---------------------------------------------------------------------------

export type LedgerId = string;

// ---------------------------------------------------------------------------
// Capability report
// ---------------------------------------------------------------------------

export interface LedgerCapabilities {
  /** Whether read operations are available (always true for a connected ledger). */
  canRead: boolean;
  /** Whether write operations are permitted in the current mode. */
  canWrite: boolean;
  /** Whether bank-sync can be triggered. */
  canRunBankSync: boolean;
  /** Whether the ledger supports export. */
  canExport: boolean;
  /** Whether the ledger supports the full set of query capabilities. */
  canQuery: boolean;
  /** The connection mode this ledger is operating in. */
  mode: ConnectionMode;
  /** Human-readable summary of what this mode permits. */
  modeDescription: string;
}

// ---------------------------------------------------------------------------
// Compatibility & health
// ---------------------------------------------------------------------------

export interface VersionRange {
  min: string;
  max: string;
}

export interface CompatibilityResult {
  /** Whether the server version is within the supported range. */
  supported: boolean;
  /** The server version string reported by Actual. */
  serverVersion: string;
  /** The maximum version this adapter supports. */
  supportedVersion: string;
  /** Specific blockers if not fully compatible. */
  blockers: string[];
}

export type HealthState = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

export interface Freshness {
  /** ISO timestamp of the last successful download/sync. */
  lastDownloadedAt: string | null;
  /** ISO timestamp of the last bank sync, if available. */
  lastBankSyncedAt: string | null;
  /** Whether pending (uncleared) transactions are included in the snapshot. */
  pendingTransactionsIncluded: boolean;
}

export interface Coverage {
  /** Total number of accounts on the server. */
  totalAccounts: number;
  /** Number of accounts included in the snapshot. */
  includedAccounts: number;
  /** Whether all expected accounts are present. */
  allExpectedAccountsPresent: boolean;
}

export interface Incident {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  details?: string;
}

export interface HealthReport {
  state: HealthState;
  compatibility: CompatibilityResult;
  freshness: Freshness;
  coverage: Coverage;
  incidents: Incident[];
}

// ---------------------------------------------------------------------------
// Watermark / cursor for overlap-safe reprocessing
// ---------------------------------------------------------------------------

export interface SyncWatermark {
  /** The budget ID this watermark belongs to. */
  budgetId: string;
  /** ISO timestamp cursor for transaction sync (last synced transaction date). */
  lastTransactionDate: string | null;
  /** Transaction count at last sync, used for overlap detection. */
  lastTransactionCount: number;
  /** ISO timestamp of the last successful sync completion. */
  lastSyncCompletedAt: string | null;
  /** Number of overlap days to re-process for safety. */
  overlapDays: number;
}

/** Default overlap window (in days) to reprocess for consistency. */
export const DEFAULT_OVERLAP_DAYS = 3;

// ---------------------------------------------------------------------------
// Watermark store (persistent cursor state)
// ---------------------------------------------------------------------------

/**
 * Persistence contract for sync watermark state.
 * Implementations may use file storage, KV, or in-memory caches.
 */
export interface WatermarkStore {
  /** Load persisted watermark for a budget. Returns null if none exists. */
  load(budgetId: string): Promise<SyncWatermark | null>;
  /** Persist watermark for a budget. */
  save(budgetId: string, watermark: SyncWatermark): Promise<void>;
  /** Remove persisted watermark for a budget. */
  clear(budgetId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cache state
// ---------------------------------------------------------------------------

export interface CacheState {
  /** Budget ID this cache belongs to. */
  budgetId: string;
  /** Path to the isolated cache directory. */
  cacheDir: string;
  /** Whether the cache has been initialized (budget downloaded). */
  initialized: boolean;
  /** Timestamp of the last cache access. */
  lastAccessedAt: string | null;
  /** Serialized mutation lock — only one mutation at a time per cache. */
  mutationLocked: boolean;
  /** Sync watermark for overlap-safe reprocessing. */
  watermark: SyncWatermark;
}

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface AccountQuery {
  includeClosed?: boolean;
  includeOffBudget?: boolean;
}

export interface TransactionQuery {
  accountId?: LedgerId;
  startDate?: string;
  endDate?: string;
  includePending?: boolean;
  includeReconciled?: boolean;
}

// ---------------------------------------------------------------------------
// Mutation types (for future phases; rejected in Observe mode)
// ---------------------------------------------------------------------------

export interface ImportTransaction {
  date: string;
  amount: number;
  payeeName?: string;
  categoryName?: string;
  notes?: string;
  cleared?: boolean;
  importedId?: string;
  importedPayee?: string;
}

export interface ImportOptions {
  learnCategories?: boolean;
  runTransfers?: boolean;
}

export interface ImportResult {
  success: boolean;
  errors: string[];
  importedCount: number;
}

export interface TransactionPatch {
  categoryId?: LedgerId;
  payeeId?: LedgerId | null;
  notes?: string | null;
  cleared?: boolean;
  amount?: number;
}

export interface MutationPrecondition {
  /** Expected last-modified timestamp or version token. */
  expectedVersion?: string;
  /** Whether the mutation requires a backup first. */
  requireBackup?: boolean;
}

export type MutationResult =
  | { success: true; id: LedgerId }
  | { success: false; error: string; code: string };

/**
 * Result of a setTransactionCategory call.
 * Includes verification of the post-write state and idempotency tracking.
 */
export type SetCategoryResult = SetCategorySuccess | SetCategoryFailure;

export interface SetCategorySuccess {
  success: true;
  transactionId: LedgerId;
  previousCategoryId: LedgerId | null;
  newCategoryId: LedgerId;
  idempotencyKey: string;
  /** Post-write re-read confirmed the change. */
  verified: true;
}

export interface SetCategoryFailure {
  success: false;
  error: string;
  code: SetCategoryErrorCode;
  /** Present when the transaction was identified before the error. */
  transactionId?: LedgerId;
  /** Present when the previous category was determined. */
  previousCategoryId?: LedgerId | null;
  /** Present when a category was proposed. */
  newCategoryId?: LedgerId;
  /** Present when the write was attempted but verification failed. */
  idempotencyKey?: string;
  /** Always false or absent on failure. */
  verified?: false;
}

export type SetCategoryErrorCode =
  | 'VERIFICATION_FAILED'
  | 'BUDGET_NOT_SELECTED'
  | 'CATEGORY_NOT_FOUND'
  | 'CATEGORY_DELETED'
  | 'TRANSACTION_NOT_FOUND'
  | 'PRECONDITION_MISMATCH';

// ---------------------------------------------------------------------------
// Rule proposal (for future mutation phases)
// ---------------------------------------------------------------------------

export interface AutomationRule {
  id: LedgerId;
  name: string;
  /** Order of evaluation (lower runs first). */
  order: number;
  trigger: unknown;
  actions: unknown;
  inactive: boolean;
}

export interface RuleProposal {
  name: string;
  conditions: unknown[];
  actions: unknown[];
}

// ---------------------------------------------------------------------------
// Budget discovery
// ---------------------------------------------------------------------------

export interface BudgetInfo {
  id: string;
  groupId: string;
  name: string;
  encrypted: boolean;
}

export interface BudgetIdentity {
  id: string;
  groupId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// BudgetLedger interface (the capability-aware internal port)
// ---------------------------------------------------------------------------

/**
 * Capability-aware internal interface for backend budget access.
 *
 * Normalizes backend objects into stable project types.
 * Stable Actual IDs are retained as backend references.
 * Category names are display values, never canonical policy keys.
 */
export interface BudgetLedger {
  /** Report what this connection can do. */
  capabilities(): Promise<LedgerCapabilities>;

  /** Full synchronize: download + sync + normalize into a snapshot. */
  synchronize(): Promise<LedgerSnapshotResult>;

  // ---- Read operations (available in all modes) ----

  listAccounts(query?: AccountQuery): Promise<Account[]>;
  listTransactions(query?: TransactionQuery): Promise<Transaction[]>;
  listCategories(): Promise<Category[]>;
  listPayees(): Promise<Payee[]>;
  listRules(): Promise<AutomationRule[]>;
  listSchedules(): Promise<Schedule[]>;

  // ---- Mutation stubs (rejected in Observe mode) ----

  importTransactions(
    accountId: LedgerId,
    transactions: ImportTransaction[],
    options?: ImportOptions,
  ): Promise<ImportResult>;

  updateTransaction(
    transactionId: LedgerId,
    patch: TransactionPatch,
    precondition?: MutationPrecondition,
  ): Promise<MutationResult>;

  createRule(
    proposal: RuleProposal,
    precondition?: MutationPrecondition,
  ): Promise<MutationResult>;

  setBudgetAmount(
    month: string,
    categoryId: LedgerId,
    amount: number,
    precondition?: MutationPrecondition,
  ): Promise<MutationResult>;

  setTransactionCategory(
    transactionId: LedgerId,
    proposedCategoryId: LedgerId,
    currentCategoryId: LedgerId | null,
  ): Promise<SetCategoryResult>;

  // ---- Lifecycle ----

  /** Disconnect: remove application cache and credentials without changing Actual. */
  disconnect(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Normalized snapshot result
// ---------------------------------------------------------------------------

export interface LedgerSnapshotResult {
  snapshot: {
    schemaVersion: string;
    actualVersion: string;
    snapshotDate: string;
    /** ISO timestamp when the budget data was actually downloaded from the server. */
    actualDownloadedAt: string | null;
    /** ISO timestamp of the last bank-sync operation on the server, or null if unavailable. */
    bankSyncedAt: string | null;
    /** Whether the budget file is encrypted on the Actual server. */
    encrypted: boolean;
    /** Whether the budget was successfully decrypted/unlocked. True if the budget loaded without auth errors. */
    unlocked: boolean;
    accounts: Account[];
    transactions: Transaction[];
    categories: Category[];
    payees: Payee[];
    rules: Rule[];
    schedules: Schedule[];
    budgets: BudgetMonth[];
    tags: { id: string; name: string }[];
  };
  health: HealthReport;
  watermark: SyncWatermark;
}

// ---------------------------------------------------------------------------
// Broad-access caveat
// ---------------------------------------------------------------------------

/**
 * The BalanceFrame connector has broad read access to the Actual budget
 * including bank-sync credentials (which are not E2E encrypted by Actual).
 * Project-side data filtering does not reduce this access.
 * Users should ensure their Actual server and backups have appropriate security.
 */
export const BROAD_ACCESS_CAVEAT =
  'The BalanceFrame connector accesses all budget data including bank-sync credentials ' +
  'stored on the Actual server (which are not protected by Actual E2E encryption). ' +
  'Project-side filtering does not reduce the broad access held by the connector. ' +
  'Ensure your Actual server and backups have appropriate security.';
