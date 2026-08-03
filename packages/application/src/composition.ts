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
  PurchaseEvaluationResult,
  PurchaseEvaluationParams,
  CashFlowProjectionResult,
  CashFlowProjectionParams,
  TargetHealthResult,
  SinkingFundHealthResult,
  FinancialStateResult,
  ReportGenerationResult,
  ReportGenerationParams,
  SavedViewsListResult,
  CreateSavedViewResult,
  CreateSavedViewParams,
  AttentionHomeResult,
  AttentionHomeParams,
  CategoryHealthResult,
  AttentionAlert,
  AttentionBlocker,
  RecurrencePattern,
  CategoryRisk,
  DataQualityResult,
  QualityDimension,
  LiquidityCoverageResult,
  UpcomingObligation,
  BillCalendarResult,
  BillCalendarEntry,
  BudgetVarianceResult,
  CategoryVariance,
  TrendDirection,
  CategoryTrend,
  IrregularObligationsResult,
  IrregularObligation,
  IrregularityKind,
  IncomeReliabilityResult,
  IncomeSource,
  ForecastCalibrationResult,
  CalibrationMetric,
  ScenarioComparisonResult,
  ScenarioComparisonDelta,
  ScenarioComparisonParams,
  MultidimensionalHealthResult,
  HealthDimension,
} from './commands.js';
import type { DataFreshness } from './envelope.js';
import { ReasonCodes } from './errors.js';
import { ApplicationError } from './errors.js';
import { NotificationRuntime, InAppChannelAdapter } from './notifications.js';
import type { NotificationPolicy } from './notifications.js';
import type { WorkflowStore } from '@balanceframe/workflow-store';
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
   * Workflow store override for lifecycle and (optionally) notification
   * operations.
   *
   * When provided, destructive lifecycle callbacks perform actual
   * cancellation, credential revocation, and scoped deletion.
   *
   * If the store also exposes the notification-store methods defined by
   * {@link NotificationStoreMethods}, a {@link NotificationRuntime} is
   * constructed automatically and exposed via
   * {@link ObserveComposition.notificationRuntime}.
   */
  workflowStore?: {
    cancelPendingJobs(): Promise<number>;
    deleteActorMembership(actorId: string): Promise<boolean>;
    recordExport(input: { budgetName: string; exportPath: string; accountCount: number; transactionCount: number }): Promise<void>;
    getLastExport(): Promise<{ exportedAt: string; budgetName: string; exportPath: string; accountCount: number; transactionCount: number } | null>;
    deleteScopeData(scope: string, options?: { actorId?: string }): Promise<{ deleted: Record<string, number>; retained: { count: number; reasons: string[] } }>;
  } & Partial<NotificationStoreMethods>;

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

  /**
   * Notification runtime override.
   * When provided, the composition uses this instance instead of constructing
   * one from the workflow store.
   */
  notificationRuntime?: NotificationRuntime;

  /**
   * Default notification policy for constructing the NotificationRuntime.
   * Only used when `notificationRuntime` is not explicitly provided and a
   * workflow store with notification capabilities is available.
   */
  notificationPolicy?: NotificationPolicy;
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

  /**
   * Notification runtime for policy evaluation and delivery.
   * Populated when a workflow store with notification capabilities is
   * available or when explicitly injected via options.
   */
  notificationRuntime: NotificationRuntime | null;
}

// ---------------------------------------------------------------------------
// Notification store methods — subset of WorkflowStore for notifications
// ---------------------------------------------------------------------------

/**
 * The subset of {@link WorkflowStore} methods required by
 * {@link NotificationRuntime}.
 *
 * When a store passed via {@link ObserveCompositionOptions.workflowStore}
 * satisfies this interface structurally, a {@link NotificationRuntime} is
 * constructed automatically (rather than defaulting to `null`).  The
 * methods are declared as optional in the options type so that callers
 * providing only lifecycle functionality are not broken.
 */
export type NotificationStoreMethods = Pick<WorkflowStore,
  | 'createNotificationEvent'
  | 'getNotificationEvent'
  | 'enqueueNotification'
  | 'claimNotificationDelivery'
  | 'completeNotificationDelivery'
  | 'failNotificationDelivery'
  | 'acknowledgeNotification'
  | 'suppressNotification'
  | 'getOutboxRecord'
  | 'getPendingNotifications'
  | 'getRetryableNotifications'
  | 'getDeliveryAttempts'
  | 'listOutboxRecords'
  | 'getNotificationPolicy'
  | 'getActorMembership'
  | 'appendAuditRecord'
>;

/**
 * Type guard: returns `true` when `store` satisfies
 * {@link NotificationStoreMethods} (i.e. it has all required notification
 * methods).  Used in {@link createObserveComposition} to decide whether
 * to construct a {@link NotificationRuntime} from a generic store.
 */
function isNotificationStore(
  store: Record<string, unknown>,
): store is NotificationStoreMethods {
  const required: Array<keyof NotificationStoreMethods> = [
    'createNotificationEvent',
    'enqueueNotification',
    'getNotificationEvent',
    'getPendingNotifications',
    'getRetryableNotifications',
    'listOutboxRecords',
    'getNotificationPolicy',
    'getActorMembership',
    'appendAuditRecord',
  ];
  return required.every((method) => typeof store[method] === 'function');
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

  // Phase 8 — Budget Intelligence N-API methods
  /** Evaluate a proposed purchase against budget limits. */
  evaluatePurchase(input: string): string;
  /** Project future cash flow based on schedules and budgets. */
  projectCashFlow(input: string): string;
  /** Evaluate target/sinking-fund health. */
  evaluateTargetHealth(input: string): string;
  /** Evaluate overall financial state. */
  evaluateFinancialState(input: string): string;

  // Phase 8.5 — Extended deterministic analytics N-API methods
  /** Compute composite data-quality report. */
  computeDataQuality(input: string): string;
  /** Compute liquidity coverage. */
  computeLiquidityCoverage(input: string): string;
  /** Compute bill calendar. */
  computeBillCalendar(input: string): string;
  /** Compute budget variance and trends. */
  computeBudgetVariance(input: string): string;
  /** Detect irregular obligations. */
  detectIrregularObligations(input: string): string;
  /** Assess income reliability. */
  assessIncomeReliability(input: string): string;
  /** Evaluate forecast calibration. */
  evaluateForecastCalibration(input: string): string;
  /** Compare two immutable scenarios. */
  compareScenarios(input: string): string;
  /** Compute multidimensional health assessment. */
  evaluateMultidimensionalHealth(input: string): string;
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
 * Type guard: true when `value` has a `disconnect(): Promise<void>` method.
 * Used to detect BudgetLedger instances that support disconnect cleanup.
 */
function isDisconnectableLedger(
  value: unknown,
): value is { disconnect(): Promise<void> } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'disconnect' in value &&
    typeof (value as Record<string, unknown>).disconnect === 'function'
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

  // -----------------------------------------------------------------------
  // Helper functions — synchronize ledger and extract snapshot data
  // -----------------------------------------------------------------------

  /**
   * Synchronize the ledger and extract the snapshot for analysis.
   * If the ledger is not synchronizable, returns null.
   */
  const obtainSnapshot = async (ledger: unknown): Promise<unknown> => {
    if (!isSynchronizableLedger(ledger)) return null;
    const syncResult = await ledger.synchronize();
    if (!syncResult || typeof syncResult !== 'object' || !('snapshot' in syncResult)) return null;
    return (syncResult as Record<string, unknown>).snapshot;
  };

  // Native response parsing helpers -----------------------------------------

  const asMoney = (value: unknown): { minorUnits: string; currency: string } | null => {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    return typeof v.minorUnits === 'string' && typeof v.currency === 'string'
      ? { minorUnits: v.minorUnits, currency: v.currency }
      : null;
  };

  const parsePurchaseResponse = (raw: string): PurchaseEvaluationResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native evaluatePurchase returned invalid JSON.'); }
    return {
      allowable: parsed.allowable === true,
      reasonCodes: Array.isArray(parsed.reasonCodes) ? parsed.reasonCodes.map(String) : ['unknown'],
      categoryBudget: asMoney(parsed.categoryBudget) ?? { minorUnits: '0', currency: 'USD' },
      categorySpent: asMoney(parsed.categorySpent) ?? { minorUnits: '0', currency: 'USD' },
      categoryRemaining: asMoney(parsed.categoryRemaining) ?? { minorUnits: '0', currency: 'USD' },
      projectedBalance: asMoney(parsed.projectedBalance),
      hasEnvelope: parsed.hasEnvelope === true,
    };
  };

  const parseCashFlowResponse = (raw: string, requestedMonths: number): CashFlowProjectionResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native projectCashFlow returned invalid JSON.'); }
    const projections = Array.isArray(parsed.monthlyProjections) ? parsed.monthlyProjections : [];
    return {
      projectionMonths: requestedMonths,
      monthlyProjections: projections.map((p: unknown) => {
        const m = p as Record<string, unknown>;
        return {
          month: String(m.month ?? ''),
          projectedIncome: asMoney(m.projectedIncome) ?? { minorUnits: '0', currency: 'USD' },
          projectedExpenses: asMoney(m.projectedExpenses) ?? { minorUnits: '0', currency: 'USD' },
          netChange: asMoney(m.netChange) ?? { minorUnits: '0', currency: 'USD' },
          endingBalance: asMoney(m.endingBalance) ?? { minorUnits: '0', currency: 'USD' },
          scheduledIncomeCount: typeof m.scheduledIncomeCount === 'number' ? m.scheduledIncomeCount : 0,
          scheduledExpenseCount: typeof m.scheduledExpenseCount === 'number' ? m.scheduledExpenseCount : 0,
        };
      }),
      sufficientData: parsed.sufficientData === true,
      dataWarning: typeof parsed.dataWarning === 'string' ? parsed.dataWarning : null,
    };
  };

  const parseTargetHealthResponse = (raw: string): TargetHealthResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native evaluateTargetHealth returned invalid JSON.'); }
    const categories = Array.isArray(parsed.categories) ? parsed.categories : [];
    const mapped = categories.map((c: unknown) => {
      const cat = c as Record<string, unknown>;
      return {
        categoryId: String(cat.categoryId ?? ''),
        categoryName: String(cat.categoryName ?? ''),
        budgeted: asMoney(cat.budgeted) ?? { minorUnits: '0', currency: 'USD' },
        spent: asMoney(cat.spent) ?? { minorUnits: '0', currency: 'USD' },
        remaining: asMoney(cat.remaining) ?? { minorUnits: '0', currency: 'USD' },
        healthLabel: String(cat.healthLabel ?? 'unknown'),
        isSinkingFund: cat.isSinkingFund === true,
        targetAmount: asMoney(cat.targetAmount),
        targetProgress: typeof cat.targetProgress === 'number' ? cat.targetProgress : null,
      } as CategoryHealthResult;
    });
    return {
      categories: mapped,
      overallLabel: String(parsed.overallLabel ?? 'unknown'),
      healthyCount: typeof parsed.healthyCount === 'number' ? parsed.healthyCount : 0,
      atRiskCount: typeof parsed.atRiskCount === 'number' ? parsed.atRiskCount : 0,
      sinkingFundCount: typeof parsed.sinkingFundCount === 'number' ? parsed.sinkingFundCount : 0,
    };
  };

  const parseFinancialStateResponse = (raw: string): FinancialStateResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native evaluateFinancialState returned invalid JSON.'); }
    return {
      overallLabel: String(parsed.overallLabel ?? 'unknown'),
      netWorth: asMoney(parsed.netWorth) ?? { minorUnits: '0', currency: 'USD' },
      monthlyCashFlow: asMoney(parsed.monthlyCashFlow) ?? { minorUnits: '0', currency: 'USD' },
      budgetAdherencePercent: typeof parsed.budgetAdherencePercent === 'number' ? parsed.budgetAdherencePercent : 0,
      categoriesAtRisk: typeof parsed.categoriesAtRisk === 'number' ? parsed.categoriesAtRisk : 0,
      sinkingFundsUnderfunded: typeof parsed.sinkingFundsUnderfunded === 'number' ? parsed.sinkingFundsUnderfunded : 0,
      advice: Array.isArray(parsed.advice) ? parsed.advice.map(String) : [],
      freshness: null,
    };
  };

  // Phase 8.5 parsing helpers ---------------------------------------------

  const parseDataQualityResponse = (raw: string): DataQualityResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native computeDataQuality returned invalid JSON.'); }
    const dims = Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
    return {
      overallScore: typeof parsed.overallScore === 'number' ? parsed.overallScore : null,
      dimensions: dims.map((d: unknown) => {
        const dim = d as Record<string, unknown>;
        return {
          dimension: String(dim.dimension ?? dim.name ?? ''),
          score: typeof dim.score === 'number' ? dim.score : null,
          explanation: String(dim.explanation ?? (Array.isArray(dim.details) ? dim.details[0] : undefined) ?? ''),
          worstSeverity: typeof dim.worstSeverity === 'string' ? dim.worstSeverity : null,
        };
      }),
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : [],
    };
  };

  const parseLiquidityCoverageResponse = (raw: string): LiquidityCoverageResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native computeLiquidityCoverage returned invalid JSON.'); }
    const obligations = Array.isArray(parsed.upcomingObligations) ? parsed.upcomingObligations : [];
    return {
      totalLiquid: asMoney(parsed.totalLiquid),
      totalObligations: asMoney(parsed.totalObligations),
      coverage: Array.isArray(parsed.coverage) ? parsed.coverage.map((c: unknown) => {
        const cr = c as Record<string, unknown>;
        return { ratio: typeof cr.ratio === 'number' ? cr.ratio : 0, label: String(cr.label ?? '') };
      }) : [],
      upcomingObligations: obligations.map((o: unknown) => {
        const ob = o as Record<string, unknown>;
        return {
          name: String(ob.name ?? ''),
          dueDate: String(ob.dueDate ?? ''),
          amount: asMoney(ob.amount) ?? { minorUnits: '0', currency: 'USD' },
          categoryId: typeof ob.categoryId === 'string' ? ob.categoryId : null,
          isRecurring: ob.isRecurring === true,
        } as UpcomingObligation;
      }),
    };
  };

  const parseBillCalendarResponse = (raw: string): BillCalendarResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native computeBillCalendar returned invalid JSON.'); }
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return {
      entries: entries.map((e: unknown) => {
        const entry = e as Record<string, unknown>;
        return {
          name: String(entry.name ?? ''),
          dueDate: String(entry.dueDate ?? ''),
          amount: asMoney(entry.amount) ?? { minorUnits: '0', currency: 'USD' },
          categoryId: typeof entry.categoryId === 'string' ? entry.categoryId : null,
          status: String(entry.status ?? 'unknown'),
        } as BillCalendarEntry;
      }),
      totalUnpaid: asMoney(parsed.totalUnpaid),
      unpaidCount: typeof parsed.unpaidCount === 'number' ? parsed.unpaidCount : 0,
    };
  };

  const parseBudgetVarianceResponse = (raw: string): BudgetVarianceResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native computeBudgetVariance returned invalid JSON.'); }
    return {
      categoryVariances: Array.isArray(parsed.categoryVariances) ? parsed.categoryVariances.map((v: unknown) => {
        const cv = v as Record<string, unknown>;
        return {
          categoryId: String(cv.categoryId ?? ''),
          categoryName: String(cv.categoryName ?? ''),
          budgeted: asMoney(cv.budgeted) ?? { minorUnits: '0', currency: 'USD' },
          actual: asMoney(cv.actual) ?? { minorUnits: '0', currency: 'USD' },
          variance: asMoney(cv.variance) ?? { minorUnits: '0', currency: 'USD' },
          variancePercent: typeof cv.variancePercent === 'number' ? cv.variancePercent : 0,
          label: String(cv.label ?? ''),
        } as CategoryVariance;
      }) : [],
      trends: Array.isArray(parsed.trends) ? parsed.trends.map((t: unknown) => {
        const tr = t as Record<string, unknown>;
        return {
          categoryId: String(tr.categoryId ?? ''),
          categoryName: String(tr.categoryName ?? ''),
          direction: String(tr.direction ?? 'stable') as TrendDirection,
          avgChange: typeof tr.avgChange === 'number' ? tr.avgChange : 0,
          periodsAnalyzed: typeof tr.periodsAnalyzed === 'number' ? tr.periodsAnalyzed : 0,
          seasonalityDetected: tr.seasonalityDetected === true,
        } as CategoryTrend;
      }) : [],
      totalBudgeted: asMoney(parsed.totalBudgeted),
      totalActual: asMoney(parsed.totalActual),
      totalVariance: asMoney(parsed.totalVariance),
      overallVariancePercent: typeof parsed.overallVariancePercent === 'number' ? parsed.overallVariancePercent : null,
    };
  };

  const parseIrregularObligationsResponse = (raw: string): IrregularObligationsResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native detectIrregularObligations returned invalid JSON.'); }
    return {
      obligations: Array.isArray(parsed.obligations) ? parsed.obligations.map((o: unknown) => {
        const ob = o as Record<string, unknown>;
        return {
          name: String(ob.name ?? ''),
          kind: String(ob.kind ?? 'nonMonthly') as IrregularityKind,
          typicalAmount: asMoney(ob.typicalAmount) ?? { minorUnits: '0', currency: 'USD' },
          frequency: String(ob.frequency ?? ''),
          categoryId: typeof ob.categoryId === 'string' ? ob.categoryId : null,
          nextExpectedDate: typeof ob.nextExpectedDate === 'string' ? ob.nextExpectedDate : null,
        } as IrregularObligation;
      }) : [],
      totalEstimatedAnnual: asMoney(parsed.totalEstimatedAnnual),
    };
  };

  const parseIncomeReliabilityResponse = (raw: string): IncomeReliabilityResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native assessIncomeReliability returned invalid JSON.'); }
    return {
      sources: Array.isArray(parsed.sources) ? parsed.sources.map((s: unknown) => {
        const src = s as Record<string, unknown>;
        return {
          name: String(src.name ?? ''),
          typicalMonthly: asMoney(src.typicalMonthly) ?? { minorUnits: '0', currency: 'USD' },
          reliabilityScore: typeof src.reliabilityScore === 'number' ? src.reliabilityScore : 0,
          variability: typeof src.variability === 'number' ? src.variability : 0,
          paymentCount: typeof src.paymentCount === 'number' ? src.paymentCount : 0,
          isRegular: src.isRegular === true,
        } as IncomeSource;
      }) : [],
      totalMonthly: asMoney(parsed.totalMonthly),
      overallScore: typeof parsed.overallScore === 'number' ? parsed.overallScore : null,
      unreliableSourceCount: typeof parsed.unreliableSourceCount === 'number' ? parsed.unreliableSourceCount : 0,
    };
  };

  const parseForecastCalibrationResponse = (raw: string): ForecastCalibrationResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native evaluateForecastCalibration returned invalid JSON.'); }
    return {
      metrics: Array.isArray(parsed.metrics) ? parsed.metrics.map((m: unknown) => {
        const metric = m as Record<string, unknown>;
        return {
          metricName: String(metric.metricName ?? ''),
          mape: typeof metric.mape === 'number' ? metric.mape : null,
          bias: typeof metric.bias === 'number' ? metric.bias : null,
          periodsCompared: typeof metric.periodsCompared === 'number' ? metric.periodsCompared : 0,
          isCalibrated: metric.isCalibrated === true,
        } as CalibrationMetric;
      }) : [],
      overallCalibrated: parsed.overallCalibrated === true,
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : [],
    };
  };

  const parseScenarioComparisonResponse = (raw: string): ScenarioComparisonResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native compareScenarios returned invalid JSON.'); }
    return {
      deltas: Array.isArray(parsed.deltas) ? parsed.deltas.map((d: unknown) => {
        const delta = d as Record<string, unknown>;
        return {
          dimension: String(delta.dimension ?? ''),
          baselineValue: delta.baselineValue,
          comparisonValue: delta.comparisonValue,
          change: String(delta.change ?? ''),
        } as ScenarioComparisonDelta;
      }) : [],
      summary: String(parsed.summary ?? ''),
    };
  };

  const parseMultidimensionalHealthResponse = (raw: string): MultidimensionalHealthResult => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error('Native evaluateMultidimensionalHealth returned invalid JSON.'); }
    return {
      dimensions: Array.isArray(parsed.dimensions) ? parsed.dimensions.map((d: unknown) => {
        const dim = d as Record<string, unknown>;
        return {
          dimension: String(dim.dimension ?? ''),
          score: typeof dim.score === 'number' ? dim.score : 0,
          weight: typeof dim.weight === 'number' ? dim.weight : 0,
          explanation: String(dim.explanation ?? ''),
          severity: String(dim.severity ?? 'info'),
        } as HealthDimension;
      }) : [],
      compositeScore: typeof parsed.compositeScore === 'number' ? parsed.compositeScore : 0,
      summary: String(parsed.summary ?? ''),
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : [],
    };
  };

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

    // -----------------------------------------------------------------------
    // Budget Intelligence — native-backed analytics
    // -----------------------------------------------------------------------


    // purchaseEvaluation
    // ------------------------------------------------------------------

    async purchaseEvaluation(
      ledger: unknown,
      params: PurchaseEvaluationParams,
    ): Promise<PurchaseEvaluationResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return {
          allowable: false,
          reasonCodes: ['no_snapshot'],
          categoryBudget: { minorUnits: '0', currency: 'USD' },
          categorySpent: { minorUnits: '0', currency: 'USD' },
          categoryRemaining: { minorUnits: '0', currency: 'USD' },
          projectedBalance: null,
          hasEnvelope: false,
        };
      }
      const proposedTransaction = {
        id: '',
        accountId: params.accountId ?? '',
        date: new Date().toISOString().slice(0, 10),
        amount: params.amount,
        payeeId: null,
        payeeName: null,
        categoryId: params.categoryId,
        categoryName: null,
        cleared: false,
        reconciled: false,
        importedId: null,
        importedPayee: null,
        notes: null,
        tags: [],
        transferAccountId: null,
        subtransactions: [],
      };
      const input = JSON.stringify({
        snapshot: rawSnapshot,
        proposedTransaction,
        categoryId: params.categoryId,
      });
      const raw = native.evaluatePurchase(input);
      return parsePurchaseResponse(raw);
    },

    // ------------------------------------------------------------------
    // cashFlowProjection
    // ------------------------------------------------------------------

    async cashFlowProjection(
      ledger: unknown,
      params: CashFlowProjectionParams,
    ): Promise<CashFlowProjectionResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return {
          projectionMonths: params.months,
          monthlyProjections: [],
          sufficientData: false,
          dataWarning: 'Ledger snapshot unavailable.',
        };
      }
      const input = JSON.stringify({
        snapshot: rawSnapshot,
        projectionMonths: params.months,
      });
      const raw = native.projectCashFlow(input);
      return parseCashFlowResponse(raw, params.months);
    },

    // ------------------------------------------------------------------
    // targetHealth
    // ------------------------------------------------------------------

    async targetHealth(
      ledger: unknown,
    ): Promise<TargetHealthResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { categories: [], overallLabel: 'unknown', healthyCount: 0, atRiskCount: 0, sinkingFundCount: 0 };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot });
      const raw = native.evaluateTargetHealth(input);
      return parseTargetHealthResponse(raw);
    },

    // ------------------------------------------------------------------
    // sinkingFundHealth — derived from evaluateTargetHealth response
    // ------------------------------------------------------------------

    async sinkingFundHealth(
      ledger: unknown,
    ): Promise<SinkingFundHealthResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { sinkingFunds: [], fullyFundedCount: 0, partiallyFundedCount: 0, unfundedCount: 0 };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot });
      const raw = native.evaluateTargetHealth(input);
      const targetHealth = parseTargetHealthResponse(raw);

      const sinkingFunds = targetHealth.categories.filter(c => c.isSinkingFund);
      let fullyFundedCount = 0;
      let partiallyFundedCount = 0;
      let unfundedCount = 0;
      for (const sf of sinkingFunds) {
        const progress = sf.targetProgress ?? 0;
        if (progress >= 1) fullyFundedCount++;
        else if (progress > 0) partiallyFundedCount++;
        else unfundedCount++;
      }
      return { sinkingFunds, fullyFundedCount, partiallyFundedCount, unfundedCount };
    },

    // ------------------------------------------------------------------
    // generateReport — transaction filtering (no native binding)
    // ------------------------------------------------------------------

    async generateReport(
      ledger: unknown,
      params: ReportGenerationParams,
    ): Promise<ReportGenerationResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return {
          reportId: '',
          reportType: params.reportType,
          scope: params.scope,
          label: params.label ?? '',
          transactionCount: 0,
          totalAmount: { minorUnits: '0', currency: 'USD' },
          generatedAt: new Date().toISOString(),
          tags: params.tags ?? [],
        };
      }
      const s = rawSnapshot as Record<string, unknown>;
      const transactions = (s.transactions as Array<Record<string, unknown>> | undefined) ?? [];

      const currency = 'USD';
      const monthRange = params.scope.monthRange;
      const [startStr, endStr] = monthRange.includes(':')
        ? monthRange.split(':')
        : [monthRange, monthRange];

      const filtered = transactions.filter(tx => {
        if (tx.pending && !params.scope.includePending) return false;
        return String(tx.date ?? '') >= startStr && String(tx.date ?? '') <= (endStr + '-31');
      });

      let totalMinor = 0;
      for (const tx of filtered) {
        const amt = tx.amount as Record<string, unknown> | undefined;
        totalMinor += Math.abs(parseInt(String(amt?.minorUnits ?? '0'), 10));
      }

      const idInput = `rpt_${params.reportType}_${monthRange}`;
      const reportId = `rpt_${createHash('sha1').update(idInput).digest('hex').slice(0, 12)}`;

      return {
        reportId,
        reportType: params.reportType,
        scope: params.scope,
        label: params.label ?? '',
        transactionCount: filtered.length,
        totalAmount: { minorUnits: String(totalMinor), currency },
        generatedAt: new Date().toISOString(),
        tags: params.tags ?? [],
      };
    },

    // ------------------------------------------------------------------
    // listSavedViews
    // ------------------------------------------------------------------

    async listSavedViews(
      _ledger: unknown,
    ): Promise<SavedViewsListResult> {
      return { views: [], total: 0 };
    },

    // ------------------------------------------------------------------
    // createSavedView
    // ------------------------------------------------------------------

    async createSavedView(
      _ledger: unknown,
      params: CreateSavedViewParams,
    ): Promise<CreateSavedViewResult> {
      const idInput = `view_${params.name}_${params.viewType}`;
      const viewId = `view_${createHash('sha1').update(idInput).digest('hex').slice(0, 12)}`;

      return {
        view: {
          viewId,
          name: params.name,
          viewType: params.viewType,
          scope: params.scope,
          sort: params.sort,
          createdAt: new Date().toISOString(),
        },
      };
    },

    // ------------------------------------------------------------------
    // financialState
    // ------------------------------------------------------------------

    async financialState(
      ledger: unknown,
    ): Promise<FinancialStateResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return {
          overallLabel: 'unknown',
          netWorth: { minorUnits: '0', currency: 'USD' },
          monthlyCashFlow: { minorUnits: '0', currency: 'USD' },
          budgetAdherencePercent: 0,
          categoriesAtRisk: 0,
          sinkingFundsUnderfunded: 0,
          advice: ['Ledger snapshot unavailable.'],
          freshness: null,
        };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot });
      const raw = native.evaluateFinancialState(input);
      return parseFinancialStateResponse(raw);
    },

    // ------------------------------------------------------------------
    // attentionHome — aggregates native deterministic outputs
    // ------------------------------------------------------------------

    async attentionHome(
      ledger: unknown,
      params: AttentionHomeParams,
    ): Promise<AttentionHomeResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return {
          blockers: [],
          alerts: [],
          recurrences: [],
          categoryRisks: [],
          targetProgress: { overallLabel: 'unknown', healthyCount: 0, atRiskCount: 0, sinkingFundsOnTrack: 0, totalSinkingFunds: 0 },
        };
      }

      // Obtain native deterministic outputs
      const targetHealthInput = JSON.stringify({ snapshot: rawSnapshot });
      const targetHealthRaw = native.evaluateTargetHealth(targetHealthInput);
      const targetHealth = parseTargetHealthResponse(targetHealthRaw);

      let financialState: FinancialStateResult | null = null;
      try {
        const finStateInput = JSON.stringify({ snapshot: rawSnapshot });
        const finStateRaw = native.evaluateFinancialState(finStateInput);
        financialState = parseFinancialStateResponse(finStateRaw);
      } catch {
        // Financial state is supplementary; non-fatal if unavailable
      }

      const s = rawSnapshot as Record<string, unknown>;
      const transactions = (s.transactions as Array<Record<string, unknown>> | undefined) ?? [];
      const payees = (s.payees as Array<Record<string, unknown>> | undefined) ?? [];
      const currency = 'USD';

      // Blockers: uncategorized transactions (counting/filtering only)
      const uncategorizedTxs = transactions.filter(
        tx => (!tx.categoryId || tx.categoryId === '') && !tx.pending,
      );
      const blockers: AttentionBlocker[] = uncategorizedTxs.length > 0
        ? [{ code: 'uncategorized_transactions', message: `${uncategorizedTxs.length} transaction(s) lack categories`, severity: 'warning', entityType: 'transaction' }]
        : [];

      // Alerts: derive from native target health overspent labels
      const alerts: AttentionAlert[] = [];
      for (const cat of targetHealth.categories) {
        if (cat.healthLabel === 'overspent') {
          alerts.push({
            code: 'category_overspent',
            message: `${cat.categoryName} is overspent`,
            severity: 'warning',
            categoryId: cat.categoryId,
            categoryName: cat.categoryName,
          });
        }
      }

      // Recurrences: pattern detection from snapshot (counting/aggregation, not money arithmetic)
      const recurrences: RecurrencePattern[] = [];
      const schedCounts: Record<string, { count: number; lastDate: string; amount: string }> = {};
      for (const tx of transactions) {
        if (tx.payeeId) {
          const key = String(tx.payeeId);
          if (!schedCounts[key]) schedCounts[key] = { count: 0, lastDate: '', amount: '0' };
          schedCounts[key].count++;
          const amt = tx.amount as Record<string, unknown> | undefined;
          if (amt && typeof amt.minorUnits === 'string') {
            schedCounts[key].amount = amt.minorUnits;
          }
          if (String(tx.date ?? '') > schedCounts[key].lastDate) schedCounts[key].lastDate = String(tx.date);
        }
      }
      for (const [payeeId, info] of Object.entries(schedCounts)) {
        if (info.count >= 3) {
          const payee = payees.find(p => p.id === payeeId);
          recurrences.push({
            payeeName: String(payee?.name ?? payeeId),
            amount: { minorUnits: info.amount, currency },
            frequency: info.count >= 6 ? 'monthly' : 'irregular',
            occurrences: info.count,
            lastOccurrence: info.lastDate,
            isEstimated: false,
          });
        }
      }

      // Category risks: derive from native target health labels
      const categoryRisks: CategoryRisk[] = [];
      for (const cat of targetHealth.categories) {
        let risk: 'low' | 'medium' | 'high';
        const reasonCodes: string[] = [];
        switch (cat.healthLabel) {
          case 'overspent':
            risk = 'high';
            reasonCodes.push('overspent');
            break;
          case 'at_risk':
            risk = 'medium';
            reasonCodes.push('nearly_depleted');
            break;
          case 'underfunded':
            risk = 'medium';
            reasonCodes.push('underfunded');
            break;
          default:
            risk = 'low';
            reasonCodes.push('on_track');
            break;
        }
        categoryRisks.push({
          categoryId: cat.categoryId,
          categoryName: cat.categoryName,
          risk,
          reasonCodes,
          remainingBudget: cat.remaining,
          daysRemaining: null,
        });
      }

      // Target progress: use native counts directly
      const sinkingFundCategories = targetHealth.categories.filter(c => c.isSinkingFund);
      const sinkingFundsOnTrack = sinkingFundCategories.filter(sf => (sf.targetProgress ?? 0) >= 0.8).length;

      return {
        blockers,
        alerts,
        recurrences,
        categoryRisks,
        targetProgress: {
          overallLabel: targetHealth.overallLabel,
          healthyCount: targetHealth.healthyCount,
          atRiskCount: targetHealth.atRiskCount,
          sinkingFundsOnTrack,
          totalSinkingFunds: targetHealth.sinkingFundCount,
        },
      };
    },

    // -----------------------------------------------------------------------
    // Phase 8.5 — Extended deterministic analytics
    // -----------------------------------------------------------------------

    async dataQuality(ledger: unknown): Promise<DataQualityResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { overallScore: null, dimensions: [], recommendations: ['Ledger snapshot unavailable.'] };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot });
      const raw = native.computeDataQuality(input);
      return parseDataQualityResponse(raw);
    },

    async liquidityCoverage(ledger: unknown, currentMonth: string): Promise<LiquidityCoverageResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { totalLiquid: null, totalObligations: null, coverage: [], upcomingObligations: [] };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot, currentMonth });
      const raw = native.computeLiquidityCoverage(input);
      return parseLiquidityCoverageResponse(raw);
    },

    async billCalendar(ledger: unknown, referenceDate: string): Promise<BillCalendarResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { entries: [], totalUnpaid: null, unpaidCount: 0 };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot, referenceDate });
      const raw = native.computeBillCalendar(input);
      return parseBillCalendarResponse(raw);
    },

    async budgetVariance(ledger: unknown, referenceDate: string): Promise<BudgetVarianceResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { categoryVariances: [], trends: [], totalBudgeted: null, totalActual: null, totalVariance: null, overallVariancePercent: null };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot, referenceDate });
      const raw = native.computeBudgetVariance(input);
      return parseBudgetVarianceResponse(raw);
    },

    async irregularObligations(ledger: unknown): Promise<IrregularObligationsResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { obligations: [], totalEstimatedAnnual: null };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot });
      const raw = native.detectIrregularObligations(input);
      return parseIrregularObligationsResponse(raw);
    },

    async incomeReliability(ledger: unknown): Promise<IncomeReliabilityResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { sources: [], totalMonthly: null, overallScore: null, unreliableSourceCount: 0 };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot });
      const raw = native.assessIncomeReliability(input);
      return parseIncomeReliabilityResponse(raw);
    },

    async forecastCalibration(ledger: unknown): Promise<ForecastCalibrationResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { metrics: [], overallCalibrated: false, recommendations: ['Ledger snapshot unavailable.'] };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot });
      const raw = native.evaluateForecastCalibration(input);
      return parseForecastCalibrationResponse(raw);
    },

    async scenarioComparison(ledger: unknown, params: ScenarioComparisonParams): Promise<ScenarioComparisonResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { deltas: [], summary: 'Ledger snapshot unavailable.' };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot, baseline: params.baseline, comparison: params.comparison });
      const raw = native.compareScenarios(input);
      return parseScenarioComparisonResponse(raw);
    },

    async multidimensionalHealth(ledger: unknown, currentMonth: string): Promise<MultidimensionalHealthResult> {
      const rawSnapshot = await obtainSnapshot(ledger);
      if (!rawSnapshot) {
        return { dimensions: [], compositeScore: 0, summary: '', recommendations: ['Ledger snapshot unavailable.'] };
      }
      const input = JSON.stringify({ snapshot: rawSnapshot, currentMonth });
      const raw = native.evaluateMultidimensionalHealth(input);
      return parseMultidimensionalHealthResponse(raw);
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
      // Ledger must support snapshot export — reject hardcoded placeholders
      if (!isSynchronizableLedger(l)) {
        throw new ApplicationError({
          code: 'export_not_implemented',
          message: 'The connected ledger cannot provide a full budget snapshot for export. Run "export" with a compatible ledger.',
          reasonCodes: ['export_not_implemented'],
          retryable: false,
        });
      }

      const syncResult = await l.synchronize();
      if (!syncResult || typeof syncResult !== 'object' || !('snapshot' in syncResult)) {
        throw new ApplicationError({
          code: 'export_not_implemented',
          message: 'Ledger synchronization returned no snapshot data.',
          reasonCodes: ['export_not_implemented'],
          retryable: false,
        });
      }
      const syncContainer = syncResult as Record<string, unknown>;
      const snapshot = syncContainer.snapshot as Record<string, unknown>;


      const now = new Date().toISOString();
      const budgetName = 'Balanced Budget';

      // Build export content from the connected budget snapshot
      const exportData = {
        version: 1,
        exportedAt: now,
        source: 'balanceframe-observe',
        budgetName,
        accounts: Array.isArray(snapshot.accounts) ? snapshot.accounts : [],
        transactions: Array.isArray(snapshot.transactions) ? snapshot.transactions : [],
        categories: Array.isArray(snapshot.categories) ? snapshot.categories : [],
        payees: Array.isArray(snapshot.payees) ? snapshot.payees : [],
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
      const accountCount = Array.isArray(snapshot.accounts) ? snapshot.accounts.length : 0;
      const transactionCount = Array.isArray(snapshot.transactions) ? snapshot.transactions.length : 0;
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

      let cacheRemoved = false;
      let credentialsRemoved = false;

      if (isDisconnectableLedger(l)) {
        await l.disconnect();
        cacheRemoved = true;
        credentialsRemoved = true;
      }

      return {
        disconnected: cacheRemoved,
        cacheRemoved,
        credentialsRemoved,
        message: cacheRemoved
          ? `Disconnected successfully. ${cancelledJobs} pending job(s) cancelled. Actual server was not modified.`
          : 'The connected ledger does not support disconnect cleanup. No cache or credentials were removed.',
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

      let cacheRemoved = false;
      let credentialsRemoved = false;

      if (isDisconnectableLedger(l)) {
        await l.disconnect();
        cacheRemoved = true;
        credentialsRemoved = true;
      }

      return {
        removed: cacheRemoved,
        cacheRemoved,
        credentialsRemoved,
        broadAccessCaveat: cacheRemoved
          ? 'The BalanceFrame connector accesses all budget data including bank-sync credentials ' +
            'stored on the Actual server (which are not protected by Actual E2E encryption). ' +
            'Project-side filtering does not reduce the broad access held by the connector. ' +
            'Ensure your Actual server and backups have appropriate security.'
          : 'The connected ledger does not support disconnect cleanup. No cache or credentials were removed.',
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

      // Reject placeholder exports (zero accounts + zero transactions) — data safety
      if ((lastExport.accountCount ?? 0) <= 0 && (lastExport.transactionCount ?? 0) <= 0) {
        throw new ApplicationError({
          code: 'export_not_implemented',
          message: 'The existing export contains no budget data and cannot satisfy export-before-delete requirements. Run "export" with a compatible ledger.',
          reasonCodes: ['export_not_implemented', 'export_before_delete'],
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

  // Build notification runtime
  let notificationRuntime: NotificationRuntime | null = null;
  if (options?.notificationRuntime) {
    notificationRuntime = options.notificationRuntime;
  } else if (options?.workflowStore) {
    const defaultPolicy: NotificationPolicy = {
      policyVersion: 'v1',
      eligibility: [
        {
          classifications: ['budget_alert', 'review_complete', 'security_alert'],
          minSeverity: 'normal',
          requiredCapability: 'notification:receive',
        },
      ],
      recipients: [],
      channels: [
        { type: 'in_app' as const, enabled: true, rateLimitPerMinute: 60, displayName: 'In-App' },
      ],
      redaction: {
        sensitive: { visibleFields: ['title', 'summary'] },
        public: { visibleFields: ['title', 'summary', 'amount', 'account'] },
        restricted: { visibleFields: ['title'] },
      },
      maxRetries: 3,
      defaultRedactionClass: 'public',
    };
    const notificationPolicy = options.notificationPolicy ?? defaultPolicy;
    const notificationCapableStore = options.workflowStore;
    notificationRuntime = new NotificationRuntime(
      notificationCapableStore as unknown as WorkflowStore,
      notificationPolicy,
      [new InAppChannelAdapter()],
    );

    // Wire up persisted re-authorisation hook using store's membership data.
    // The store satisfies NotificationStoreMethods structurally at runtime
    // when it is a real WorkflowStore; we use the type guard to convince
    // TypeScript so the hook can call getActorMembership.
    if (isNotificationStore(notificationCapableStore as Record<string, unknown>)) {
      const membershipStore = notificationCapableStore as NotificationStoreMethods;
      notificationRuntime.setReAuthorizationHook(
        async (actorId: string, capability: string, _scope: string) => {
          try {
            const membership = await membershipStore.getActorMembership(actorId);
            return membership?.capabilities.includes(capability) ?? false;
          } catch {
            return false;
          }
        },
      );
    }
  }

  return {
    mode,
    actorId,
    requestId,
    ledger,
    freshness,
    analysisProtocol,
    lifecycleCallbacks,
    notificationRuntime,
  };
}
