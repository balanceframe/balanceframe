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

import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import type {
  Account,
  Transaction,
  Category,
  Payee,
  Rule,
  Schedule,
  BudgetMonth,
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
  normalizeTag,
} from './normalizer.js';

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
  getTransactions(accountId: string, startDate: string, endDate: string): Promise<TransactionEntity[]>;
  getPayees(): Promise<APIPayeeEntity[]>;
  getCategories(opts?: { hidden?: boolean }): Promise<(APICategoryEntity | APICategoryGroupEntity)[]>;
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
  addTransactions(accountId: string, transactions: unknown[], opts?: { learnCategories?: boolean; runTransfers?: boolean }): Promise<'ok'>;
  createAccount(account: Omit<APIAccountEntity, 'id'>, initialBalance?: number): Promise<string>;
  updateTransaction(id: string, fields: Record<string, unknown>): Promise<unknown>;
  createRule(rule: Record<string, unknown>): Promise<{ id: string }>;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-unknown
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
    createAccount: (account, initialBalance) =>
      actual.createAccount(account, initialBalance),
    updateTransaction: (id, fields) => actual.updateTransaction(id, fields),
    createRule: (rule) => actual.createRule(rule as Parameters<typeof actual.createRule>[0]),
    setBudgetAmount: (month, categoryId, value) =>
      actual.setBudgetAmount(month, categoryId, value),
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
  // -------------------------------------------------------------------------

  async synchronize(): Promise<LedgerSnapshotResult> {
    this.assertInitialized();

    if (!this._budgetInfo) {
      throw new Error('No budget selected; call discoverBudgets() and selectBudget() first');
    }

    const budgetId = this._budgetInfo.id;

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

      // Sync from Actual server
      await this.client.sync();

      // Update watermark
      cache.watermark.lastTransactionDate = new Date().toISOString();
      cache.watermark.lastTransactionCount = (cache.watermark.lastTransactionCount || 0) + 1;
      cache.watermark.lastSyncCompletedAt = new Date().toISOString();

      // Persist watermark if store available
      if (this.watermarkStore) {
        await this.watermarkStore.save(budgetId, { ...cache.watermark });
      }
    });

    const snapshot = await this.buildSnapshot();
    const health = await this.getHealthReport();
    const watermark = this.getWatermark(budgetId);

    return { snapshot, health, watermark };
  }

  // -------------------------------------------------------------------------
  // Read operations
  // -------------------------------------------------------------------------

  async listAccounts(query?: AccountQuery): Promise<Account[]> {
    this.assertInitialized();
    const accounts = await this.client.getAccounts();
    let filtered = accounts;
    if (query) {
      if (!query.includeClosed) filtered = filtered.filter(a => !a.closed);
      if (!query.includeOffBudget) filtered = filtered.filter(a => !a.offbudget);
    }
    return normalizeAccounts(filtered, this.currency);
  }

  async listTransactions(query?: TransactionQuery): Promise<Transaction[]> {
    this.assertInitialized();
    const accounts = query?.accountId
      ? [query.accountId]
      : (await this.client.getAccounts()).map(a => a.id);
    const payees = normalizePayees(await this.client.getPayees());
    const payeeMap = buildPayeeNameMap(payees);
    const categories = normalizeCategories(
      (await this.client.getCategories({ hidden: true })) as APICategoryEntity[],
      await this.client.getCategoryGroups(),
    );
    const categoryMap = buildCategoryInfoMap(categories);

    const allTxns: Transaction[] = [];
    for (const accountId of accounts) {
      // Apply overlap window from watermark if available
      const defStart = '1970-01-01';
      const defEnd = '2099-12-31';
      let startDate = query?.startDate ?? defStart;
      if (this._budgetInfo && !query?.startDate) {
        const wm = this.getWatermark(this._budgetInfo.id);
        if (wm.lastTransactionDate) {
          const d = new Date(wm.lastTransactionDate);
          d.setDate(d.getDate() - wm.overlapDays);
          const overlap = d.toISOString().slice(0, 10);
          if (overlap > startDate) startDate = overlap;
        }
      }
      const endDate = query?.endDate ?? defEnd;
      const txns = await this.client.getTransactions(accountId, startDate, endDate);
      const normalized = normalizeTransactions(txns, payeeMap, categoryMap, this.currency);
      if (query?.includePending === false) {
        allTxns.push(...normalized.filter(t => t.cleared));
      } else {
        allTxns.push(...normalized);
      }
    }
    return allTxns;
  }

  async listCategories(): Promise<Category[]> {
    this.assertInitialized();
    const cats = (await this.client.getCategories({ hidden: true })) as APICategoryEntity[];
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
    return normalizeRules(rules).map(r => ({
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
  // Mutation stubs (Observe mode rejects all writes)
  // -------------------------------------------------------------------------

  async importTransactions(
    _accountId: LedgerId,
    _transactions: ImportTransaction[],
    _options?: ImportOptions,
  ): Promise<ImportResult> {
    this.assertMutationAllowed('importTransactions');
    return { success: true, errors: [], importedCount: 0 };
  }

  async updateTransaction(
    _transactionId: LedgerId,
    _patch: TransactionPatch,
    _precondition?: MutationPrecondition,
  ): Promise<MutationResult> {
    this.assertMutationAllowed('updateTransaction');
    return { success: true, id: _transactionId };
  }

  async createRule(
    _proposal: RuleProposal,
    _precondition?: MutationPrecondition,
  ): Promise<MutationResult> {
    this.assertMutationAllowed('createRule');
    return { success: true, id: '' };
  }

  async setBudgetAmount(
    _month: string,
    _categoryId: LedgerId,
    _amount: number,
    _precondition?: MutationPrecondition,
  ): Promise<MutationResult> {
    this.assertMutationAllowed('setBudgetAmount');
    return { success: true, id: _categoryId };
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
      throw new Error('No credentials available; provide credentials or configure credential store.');
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

    this._connectedAt = new Date().toISOString();
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
    return files.map(f => ({
      id: f.id ?? f.cloudFileId ?? '',
      groupId: f.groupId ?? '',
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
    const info = budgets.find(b => b.id === budgetId);
    if (!info) {
      throw new Error(`Budget "${budgetId}" not found on server`);
    }

    // Use groupId for the data directory so multiple budgets in same group share cache
    const cacheDir = this.cacheDirFor(info.groupId);
    await this.client.downloadBudget(info.groupId, { password });
    await this.client.loadBudget(budgetId);

    this._budgetInfo = info;
    const cache = this.getOrCreateCache(info.id);
    // Override cache dir to use the group-based directory
    cache.cacheDir = cacheDir;
    return info;
  }

  async disconnect(): Promise<void> {
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
    // (EnvCredentialStore delete() is a no-op, avoiding file errors)
    await this.credStore.delete();

    this._initialized = false;
    this._budgetInfo = null;
    this._serverVersion = null;
    this._connectedAt = null;
  }

  // -------------------------------------------------------------------------
  // Health / compatibility / freshness / coverage / incidents
  // -------------------------------------------------------------------------

  async getHealthReport(): Promise<HealthReport> {
    const compatibility = await this.getCompatibility();
    const freshness = this.getFreshness();
    const coverage = await this.getCoverage();
    const incidents: Incident[] = [];

    const state: HealthState = (() => {
      if (!compatibility.supported) return 'degraded';
      if (incidents.some(i => i.severity === 'error')) return 'degraded';
      if (freshness.lastDownloadedAt === null) return 'degraded';
      return 'healthy';
    })();

    if (!compatibility.supported) {
      incidents.push({
        severity: 'error',
        code: 'INCOMPATIBLE_VERSION',
        message: `Server version ${compatibility.serverVersion} is not supported. Supported: ${compatibility.supportedVersion}`,
      });
    }

    if (!coverage.allExpectedAccountsPresent) {
      incidents.push({
        severity: 'warning',
        code: 'MISSING_ACCOUNTS',
        message: `Only ${coverage.includedAccounts}/${coverage.totalAccounts} accounts are included in the snapshot.`,
      });
    }

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

        const serverMajor = parts[0] ?? 0;
        const serverMinor = parts[1] ?? 0;
        const minMajor = minParts[0] ?? 0;
        const minMinor = minParts[1] ?? 0;
        const maxMajor = maxParts[0] ?? 0;
        const maxMinor = maxParts[1] ?? 0;

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
      .map(c => c.watermark.lastSyncCompletedAt)
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
    const allAccounts = await this.client.getAccounts();
    const included = allAccounts.filter(a => !a.closed);
    return {
      totalAccounts: allAccounts.length,
      includedAccounts: included.length,
      allExpectedAccountsPresent: included.length >= allAccounts.length,
    };
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
      throw new Error(
        'ActualConnector has not been initialized. Call connect() first.',
      );
    }
  }

  private assertMutationAllowed(method: string): void {
    this.assertInitialized();
    if (this.mode === 'observe') {
      throw new Error(
        `Mutation rejected in Observe mode: ${method}() is not allowed. ` +
        `Current mode: ${this.mode}. Change to a write-enabled mode to mutate Actual.`,
      );
    }
  }

  private cacheDirFor(key: string): string {
    const safeName = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return resolve(this.baseCacheDir, safeName);
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
    this.cacheLocks.set(budgetId, next.catch(() => undefined));
    return next;
  }

  private removeCacheDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  private async buildSnapshot(): Promise<LedgerSnapshotResult['snapshot']> {
    this.assertInitialized();
    const payees = normalizePayees(await this.client.getPayees());
    const categories = normalizeCategories(
      (await this.client.getCategories({ hidden: true })) as APICategoryEntity[],
      await this.client.getCategoryGroups(),
    );
    const payeeMap = buildPayeeNameMap(payees);
    const categoryMap = buildCategoryInfoMap(categories);

    const accounts = normalizeAccounts(await this.client.getAccounts(), this.currency);

    // Collect all transactions across all non-closed accounts
    const allAccounts = await this.client.getAccounts();
    const activeAccounts = allAccounts.filter(a => !a.closed);
    const allTxns: Transaction[] = [];
    for (const account of activeAccounts) {
      const txns = await this.client.getTransactions(account.id, '1970-01-01', '2099-12-31');
      allTxns.push(...normalizeTransactions(txns, payeeMap, categoryMap, this.currency));
    }

    const rules = normalizeRules(await this.client.getRules());
    const schedules = normalizeSchedules(await this.client.getSchedules(), this.currency);

    // Budget months
    const budgetMonths = await this.client.getBudgetMonths();
    const budgets: BudgetMonth[] = [];
    for (const month of budgetMonths) {
      try {
        const monthData = await this.client.getBudgetMonth(month);
        const categoryBudgets: Record<string, number> = {};
        for (const group of monthData.categoryGroups ?? []) {
          for (const cat of (group.categories ?? []) as Array<Record<string, unknown>>) {
            if (cat.id && typeof cat.budgeted === 'number') {
              categoryBudgets[String(cat.id)] = cat.budgeted as number;
            }
          }
        }
        budgets.push(normalizeBudgetMonth(month, categoryBudgets, this.currency));
      } catch {
        // Skip months that fail to load
      }
    }

    return {
      schemaVersion: '1',
      actualVersion: this._serverVersion ?? 'unknown',
      snapshotDate: new Date().toISOString(),
      accounts,
      transactions: allTxns,
      categories,
      payees,
      rules,
      schedules,
      budgets,
      tags: [],
    };
  }
}
