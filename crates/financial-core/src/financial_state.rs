//! Financial state labels and data policy for budget intelligence.
//!
//! These types classify the nature of a financial state observation and
//! configure how transaction data is filtered for decision-making.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// FinancialStateLabel
// ---------------------------------------------------------------------------

/// Taxonomy of financial state observations used in budget intelligence.
///
/// Each label identifies the domain of a financial computation result,
/// enabling consumers to distinguish ledger facts from projections,
/// advice, and execution outcomes.
///
/// The default is [`FinancialStateLabel::LedgerFact`] as the base case.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FinancialStateLabel {
    #[default]
    /// A fact derived from the ledger (confirmed cleared balances).
    LedgerFact,
    /// Availability computed from envelope budget balances.
    EnvelopeAvailability,
    /// A forward-looking projection of cash flow.
    CashFlowProjection,
    /// A recommendation or guidance (non-binding).
    Advice,
    /// A concrete proposed action (e.g., reallocation).
    Proposal,
    /// The outcome of executing a proposal.
    ExecutionResult,
    /// A purchase evaluation result (advisory, never authorization).
    PurchaseOutcome,
    /// Liquidity available within a financial account.
    AccountLiquidity,
    /// Funds held aside for an intended use.
    Reservation,
    /// A financial obligation that has been committed.
    Commitment,
    /// An observation captured directly from a source.
    SourceObservation,
    /// Evidence normalized into a canonical financial representation.
    NormalizedEvidence,
    /// The resolved economic event represented by one or more records.
    EconomicEventResolution,
    /// A decision conclusion whose sensitive details have been redacted.
    RedactedConclusion,
}

// ---------------------------------------------------------------------------
// PendingMode
// ---------------------------------------------------------------------------

/// How pending (uncleared) transactions affect availability calculations.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PendingMode {
    /// Include pending transactions as committed outflows, reducing the
    /// effective envelope balance.
    Include,
    /// Exclude pending transactions from availability calculations entirely.
    Exclude,
    /// Include pending transactions as committed outflows and flag the
    /// decision with a pending-exposure blocker (conservative).
    IncludeConservatively,
}

// ---------------------------------------------------------------------------
// UncategorizedMode
// ---------------------------------------------------------------------------

/// How uncategorized transactions affect availability calculations.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UncategorizedMode {
    /// Block the purchase decision when uncategorized transactions exist.
    Block,
    /// Reserve the full uncategorized amount by subtracting it from the
    /// effective envelope balance.
    ReserveFullAmount,
    /// Ignore uncategorized transactions entirely.
    Ignore,
}

// ---------------------------------------------------------------------------
// UnclearedMode
// ---------------------------------------------------------------------------

/// How uncleared (cleared-but-not-reconciled) transactions affect
/// availability calculations.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnclearedMode {
    /// Include uncleared transactions as committed outflows.
    Include,
    /// Exclude uncleared transactions from availability calculations.
    Exclude,
}

// ---------------------------------------------------------------------------
// AccountOverrides
// ---------------------------------------------------------------------------

/// Account-level overrides that narrow or exclude accounts from
/// decision-making.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountOverrides {
    /// If set, only these account IDs are considered in decisions.
    /// `None` means no inclusion filter.
    pub include_only: Option<Vec<String>>,
    /// These account IDs are explicitly excluded from consideration.
    #[serde(default)]
    pub exclude: Vec<String>,
}

// ---------------------------------------------------------------------------
// DecisionDataPolicy
// ---------------------------------------------------------------------------

/// Controls how transaction data is filtered and aged for decision-making.
///
/// Each mode determines whether certain classes of transactions are
/// excluded, included, or cause the decision to be blocked.
///
/// # Default
///
/// The default policy includes pending transactions conservatively (with
/// a flag), reserves the full uncategorized amount, includes uncleared
/// transactions, applies no age limits, and has no account overrides.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionDataPolicy {
    /// How pending transactions affect availability.
    pub pending_mode: PendingMode,
    /// How uncategorized transactions affect availability.
    pub uncategorized_mode: UncategorizedMode,
    /// How uncleared (cleared-but-not-reconciled) transactions affect
    /// availability.
    pub uncleared_mode: UnclearedMode,
    /// Maximum age in minutes for bank sync data before it is considered
    /// stale.  `None` means no age limit.
    pub max_bank_sync_age_minutes: Option<u64>,
    /// Maximum age in minutes for budget snapshot data before it is
    /// considered stale.  `None` means no age limit.
    pub max_budget_snapshot_age_minutes: Option<u64>,
    /// Account-level overrides that narrow or exclude accounts.
    pub account_overrides: AccountOverrides,
}

impl Default for DecisionDataPolicy {
    fn default() -> Self {
        DecisionDataPolicy {
            pending_mode: PendingMode::IncludeConservatively,
            uncategorized_mode: UncategorizedMode::ReserveFullAmount,
            uncleared_mode: UnclearedMode::Include,
            max_bank_sync_age_minutes: None,
            max_budget_snapshot_age_minutes: None,
            account_overrides: AccountOverrides::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[cfg(test)]
mod tests;
