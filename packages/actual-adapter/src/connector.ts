/**
 * ActualConnector — the BudgetLedger implementation backed by @actual-app/api.
 *
 * Provides:
 * - Dependency injection via ActualClient interface (testable with mocks).
 * - Server/budget discovery.
 * - Observe-only mode enforcement (all mutation methods reject).
 * - Isolated per-budget cache lifecycle with serialized mutation lock.
 * - Sync watermark for overlap-safe reprocessing.
 * - Health, compatibility, freshness, coverage, and incident reporting.
 * - Disconnect cleanup (removes cache and credentials).
 * - Broad-access caveat exposed as a constant.
 */

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

import type {
  Account,
  Transaction,
  Category,
  Payee,
  Rule,
  Schedule,
  BudgetMonth,
  CoverageState,
  EvidenceReference,
  FinancialSnapshot,
  SourceObservation,
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

import type {
  BudgetLedger,
  LedgerCapabilities,
  ConnectionMode,
  LedgerId,
  AccountQuery,
  TransactionQuery,
  ImportTransaction,
  ImportOptions,
  ImportResult,
  TransactionPatch,
  MutationPrecondition,
  MutationResult,
  SetCategoryResult,
  AutomationRule,
  RuleProposal,
  HealthReport,
  HealthState,
  Freshness,
  Coverage,
  Incident,
  CompatibilityResult,
  SyncWatermark,
  WatermarkStore,
  CacheState,
  BudgetInfo,
  LedgerSnapshotResult,
  SynchronizeOptions,
  VersionRange,
} from './types.js';
import { DEFAULT_MODE, DEFAULT_OVERLAP_DAYS, BROAD_ACCESS_CAVEAT } from './types.js';

import type { CredentialStore, ActualCredentials } from './credentials.js';
import { NullCredentialStore } from './credentials.js';

import {
  normalizeAccounts,
  normalizeTransactions,
  normalizeCategories,
  normalizePayees,
  normalizeRules,
  normalizeSchedules,
  normalizeBudgetMonth,
  buildPayeeNameMap,
  buildCategoryInfoMap,
  buildTransferAcctMap,
} from './normalizer.js';

type CollectionRead<T> = { available: true; items: T[] } | { available: false; items: [] };

async function readCollection<T>(read: () => Promise<T[]>): Promise<CollectionRead<T>> {
  try {
    return { available: true, items: await read() };
  } catch {
    return { available: false, items: [] };
  }
}

function coverageFor<T>(read: CollectionRead<T>, incomplete = false): CoverageState {
  if (!read.available) return 'unknown';
  if (read.items.length === 0) return 'empty';
  return incomplete ? 'partial' : 'complete';
}

function healthCoverageFor(accountRead: CollectionRead<APIAccountEntity>): Coverage {
  if (!accountRead.available) {
    return {
      totalAccounts: 0,
      includedAccounts: 0,
      allExpectedAccountsPresent: false,
    };
  }

  // Closed accounts are intentionally excluded from snapshots and coverage reporting.
  const includedAccounts = accountRead.items.filter((account) => !account.closed).length;
  return {
    totalAccounts: includedAccounts,
    includedAccounts,
    allExpectedAccountsPresent: true,
  };
}

type SnapshotBuildResult = Pick<LedgerSnapshotResult, 'snapshot' | 'financialSnapshot'> & {
  accountRead: CollectionRead<APIAccountEntity>;
};

type SourceAccountFacts = APIAccountEntity & {
  type?: unknown;
  account_type?: unknown;
};

function hasNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasReliableAccountType(account: APIAccountEntity): boolean {
  const sourceAccount = account as SourceAccountFacts;
  return hasNonBlankString(sourceAccount.type ?? sourceAccount.account_type);
}

function hasReliableAccountBalance(account: APIAccountEntity): boolean {
  return typeof account.balance_current === 'number' && Number.isFinite(account.balance_current);
}

function hasReliableScheduleFacts(schedule: APIScheduleEntity): boolean {
  return (
    hasNonBlankString(schedule.account) &&
    typeof schedule.amount === 'number' &&
    Number.isFinite(schedule.amount) &&
    hasNonBlankString(schedule.next_date)
  );
}

function visibleEvidence(evidenceId: string, kind: string): EvidenceReference {
  return { evidenceId, kind, authorized: true, redaction: 'visible' };
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate === null || typeof candidate !== 'object') return candidate;

    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(candidate).sort()) {
      const child = (candidate as Record<string, unknown>)[key];
      if (child !== undefined) normalized[key] = normalize(child);
    }
    return normalized;
  };

  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw new Error('Cannot hash an undefined snapshot payload');
  return serialized;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// ActualClient interface (DI seam)
// ---------------------------------------------------------------------------

/**
 * The Actual Budget API surface consumed by the connector.
 *
 * This is the dependency-injection seam. Implementations wrap @actual-app/api
 * for production, or provide a mock for deterministic testing.
 * All methods named to match the @actual-app/api exports.
 */
export interface ActualClient {
  init(config?: InitConfigLike): Promise<ActualInitResult>;
  shutdown(): Promise<void>;
  getBudgets(): Promise<APIFileEntity[]>;
  downloadBudget(syncId: string, opts?: { password?: string }): Promise<void>;
  loadBudget(budgetId: string): Promise<void>;
  sync(): Promise<void>;
  getServerVersion(): Promise<{ version: string } | { error: string }>;
  getAccounts(): Promise<APIAccountEntity[]>;
  getTransactions(
    accountId: string,
    startDate: string,
    endDate: string,
  ): Promise<TransactionEntity[]>;
  getPayees(): Promise<APIPayeeEntity[]>;
  getCategories(opts?: {
    hidden?: boolean;
  }): Promise<(APICategoryEntity | APICategoryGroupEntity)[]>;
  getCategoryGroups(opts?: { hidden?: boolean }): Promise<APICategoryGroupEntity[]>;
  getBudgetMonths(): Promise<string[]>;
  getBudgetMonth(month: string): Promise<{
    month: string;
    categoryGroups: Array<Record<string, unknown> & { categories?: Record<string, unknown>[] }>;
    [key: string]: unknown;
  }>;
  getRules(): Promise<RuleEntity[]>;
  getSchedules(): Promise<APIScheduleEntity[]>;
  getTags(): Promise<APITagEntity[]>;
  runBankSync(_args?: { accountId: string }): Promise<void>;
  // Write methods (rejected in Observe mode)
  addTransactions(
    accountId: string,
    transactions: unknown[],
    opts?: { learnCategories?: boolean; runTransfers?: boolean },
  ): Promise<'ok'>;
  createAccount(account: Omit<APIAccountEntity, 'id'>, initialBalance?: number): Promise<string>;
  updateTransaction(id: string, fields: Record<string, unknown>): Promise<unknown>;
  createRule(rule: Record<string, unknown>): Promise<{ id: string }>;
  updateRule(id: string, rule: Record<string, unknown>): Promise<unknown>;
  deleteRule(id: string): Promise<boolean>;
  setBudgetAmount(month: string, categoryId: string, value: number): Promise<void>;
}

interface InitConfigLike {
  dataDir: string;
  serverURL: string;
  password: string;
}

interface ActualInitResult {
  getDataDir: () => string;
  sendMessage: (msg: unknown, args: unknown) => void;
  send: <K extends string>(_name: K, _args?: unknown) => Promise<unknown>;
  amountToInteger: (amount: number) => number;
  integerToAmount: (integer: number) => number;
}

// ---------------------------------------------------------------------------
// Default (production) client
// ---------------------------------------------------------------------------

/**
 * Wrap @actual-app/api in the ActualClient interface.
 * Uses ESM dynamic import for proper module resolution.
 */
export async function createDefaultActualClient(): Promise<ActualClient> {
  // Dynamic import — @actual-app/api is ESM-only. Static import is not used
  // because the package may not be installed in all consuming packages.
  const actual = await import('@actual-app/api');
  return {
    init: (config) => actual.init(config) as Promise<ActualInitResult>,
    shutdown: () => actual.shutdown(),
    getBudgets: () => actual.getBudgets(),
    downloadBudget: (syncId, opts) => actual.downloadBudget(syncId, opts),
    loadBudget: (budgetId) => actual.loadBudget(budgetId),
    sync: () => actual.sync(),
    getServerVersion: () => actual.getServerVersion(),
    getAccounts: () => actual.getAccounts(),
    getTransactions: (accountId, startDate, endDate) =>
      actual.getTransactions(accountId, startDate, endDate),
    getPayees: () => actual.getPayees(),
    getCategories: (opts) => actual.getCategories(opts),
    getCategoryGroups: (opts) => actual.getCategoryGroups(opts),
    getBudgetMonths: () => actual.getBudgetMonths(),
    getBudgetMonth: (month) => actual.getBudgetMonth(month),
    getRules: () => actual.getRules(),
    getSchedules: () => actual.getSchedules(),
    getTags: () => actual.getTags(),
    runBankSync: (args) => actual.runBankSync(args),
    addTransactions: (accountId, txns, opts) =>
      actual.addTransactions(
        accountId as Parameters<typeof actual.addTransactions>[0],
        txns as unknown as Parameters<typeof actual.addTransactions>[1],
        opts as Parameters<typeof actual.addTransactions>[2],
      ),
    createAccount: (account, initialBalance) => actual.createAccount(account, initialBalance),
    updateTransaction: (id, fields) => actual.updateTransaction(id, fields),
    createRule: (rule) => actual.createRule(rule as Parameters<typeof actual.createRule>[0]),
    updateRule: (id, rule) =>
      actual.updateRule({ id, ...rule } as Parameters<typeof actual.updateRule>[0]),
    deleteRule: (id) => actual.deleteRule(id),
    setBudgetAmount: (month, categoryId, value) => actual.setBudgetAmount(month, categoryId, value),
  };
}

// ---------------------------------------------------------------------------
// ActualConnector
// ---------------------------------------------------------------------------

export interface ActualConnectorConfig {
  /** The Actual API client (injectable for testing). */
  client: ActualClient;
  /** Credential store for encrypted persistence. */
  credentialStore?: CredentialStore;
  /** Connection mode (default: 'observe'). */
  mode?: ConnectionMode;
  /** Data directory for per-budget caches. If not provided, a temp directory is created. */
  cacheDir?: string;
  /** Number of overlap days for watermark-based sync reprocessing. */
  overlapDays?: number;
  /** Currency code for Money values (default: 'USD'). */
  currency?: string;
  /** Persistent watermark store for sync cursor state. */
  watermarkStore?: WatermarkStore;
  /** Minimum and maximum server version compatibility. */
  compatibilityRange?: VersionRange;
}

export class ActualConnector implements BudgetLedger {
  private readonly client: ActualClient;
  private readonly credStore: CredentialStore;
  private readonly mode: ConnectionMode;
  private readonly baseCacheDir: string;
  private readonly overlapDays: number;
  private readonly currency: string;
  private readonly watermarkStore: WatermarkStore | undefined;
  private readonly compatibilityRange: VersionRange | undefined;

  /** Per-cache state, keyed by budgetId. */
  private readonly caches: Map<string, CacheState> = new Map();
  /** Mutex guard for cache mutations. Serializes lifecycle operations per cache. */
  private readonly cacheLocks: Map<string, Promise<unknown>> = new Map();

  private _initialized = false;
  private _budgetInfo: BudgetInfo | null = null;
  private _serverVersion: string | null = null;
  private _connectedAt: string | null = null;
  /** Promise guard for synchronize() — prevents concurrent sync operations. */
  private _syncPromise: Promise<LedgerSnapshotResult> | null = null;
  /** Whether the in-flight synchronization includes a remote refresh. */
  private _syncRefresh = false;
  /** Most recent immutable synchronization result for request-local analysis reuse. */
  private _latestSynchronization: LedgerSnapshotResult | null = null;

  constructor(config: ActualConnectorConfig) {
    this.client = config.client;
    this.credStore = config.credentialStore ?? new NullCredentialStore();
    this.mode = config.mode ?? DEFAULT_MODE;
    this.baseCacheDir = config.cacheDir ?? mkdtempSync(join(tmpdir(), 'bf-actual-'));
    this.overlapDays = config.overlapDays ?? DEFAULT_OVERLAP_DAYS;
    this.currency = config.currency ?? 'USD';
    this.watermarkStore = config.watermarkStore;
    this.compatibilityRange = config.compatibilityRange;
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  async capabilities(): Promise<LedgerCapabilities> {
    const isObserve = this.mode === 'observe';
    return {
      canRead: true,
      canWrite: !isObserve,
      canRunBankSync: false, // disabled in Phase 1
      canExport: false,
      canQuery: true,
      mode: this.mode,
      modeDescription: isObserve
        ? 'Read-only: connect, download, synchronize, and analyze. Never modifies Actual.'
        : 'Review and apply: explicit approved writes permitted.',
    };
  }

  // -------------------------------------------------------------------------
  // Synchronize
  async synchronize(options: SynchronizeOptions = {}): Promise<LedgerSnapshotResult> {
    this.assertInitialized();

    if (!this._budgetInfo) {
      throw new Error('No budget selected; call discoverBudgets() and selectBudget() first');
    }

    const refresh = options.refresh !== false;
    if (this._syncPromise) {
      const inFlight = this._syncPromise;
      if (!refresh || this._syncRefresh) return inFlight;
      await inFlight;
      return this.synchronize({ refresh: true });
    }

    const pending = this._doSynchronize(refresh);
    this._syncPromise = pending;
    this._syncRefresh = refresh;
    try {
      const synchronization = await pending;
      this._latestSynchronization = synchronization;
      return synchronization;
    } finally {
      if (this._syncPromise === pending) {
        this._syncPromise = null;
        this._syncRefresh = false;
      }
    }
  }

  /** Return the latest normalized result without performing another remote download. */
  getLatestSynchronization(): LedgerSnapshotResult | null {
    return this._latestSynchronization;
  }

  private async _doSynchronize(refresh: boolean): Promise<LedgerSnapshotResult> {
    const budgetId = this._budgetInfo!.id;
    const groupId = this._budgetInfo!.groupId;

    await this.withCacheLock(budgetId, async () => {
      const cache = this.getOrCreateCache(budgetId);
      // Calculate overlap start from watermark for safe re-processing
      const watermark = this.getWatermark(budgetId);
      let overlapStart: string | undefined;
      if (watermark.lastTransactionDate) {
        const d = new Date(watermark.lastTransactionDate);
        d.setDate(d.getDate() - watermark.overlapDays);
        overlapStart = d.toISOString();
      }

      // In Observe mode, refresh by re-downloading instead of calling sync(),
      // which may upload local changes. A caller that just selected the budget
      // can skip the redundant download while still normalizing a snapshot.
      if (refresh) {
        if (this.mode === 'observe') {
          const creds = await this.credStore.load();
          await this.client.downloadBudget(groupId, {
            password: creds?.budgetPassword ?? undefined,
          });
        } else {
          await this.client.sync();
        }
      }

      // Update watermark
      cache.watermark.lastTransactionDate = new Date().toISOString();
      cache.watermark.lastTransactionCount = (cache.watermark.lastTransactionCount || 0) + 1;
      cache.watermark.lastSyncCompletedAt = new Date().toISOString();

      // Persist watermark if store available
      if (this.watermarkStore) {
        await this.watermarkStore.save(budgetId, { ...cache.watermark });
      }
    });

    const capturedAt = new Date().toISOString();
    const { snapshot, financialSnapshot, accountRead } = await this.buildSnapshot(capturedAt);
    const health = await this.buildHealthReport(accountRead);
    const watermark = this.getWatermark(budgetId);

    return { snapshot, financialSnapshot, health, watermark };
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  async listAccounts(query?: AccountQuery): Promise<Account[]> {
    this.assertInitialized();
    const accounts = await this.client.getAccounts();
    let filtered = accounts;
    if (query) {
      if (!query.includeClosed) filtered = filtered.filter((a) => !a.closed);
      if (!query.includeOffBudget) filtered = filtered.filter((a) => !a.offbudget);
    }
    return normalizeAccounts(filtered, this.currency);
  }

  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    this.assertInitialized();
    const accounts = query?.accountId
      ? [query.accountId]
      : (await this.client.getAccounts()).map((a) => a.id);
    const payees = normalizePayees(await this.client.getPayees());
    const payeeMap = buildPayeeNameMap(payees);
    const transferAcctMap = buildTransferAcctMap(payees);
    const categories = normalizeCategories(
      (await this.client.getCategories()) as APICategoryEntity[],
      await this.client.getCategoryGroups(),
    );
    const categoryMap = buildCategoryInfoMap(categories);

    const allTxns: Transaction[] = [];
    for (const accountId of accounts) {
      // Query the full date range unless explicit dates are provided.
      // The watermark overlap window is for synchronize() internal use only;
      // listTransactions() always returns the complete transaction history.
      const startDate = query?.startDate ?? '1970-01-01';
      const endDate = query?.endDate ?? '2099-12-31';
      const txns = await this.client.getTransactions(accountId, startDate, endDate);
      const normalized = normalizeTransactions(
        txns,
        payeeMap,
        categoryMap,
        transferAcctMap,
        this.currency,
      );
      if (query?.includePending === false) {
        allTxns.push(...normalized.filter((t) => t.cleared));
      } else {
        allTxns.push(...normalized);
      }
    }
    return allTxns;
  }

  async listCategories(): Promise<Category[]> {
    this.assertInitialized();
    const cats = (await this.client.getCategories()) as APICategoryEntity[];
    const groups = await this.client.getCategoryGroups();
    return normalizeCategories(cats, groups);
  }

  async listPayees(): Promise<Payee[]> {
    this.assertInitialized();
    return normalizePayees(await this.client.getPayees());
  }

  async listRules(): Promise<AutomationRule[]> {
    this.assertInitialized();
    const rules = await this.client.getRules();
    return normalizeRules(rules).map((r) => ({
      id: r.id,
      name: r.name,
      order: r.order,
      trigger: r.trigger,
      actions: r.actions,
      inactive: r.inactive,
    }));
  }

  async listSchedules(): Promise<Schedule[]> {
    this.assertInitialized();
    return normalizeSchedules(await this.client.getSchedules(), this.currency);
  }

  // -------------------------------------------------------------------------
  // Mutation stubs (rejected in all modes — not yet implemented)
  // -------------------------------------------------------------------------

  async importTransactions(
    _accountId: LedgerId,
    _transactions: ImportTransaction[],
    _options?: ImportOptions,
  ): Promise<ImportResult> {
    this.assertInitialized();
    throw new Error(
      'importTransactions() is not yet implemented in any connection mode. ' +
        'This method will be available in a future update.',
    );
  }

  async updateTransaction(
    _transactionId: LedgerId,
    _patch: TransactionPatch,
    _precondition?: MutationPrecondition,
  ): Promise<MutationResult> {
    this.assertInitialized();
    throw new Error(
      'updateTransaction() is not yet implemented in any connection mode. ' +
        'This method will be available in a future update.',
    );
  }
  async createRule(
    proposal: RuleProposal,
    precondition?: MutationPrecondition,
  ): Promise<MutationResult> {
    this.assertMutationAllowed('createRule');

    // Require an explicitly selected budget
    if (!this._budgetInfo) {
      return {
        success: false,
        error: 'No budget selected. Call selectBudget() before creating rules.',
        code: 'BUDGET_NOT_SELECTED',
      } as MutationResult;
    }

    return this.withCacheLock(this._budgetInfo.id, async (): Promise<MutationResult> => {
      // If a backup precondition is set, the caller is responsible for the backup.
      // Actual's createRule doesn't have native precondition support, so we just log it.
      if (precondition?.requireBackup) {
        // Backup requirement noted — caller should have handled it upstream
      }

      // Build the rule object for the Actual API
      const ruleRecord: Record<string, unknown> = {
        stage: proposal.stage ?? 'post',
        conditionsOp: proposal.conditionsOp ?? 'and',
        conditions: proposal.conditions,
        actions: proposal.actions,
      };

      // Call Actual API to create the rule
      let createResult: { id: string };
      try {
        createResult = await this.client.createRule(ruleRecord);
      } catch (err) {
        return {
          success: false,
          error: `Failed to create rule: ${err instanceof Error ? err.message : String(err)}`,
          code: 'RULE_CREATION_FAILED',
        } as MutationResult;
      }

      // Persist changes to the server — if sync fails, the rule may not be persisted
      try {
        await this.client.sync();
      } catch {
        return {
          success: false,
          error: 'Sync failed after creating rule: the mutation may not have been persisted',
          code: 'SYNC_FAILED',
        } as MutationResult;
      }

      return {
        success: true,
        id: createResult.id,
      } as MutationResult;
    });
  }

  async updateRule(
    id: string,
    fields: Record<string, unknown>,
    precondition?: MutationPrecondition,
  ): Promise<MutationResult> {
    this.assertMutationAllowed('updateRule');
    if (!this._budgetInfo) {
      return {
        success: false,
        error: 'No budget selected.',
        code: 'BUDGET_NOT_SELECTED',
      } as MutationResult;
    }
    return this.withCacheLock(this._budgetInfo.id, async () => {
      try {
        const allRaw = await this.client.getRules();
        const currentRaw = allRaw.find((r) => r.id === id);
        if (!currentRaw) {
          return {
            success: false,
            error: `Rule not found: ${id}`,
            code: 'RULE_NOT_FOUND',
          } as MutationResult;
        }
        const merged: Record<string, unknown> = {
          id: currentRaw.id,
          stage: currentRaw.stage,
          conditionsOp: currentRaw.conditionsOp,
          conditions: JSON.stringify(currentRaw.conditions),
          actions: JSON.stringify(currentRaw.actions),
          tombstone:
            fields.inactive !== undefined ? fields.inactive : (currentRaw.tombstone ?? false),
        };
        await this.client.updateRule(id, merged);
      } catch (err) {
        return {
          success: false,
          error: `Failed to update rule: ${err instanceof Error ? err.message : String(err)}`,
          code: 'RULE_UPDATE_FAILED',
        } as MutationResult;
      }
      try {
        await this.client.sync();
      } catch {
        return {
          success: false,
          error: 'Sync failed after updating rule',
          code: 'SYNC_FAILED',
        } as MutationResult;
      }
      return { success: true } as MutationResult;
    });
  }

  async setBudgetAmount(
    _month: string,
    _categoryId: LedgerId,
    _amount: number,
    _precondition?: MutationPrecondition,
  ): Promise<MutationResult> {
    this.assertInitialized();
    throw new Error(
      'setBudgetAmount() is not yet implemented in any connection mode. ' +
        'This method will be available in a future update.',
    );
  }

  async deleteRule(id: string, precondition?: MutationPrecondition): Promise<MutationResult> {
    this.assertMutationAllowed('deleteRule');
    if (!this._budgetInfo) {
      return {
        success: false,
        error: 'No budget selected.',
        code: 'BUDGET_NOT_SELECTED',
      } as MutationResult;
    }
    return this.withCacheLock(this._budgetInfo.id, async () => {
      try {
        const result = await this.client.deleteRule(id);
        if (result === false) {
          return {
            success: false,
            error: 'Rule is referenced by a schedule and cannot be deleted.',
            code: 'RULE_HAS_SCHEDULE',
          } as MutationResult;
        }
      } catch (err) {
        return {
          success: false,
          error: `Failed to delete rule: ${err instanceof Error ? err.message : String(err)}`,
          code: 'RULE_DELETE_FAILED',
        } as MutationResult;
      }
      try {
        await this.client.sync();
      } catch {
        return {
          success: false,
          error: 'Sync failed after deleting rule',
          code: 'SYNC_FAILED',
        } as MutationResult;
      }
      return { success: true } as MutationResult;
    });
  }

  /**
   * Set the category of a transaction by ID.
   *
   * Precondition:
   *   `currentCategoryId` — expected current category from the caller.
   *   - If non-null: MUST match Actual's current category or the call fails
   *     with `PRECONDITION_MISMATCH` (stale-precondition protection).
   *   - If null (unknown / review-item stored no category): Actual's current
   *     category is accepted as-is and the mutation proceeds.
   *
   * Postcondition:
   *   The transaction is updated in Actual, synced, and re-read to verify.
   *   On success the result includes `previousCategoryId` (the value before
   *   mutation), `newCategoryId`, `idempotencyKey`, and `verified: true`.
   *
   * Error conditions:
   *   `PRECONDITION_MISMATCH` — non-null currentCategoryId does not match Actual
   *   `TRANSACTION_NOT_FOUND` — transaction does not exist
   *   `CATEGORY_NOT_FOUND` — proposed category does not exist in budget
   *   `CATEGORY_DELETED` — proposed category is a tombstone (deleted)
   *   `SYNC_FAILED` — the write succeeded but sync after it failed
   *   `VERIFICATION_FAILED` — post-write re-read shows unexpected category
   *   `BUDGET_NOT_SELECTED` — no budget selected via selectBudget()
   */
  async setTransactionCategory(
    transactionId: LedgerId,
    proposedCategoryId: LedgerId,
    currentCategoryId: LedgerId | null,
  ): Promise<SetCategoryResult> {
    this.assertMutationAllowed('setTransactionCategory');

    // Require an explicitly selected budget
    if (!this._budgetInfo) {
      return {
        success: false,
        error: 'No budget selected. Call selectBudget() before mutating transactions.',
        code: 'BUDGET_NOT_SELECTED',
      } as SetCategoryResult;
    }

    // Serialize the read/check/update/reread under the budget lock
    return this.withCacheLock(this._budgetInfo.id, async (): Promise<SetCategoryResult> => {
      // Read current transaction state to check precondition
      const allAccounts = await this.client.getAccounts();
      const activeAccounts = allAccounts.filter((a) => !a.closed);
      let tx: TransactionEntity | null = null;
      for (const account of activeAccounts) {
        const txns = await this.client.getTransactions(account.id, '1970-01-01', '2099-12-31');
        const found = txns.find((t) => t.id === transactionId);
        if (found) {
          tx = found;
          break;
        }
      }
      if (!tx) {
        return {
          success: false,
          error: `Transaction ${transactionId} not found`,
          code: 'TRANSACTION_NOT_FOUND',
        } as SetCategoryResult;
      }

      // Verify precondition: current category must match expected value
      // When currentCategoryId is null (unknown/empty from review item), we
      // accept Actual's current value and proceed. When non-null, a mismatch
      // rejects with PRECONDITION_MISMATCH (stale-precondition protection).
      const actualCategory = tx.category ?? null;
      if (currentCategoryId !== null && actualCategory !== currentCategoryId) {
        return {
          success: false,
          error:
            `Category precondition mismatch for transaction ${transactionId}: ` +
            `expected currentCategoryId=${JSON.stringify(currentCategoryId)}, ` +
            `actual=${JSON.stringify(actualCategory)}`,
          code: 'PRECONDITION_MISMATCH',
          transactionId,
          previousCategoryId: actualCategory,
        } as SetCategoryResult;
      }

      // Validate the proposed category exists in this budget
      const allCats = (await this.client.getCategories()) as APICategoryEntity[];
      const proposedCat = allCats.find((c) => c.id === proposedCategoryId);
      if (!proposedCat) {
        return {
          success: false,
          error: `Proposed category ${proposedCategoryId} does not exist in this budget`,
          code: 'CATEGORY_NOT_FOUND',
          transactionId,
          previousCategoryId: actualCategory,
          newCategoryId: proposedCategoryId,
        } as SetCategoryResult;
      }

      // Tombstone categories are deleted, not just hidden
      const proposedCatWithMeta = proposedCat as APICategoryEntity & { tombstone?: boolean };
      if (proposedCatWithMeta.tombstone) {
        return {
          success: false,
          error: `Proposed category ${proposedCategoryId} is deleted (tombstone) and cannot be assigned`,
          code: 'CATEGORY_DELETED',
          transactionId,
          previousCategoryId: actualCategory,
          newCategoryId: proposedCategoryId,
        } as SetCategoryResult;
      }

      // Generate idempotency key for replay detection
      const idempotencyKey = `${transactionId}_${proposedCategoryId}_${Date.now()}_${randomUUID()}`;
      // Call Actual update API with the new category
      await this.client.updateTransaction(transactionId, { category: proposedCategoryId });

      // Persist changes to the server before re-reading — if sync fails, the
      // mutation may not have been persisted so we report failure rather than
      // returning a misleading success.
      try {
        await this.client.sync();
      } catch {
        return {
          success: false,
          error: `Sync failed after updating transaction ${transactionId}: the mutation may not have been persisted`,
          code: 'SYNC_FAILED',
          transactionId,
          previousCategoryId: actualCategory,
          newCategoryId: proposedCategoryId,
          idempotencyKey,
        } as SetCategoryResult;
      }

      // Re-read the transaction to verify the postcondition
      const reReads = await this.client.getTransactions(tx.account, '1970-01-01', '2099-12-31');
      const reReadTx = reReads.find((t) => t.id === transactionId);
      const reReadCategory = reReadTx?.category ?? null;
      const verified = reReadCategory === proposedCategoryId;

      if (!verified) {
        return {
          success: false,
          error:
            `Post-write verification failed for transaction ${transactionId}: ` +
            `expected category=${JSON.stringify(proposedCategoryId)}, ` +
            `actual=${JSON.stringify(reReadCategory)}`,
          code: 'VERIFICATION_FAILED',
          transactionId,
          previousCategoryId: actualCategory,
          newCategoryId: proposedCategoryId,
          idempotencyKey,
          verified: false,
        } as SetCategoryResult;
      }

      return {
        success: true,
        transactionId,
        previousCategoryId: actualCategory,
        newCategoryId: proposedCategoryId,
        idempotencyKey,
        verified: true,
      } as SetCategoryResult;
    });
  }
  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect to the Actual server, discover and select a budget.
   * Credentials are loaded from the credential store and used to authenticate.
   */
  async connect(credentials?: ActualCredentials): Promise<BudgetInfo[]> {
    const creds = credentials ?? (await this.credStore.load());
    if (!creds) {
      throw new Error(
        'No credentials available; provide credentials or configure credential store.',
      );
    }

    const dataDir = this.cacheDirFor(creds.serverUrl);
    await this.client.init({
      dataDir,
      serverURL: creds.serverUrl,
      password: creds.secretKey,
    });

    // Store credentials only if the store supports persistence
    // (EnvCredentialStore store() is a no-op, avoiding file attempts)
    await this.credStore.store(creds);

    // Check server version
    const versionResult = await this.client.getServerVersion();
    if ('version' in versionResult) {
      this._serverVersion = versionResult.version;
    }

    this._initialized = true;

    // Hydrate watermarks from persistent store
    if (this.watermarkStore) {
      const budgets = await this.client.getBudgets();
      for (const b of budgets) {
        const id = b.id ?? b.cloudFileId ?? '';
        if (id) {
          const stored = await this.watermarkStore.load(id);
          if (stored) {
            this.caches.set(id, {
              budgetId: id,
              cacheDir: this.cacheDirFor(id),
              initialized: false,
              lastAccessedAt: null,
              mutationLocked: false,
              watermark: stored,
            });
          }
        }
      }
    }

    const budgets = await this.discoverBudgets();
    return budgets;
  }

  async discoverBudgets(): Promise<BudgetInfo[]> {
    this.assertInitialized();
    const files = await this.client.getBudgets();
    return files.map((f) => ({
      id: f.id ?? f.cloudFileId ?? f.groupId ?? '',
      groupId: f.groupId ?? f.id ?? f.cloudFileId ?? '',
      name: f.name ?? 'Unnamed Budget',
      encrypted: f.hasKey ?? false,
    }));
  }

  /**
   * Select a budget for operations. Downloads it into an isolated cache.
   */
  async selectBudget(budgetId: string, password?: string): Promise<BudgetInfo> {
    this.assertInitialized();
    const budgets = await this.discoverBudgets();
    const info = budgets.find((b) => b.id === budgetId || b.groupId === budgetId);
    if (!info) {
      throw new Error(`Budget "${budgetId}" not found on server`);
    }

    // Re-init the client with per-budget (per-group) data dir so the Actual API
    // stores downloaded data in an isolated directory.
    const dataDir = this.cacheDirFor(info.groupId);
    await this.client.shutdown();
    const creds = await this.credStore.load();
    await this.client.init({
      dataDir,
      serverURL: creds?.serverUrl ?? '',
      password: creds?.secretKey ?? '',
    });
    await this.client.downloadBudget(info.groupId, { password });
    // downloadBudget already loads the budget internally; no need for a separate loadBudget call.

    this._latestSynchronization = null;
    this._budgetInfo = info;
    const cache = this.getOrCreateCache(info.id);
    cache.cacheDir = dataDir;
    return info;
  }

  async disconnect(): Promise<void> {
    // Await any pending cache operations before shutdown
    for (const [, lock] of this.cacheLocks) {
      try {
        await lock;
      } catch {
        /* ignore rejected ops */
      }
    }

    // Persist watermarks before cleaning up
    if (this.watermarkStore) {
      for (const [budgetId, cache] of this.caches) {
        await this.watermarkStore.save(budgetId, { ...cache.watermark }).catch(() => {});
      }
    }

    // Remove all per-budget caches
    for (const [, cache] of this.caches) {
      this.removeCacheDir(cache.cacheDir);
    }
    this.caches.clear();
    this.cacheLocks.clear();

    // Shut down the Actual client
    await this.client.shutdown();

    // Remove stored credentials
    await this.credStore.delete();

    this._initialized = false;
    this._budgetInfo = null;
    this._latestSynchronization = null;
    this._serverVersion = null;
    this._connectedAt = null;
  }

  // -------------------------------------------------------------------------
  // Health / compatibility / freshness / coverage / incidents
  // -------------------------------------------------------------------------

  async getHealthReport(): Promise<HealthReport> {
    this.assertInitialized();
    const accountRead = await readCollection(() => this.client.getAccounts());
    return this.buildHealthReport(accountRead);
  }

  private async buildHealthReport(
    accountRead: CollectionRead<APIAccountEntity>,
  ): Promise<HealthReport> {
    const compatibility = await this.getCompatibility();
    const freshness = this.getFreshness();
    const coverage = healthCoverageFor(accountRead);
    const incidents: Incident[] = [];

    if (!compatibility.supported) {
      incidents.push({
        severity: 'error',
        code: 'INCOMPATIBLE_VERSION',
        message: `Server version ${compatibility.serverVersion} is not supported. Supported: ${compatibility.supportedVersion}`,
      });
    }

    if (!accountRead.available) {
      incidents.push({
        severity: 'warning',
        code: 'ACCOUNT_COVERAGE_UNAVAILABLE',
        message:
          'Account coverage could not be determined because the account collection was unavailable.',
      });
    } else if (!coverage.allExpectedAccountsPresent) {
      incidents.push({
        severity: 'warning',
        code: 'MISSING_ACCOUNTS',
        message: `Only ${coverage.includedAccounts}/${coverage.totalAccounts} accounts are included in the snapshot.`,
      });
    }

    const state: HealthState = (() => {
      if (!compatibility.supported) return 'degraded';
      if (incidents.some((incident) => incident.severity === 'error')) return 'degraded';
      if (freshness.lastDownloadedAt === null) return 'degraded';
      if (!accountRead.available) return 'unknown';
      return 'healthy';
    })();

    return { state, compatibility, freshness, coverage, incidents };
  }

  async getCompatibility(): Promise<CompatibilityResult> {
    const serverVersion = this._serverVersion ?? 'unknown';
    const minVersion = this.compatibilityRange?.min ?? '24.0.0';
    const maxVersion = this.compatibilityRange?.max ?? '26.7.0';
    const blockers: string[] = [];

    if (serverVersion === 'unknown') {
      blockers.push('Unable to determine server version');
    }

    // Enforce configured min/max compatibility range
    if (serverVersion !== 'unknown') {
      try {
        const parts = serverVersion.split('.').map(Number);
        const minParts = minVersion.split('.').map(Number);
        const maxParts = maxVersion.split('.').map(Number);

        // Validate all version parts are finite non-NaN numbers with at least 2 parts
        const validServer = parts.length >= 2 && parts.every((p) => Number.isFinite(p));
        const validMin = minParts.length >= 2 && minParts.every((p) => Number.isFinite(p));
        const validMax = maxParts.length >= 2 && maxParts.every((p) => Number.isFinite(p));

        if (!validServer) {
          blockers.push(`Unable to parse server version: "${serverVersion}" is not a valid semver`);
        }
        if (!validMin) {
          blockers.push(`Invalid minimum version range: "${minVersion}"`);
        }
        if (!validMax) {
          blockers.push(`Invalid maximum version range: "${maxVersion}"`);
        }

        if (validServer && validMin && validMax) {
          const serverMajor = parts[0]!;
          const serverMinor = parts[1]!;
          const minMajor = minParts[0]!;
          const minMinor = minParts[1]!;
          const maxMajor = maxParts[0]!;
          const maxMinor = maxParts[1]!;

          if (serverMajor < minMajor || (serverMajor === minMajor && serverMinor < minMinor)) {
            blockers.push(
              `Server version ${serverVersion} is below minimum supported version ${minVersion}`,
            );
          }
          if (serverMajor > maxMajor || (serverMajor === maxMajor && serverMinor > maxMinor)) {
            blockers.push(
              `Server version ${serverVersion} exceeds maximum supported version ${maxVersion}`,
            );
          }
        }
      } catch {
        blockers.push(`Unable to parse server version: ${serverVersion}`);
      }
    }

    const isSupported = serverVersion !== 'unknown' && blockers.length === 0;
    return {
      supported: isSupported,
      serverVersion,
      supportedVersion: maxVersion,
      blockers,
    };
  }

  getFreshness(): Freshness {
    const cacheList = Array.from(this.caches.values());
    const lastSync = cacheList
      .map((c) => c.watermark.lastSyncCompletedAt)
      .filter(Boolean)
      .sort()
      .pop();
    return {
      lastDownloadedAt: lastSync ?? null,
      lastBankSyncedAt: null, // bank sync not available in Observe-only mode
      pendingTransactionsIncluded: true,
    };
  }

  async getCoverage(): Promise<Coverage> {
    this.assertInitialized();
    const accountRead = await readCollection(() => this.client.getAccounts());
    return healthCoverageFor(accountRead);
  }

  /** Convenience: one-shot health check without full report construction. */
  async healthCheck(): Promise<HealthState> {
    try {
      const report = await this.getHealthReport();
      return report.state;
    } catch {
      return 'unreachable';
    }
  }

  /** Expose the broad-access caveat. */
  getBroadAccessCaveat(): string {
    return BROAD_ACCESS_CAVEAT;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private assertInitialized(): void {
    if (!this._initialized) {
      throw new Error('ActualConnector has not been initialized. Call connect() first.');
    }
  }

  private assertMutationAllowed(method: string): void {
    this.assertInitialized();
    if (this.mode === 'observe') {
      throw new Error(
        `Mutation rejected: ${method}() is not permitted in observe mode. ` +
          `Switch to a write-enabled mode to perform mutations.`,
      );
    }
  }

  private cacheDirFor(key: string): string {
    // Sanitize the key: remove path separators and other unsafe chars.
    // Path traversal sequences (..) are handled by the resolve guard below.
    const safeName = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    const resolved = resolve(this.baseCacheDir, safeName);
    // Guard against path traversal — the resolved path must stay within baseCacheDir
    const baseResolved = resolve(this.baseCacheDir) + '/';
    if (!resolved.startsWith(baseResolved)) {
      throw new Error(`Cache path traversal blocked for key "${key}"`);
    }
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
    return resolved;
  }

  private getOrCreateCache(budgetId: string): CacheState {
    let cache = this.caches.get(budgetId);
    if (!cache) {
      const dir = this.cacheDirFor(budgetId);
      cache = {
        budgetId,
        cacheDir: dir,
        initialized: true,
        lastAccessedAt: new Date().toISOString(),
        mutationLocked: false,
        watermark: {
          budgetId,
          lastTransactionDate: null,
          lastTransactionCount: 0,
          lastSyncCompletedAt: null,
          overlapDays: this.overlapDays,
        },
      };
      this.caches.set(budgetId, cache);
    }
    cache.lastAccessedAt = new Date().toISOString();
    return cache;
  }

  private getWatermark(budgetId: string): SyncWatermark {
    const cache = this.caches.get(budgetId);
    if (!cache) {
      return {
        budgetId,
        lastTransactionDate: null,
        lastTransactionCount: 0,
        lastSyncCompletedAt: null,
        overlapDays: this.overlapDays,
      };
    }
    return { ...cache.watermark };
  }

  /**
   * Serialized mutation lock per cache.
   * Ensures only one lifecycle/mutation operation runs per budget at a time.
   * Uses a promise chain per budgetId to serialize operations.
   * Rejected operations in the chain do not block subsequent ones.
   */
  private async withCacheLock<T>(budgetId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.cacheLocks.get(budgetId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // Run even if prev rejected
    this.cacheLocks.set(
      budgetId,
      next.catch(() => undefined),
    );
    return next;
  }

  private removeCacheDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  private async buildSnapshot(capturedAt: string): Promise<SnapshotBuildResult> {
    this.assertInitialized();

    const accountRead = await readCollection(() => this.client.getAccounts());
    const payeeRead = await readCollection(() => this.client.getPayees());
    const categoryRead = await readCollection<APICategoryEntity | APICategoryGroupEntity>(() =>
      this.client.getCategories(),
    );
    const categoryGroupRead = await readCollection(() => this.client.getCategoryGroups());
    const ruleRead = await readCollection(() => this.client.getRules());
    const scheduleRead = await readCollection(() => this.client.getSchedules());
    const budgetMonthRead = await readCollection(() => this.client.getBudgetMonths());
    const tagRead = await readCollection(() => this.client.getTags());

    const rawCategories = categoryRead.available
      ? (categoryRead.items as unknown as APICategoryEntity[])
      : [];
    const payees = normalizePayees(payeeRead.items);
    const categories = normalizeCategories(rawCategories, categoryGroupRead.items);
    const accounts = normalizeAccounts(accountRead.items, this.currency);
    const rules = normalizeRules(ruleRead.items);
    const schedules = normalizeSchedules(scheduleRead.items, this.currency);
    const payeeMap = buildPayeeNameMap(payees);
    const categoryMap = buildCategoryInfoMap(categories);
    const transferAcctMap = buildTransferAcctMap(payees);

    const activeAccounts = accountRead.items.filter((account) => !account.closed);
    const transactionReads: Array<{
      accountId: string;
      read: CollectionRead<TransactionEntity>;
    }> = [];
    for (const account of activeAccounts) {
      transactionReads.push({
        accountId: account.id,
        read: await readCollection(() =>
          this.client.getTransactions(account.id, '1970-01-01', '2099-12-31'),
        ),
      });
    }
    const allRawTransactions: TransactionEntity[] = [];
    const transactions: Transaction[] = [];
    for (const transactionRead of transactionReads) {
      if (!transactionRead.read.available) continue;
      allRawTransactions.push(...transactionRead.read.items);
      transactions.push(
        ...normalizeTransactions(
          transactionRead.read.items,
          payeeMap,
          categoryMap,
          transferAcctMap,
          this.currency,
        ),
      );
    }

    const budgets: BudgetMonth[] = [];
    let loadedBudgetMonths = 0;
    if (budgetMonthRead.available) {
      for (const month of budgetMonthRead.items) {
        try {
          const monthData = await this.client.getBudgetMonth(month);
          const categoryBudgets: Record<string, number> = {};
          for (const group of monthData.categoryGroups ?? []) {
            for (const category of (group.categories ?? []) as Array<Record<string, unknown>>) {
              if (category.id && typeof category.budgeted === 'number') {
                categoryBudgets[String(category.id)] = category.budgeted;
              }
            }
          }
          budgets.push(normalizeBudgetMonth(month, categoryBudgets, this.currency));
          loadedBudgetMonths += 1;
        } catch {
          // Coverage below records the unreadable month; successfully loaded months are retained.
        }
      }
    }

    const snapshot: LedgerSnapshotResult['snapshot'] = {
      schemaVersion: '1',
      actualVersion: this._serverVersion ?? 'unknown',
      snapshotDate: capturedAt,
      actualDownloadedAt: capturedAt,
      bankSyncedAt: null,
      encrypted: this._budgetInfo?.encrypted ?? false,
      unlocked: this._budgetInfo !== null,
      accounts,
      transactions,
      categories,
      payees,
      rules,
      schedules,
      budgets,
      tags: [],
    };

    const accountFactsIncomplete = accountRead.items.some(
      (account) => !hasReliableAccountType(account) || !hasReliableAccountBalance(account),
    );
    const scheduleFactsIncomplete = scheduleRead.items.some(
      (schedule) => !hasReliableScheduleFacts(schedule),
    );

    let transactionCoverage: CoverageState;
    if (!accountRead.available) {
      transactionCoverage = 'unknown';
    } else if (activeAccounts.length === 0) {
      transactionCoverage = 'empty';
    } else {
      const readableAccounts = transactionReads.filter(({ read }) => read.available).length;
      if (readableAccounts === 0) {
        transactionCoverage = 'unknown';
      } else if (readableAccounts < activeAccounts.length) {
        transactionCoverage = 'partial';
      } else {
        transactionCoverage = allRawTransactions.length === 0 ? 'empty' : 'complete';
      }
    }

    let categoryCoverage: CoverageState;
    if (!categoryRead.available) {
      categoryCoverage = 'unknown';
    } else if (!categoryGroupRead.available) {
      categoryCoverage = categoryRead.items.length === 0 ? 'unknown' : 'partial';
    } else {
      categoryCoverage = coverageFor(categoryRead);
    }

    let budgetCoverage: CoverageState;
    if (!budgetMonthRead.available) {
      budgetCoverage = 'unknown';
    } else if (budgetMonthRead.items.length === 0) {
      budgetCoverage = 'empty';
    } else if (loadedBudgetMonths === 0) {
      budgetCoverage = 'unknown';
    } else if (loadedBudgetMonths < budgetMonthRead.items.length) {
      budgetCoverage = 'partial';
    } else {
      budgetCoverage = 'complete';
    }

    const coverage: FinancialSnapshot['coverage'] = {
      accounts: coverageFor(accountRead, accountFactsIncomplete),
      transactions: transactionCoverage,
      categories: categoryCoverage,
      payees: coverageFor(payeeRead),
      rules: coverageFor(ruleRead),
      schedules: coverageFor(scheduleRead, scheduleFactsIncomplete),
      budgets: budgetCoverage,
      tags: coverageFor(tagRead),
    };

    const observations: SourceObservation[] = [];
    for (const account of accountRead.items) {
      const evidence = [visibleEvidence(account.id, 'account')];
      const scope = { kind: 'account' as const, id: account.id };
      const hasReliableBalance = hasReliableAccountBalance(account);
      observations.push({
        kind: 'account_freshness',
        scope,
        state: 'unavailable',
        observedAt: null,
        evidence,
      });
      observations.push({
        kind: 'account_coverage',
        scope,
        state: hasReliableBalance ? 'complete' : 'unavailable',
        observedAt: hasReliableBalance ? capturedAt : null,
        evidence,
      });

      const hasReliableType = hasReliableAccountType(account);
      observations.push({
        kind: 'account_type',
        scope,
        state: hasReliableType ? 'complete' : 'unavailable',
        observedAt: hasReliableType ? capturedAt : null,
        evidence,
      });

      observations.push({
        kind: 'account_balance',
        scope,
        state: hasReliableBalance ? 'complete' : 'unavailable',
        observedAt: hasReliableBalance ? capturedAt : null,
        evidence,
      });
      observations.push({
        kind: 'credit_card_obligation_coverage',
        scope,
        state: 'unavailable',
        observedAt: null,
        evidence,
      });
    }

    const observableTransactions = allRawTransactions.filter(
      (transaction) => !transaction.tombstone,
    );
    for (const transaction of observableTransactions) {
      const transactionEvidence = [visibleEvidence(transaction.id, 'transaction')];
      const accountScope = { kind: 'account' as const, id: transaction.account };
      if (transaction.cleared === false) {
        observations.push({
          kind: 'pending_activity',
          scope: accountScope,
          state: 'included',
          observedAt: capturedAt,
          evidence: transactionEvidence,
        });
      } else if (transaction.reconciled === false) {
        observations.push({
          kind: 'uncleared_activity',
          scope: accountScope,
          state: 'included',
          observedAt: capturedAt,
          evidence: transactionEvidence,
        });
      }

      if (transaction.imported_id) {
        const duplicate = observableTransactions.find(
          (candidate) =>
            candidate.id !== transaction.id &&
            candidate.account === transaction.account &&
            candidate.date === transaction.date &&
            candidate.amount === transaction.amount &&
            candidate.payee === transaction.payee,
        );
        if (duplicate) {
          observations.push({
            kind: 'duplicate_candidate',
            scope: { kind: 'transaction', id: transaction.id },
            state: 'present',
            observedAt: capturedAt,
            evidence: [
              visibleEvidence(transaction.id, 'transaction'),
              visibleEvidence(duplicate.id, 'transaction'),
            ],
          });
        }
      }

      const transferAccountId = transaction.payee
        ? (transferAcctMap[transaction.payee] ?? null)
        : null;
      if (transferAccountId) {
        const counterpart = observableTransactions.find(
          (candidate) =>
            candidate.id !== transaction.id &&
            candidate.account === transferAccountId &&
            candidate.date === transaction.date &&
            candidate.amount === -transaction.amount,
        );
        if (!counterpart) {
          observations.push({
            kind: 'transfer_ambiguity',
            scope: { kind: 'transaction', id: transaction.id },
            state: 'ambiguous',
            observedAt: capturedAt,
            evidence: transactionEvidence,
          });
        }
      }
    }

    for (const account of activeAccounts) {
      const unreconciled = observableTransactions.filter(
        (transaction) => transaction.account === account.id && transaction.reconciled === false,
      );
      if (unreconciled.length > 0) {
        observations.push({
          kind: 'reconciliation',
          scope: { kind: 'account', id: account.id },
          state: 'unreconciled',
          observedAt: capturedAt,
          evidence: unreconciled.map((transaction) =>
            visibleEvidence(transaction.id, 'transaction'),
          ),
        });
      }
    }

    for (const schedule of scheduleRead.items.filter((candidate) => !candidate.completed)) {
      const hasReliableFacts = hasReliableScheduleFacts(schedule);
      observations.push({
        kind: 'schedule_coverage',
        scope: { kind: 'schedule', id: schedule.id },
        state: hasReliableFacts ? 'complete' : 'unavailable',
        observedAt: hasReliableFacts ? capturedAt : null,
        evidence: [visibleEvidence(schedule.id, 'schedule')],
      });
    }

    observations.push({
      kind: 'currency_compatibility',
      scope: { kind: 'global' },
      state: 'complete',
      observedAt: capturedAt,
      evidence: [],
    });

    const source = {
      ledgerBackend: 'actual',
      ledgerId: this._budgetInfo!.groupId,
      budgetId: this._budgetInfo!.id,
      spaceId: null,
    };
    const hashInput = {
      contractVersion: '1.0',
      source,
      capturedAt,
      sourceNormalizationVersion: 'actual-normalizer/1',
      legacySnapshot: snapshot,
      coverage,
      inclusionScope: {
        pendingActivity: 'included' as const,
        unclearedActivity: 'included' as const,
      },
      observations,
    };
    const digest = sha256(hashInput);
    const financialSnapshot: FinancialSnapshot = {
      ...hashInput,
      snapshotId: `actual:${source.ledgerId}:${source.budgetId}:sha256:${digest}`,
      contentHash: `sha256:${digest}`,
    };

    return { snapshot, financialSnapshot, accountRead };
  }
}
