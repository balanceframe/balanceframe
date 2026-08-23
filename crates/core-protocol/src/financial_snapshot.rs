//! Canonical financial snapshot metadata for deterministic decisions.

use balanceframe_financial_core::{DecisionScope, EvidenceReference};
use serde::{Deserialize, Serialize};

use crate::ProtocolSnapshot;

/// An immutable normalized snapshot and the metadata needed to interpret it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinancialSnapshot {
    /// Version of this canonical snapshot contract.
    pub contract_version: String,
    /// Stable caller-supplied identity for this snapshot.
    pub snapshot_id: String,
    /// Caller-supplied hash of the normalized snapshot content.
    pub content_hash: String,
    /// Namespace of the source ledger represented by the snapshot.
    pub source: SnapshotSource,
    /// ISO-8601 timestamp at which the snapshot was captured.
    pub captured_at: String,
    /// Version of the source-specific normalization process.
    pub source_normalization_version: String,
    /// Unchanged v1 protocol entity payload.
    pub legacy_snapshot: ProtocolSnapshot,
    /// Reported collection coverage for the nested entity payload.
    pub coverage: SnapshotCoverage,
    /// Treatment of unsettled activity in the nested entity payload.
    pub inclusion_scope: InclusionScope,
    /// Source observations that qualify facts in the snapshot.
    pub observations: Vec<SourceObservation>,
}

/// Source namespace for ledger-local identifiers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSource {
    /// Backend or connector family that supplied the ledger.
    pub ledger_backend: String,
    /// Stable identifier of the ledger within its backend namespace.
    pub ledger_id: String,
    /// Stable identifier of the budget within the source ledger.
    pub budget_id: String,
    /// Optional source space or workspace identifier.
    pub space_id: Option<String>,
}

/// Coverage reported for each legacy snapshot collection.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotCoverage {
    /// Coverage of accounts.
    #[serde(default)]
    pub accounts: CoverageState,
    /// Coverage of transactions.
    #[serde(default)]
    pub transactions: CoverageState,
    /// Coverage of categories.
    #[serde(default)]
    pub categories: CoverageState,
    /// Coverage of payees.
    #[serde(default)]
    pub payees: CoverageState,
    /// Coverage of rules.
    #[serde(default)]
    pub rules: CoverageState,
    /// Coverage of schedules.
    #[serde(default)]
    pub schedules: CoverageState,
    /// Coverage of budgets.
    #[serde(default)]
    pub budgets: CoverageState,
    /// Coverage of tags.
    #[serde(default)]
    pub tags: CoverageState,
}

/// Reported completeness of a snapshot collection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoverageState {
    /// The source reported complete coverage.
    Complete,
    /// The source reported that the collection is explicitly empty.
    Empty,
    /// The source did not report whether the collection is covered.
    #[default]
    Unknown,
}

/// Treatment of unsettled activity represented by a snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InclusionScope {
    /// Treatment of pending activity.
    #[serde(default)]
    pub pending_activity: PendingActivityTreatment,
    /// Treatment of uncleared activity.
    #[serde(default)]
    pub uncleared_activity: UnclearedActivityTreatment,
}

/// Treatment of pending activity during source normalization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingActivityTreatment {
    /// Pending activity is included in the snapshot.
    Included,
    /// Pending activity is excluded from the snapshot.
    Excluded,
    /// The source did not report its pending-activity treatment.
    #[default]
    Unknown,
}

/// Treatment of uncleared activity during source normalization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnclearedActivityTreatment {
    /// Uncleared activity is included in the snapshot.
    Included,
    /// Uncleared activity is excluded from the snapshot.
    Excluded,
    /// The source did not report its uncleared-activity treatment.
    #[default]
    Unknown,
}

/// A normalized source observation attached to a decision scope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceObservation {
    /// Kind of fact or data-quality condition observed.
    pub kind: ObservationKind,
    /// Entity or collection to which the observation applies.
    pub scope: DecisionScope,
    /// State observed for the selected kind and scope.
    pub state: ObservationState,
    /// ISO-8601 timestamp at which the source state was observed, when known.
    pub observed_at: Option<String>,
    /// Authorized references supporting the observation, without raw evidence content.
    pub evidence: Vec<EvidenceReference>,
}

/// Kind of source fact or data-quality condition observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationKind {
    /// Freshness of an account's source data.
    AccountFreshness,
    /// Presence and treatment of pending activity.
    PendingActivity,
    /// Presence and treatment of uncleared activity.
    UnclearedActivity,
    /// Coverage of a scheduled obligation.
    ScheduleCoverage,
    /// Coverage of an account's credit-card payment obligation.
    CreditCardObligationCoverage,
    /// A possible duplicate transaction relationship.
    DuplicateCandidate,
    /// An ambiguous transfer relationship.
    TransferAmbiguity,
    /// Reconciliation state of an account or transaction.
    Reconciliation,
    /// Currency compatibility of the relevant facts.
    CurrencyCompatibility,
}

/// State carried by a source observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationState {
    /// The source observation is fresh.
    Fresh,
    /// The source observation is stale.
    Stale,
    /// The source observation is unavailable.
    Unavailable,
    /// The observed activity is included.
    Included,
    /// The observed coverage is complete.
    Complete,
    /// The observed condition is present.
    Present,
    /// The observed relationship is ambiguous.
    Ambiguous,
    /// The observed entity is unreconciled.
    Unreconciled,
    /// The observed currencies are incompatible.
    Incompatible,
}
