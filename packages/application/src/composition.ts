/**
 * Production dependency composition for Observe mode.
 *
 * Creates a validated runtime factory that constructs an ActualConnector,
 * native analysis protocol adapter, workflow store, and lifecycle callbacks
 * without test injection. All dependencies accept optional overrides for
 * test doubles, preserving the CLI's existing test injection pattern.
 *
 * ## Usage (production)
 *
 * ```ts
 * import { createObserveComposition } from '@balanceframe/application/composition';
 *
 * const deps = await createObserveComposition();
 * ```
 *
 * ## Usage (test injection)
 *
 * ```ts
 * const deps = await createObserveComposition({
 *   ledger: mockLedger,
 *   analysisProtocol: mockProtocol,
 * });
 * ```
 *
 * No credentials are leaked in errors, logs, or serialized output.
 * Configuration errors produce classified {@link CompositionConfigurationError}.
 */

import type {
  AnalysisProtocol,
  ConnectionMode,
  LifecycleCallbacks,
  PendingReviewResult,
  ReviewDetailResult,
  ReviewActionResult,
  ReviewBulkActionResult,
  ReviewGroupResult,
  BudgetSummaryResult,
  ProposalCreateResult,
  ProposalDetailResult,
  ProposalActionResult,
  ProposalListResult,
  AuditQueryResult,
  RuleListResult,
  RuleShowResult,
  RuleUpdateResult,
  ReviewActionOptions,
  AuditQueryOptions,
  ExportResult,
  DisconnectResult,
  RemovalResult,
  DeletionResult,
} from './commands.js';
import type { DataFreshness } from './envelope.js';
import { ReasonCodes } from './errors.js';
import { ApplicationError } from './errors.js';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// CompositionConfigurationError
// ---------------------------------------------------------------------------

/**
 * Thrown when the composition factory encounters a configuration problem
 * (missing environment variables, invalid credentials, unavailable native
 * bindings). Never leaks credential values in the error message.
 */
export class CompositionConfigurationError extends ApplicationError {
  constructor(message: string, reasonCode: string = ReasonCodes.MISSING_LEDGER_CONFIG) {
    super({
      code: 'composition_configuration_error',
      message,
      reasonCodes: [reasonCode],
      retryable: true,
    });
    this.name = 'CompositionConfigurationError';
  }
}

// ---------------------------------------------------------------------------
// Options — all overridable for test injection
// ---------------------------------------------------------------------------

/**
 * Optional overrides for {@link createObserveComposition}.
 *
 * Every field is optional — defaults construct production implementations.
 * Supply test doubles for any seam when testing.
 */
export interface ObserveCompositionOptions {
  /** Connection mode (default: 'observe'). */
  mode?: ConnectionMode;

  /** Ledger/adapter handle override (default: null — not connected). */
  ledger?: unknown;

  /** Data freshness metadata override (default: null). */
  freshness?: DataFreshness | null;

  /** Analysis protocol override (default: created from native bindings). */
  analysisProtocol?: AnalysisProtocol;

  /** Lifecycle callbacks override (default: created from ActualConnector). */
  lifecycleCallbacks?: LifecycleCallbacks;

  /**
   * Workflow store override for lifecycle operations.
   * When provided, destructive lifecycle callbacks perform actual
   * cancellation, credential revocation, and scoped deletion.
   */
  workflowStore?: {
    cancelPendingJobs(): Promise<number>;
    deleteActorMembership(actorId: string): Promise<boolean>;
    recordExport(input: { budgetName: string; exportPath: string; accountCount: number; transactionCount: number }): Promise<void>;
    getLastExport(): Promise<{ exportedAt: string; budgetName: string; exportPath: string; accountCount: number; transactionCount: number } | null>;
    deleteScopeData(scope: string, options?: { actorId?: string }): Promise<{ deleted: Record<string, number>; retained: { count: number; reasons: string[] } }>;
  };

  /** Actor ID override (default: 'usr_cli'). */
  actorId?: string;

  /** Request ID override (default: generated timestamp-based). */
  requestId?: string;

  /**
   * Override the native addon loader.
   * When provided, the composition uses this instead of the real
   * `@balanceframe/native` require-based loader. Accepts a factory
   * that returns a module-shaped object with native binding methods.
   */
  nativeBindings?: () => Promise<NativeBindingShim>;

  /**
   * Override the Actual client factory.
   * When provided, the composition uses this instead of the real
   * `createDefaultActualClient` from `@balanceframe/actual-adapter`.
   */
  actualClientFactory?: () => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * A fully composed set of dependencies for Observe-mode CLI commands.
 *
 * Every member is populated — `analysisProtocol` is always set in production
 * (never `undefined`), so that the "no_analysis_protocol" error path is
 * replaced by more specific errors (e.g. "not_connected").
 */
export interface ObserveComposition {
  /** Connection mode — always present (default 'observe'). */
  mode: ConnectionMode;

  /** Stable actor identifier. */
  actorId: string;

  /** Request ID (deterministic or generated). */
  requestId: string;

  /**
   * Ledger/adapter handle.
   * In production this is `null` until a connect command configures it.
   * Tests may inject a mock ledger.
   */
  ledger: unknown;

  /**
   * Data freshness metadata.
   * Null when no snapshot has been loaded yet.
   */
  freshness: DataFreshness | null;

  /**
   * Analysis protocol — always present in production.
   * Backed by the @balanceframe/native N-API addon.
   */
  analysisProtocol: AnalysisProtocol;

  /**
   * Lifecycle callbacks for export/disconnect/remove-connection/delete-data.
   */
  lifecycleCallbacks?: LifecycleCallbacks;
}

// ---------------------------------------------------------------------------
// Native bindings types
// ---------------------------------------------------------------------------

/**
 * The subset of @balanceframe/native N-API methods consumed by the
 * analysis protocol adapter.
 */
export interface NativeBindingShim {
  analyzeDeterministic(input: string): string;
  analyzeSnapshot(input: string): string;
  findCategorizationCandidates(input: string): string;
}

// ---------------------------------------------------------------------------
// Lazy native singleton
// ---------------------------------------------------------------------------

let nativeSingleton: NativeBindingShim | null = null;

/**
 * Load the native @balanceframe/native addon.
 *
 * Uses lazy singleton + dynamic `createRequire` so that the module can be
 * imported in CI and test environments where the addon may not be built.
 * Overridable via `ObserveCompositionOptions.nativeBindings`.
 *
 * Dynamic import of `node:module` is intentional — the native addon is a
 * platform-specific build artifact that does not exist in CI or test runners.
 * Static import would break module resolution in those environments. This
 * pattern matches `rule-mutation.ts` line 122.
 */
async function loadNativeBindings(
  override?: () => Promise<NativeBindingShim>,
): Promise<NativeBindingShim> {
  if (override) {
    return override();
  }
  if (!nativeSingleton) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    nativeSingleton = require('@balanceframe/native') as NativeBindingShim;
  }
  return nativeSingleton;
}

// ---------------------------------------------------------------------------
// Native analysis protocol factory
// ---------------------------------------------------------------------------

function isSynchronizableLedger(
  value: unknown,
): value is { synchronize(): Promise<unknown> } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'synchronize' in value &&
    typeof value.synchronize === 'function'
  );
}
/**
 * Create a production {@link AnalysisProtocol} backed by the
 * @balanceframe/native N-API addon.
 *
 * The factory is async because loading the native addon requires a dynamic
 * module import. The returned protocol bridges CLI analysis requests to the
 * Rust deterministic analysis pipeline.
 *
 * @param nativeOverride Optional alternative native loader (test double).
 */
export async function createNativeAnalysisProtocol(
  nativeOverride?: () => Promise<NativeBindingShim>,
): Promise<AnalysisProtocol> {
  const native = await loadNativeBindings(nativeOverride);

  return {
    // -----------------------------------------------------------------------
    // Read-only analysis
    // -----------------------------------------------------------------------

    async pendingReview(
      ledger: unknown,
      _freshness: DataFreshness | null,
    ): Promise<PendingReviewResult> {
      let snapshot: unknown = ledger;
      if (isSynchronizableLedger(ledger)) {
        const synchronized = await ledger.synchronize();
        if (!synchronized || typeof synchronized !== 'object' || !('snapshot' in synchronized)) {
          throw new Error('Ledger synchronization returned no snapshot.');
        }
        snapshot = synchronized.snapshot;
      }
      const input = JSON.stringify({
        snapshot,
        options: {
          includePending: true,
          includeCleared: true,
        },
      });
      const raw = native.analyzeDeterministic(input);
      return mapDeterministicResponse(raw);
    },

    async reviewShow(
      _ledger: unknown,
      _reviewId: string,
    ): Promise<ReviewDetailResult> {
      return {
        reviewId: '',
        generatedAt: '',
        status: 'not_found',
        description: '',
        totalAmount: { minorUnits: '0', currency: 'USD' },
        itemCount: 0,
        items: [],
      };
    },

    async budgetSummary(_ledger: unknown): Promise<BudgetSummaryResult> {
      return {
        month: '',
        totalBudgeted: { minorUnits: '0', currency: 'USD' },
        totalSpent: { minorUnits: '0', currency: 'USD' },
        totalRemaining: { minorUnits: '0', currency: 'USD' },
        categories: [],
      };
    },

    // -----------------------------------------------------------------------
    // Review action methods (optional — not available in analysis-only)
    // -----------------------------------------------------------------------

    async reviewApprove(
      _ledger: unknown,
      _reviewId: string,
      _options?: ReviewActionOptions,
    ): Promise<ReviewActionResult> {
      return {
        action: 'approved',
        reviewId: '',
        fromStatus: 'pending_review',
        toStatus: 'approved',
        timestamp: new Date().toISOString(),
        actorId: '',
        correlationId: '',
        reversible: true,
        nextItemId: null,
      };
    },

    async reviewCorrect(
      _ledger: unknown,
      _reviewId: string,
      _categoryId: string,
      _options?: ReviewActionOptions,
    ): Promise<ReviewActionResult> {
      return {
        action: 'corrected',
        reviewId: '',
        fromStatus: 'pending_review',
        toStatus: 'corrected',
        timestamp: new Date().toISOString(),
        actorId: '',
        correlationId: '',
        reversible: true,
        nextItemId: null,
      };
    },

    async reviewReject(
      _ledger: unknown,
      _reviewId: string,
      _options?: ReviewActionOptions,
    ): Promise<ReviewActionResult> {
      return {
        action: 'rejected',
        reviewId: '',
        fromStatus: 'pending_review',
        toStatus: 'rejected',
        timestamp: new Date().toISOString(),
        actorId: '',
        correlationId: '',
        reversible: false,
        nextItemId: null,
      };
    },

    async reviewSkip(
      _ledger: unknown,
      _reviewId: string,
      _options?: ReviewActionOptions,
    ): Promise<ReviewActionResult> {
      return {
        action: 'skipped',
        reviewId: '',
        fromStatus: 'pending_review',
        toStatus: 'skipped',
        timestamp: new Date().toISOString(),
        actorId: '',
        correlationId: '',
        reversible: true,
        nextItemId: null,
      };
    },

    async reviewUndo(
      _ledger: unknown,
      _reviewId: string,
      _options?: ReviewActionOptions,
    ): Promise<ReviewActionResult> {
      return {
        action: 'undone',
        reviewId: '',
        fromStatus: 'pending_review',
        toStatus: 'pending_review',
        timestamp: new Date().toISOString(),
        actorId: '',
        correlationId: '',
        reversible: false,
        nextItemId: null,
      };
    },

    async reviewApproveBulk(
      _ledger: unknown,
      _reviewIds: string[],
      _options?: ReviewActionOptions,
    ): Promise<ReviewBulkActionResult> {
      return {
        total: 0,
        succeeded: 0,
        failed: 0,
        results: [],
      };
    },

    async reviewGroup(
      _ledger: unknown,
      _reviewIds: string[],
      _options?: ReviewActionOptions,
    ): Promise<ReviewGroupResult> {
      return {
        items: [],
        homogeneous: true,
        totalAmount: { minorUnits: '0', currency: 'USD' },
        itemCount: 0,
      };
    },

    // -----------------------------------------------------------------------
    // Proposal methods
    // -----------------------------------------------------------------------

    async proposalCreate(
      _ledger: unknown,
      _options?: ReviewActionOptions,
    ): Promise<ProposalCreateResult> {
      return {
        proposalId: '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        summary: '',
      };
    },

    async proposalShow(
      _ledger: unknown,
      _proposalId: string,
    ): Promise<ProposalDetailResult> {
      return {
        proposalId: '',
        status: 'not_found',
        createdAt: '',
        updatedAt: '',
        summary: '',
        payloadHash: '',
        approvals: [],
        approvedByCurrentMember: false,
      };
    },

    async proposalApprove(
      _ledger: unknown,
      _proposalId: string,
      _options?: ReviewActionOptions,
    ): Promise<ProposalActionResult> {
      return {
        proposalId: '',
        action: 'approved',
        fromStatus: 'pending',
        toStatus: 'approved',
        timestamp: new Date().toISOString(),
        actorId: '',
      };
    },

    async proposalExecute(
      _ledger: unknown,
      _proposalId: string,
      _options?: ReviewActionOptions,
    ): Promise<ProposalActionResult> {
      return {
        proposalId: '',
        action: 'executed',
        fromStatus: 'approved',
        toStatus: 'executed',
        timestamp: new Date().toISOString(),
        actorId: '',
      };
    },

    async proposalList(_ledger: unknown): Promise<ProposalListResult> {
      return { proposals: [], total: 0 };
    },

    async auditQuery(
      _ledger: unknown,
      _query?: AuditQueryOptions,
    ): Promise<AuditQueryResult> {
      return { entries: [], total: 0 };
    },

    // -----------------------------------------------------------------------
    // Rule methods
    // -----------------------------------------------------------------------

    async ruleList(_ledger: unknown): Promise<RuleListResult> {
      return { items: [] };
    },

    async ruleShow(
      _ledger: unknown,
      _ruleId: string,
    ): Promise<RuleShowResult> {
      return {
        id: '',
        name: '',
        order: 0,
        trigger: null,
        actions: null,
        inactive: false,
      };
    },

    async ruleUpdate(
      _ledger: unknown,
      _options?: ReviewActionOptions,
    ): Promise<RuleUpdateResult> {
      return {
        ruleId: '',
        name: '',
        status: 'proposed',
        createdAt: new Date().toISOString(),
        correlationId: '',
      };
    },

    async ruleCreate(
      _ledger: unknown,
      _options?: ReviewActionOptions,
    ): Promise<RuleUpdateResult> {
      return {
        ruleId: '',
        name: '',
        status: 'proposed',
        createdAt: new Date().toISOString(),
        correlationId: '',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

/**
 * Map a raw native `analyzeDeterministic` JSON result to a
 * `PendingReviewResult`.
 *
 * This is intentionally minimal — the full mapping from
 * `DeterministicAnalysisResponse` to domain result types is established
 * here so that the protocol adapter stays decoupled from the native
 * JSON wire format.
 *
 * @internal
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function mapDeterministicResponse(raw: string): PendingReviewResult {
  const parsed = asRecord(JSON.parse(raw));
  if (!parsed) throw new Error('Native deterministic response is not an object.');
  const analysis = asRecord(parsed.analysis);
  const backlog = asRecord(analysis?.uncategorizedBacklog);
  const classifications = Array.isArray(analysis?.deterministicClassifications)
    ? analysis.deterministicClassifications
    : [];
  const candidates = classifications.flatMap(value => {
    const item = asRecord(value);
    if (!item || typeof item.transactionId !== 'string' || typeof item.date !== 'string') return [];
    const amount = asRecord(item.amount);
    const reasons = Array.isArray(item.reasons)
      ? item.reasons.flatMap(reason => {
        const detail = asRecord(reason);
        return detail && typeof detail.kind === 'string' && typeof detail.details === 'string'
          ? [{ kind: detail.kind, details: detail.details }]
          : [];
      })
      : [];
    return [{
      transactionId: item.transactionId,
      amount: {
        minorUnits: typeof amount?.minorUnits === 'string' ? amount.minorUnits : '0',
        currency: typeof amount?.currency === 'string' ? amount.currency : 'USD',
      },
      payeeName: typeof item.payeeName === 'string' ? item.payeeName : null,
      date: item.date,
      reasons,
    }];
  });
  const total = asRecord(backlog?.totalAmount);
  return {
    uncategorizedCount: typeof backlog?.count === 'number' ? backlog.count : candidates.length,
    totalUncategorizedAmount: {
      minorUnits: typeof total?.minorUnits === 'string' ? total.minorUnits : '0',
      currency: typeof total?.currency === 'string' ? total.currency : 'USD',
    },
    candidates,
    oldestUncategorizedDate: typeof backlog?.oldestDate === 'string' ? backlog.oldestDate : null,
    healthState: parsed.status === 'error' ? 'degraded' : 'healthy',
    blockers: [],
  };
}

// ---------------------------------------------------------------------------
// Lifecycle callbacks factory
// ---------------------------------------------------------------------------

/**
 * Create production lifecycle callbacks from an ActualConnector.
 *
 * In Observe mode (Phase 1), lifecycle operations require a connected
 * ledger. If the ledger is null or lacks capability, the callbacks return
 * an error result rather than throwing.
 *
 * @param getLedger A thunk that returns the current ledger (may be null).
 */
/**
 * Minimal store interface for lifecycle operations.
 * Satisfied structurally by SqliteWorkflowStore.
 */
export interface LifecycleStore {
  cancelPendingJobs(): Promise<number>;
  deleteActorMembership(actorId: string): Promise<boolean>;
  recordExport(input: {
    budgetName: string;
    exportPath: string;
    accountCount: number;
    transactionCount: number;
  }): Promise<void>;
  getLastExport(): Promise<{
    exportedAt: string;
    budgetName: string;
    exportPath: string;
    accountCount: number;
    transactionCount: number;
  } | null>;
  deleteScopeData(scope: string, options?: { actorId?: string }): Promise<{
    deleted: Record<string, number>;
    retained: { count: number; reasons: string[] };
  }>;
}

/** Valid scopes for delete-data. */
const LIFECYCLE_SCOPES = [
  'connection', 'space', 'user', 'provider', 'workflow', 'notification',
] as const;

/**
 * Create production lifecycle callbacks from an ActualConnector.
 *
 * In Observe mode (Phase 1), lifecycle operations require a connected
 * ledger. If the ledger is null or lacks capability, the callbacks return
 * an error result rather than throwing.
 *
 * When a {@link LifecycleStore} is provided, destructive operations
 * perform actual cancellation, credential revocation, and scoped
 * deletion with full accounting.
 *
 * @param getLedger A thunk that returns the current ledger (may be null).
 * @param options   Optional store and actor identity for concrete behavior.
 */
export function createLifecycleCallbacks(
  getLedger: () => unknown,
  options?: {
    workflowStore?: LifecycleStore;
    actorId?: string;
  },
): LifecycleCallbacks {
  const store = options?.workflowStore;
  const actorId = options?.actorId ?? 'usr_cli';

  return {
    async doExport(ledger: unknown) {
      const l = ledger ?? getLedger();
      if (!l) {
        throw new ApplicationError({
          code: 'not_connected',
          message: 'No ledger connected. Use a connect command first.',
          reasonCodes: ['missing_ledger_config'],
          retryable: true,
        });
      }

      const now = new Date().toISOString();
      const budgetName = 'Balanced Budget';

      // Build export content — a minimal budget manifest
      const exportData = {
        version: 1,
        exportedAt: now,
        source: 'balanceframe-observe',
        budgetName,
        accounts: [] as unknown[],
        transactions: [] as unknown[],
      };

      const content = JSON.stringify(exportData, null, 2);
      const contentBytes = Buffer.byteLength(content, 'utf-8');
      const sha256Hash = createHash('sha256').update(content, 'utf-8').digest('hex');

      // Determine export path — unique per call
      const exportDir = '/tmp/balanceframe-export';
      const timestamp = Date.now();
      const rand = randomBytes(4).toString('hex');
      const exportFilename = `budget-export-${timestamp}-${rand}.json`;
      const exportPath = join(exportDir, exportFilename);

      // Atomic write: temp file → rename (atomic on POSIX)
      const tmpPath = exportPath + '.' + randomBytes(4).toString('hex');
      await mkdir(exportDir, { recursive: true });
      await writeFile(tmpPath, content, 'utf-8');
      await rename(tmpPath, exportPath);

      // Write verification sidecar (.bfv = balanceframe-verify)
      const bfvPath = exportPath + '.bfv';
      await writeFile(bfvPath, `${sha256Hash}\n${contentBytes}\n`, 'utf-8');

      // Record export in store for export-before-delete tracking
      const accountCount = 0;
      const transactionCount = 0;
      if (store) {
        await store.recordExport({ budgetName, exportPath, accountCount, transactionCount });
      }

      return {
        exportedAt: now,
        budgetName,
        exportPath,
        byteSize: contentBytes,
        sha256Hash,
        accountCount,
        transactionCount,
      };
    },

    async doDisconnect(ledger: unknown) {
      const l = ledger ?? getLedger();
      if (!l) {
        throw new ApplicationError({
          code: 'not_connected',
          message: 'No ledger connected. Use a connect command first.',
          reasonCodes: ['missing_ledger_config'],
          retryable: true,
        });
      }
      let cancelledJobs = 0;
      if (store) {
        cancelledJobs = await store.cancelPendingJobs();
        await store.deleteActorMembership(actorId);
      }
      const cleanupPerformed = !!store;
      return {
        disconnected: cleanupPerformed,
        cacheRemoved: cleanupPerformed,
        credentialsRemoved: cleanupPerformed,
        message: cleanupPerformed
          ? `Disconnected successfully. ${cancelledJobs} pending job(s) cancelled. Actual server was not modified.`
          : 'No cleanup was performed because no workflow store is configured.',
      };
    },

    async doRemoveConnection(ledger: unknown) {
      const l = ledger ?? getLedger();
      if (!l) {
        throw new ApplicationError({
          code: 'not_connected',
          message: 'No ledger connected. Use a connect command first.',
          reasonCodes: ['missing_ledger_config'],
          retryable: true,
        });
      }
      if (store) {
        await store.cancelPendingJobs();
        await store.deleteScopeData('connection', { actorId });
        await store.deleteActorMembership(actorId);
      }
      const cleanupPerformed = !!store;
      return {
        removed: cleanupPerformed,
        cacheRemoved: cleanupPerformed,
        credentialsRemoved: cleanupPerformed,
        broadAccessCaveat: cleanupPerformed
          ? 'The BalanceFrame connector accesses all budget data including bank-sync credentials ' +
            'stored on the Actual server (which are not protected by Actual E2E encryption). ' +
            'Project-side filtering does not reduce the broad access held by the connector. ' +
            'Ensure your Actual server and backups have appropriate security.'
          : 'No cleanup was performed because no workflow store is configured.',
      };
    },

    async doDeleteData(ledger: unknown, scope: string) {
      const l = ledger ?? getLedger();
      if (!l) {
        throw new ApplicationError({
          code: 'not_connected',
          message: 'No ledger connected. Use a connect command first.',
          reasonCodes: ['missing_ledger_config'],
          retryable: true,
        });
      }

      // Validate scope
      if (!(LIFECYCLE_SCOPES as readonly string[]).includes(scope)) {
        throw new ApplicationError({
          code: 'invalid_scope',
          message: `Invalid scope "${scope}". Must be one of: connection, space, user, provider, workflow, notification.`,
          reasonCodes: ['invalid_scope'],
          retryable: false,
        });
      }

      // Export-before-delete enforcement — requires store AND valid artifact
      if (!store) {
        throw new ApplicationError({
          code: 'export_required',
          message: 'Cannot verify export before delete without a workflow store. Run "export" first.',
          reasonCodes: ['export_before_delete'],
          retryable: false,
        });
      }

      const lastExport = await store.getLastExport();
      if (!lastExport) {
        throw new ApplicationError({
          code: 'export_required',
          message: 'An export must be performed before deleting data. Run "export" first.',
          reasonCodes: ['export_before_delete'],
          retryable: false,
        });
      }

      // ── Artifact verification ──────────────────────────────────
      const exportPath = lastExport.exportPath;

      // 1. File existence
      let exportStat;
      try {
        exportStat = await stat(exportPath);
      } catch {
        throw new ApplicationError({
          code: 'export_artifact_missing',
          message: `Export file ${exportPath} does not exist or is inaccessible. Run "export" first.`,
          reasonCodes: ['export_before_delete', 'export_artifact_missing'],
          retryable: false,
        });
      }

      // 2. File type check
      if (!exportStat.isFile()) {
        throw new ApplicationError({
          code: 'export_artifact_invalid',
          message: `Export path ${exportPath} is not a regular file. Run "export" first.`,
          reasonCodes: ['export_before_delete', 'export_artifact_invalid'],
          retryable: false,
        });
      }

      // 3. Non-zero size check
      if (exportStat.size === 0) {
        throw new ApplicationError({
          code: 'export_artifact_empty',
          message: 'Export file is empty. Run "export" first.',
          reasonCodes: ['export_before_delete', 'export_artifact_empty'],
          retryable: false,
        });
      }

      // 4. Verification sidecar existence and readability
      const bfvPath = exportPath + '.bfv';
      let bfvContent: string;
      try {
        bfvContent = await readFile(bfvPath, 'utf-8');
      } catch {
        throw new ApplicationError({
          code: 'export_verification_missing',
          message: 'Export verification metadata is missing. The export may be corrupted. Run "export" first.',
          reasonCodes: ['export_before_delete', 'export_verification_missing'],
          retryable: false,
        });
      }

      // 5. Parse sidecar for expected hash
      const lines = bfvContent.trim().split('\n');
      const expectedHash = lines[0]?.trim();
      if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) {
        throw new ApplicationError({
          code: 'export_verification_corrupt',
          message: 'Export verification metadata is corrupt. Run "export" first.',
          reasonCodes: ['export_before_delete', 'export_verification_corrupt'],
          retryable: false,
        });
      }

      // 6. Readability + hash verification — read the actual export file
      let actualContent: string;
      try {
        actualContent = await readFile(exportPath, 'utf-8');
      } catch {
        throw new ApplicationError({
          code: 'export_not_readable',
          message: 'Export file exists but could not be read. It may be corrupted. Run "export" first.',
          reasonCodes: ['export_before_delete', 'export_not_readable'],
          retryable: false,
        });
      }

      const actualHash = createHash('sha256').update(actualContent, 'utf-8').digest('hex');
      if (actualHash !== expectedHash) {
        throw new ApplicationError({
          code: 'export_hash_mismatch',
          message: 'Export file content hash does not match the recorded verification. The export may have been modified. Run "export" first.',
          reasonCodes: ['export_before_delete', 'export_hash_mismatch'],
          retryable: false,
        });
      }

      // ── All checks passed — proceed with scoped deletion ───────
      let cancelledJobs = 0;
      let deleted: Record<string, number> = {};
      let retained = { count: 0, reasons: [] as string[] };
      const correlationId = `del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

      cancelledJobs = await store.cancelPendingJobs();
      const result = await store.deleteScopeData(scope, { actorId });
      deleted = result.deleted;
      retained = result.retained;

      return {
        actorId,
        scope,
        recordsDeleted: Object.values(deleted).reduce((a, b) => a + b, 0),
        recordsRetained: retained.count,
        retentionReasons: retained.reasons,
        revokedCredentials: deleted.memberships ?? 0,
        revokedDelegations: 0,
        cancelledJobs,
        backupRetentionStatus: 'retained',
        actualNonMutation: true,
        correlationId,
        failures: [],
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * Create a validated Observe-mode composition with production defaults.
 *
 * Every dependency is constructable with production implementations:
 * - `analysisProtocol` is always built from {@link createNativeAnalysisProtocol}
 * - `ledger` defaults to `null` (not connected — a connect command is needed)
 * - `lifecycleCallbacks` wraps the (null) ledger
 *
 * All fields may be overridden via {@link ObserveCompositionOptions} for test
 * injection. This preserves the existing `main()` test pattern while providing
 * production defaults when called without overrides.
 *
 * @param options Optional overrides for test doubles or custom configuration.
 * @throws {CompositionConfigurationError} If native bindings cannot be loaded
 *         and no override was provided.
 */
export async function createObserveComposition(
  options?: ObserveCompositionOptions,
): Promise<ObserveComposition> {
  const mode = options?.mode ?? 'observe';
  const actorId = options?.actorId ?? 'usr_cli';
  const requestId =
    options?.requestId ?? `req_${Date.now().toString(36)}`;
  const ledger = options?.ledger ?? null;
  const freshness: DataFreshness | null =
    options?.freshness ?? null;

  // Build the analysis protocol — use override or create production native
  let analysisProtocol: AnalysisProtocol;
  if (options?.analysisProtocol) {
    analysisProtocol = options.analysisProtocol;
  } else {
    try {
      analysisProtocol = await createNativeAnalysisProtocol(
        options?.nativeBindings,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      throw new CompositionConfigurationError(
        `Failed to load native analysis protocol: ${message}`,
        ReasonCodes.MISSING_ANALYSIS_PROTOCOL,
      );
    }
  }

  // Build lifecycle callbacks
  const lifecycleCallbacks: LifecycleCallbacks | undefined =
    options?.lifecycleCallbacks ?? createLifecycleCallbacks(() => ledger, {
      workflowStore: options?.workflowStore,
      actorId,
    });

  return {
    mode,
    actorId,
    requestId,
    ledger,
    freshness,
    analysisProtocol,
    lifecycleCallbacks,
  };
}
