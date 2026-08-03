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
mod tests {
    use super::*;

    // -- FinancialStateLabel -----------------------------------------------

    #[test]
    fn test_label_serialization_camelcase() {
        assert_eq!(
            serde_json::to_string(&FinancialStateLabel::LedgerFact).unwrap(),
            r#""ledgerFact""#,
        );
        assert_eq!(
            serde_json::to_string(&FinancialStateLabel::EnvelopeAvailability).unwrap(),
            r#""envelopeAvailability""#,
        );
        assert_eq!(
            serde_json::to_string(&FinancialStateLabel::CashFlowProjection).unwrap(),
            r#""cashFlowProjection""#,
        );
        assert_eq!(
            serde_json::to_string(&FinancialStateLabel::Advice).unwrap(),
            r#""advice""#,
        );
        assert_eq!(
            serde_json::to_string(&FinancialStateLabel::Proposal).unwrap(),
            r#""proposal""#,
        );
        assert_eq!(
            serde_json::to_string(&FinancialStateLabel::ExecutionResult).unwrap(),
            r#""executionResult""#,
        );
        assert_eq!(
            serde_json::to_string(&FinancialStateLabel::PurchaseOutcome).unwrap(),
            r#""purchaseOutcome""#,
        );
    }

    #[test]
    fn test_label_roundtrip() {
        let labels = [
            FinancialStateLabel::LedgerFact,
            FinancialStateLabel::EnvelopeAvailability,
            FinancialStateLabel::CashFlowProjection,
            FinancialStateLabel::Advice,
            FinancialStateLabel::Proposal,
            FinancialStateLabel::ExecutionResult,
            FinancialStateLabel::PurchaseOutcome,
        ];
        for label in &labels {
            let json = serde_json::to_string(label).unwrap();
            let back: FinancialStateLabel = serde_json::from_str(&json).unwrap();
            assert_eq!(*label, back);
        }
    }

    #[test]
    fn test_label_deserialize_unknown_fails() {
        let result: Result<FinancialStateLabel, _> = serde_json::from_str(r#""bogusLabel""#);
        assert!(result.is_err());
    }

    // -- DecisionDataPolicy default -----------------------------------------

    #[test]
    fn test_policy_default_modes() {
        let p = DecisionDataPolicy::default();
        assert_eq!(p.pending_mode, PendingMode::IncludeConservatively);
        assert_eq!(p.uncategorized_mode, UncategorizedMode::ReserveFullAmount);
        assert_eq!(p.uncleared_mode, UnclearedMode::Include);
        assert_eq!(p.max_bank_sync_age_minutes, None);
        assert_eq!(p.max_budget_snapshot_age_minutes, None);
    }

    #[test]
    fn test_policy_default_account_overrides() {
        let p = DecisionDataPolicy::default();
        assert_eq!(p.account_overrides.include_only, None);
        assert!(p.account_overrides.exclude.is_empty());
    }

    // -- DecisionDataPolicy roundtrip ---------------------------------------

    #[test]
    fn test_policy_roundtrip_json() {
        let p = DecisionDataPolicy {
            pending_mode: PendingMode::Exclude,
            uncategorized_mode: UncategorizedMode::Ignore,
            uncleared_mode: UnclearedMode::Exclude,
            max_bank_sync_age_minutes: Some(1440),
            max_budget_snapshot_age_minutes: Some(60),
            account_overrides: AccountOverrides {
                include_only: Some(vec!["acct_1".into(), "acct_2".into()]),
                exclude: vec!["acct_3".into()],
            },
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains(r#""pendingMode":"exclude""#), "{}", json);
        assert!(json.contains(r#""uncategorizedMode":"ignore""#), "{}", json);
        assert!(json.contains(r#""unclearedMode":"exclude""#), "{}", json);
        assert!(json.contains(r#""maxBankSyncAgeMinutes":1440"#), "{}", json);
        assert!(
            json.contains(r#""maxBudgetSnapshotAgeMinutes":60"#),
            "{}",
            json
        );
        assert!(json.contains(r#""includeOnly""#), "{}", json);
        assert!(json.contains(r#""exclude""#), "{}", json);

        let back: DecisionDataPolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn test_policy_age_limits_none() {
        let p = DecisionDataPolicy {
            max_bank_sync_age_minutes: None,
            max_budget_snapshot_age_minutes: None,
            ..Default::default()
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains(r#""maxBankSyncAgeMinutes":null"#), "{}", json);
        assert!(
            json.contains(r#""maxBudgetSnapshotAgeMinutes":null"#),
            "{}",
            json
        );
        let back: DecisionDataPolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(back.max_bank_sync_age_minutes, None);
        assert_eq!(back.max_budget_snapshot_age_minutes, None);
    }

    // -- AccountOverrides ---------------------------------------------------

    #[test]
    fn test_account_overrides_include_only() {
        let o = AccountOverrides {
            include_only: Some(vec!["a".into(), "b".into()]),
            exclude: vec![],
        };
        let json = serde_json::to_string(&o).unwrap();
        assert!(json.contains(r#""includeOnly""#));
        let back: AccountOverrides = serde_json::from_str(&json).unwrap();
        assert_eq!(o, back);
    }

    #[test]
    fn test_account_overrides_exclude() {
        let o = AccountOverrides {
            include_only: None,
            exclude: vec!["x".into()],
        };
        let json = serde_json::to_string(&o).unwrap();
        assert!(json.contains(r#""includeOnly":null"#));
        let back: AccountOverrides = serde_json::from_str(&json).unwrap();
        assert_eq!(o, back);
    }

    // -- Mode serialization -------------------------------------------------

    #[test]
    fn test_pending_mode_serde() {
        assert_eq!(
            serde_json::to_string(&PendingMode::Include).unwrap(),
            r#""include""#,
        );
        assert_eq!(
            serde_json::to_string(&PendingMode::Exclude).unwrap(),
            r#""exclude""#,
        );
        assert_eq!(
            serde_json::to_string(&PendingMode::IncludeConservatively).unwrap(),
            r#""includeConservatively""#,
        );
    }

    #[test]
    fn test_uncategorized_mode_serde() {
        assert_eq!(
            serde_json::to_string(&UncategorizedMode::Block).unwrap(),
            r#""block""#,
        );
        assert_eq!(
            serde_json::to_string(&UncategorizedMode::ReserveFullAmount).unwrap(),
            r#""reserveFullAmount""#,
        );
        assert_eq!(
            serde_json::to_string(&UncategorizedMode::Ignore).unwrap(),
            r#""ignore""#,
        );
    }

    #[test]
    fn test_uncleared_mode_serde() {
        assert_eq!(
            serde_json::to_string(&UnclearedMode::Include).unwrap(),
            r#""include""#,
        );
        assert_eq!(
            serde_json::to_string(&UnclearedMode::Exclude).unwrap(),
            r#""exclude""#,
        );
    }
}
