// Generated TypeScript declarations for the Rust-owned BalanceFrame protocol.
// The JSON wire format is camelCase, matching Rust's serde(rename_all = "camelCase").
import type {
  AccountAwareSpendabilityResult,
  AccountCapacity,
  BackingAllocation,
  BudgetFundingStatus,
  LiquidityFacts,
  LiquidityClaimSet,
  LiquidityPolicy,
  PaymentLiquidityStatus,
  RouteSelection,
  ScheduleRecurrence,
  TransferPlan,
} from './liquidity.js';

export interface Money {
  minorUnits: string;
  currency: string;
}

export type AccountType =
  'checking' | 'savings' | 'creditCard' | 'cash' | 'investment' | 'mortgage' | 'loan' | 'other';

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
  actualDownloadedAt?: string | null;
  encrypted?: boolean | null;
  bankSyncedAt?: string | null;
  unlocked?: boolean | null;
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

// ---------------------------------------------------------------------------
// Rule Candidate / Simulation — deterministic learning output from Rust (camelCase)
// ---------------------------------------------------------------------------

/** A single rule candidate produced by the rule-generation engine. */
export interface RuleCandidate {
  /** Identifier of the generated rule. */
  ruleId: string;
  /** Human-readable name of the rule. */
  ruleName: string;
  /** Identifier of the category the rule would assign. */
  proposedCategoryId: string;
  /** Human-readable name of the proposed category. */
  proposedCategoryName: string;
  /** Number of transactions that would match this rule. */
  matchingTxCount: number;
  /** Human-readable explanation for why this rule was generated. */
  reason: string;
}

/** A single transaction example illustrating what a rule simulation would change. */
export interface SimulationExample {
  /** Identifier of the transaction. */
  transactionId: string;
  /** Payee name of the transaction. */
  payeeName: string;
  /** Monetary amount of the transaction (string to avoid floating-point precision loss across the napi boundary). */
  amount: string;
  /** Identifier of the category currently assigned. */
  currentCategoryId: string;
  /** Whether applying the rule would change the category. */
  wouldChange: boolean;
}

/** Result of simulating a set of rule candidates against historical transactions. */
export interface RuleSimulationResult {
  /** Distribution of proposed categories across matching transactions. */
  categoryDistribution: Record<string, number>;
  /** Per-transaction examples illustrating the simulation outcome. */
  examples: SimulationExample[];
}

// ---------------------------------------------------------------------------
// Phase 8 — Budget Intelligence types (camelCase, matching Rust serde)
// ---------------------------------------------------------------------------

/** Result of evaluating a proposed purchase against budget limits. */
export interface PurchaseEvaluation {
  /** Whether the purchase is allowable within budget constraints. */
  allowable: boolean;
  /** Machine-readable reason codes for the evaluation. */
  reasonCodes: string[];
  /** How much is budgeted for this category in the current month. */
  categoryBudget: Money;
  /** How much has been spent in this category so far. */
  categorySpent: Money;
  /** Remaining budget after accounting for this purchase. */
  categoryRemaining: Money;
  /** Projected account balance after purchase (null if account not tracked). */
  projectedBalance: Money | null;
  /** Independent funding and account settlement result; absent on legacy evaluations. */
  accountAware?: AccountAwareSpendabilityResult | null;
}

/** Request to project future cash flow based on schedules and budgets. */
export interface CashFlowProjectionRequest {
  snapshot: ProtocolSnapshot;
  projectionMonths: number;
}

/** A single month's cash-flow projection. */
export interface MonthlyProjection {
  /** The month in YYYY-MM format. */
  month: string;
  /** Total projected income for this month. */
  projectedIncome: Money;
  /** Total projected expenses for this month. */
  projectedExpenses: Money;
  /** Net change (income - expenses) for this month. */
  netChange: Money;
  /** Ending balance after this month. */
  endingBalance: Money;
}

/** Response containing projected monthly cash flows. */
export interface CashFlowProjectionResponse {
  projectionMonths: number;
  monthlyProjections: MonthlyProjection[];
}

/** Request to evaluate the health of budget targets. */
export interface TargetHealthRequest {
  snapshot: ProtocolSnapshot;
}

/** Health status of a single budget category. */
export interface CategoryHealth {
  categoryId: string;
  categoryName: string;
  budgeted: Money;
  spent: Money;
  remaining: Money;
  /** One of: "healthy", "overspent", "underfunded", "at_risk". */
  healthLabel: string;
}

/** Result of evaluating budget target health. */
export interface TargetHealthResult {
  categoryHealth: CategoryHealth[];
  overallLabel: string;
}

/** Structured request for computing an overall financial state label. */
export interface FinancialStateRequest {
  overallHealthLabel: string;
  positiveCashFlow: boolean;
  budgetCoverageRatio: number;
  overspentCategoryCount: number;
  month: string;
}

/** A label describing the overall financial state. */
export interface FinancialStateLabel {
  /** The state label: "healthy", "stable", "at_risk", or "critical". */
  label: string;
  /** Numeric score between 0.0 and 1.0 summarizing overall health. */
  score: number;
  /** Machine-readable reason codes supporting this label. */
  reasonCodes: string[];
}

// ---------------------------------------------------------------------------
// Phase 8.8 — Prospective financial decision contracts
// ---------------------------------------------------------------------------

/** Semantic classification of a financial value or conclusion. */
export type FinancialSemanticClass =
  | 'ledgerFact'
  | 'envelopeAvailability'
  | 'cashFlowProjection'
  | 'advice'
  | 'proposal'
  | 'executionResult'
  | 'purchaseOutcome'
  | 'accountLiquidity'
  | 'reservation'
  | 'commitment'
  | 'sourceObservation'
  | 'normalizedEvidence'
  | 'economicEventResolution'
  | 'redactedConclusion';

/** Known issue vocabulary plus forward-compatible issue codes. */
export type DecisionIssueCode =
  | 'account_freshness_coverage'
  | 'pending_availability'
  | 'schedule_coverage'
  | 'duplicate_transfer_ambiguity'
  | 'credit_payment_uncertainty'
  | 'reservation_conflict'
  | 'wallet_balance_uncertainty'
  | 'receipt_total_mismatch'
  | 'economic_event_ambiguity'
  | 'currency_mismatch'
  | (string & {});

export type DecisionIssueSeverity = 'info' | 'warning' | 'critical';

export type DecisionIssueEffect = 'qualifies' | 'blocks';

export type DecisionScope =
  | { kind: 'global' }
  | { kind: 'account'; id: string }
  | { kind: 'category'; id: string }
  | { kind: 'transaction'; id: string }
  | { kind: 'schedule'; id: string }
  | { kind: 'claim'; id: string };

export type RedactionState = 'visible' | 'redacted';

export interface EvidenceReference {
  evidenceId: string;
  kind: string;
  authorized: boolean;
  redaction: RedactionState;
}

export interface Remediation {
  code: string;
  action: string;
}

export interface DecisionIssue {
  code: DecisionIssueCode;
  severity: DecisionIssueSeverity;
  effect: DecisionIssueEffect;
  scope: DecisionScope;
  evidence: EvidenceReference[];
  remediation?: Remediation | null;
  redaction: RedactionState;
}

export interface FinancialSnapshot {
  contractVersion: string;
  snapshotId: string;
  contentHash: string;
  source: SnapshotSource;
  capturedAt: string;
  sourceNormalizationVersion: string;
  legacySnapshot: ProtocolSnapshot;
  coverage: SnapshotCoverage;
  inclusionScope: InclusionScope;
  observations: SourceObservation[];
  /** Source-qualified liquidity facts; absence never asserts account readiness. */
  liquidity?: LiquidityFacts | null;
}

export interface SnapshotSource {
  ledgerBackend: string;
  ledgerId: string;
  budgetId: string;
  spaceId: string | null;
}

export interface SnapshotCoverage {
  accounts: CoverageState;
  transactions: CoverageState;
  categories: CoverageState;
  payees: CoverageState;
  rules: CoverageState;
  schedules: CoverageState;
  budgets: CoverageState;
  tags: CoverageState;
}

/** Unavailable means the source collection could not be read; partial means some entries were unavailable; empty means a confirmed complete collection has no entries. */
export type CoverageState = 'complete' | 'empty' | 'partial' | 'unknown' | 'unavailable';

export interface InclusionScope {
  pendingActivity: PendingActivityTreatment;
  unclearedActivity: UnclearedActivityTreatment;
}

export type PendingActivityTreatment = 'included' | 'excluded' | 'unknown';

export type UnclearedActivityTreatment = 'included' | 'excluded' | 'unknown';

export interface SourceObservation {
  kind: ObservationKind;
  scope: DecisionScope;
  state: ObservationState;
  observedAt: string | null;
  evidence: EvidenceReference[];
}

export type ObservationKind =
  | 'account_freshness'
  | 'account_coverage'
  | 'account_collection_coverage'
  | 'account_type'
  | 'account_balance'
  | 'pending_activity'
  | 'uncleared_activity'
  | 'schedule_coverage'
  | 'credit_card_obligation_coverage'
  | 'duplicate_candidate'
  | 'transfer_ambiguity'
  | 'reconciliation'
  | 'currency_compatibility';

export type ObservationState =
  | 'fresh'
  | 'stale'
  | 'unavailable'
  | 'unknown'
  | 'included'
  | 'complete'
  | 'present'
  | 'ambiguous'
  | 'unreconciled'
  | 'incompatible';

export type PendingMode = 'include' | 'exclude' | 'includeConservatively';

export type UncategorizedMode = 'block' | 'reserveFullAmount' | 'ignore';

export type UnclearedMode = 'include' | 'exclude';

export interface AccountOverrides {
  includeOnly: string[] | null;
  exclude: string[];
}

export interface DecisionDataPolicy {
  pendingMode: PendingMode;
  uncategorizedMode: UncategorizedMode;
  unclearedMode: UnclearedMode;
  maxBankSyncAgeMinutes: number | null;
  maxBudgetSnapshotAgeMinutes: number | null;
  accountOverrides: AccountOverrides;
}

export interface DecisionHorizon {
  startsAt: string;
  endsAt: string;
}

export interface DecisionContext {
  evaluatedAt: string;
  horizon: DecisionHorizon;
  policy: DecisionDataPolicy;
  policyVersion: string;
  policyHash: string;
  snapshotId: string;
  contentHash: string;
}
/** Decision Card outcomes owned by the canonical Rust evaluator. */
export type DecisionCardOutcome =
  | 'funded_now'
  | 'safe_after_date'
  | 'safe_with_reallocation'
  | 'cash_available_but_unfunded'
  | 'not_safe'
  | 'plan_breaking'
  | 'insufficient_data';

/** User-supplied priority for a proposed Decision Card item. */
export type DecisionCardPriority = 'required' | 'planned' | 'optional';
/** Positive line-total amount assigned to one item category. */
export interface DecisionCardCategoryAllocation {
  categoryId: string;
  amount: Money;
}

/** Source-backed price provenance for a proposed item. */
export type DecisionCardPriceProvenance =
  | {
      kind: 'current_session_manual';
      source?: string | null;
      store?: string | null;
      observedAt: string;
      estimate: boolean;
    }
  | {
      kind: 'outside_price';
      source: string;
      store?: string | null;
      observedAt: string;
      estimate: boolean;
    };

/** Fixed cart-wide tax, fee, or discount input. */
export interface DecisionCardAdjustment {
  kind: 'tax' | 'fee' | 'discount';
  categoryId: string;
  amount: Money;
}

/** User-configurable cart warning threshold. */
export type DecisionCardWarningThreshold =
  | {
      id: string;
      basis: 'cart_total';
      maximum: Money;
    }
  | {
      id: string;
      basis: 'category_charge';
      categoryId: string;
      maximum: Money;
    };

/** One normalized category cart charge. */
export interface DecisionCardCategoryCharge {
  categoryId: string;
  amount: Money;
}

/** One normalized account cart charge. */
export interface DecisionCardAccountCharge {
  accountId: string;
  amount: Money;
}

/** Exact normalized line, category, and account cart totals. */
export interface DecisionCardCart {
  subtotal: Money;
  tax: Money;
  fee: Money;
  discount: Money;
  total: Money;
  categoryCharges: DecisionCardCategoryCharge[];
  accountCharges: DecisionCardAccountCharge[];
}

/** Candidate item-removal projection retained for review. */
export interface DecisionCardTrimAlternative {
  removedItemIds: string[];
  retainedItemIds: string[];
  total: Money;
  outcome: DecisionCardOutcome;
  categoryCharges: DecisionCardCategoryCharge[];
}

/** One threshold warning and its candidate alternatives. */
export interface DecisionCardWarning {
  thresholdId: string;
  threshold: Money;
  actual: Money;
  excess: Money;
  reason: 'threshold_exceeded';
  alternatives: DecisionCardTrimAlternative[];
}

/** A proposed item evaluated jointly by the canonical Decision Card evaluator. */
export interface DecisionCardItem {
  id: string;
  categoryId: string;
  amount: Money;
  purchaseAt: string;
  requiredBy: string;
  routeSelection: RouteSelection;
  priority: DecisionCardPriority;
  quantity?: number;
  categoryAllocations?: DecisionCardCategoryAllocation[];
  barcode?: string;
  priceProvenance?: DecisionCardPriceProvenance;
}

/** Category policy applied to a proposed Decision Card item. */
export interface DecisionCardCategoryPolicy {
  categoryId: string;
  kind: string;
  donorEligible: boolean;
  minimumRetained: Money;
  projectedRemainingNeed: Money;
}

/** Immutable input accepted by the canonical Decision Card evaluator. */
export interface DecisionCardRequest {
  financialSnapshot: FinancialSnapshot;
  context: DecisionContext;
  liquidityPolicy: LiquidityPolicy;
  claimSet: LiquidityClaimSet;
  priorAllocation: BackingAllocation | null;
  items: DecisionCardItem[];
  adjustments?: DecisionCardAdjustment[];
  warningThresholds?: DecisionCardWarningThreshold[];
  categoryPolicies: DecisionCardCategoryPolicy[];
  validUntil: string;
  requestId: string;
  correlationId: string;
  decisionId: string;
}

/** Category-level before/after state projected by the canonical evaluator. */
export interface DecisionCardCategoryState {
  categoryId: string;
  asOfMonth: string;
  availability: Money;
  commitments: Money;
  reservations: Money;
  uncommittedAvailability: Money;
  safeToRedirect: Money;
  policyKind: string | null;
}

/** A known or explicitly unknown runway projection. */
export type DecisionCardRunway =
  | {
      state: 'known';
      accountId: string;
      remainingSafeCash: Money;
      basis: string;
    }
  | {
      state: 'unknown';
      accountId?: string;
      remainingSafeCash: null;
    };

/** A protected goal or category impact in a before/after state. */
export interface DecisionCardGoalImpact {
  categoryId: string;
  asOfMonth: string;
  kind: string;
  state: 'on_track' | 'at_risk';
  shortfall: Money;
  minimumRetained: Money;
  projectedRemainingNeed: Money;
  requiredRetained: Money;
  targetState: 'unknown';
  availability: Money;
  uncommittedAvailability: Money;
}

/** A known obligation projection retained in a Decision Card. */
export interface DecisionCardKnownObligation {
  economicObligationId: string;
  classification: 'commitment' | 'reservation';
  accountId: string | null;
  categoryId: string | null;
  amount: Money;
  state: 'active' | 'scheduled';
  dueAt?: string;
  recurring?: boolean;
  scheduleId?: string;
  recurrence?: ScheduleRecurrence;
  amountState?: 'known';
}

/** A scheduled obligation whose amount is explicitly unknown. */
export interface DecisionCardUnknownObligation {
  scheduleId: string;
  classification: 'commitment';
  accountId: string | null;
  categoryId: string | null;
  dueAt: string;
  state: 'scheduled';
  recurring: boolean;
  amount: null;
  amountState: 'unknown';
  recurrence?: ScheduleRecurrence;
}

/** A typed recurring-obligation or persisted-claim projection. */
export type DecisionCardObligation =
  | DecisionCardKnownObligation
  | DecisionCardUnknownObligation;

/** Complete before/after financial state projected by the canonical evaluator. */
export interface DecisionCardState {
  categories: DecisionCardCategoryState[];
  accounts: AccountCapacity[];
  backing: BackingAllocation;
  goals: DecisionCardGoalImpact[];
  obligations: DecisionCardObligation[];
  runway: DecisionCardRunway | null;
}

/** One exact account transfer funding path. */
export interface DecisionCardAccountTransferPath extends TransferPlan {
  kind: 'account_transfer';
  itemId?: string;
  itemIds: string[];
}

/** Before/after category availability shown for a reallocation path. */
export interface DecisionCardReallocationState {
  sourceAvailability: Money;
  destinationAvailability: Money;
}

/** One exact category reallocation funding path. */
export interface DecisionCardCategoryReallocationPath {
  kind: 'category_reallocation';
  sourceCategoryId: string;
  sourceAsOfMonth: string;
  destinationCategoryId: string;
  destinationAsOfMonth: string;
  amount: Money;
  approvalRequired: true;
  tradeoffs: string[];
  before: DecisionCardReallocationState;
  after: DecisionCardReallocationState;
}

/** One typed funding path retained by a Decision Card. */
export type DecisionCardFundingPath =
  | DecisionCardAccountTransferPath
  | DecisionCardCategoryReallocationPath;

/** Explicit category tradeoff caused by a reallocation path. */
export interface DecisionCardOpportunityCost {
  kind: 'category_opportunity_cost';
  sourceCategoryId: string;
  sourceAsOfMonth: string;
  destinationCategoryId: string;
  destinationAsOfMonth: string;
  amount: Money;
  beforeSafeToRedirect: Money;
  afterSafeToRedirect: Money;
  tradeoff: 'donor_category_surplus_redirected';
}

/** Competing item/account capacity conflict retained by a Decision Card. */
export interface DecisionCardConflict {
  kind: 'competing_account_capacity';
  accountId: string;
  itemId: string;
  competingItemIds: string[];
  reason: 'engine_cumulative_account_capacity';
  paymentLiquidityStatus: PaymentLiquidityStatus;
}

/** Readiness projection shared by Decision Card consumers. */
export interface DecisionCardReadiness {
  outcome: DecisionCardOutcome;
  status: 'evaluated' | 'blocked';
  blockers?: string[];
  budgetFundingStatus?: BudgetFundingStatus;
  paymentLiquidityStatus?: PaymentLiquidityStatus;
}

/** Per-item deterministic outcome in a Decision Card response. */
export interface DecisionCardItemOutcome {
  id: string;
  categoryId: string;
  amount: Money;
  priority: DecisionCardPriority;
  outcome: DecisionCardOutcome;
  budgetFundingStatus: BudgetFundingStatus;
  paymentLiquidityStatus: PaymentLiquidityStatus;
  selectedAccountId: string | null;
  selectionSource: string;
  reasons: string[];
  before: AccountCapacity | null;
  after: AccountCapacity | null;
}

/** Immutable Decision Card returned by the canonical Rust evaluator. */
export interface DecisionCard {
  version: string;
  decisionId: string;
  requestId: string;
  correlationId: string;
  snapshotId: string;
  contentHash: string;
  policyVersion: string;
  policyHash: string;
  claimSetRevision: string;
  planHash: string;
  intentHash: string;
  outcome: DecisionCardOutcome;
  budgetFundingStatus: BudgetFundingStatus;
  paymentLiquidityStatus: PaymentLiquidityStatus;
  selectedAccountId: string | null;
  selectionSource: string | null;
  before: DecisionCardState | null;
  after: DecisionCardState | null;
  fundingPaths: DecisionCardFundingPath[];
  opportunityCosts: DecisionCardOpportunityCost[];
  conflicts: DecisionCardConflict[];
  authorizationRequirements: string[];
  evidence: EvidenceReference[];
  blockers: string[];
  reasons: string[];
  assumptions: string[];
  earliestExpiry: string;
  expiresAt: string;
  cart: DecisionCardCart | null;
  warnings: DecisionCardWarning[];
  trimAlternatives: DecisionCardTrimAlternative[];
  readiness: DecisionCardReadiness;
  items: DecisionCardItemOutcome[];
}

export type ProspectiveClaimKind = 'reservation' | 'commitment';

export type ProspectiveClaimStatus = 'active' | 'released';

export interface ProspectiveClaim {
  claimId: string;
  kind: ProspectiveClaimKind;
  sourceId: string;
  scope: DecisionScope;
  amount: Money;
  status: ProspectiveClaimStatus;
  effectiveFrom: string;
  expiresAt: string | null;
  visibility: RedactionState;
  policyVersion: string;
  snapshotId: string;
}

export interface ProspectiveClaimEvaluation {
  eligibleClaimIds: string[];
  reservationTotal: Money | null;
  commitmentTotal: Money | null;
  issues: DecisionIssue[];
}

export type DecisionReadiness = 'ready' | 'qualified' | 'blocked';

export interface DecisionAmount {
  label: FinancialSemanticClass;
  scope: DecisionScope;
  amount: Money;
}

export interface DecisionSemanticState {
  amounts: DecisionAmount[];
}

export interface DecisionAlternative {
  alternativeId: string;
  summary: string;
  resultingState: DecisionSemanticState;
}

export interface ProspectiveDecisionMetadata {
  contractVersion: string;
  decisionId: string;
  decisionKind: string;
  requestId: string;
  correlationId: string;
  context: DecisionContext;
}

export interface ProspectiveDecisionEnvelope<T> {
  metadata: ProspectiveDecisionMetadata;
  readiness: DecisionReadiness;
  before: DecisionSemanticState;
  after: DecisionSemanticState;
  issues: DecisionIssue[];
  evidence: EvidenceReference[];
  alternatives: DecisionAlternative[];
  expiresAt: string;
  redaction: RedactionState;
  payload: T;
}

export type * from './liquidity.js';
