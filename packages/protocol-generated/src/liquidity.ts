import type {
  Money,
  FinancialSnapshot,
  DecisionContext,
  Transaction,
  ProspectiveClaim,
  RedactionState,
} from './index.js';

/** Canonical Rust liquidity vocabulary: FactState. */
export type FactState = 'known' | 'unknown' | 'unavailable';

/** Canonical Rust liquidity vocabulary: FactSource. */
export type FactSource =
  'actual_ledger' | 'institution_provider' | 'user_attested' | 'policy_assumption';

/** Canonical Rust liquidity vocabulary: LiquidityAccountKind. */
export type LiquidityAccountKind = 'cash' | 'credit' | 'unknown';

/** Canonical Rust liquidity vocabulary: AccountRole. */
export type AccountRole =
  | 'daily_spending'
  | 'bill_payment'
  | 'reserve'
  | 'savings'
  | 'restricted'
  | 'credit_payment'
  | 'cash'
  | 'excluded';

/** Canonical Rust liquidity vocabulary: LiquidityCategoryKind. */
export type LiquidityCategoryKind =
  'ordinary' | 'income' | 'transfer' | 'reimbursement' | 'debt' | 'credit_payment';

/** Canonical Rust liquidity vocabulary: CategoryPeriodKind. */
export type CategoryPeriodKind = 'current' | 'future';

/** Canonical Rust liquidity vocabulary: FlowDirection. */
export type FlowDirection = 'inflow' | 'outflow';

/** Canonical Rust liquidity vocabulary: CalendarMode. */
export type CalendarMode = 'instant' | 'calendar_days' | 'business_days';

/** Canonical Rust liquidity vocabulary: LiquidityClaimState. */
export type LiquidityClaimState = 'active' | 'initiated' | 'cancelled' | 'expired' | 'settled';

/** Canonical Rust liquidity vocabulary: ClaimEffectKind. */
export type ClaimEffectKind = 'category' | 'account_debit' | 'destination_hold';

/** Canonical Rust liquidity vocabulary: BudgetFundingStatus. */
export type BudgetFundingStatus = 'funded' | 'unfunded' | 'insufficient_data';

/** Canonical Rust liquidity vocabulary: PaymentLiquidityStatus. */
export type PaymentLiquidityStatus =
  | 'ready'
  | 'use_other_account'
  | 'transfer_required'
  | 'transfer_too_late'
  | 'not_liquid'
  | 'insufficient_data';

/** Canonical Rust liquidity vocabulary: SettlementProvenance. */
export type SettlementProvenance =
  'institution_import' | 'provider_confirmed' | 'actual_import' | 'manual_ledger';

/** Source schedule certainty; an approximate amount is never an exact obligation. */
export type ScheduleAmountCertainty = 'exact' | 'approximate' | 'range' | 'unknown';

/** Source recurrence vocabulary, independent of any evaluation horizon. */
export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type ScheduleEndMode = 'never' | 'after_n_occurrences' | 'on_date';
export type ScheduleWeekendSolveMode = 'before' | 'after';
export type SchedulePatternKind = 'su' | 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'day';

/** Source weekday/day-of-month recurrence pattern. */
export interface ScheduleRecurrencePattern {
  kind: SchedulePatternKind;
  value: number;
}

/** Explicit recurrence representation; missing source options remain null, not invented defaults. */
export interface ScheduleRecurrence {
  frequency: ScheduleFrequency;
  interval: number | null;
  patterns: ScheduleRecurrencePattern[] | null;
  start: string;
  endMode: ScheduleEndMode | null;
  endOccurrences: number | null;
  endDate: string | null;
  skipWeekend: boolean | null;
  weekendSolveMode: ScheduleWeekendSolveMode | null;
}

/** Typed signed source schedule evidence, with independent source IDs and calendar date. */
export interface ScheduleLiquidityFact {
  id: string;
  accountId: string | null;
  categoryId: string | null;
  ruleId: string | null;
  dueDate: string | null;
  certainty: ScheduleAmountCertainty;
  amount: Money | null;
  minimum: Money | null;
  maximum: Money | null;
  recurrence: ScheduleRecurrence | null;
}

/** Immutable normalized Rust contract: FactEvidence. Unknown evidence is never a zero-value assertion. */
export interface FactEvidence {
  state: FactState;
  source: FactSource;
  observedAt: string | null;
  expiresAt: string | null;
  reasons: string[];
}

/** Immutable normalized Rust contract: CategoryLiquidityFact. Unknown evidence is never a zero-value assertion. */
export interface CategoryLiquidityFact {
  categoryId: string;
  cashBucketId: string;
  asOfMonth: string;
  kind: LiquidityCategoryKind;
  periodKind: CategoryPeriodKind;
  /** Current authoritative balance, or future additional assignment excluding rolled current cash; never future projected balance. */
  availability: Money;
  evidence: FactEvidence;
}

/** Immutable normalized Rust contract: UnsettledFlow. Unknown evidence is never a zero-value assertion. */
export interface UnsettledFlow {
  id: string;
  economicObligationId: string;
  direction: FlowDirection;
  amount: Money;
  includedInBalance: boolean;
  matchedTransactionIds: string[];
  scheduleId: string | null;
  transferTransactionId: string | null;
  importedId: string | null;
  reconciled: boolean;
  provenance: SettlementProvenance;
}

/** Immutable normalized Rust contract: CashObligation. Unknown evidence is never a zero-value assertion. */
export interface CashObligation {
  id: string;
  economicObligationId: string;
  categoryId: string | null;
  amount: Money;
  dueAt: string;
  paid: boolean;
  includedInBalance: boolean;
  matchedTransactionIds: string[];
}

/** Immutable normalized Rust contract: CreditLiquidityFact. Unknown evidence is never a zero-value assertion. */
export interface CreditLiquidityFact {
  authorizationAvailable: Money;
  pendingIncludedInAuthorization: boolean;
  paymentAccountId: string;
  paymentCategoryId: string;
  dueAt: string;
  reservedCash: Money;
  economicObligationId: string;
  evidence: FactEvidence;
}

/** Immutable normalized Rust contract: AccountLiquidityFact. Unknown evidence is never a zero-value assertion. */
export interface AccountLiquidityFact {
  accountId: string;
  currency: string;
  currencyEvidence: FactEvidence;
  kind: LiquidityAccountKind;
  kindEvidence: FactEvidence;
  onBudget: boolean;
  closed: boolean;
  owned: boolean;
  ownershipEvidence: FactEvidence;
  recordedBalance: Money;
  balanceEvidence: FactEvidence;
  /** Independent current-balance confirmation; ledger capture is not institution freshness. */
  freshnessEvidence: FactEvidence;
  activityEvidence: FactEvidence;
  scheduleEvidence: FactEvidence;
  baselineTransactionIds: string[];
  unsettledFlows: UnsettledFlow[];
  holds: Money;
  holdsEvidence: FactEvidence;
  obligations: CashObligation[];
  credit: CreditLiquidityFact | null;
  ambiguityReasons: string[];
}

/** Immutable normalized Rust contract: LiquidityFacts. Unknown evidence is never a zero-value assertion. */
export interface LiquidityFacts {
  version: string;
  ledgerContentHash: string;
  asOfMonth: string;
  categories: CategoryLiquidityFact[];
  accounts: AccountLiquidityFact[];
  schedules: ScheduleLiquidityFact[];
}

/** Immutable normalized Rust contract: AccountLiquidityPolicy. Unknown evidence is never a zero-value assertion. */
export interface AccountLiquidityPolicy {
  accountId: string;
  role: AccountRole;
  protectedBuffer: Money;
  paymentEligible: boolean;
  sourceEligible: boolean;
  backingEligible: boolean;
  eligibleCategoryIds: string[];
  restrictedCashBucketIds: string[];
  automationAllowed: boolean;
  resourceScope: string;
}

/** Immutable normalized Rust contract: TransferTimingRoute. Unknown evidence is never a zero-value assertion. */
export interface TransferTimingRoute {
  id: string;
  sourceAccountId: string;
  destinationAccountId: string;
  providerArrivalAt: string | null;
  calendarMode: CalendarMode | null;
  delayDays: number;
  utcOffsetMinutes: number | null;
  cutoffMinute: number | null;
  weekendsAvailable: boolean | null;
  holidaysComplete: boolean;
  holidays: string[];
  evidence: FactEvidence;
}

/** Immutable normalized Rust contract: LiquidityPolicy. Unknown evidence is never a zero-value assertion. */
export interface LiquidityPolicy {
  version: string;
  policyHash: string;
  expiresAt: string;
  accounts: AccountLiquidityPolicy[];
  transferRoutes: TransferTimingRoute[];
}

/** Immutable normalized Rust contract: LiquidityClaimEffect. Unknown evidence is never a zero-value assertion. */
export interface LiquidityClaimEffect {
  kind: ClaimEffectKind;
  resourceId: string;
  amount: Money;
  economicObligationId: string;
  sourceEconomicObligationId?: string;
  categoryId: string | null;
  includedInBalance: boolean;
  matchedTransactionIds: string[];
}

/** Immutable normalized Rust contract: LiquidityClaimBundle. Unknown evidence is never a zero-value assertion. */
export interface LiquidityClaimBundle {
  id: string;
  creationSnapshotId: string;
  creationPolicyVersion: string;
  state: LiquidityClaimState;
  expiresAt: string;
  initiated: boolean;
  effects: LiquidityClaimEffect[];
}

/** Immutable normalized Rust contract: LiquidityClaimSet. Unknown evidence is never a zero-value assertion. */
export interface LiquidityClaimSet {
  revision: string;
  bundles: LiquidityClaimBundle[];
}

/** Immutable normalized Rust contract: TrustedRoute. Unknown evidence is never a zero-value assertion. */
export interface TrustedRoute {
  accountId: string;
  referenceId: string;
}

/** Immutable normalized Rust contract: RouteSelection. Unknown evidence is never a zero-value assertion. */
export interface RouteSelection {
  explicitAccountId: string | null;
  sessionAccountId: string | null;
  approvedPreference: TrustedRoute | null;
  historicalRoute: TrustedRoute | null;
}

/** Immutable normalized Rust contract: LiquidityPurchaseItem. Unknown evidence is never a zero-value assertion. */
export interface LiquidityPurchaseItem {
  id: string;
  categoryId: string;
  amount: Money;
  purchaseAt: string;
  requiredBy: string;
  routeSelection: RouteSelection;
}

/** Immutable normalized Rust contract: CategoryReallocation. Unknown evidence is never a zero-value assertion. */
export interface CategoryReallocation {
  id: string;
  sourceCategoryId: string;
  destinationCategoryId: string;
  amount: Money;
}

/** Immutable normalized Rust contract: LiquidityHorizon. Unknown evidence is never a zero-value assertion. */
export interface LiquidityHorizon {
  startsAt: string;
  endsAt: string;
}

/** Immutable normalized Rust contract: BackingLine. Unknown evidence is never a zero-value assertion. */
export interface BackingLine {
  accountId: string;
  categoryId: string;
  /** Disjoint temporal cash bucket; categoryId remains the stable source category identity. */
  cashBucketId: string;
  amount: Money;
}

/** Immutable normalized Rust contract: BackingAllocation. Unknown evidence is never a zero-value assertion. */
export interface BackingAllocation {
  version: string;
  snapshotId: string;
  contentHash: string;
  policyVersion: string;
  policyHash: string;
  claimSetRevision: string;
  feasible: boolean;
  lines: BackingLine[];
  reasons: string[];
}

/** Immutable normalized Rust contract: LiquidityInput. Unknown evidence is never a zero-value assertion. */
export interface LiquidityInput {
  snapshotId: string;
  contentHash: string;
  evaluatedAt: string;
  /** Trusted budget-snapshot freshness policy, evaluated from original source observation time. */
  maxBudgetSnapshotAgeMinutes: number;
  /** Required source-coverage gate derived by the trusted wrapper; absence never means complete. */
  sourceCoverageComplete: boolean;
  horizon: LiquidityHorizon;
  facts: LiquidityFacts | null;
  liquidityPolicy: LiquidityPolicy;
  claimSet: LiquidityClaimSet;
  priorAllocation: BackingAllocation | null;
  scenario: LiquidityScenario;
  validUntil: string;
}

/** Immutable normalized Rust contract: CapacityDeduction. Unknown evidence is never a zero-value assertion. */
export interface CapacityDeduction {
  reason: string;
  evidenceId: string;
  amount: Money;
  affectsBacking: boolean;
}

/** Immutable normalized Rust contract: AccountCapacity. Unknown evidence is never a zero-value assertion. */
export interface AccountCapacity {
  accountId: string;
  recordedBalance: Money;
  adjustedCash: Money | null;
  signedHeadroom: Money | null;
  existingShortfall: Money | null;
  safeSpendingCapacity: Money | null;
  safeTransferCapacity: Money | null;
  backingCapacity: Money | null;
  deductions: CapacityDeduction[];
  reasons: string[];
}

/** Immutable normalized Rust contract: CategoryCapacity. Unknown evidence is never a zero-value assertion. */
export interface CategoryCapacity {
  categoryId: string;
  /** Disjoint temporal cash bucket represented by this capacity. */
  cashBucketId: string;
  authoritativeAvailability: Money;
  remainingAvailability: Money | null;
  reasons: string[];
}

/** Immutable normalized Rust contract: PaymentAlternative. Unknown evidence is never a zero-value assertion. */
export interface PaymentAlternative {
  accountId: string;
  status: PaymentLiquidityStatus;
  capacity: Money;
}

/** Immutable normalized Rust contract: AccountPlanPrecondition. Unknown evidence is never a zero-value assertion. */
export interface AccountPlanPrecondition {
  accountId: string;
  recordedBalance: Money;
  signedHeadroom: Money;
  backingCapacity: Money;
  baselineTransactionIds: string[];
}

/** Immutable normalized Rust contract: TransferLeg. Unknown evidence is never a zero-value assertion. */
export interface TransferLeg {
  id: string;
  sourceAccountId: string;
  destinationAccountId: string;
  amount: Money;
  requiredBy: string;
  estimatedArrival: string;
  timingRouteId: string;
  sourceBefore: AccountPlanPrecondition;
  destinationBefore: AccountPlanPrecondition;
  sourceAfter: Money;
  destinationAfter: Money;
}

/** Immutable normalized Rust contract: TransferPlan. Unknown evidence is never a zero-value assertion. */
export interface TransferPlan {
  version: string;
  snapshotId: string;
  contentHash: string;
  policyVersion: string;
  policyHash: string;
  claimSetRevision: string;
  evaluatedAt: string;
  expiresAt: string;
  minimumAmount: Money;
  legs: TransferLeg[];
  reservations: LiquidityClaimEffect[];
  backingAfter: BackingAllocation;
  scenario: LiquidityScenario;
  preconditionsHash: string;
  payloadHash: string;
}

/** Immutable normalized Rust contract: CreditPaymentResult. Unknown evidence is never a zero-value assertion. */
export interface CreditPaymentResult {
  accountId: string;
  authorizationAvailable: Money;
  authorizationAfter: Money;
  paymentAccountId: string;
  paymentCategoryId: string;
  dueAt: string;
  additionalPaymentCash: Money;
  paymentCashReady: boolean;
}

/** Immutable normalized Rust contract: PurchaseLiquidityResult. Unknown evidence is never a zero-value assertion. */
export interface PurchaseLiquidityResult {
  itemId: string;
  categoryId: string;
  budgetFundingStatus: BudgetFundingStatus;
  paymentLiquidityStatus: PaymentLiquidityStatus;
  selectedAccountId: string | null;
  selectionSource: string;
  selectedBefore: AccountCapacity | null;
  selectedAfter: AccountCapacity | null;
  alternatives: PaymentAlternative[];
  transferPlan: TransferPlan | null;
  credit: CreditPaymentResult | null;
  reasons: string[];
}

/** Immutable normalized Rust contract: AccountAwareSpendabilityResult. Unknown evidence is never a zero-value assertion. */
export interface AccountAwareSpendabilityResult {
  version: string;
  snapshotId: string;
  contentHash: string;
  policyVersion: string;
  policyHash: string;
  claimSetRevision: string;
  budgetFundingStatus: BudgetFundingStatus;
  paymentLiquidityStatus: PaymentLiquidityStatus;
  accountsBefore: AccountCapacity[];
  accountsAfter: AccountCapacity[];
  categories: CategoryCapacity[];
  backingBefore: BackingAllocation;
  backingAfter: BackingAllocation;
  purchases: PurchaseLiquidityResult[];
  horizon: LiquidityHorizon;
  expiresAt: string;
  assumptions: string[];
  reasons: string[];
}

/** Immutable normalized Rust contract: TransferSettlementRecord. Unknown evidence is never a zero-value assertion. */
export interface TransferSettlementRecord {
  id: string;
  accountId: string;
  amount: Money;
  observedAt: string;
  /** Source calendar date or precise UTC instant; date-only evidence does not assert a bank timestamp. */
  occurredAt: string;
  importedId: string | null;
  providerReference: string | null;
  pairId: string;
  reconciled: boolean;
  reversed: boolean;
  provenance: SettlementProvenance;
}

/** Immutable normalized Rust contract: TransferSettlementRequest. Unknown evidence is never a zero-value assertion. */
export interface TransferSettlementRequest {
  plan: TransferPlan;
  evaluatedAt: string;
  records: TransferSettlementRecord[];
  consumedEvidenceIds: string[];
}

/** Immutable normalized Rust contract: TransferSettlementResult. Unknown evidence is never a zero-value assertion. */
export interface TransferSettlementResult {
  confirmed: boolean;
  sourceObserved: boolean;
  destinationObserved: boolean;
  reconciled: boolean;
  evidenceIds: string[];
  reasons: string[];
  /** Authoritative native replacement effects, or null when existing claims must be retained. */
  claimEffects: LiquidityClaimEffect[] | null;
}

/** Immutable normalized Rust contract: TransferPreconditionRequest. Unknown evidence is never a zero-value assertion. */
export interface TransferPreconditionRequest {
  plan: TransferPlan;
  currentInput: LiquidityInput;
  ownClaimId: string | null;
}

/** Immutable normalized Rust contract: TransferPreconditionResult. Unknown evidence is never a zero-value assertion. */
export interface TransferPreconditionResult {
  valid: boolean;
  reasons: string[];
}

/** Joint hypothetical effects; category reallocation never changes account cash. */
export type LiquidityScenario =
  | { kind: 'none' }
  | { kind: 'purchases'; items: LiquidityPurchaseItem[] }
  | { kind: 'reallocation'; moves: CategoryReallocation[] };

/** Trusted server-assembled wrapper for native account-aware evaluation. */
export interface AccountAwareSpendabilityRequest {
  financialSnapshot: FinancialSnapshot;
  context: DecisionContext;
  liquidityPolicy: LiquidityPolicy;
  claimSet: LiquidityClaimSet;
  priorAllocation: BackingAllocation | null;
  scenario: LiquidityScenario;
  validUntil: string;
}

/** Trusted liquidity extension to the existing prospective purchase request. */
export interface PurchaseLiquidityContext {
  liquidityPolicy: LiquidityPolicy;
  claimSet: LiquidityClaimSet;
  priorAllocation: BackingAllocation | null;
  routeSelection: RouteSelection;
  purchaseAt: string;
  requiredBy: string;
}

/** Existing prospective purchase contract with an optional trusted liquidity context. */
export interface ProspectivePurchaseEvaluationRequest {
  financialSnapshot: FinancialSnapshot;
  context: DecisionContext;
  claims: ProspectiveClaim[];
  proposedTransaction: Transaction;
  categoryId: string;
  requestId: string;
  correlationId: string;
  decisionId: string;
  validUntil: string;
  redaction: RedactionState;
  liquidity?: PurchaseLiquidityContext | null;
}

/** Native wrapper re-evaluating current facts against an immutable transfer plan. */
export interface VerifyTransferPreconditionsRequest {
  plan: TransferPlan;
  currentInput: AccountAwareSpendabilityRequest;
  ownClaimId: string | null;
}
