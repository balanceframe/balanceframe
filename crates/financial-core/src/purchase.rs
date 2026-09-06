//! Conservative deterministic purchase evaluation engine.
//!
//! This module implements a pure, deterministic evaluation of whether a
//! proposed purchase is allowable under current budget policy and data
//! constraints. It produces exactly one of four outcomes and NEVER
//! authorizes or mutates any state. All arithmetic is checked for
//! overflow and currency mismatch.
//!
//! # Outcomes
//!
//! | Outcome | Meaning |
//! |---|---|
//! | `Approved` | Purchase is allowable under all constraints |
//! | `Declined` | Purchase violates policy or budget constraints |
//! | `FlaggedForReview` | Purchase needs human review (near limits) |
//! | `InsufficientData` | Cannot evaluate due to data quality issues |
//!
//! # Semantic Types
//!
//! Different [`TransactionSemantic`] values change how the evaluation
//! treats the proposed purchase:
//!
//! * `Card` — Standard purchase against category budget and account balance.
//! * `Payment` — Scheduled/known payment; treated as committed outflow.
//! * `Transfer` — Between linked accounts; net-zero effect on overall budget.
//! * `Split` — Portion of a larger split transaction across categories.
//! * `Reimbursement` — Expected repayment; does not consume category budget.
//! * `Rollover` — Unspent category funds carried from a prior period.

use serde::{Deserialize, Serialize};

use crate::financial_state::{
    DecisionDataPolicy, FinancialStateLabel, PendingMode, UncategorizedMode, UnclearedMode,
};
use crate::money::{Money, MoneyError};

// ---------------------------------------------------------------------------
// PurchaseOutcomeKind
// ---------------------------------------------------------------------------

/// The four possible outcomes of a purchase evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PurchaseOutcomeKind {
    /// Purchase is allowed under current policy and budget constraints.
    Approved,
    /// Purchase is denied due to policy or budget constraint violations.
    Declined,
    /// Purchase requires manual review by a human before final decision.
    FlaggedForReview,
    /// Insufficient data quality to produce a determination.
    InsufficientData,
}

// ---------------------------------------------------------------------------
// PurchaseReasonCode
// ---------------------------------------------------------------------------

/// Stable machine-readable reason codes for purchase evaluation.
///
/// Each code serialises to a fixed `snake_case` string that can be
/// relied upon across versions.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PurchaseReasonCode {
    /// The purchase amount is within the available category budget.
    WithinBudget,
    /// The purchase amount is within the configured policy buffer.
    WithinBuffer,
    /// A donor category covered the budget shortfall.
    DonorCovered,
    /// A rollover amount from a prior period was applied.
    RolloverApplied,
    /// A reimbursement is expected for this purchase.
    ReimbursementExpected,
    /// Snapshot data is stale (exceeds max age threshold).
    StaleSnapshot,
    /// Bank sync data is stale (exceeds max age threshold).
    StaleBankSync,
    /// Pending transactions create budgetary exposure.
    PendingExposure,
    /// Uncategorized transactions create budgetary exposure.
    UncategorizedExposure,
    /// The purchase amount exceeds the available category budget.
    ExceedsCategoryBudget,
    /// The purchase would leave insufficient account balance.
    ExceedsAvailableBalance,
    /// The purchase would exceed the policy buffer above the minimum.
    ExceedsBuffer,
    /// The purchase would breach a protected balance threshold.
    ExceedsProtectedBalance,
    /// The purchase would drop the balance below the required minimum.
    InsufficientMinimumBalance,
    /// The target account is excluded by the current decision policy.
    AccountExcludedByPolicy,
    /// The target category is excluded from this evaluation.
    CategoryExcluded,
    /// The transaction is part of a split across categories.
    SplitApplied,
    /// The transaction is a transfer between linked accounts.
    TransferPair,
    /// The transaction is a scheduled payment.
    ScheduledPayment,
}

impl PurchaseReasonCode {
    /// Return the canonical string form of this reason code.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::WithinBudget => "within_budget",
            Self::WithinBuffer => "within_buffer",
            Self::DonorCovered => "donor_covered",
            Self::RolloverApplied => "rollover_applied",
            Self::ReimbursementExpected => "reimbursement_expected",
            Self::StaleSnapshot => "stale_snapshot",
            Self::StaleBankSync => "stale_bank_sync",
            Self::PendingExposure => "pending_exposure",
            Self::UncategorizedExposure => "uncategorized_exposure",
            Self::ExceedsCategoryBudget => "exceeds_category_budget",
            Self::ExceedsAvailableBalance => "exceeds_available_balance",
            Self::ExceedsBuffer => "exceeds_buffer",
            Self::ExceedsProtectedBalance => "exceeds_protected_balance",
            Self::InsufficientMinimumBalance => "insufficient_minimum_balance",
            Self::AccountExcludedByPolicy => "account_excluded_by_policy",
            Self::CategoryExcluded => "category_excluded",
            Self::SplitApplied => "split_applied",
            Self::TransferPair => "transfer_pair",
            Self::ScheduledPayment => "scheduled_payment",
        }
    }
}

impl Serialize for PurchaseReasonCode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PurchaseReasonCode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de;
        let s = String::deserialize(d)?;
        match s.as_str() {
            "within_budget" => Ok(Self::WithinBudget),
            "within_buffer" => Ok(Self::WithinBuffer),
            "donor_covered" => Ok(Self::DonorCovered),
            "rollover_applied" => Ok(Self::RolloverApplied),
            "reimbursement_expected" => Ok(Self::ReimbursementExpected),
            "stale_snapshot" => Ok(Self::StaleSnapshot),
            "stale_bank_sync" => Ok(Self::StaleBankSync),
            "pending_exposure" => Ok(Self::PendingExposure),
            "uncategorized_exposure" => Ok(Self::UncategorizedExposure),
            "exceeds_category_budget" => Ok(Self::ExceedsCategoryBudget),
            "exceeds_available_balance" => Ok(Self::ExceedsAvailableBalance),
            "exceeds_buffer" => Ok(Self::ExceedsBuffer),
            "exceeds_protected_balance" => Ok(Self::ExceedsProtectedBalance),
            "insufficient_minimum_balance" => Ok(Self::InsufficientMinimumBalance),
            "account_excluded_by_policy" => Ok(Self::AccountExcludedByPolicy),
            "category_excluded" => Ok(Self::CategoryExcluded),
            "split_applied" => Ok(Self::SplitApplied),
            "transfer_pair" => Ok(Self::TransferPair),
            "scheduled_payment" => Ok(Self::ScheduledPayment),
            _ => Err(de::Error::unknown_variant(
                &s,
                &[
                    "within_budget",
                    "within_buffer",
                    "donor_covered",
                    "rollover_applied",
                    "reimbursement_expected",
                    "stale_snapshot",
                    "stale_bank_sync",
                    "pending_exposure",
                    "uncategorized_exposure",
                    "exceeds_category_budget",
                    "exceeds_available_balance",
                    "exceeds_buffer",
                    "exceeds_protected_balance",
                    "insufficient_minimum_balance",
                    "account_excluded_by_policy",
                    "category_excluded",
                    "split_applied",
                    "transfer_pair",
                    "scheduled_payment",
                ],
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// TransactionSemantic
// ---------------------------------------------------------------------------

/// The semantic type of the transaction being evaluated.
///
/// Different semantics change how the purchase affects budget calculations.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransactionSemantic {
    /// Standard retail or service card purchase.
    Card,
    /// Bill payment (utility, subscription, loan, rent).
    Payment,
    /// Transfer between linked accounts within the same budget.
    Transfer,
    /// Portion of a larger split transaction across multiple categories.
    Split,
    /// Purchase where a reimbursement is expected from another party.
    Reimbursement,
    /// Rollover of unspent category funds from a prior period.
    Rollover,
}

// ---------------------------------------------------------------------------
// PurchasePolicy
// ---------------------------------------------------------------------------

/// Policy constraints that govern purchase evaluation.
///
/// These values are combined with account balances and category budgets
/// to determine the allowable purchase amount.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchasePolicy {
    /// Minimum balance that must remain in the account after the purchase.
    pub minimum_balance: Money,
    /// Additional buffer amount above the minimum balance.
    pub buffer_amount: Money,
}

impl PurchasePolicy {
    /// Create a new purchase policy with the given minimum and buffer.
    pub fn new(minimum_balance: Money, buffer_amount: Money) -> Self {
        PurchasePolicy {
            minimum_balance,
            buffer_amount,
        }
    }

    /// Total reservation (minimum + buffer).
    pub fn total_reservation(&self) -> Result<Money, MoneyError> {
        self.minimum_balance.add(&self.buffer_amount)
    }
}

impl Default for PurchasePolicy {
    fn default() -> Self {
        PurchasePolicy {
            minimum_balance: Money::zero("USD"),
            buffer_amount: Money::zero("USD"),
        }
    }
}

// ---------------------------------------------------------------------------
// PurchaseEvidence
// ---------------------------------------------------------------------------

/// Structured evidence collected during purchase evaluation.
///
/// All monetary amounts are in the account's currency.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseEvidence {
    /// Budgeted amount for the target category this period.
    pub category_budget: Money,
    /// Amount already spent from this category.
    pub category_spent: Money,
    /// Remaining budget in this category before considering this purchase.
    pub category_remaining: Money,
    /// Effective available balance after policy reserves.
    pub available_balance: Option<Money>,
    /// Projected account balance after purchase.
    pub projected_balance: Option<Money>,
    /// Current cleared account balance (None if unknown).
    pub account_balance: Option<Money>,
    /// Total pending transaction outflow.
    pub pending_total: Money,
    /// Total uncategorized transaction outflow.
    pub uncategorized_total: Money,
    /// Total uncleared (cleared but unreconciled) outflow.
    pub uncleared_total: Money,
    /// Remaining buffer after accounting for this purchase.
    pub buffer_remaining: Option<Money>,
    /// Available donor funds (None if no donor configured).
    pub donor_available: Option<Money>,
    /// Rollover amount applied (None if no rollover).
    pub rollover_applied: Option<Money>,
}

// ---------------------------------------------------------------------------
// PurchaseDataBlocker
// ---------------------------------------------------------------------------

/// A data-quality issue that prevents a reliable purchase evaluation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseDataBlocker {
    /// Machine-readable blocker code.
    pub code: String,
    /// Human-readable explanation.
    pub message: String,
}

impl PurchaseDataBlocker {
    /// Create a new data blocker from a code and message.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        PurchaseDataBlocker {
            code: code.into(),
            message: message.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// PurchaseOutcome
// ---------------------------------------------------------------------------

/// The complete result of a deterministic purchase evaluation.
///
/// Carries all evidence, blockers, and reason codes so consumers can make
/// informed decisions. This type is advisory only — it NEVER authorizes
/// or mutates any state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOutcome {
    /// Financial state label (always [`FinancialStateLabel::Advice`]).
    pub label: FinancialStateLabel,
    /// The four-valued outcome.
    pub outcome: PurchaseOutcomeKind,
    /// Machine-readable reason codes.
    pub reason_codes: Vec<String>,
    /// Structured evidence from the evaluation.
    pub evidence: PurchaseEvidence,
    /// Data-quality blockers encountered.
    pub data_blockers: Vec<PurchaseDataBlocker>,
    /// Semantic type of the evaluated transaction.
    pub transaction_semantic: TransactionSemantic,
}

// ---------------------------------------------------------------------------
// Helpers: effective balance
// ---------------------------------------------------------------------------

/// Compute the effective available balance after applying policy filters.
///
/// Returns `None` when no account balance is available.
fn compute_effective_balance(
    account_balance: Option<&Money>,
    pending_total: &Money,
    uncategorized_total: &Money,
    uncleared_total: &Money,
    data_policy: &DecisionDataPolicy,
) -> Result<Option<Money>, MoneyError> {
    let balance = match account_balance {
        Some(b) => b.clone(),
        None => return Ok(None),
    };

    let mut effective = balance;

    // Reserve pending totals
    match data_policy.pending_mode {
        PendingMode::Exclude => { /* skip */ }
        PendingMode::Include | PendingMode::IncludeConservatively => {
            effective = effective.sub(pending_total)?;
        }
    }

    // Reserve uncategorized totals
    match data_policy.uncategorized_mode {
        UncategorizedMode::Ignore => { /* skip */ }
        UncategorizedMode::ReserveFullAmount | UncategorizedMode::Block => {
            effective = effective.sub(uncategorized_total)?;
        }
    }

    // Reserve uncleared totals
    match data_policy.uncleared_mode {
        UnclearedMode::Exclude => { /* skip */ }
        UnclearedMode::Include => {
            effective = effective.sub(uncleared_total)?;
        }
    }

    Ok(Some(effective))
}

// ---------------------------------------------------------------------------
// Helpers: build evidence
// ---------------------------------------------------------------------------

/// Build a [`PurchaseEvidence`] struct from evaluation inputs.
#[allow(clippy::too_many_arguments)]
fn build_evidence(
    amount: &Money,
    category_budget: &Money,
    category_spent: &Money,
    account_balance: Option<&Money>,
    pending_total: &Money,
    uncategorized_total: &Money,
    uncleared_total: &Money,
    policy: &PurchasePolicy,
    data_policy: &DecisionDataPolicy,
    _rollover_available: Option<&Money>,
    donor_available: Option<&Money>,
) -> Result<PurchaseEvidence, MoneyError> {
    let category_remaining = category_budget.sub(category_spent)?;
    let available_balance = compute_effective_balance(
        account_balance,
        pending_total,
        uncategorized_total,
        uncleared_total,
        data_policy,
    )?;

    let projected_balance = available_balance
        .as_ref()
        .map(|balance| balance.sub(amount))
        .transpose()?;

    let buffer_remaining = match &projected_balance {
        Some(balance) => {
            let after_min = balance.sub(&policy.minimum_balance)?;
            Some(if after_min.is_negative() {
                Money::zero(after_min.currency())
            } else {
                after_min
            })
        }
        None => None,
    };

    Ok(PurchaseEvidence {
        category_budget: category_budget.clone(),
        category_spent: category_spent.clone(),
        category_remaining,
        available_balance,
        projected_balance,
        account_balance: account_balance.cloned(),
        pending_total: pending_total.clone(),
        uncategorized_total: uncategorized_total.clone(),
        uncleared_total: uncleared_total.clone(),
        buffer_remaining,
        donor_available: donor_available.cloned(),
        rollover_applied: None,
    })
}

// ---------------------------------------------------------------------------
// evaluate_purchase
// ---------------------------------------------------------------------------

/// Deterministically evaluate a proposed purchase against budget policy
/// and data constraints.
///
/// This function is purely advisory — it NEVER authorizes or mutates
/// any state. All arithmetic uses checked operations and returns
/// `MoneyError` on overflow or currency mismatch.
///
/// # Outcome selection logic
///
/// 1. **Data quality** — stale snapshot with no account balance, or
///    `UncategorizedMode::Block` with uncategorized transactions, yields
///    `InsufficientData`.
/// 2. **Reimbursements** — always approved (expected repayment).
/// 3. **Protected accounts** — purchases that breach the minimum yield
///    `Declined`.
/// 4. **Minimum balance + buffer** — purchases below the reservation
///    floor yield `Declined`; those consuming only the buffer yield
///    `FlaggedForReview`.
/// 5. **Category budget** — purchases within budget yield `Approved`;
///    those exceeding it yield `FlaggedForReview` (or `Approved` with
///    `DonorCovered` if a donor covers the deficit).
///
/// # Arguments
///
/// * `amount` — Proposed purchase amount (positive for outflow).
/// * `category_budget` — Total budgeted amount for this category.
/// * `category_spent` — Amount already spent in this category.
/// * `account_balance` — Current cleared account balance (`None` if unknown).
/// * `pending_total` — Sum of all pending (uncleared) outflows.
/// * `uncategorized_total` — Sum of all uncategorized outflows.
/// * `uncleared_total` — Sum of all uncleared (cleared but unreconciled) outflows.
/// * `policy` — [`PurchasePolicy`] with minimum balance and buffer.
/// * `data_policy` — [`DecisionDataPolicy`] controlling transaction class inclusion.
/// * `semantic` — [`TransactionSemantic`] of the proposed transaction.
/// * `rollover_available` — Rollover funds from prior period (`None` if none).
/// * `donor_available` — Donor category funds (`None` if none).
/// * `is_protected_account` — Whether the target account is protected.
/// * `has_stale_snapshot` — Whether snapshot data is stale.
/// * `has_stale_bank_sync` — Whether bank sync data is stale.
///
/// # Errors
///
/// Returns `Err(MoneyError::CurrencyMismatch)` when monetary inputs have
/// mismatched currencies, or `Err(MoneyError::Overflow)` on arithmetic
/// overflow.
#[allow(clippy::too_many_arguments)]
pub fn evaluate_purchase(
    amount: &Money,
    category_budget: &Money,
    category_spent: &Money,
    account_balance: Option<&Money>,
    pending_total: &Money,
    uncategorized_total: &Money,
    uncleared_total: &Money,
    policy: &PurchasePolicy,
    data_policy: &DecisionDataPolicy,
    semantic: TransactionSemantic,
    rollover_available: Option<&Money>,
    donor_available: Option<&Money>,
    is_protected_account: bool,
    has_stale_snapshot: bool,
    has_stale_bank_sync: bool,
) -> Result<PurchaseOutcome, MoneyError> {
    // -- Currency checks ---------------------------------------------------
    let currency = amount.currency().to_string();
    for m in [
        category_budget,
        category_spent,
        &policy.minimum_balance,
        &policy.buffer_amount,
    ] {
        if m.currency() != currency {
            return Err(MoneyError::CurrencyMismatch(
                currency.clone(),
                m.currency().to_string(),
            ));
        }
    }
    if let Some(bal) = account_balance {
        if bal.currency() != currency {
            return Err(MoneyError::CurrencyMismatch(
                currency.clone(),
                bal.currency().to_string(),
            ));
        }
    }
    for m in [pending_total, uncategorized_total, uncleared_total] {
        if !m.is_zero() && m.currency() != currency {
            return Err(MoneyError::CurrencyMismatch(
                currency.clone(),
                m.currency().to_string(),
            ));
        }
    }
    if let Some(r) = rollover_available {
        if r.currency() != currency {
            return Err(MoneyError::CurrencyMismatch(
                currency.clone(),
                r.currency().to_string(),
            ));
        }
    }
    if let Some(d) = donor_available {
        if d.currency() != currency {
            return Err(MoneyError::CurrencyMismatch(
                currency,
                d.currency().to_string(),
            ));
        }
    }

    let mut reason_codes: Vec<String> = Vec::new();
    let mut data_blockers: Vec<PurchaseDataBlocker> = Vec::new();

    // -- 1. Data quality checks --------------------------------------------

    if has_stale_snapshot {
        data_blockers.push(PurchaseDataBlocker::new(
            "stale_snapshot",
            "Snapshot data exceeds maximum age threshold; evaluation may be unreliable.",
        ));
        reason_codes.push(PurchaseReasonCode::StaleSnapshot.as_str().to_string());
    }

    if has_stale_bank_sync {
        data_blockers.push(PurchaseDataBlocker::new(
            "stale_bank_sync",
            "Bank sync data is stale; account balance may be inaccurate.",
        ));
        reason_codes.push(PurchaseReasonCode::StaleBankSync.as_str().to_string());
    }

    // Pending exposure
    if !pending_total.is_zero()
        && matches!(
            data_policy.pending_mode,
            PendingMode::IncludeConservatively | PendingMode::Include
        )
    {
        reason_codes.push(PurchaseReasonCode::PendingExposure.as_str().to_string());
    }

    // Uncategorized exposure
    if !uncategorized_total.is_zero()
        && matches!(
            data_policy.uncategorized_mode,
            UncategorizedMode::ReserveFullAmount | UncategorizedMode::Block
        )
    {
        reason_codes.push(
            PurchaseReasonCode::UncategorizedExposure
                .as_str()
                .to_string(),
        );
    }

    // A stale snapshot without a current account balance cannot support any
    // reliable evaluation.
    if has_stale_snapshot && account_balance.is_none() {
        let ev = build_evidence(
            amount,
            category_budget,
            category_spent,
            account_balance,
            pending_total,
            uncategorized_total,
            uncleared_total,
            policy,
            data_policy,
            rollover_available,
            donor_available,
        )?;
        return Ok(PurchaseOutcome {
            label: FinancialStateLabel::Advice,
            outcome: PurchaseOutcomeKind::InsufficientData,
            reason_codes,
            evidence: ev,
            data_blockers,
            transaction_semantic: semantic,
        });
    }

    // Insufficient data: uncategorized block mode with uncategorized txns
    if matches!(data_policy.uncategorized_mode, UncategorizedMode::Block)
        && !uncategorized_total.is_zero()
    {
        let ev = build_evidence(
            amount,
            category_budget,
            category_spent,
            account_balance,
            pending_total,
            uncategorized_total,
            uncleared_total,
            policy,
            data_policy,
            rollover_available,
            donor_available,
        )?;
        return Ok(PurchaseOutcome {
            label: FinancialStateLabel::Advice,
            outcome: PurchaseOutcomeKind::InsufficientData,
            reason_codes,
            evidence: ev,
            data_blockers,
            transaction_semantic: semantic,
        });
    }

    // A stale bank sync invalidates cached balances.  Never approve or
    // otherwise treat them as safe; callers must refresh the account data.
    if has_stale_bank_sync {
        let ev = build_evidence(
            amount,
            category_budget,
            category_spent,
            account_balance,
            pending_total,
            uncategorized_total,
            uncleared_total,
            policy,
            data_policy,
            rollover_available,
            donor_available,
        )?;
        return Ok(PurchaseOutcome {
            label: FinancialStateLabel::Advice,
            outcome: PurchaseOutcomeKind::InsufficientData,
            reason_codes,
            evidence: ev,
            data_blockers,
            transaction_semantic: semantic,
        });
    }

    // -- 2. Available balance ----------------------------------------------
    let effective_balance = compute_effective_balance(
        account_balance,
        pending_total,
        uncategorized_total,
        uncleared_total,
        data_policy,
    )?;

    // -- 3. Category remaining with rollover --------------------------------
    let category_remaining = category_budget.sub(category_spent)?;
    let mut adjusted_remaining = category_remaining.clone();
    let mut rollover_applied: Option<Money> = None;

    if let Some(rollover) = rollover_available {
        if !rollover.is_zero() {
            adjusted_remaining = adjusted_remaining.add(rollover)?;
            reason_codes.push(PurchaseReasonCode::RolloverApplied.as_str().to_string());
            rollover_applied = Some(rollover.clone());
        }
    }

    // -- 4. Semantic adjustments ------------------------------------------
    match semantic {
        TransactionSemantic::Reimbursement => {
            reason_codes.push(
                PurchaseReasonCode::ReimbursementExpected
                    .as_str()
                    .to_string(),
            );
            let mut ev = build_evidence(
                amount,
                category_budget,
                category_spent,
                account_balance,
                pending_total,
                uncategorized_total,
                uncleared_total,
                policy,
                data_policy,
                rollover_available,
                donor_available,
            )?;
            ev.rollover_applied = rollover_applied;
            return Ok(PurchaseOutcome {
                label: FinancialStateLabel::Advice,
                outcome: PurchaseOutcomeKind::Approved,
                reason_codes,
                evidence: ev,
                data_blockers,
                transaction_semantic: semantic,
            });
        }
        TransactionSemantic::Split => {
            reason_codes.push(PurchaseReasonCode::SplitApplied.as_str().to_string());
        }
        TransactionSemantic::Transfer => {
            reason_codes.push(PurchaseReasonCode::TransferPair.as_str().to_string());
        }
        TransactionSemantic::Payment => {
            reason_codes.push(PurchaseReasonCode::ScheduledPayment.as_str().to_string());
        }
        TransactionSemantic::Card | TransactionSemantic::Rollover => {}
    }

    // -- 5. Account policy checks (only with known balance) ----------------
    if let Some(ref bal) = effective_balance {
        let projected_balance = bal.sub(amount)?;

        // Protected account: minimum balance check
        if is_protected_account && !policy.minimum_balance.is_zero() {
            if bal.minor_units() < policy.minimum_balance.minor_units() {
                reason_codes.push(
                    PurchaseReasonCode::ExceedsProtectedBalance
                        .as_str()
                        .to_string(),
                );
                let mut ev = build_evidence(
                    amount,
                    category_budget,
                    category_spent,
                    account_balance,
                    pending_total,
                    uncategorized_total,
                    uncleared_total,
                    policy,
                    data_policy,
                    rollover_available,
                    donor_available,
                )?;
                ev.rollover_applied = rollover_applied;
                return Ok(PurchaseOutcome {
                    label: FinancialStateLabel::Advice,
                    outcome: PurchaseOutcomeKind::Declined,
                    reason_codes,
                    evidence: ev,
                    data_blockers,
                    transaction_semantic: semantic,
                });
            }
            if projected_balance.minor_units() < policy.minimum_balance.minor_units() {
                let deficit = policy.minimum_balance.sub(&projected_balance)?;
                if let Some(donor) = donor_available {
                    if donor.minor_units() >= deficit.minor_units() {
                        reason_codes.push(PurchaseReasonCode::DonorCovered.as_str().to_string());
                        let mut ev = build_evidence(
                            amount,
                            category_budget,
                            category_spent,
                            account_balance,
                            pending_total,
                            uncategorized_total,
                            uncleared_total,
                            policy,
                            data_policy,
                            rollover_available,
                            donor_available,
                        )?;
                        ev.rollover_applied = rollover_applied;
                        return Ok(PurchaseOutcome {
                            label: FinancialStateLabel::Advice,
                            outcome: PurchaseOutcomeKind::Approved,
                            reason_codes,
                            evidence: ev,
                            data_blockers,
                            transaction_semantic: semantic,
                        });
                    }
                }
                reason_codes.push(
                    PurchaseReasonCode::ExceedsProtectedBalance
                        .as_str()
                        .to_string(),
                );
                let mut ev = build_evidence(
                    amount,
                    category_budget,
                    category_spent,
                    account_balance,
                    pending_total,
                    uncategorized_total,
                    uncleared_total,
                    policy,
                    data_policy,
                    rollover_available,
                    donor_available,
                )?;
                ev.rollover_applied = rollover_applied;
                return Ok(PurchaseOutcome {
                    label: FinancialStateLabel::Advice,
                    outcome: PurchaseOutcomeKind::Declined,
                    reason_codes,
                    evidence: ev,
                    data_blockers,
                    transaction_semantic: semantic,
                });
            }
        }

        // General minimum balance + buffer check
        let total_reservation = policy.total_reservation()?;
        if !total_reservation.is_zero() {
            let after_purchase = bal.sub(amount)?;
            let remaining_after_reservation = after_purchase.sub(&total_reservation)?;

            if remaining_after_reservation.is_negative() {
                let deficit = remaining_after_reservation.abs()?;

                // Check donor
                if let Some(donor) = donor_available {
                    if donor.minor_units() >= deficit.minor_units() {
                        reason_codes.push(PurchaseReasonCode::DonorCovered.as_str().to_string());
                        let mut ev = build_evidence(
                            amount,
                            category_budget,
                            category_spent,
                            account_balance,
                            pending_total,
                            uncategorized_total,
                            uncleared_total,
                            policy,
                            data_policy,
                            rollover_available,
                            donor_available,
                        )?;
                        ev.rollover_applied = rollover_applied;
                        return Ok(PurchaseOutcome {
                            label: FinancialStateLabel::Advice,
                            outcome: PurchaseOutcomeKind::Approved,
                            reason_codes,
                            evidence: ev,
                            data_blockers,
                            transaction_semantic: semantic,
                        });
                    }
                }

                // Check if still above minimum (buffer consumed only)
                let remaining_after_min = after_purchase.sub(&policy.minimum_balance)?;
                if !remaining_after_min.is_negative() {
                    reason_codes.push(PurchaseReasonCode::ExceedsBuffer.as_str().to_string());
                    let mut ev = build_evidence(
                        amount,
                        category_budget,
                        category_spent,
                        account_balance,
                        pending_total,
                        uncategorized_total,
                        uncleared_total,
                        policy,
                        data_policy,
                        rollover_available,
                        donor_available,
                    )?;
                    ev.rollover_applied = rollover_applied;
                    return Ok(PurchaseOutcome {
                        label: FinancialStateLabel::Advice,
                        outcome: PurchaseOutcomeKind::FlaggedForReview,
                        reason_codes,
                        evidence: ev,
                        data_blockers,
                        transaction_semantic: semantic,
                    });
                }

                // Below minimum
                reason_codes.push(
                    PurchaseReasonCode::InsufficientMinimumBalance
                        .as_str()
                        .to_string(),
                );
                let mut ev = build_evidence(
                    amount,
                    category_budget,
                    category_spent,
                    account_balance,
                    pending_total,
                    uncategorized_total,
                    uncleared_total,
                    policy,
                    data_policy,
                    rollover_available,
                    donor_available,
                )?;
                ev.rollover_applied = rollover_applied;
                return Ok(PurchaseOutcome {
                    label: FinancialStateLabel::Advice,
                    outcome: PurchaseOutcomeKind::Declined,
                    reason_codes,
                    evidence: ev,
                    data_blockers,
                    transaction_semantic: semantic,
                });
            }
        }
    } else {
        // No balance — flag for review
        let mut ev = build_evidence(
            amount,
            category_budget,
            category_spent,
            account_balance,
            pending_total,
            uncategorized_total,
            uncleared_total,
            policy,
            data_policy,
            rollover_available,
            donor_available,
        )?;
        ev.rollover_applied = rollover_applied;
        return Ok(PurchaseOutcome {
            label: FinancialStateLabel::Advice,
            outcome: PurchaseOutcomeKind::FlaggedForReview,
            reason_codes,
            evidence: ev,
            data_blockers,
            transaction_semantic: semantic,
        });
    }

    // -- 6. Category budget check ------------------------------------------

    let exceeds_category = amount.minor_units() > adjusted_remaining.minor_units();

    if exceeds_category {
        reason_codes.push(
            PurchaseReasonCode::ExceedsCategoryBudget
                .as_str()
                .to_string(),
        );

        if let Some(donor) = donor_available {
            let deficit = amount.sub(&adjusted_remaining)?;
            if donor.minor_units() >= deficit.minor_units() {
                reason_codes.push(PurchaseReasonCode::DonorCovered.as_str().to_string());
                let mut ev = build_evidence(
                    amount,
                    category_budget,
                    category_spent,
                    account_balance,
                    pending_total,
                    uncategorized_total,
                    uncleared_total,
                    policy,
                    data_policy,
                    rollover_available,
                    donor_available,
                )?;
                ev.rollover_applied = rollover_applied;
                return Ok(PurchaseOutcome {
                    label: FinancialStateLabel::Advice,
                    outcome: PurchaseOutcomeKind::Approved,
                    reason_codes,
                    evidence: ev,
                    data_blockers,
                    transaction_semantic: semantic,
                });
            }
        }

        let mut ev = build_evidence(
            amount,
            category_budget,
            category_spent,
            account_balance,
            pending_total,
            uncategorized_total,
            uncleared_total,
            policy,
            data_policy,
            rollover_available,
            donor_available,
        )?;
        ev.rollover_applied = rollover_applied;
        return Ok(PurchaseOutcome {
            label: FinancialStateLabel::Advice,
            outcome: PurchaseOutcomeKind::FlaggedForReview,
            reason_codes,
            evidence: ev,
            data_blockers,
            transaction_semantic: semantic,
        });
    }

    // -- 7. Approved -------------------------------------------------------
    reason_codes.push(PurchaseReasonCode::WithinBudget.as_str().to_string());
    let mut ev = build_evidence(
        amount,
        category_budget,
        category_spent,
        account_balance,
        pending_total,
        uncategorized_total,
        uncleared_total,
        policy,
        data_policy,
        rollover_available,
        donor_available,
    )?;
    ev.rollover_applied = rollover_applied;
    Ok(PurchaseOutcome {
        label: FinancialStateLabel::Advice,
        outcome: PurchaseOutcomeKind::Approved,
        reason_codes,
        evidence: ev,
        data_blockers,
        transaction_semantic: semantic,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[cfg(test)]
mod tests;
