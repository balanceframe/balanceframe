//! Pure account-aware liquidity: trusted normalized facts, immutable scenarios and plans.
use crate::Money;
use serde::{Deserialize, Serialize};

#[path = "liquidity_engine.rs"]
mod engine;

/// Fact State: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactState {
    /// Known.
    Known,
    /// Unknown.
    Unknown,
    /// Unavailable.
    Unavailable,
}

/// Fact Source: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactSource {
    /// Actual Ledger.
    ActualLedger,
    /// Institution Provider.
    InstitutionProvider,
    /// User Attested.
    UserAttested,
    /// Policy Assumption.
    PolicyAssumption,
}

/// Fact Evidence: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactEvidence {
    /// Explicit evidence or lifecycle state; unknown is never coerced complete.
    pub state: FactState,
    /// Provenance of the observation; policy assumptions cannot establish a missing fact.
    pub source: FactSource,
    /// Actual observation instant in RFC3339, not the download time.
    pub observed_at: Option<String>,
    /// Fixed exclusive expiry instant in RFC3339; initiated claims remain held past expiry.
    pub expires_at: Option<String>,
    /// Stable scoped reason codes preserving unavailable or ambiguous evidence.
    pub reasons: Vec<String>,
}

/// Liquidity Account Kind: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LiquidityAccountKind {
    /// Cash.
    Cash,
    /// Credit.
    Credit,
    /// Unknown.
    Unknown,
}

/// Account Role: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountRole {
    /// Daily Spending.
    DailySpending,
    /// Bill Payment.
    BillPayment,
    /// Reserve.
    Reserve,
    /// Savings.
    Savings,
    /// Restricted.
    Restricted,
    /// Credit Payment.
    CreditPayment,
    /// Cash.
    Cash,
    /// Excluded.
    Excluded,
}

/// Liquidity Category Kind: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LiquidityCategoryKind {
    /// Ordinary.
    Ordinary,
    /// Income.
    Income,
    /// Transfer.
    Transfer,
    /// Reimbursement.
    Reimbursement,
    /// Debt.
    Debt,
    /// Credit Payment.
    CreditPayment,
}

/// Category Period Kind: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CategoryPeriodKind {
    /// Current.
    Current,
    /// Future.
    Future,
}

/// Category Liquidity Fact: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CategoryLiquidityFact {
    /// Stable category resource identifier.
    pub category_id: String,
    /// Disjoint authoritative cash bucket; duplicate buckets are rejected.
    pub cash_bucket_id: String,
    /// Authoritative YYYY-MM period of the balance.
    pub as_of_month: String,
    /// Kind for this normalized liquidity result.
    pub kind: LiquidityCategoryKind,
    /// Period kind for this normalized liquidity result.
    pub period_kind: CategoryPeriodKind,
    /// Current authoritative balance, or independent future additional assignment.
    pub availability: Money,
    /// Evidence for this normalized liquidity result.
    pub evidence: FactEvidence,
}

/// Flow Direction: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowDirection {
    /// Inflow.
    Inflow,
    /// Outflow.
    Outflow,
}

/// Unsettled Flow: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsettledFlow {
    /// Stable normalized identity; never a display label.
    pub id: String,
    /// Stable economic identity linking schedule, transaction, card and claim effects for single attribution.
    pub economic_obligation_id: String,
    /// Direction for this normalized liquidity result.
    pub direction: FlowDirection,
    /// Exact monetary effect in integer minor units and explicit currency.
    pub amount: Money,
    /// Whether this exact effect is already reflected in the recorded balance.
    pub included_in_balance: bool,
    /// Reliable normalized links to matching ledger transactions.
    pub matched_transaction_ids: Vec<String>,
    /// Preserved source schedule link, if explicitly supplied.
    pub schedule_id: Option<String>,
    /// Preserved source transfer-counterpart link, if explicitly supplied.
    pub transfer_transaction_id: Option<String>,
    /// Independent source import identifier; an ID alone is not trusted provenance.
    pub imported_id: Option<String>,
    /// Whether authoritative Actual evidence records reconciliation.
    pub reconciled: bool,
    /// Normalized trust classification; manual ledger rows cannot prove settlement.
    pub provenance: SettlementProvenance,
}

/// Cash Obligation: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CashObligation {
    /// Stable normalized identity; never a display label.
    pub id: String,
    /// Stable economic identity linking schedule, transaction, card and claim effects for single attribution.
    pub economic_obligation_id: String,
    /// Stable category resource identifier.
    pub category_id: Option<String>,
    /// Exact monetary effect in integer minor units and explicit currency.
    pub amount: Money,
    /// Known obligation or card due instant in RFC3339.
    pub due_at: String,
    /// Whether authoritative evidence marks this obligation already paid.
    pub paid: bool,
    /// Whether this exact effect is already reflected in the recorded balance.
    pub included_in_balance: bool,
    /// Reliable normalized links to matching ledger transactions.
    pub matched_transaction_ids: Vec<String>,
}

/// Credit Liquidity Fact: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreditLiquidityFact {
    /// Observed available card authorization, never cash backing.
    pub authorization_available: Money,
    /// Whether authorization availability already deducts pending card outflows.
    pub pending_included_in_authorization: bool,
    /// Explicit cash account expected to settle the card payment.
    pub payment_account_id: String,
    /// Explicit credit-payment category receiving transformed purchase backing.
    pub payment_category_id: String,
    /// Known obligation or card due instant in RFC3339.
    pub due_at: String,
    /// Existing payment cash reserve, attributed once by economic obligation ID.
    pub reserved_cash: Money,
    /// Stable economic identity linking schedule, transaction, card and claim effects for single attribution.
    pub economic_obligation_id: String,
    /// Evidence for this normalized liquidity result.
    pub evidence: FactEvidence,
}

/// Account Liquidity Fact: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountLiquidityFact {
    /// Stable account resource identifier.
    pub account_id: String,
    /// Explicit observed ISO currency; never inferred from a legacy fallback.
    pub currency: String,
    /// Coverage and provenance of the account currency observation.
    pub currency_evidence: FactEvidence,
    /// Kind for this normalized liquidity result.
    pub kind: LiquidityAccountKind,
    /// Coverage and provenance of the account-kind observation.
    pub kind_evidence: FactEvidence,
    /// On budget for this normalized liquidity result.
    pub on_budget: bool,
    /// Closed for this normalized liquidity result.
    pub closed: bool,
    /// Owned for this normalized liquidity result.
    pub owned: bool,
    /// Evidence for ownership, on-budget and closure eligibility.
    pub ownership_evidence: FactEvidence,
    /// Signed ledger balance, including exactly the activity marked included.
    pub recorded_balance: Money,
    /// Balance evidence for this normalized liquidity result.
    pub balance_evidence: FactEvidence,
    /// Independent institution or explicit user-confirmed current-ledger freshness.
    pub freshness_evidence: FactEvidence,
    /// Activity evidence for this normalized liquidity result.
    pub activity_evidence: FactEvidence,
    /// Schedule evidence for this normalized liquidity result.
    pub schedule_evidence: FactEvidence,
    /// All preexisting ledger/import identities that cannot prove a new transfer settled.
    pub baseline_transaction_ids: Vec<String>,
    /// Unsettled flows for this normalized liquidity result.
    pub unsettled_flows: Vec<UnsettledFlow>,
    /// Holds for this normalized liquidity result.
    pub holds: Money,
    /// Evidence that the reported hold amount is complete.
    pub holds_evidence: FactEvidence,
    /// Obligations for this normalized liquidity result.
    pub obligations: Vec<CashObligation>,
    /// Credit for this normalized liquidity result.
    pub credit: Option<CreditLiquidityFact>,
    /// Ambiguity reasons for this normalized liquidity result.
    pub ambiguity_reasons: Vec<String>,
}

/// Precision of a source schedule amount; estimates never establish safe bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleAmountCertainty {
    /// Exact source amount with no uncertainty.
    Exact,
    /// Approximate source amount, not a guaranteed bound.
    Approximate,
    /// Source explicitly reports a range.
    Range,
    /// Source amount cannot be determined.
    Unknown,
}

/// Preserved typed schedule uncertainty without provider objects or financial reason strings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleLiquidityFact {
    /// Stable source schedule identifier.
    pub id: String,
    /// Explicit account link, or unknown.
    pub account_id: Option<String>,
    /// Explicit category link, or unknown.
    pub category_id: Option<String>,
    /// Source rule link, if present.
    pub rule_id: Option<String>,
    /// Source YYYY-MM-DD date; never fabricate a time or timezone from it.
    pub due_date: Option<String>,
    /// Source amount precision, independent of account schedule coverage.
    pub certainty: ScheduleAmountCertainty,
    /// Source exact or approximate amount, when supplied.
    pub amount: Option<Money>,
    /// Source lower amount bound, when supplied.
    pub minimum: Option<Money>,
    /// Source upper amount bound, when supplied.
    pub maximum: Option<Money>,
    /// Source recurrence configuration; null means a one-time schedule.
    pub recurrence: Option<ScheduleRecurrence>,
}

/// Liquidity Facts: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiquidityFacts {
    /// Version of this immutable domain contract or policy.
    pub version: String,
    /// Original ledger hash retained when supplemental facts form a composite snapshot.
    pub ledger_content_hash: String,
    /// Authoritative YYYY-MM period of the balance.
    pub as_of_month: String,
    /// Categories for this normalized liquidity result.
    pub categories: Vec<CategoryLiquidityFact>,
    /// Accounts for this normalized liquidity result.
    pub accounts: Vec<AccountLiquidityFact>,
    /// Typed source schedules, preserving unknown account, amount and date evidence.
    pub schedules: Vec<ScheduleLiquidityFact>,
}

/// Account Liquidity Policy: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountLiquidityPolicy {
    /// Stable account resource identifier.
    pub account_id: String,
    /// Explicit user policy role, not an inferred institution account type.
    pub role: AccountRole,
    /// Protected cash reserve, distinct from funded category obligations.
    pub protected_buffer: Money,
    /// Whether policy permits this account for payment.
    pub payment_eligible: bool,
    /// Whether policy permits this account as a transfer source.
    pub source_eligible: bool,
    /// Whether policy permits this account to back category demand.
    pub backing_eligible: bool,
    /// Allowlisted category IDs; empty means all otherwise eligible categories.
    pub eligible_category_ids: Vec<String>,
    /// Explicit cash buckets permitted for restricted-account category backing only.
    pub restricted_cash_bucket_ids: Vec<String>,
    /// Policy permission metadata; this engine never initiates bank actions.
    pub automation_allowed: bool,
    /// Trusted authorized resource scope supplied by the server.
    pub resource_scope: String,
}

/// Calendar Mode: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalendarMode {
    /// Instant.
    Instant,
    /// Calendar Days.
    CalendarDays,
    /// Business Days.
    BusinessDays,
}

/// Transfer Timing Route: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferTimingRoute {
    /// Stable normalized identity; never a display label.
    pub id: String,
    /// Stable transfer source account identifier.
    pub source_account_id: String,
    /// Stable transfer destination account identifier.
    pub destination_account_id: String,
    /// Explicit trusted provider arrival instant; no calendar inference when absent.
    pub provider_arrival_at: Option<String>,
    /// Explicit policy calendar interpretation, null when timing is unknown.
    pub calendar_mode: Option<CalendarMode>,
    /// Known transfer delay in the selected calendar, never inferred.
    pub delay_days: u32,
    /// Explicit fixed timezone offset for cutoff/calendar computation.
    pub utc_offset_minutes: Option<i32>,
    /// Known local cutoff minute after midnight, from 0 through 1439.
    pub cutoff_minute: Option<u32>,
    /// Explicit weekend availability; null means unknown.
    pub weekends_available: Option<bool>,
    /// Whether the holiday list fully covers the business-day calculation.
    pub holidays_complete: bool,
    /// Explicit YYYY-MM-DD nonbusiness dates in the covered policy calendar.
    pub holidays: Vec<String>,
    /// Evidence for this normalized liquidity result.
    pub evidence: FactEvidence,
}

/// Liquidity Policy: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiquidityPolicy {
    /// Version of this immutable domain contract or policy.
    pub version: String,
    /// Exact policy content identity supplied by the trusted policy owner.
    pub policy_hash: String,
    /// Fixed exclusive expiry instant in RFC3339; initiated claims remain held past expiry.
    pub expires_at: String,
    /// Accounts for this normalized liquidity result.
    pub accounts: Vec<AccountLiquidityPolicy>,
    /// Transfer routes for this normalized liquidity result.
    pub transfer_routes: Vec<TransferTimingRoute>,
}

/// Liquidity Claim State: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LiquidityClaimState {
    /// Active.
    Active,
    /// Initiated.
    Initiated,
    /// Cancelled.
    Cancelled,
    /// Expired.
    Expired,
    /// Settled.
    Settled,
}

/// Claim Effect Kind: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimEffectKind {
    /// Category.
    Category,
    /// Account Debit.
    AccountDebit,
    /// Destination Hold.
    DestinationHold,
}

/// Liquidity Claim Effect: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiquidityClaimEffect {
    /// Kind for this normalized liquidity result.
    pub kind: ClaimEffectKind,
    /// Resource id for this normalized liquidity result.
    pub resource_id: String,
    /// Exact monetary effect in integer minor units and explicit currency.
    pub amount: Money,
    /// Stable economic identity linking schedule, transaction, card and claim effects for single attribution.
    pub economic_obligation_id: String,
    /// Stable category resource identifier.
    pub category_id: Option<String>,
    /// Whether this exact effect is already reflected in the recorded balance.
    pub included_in_balance: bool,
    /// Reliable normalized links to matching ledger transactions.
    pub matched_transaction_ids: Vec<String>,
}

/// Liquidity Claim Bundle: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiquidityClaimBundle {
    /// Stable normalized identity; never a display label.
    pub id: String,
    /// Creation provenance only; a new snapshot never erases an active claim.
    pub creation_snapshot_id: String,
    /// Creation provenance only; lifecycle governs whether this claim stays active.
    pub creation_policy_version: String,
    /// Explicit evidence or lifecycle state; unknown is never coerced complete.
    pub state: LiquidityClaimState,
    /// Fixed exclusive expiry instant in RFC3339; initiated claims remain held past expiry.
    pub expires_at: String,
    /// True once money movement is reported or observed; expiry cannot silently release it.
    pub initiated: bool,
    /// Atomic category/account effects admitted together under the shared claim-set revision.
    pub effects: Vec<LiquidityClaimEffect>,
}

/// Liquidity Claim Set: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiquidityClaimSet {
    /// Independent persisted revision for serialized claim admission.
    pub revision: String,
    /// Persisted atomic claim bundles supplied by the trusted server.
    pub bundles: Vec<LiquidityClaimBundle>,
}

/// Trusted Route: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedRoute {
    /// Stable account resource identifier.
    pub account_id: String,
    /// Stable approved-preference or historical-evidence provenance reference.
    pub reference_id: String,
}

/// Route Selection: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteSelection {
    /// Explicit selected account, if supplied; never silently replaced.
    pub explicit_account_id: Option<String>,
    /// Persisted Spend Session payment selection, subordinate to explicit choice.
    pub session_account_id: Option<String>,
    /// Server-assembled approved route with stable provenance.
    pub approved_preference: Option<TrustedRoute>,
    /// Server-assembled deterministic historical route with stable provenance.
    pub historical_route: Option<TrustedRoute>,
}

/// Liquidity Purchase Item: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiquidityPurchaseItem {
    /// Stable normalized identity; never a display label.
    pub id: String,
    /// Stable category resource identifier.
    pub category_id: String,
    /// Exact monetary effect in integer minor units and explicit currency.
    pub amount: Money,
    /// Intended purchase RFC3339 instant inside the horizon.
    pub purchase_at: String,
    /// Latest acceptable payment or transfer arrival RFC3339 instant.
    pub required_by: String,
    /// Trusted explicit/session/preference/history selection in documented precedence.
    pub route_selection: RouteSelection,
}

/// Category Reallocation: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CategoryReallocation {
    /// Stable normalized identity; never a display label.
    pub id: String,
    /// Source category id for this normalized liquidity result.
    pub source_category_id: String,
    /// Destination category id for this normalized liquidity result.
    pub destination_category_id: String,
    /// Exact monetary effect in integer minor units and explicit currency.
    pub amount: Money,
}

/// Liquidity Horizon: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiquidityHorizon {
    /// Inclusive RFC3339 beginning of the evaluation horizon.
    pub starts_at: String,
    /// Exclusive RFC3339 end of the evaluation horizon.
    pub ends_at: String,
}

/// Backing Line: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackingLine {
    /// Stable account resource identifier.
    pub account_id: String,
    /// Stable category resource identifier.
    pub category_id: String,
    /// Disjoint authoritative cash bucket identifying the category's temporal allocation.
    pub cash_bucket_id: String,
    /// Exact monetary effect in integer minor units and explicit currency.
    pub amount: Money,
}

/// Backing Allocation: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackingAllocation {
    /// Version of this immutable domain contract or policy.
    pub version: String,
    /// Canonical snapshot identity bound to the evaluation.
    pub snapshot_id: String,
    /// Canonical composite snapshot content identity.
    pub content_hash: String,
    /// Exact policy version bound to this result.
    pub policy_version: String,
    /// Exact policy content identity supplied by the trusted policy owner.
    pub policy_hash: String,
    /// Independent persisted claim-set revision; not the snapshot revision.
    pub claim_set_revision: String,
    /// Whether every positive category demand is exactly backed on eligible edges.
    pub feasible: bool,
    /// Nonnegative constrained category-to-account allocation edges.
    pub lines: Vec<BackingLine>,
    /// Stable scoped reason codes preserving unavailable or ambiguous evidence.
    pub reasons: Vec<String>,
}

/// Liquidity Input: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiquidityInput {
    /// Complete account/category/budget source enumeration, including requested future months.
    pub source_coverage_complete: bool,
    /// Trusted maximum ledger-observation age; wrapper defaults absent policy to 15 minutes.
    pub max_budget_snapshot_age_minutes: u64,
    /// Canonical snapshot identity bound to the evaluation.
    pub snapshot_id: String,
    /// Canonical composite snapshot content identity.
    pub content_hash: String,
    /// Fixed trusted RFC3339 evaluation instant; no wall clock is consulted.
    pub evaluated_at: String,
    /// Fixed inclusive start and exclusive end for this evaluation.
    pub horizon: LiquidityHorizon,
    /// Normalized liquidity evidence; null returns explicit unavailable conclusions.
    pub facts: Option<LiquidityFacts>,
    /// Effective trusted account and timing policy, separate from institution facts.
    pub liquidity_policy: LiquidityPolicy,
    /// Trusted persisted active claims and independent revision.
    pub claim_set: LiquidityClaimSet,
    /// Optional immutable prior allocation; mismatched identities do not create trusted prior edges.
    pub prior_allocation: Option<BackingAllocation>,
    /// Complete joint hypothetical effects included in the immutable plan hash.
    pub scenario: LiquidityScenario,
    /// Trusted maximum expiry, clamped by relevant evidence, policy and claims.
    pub valid_until: String,
}

/// Budget Funding Status: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetFundingStatus {
    /// Funded.
    Funded,
    /// Unfunded.
    Unfunded,
    /// Insufficient Data.
    InsufficientData,
}

/// Payment Liquidity Status: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentLiquidityStatus {
    /// Ready.
    Ready,
    /// Use Other Account.
    UseOtherAccount,
    /// Transfer Required.
    TransferRequired,
    /// Transfer Too Late.
    TransferTooLate,
    /// Not Liquid.
    NotLiquid,
    /// Insufficient Data.
    InsufficientData,
}

/// Capacity Deduction: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapacityDeduction {
    /// Reason for this normalized liquidity result.
    pub reason: String,
    /// Evidence id for this normalized liquidity result.
    pub evidence_id: String,
    /// Exact monetary effect in integer minor units and explicit currency.
    pub amount: Money,
    /// Whether the deduction reduces backing as well as spending capacity.
    pub affects_backing: bool,
}

/// Account Capacity: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountCapacity {
    /// Stable account resource identifier.
    pub account_id: String,
    /// Signed ledger balance, including exactly the activity marked included.
    pub recorded_balance: Money,
    /// Recorded cash less included unsettled inflows and excluded unsettled outflows.
    pub adjusted_cash: Option<Money>,
    /// Signed additional spending headroom after distinct reserves; may be negative.
    pub signed_headroom: Option<Money>,
    /// Nonnegative amount required to restore existing protected reserves.
    pub existing_shortfall: Option<Money>,
    /// Nonnegative eligible additional payment capacity; null means unresolved evidence.
    pub safe_spending_capacity: Option<Money>,
    /// Nonnegative source excess before scenario-specific constrained backing checks.
    pub safe_transfer_capacity: Option<Money>,
    /// Cash capacity for category backing without double-deducting funded obligations.
    pub backing_capacity: Option<Money>,
    /// Every reserve or unsettled adjustment with identity and amount.
    pub deductions: Vec<CapacityDeduction>,
    /// Stable scoped reason codes preserving unavailable or ambiguous evidence.
    pub reasons: Vec<String>,
}

/// Category Capacity: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CategoryCapacity {
    /// Stable category resource identifier.
    pub category_id: String,
    /// Disjoint authoritative cash bucket; temporal labels come from the matching fact.
    pub cash_bucket_id: String,
    /// Unmodified authoritative category balance before scenario effects.
    pub authoritative_availability: Money,
    /// Authoritative availability after active claims and joint scenario effects.
    pub remaining_availability: Option<Money>,
    /// Stable scoped reason codes preserving unavailable or ambiguous evidence.
    pub reasons: Vec<String>,
}

/// Payment Alternative: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaymentAlternative {
    /// Stable account resource identifier.
    pub account_id: String,
    /// Status for this normalized liquidity result.
    pub status: PaymentLiquidityStatus,
    /// Capacity for this normalized liquidity result.
    pub capacity: Money,
}

/// Account Plan Precondition: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountPlanPrecondition {
    /// Stable account resource identifier.
    pub account_id: String,
    /// Signed ledger balance, including exactly the activity marked included.
    pub recorded_balance: Money,
    /// Signed additional spending headroom after distinct reserves; may be negative.
    pub signed_headroom: Money,
    /// Cash capacity for category backing without double-deducting funded obligations.
    pub backing_capacity: Money,
    /// All preexisting ledger/import identities that cannot prove a new transfer settled.
    pub baseline_transaction_ids: Vec<String>,
}

/// Transfer Leg: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferLeg {
    /// Stable normalized identity; never a display label.
    pub id: String,
    /// Stable transfer source account identifier.
    pub source_account_id: String,
    /// Stable transfer destination account identifier.
    pub destination_account_id: String,
    /// Exact monetary effect in integer minor units and explicit currency.
    pub amount: Money,
    /// Latest acceptable payment or transfer arrival RFC3339 instant.
    pub required_by: String,
    /// Arrival derived only from trusted provider instant or explicit calendar policy.
    pub estimated_arrival: String,
    /// Timing route id for this normalized liquidity result.
    pub timing_route_id: String,
    /// Exact source financial state required before this leg.
    pub source_before: AccountPlanPrecondition,
    /// Exact destination financial state required before this leg.
    pub destination_before: AccountPlanPrecondition,
    /// Signed source headroom after this leg.
    pub source_after: Money,
    /// Signed destination headroom after this leg.
    pub destination_after: Money,
}

/// Transfer Plan: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferPlan {
    /// Version of this immutable domain contract or policy.
    pub version: String,
    /// Canonical snapshot identity bound to the evaluation.
    pub snapshot_id: String,
    /// Canonical composite snapshot content identity.
    pub content_hash: String,
    /// Exact policy version bound to this result.
    pub policy_version: String,
    /// Exact policy content identity supplied by the trusted policy owner.
    pub policy_hash: String,
    /// Independent persisted claim-set revision; not the snapshot revision.
    pub claim_set_revision: String,
    /// Fixed trusted RFC3339 evaluation instant; no wall clock is consulted.
    pub evaluated_at: String,
    /// Fixed exclusive expiry instant in RFC3339; initiated claims remain held past expiry.
    pub expires_at: String,
    /// Exact cumulative same-currency transfer total, including all prerequisite steps.
    pub minimum_amount: Money,
    /// Ordered bank steps for this prefix; distinct steps require exclusive settlement evidence.
    pub legs: Vec<TransferLeg>,
    /// Exact source claim effects that must be admitted atomically with this plan.
    pub reservations: Vec<LiquidityClaimEffect>,
    /// Complete constrained backing following this hypothetical scenario or plan.
    pub backing_after: BackingAllocation,
    /// Complete joint hypothetical effects included in the immutable plan hash.
    pub scenario: LiquidityScenario,
    /// Native hash of financial facts, policy, claim effects and scenario excluding capture identity.
    pub preconditions_hash: String,
    /// Domain-separated SHA256 of sorted-key canonical plan JSON excluding this field only.
    pub payload_hash: String,
}

/// Credit Payment Result: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreditPaymentResult {
    /// Stable account resource identifier.
    pub account_id: String,
    /// Observed available card authorization, never cash backing.
    pub authorization_available: Money,
    /// Authorization remaining after joint pending and prospective card activity.
    pub authorization_after: Money,
    /// Explicit cash account expected to settle the card payment.
    pub payment_account_id: String,
    /// Explicit credit-payment category receiving transformed purchase backing.
    pub payment_category_id: String,
    /// Known obligation or card due instant in RFC3339.
    pub due_at: String,
    /// New card-payment cash demand replacing purchase category backing once.
    pub additional_payment_cash: Money,
    /// Whether the explicit payment cash account covers this purchase by the due date.
    pub payment_cash_ready: bool,
}

/// Purchase Liquidity Result: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurchaseLiquidityResult {
    /// Item id for this normalized liquidity result.
    pub item_id: String,
    /// Stable category resource identifier.
    pub category_id: String,
    /// Category funding independent from account settlement readiness.
    pub budget_funding_status: BudgetFundingStatus,
    /// Payment route readiness independent from category funding.
    pub payment_liquidity_status: PaymentLiquidityStatus,
    /// Resolved selection or null; alternatives never imply automatic selection.
    pub selected_account_id: Option<String>,
    /// Explicit, session, approved preference, historical, or none.
    pub selection_source: String,
    /// Selected before for this normalized liquidity result.
    pub selected_before: Option<AccountCapacity>,
    /// Selected after for this normalized liquidity result.
    pub selected_after: Option<AccountCapacity>,
    /// Alternatives for this normalized liquidity result.
    pub alternatives: Vec<PaymentAlternative>,
    /// Transfer plan for this normalized liquidity result.
    pub transfer_plan: Option<TransferPlan>,
    /// Credit for this normalized liquidity result.
    pub credit: Option<CreditPaymentResult>,
    /// Stable scoped reason codes preserving unavailable or ambiguous evidence.
    pub reasons: Vec<String>,
}

/// Account Aware Spendability Result: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountAwareSpendabilityResult {
    /// Version of this immutable domain contract or policy.
    pub version: String,
    /// Canonical snapshot identity bound to the evaluation.
    pub snapshot_id: String,
    /// Canonical composite snapshot content identity.
    pub content_hash: String,
    /// Exact policy version bound to this result.
    pub policy_version: String,
    /// Exact policy content identity supplied by the trusted policy owner.
    pub policy_hash: String,
    /// Independent persisted claim-set revision; not the snapshot revision.
    pub claim_set_revision: String,
    /// Category funding independent from account settlement readiness.
    pub budget_funding_status: BudgetFundingStatus,
    /// Payment route readiness independent from category funding.
    pub payment_liquidity_status: PaymentLiquidityStatus,
    /// Accounts before for this normalized liquidity result.
    pub accounts_before: Vec<AccountCapacity>,
    /// Accounts after for this normalized liquidity result.
    pub accounts_after: Vec<AccountCapacity>,
    /// Categories for this normalized liquidity result.
    pub categories: Vec<CategoryCapacity>,
    /// Backing before for this normalized liquidity result.
    pub backing_before: BackingAllocation,
    /// Complete constrained backing following this hypothetical scenario or plan.
    pub backing_after: BackingAllocation,
    /// Purchases for this normalized liquidity result.
    pub purchases: Vec<PurchaseLiquidityResult>,
    /// Fixed inclusive start and exclusive end for this evaluation.
    pub horizon: LiquidityHorizon,
    /// Fixed exclusive expiry instant in RFC3339; initiated claims remain held past expiry.
    pub expires_at: String,
    /// Assumptions for this normalized liquidity result.
    pub assumptions: Vec<String>,
    /// Stable scoped reason codes preserving unavailable or ambiguous evidence.
    pub reasons: Vec<String>,
}

/// Settlement Provenance: immutable normalized domain contract.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettlementProvenance {
    /// Separately imported Actual ledger evidence from the trusted adapter.
    ActualImport,
    /// Institution Import.
    InstitutionImport,
    /// Provider Confirmed.
    ProviderConfirmed,
    /// Manual Ledger.
    ManualLedger,
}

/// Transfer Settlement Record: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferSettlementRecord {
    /// Stable normalized identity; never a display label.
    pub id: String,
    /// Stable account resource identifier.
    pub account_id: String,
    /// Exact monetary effect in integer minor units and explicit currency.
    pub amount: Money,
    /// Actual observation instant in RFC3339, not the download time.
    pub observed_at: String,
    /// Actual source date or precise UTC instant; date-only proof is limited to actual_import.
    pub occurred_at: String,
    /// Independent source import identifier; an ID alone is not trusted provenance.
    pub imported_id: Option<String>,
    /// Provider transfer confirmation reference that must agree with Actual evidence.
    pub provider_reference: Option<String>,
    /// Trusted shared transfer pairing identity, not amount-only matching.
    pub pair_id: String,
    /// Whether authoritative Actual evidence records reconciliation.
    pub reconciled: bool,
    /// Whether this evidence represents a reversed transaction.
    pub reversed: bool,
    /// Normalized trust classification; manual ledger rows cannot prove settlement.
    pub provenance: SettlementProvenance,
}

/// Transfer Settlement Request: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferSettlementRequest {
    /// Plan for this normalized liquidity result.
    pub plan: TransferPlan,
    /// Fixed trusted RFC3339 evaluation instant; no wall clock is consulted.
    pub evaluated_at: String,
    /// Records for this normalized liquidity result.
    pub records: Vec<TransferSettlementRecord>,
    /// Evidence identities already consumed by other proposals.
    pub consumed_evidence_ids: Vec<String>,
}

/// Transfer Settlement Result: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferSettlementResult {
    /// True only when every immutable leg has independent reconciled matching sides.
    pub confirmed: bool,
    /// Whether every required source side has independent matching evidence.
    pub source_observed: bool,
    /// Whether every required destination side has independent matching evidence.
    pub destination_observed: bool,
    /// Whether authoritative Actual evidence records reconciliation.
    pub reconciled: bool,
    /// Independent evidence identities to consume exclusively upon successful verification.
    pub evidence_ids: Vec<String>,
    /// Stable scoped reason codes preserving unavailable or ambiguous evidence.
    pub reasons: Vec<String>,
    /// Complete replacement claim bundle effects, including unsettled destination holds.
    pub claim_effects: Option<Vec<LiquidityClaimEffect>>,
}

/// Transfer Precondition Request: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferPreconditionRequest {
    /// Plan for this normalized liquidity result.
    pub plan: TransferPlan,
    /// Fresh trusted normalized input used for pre-initiation revalidation.
    pub current_input: LiquidityInput,
    /// Trusted own reservation to exclude only after exact effect verification.
    pub own_claim_id: Option<String>,
}

/// Transfer Precondition Result: immutable normalized domain contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferPreconditionResult {
    /// Whether the original immutable plan remains actionable before initiation.
    pub valid: bool,
    /// Stable scoped reason codes preserving unavailable or ambiguous evidence.
    pub reasons: Vec<String>,
}

/// Joint hypothetical effects. Reallocation changes category demand only, never cash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum LiquidityScenario {
    /// Base account and category views without a synthetic purchase.
    None,
    /// Joint purchases evaluated in deterministic item-ID order.
    Purchases {
        /// All competing purchase items in this immutable scenario.
        items: Vec<LiquidityPurchaseItem>,
    },
    /// Exact category demand moves; account cash never changes.
    Reallocation {
        /// Ordered-by-ID cash-neutral category movements.
        moves: Vec<CategoryReallocation>,
    },
}

/// Evaluates immutable normalized evidence without reading a clock or mutating a ledger.
pub fn evaluate_account_aware_spendability(
    input: LiquidityInput,
) -> AccountAwareSpendabilityResult {
    engine::evaluate(&input)
}

/// Verifies independent imported and reconciled transfer sides, never ledger entry alone.
pub fn verify_transfer_settlement(request: TransferSettlementRequest) -> TransferSettlementResult {
    engine::settlement(&request)
}

/// Revalidates financial preconditions before initiation, tolerating capture metadata changes only.
pub fn verify_transfer_preconditions(
    request: TransferPreconditionRequest,
) -> TransferPreconditionResult {
    engine::preconditions(&request)
}

/// Exposes sorted-key immutable payload JSON for consumers verifying native SHA256 output.
pub fn canonical_transfer_plan_payload(plan: &TransferPlan) -> Result<String, String> {
    engine::canonical(plan)
}

/// Explicit normalized source recurrence frequency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleFrequency {
    /// Every supplied number of days.
    Daily,
    /// Every supplied number of weeks.
    Weekly,
    /// Every supplied number of months.
    Monthly,
    /// Every supplied number of years.
    Yearly,
}

/// Explicit source recurrence termination condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleEndMode {
    /// Source reports no termination.
    Never,
    /// Terminate after the supplied occurrence count.
    #[serde(rename = "after_n_occurrences")]
    AfterNOccurrences,
    /// Terminate on the supplied date.
    OnDate,
}

/// Source's declared direction for weekend adjustment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleWeekendSolveMode {
    /// Move to the preceding allowed day.
    Before,
    /// Move to the following allowed day.
    After,
}

/// Normalized source weekday or calendar-day recurrence selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SchedulePatternKind {
    /// Sunday.
    Su,
    /// Monday.
    Mo,
    /// Tuesday.
    Tu,
    /// Wednesday.
    We,
    /// Thursday.
    Th,
    /// Friday.
    Fr,
    /// Saturday.
    Sa,
    /// Calendar day.
    Day,
}

/// One explicit source recurrence selector, preserved without guessing its expansion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRecurrencePattern {
    /// Source weekday or day selector.
    pub kind: SchedulePatternKind,
    /// Source selector ordinal, including negative ordinals where reported.
    pub value: i32,
}

/// Typed normalized recurrence configuration; absent fields remain explicitly unknown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleRecurrence {
    /// Source frequency.
    pub frequency: ScheduleFrequency,
    /// Source interval, or unknown.
    pub interval: Option<u32>,
    /// Source selectors, or unknown.
    pub patterns: Option<Vec<ScheduleRecurrencePattern>>,
    /// Source YYYY-MM-DD start date.
    pub start: String,
    /// Explicit termination mode, or unknown.
    pub end_mode: Option<ScheduleEndMode>,
    /// Source terminating occurrence count, if reported.
    pub end_occurrences: Option<u32>,
    /// Source YYYY-MM-DD terminating date, if reported.
    pub end_date: Option<String>,
    /// Explicit source weekend adjustment flag, or unknown.
    pub skip_weekend: Option<bool>,
    /// Explicit source weekend adjustment direction, or unknown.
    pub weekend_solve_mode: Option<ScheduleWeekendSolveMode>,
}
