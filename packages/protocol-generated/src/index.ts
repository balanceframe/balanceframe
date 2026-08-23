// Generated TypeScript declarations for the Rust-owned BalanceFrame protocol.
// The JSON wire format is camelCase, matching Rust's serde(rename_all = "camelCase").

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
