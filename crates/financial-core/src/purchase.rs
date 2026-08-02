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
    DecisionDataPolicy, FinancialStateLabel, PendingMode, UnclearedMode, UncategorizedMode,
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

    let projected_balance = match &available_balance {
        Some(b) => Some(b.sub(category_budget).unwrap_or_else(|_| Money::zero(b.currency()))),
        None => None,
    };

    let buffer_remaining = match &available_balance {
        Some(b) => {
            let after_min = b.sub(&policy.minimum_balance).ok();
            after_min.map(|m| {
                if m.is_negative() {
                    Money::zero(m.currency())
                } else {
                    m
                }
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
    for m in [category_budget, category_spent] {
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
        reason_codes.push(PurchaseReasonCode::UncategorizedExposure.as_str().to_string());
    }

    // A stale snapshot without a current account balance cannot support any
    // reliable evaluation.
    if has_stale_snapshot && account_balance.is_none() {
        let ev = build_evidence(
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
            reason_codes.push(PurchaseReasonCode::ReimbursementExpected.as_str().to_string());
            let mut ev = build_evidence(
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
                reason_codes.push(PurchaseReasonCode::ExceedsProtectedBalance.as_str().to_string());
                let mut ev = build_evidence(
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
                if let Some(ref donor) = donor_available {
                    if donor.minor_units() >= deficit.minor_units() {
                        reason_codes.push(PurchaseReasonCode::DonorCovered.as_str().to_string());
                        let mut ev = build_evidence(
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
                reason_codes.push(PurchaseReasonCode::ExceedsProtectedBalance.as_str().to_string());
                let mut ev = build_evidence(
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
                if let Some(ref donor) = donor_available {
                    if donor.minor_units() >= deficit.minor_units() {
                        reason_codes.push(PurchaseReasonCode::DonorCovered.as_str().to_string());
                        let mut ev = build_evidence(
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
                reason_codes.push(PurchaseReasonCode::InsufficientMinimumBalance.as_str().to_string());
                let mut ev = build_evidence(
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
        reason_codes.push(PurchaseReasonCode::ExceedsCategoryBudget.as_str().to_string());

        if let Some(ref donor) = donor_available {
            let deficit = amount.sub(&adjusted_remaining)?;
            if donor.minor_units() >= deficit.minor_units() {
                reason_codes.push(PurchaseReasonCode::DonorCovered.as_str().to_string());
                let mut ev = build_evidence(
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
mod tests {
    use super::*;

    fn default_policy() -> PurchasePolicy {
        PurchasePolicy::default()
    }

    fn default_data_policy() -> DecisionDataPolicy {
        DecisionDataPolicy::default()
    }

    fn usd(units: i64) -> Money {
        Money::new(units, "USD")
    }

    // ======================================================================
    // 1. Approved outcomes
    // ======================================================================

    #[test]
    fn test_approved_within_budget_no_policy() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
        assert!(outcome.reason_codes.contains(&"within_budget".to_string()));
        assert!(outcome.data_blockers.is_empty());
    }

    #[test]
    fn test_approved_reimbursement_always_approved() {
        let outcome = evaluate_purchase(
            &usd(50000),
            &usd(10000),
            &usd(5000),
            Some(&usd(1000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Reimbursement,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
        assert!(outcome.reason_codes.contains(&"reimbursement_expected".to_string()));
    }

    #[test]
    fn test_approved_donor_covers_category_deficit() {
        let outcome = evaluate_purchase(
            &usd(8000),
            &usd(5000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            Some(&usd(20000)),
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
        assert!(outcome.reason_codes.contains(&"donor_covered".to_string()));
    }

    #[test]
    fn test_approved_rollover_applied() {
        let outcome = evaluate_purchase(
            &usd(8000),
            &usd(5000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            Some(&usd(5000)),
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
        assert!(outcome.reason_codes.contains(&"rollover_applied".to_string()));
        assert!(outcome.reason_codes.contains(&"within_budget".to_string()));
    }

    #[test]
    fn test_approved_exact_budget() {
        let outcome = evaluate_purchase(
            &usd(5000),
            &usd(10000),
            &usd(5000),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
        assert!(outcome.reason_codes.contains(&"within_budget".to_string()));
    }

    // ======================================================================
    // 2. Declined outcomes
    // ======================================================================

    #[test]
    fn test_declined_protected_account_below_minimum() {
        let outcome = evaluate_purchase(
            &usd(1000),
            &usd(10000),
            &usd(0),
            Some(&usd(8000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &PurchasePolicy::new(usd(10000), usd(0)),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            true,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Declined);
        assert!(outcome.reason_codes.contains(&"exceeds_protected_balance".to_string()));
    }

    #[test]
    fn test_declined_insufficient_minimum_balance() {
        let outcome = evaluate_purchase(
            &usd(19000),
            &usd(20000),
            &usd(0),
            Some(&usd(20000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &PurchasePolicy::new(usd(10000), usd(5000)),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Declined);
        assert!(outcome.reason_codes.contains(&"insufficient_minimum_balance".to_string()));
    }

    #[test]
    fn test_declined_protected_purchase_breaches_minimum() {
        let outcome = evaluate_purchase(
            &usd(15000),
            &usd(20000),
            &usd(0),
            Some(&usd(20000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &PurchasePolicy::new(usd(10000), usd(0)),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            true,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Declined);
        assert!(outcome.reason_codes.contains(&"exceeds_protected_balance".to_string()));
    }

    // ======================================================================
    // 3. FlaggedForReview outcomes
    // ======================================================================

    #[test]
    fn test_flagged_exceeds_category_budget() {
        let outcome = evaluate_purchase(
            &usd(6000),
            &usd(5000),
            &usd(5000),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::FlaggedForReview);
        assert!(outcome.reason_codes.contains(&"exceeds_category_budget".to_string()));
    }

    #[test]
    fn test_flagged_buffer_consumed_still_above_minimum() {
        let outcome = evaluate_purchase(
            &usd(6000),
            &usd(20000),
            &usd(0),
            Some(&usd(20000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &PurchasePolicy::new(usd(10000), usd(5000)),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::FlaggedForReview);
        assert!(outcome.reason_codes.contains(&"exceeds_buffer".to_string()));
    }

    #[test]
    fn test_flagged_no_account_balance() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            None,
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::FlaggedForReview);
    }

    // ======================================================================
    // 4. InsufficientData outcomes
    // ======================================================================

    #[test]
    fn test_insufficient_data_uncategorized_block() {
        let mut data_policy = default_data_policy();
        data_policy.uncategorized_mode = UncategorizedMode::Block;

        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(5000),
            &usd(0),
            &default_policy(),
            &data_policy,
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::InsufficientData);
        assert!(outcome.reason_codes.contains(&"uncategorized_exposure".to_string()));
    }

    #[test]
    fn test_insufficient_data_stale_snapshot_no_balance() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            None,
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            true,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::InsufficientData);
        assert!(outcome.reason_codes.contains(&"stale_snapshot".to_string()));
    }

    // ======================================================================
    // 5. Transaction semantics
    // ======================================================================

    #[test]
    fn test_semantic_split_applied() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Split,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert!(outcome.reason_codes.contains(&"split_applied".to_string()));
    }

    #[test]
    fn test_semantic_transfer_pair() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Transfer,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert!(outcome.reason_codes.contains(&"transfer_pair".to_string()));
    }

    #[test]
    fn test_semantic_scheduled_payment() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Payment,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert!(outcome.reason_codes.contains(&"scheduled_payment".to_string()));
    }

    // ======================================================================
    // 6. Data quality flags on otherwise approved
    // ======================================================================

    #[test]
    fn test_pending_exposure_flag_approved() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(3000),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert!(outcome.reason_codes.contains(&"pending_exposure".to_string()));
        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
    }

    #[test]
    fn test_uncategorized_exposure_flag_approved() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(5000),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        assert!(outcome.reason_codes.contains(&"uncategorized_exposure".to_string()));
        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
    }

    #[test]
    fn test_stale_snapshot_blocker_emitted() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            true,
            false,
        )
        .unwrap();

        assert!(outcome.reason_codes.contains(&"stale_snapshot".to_string()));
        assert!(!outcome.data_blockers.is_empty());
        assert_eq!(outcome.data_blockers[0].code, "stale_snapshot");
    }

    // ======================================================================
    // 7. PurchasePolicy defaults and edge cases
    // ======================================================================

    #[test]
    fn test_policy_defaults() {
        let p = PurchasePolicy::default();
        assert!(p.minimum_balance.is_zero());
        assert!(p.buffer_amount.is_zero());
    }

    #[test]
    fn test_policy_total_reservation() {
        let p = PurchasePolicy::new(usd(10000), usd(5000));
        assert_eq!(p.total_reservation().unwrap(), usd(15000));
    }

    #[test]
    fn test_zero_amount_approved() {
        let outcome = evaluate_purchase(
            &usd(0),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();
        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
    }

    #[test]
    fn test_zero_budget_zero_spent_approved() {
        let outcome = evaluate_purchase(
            &usd(0),
            &usd(0),
            &usd(0),
            Some(&usd(0)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();
        assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
    }

    // ======================================================================
    // 8. Error cases
    // ======================================================================

    #[test]
    fn test_currency_mismatch_amount_vs_budget() {
        let result = evaluate_purchase(
            &Money::new(2000, "USD"),
            &Money::new(10000, "EUR"),
            &Money::new(0, "USD"),
            Some(&Money::new(50000, "USD")),
            &Money::zero("USD"),
            &Money::zero("USD"),
            &Money::zero("USD"),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        );
        assert!(result.is_err());
        assert!(matches!(result, Err(MoneyError::CurrencyMismatch(_, _))));
    }

    #[test]
    fn test_currency_mismatch_account_balance() {
        let result = evaluate_purchase(
            &Money::new(2000, "USD"),
            &Money::new(10000, "USD"),
            &Money::new(0, "USD"),
            Some(&Money::new(50000, "EUR")),
            &Money::zero("USD"),
            &Money::zero("USD"),
            &Money::zero("USD"),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        );
        assert!(result.is_err());
    }

    // ======================================================================
    // 9. Evidence verification
    // ======================================================================

    #[test]
    fn test_evidence_fields_populated() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(3000),
            Some(&usd(50000)),
            &usd(500),
            &usd(200),
            &usd(100),
            &PurchasePolicy::new(usd(10000), usd(5000)),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        let ev = &outcome.evidence;
        assert_eq!(ev.category_budget, usd(10000));
        assert_eq!(ev.category_spent, usd(3000));
        assert_eq!(ev.category_remaining, usd(7000));
        assert_eq!(ev.account_balance, Some(usd(50000)));
        assert_eq!(ev.pending_total, usd(500));
        assert_eq!(ev.uncategorized_total, usd(200));
        assert_eq!(ev.uncleared_total, usd(100));
        assert!(ev.buffer_remaining.is_some());
    }

    // ======================================================================
    // 10. JSON serialization
    // ======================================================================

    #[test]
    fn test_purchase_outcome_camelcase_keys() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        let json = serde_json::to_string(&outcome).unwrap();
        assert!(json.contains("reasonCodes"));
        assert!(json.contains("dataBlockers"));
        assert!(json.contains("transactionSemantic"));
        assert!(json.contains("categoryRemaining"));
        assert!(json.contains("availableBalance"));
        assert!(json.contains("pendingTotal"));
        assert!(json.contains("uncategorizedTotal"));
        assert!(json.contains("unclearedTotal"));
    }

    #[test]
    fn test_purchase_outcome_roundtrip() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();

        let json = serde_json::to_string(&outcome).unwrap();
        let back: PurchaseOutcome = serde_json::from_str(&json).unwrap();
        assert_eq!(outcome, back);
    }

    #[test]
    fn test_outcome_label_is_advice() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            false,
        )
        .unwrap();
        assert_eq!(outcome.label, FinancialStateLabel::Advice);
    }

    #[test]
    fn test_stale_data_with_balance_still_evaluable() {
        let outcome = evaluate_purchase(
            &usd(2000),
            &usd(10000),
            &usd(0),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            true,
            false,
        )
        .unwrap();

        assert_ne!(outcome.outcome, PurchaseOutcomeKind::InsufficientData);
        assert!(outcome.reason_codes.contains(&"stale_snapshot".to_string()));
    }

    #[test]
    fn test_donor_insufficient_to_cover_deficit() {
        let outcome = evaluate_purchase(
            &usd(12000),
            &usd(10000),
            &usd(1000),
            Some(&usd(50000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            Some(&usd(2000)),
            false,
            false,
            false,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::FlaggedForReview);
        assert!(outcome.reason_codes.contains(&"exceeds_category_budget".to_string()));
        assert!(!outcome.reason_codes.contains(&"donor_covered".to_string()));
    }

    #[test]
    fn stale_bank_sync_with_cached_balance_is_insufficient_data() {
        let outcome = evaluate_purchase(
            &usd(1000),
            &usd(10000),
            &usd(0),
            Some(&usd(100000)),
            &usd(0),
            &usd(0),
            &usd(0),
            &default_policy(),
            &default_data_policy(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            true,
        )
        .unwrap();

        assert_eq!(outcome.outcome, PurchaseOutcomeKind::InsufficientData);
        assert!(outcome.reason_codes.contains(&"stale_bank_sync".to_string()));
    }
}
