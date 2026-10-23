//! Native planning and verification for exact, source-bound ledger actions.

use crate::{
    evaluate_account_aware_spendability, evaluate_decision_card, AccountAwareSpendabilityRequest,
    CoverageState, DecisionCard, DecisionCardRequest, DecisionContext, EconomicEventLedgerEffect,
    FinancialSnapshot, ObservationKind, ObservationState, SourceObservation,
};

use balanceframe_financial_core::{
    liquidity::{
        AccountAwareSpendabilityResult, FactEvidence, FactSource, FactState,
        LiquidityScenario as Scenario, SettlementProvenance,
    },
    DecisionScope, Money, RedactionState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// One exact month/category budget assignment move.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReallocationAssignment {
    pub source_category_id: String,
    pub source_as_of_month: String,
    pub destination_category_id: String,
    pub destination_as_of_month: String,
    pub amount: Money,
}

/// One split child of an Actual transaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualTransactionSplit {
    pub category_id: String,
    pub amount: Money,
}

/// Stable, caller-assigned identity and exact fields for a manual debit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManualTransactionIntent {
    pub parent_id: String,
    pub correlation_id: String,
    pub account_id: String,
    pub amount: Money,
    pub date: String,
    pub category_id: Option<String>,
    pub payee_name: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub splits: Vec<ManualTransactionSplit>,
}

fn resolution_subject<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

/// Native opening equity bound to a current human-attested before-day balance anchor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalletOpeningIntent {
    pub amount: Money,
    pub date: String,
    pub proof_set_hash: String,
    pub activity_manifest_hash: String,
}

fn wallet_opening<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<WalletOpeningIntent>, D::Error> {
    WalletOpeningIntent::deserialize(deserializer).map(Some)
}

/// Trusted SDK readback, including the native equity marker which ordinary transactions lack.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalletOpeningEquity {
    pub wallet_id: String,
    pub account_id: String,
    pub transaction_id: String,
    pub date: String,
    pub amount: Money,
    pub starting_balance: bool,
    pub sdk_fingerprint: String,
    pub payee_id: Option<String>,
    pub category_id: Option<String>,
}

/// A single atomic action; composites cannot be nested.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AtomicConsequentialActionIntent {
    Reallocation {
        assignments: Vec<ReallocationAssignment>,
    },
    ManualTransaction {
        transaction: ManualTransactionIntent,
    },
    EvidenceProjection {
        transaction: ManualTransactionIntent,
        evidence_ids: Vec<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "resolution_subject"
        )]
        resolution_subject_id: Option<String>,
    },
    /// Create an exact reviewed inflow without a purchase/debit readiness claim.
    EvidenceCredit {
        transaction: ManualTransactionIntent,
        evidence_ids: Vec<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "resolution_subject"
        )]
        resolution_subject_id: Option<String>,
    },
    /// Reclassify an existing settlement while preserving its monetary identity.
    EvidenceAmendment {
        expected: Box<LedgerTransaction>,
        expected_source: Box<balanceframe_financial_core::Transaction>,
        transaction: ManualTransactionIntent,
        evidence_ids: Vec<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "resolution_subject"
        )]
        resolution_subject_id: Option<String>,
    },
    WalletMaterialization {
        wallet_id: String,
        account_name: String,
        currency: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "wallet_opening"
        )]
        opening: Option<WalletOpeningIntent>,
    },
    Transfer {
        transfer_id: String,
        correlation_id: String,
        source_account_id: String,
        destination_account_id: String,
        amount: Money,
        date: String,
    },
}

/// One action or a nonempty, ordered list of non-nested atomic actions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConsequentialActionIntent {
    Reallocation {
        assignments: Vec<ReallocationAssignment>,
    },
    ManualTransaction {
        transaction: ManualTransactionIntent,
    },
    EvidenceProjection {
        transaction: ManualTransactionIntent,
        evidence_ids: Vec<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "resolution_subject"
        )]
        resolution_subject_id: Option<String>,
    },
    /// Create an exact reviewed inflow without a purchase/debit readiness claim.
    EvidenceCredit {
        transaction: ManualTransactionIntent,
        evidence_ids: Vec<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "resolution_subject"
        )]
        resolution_subject_id: Option<String>,
    },
    /// Reclassify an existing settlement while preserving its monetary identity.
    EvidenceAmendment {
        expected: Box<LedgerTransaction>,
        expected_source: Box<balanceframe_financial_core::Transaction>,
        transaction: ManualTransactionIntent,
        evidence_ids: Vec<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "resolution_subject"
        )]
        resolution_subject_id: Option<String>,
    },
    WalletMaterialization {
        wallet_id: String,
        account_name: String,
        currency: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "wallet_opening"
        )]
        opening: Option<WalletOpeningIntent>,
    },
    Transfer {
        transfer_id: String,
        correlation_id: String,
        source_account_id: String,
        destination_account_id: String,
        amount: Money,
        date: String,
    },
    Composite {
        actions: Vec<AtomicConsequentialActionIntent>,
    },
}

impl ConsequentialActionIntent {
    fn atoms(&self) -> Vec<AtomicConsequentialActionIntent> {
        match self {
            Self::Reallocation { assignments } => {
                vec![AtomicConsequentialActionIntent::Reallocation {
                    assignments: assignments.clone(),
                }]
            }
            Self::ManualTransaction { transaction } => {
                vec![AtomicConsequentialActionIntent::ManualTransaction {
                    transaction: transaction.clone(),
                }]
            }
            Self::EvidenceProjection {
                transaction,
                evidence_ids,
                resolution_subject_id,
            } => vec![AtomicConsequentialActionIntent::EvidenceProjection {
                transaction: transaction.clone(),
                evidence_ids: evidence_ids.clone(),
                resolution_subject_id: resolution_subject_id.clone(),
            }],
            Self::EvidenceCredit {
                transaction,
                evidence_ids,
                resolution_subject_id,
            } => vec![AtomicConsequentialActionIntent::EvidenceCredit {
                transaction: transaction.clone(),
                evidence_ids: evidence_ids.clone(),
                resolution_subject_id: resolution_subject_id.clone(),
            }],
            Self::EvidenceAmendment {
                expected,
                expected_source,
                transaction,
                evidence_ids,
                resolution_subject_id,
            } => vec![AtomicConsequentialActionIntent::EvidenceAmendment {
                expected: expected.clone(),
                expected_source: expected_source.clone(),
                transaction: transaction.clone(),
                evidence_ids: evidence_ids.clone(),
                resolution_subject_id: resolution_subject_id.clone(),
            }],
            Self::WalletMaterialization {
                wallet_id,
                account_name,
                currency,
                opening,
            } => vec![AtomicConsequentialActionIntent::WalletMaterialization {
                wallet_id: wallet_id.clone(),
                account_name: account_name.clone(),
                currency: currency.clone(),
                opening: opening.clone(),
            }],
            Self::Transfer {
                transfer_id,
                correlation_id,
                source_account_id,
                destination_account_id,
                amount,
                date,
            } => vec![AtomicConsequentialActionIntent::Transfer {
                transfer_id: transfer_id.clone(),
                correlation_id: correlation_id.clone(),
                source_account_id: source_account_id.clone(),
                destination_account_id: destination_account_id.clone(),
                amount: amount.clone(),
                date: date.clone(),
            }],
            Self::Composite { actions } => actions.clone(),
        }
    }
}

/// Current synchronized ledger facts and durable generated-ID mappings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionLedger {
    pub accounts: Vec<ConsequentialActionAccount>,
    pub categories: Vec<ConsequentialActionCategory>,
    pub assignments: Vec<ConsequentialActionAssignment>,
    pub wallets: Vec<WalletMapping>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wallet_opening_equities: Vec<WalletOpeningEquity>,
    pub transactions: Vec<LedgerTransaction>,
    pub transfers: Vec<TransferMapping>,
}

/// Exact synchronized identity, budget eligibility and balance of one account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionAccount {
    pub account_id: String,
    pub name: String,
    pub on_budget: bool,
    pub closed: bool,
    pub currency: String,
    pub balance: Money,
}

/// Stable identity of a currently available budget category.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionCategory {
    pub category_id: String,
}

/// Assigned amount for one category/month, distinct from its spendable availability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionAssignment {
    pub category_id: String,
    pub as_of_month: String,
    pub amount: Money,
}

/// Durable binding of an approved wallet identity to the Actual-generated account ID.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalletMapping {
    pub wallet_id: String,
    pub account_id: String,
}

/// Exact synchronized transaction fields used to prove the approved manual effect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LedgerTransaction {
    pub parent_id: String,
    pub account_id: String,
    pub amount: Money,
    pub date: String,
    pub category_id: Option<String>,
    pub payee_name: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub splits: Vec<ManualTransactionSplit>,
    pub transfer_account_id: Option<String>,
}

/// Durable identity and reciprocal Actual linkage of a ledger-only transfer pair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferMapping {
    pub transfer_id: String,
    pub correlation_id: String,
    pub marker: String,
    pub source_transaction_id: String,
    pub destination_transaction_id: String,
    pub source_account_id: String,
    pub destination_account_id: String,
    pub amount: Money,
    pub date: String,
}

/// Source-backed evidence resolved by a trusted source normalizer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionEvidence {
    pub evidence_id: String,
    pub subject_id: String,
    pub state: EvidenceState,
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Current resolution availability of a trusted economic-event source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceState {
    Resolved,
    Stale,
    Missing,
}

/// Value-free projection of one currently merged user-attested account observation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionSupplementalObservation {
    /// Account selected by the persisted observation.
    pub account_id: String,
    /// Optional observation keys actually merged into this capture.
    pub fields: Vec<ConsequentialActionSupplementalField>,
    /// IDs of merged user-supplemented unsettled flows.
    pub flow_ids: Vec<String>,
    /// IDs of merged user-supplemented obligations.
    pub obligation_ids: Vec<String>,
}

/// Optional key from a persisted user-attested observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConsequentialActionSupplementalField {
    /// User-supplied account currency.
    Currency,
    /// User-supplied account kind.
    Kind,
    /// User-supplied ownership declaration.
    Owned,
    /// Server-bound current-ledger confirmation.
    CurrentLedgerConfirmed,
    /// User-supplied holds amount.
    Holds,
    /// User-supplied unsettled flow collection.
    UnsettledFlows,
    /// User-supplied cash-obligation collection.
    Obligations,
    /// User-supplied credit declaration.
    Credit,
}

/// A precise account-fact path authorized to disappear when its source observation is invalidated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConsequentialActionSupplementalFactPath {
    /// Account currency value.
    Currency,
    /// Evidence for the account currency value.
    CurrencyEvidence,
    /// Account kind value.
    Kind,
    /// Evidence for the account kind value.
    KindEvidence,
    /// Account ownership value.
    Owned,
    /// Evidence for the account ownership value.
    OwnershipEvidence,
    /// Current-ledger freshness confirmation.
    FreshnessEvidence,
    /// Account holds amount.
    Holds,
    /// Evidence for the account holds amount.
    HoldsEvidence,
    /// User-attested account activity evidence.
    ActivityEvidence,
    /// User-attested account schedule evidence.
    ScheduleEvidence,
    /// User-attested credit declaration.
    Credit,
}

/// Exact derived paths and item IDs that may disappear with a ledger-confirmed observation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionInvalidatedSupplementalFacts {
    /// Account whose persisted supplemental observation was invalidated.
    pub account_id: String,
    /// Optional input keys retained so the exact source projection can be rechecked pre-write.
    pub fields: Vec<ConsequentialActionSupplementalField>,
    /// Only fact paths sourced from that observation.
    pub paths: Vec<ConsequentialActionSupplementalFactPath>,
    /// Only user-supplemented unsettled flows sourced from that observation.
    pub flow_ids: Vec<String>,
    /// Only user-supplemented obligations sourced from that observation.
    pub obligation_ids: Vec<String>,
}

/// Request to produce a deterministic consequential action plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanConsequentialActionRequest {
    pub decision_card_request: DecisionCardRequest,
    pub intent: ConsequentialActionIntent,
    pub current_ledger: ConsequentialActionLedger,
    pub resolved_evidence: Vec<ConsequentialActionEvidence>,
    pub financial_policy_version: String,
    pub evaluated_at: String,
    pub idempotency_key: String,
    /// Value-free projections for active user-attested observations merged into this capture.
    pub supplemental_observations: Vec<ConsequentialActionSupplementalObservation>,
}

/// Source-bound Actual payee selection for one manual transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionManualPayeeBinding {
    /// Manual transaction parent ID selecting this binding.
    pub parent_id: String,
    /// Exact approved display name used by Actual.
    pub payee_name: String,
    /// Existing source payee ID, or `None` when exactly one new payee is authorized.
    pub existing_payee_id: Option<String>,
}

/// Stable source diagnostics and hashes included in every native plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionSource {
    pub snapshot_id: String,
    pub content_hash: String,
    pub policy_version: String,
    pub claim_set_revision: String,
    pub financial_policy_version: String,
    /// Hash of the current source evidence, excluding generated Actual fact capture clocks.
    pub evidence_hash: String,
    /// Accounts whose source-bound user-attested freshness may be invalidated by this action.
    pub invalidated_freshness_accounts: Vec<String>,
    /// Payee IDs and names authorized for each action-created manual transaction.
    pub manual_payee_bindings: Vec<ConsequentialActionManualPayeeBinding>,
    /// Exact derived supplemental fields and items that may disappear after authorized ledger writes.
    pub invalidated_supplemental_facts: Vec<ConsequentialActionInvalidatedSupplementalFacts>,
    /// Account collection coverage in the authorized source snapshot.
    pub accounts_coverage_before: CoverageState,
    /// Transaction collection coverage in the authorized source snapshot.
    pub transactions_coverage_before: CoverageState,
    pub preconditions_hash: String,
    pub invariants_hash: String,
}

/// Stable action rationale code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsequentialActionReasonCode {
    SafeReallocation,
    AccountReadiness,
    PaymentRoute,
    TransferNeed,
    ReservationCommitment,
    EvidenceResolution,
}

/// Typed, native-derived financial effect explanation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
// Keep this bounded wire value inline; boxing the largest variant would allocate per impact.
#[allow(clippy::large_enum_variant)]
pub enum ConsequentialActionImpact {
    CategoryReallocation {
        source_category_id: String,
        source_as_of_month: String,
        destination_category_id: String,
        destination_as_of_month: String,
        amount: Money,
        source_protected: bool,
        source_availability_before: Money,
        source_availability_after: Money,
        source_uncommitted_availability_before: Money,
        source_uncommitted_availability_after: Money,
        minimum_retained: Money,
        projected_remaining_need: Money,
        safe_to_redirect_after: Money,
        rationale: String,
    },
    AccountReadiness {
        account_id: String,
        state: ReadinessState,
    },
    PaymentRoute {
        account_id: String,
        state: ReadinessState,
    },
    TransferNeed {
        account_id: String,
        amount: Money,
    },
    ReservationCommitment {
        category_id: String,
        commitments: Money,
        reservations: Money,
    },
    EvidenceResolution {
        evidence_id: String,
        state: EvidenceState,
    },
}

/// Whether the native payment-account facts permit the proposed action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessState {
    Ready,
    Blocked,
}

/// Exact post-write state expected from the authorized action atoms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConsequentialActionPostcondition {
    Assignment {
        category_id: String,
        as_of_month: String,
        amount: Money,
    },
    AccountBalance {
        account_id: String,
        balance: Money,
    },
    Transaction {
        parent_id: String,
        account_id: String,
        amount: Money,
        date: String,
        category_id: Option<String>,
        payee_name: Option<String>,
        notes: Option<String>,
        splits: Vec<ManualTransactionSplit>,
    },
    WalletMapping {
        wallet_id: String,
        account_name: String,
        on_budget: bool,
        closed: bool,
        opening_balance: Money,
    },
    WalletOpeningEquity {
        wallet_id: String,
        amount: Money,
        date: String,
    },
    TransferLedgerEntry {
        transfer_id: String,
        correlation_id: String,
        source_account_id: String,
        destination_account_id: String,
        amount: Money,
        date: String,
    },
}

/// Exact source values required immediately before an ordered atom is dispatched.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionDispatchPrecondition {
    /// Zero-based position in the ordered atomic action list.
    pub atom_index: usize,
    /// Balance snapshots required by account-transfer writes.
    pub account_balances: Vec<ConsequentialActionAccountBalancePrecondition>,
    /// Assignment snapshots required by category-reallocation writes.
    pub assignments: Vec<ConsequentialActionAssignmentPrecondition>,
}

/// One exact account balance that an adapter must compare before a transfer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionAccountBalancePrecondition {
    /// Stable ledger account identity.
    pub account_id: String,
    /// Exact balance immediately before this action atom.
    pub balance: Money,
}

/// One exact assignment that an adapter must compare before a reallocation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionAssignmentPrecondition {
    /// Stable budget category identity.
    pub category_id: String,
    /// Budget month to compare.
    pub as_of_month: String,
    /// Exact assignment immediately before this action atom.
    pub amount: Money,
    /// Exact assignment immediately after all movements in this action atom.
    pub post_amount: Money,
}

/// Immutable, content-addressed plan produced by the native planner.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionPlan {
    pub version: String,
    pub action: ConsequentialActionIntent,
    pub source: ConsequentialActionSource,
    pub evidence_references: Vec<ConsequentialActionEvidence>,
    pub expires_at: String,
    pub idempotency_key: String,
    pub reason_codes: Vec<ConsequentialActionReasonCode>,
    pub impacts: Vec<ConsequentialActionImpact>,
    pub expected_postconditions: Vec<ConsequentialActionPostcondition>,
    pub action_hash: String,
    /// Per-atom source values derived from the original ledger and authorized action prefix.
    pub dispatch_preconditions: Vec<ConsequentialActionDispatchPrecondition>,
}

/// Verification stage for a consequential action plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationPhase {
    Preconditions,
    Postconditions,
}

/// Revalidation request using a fresh authoritative source capture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyConsequentialActionRequest {
    pub plan: ConsequentialActionPlan,
    pub phase: VerificationPhase,
    pub decision_card_request: DecisionCardRequest,
    pub current_ledger: ConsequentialActionLedger,
    pub resolved_evidence: Vec<ConsequentialActionEvidence>,
    pub evaluated_at: String,
    pub financial_policy_version: String,
}

/// Stable result of pre-write validation or read-only post-write verification.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsequentialActionVerification {
    pub valid: bool,
    pub reason: Option<ConsequentialActionVerificationReason>,
    pub action_hash: String,
}

/// Deterministic reason an immutable plan or its observed ledger effects cannot be verified.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsequentialActionVerificationReason {
    Expired,
    SourceChanged,
    EvidenceChanged,
    PolicyChanged,
    ClaimsChanged,
    TargetChanged,
    PostconditionMismatch,
    InvalidPlan,
}

/// Plan an exact, source-bound consequential action without mutating a ledger.
///
/// Requires current, sufficiently complete financial facts and an exact supported intent.
/// Returns a hashed plan with ordered dispatch preconditions, or a refusal for invalid,
/// insufficient, protected, expired, inconsistent or arithmetically unrepresentable input.
pub fn plan_consequential_action(
    request: PlanConsequentialActionRequest,
) -> Result<ConsequentialActionPlan, String> {
    build_plan(request, true)
}

fn action_accounts(intent: &ConsequentialActionIntent) -> BTreeSet<&str> {
    fn add_atom_accounts<'a>(
        action: &'a AtomicConsequentialActionIntent,
        accounts: &mut BTreeSet<&'a str>,
    ) {
        match action {
            AtomicConsequentialActionIntent::ManualTransaction { transaction }
            | AtomicConsequentialActionIntent::EvidenceProjection { transaction, .. }
            | AtomicConsequentialActionIntent::EvidenceCredit { transaction, .. } => {
                accounts.insert(transaction.account_id.as_str());
            }
            AtomicConsequentialActionIntent::Transfer {
                source_account_id,
                destination_account_id,
                ..
            } => {
                accounts.insert(source_account_id.as_str());
                accounts.insert(destination_account_id.as_str());
            }
            AtomicConsequentialActionIntent::Reallocation { .. }
            | AtomicConsequentialActionIntent::WalletMaterialization { .. }
            | AtomicConsequentialActionIntent::EvidenceAmendment { .. } => {}
        }
    }

    let mut accounts: BTreeSet<&str> = BTreeSet::new();
    match intent {
        ConsequentialActionIntent::ManualTransaction { transaction }
        | ConsequentialActionIntent::EvidenceProjection { transaction, .. }
        | ConsequentialActionIntent::EvidenceCredit { transaction, .. } => {
            accounts.insert(transaction.account_id.as_str());
        }
        ConsequentialActionIntent::Transfer {
            source_account_id,
            destination_account_id,
            ..
        } => {
            accounts.insert(source_account_id.as_str());
            accounts.insert(destination_account_id.as_str());
        }
        ConsequentialActionIntent::Composite { actions } => {
            for action in actions {
                add_atom_accounts(action, &mut accounts);
            }
        }
        ConsequentialActionIntent::Reallocation { .. }
        | ConsequentialActionIntent::WalletMaterialization { .. }
        | ConsequentialActionIntent::EvidenceAmendment { .. } => {}
    }
    accounts
}

fn invalidated_freshness_accounts(request: &PlanConsequentialActionRequest) -> Vec<String> {
    let touched = action_accounts(&request.intent);
    let mut accounts: Vec<_> = request
        .supplemental_observations
        .iter()
        .filter(|observation| {
            touched.contains(observation.account_id.as_str())
                && observation
                    .fields
                    .contains(&ConsequentialActionSupplementalField::CurrentLedgerConfirmed)
        })
        .map(|observation| observation.account_id.clone())
        .collect();
    accounts.sort();
    accounts
}

fn invalidated_supplemental_facts(
    request: &PlanConsequentialActionRequest,
    invalidated_accounts: &[String],
) -> Vec<ConsequentialActionInvalidatedSupplementalFacts> {
    let mut invalidations = Vec::new();
    for observation in &request.supplemental_observations {
        if !invalidated_accounts
            .iter()
            .any(|account_id| account_id == &observation.account_id)
        {
            continue;
        }
        let Some(account) = account_fact(
            &request.decision_card_request.financial_snapshot,
            &observation.account_id,
        ) else {
            continue;
        };
        let mut paths = Vec::new();
        for field in &observation.fields {
            match field {
                ConsequentialActionSupplementalField::Currency => {
                    paths.extend([
                        ConsequentialActionSupplementalFactPath::Currency,
                        ConsequentialActionSupplementalFactPath::CurrencyEvidence,
                    ]);
                }
                ConsequentialActionSupplementalField::Kind => {
                    paths.extend([
                        ConsequentialActionSupplementalFactPath::Kind,
                        ConsequentialActionSupplementalFactPath::KindEvidence,
                    ]);
                }
                ConsequentialActionSupplementalField::Owned => {
                    paths.extend([
                        ConsequentialActionSupplementalFactPath::Owned,
                        ConsequentialActionSupplementalFactPath::OwnershipEvidence,
                    ]);
                }
                ConsequentialActionSupplementalField::CurrentLedgerConfirmed => {
                    paths.push(ConsequentialActionSupplementalFactPath::FreshnessEvidence);
                }
                ConsequentialActionSupplementalField::Holds => {
                    paths.extend([
                        ConsequentialActionSupplementalFactPath::Holds,
                        ConsequentialActionSupplementalFactPath::HoldsEvidence,
                    ]);
                }
                ConsequentialActionSupplementalField::UnsettledFlows => {
                    if account.activity_evidence.source == FactSource::UserAttested {
                        paths.push(ConsequentialActionSupplementalFactPath::ActivityEvidence);
                    }
                }
                ConsequentialActionSupplementalField::Obligations => {
                    if account.schedule_evidence.source == FactSource::UserAttested {
                        paths.push(ConsequentialActionSupplementalFactPath::ScheduleEvidence);
                    }
                }
                ConsequentialActionSupplementalField::Credit => {
                    if account
                        .credit
                        .as_ref()
                        .is_some_and(|credit| credit.evidence.source == FactSource::UserAttested)
                    {
                        paths.push(ConsequentialActionSupplementalFactPath::Credit);
                    }
                }
            }
        }
        paths.sort();
        let mut flow_ids = observation.flow_ids.clone();
        flow_ids.sort();
        let mut obligation_ids = observation.obligation_ids.clone();
        obligation_ids.sort();
        let mut fields = observation.fields.clone();
        fields.sort();
        invalidations.push(ConsequentialActionInvalidatedSupplementalFacts {
            account_id: observation.account_id.clone(),
            fields,
            paths,
            flow_ids,
            obligation_ids,
        });
    }
    invalidations.sort_by(|left, right| left.account_id.cmp(&right.account_id));
    invalidations
}

fn validate_supplemental_observations(
    request: &PlanConsequentialActionRequest,
) -> Result<(), String> {
    let mut seen_accounts = HashSet::new();
    for observation in &request.supplemental_observations {
        if observation.account_id.trim().is_empty()
            || !seen_accounts.insert(observation.account_id.as_str())
        {
            return Err("invalid_or_duplicate_supplemental_account".into());
        }
        let account = account_fact(
            &request.decision_card_request.financial_snapshot,
            &observation.account_id,
        )
        .ok_or("supplemental_account_missing")?;
        let mut fields = HashSet::new();
        if observation
            .fields
            .iter()
            .any(|field| !fields.insert(*field))
        {
            return Err("duplicate_supplemental_field".into());
        }
        let baseline_transaction_ids: HashSet<_> = account
            .baseline_transaction_ids
            .iter()
            .map(String::as_str)
            .collect();
        let mut flow_ids = HashSet::new();
        if observation.flow_ids.iter().any(|id| {
            let mut matching = account.unsettled_flows.iter().filter(|flow| flow.id == *id);
            let flow = matching.next();
            id.trim().is_empty()
                || !flow_ids.insert(id.as_str())
                || !observation
                    .fields
                    .contains(&ConsequentialActionSupplementalField::UnsettledFlows)
                || flow.is_none()
                || matching.next().is_some()
                || flow.is_some_and(|flow| {
                    flow.provenance != SettlementProvenance::ManualLedger
                        || flow.matched_transaction_ids.iter().any(|transaction_id| {
                            baseline_transaction_ids.contains(transaction_id.as_str())
                        })
                        || account.unsettled_flows.iter().any(|other| {
                            other.id != flow.id
                                && other.economic_obligation_id == flow.economic_obligation_id
                        })
                })
        }) {
            return Err("invalid_supplemental_flow_binding".into());
        }
        let mut obligation_ids = HashSet::new();
        if observation.obligation_ids.iter().any(|id| {
            let mut matching = account.obligations.iter().filter(|item| item.id == *id);
            let item = matching.next();
            id.trim().is_empty()
                || !obligation_ids.insert(id.as_str())
                || !observation
                    .fields
                    .contains(&ConsequentialActionSupplementalField::Obligations)
                || item.is_none()
                || matching.next().is_some()
                || item.is_some_and(|item| {
                    item.matched_transaction_ids.iter().any(|transaction_id| {
                        baseline_transaction_ids.contains(transaction_id.as_str())
                    }) || account.obligations.iter().any(|other| {
                        other.id != item.id
                            && other.economic_obligation_id == item.economic_obligation_id
                    })
                })
        }) {
            return Err("invalid_supplemental_obligation_binding".into());
        }
        for field in &observation.fields {
            let valid = match field {
                ConsequentialActionSupplementalField::Currency => {
                    account.currency_evidence.source == FactSource::UserAttested
                }
                ConsequentialActionSupplementalField::Kind => {
                    account.kind_evidence.source == FactSource::UserAttested
                }
                ConsequentialActionSupplementalField::Owned => {
                    account.ownership_evidence.source == FactSource::UserAttested
                }
                ConsequentialActionSupplementalField::CurrentLedgerConfirmed => {
                    account.freshness_evidence.source == FactSource::UserAttested
                }
                ConsequentialActionSupplementalField::Holds => {
                    account.holds_evidence.source == FactSource::UserAttested
                }
                ConsequentialActionSupplementalField::UnsettledFlows
                | ConsequentialActionSupplementalField::Obligations => true,
                ConsequentialActionSupplementalField::Credit => account
                    .credit
                    .as_ref()
                    .is_none_or(|credit| credit.evidence.source == FactSource::UserAttested),
            };
            if !valid {
                return Err("supplemental_field_source_mismatch".into());
            }
        }
    }
    Ok(())
}
fn manual_payee_bindings(
    decision_card_request: &DecisionCardRequest,
    intent: &ConsequentialActionIntent,
) -> Result<Vec<ConsequentialActionManualPayeeBinding>, String> {
    let payees = &decision_card_request
        .financial_snapshot
        .legacy_snapshot
        .payees;
    let coverage = decision_card_request.financial_snapshot.coverage.payees;
    let mut bindings = Vec::new();
    for atom in intent.atoms() {
        let transaction = match atom {
            AtomicConsequentialActionIntent::ManualTransaction { transaction }
            | AtomicConsequentialActionIntent::EvidenceProjection { transaction, .. }
            | AtomicConsequentialActionIntent::EvidenceCredit { transaction, .. } => transaction,
            AtomicConsequentialActionIntent::WalletMaterialization {
                wallet_id,
                opening: Some(opening),
                ..
            } => ManualTransactionIntent {
                parent_id: format!("wallet-opening:{wallet_id}"),
                correlation_id: String::new(),
                account_id: String::new(),
                amount: opening.amount,
                date: opening.date,
                category_id: None,
                payee_name: Some("Starting Balance".into()),
                notes: None,
                splits: vec![],
            },
            _ => continue,
        };
        let Some(payee_name) = transaction
            .payee_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        if !matches!(
            coverage,
            crate::CoverageState::Complete | crate::CoverageState::Empty
        ) || (coverage == crate::CoverageState::Empty && !payees.is_empty())
        {
            return Err("manual_payee_coverage_incomplete".into());
        }
        let mut matches = payees
            .iter()
            .filter(|payee| payee.name.trim() == payee_name);
        let existing_payee_id = matches.next().map(|payee| payee.id.clone());
        if matches.next().is_some() {
            return Err("manual_payee_ambiguous".into());
        }
        bindings.push(ConsequentialActionManualPayeeBinding {
            parent_id: transaction.parent_id.clone(),
            payee_name: payee_name.to_owned(),
            existing_payee_id,
        });
    }
    Ok(bindings)
}

fn build_plan(
    request: PlanConsequentialActionRequest,
    enforce_expiry: bool,
) -> Result<ConsequentialActionPlan, String> {
    let invalidated_freshness_accounts = invalidated_freshness_accounts(&request);
    let invalidated_supplemental_facts =
        invalidated_supplemental_facts(&request, &invalidated_freshness_accounts);
    build_plan_with_invalidated_freshness(
        request,
        enforce_expiry,
        invalidated_freshness_accounts,
        invalidated_supplemental_facts,
    )
}

fn build_plan_with_invalidated_freshness(
    request: PlanConsequentialActionRequest,
    enforce_expiry: bool,
    invalidated_freshness_accounts: Vec<String>,
    invalidated_supplemental_facts: Vec<ConsequentialActionInvalidatedSupplementalFacts>,
) -> Result<ConsequentialActionPlan, String> {
    validate_request(&request, enforce_expiry)?;
    let atoms = request.intent.atoms();
    if atoms.is_empty() {
        return Err("composite_action_empty".into());
    }
    let has_card = atoms.iter().any(|action| {
        matches!(
            action,
            AtomicConsequentialActionIntent::Reallocation { .. }
                | AtomicConsequentialActionIntent::ManualTransaction { .. }
                | AtomicConsequentialActionIntent::EvidenceProjection { .. }
        )
    });
    let card = if has_card {
        Some(evaluate_card(&request)?)
    } else {
        None
    };
    let has_transfer = atoms
        .iter()
        .any(|action| matches!(action, AtomicConsequentialActionIntent::Transfer { .. }));
    let shared = if has_transfer {
        Some(evaluate_shared(&request))
    } else {
        None
    };
    let evidence_references = action_evidence(&request, card.as_ref())?;
    let DerivedAction {
        reason_codes,
        impacts,
        expected_postconditions,
        dispatch_preconditions,
    } = derive_action(
        &request,
        card.as_ref(),
        shared.as_ref(),
        &evidence_references,
        &atoms,
    )?;
    let manual_payee_bindings =
        manual_payee_bindings(&request.decision_card_request, &request.intent)?;
    let source_hash_material = SourceHashMaterial {
        decision_card_request: &request.decision_card_request,
        action: &request.intent,
        ledger: &request.current_ledger,
        evidence: &request.resolved_evidence,
        financial_policy_version: &request.financial_policy_version,
        idempotency_key: &request.idempotency_key,
        invalidated_freshness_accounts: &invalidated_freshness_accounts,
        invalidated_supplemental_facts: &invalidated_supplemental_facts,
        manual_payee_bindings: &manual_payee_bindings,
    };
    let preconditions_hash = hash_material(&source_hash_material, false)?;
    let invariants_hash = hash_material(&source_hash_material, true)?;
    let source = ConsequentialActionSource {
        snapshot_id: request
            .decision_card_request
            .financial_snapshot
            .snapshot_id
            .clone(),
        content_hash: request
            .decision_card_request
            .financial_snapshot
            .content_hash
            .clone(),
        policy_version: request
            .decision_card_request
            .liquidity_policy
            .version
            .clone(),
        claim_set_revision: request.decision_card_request.claim_set.revision.clone(),
        financial_policy_version: request.financial_policy_version.clone(),
        evidence_hash: evidence_material_hash(
            &request.decision_card_request,
            &request.resolved_evidence,
        )?,
        accounts_coverage_before: request
            .decision_card_request
            .financial_snapshot
            .coverage
            .accounts,
        transactions_coverage_before: request
            .decision_card_request
            .financial_snapshot
            .coverage
            .transactions,
        invalidated_freshness_accounts,
        invalidated_supplemental_facts,
        manual_payee_bindings,
        preconditions_hash,
        invariants_hash,
    };
    let mut plan = ConsequentialActionPlan {
        version: "1".into(),
        action: request.intent,
        source,
        evidence_references,
        expires_at: request.decision_card_request.valid_until.clone(),
        idempotency_key: request.idempotency_key,
        reason_codes,
        impacts,
        expected_postconditions,
        action_hash: String::new(),
        dispatch_preconditions,
    };
    plan.action_hash = plan_hash(&plan)?;
    Ok(plan)
}

fn uses_financial_source(intent: &ConsequentialActionIntent) -> bool {
    match intent {
        ConsequentialActionIntent::WalletMaterialization { .. } => false,
        ConsequentialActionIntent::Composite { actions } => actions.iter().any(|action| {
            !matches!(
                action,
                AtomicConsequentialActionIntent::WalletMaterialization { .. }
            )
        }),
        _ => true,
    }
}

fn validate_request(
    request: &PlanConsequentialActionRequest,
    enforce_expiry: bool,
) -> Result<(), String> {
    if request.financial_policy_version.trim().is_empty()
        || request.idempotency_key.trim().is_empty()
    {
        return Err("missing_action_identity".into());
    }
    let now = parse_utc(&request.evaluated_at).ok_or("invalid_evaluated_at")?;
    let until = parse_utc(&request.decision_card_request.valid_until).ok_or("invalid_expiry")?;
    if enforce_expiry && now >= until {
        return Err("expired".into());
    }
    let card_request = &request.decision_card_request;
    parse_utc(&card_request.context.evaluated_at).ok_or("invalid_context_time")?;
    parse_utc(&card_request.context.horizon.starts_at).ok_or("invalid_horizon")?;
    parse_utc(&card_request.context.horizon.ends_at).ok_or("invalid_horizon")?;
    parse_utc(&card_request.liquidity_policy.expires_at).ok_or("invalid_policy_expiry")?;
    if card_request.financial_snapshot.snapshot_id != card_request.context.snapshot_id
        || card_request.financial_snapshot.content_hash != card_request.context.content_hash
        || card_request.liquidity_policy.version != card_request.context.policy_version
        || card_request.liquidity_policy.policy_hash != card_request.context.policy_hash
        || card_request.claim_set.revision.trim().is_empty()
    {
        return Err("source_identity_mismatch".into());
    }
    if uses_financial_source(&request.intent)
        && !crate::account_aware_liquidity::source_coverage_complete(
            &card_request.financial_snapshot,
        )
    {
        return Err("source_coverage_incomplete".into());
    }
    validate_supplemental_observations(request)?;
    validate_resolution_observations(&card_request.financial_snapshot, &request.evaluated_at)?;
    validate_ledger(&request.current_ledger)?;
    let mut evidence_ids = HashSet::new();
    for evidence in &request.resolved_evidence {
        if evidence.evidence_id.trim().is_empty()
            || evidence.subject_id.trim().is_empty()
            || !evidence_ids.insert((evidence.evidence_id.as_str(), evidence.subject_id.as_str()))
        {
            return Err("invalid_or_duplicate_evidence".into());
        }
        if evidence
            .content_hash
            .as_ref()
            .is_some_and(|hash| hash.trim().is_empty())
            || evidence
                .version
                .as_ref()
                .is_some_and(|version| version.trim().is_empty())
        {
            return Err("invalid_evidence_identity".into());
        }
    }
    Ok(())
}

fn validate_economic_event_ledger_effect(effect: &EconomicEventLedgerEffect) -> Result<(), String> {
    if effect.account_id.trim().is_empty()
        || !valid_date(&effect.date)
        || !valid_currency(effect.amount.currency())
        || effect
            .category_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty())
        || effect.splits.iter().any(|split| {
            split.category_id.trim().is_empty()
                || split.amount.currency() != effect.amount.currency()
        })
    {
        return Err("invalid_economic_event_ledger_effect".into());
    }
    if !effect.splits.is_empty() {
        let total = effect.splits.iter().try_fold(0_i64, |total, split| {
            checked_add(total, split.amount.minor_units())
        })?;
        if total != effect.amount.minor_units() {
            return Err("invalid_economic_event_ledger_effect".into());
        }
    }
    Ok(())
}

fn validate_resolution_observations(
    snapshot: &FinancialSnapshot,
    evaluated_at: &str,
) -> Result<(), String> {
    let now = parse_utc(evaluated_at).ok_or("invalid_evaluated_at")?;
    let mut subjects = HashSet::new();
    let mut reference_ids = HashSet::new();
    for observation in &snapshot.observations {
        if let Some(observed_at) = observation.observed_at.as_deref() {
            if parse_utc(observed_at).is_none_or(|observed_at| observed_at > now) {
                return Err("invalid_or_future_observation_time".into());
            }
        }
        if observation.wallet_balance_anchor.is_some()
            && observation.kind != ObservationKind::WalletStatementAnchor
        {
            return Err("wallet_anchor_metadata_not_allowed".into());
        }
        if observation.kind == ObservationKind::EconomicEventResolution {
            let DecisionScope::Transaction(subject_id) = &observation.scope else {
                return Err("invalid_economic_event_resolution_scope".into());
            };
            if subject_id.trim().is_empty()
                || !subjects.insert(subject_id.as_str())
                || observation.state != ObservationState::Resolved
                || observation
                    .content_hash
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                || observation
                    .version
                    .as_deref()
                    .is_none_or(|value| value.trim().is_empty())
                || observation.observed_at.is_none()
                || observation.evidence.is_empty()
                || observation.evidence.iter().any(|reference| {
                    reference.kind != "economic_event_resolution"
                        || !reference.authorized
                        || reference.redaction != RedactionState::Visible
                        || reference.evidence_id.trim().is_empty()
                        || !reference_ids
                            .insert((reference.evidence_id.as_str(), subject_id.as_str()))
                })
            {
                return Err("invalid_economic_event_resolution".into());
            }
            validate_economic_event_ledger_effect(
                observation
                    .ledger_effect
                    .as_ref()
                    .ok_or("economic_event_ledger_effect_required")?,
            )?;
        } else if observation.kind == ObservationKind::WalletStatementAnchor {
            let DecisionScope::Claim(wallet_id) = &observation.scope else {
                return Err("wallet_opening_anchor_invalid_scope".into());
            };
            let anchor = observation
                .wallet_balance_anchor
                .as_ref()
                .ok_or("wallet_opening_anchor_metadata_missing")?;
            if wallet_id.trim().is_empty()
                || anchor.wallet_id != *wallet_id
                || observation.state != ObservationState::Resolved
                || observation.version.as_deref() != Some("wallet-statement-v1")
                || observation.content_hash.as_deref() != Some(anchor.proof_set_hash.as_str())
                || observation.ledger_effect.is_some()
                || observation.allocation_review.is_some()
                || observation.observed_at.is_none()
                || anchor.evidence_ids.is_empty()
                || anchor.evidence_ids.len() != observation.evidence.len()
                || observation.evidence.iter().any(|r| {
                    r.kind != "human_attested_statement"
                        || !r.authorized
                        || r.redaction != RedactionState::Visible
                        || !anchor.evidence_ids.contains(&r.evidence_id)
                })
            {
                return Err("wallet_opening_anchor_invalid".into());
            }
        } else if observation.state == ObservationState::Resolved
            || observation.content_hash.is_some()
            || observation.version.is_some()
            || observation.ledger_effect.is_some()
            || observation.wallet_balance_anchor.is_some()
        {
            return Err("resolution_metadata_not_allowed".into());
        }
        continue;
    }
    Ok(())
}

fn validate_ledger(ledger: &ConsequentialActionLedger) -> Result<(), String> {
    let mut accounts = HashSet::new();
    for account in &ledger.accounts {
        if account.account_id.trim().is_empty()
            || account.name.trim().is_empty()
            || !valid_currency(&account.currency)
            || !accounts.insert(account.account_id.as_str())
            || account.balance.currency() != account.currency
        {
            return Err("invalid_or_duplicate_ledger_account".into());
        }
    }
    let mut categories = HashSet::new();
    if ledger.categories.iter().any(|category| {
        category.category_id.trim().is_empty() || !categories.insert(category.category_id.as_str())
    }) {
        return Err("invalid_or_duplicate_ledger_category".into());
    }
    let mut assignments = HashSet::new();
    for assignment in &ledger.assignments {
        if !categories.contains(assignment.category_id.as_str())
            || !valid_month(&assignment.as_of_month)
            || !valid_currency(assignment.amount.currency())
            || !assignments.insert((
                assignment.category_id.as_str(),
                assignment.as_of_month.as_str(),
            ))
        {
            return Err("invalid_or_duplicate_assignment".into());
        }
    }
    let mut wallet_ids = HashSet::new();
    let mut wallet_accounts = HashSet::new();
    for wallet in &ledger.wallets {
        if wallet.wallet_id.trim().is_empty()
            || !accounts.contains(wallet.account_id.as_str())
            || !wallet_ids.insert(wallet.wallet_id.as_str())
            || !wallet_accounts.insert(wallet.account_id.as_str())
        {
            return Err("invalid_or_duplicate_wallet_mapping".into());
        }
    }
    let mut opening_wallets = HashSet::new();
    for equity in &ledger.wallet_opening_equities {
        if !opening_wallets.insert(&equity.wallet_id) || !valid_opening_equity(ledger, equity) {
            return Err("invalid_wallet_opening_equity".into());
        }
    }
    let mut tx_ids = HashSet::new();
    for tx in &ledger.transactions {
        let Some(account) = ledger
            .accounts
            .iter()
            .find(|account| account.account_id == tx.account_id)
        else {
            return Err("transaction_account_missing".into());
        };
        if tx.parent_id.trim().is_empty()
            || !tx_ids.insert(tx.parent_id.as_str())
            || !valid_date(&tx.date)
            || tx.amount.currency() != account.currency
            || tx.splits.iter().any(|split| {
                !categories.contains(split.category_id.as_str())
                    || split.amount.currency() != account.currency
            })
        {
            return Err("invalid_or_duplicate_ledger_transaction".into());
        }
        if tx
            .transfer_account_id
            .as_ref()
            .is_some_and(|id| !accounts.contains(id.as_str()))
        {
            return Err("transaction_transfer_account_missing".into());
        }
    }
    let mut transfer_ids = HashSet::new();
    let mut correlations = HashSet::new();
    let mut transfer_rows = HashSet::new();
    for transfer in &ledger.transfers {
        if transfer.transfer_id.trim().is_empty()
            || transfer.correlation_id.trim().is_empty()
            || !transfer_ids.insert(transfer.transfer_id.as_str())
            || !correlations.insert(transfer.correlation_id.as_str())
            || !transfer_rows.insert(transfer.source_transaction_id.as_str())
            || !transfer_rows.insert(transfer.destination_transaction_id.as_str())
        {
            return Err("invalid_or_duplicate_transfer_mapping".into());
        }
        validate_transfer_mapping(ledger, transfer)?;
    }
    Ok(())
}

fn validate_transfer_mapping(
    ledger: &ConsequentialActionLedger,
    mapping: &TransferMapping,
) -> Result<(), String> {
    let marker = format!(
        "balanceframe:transfer:{}:{}",
        mapping.transfer_id, mapping.correlation_id
    );
    let source = ledger
        .transactions
        .iter()
        .find(|tx| tx.parent_id == mapping.source_transaction_id)
        .ok_or("transfer_source_row_missing")?;
    let destination = ledger
        .transactions
        .iter()
        .find(|tx| tx.parent_id == mapping.destination_transaction_id)
        .ok_or("transfer_destination_row_missing")?;
    let amount = mapping.amount.minor_units();
    if amount <= 0
        || mapping.marker != marker
        || source.parent_id == destination.parent_id
        || source.account_id != mapping.source_account_id
        || destination.account_id != mapping.destination_account_id
        || source.transfer_account_id.as_deref() != Some(mapping.destination_account_id.as_str())
        || destination.transfer_account_id.as_deref() != Some(mapping.source_account_id.as_str())
        || source.notes.as_deref() != Some(marker.as_str())
        || destination.notes.as_deref() != Some(marker.as_str())
        || source.amount.minor_units() != amount.checked_neg().ok_or("money_overflow")?
        || destination.amount.minor_units() != amount
        || source.amount.currency() != mapping.amount.currency()
        || destination.amount.currency() != mapping.amount.currency()
        || source.date != mapping.date
        || destination.date != mapping.date
        || !valid_date(&mapping.date)
        || mapping.source_account_id == mapping.destination_account_id
        || source.category_id.is_some()
        || destination.category_id.is_some()
        || !source.splits.is_empty()
        || !destination.splits.is_empty()
    {
        return Err("transfer_mapping_mismatch".into());
    }
    Ok(())
}

fn account_fact<'a>(
    snapshot: &'a FinancialSnapshot,
    id: &str,
) -> Option<&'a balanceframe_financial_core::liquidity::AccountLiquidityFact> {
    snapshot
        .liquidity
        .as_ref()?
        .accounts
        .iter()
        .find(|account| account.account_id == id)
}

fn category_fact<'a>(
    snapshot: &'a FinancialSnapshot,
    id: &str,
    month: &str,
) -> Option<&'a balanceframe_financial_core::liquidity::CategoryLiquidityFact> {
    snapshot
        .liquidity
        .as_ref()?
        .categories
        .iter()
        .find(|category| category.category_id == id && category.as_of_month == month)
}

fn matches_positive_debit(purchase: &Money, debit: &Money) -> bool {
    debit
        .minor_units()
        .checked_neg()
        .filter(|amount| *amount > 0)
        == Some(purchase.minor_units())
        && debit.currency() == purchase.currency()
}

fn evaluate_card(request: &PlanConsequentialActionRequest) -> Result<DecisionCard, String> {
    if request.decision_card_request.items.is_empty() {
        return Err("purchase_card_required_for_category_action".into());
    }
    let mut source = request.decision_card_request.clone();
    source.context.evaluated_at = request.evaluated_at.clone();
    // Approval delay advances only exact immediate debit projections, never their hashed source.
    for atom in request.intent.atoms() {
        let transaction = match atom {
            AtomicConsequentialActionIntent::ManualTransaction { transaction }
            | AtomicConsequentialActionIntent::EvidenceProjection { transaction, .. }
            | AtomicConsequentialActionIntent::EvidenceCredit { transaction, .. } => transaction,
            AtomicConsequentialActionIntent::WalletMaterialization {
                wallet_id,
                opening: Some(opening),
                ..
            } => ManualTransactionIntent {
                parent_id: format!("wallet-opening:{wallet_id}"),
                correlation_id: String::new(),
                account_id: String::new(),
                amount: opening.amount,
                date: opening.date,
                category_id: None,
                payee_name: Some("Starting Balance".into()),
                notes: None,
                splits: vec![],
            },
            _ => continue,
        };
        for item in &mut source.items {
            if item.purchase_at != source.context.horizon.starts_at
                || item.required_by != item.purchase_at
                || item.purchase_at.get(..10) != request.evaluated_at.get(..10)
                || parse_utc(&item.purchase_at) >= parse_utc(&request.evaluated_at)
                || item.route_selection.explicit_account_id.as_deref()
                    != Some(&transaction.account_id)
                || item.route_selection.session_account_id.is_some()
                || item.quantity.is_some()
                || item.category_allocations.is_some()
                || item.price_provenance.is_some()
                || item.barcode.is_some()
            {
                continue;
            }
            let matches = if transaction.splits.is_empty() {
                item.id == transaction.parent_id
                    && transaction.category_id.as_deref() == Some(item.category_id.as_str())
                    && matches_positive_debit(&item.amount, &transaction.amount)
            } else {
                transaction.splits.iter().enumerate().any(|(index, split)| {
                    item.id == format!("{}:split:{index}", transaction.parent_id)
                        && item.category_id == split.category_id
                        && matches_positive_debit(&item.amount, &split.amount)
                })
            };
            if matches {
                item.purchase_at = request.evaluated_at.clone();
                item.required_by = request.evaluated_at.clone();
            }
        }
    }
    let card = evaluate_decision_card(source);
    if !card.blockers.is_empty() || card.outcome == "insufficient_data" {
        let class = if card
            .blockers
            .iter()
            .any(|blocker| blocker.contains("evidence"))
        {
            "decision_card_evidence_blocked"
        } else {
            "decision_card_source_blocked"
        };
        return Err(class.into());
    }
    Ok(card)
}

fn evaluate_shared(request: &PlanConsequentialActionRequest) -> AccountAwareSpendabilityResult {
    let card = &request.decision_card_request;
    let mut context: DecisionContext = card.context.clone();
    context.evaluated_at = request.evaluated_at.clone();
    evaluate_account_aware_spendability(AccountAwareSpendabilityRequest {
        financial_snapshot: card.financial_snapshot.clone(),
        context,
        liquidity_policy: card.liquidity_policy.clone(),
        claim_set: card.claim_set.clone(),
        prior_allocation: card.prior_allocation.clone(),
        scenario: Scenario::None,
        valid_until: card.valid_until.clone(),
    })
}

fn wallet_opening_anchor<'a>(
    request: &'a PlanConsequentialActionRequest,
    wallet_id: &str,
    currency: &str,
    opening: &WalletOpeningIntent,
) -> Result<&'a SourceObservation, String> {
    if opening.amount.minor_units() <= 0
        || opening.amount.currency() != currency
        || !valid_date(&opening.date)
        || !hash_valid(&opening.proof_set_hash)
        || !hash_valid(&opening.activity_manifest_hash)
    {
        return Err("wallet_opening_invalid".into());
    }
    let observations: std::collections::BTreeMap<_, _> = request
        .decision_card_request
        .financial_snapshot
        .observations
        .iter()
        .filter(|observation| {
            let value = serde_json::to_value(observation).unwrap_or(Value::Null);
            value["kind"] == "wallet_statement_anchor"
                && value["scope"]["kind"] == "claim"
                && value["scope"]["id"] == wallet_id
                && value["walletBalanceAnchor"]["boundary"] == "before_day_activity"
                && value["walletBalanceAnchor"]["asOfDate"] == opening.date
                && value["walletBalanceAnchor"]["amount"]
                    == serde_json::to_value(&opening.amount).unwrap_or(Value::Null)
                && value["walletBalanceAnchor"]["proofSetHash"] == opening.proof_set_hash
                && value["walletBalanceAnchor"]["activityManifestHash"]
                    == opening.activity_manifest_hash
        })
        .map(|observation| {
            (
                serde_json::to_vec(observation).unwrap_or_default(),
                observation,
            )
        })
        .collect();
    if observations.len() != 1 {
        return Err("wallet_opening_anchor_missing_or_ambiguous".into());
    }
    let observation = *observations.values().next().unwrap();
    let value = serde_json::to_value(observation).map_err(|_| "wallet_opening_anchor_invalid")?;
    let anchor = &value["walletBalanceAnchor"];
    if value["state"] != "resolved"
        || value["contentHash"] != opening.proof_set_hash
        || anchor["walletId"] != wallet_id
        || anchor["amount"] != serde_json::to_value(&opening.amount).unwrap_or(Value::Null)
        || anchor["asOfDate"] != opening.date
        || anchor["boundary"] != "before_day_activity"
        || anchor["proofSetHash"] != opening.proof_set_hash
        || anchor["activityManifestHash"] != opening.activity_manifest_hash
        || anchor["proofIds"].as_array().is_none_or(Vec::is_empty)
        || anchor["evidenceIds"].as_array().is_none_or(Vec::is_empty)
        || observation.evidence.is_empty()
        || value["evidence"].as_array().is_none_or(|refs| {
            refs.iter().any(|reference| {
                reference["kind"] != "human_attested_statement"
                    || reference["authorized"] != true
                    || reference["redaction"] != "visible"
            })
        })
        || anchor["evidenceIds"].as_array().is_none_or(|ids| {
            ids.len() != observation.evidence.len()
                || ids.iter().any(|id| {
                    !value["evidence"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|r| r["evidenceId"] == *id)
                })
        })
    {
        return Err("wallet_opening_anchor_mismatch".into());
    }
    Ok(observation)
}
fn hash_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn add_observation_evidence(
    request: &PlanConsequentialActionRequest,
    evidence: &mut BTreeMap<String, String>,
    scope: &DecisionScope,
) -> Result<(), String> {
    let subject_id = match scope {
        DecisionScope::Account(id)
        | DecisionScope::Category(id)
        | DecisionScope::Transaction(id)
        | DecisionScope::Schedule(id)
        | DecisionScope::Claim(id) => id,
        DecisionScope::Global => return Ok(()),
    };
    for observation in request
        .decision_card_request
        .financial_snapshot
        .observations
        .iter()
        .filter(|observation| &observation.scope == scope)
    {
        for reference in observation.evidence.iter().filter(|reference| {
            reference.authorized && reference.redaction == RedactionState::Visible
        }) {
            if reference.evidence_id.trim().is_empty()
                || evidence
                    .insert(reference.evidence_id.clone(), subject_id.clone())
                    .is_some_and(|previous| previous != *subject_id)
            {
                return Err("evidence_subject_mismatch".into());
            }
        }
    }
    Ok(())
}

fn event_resolution_for_evidence<'a>(
    request: &'a PlanConsequentialActionRequest,
    evidence_id: &str,
    resolution_subject_id: Option<&str>,
) -> Result<&'a SourceObservation, String> {
    let mut candidates = request
        .decision_card_request
        .financial_snapshot
        .observations
        .iter()
        .filter(|observation| {
            observation.kind == ObservationKind::EconomicEventResolution
                && resolution_subject_id
                    .is_none_or(|subject| event_subject(observation).ok() == Some(subject))
                && observation.evidence.iter().any(|reference| {
                    reference.evidence_id == evidence_id
                        && reference.kind == "economic_event_resolution"
                        && reference.authorized
                        && reference.redaction == RedactionState::Visible
                })
        });
    let observation = candidates
        .next()
        .ok_or("trusted_resolution_observation_missing")?;
    if candidates.next().is_some() {
        return Err("ambiguous_evidence_resolution".into());
    }
    Ok(observation)
}

fn event_subject(observation: &SourceObservation) -> Result<&str, String> {
    match &observation.scope {
        DecisionScope::Transaction(subject_id) => Ok(subject_id),
        _ => Err("invalid_economic_event_resolution_scope".into()),
    }
}

fn evidence_write_shape(
    request: &PlanConsequentialActionRequest,
    transaction: &ManualTransactionIntent,
) -> Result<(), String> {
    if transaction.parent_id.trim().is_empty()
        || transaction.correlation_id.trim().is_empty()
        || !valid_date(&transaction.date)
        || transaction.amount.minor_units() == 0
        || transaction.date.as_str()
            > request
                .evaluated_at
                .get(..10)
                .ok_or("invalid_evaluated_at")?
    {
        return Err("invalid_evidence_transaction".into());
    }
    let snapshot = &request.decision_card_request.financial_snapshot;
    let now = parse_utc(&request.evaluated_at).ok_or("invalid_evaluated_at")?;
    let captured = parse_utc(&snapshot.captured_at).ok_or("invalid_snapshot_time")?;
    let maximum = request
        .decision_card_request
        .context
        .policy
        .max_budget_snapshot_age_minutes
        .ok_or("snapshot_freshness_policy_required")?;
    if captured > now
        || now - captured > i128::from(maximum) * 60_000_000_000
        || now
            >= parse_utc(&request.decision_card_request.liquidity_policy.expires_at)
                .ok_or("invalid_policy_expiry")?
    {
        return Err("stale_evidence_action_source".into());
    }
    let account = live_account(request, &transaction.account_id)?;
    if transaction.amount.currency() != account.currency {
        return Err("evidence_transaction_currency_mismatch".into());
    }
    if !transaction.splits.is_empty() && transaction.category_id.is_some() {
        return Err("split_parent_category_must_be_null".into());
    }
    let mut total = 0i64;
    for split in &transaction.splits {
        if split.amount.currency() != transaction.amount.currency()
            || split.amount.minor_units().signum() != transaction.amount.minor_units().signum()
        {
            return Err("invalid_evidence_split".into());
        }
        total = checked_add(total, split.amount.minor_units())?;
    }
    if !transaction.splits.is_empty() && total != transaction.amount.minor_units() {
        return Err("split_total_mismatch".into());
    }
    for (category, _) in transaction_category_deltas(transaction) {
        if category.trim().is_empty()
            || !request
                .current_ledger
                .categories
                .iter()
                .any(|current| current.category_id == category)
        {
            return Err("evidence_category_missing".into());
        }
        let fact = category_fact(snapshot, category, &transaction.date[..7])
            .ok_or("evidence_category_fact_missing")?;
        if fact.availability.currency() != transaction.amount.currency() {
            return Err("evidence_category_currency_mismatch".into());
        }
    }
    Ok(())
}
fn transaction_postcondition(
    transaction: &ManualTransactionIntent,
) -> ConsequentialActionPostcondition {
    ConsequentialActionPostcondition::Transaction {
        parent_id: transaction.parent_id.clone(),
        account_id: transaction.account_id.clone(),
        amount: transaction.amount.clone(),
        date: transaction.date.clone(),
        category_id: transaction.category_id.clone(),
        payee_name: transaction.payee_name.clone(),
        notes: transaction.notes.clone(),
        splits: transaction.splits.clone(),
    }
}
fn validate_evidence_credit(
    request: &PlanConsequentialActionRequest,
    transaction: &ManualTransactionIntent,
    evidence_selection: (&[String], Option<&str>),
    seen_ids: &mut HashSet<String>,
    seen_correlations: &mut HashSet<String>,
    balances: &mut BTreeMap<String, Money>,
    postconditions: &mut Vec<ConsequentialActionPostcondition>,
) -> Result<(), String> {
    let (evidence_ids, resolution_subject_id) = evidence_selection;
    evidence_write_shape(request, transaction)?;
    if transaction.amount.minor_units() <= 0
        || !seen_ids.insert(transaction.parent_id.clone())
        || !seen_correlations.insert(transaction.correlation_id.clone())
    {
        return Err("invalid_or_duplicate_evidence_credit".into());
    }
    if request
        .decision_card_request
        .financial_snapshot
        .legacy_snapshot
        .transactions
        .iter()
        .any(|row| {
            row.id == transaction.parent_id
                || row
                    .subtransactions
                    .iter()
                    .any(|child| child.id == transaction.parent_id)
        })
    {
        return Err("duplicate_evidence_credit_source".into());
    }
    validate_projection_evidence(request, transaction, evidence_ids, resolution_subject_id)?;
    let account = live_account(request, &transaction.account_id)?;
    let current = balances
        .get(&transaction.account_id)
        .unwrap_or(&account.balance);
    balances.insert(
        transaction.account_id.clone(),
        Money::new(
            checked_add(current.minor_units(), transaction.amount.minor_units())?,
            account.currency.clone(),
        ),
    );
    postconditions.push(transaction_postcondition(transaction));
    Ok(())
}
fn source_row_matches_expected(
    source: &balanceframe_financial_core::Transaction,
    expected: &LedgerTransaction,
) -> bool {
    source.id == expected.parent_id
        && source.account_id == expected.account_id
        && source.amount == expected.amount
        && source.date == expected.date
        && source.category_id == expected.category_id
        && source.payee_name == expected.payee_name
        && source.notes == expected.notes
        && source.transfer_account_id == expected.transfer_account_id
        && source.subtransactions.len() == expected.splits.len()
        && source
            .subtransactions
            .iter()
            .zip(&expected.splits)
            .all(|(child, split)| {
                child.account_id == source.account_id
                    && child.date == source.date
                    && child.amount == split.amount
                    && child.category_id.as_ref() == Some(&split.category_id)
                    && child.subtransactions.is_empty()
                    && !child.reconciled
                    && child.transfer_account_id.is_none()
            })
}
fn original_transaction_intent(
    expected: &LedgerTransaction,
    correlation_id: &str,
) -> ManualTransactionIntent {
    ManualTransactionIntent {
        parent_id: expected.parent_id.clone(),
        correlation_id: correlation_id.to_owned(),
        account_id: expected.account_id.clone(),
        amount: expected.amount.clone(),
        date: expected.date.clone(),
        category_id: expected.category_id.clone(),
        payee_name: expected.payee_name.clone(),
        notes: expected.notes.clone(),
        splits: expected.splits.clone(),
    }
}

fn validate_evidence_amendment(
    request: &PlanConsequentialActionRequest,
    expected: &LedgerTransaction,
    expected_source: &balanceframe_financial_core::Transaction,
    transaction: &ManualTransactionIntent,
    evidence_ids: &[String],
    resolution_subject_id: Option<&str>,
    postconditions: &mut Vec<ConsequentialActionPostcondition>,
) -> Result<(), String> {
    evidence_write_shape(request, transaction)?;
    evidence_write_shape(
        request,
        &original_transaction_intent(expected, &transaction.correlation_id),
    )?;
    if expected.transfer_account_id.is_some()
        || expected_source.reconciled
        || !source_row_matches_expected(expected_source, expected)
        || transaction.parent_id != expected.parent_id
        || transaction.account_id != expected.account_id
        || transaction.amount != expected.amount
        || transaction.date != expected.date
        || transaction.payee_name != expected.payee_name
        || transaction.notes != expected.notes
        || (transaction.category_id == expected.category_id
            && transaction.splits == expected.splits)
    {
        return Err("invalid_evidence_amendment_identity".into());
    }
    if !expected_source.subtransactions.is_empty()
        && (expected_source.subtransactions.len() != transaction.splits.len()
            || !expected_source
                .subtransactions
                .iter()
                .zip(&transaction.splits)
                .all(|(child, split)| child.amount == split.amount))
    {
        return Err("amendment_existing_split_reshape_unsupported".into());
    }
    let current = request
        .current_ledger
        .transactions
        .iter()
        .find(|row| row.parent_id == expected.parent_id)
        .ok_or("amendment_source_missing")?;
    let source = request
        .decision_card_request
        .financial_snapshot
        .legacy_snapshot
        .transactions
        .iter()
        .find(|row| row.id == expected.parent_id)
        .ok_or("amendment_source_missing")?;
    if current != expected
        || source != expected_source
        || request
            .decision_card_request
            .financial_snapshot
            .legacy_snapshot
            .transactions
            .iter()
            .filter(|row| row.id == expected.parent_id)
            .count()
            != 1
    {
        return Err("amendment_source_changed".into());
    }
    validate_projection_evidence(request, transaction, evidence_ids, resolution_subject_id)?;
    for evidence in evidence_ids {
        if event_subject(event_resolution_for_evidence(
            request,
            evidence,
            resolution_subject_id,
        )?)? != expected.parent_id
        {
            return Err("amendment_evidence_target_mismatch".into());
        }
    }
    postconditions.push(transaction_postcondition(transaction));
    Ok(())
}
fn reverse_evidence_amendment(
    card: &mut Value,
    ledger: &mut Value,
    expected: &LedgerTransaction,
    expected_source: &balanceframe_financial_core::Transaction,
    transaction: &ManualTransactionIntent,
) -> Result<(), String> {
    let rows = ledger["transactions"]
        .as_array_mut()
        .ok_or("transaction_collection_missing")?;
    let index = unique_row_index(rows, |row| row["parentId"] == transaction.parent_id)?;
    if !manual_row_matches(&rows[index], transaction) {
        return Err("amendment_postcondition_mismatch".into());
    }
    rows[index] = serde_json::to_value(expected).map_err(|error| error.to_string())?;
    let source_rows = card["financialSnapshot"]["legacySnapshot"]["transactions"]
        .as_array_mut()
        .ok_or("legacy_transaction_collection_missing")?;
    let index = unique_row_index(source_rows, |row| row["id"] == transaction.parent_id)?;
    let mut restored = source_rows[index].clone();
    let children = restored["subtransactions"]
        .as_array()
        .ok_or("legacy_transaction_children_missing")?;
    if children.len() != transaction.splits.len()
        || !children
            .iter()
            .zip(&transaction.splits)
            .all(|(child, split)| {
                child["accountId"] == transaction.account_id
                    && child["date"] == transaction.date
                    && child["amount"] == serde_json::to_value(&split.amount).unwrap_or(Value::Null)
                    && child["categoryId"] == split.category_id
            })
    {
        return Err("amendment_split_postcondition_mismatch".into());
    }
    if restored["categoryId"]
        != serde_json::to_value(&transaction.category_id).unwrap_or(Value::Null)
    {
        return Err("amendment_category_postcondition_mismatch".into());
    }
    let mut child_ids = BTreeSet::new();
    for (index, child) in children.iter().enumerate() {
        if !child["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && id != transaction.parent_id && child_ids.insert(id))
        {
            return Err("amendment_child_identity_mismatch".into());
        }
        if let Some(before) = expected_source.subtransactions.get(index) {
            let original_child = serde_json::to_value(before).map_err(|error| error.to_string())?;
            let mut restored_child = child.clone();
            for field in ["categoryId", "categoryName"] {
                restored_child[field] = original_child[field].clone();
            }
            if restored_child != original_child {
                return Err("amendment_child_source_changed".into());
            }
        } else if !child["payeeId"].is_null()
            || !child["payeeName"].is_null()
            || !child["notes"].is_null()
            || !child["importedId"].is_null()
            || !child["importedPayee"].is_null()
            || !child["transferAccountId"].is_null()
            || child["reconciled"] != false
            || child["cleared"] != expected_source.cleared
            || child["tags"] != json!([])
            || child["subtransactions"] != json!([])
        {
            return Err("amendment_child_metadata_mismatch".into());
        }
    }
    let original = serde_json::to_value(expected_source).map_err(|error| error.to_string())?;
    for field in ["categoryId", "categoryName", "subtransactions"] {
        restored[field] = original[field].clone();
    }
    if restored != original {
        return Err("amendment_source_postcondition_mismatch".into());
    }
    source_rows[index] = original;
    let original_intent = original_transaction_intent(expected, &transaction.correlation_id);
    for (source, inverse) in [(transaction, true), (&original_intent, false)] {
        for (category, amount) in transaction_category_deltas(source) {
            let delta = if inverse {
                amount.checked_neg().ok_or("money_arithmetic_overflow")?
            } else {
                amount
            };
            adjust_named_money(
                &mut card["financialSnapshot"]["liquidity"]["categories"],
                NamedMoneyTarget {
                    id_key: "categoryId",
                    id: category,
                    month: Some(("asOfMonth", &transaction.date[..7])),
                    money_key: "availability",
                },
                delta,
                transaction.amount.currency(),
            )?;
        }
    }
    Ok(())
}

fn source_effect_matches_transaction(
    effect: &EconomicEventLedgerEffect,
    transaction: &ManualTransactionIntent,
) -> bool {
    effect.account_id == transaction.account_id
        && effect.amount == transaction.amount
        && effect.date == transaction.date
        && effect.category_id == transaction.category_id
        && effect.payee_name == transaction.payee_name
        && effect.notes == transaction.notes
        && effect.splits == transaction.splits
}
fn add_card_account_evidence(
    request: &PlanConsequentialActionRequest,
    used: &mut BTreeMap<String, String>,
    card: &DecisionCard,
) -> Result<(), String> {
    let mut account_ids = card
        .items
        .iter()
        .filter_map(|item| item.selected_account_id.as_deref())
        .collect::<BTreeSet<_>>();
    if account_ids.is_empty() {
        account_ids.extend(card.selected_account_id.iter().map(String::as_str));
    }
    for account_id in account_ids {
        add_observation_evidence(
            request,
            used,
            &DecisionScope::Account(account_id.to_owned()),
        )?;
    }
    Ok(())
}

fn action_evidence(
    request: &PlanConsequentialActionRequest,
    card: Option<&DecisionCard>,
) -> Result<Vec<ConsequentialActionEvidence>, String> {
    let mut used = BTreeMap::<String, String>::new();
    let mut projection_used = BTreeSet::new();
    for atom in request.intent.atoms() {
        match atom {
            AtomicConsequentialActionIntent::Reallocation { assignments } => {
                if let Some(card) = card {
                    add_card_account_evidence(request, &mut used, card)?;
                }
                for assignment in assignments {
                    add_observation_evidence(
                        request,
                        &mut used,
                        &DecisionScope::Category(assignment.source_category_id),
                    )?;
                    add_observation_evidence(
                        request,
                        &mut used,
                        &DecisionScope::Category(assignment.destination_category_id),
                    )?;
                }
            }
            AtomicConsequentialActionIntent::ManualTransaction { transaction } => {
                if let Some(card) = card {
                    add_card_account_evidence(request, &mut used, card)?;
                }
                for (category_id, _) in transaction_category_deltas(&transaction) {
                    add_observation_evidence(
                        request,
                        &mut used,
                        &DecisionScope::Category(category_id.to_owned()),
                    )?;
                }
            }
            AtomicConsequentialActionIntent::EvidenceProjection {
                evidence_ids,
                resolution_subject_id,
                ..
            }
            | AtomicConsequentialActionIntent::EvidenceCredit {
                evidence_ids,
                resolution_subject_id,
                ..
            }
            | AtomicConsequentialActionIntent::EvidenceAmendment {
                evidence_ids,
                resolution_subject_id,
                ..
            } => {
                for evidence_id in evidence_ids {
                    let id = evidence_id.clone();
                    let observation = event_resolution_for_evidence(
                        request,
                        &id,
                        resolution_subject_id.as_deref(),
                    )?;
                    if !projection_used.insert((id, event_subject(observation)?.to_owned())) {
                        return Err("duplicate_projection_evidence".into());
                    }
                }
            }
            AtomicConsequentialActionIntent::Transfer {
                source_account_id,
                destination_account_id,
                ..
            } => {
                add_observation_evidence(
                    request,
                    &mut used,
                    &DecisionScope::Account(source_account_id),
                )?;
                add_observation_evidence(
                    request,
                    &mut used,
                    &DecisionScope::Account(destination_account_id),
                )?;
            }
            AtomicConsequentialActionIntent::WalletMaterialization {
                wallet_id,
                currency,
                opening: Some(opening),
                ..
            } => {
                let anchor = wallet_opening_anchor(request, &wallet_id, &currency, &opening)?;
                for reference in &anchor.evidence {
                    used.insert(reference.evidence_id.clone(), wallet_id.clone());
                }
            }
            AtomicConsequentialActionIntent::WalletMaterialization { opening: None, .. } => {}
        }
    }
    let mut result = Vec::new();
    for (id, subject_id) in used.into_iter().chain(projection_used) {
        let evidence = request
            .resolved_evidence
            .iter()
            .find(|evidence| evidence.evidence_id == id && evidence.subject_id == subject_id)
            .ok_or_else(|| format!("evidence_unresolved:{id}"))?;
        if evidence.subject_id != subject_id
            || evidence.state != EvidenceState::Resolved
            || evidence.content_hash.as_deref().is_none_or(str::is_empty)
        {
            return Err(format!("evidence_unresolved:{id}"));
        }
        result.push(evidence.clone());
    }
    Ok(result)
}

#[derive(Clone)]
struct CategoryEnvelope {
    baseline_availability: Money,
    availability: Money,
    uncommitted: Money,
    commitments: Money,
    reservations: Money,
}

struct CardCharges {
    total: Money,
    accounts: BTreeMap<String, Money>,
    categories: BTreeMap<String, Money>,
}

fn card_charges(card: &DecisionCard) -> Result<CardCharges, String> {
    fn amounts(
        card: &DecisionCard,
        collection: &str,
        identity: &str,
    ) -> Result<BTreeMap<String, Money>, String> {
        let rows = card
            .cart
            .get(collection)
            .and_then(Value::as_array)
            .ok_or("decision_card_cart_missing")?;
        let mut result = BTreeMap::new();
        for row in rows {
            let id = row
                .get(identity)
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or("decision_card_cart_identity_missing")?;
            let (units, currency) = parse_money(&row["amount"])?;
            if units <= 0
                || result
                    .insert(id.to_owned(), Money::new(units, currency))
                    .is_some()
            {
                return Err("invalid_or_duplicate_decision_card_charge".into());
            }
        }
        Ok(result)
    }

    let (total, currency) = parse_money(&card.cart["total"])?;
    if total <= 0 {
        return Err("invalid_decision_card_total".into());
    }
    let accounts = amounts(card, "accountCharges", "accountId")?;
    let categories = amounts(card, "categoryCharges", "categoryId")?;
    fn total_for(charges: &BTreeMap<String, Money>, currency: &str) -> Result<i64, String> {
        charges.values().try_fold(0_i64, |sum, amount| {
            if amount.currency() != currency {
                return Err("decision_card_charge_currency_mismatch".into());
            }
            checked_add(sum, amount.minor_units())
        })
    }
    if total_for(&accounts, &currency)? != total || total_for(&categories, &currency)? != total {
        return Err("decision_card_charge_total_mismatch".into());
    }
    Ok(CardCharges {
        total: Money::new(total, currency),
        accounts,
        categories,
    })
}

fn charge_matches(charges: &BTreeMap<String, Money>, actual: &BTreeMap<String, i64>) -> bool {
    charges.len() == actual.len()
        && charges.iter().all(|(id, expected)| {
            actual
                .get(id)
                .is_some_and(|units| *units == expected.minor_units())
        })
}
fn ensure_composite_outflow_capacity(
    shared: &AccountAwareSpendabilityResult,
    account_id: &str,
    currency: &str,
    manual_outflow: i64,
    transfer_outflow: i64,
) -> Result<(), String> {
    let capacity = shared
        .accounts_before
        .iter()
        .find(|account| account.account_id == account_id)
        .and_then(|account| account.safe_transfer_capacity.as_ref())
        .filter(|capacity| capacity.currency() == currency)
        .ok_or("transfer_capacity_unavailable")?;
    if checked_add(manual_outflow, transfer_outflow)? > capacity.minor_units() {
        return Err("transfer_capacity_insufficient".into());
    }
    Ok(())
}

fn ensure_unique_projection_subjects(
    request: &PlanConsequentialActionRequest,
    atoms: &[AtomicConsequentialActionIntent],
) -> Result<(), String> {
    let mut projected_subjects = HashSet::new();
    for atom in atoms {
        let (evidence_ids, resolution_subject_id) = match atom {
            AtomicConsequentialActionIntent::EvidenceProjection {
                evidence_ids,
                resolution_subject_id,
                ..
            }
            | AtomicConsequentialActionIntent::EvidenceCredit {
                evidence_ids,
                resolution_subject_id,
                ..
            }
            | AtomicConsequentialActionIntent::EvidenceAmendment {
                evidence_ids,
                resolution_subject_id,
                ..
            } => (evidence_ids, resolution_subject_id),
            _ => continue,
        };
        let mut atom_subjects = HashSet::new();
        for evidence_id in evidence_ids {
            atom_subjects.insert(event_subject(event_resolution_for_evidence(
                request,
                evidence_id,
                resolution_subject_id.as_deref(),
            )?)?);
        }
        if atom_subjects
            .iter()
            .any(|subject_id| !projected_subjects.insert(*subject_id))
        {
            return Err("economic_event_projected_more_than_once".into());
        }
    }
    Ok(())
}

fn dispatch_preconditions_from_ledger(
    ledger: &ConsequentialActionLedger,
    atoms: &[AtomicConsequentialActionIntent],
) -> Result<Vec<ConsequentialActionDispatchPrecondition>, String> {
    fn balance_at_prefix(
        ledger: &ConsequentialActionLedger,
        balances: &BTreeMap<String, Money>,
        account_id: &str,
    ) -> Result<Money, String> {
        balances
            .get(account_id)
            .cloned()
            .or_else(|| {
                ledger
                    .accounts
                    .iter()
                    .find(|account| account.account_id == account_id)
                    .map(|account| account.balance.clone())
            })
            .ok_or_else(|| "ledger_account_missing".into())
    }

    fn assignment_at_prefix<'a, 'b>(
        ledger: &ConsequentialActionLedger,
        assignments: &BTreeMap<(&'a str, &'a str), Money>,
        key: (&'b str, &'b str),
    ) -> Result<Money, String> {
        assignments
            .iter()
            .find(|((category_id, as_of_month), _)| *category_id == key.0 && *as_of_month == key.1)
            .map(|(_, amount)| amount.clone())
            .or_else(|| {
                ledger
                    .assignments
                    .iter()
                    .find(|assignment| {
                        assignment.category_id.as_str() == key.0
                            && assignment.as_of_month.as_str() == key.1
                    })
                    .map(|assignment| assignment.amount.clone())
            })
            .ok_or_else(|| "assignment_missing".into())
    }

    let mut balances = BTreeMap::<String, Money>::new();
    let mut assignments = BTreeMap::<(&str, &str), Money>::new();
    let mut result = Vec::new();
    for (atom_index, atom) in atoms.iter().enumerate() {
        match atom {
            AtomicConsequentialActionIntent::Reallocation { assignments: moves } => {
                let mut targets = BTreeSet::new();
                for movement in moves {
                    targets.insert((
                        movement.source_category_id.as_str(),
                        movement.source_as_of_month.as_str(),
                    ));
                    targets.insert((
                        movement.destination_category_id.as_str(),
                        movement.destination_as_of_month.as_str(),
                    ));
                }
                let mut preconditions = targets
                    .iter()
                    .map(|(category_id, as_of_month)| {
                        let amount = assignment_at_prefix(
                            ledger,
                            &assignments,
                            (*category_id, *as_of_month),
                        )?;
                        Ok(ConsequentialActionAssignmentPrecondition {
                            category_id: (*category_id).to_owned(),
                            as_of_month: (*as_of_month).to_owned(),
                            post_amount: amount.clone(),
                            amount,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                for movement in moves {
                    let source_key = (
                        movement.source_category_id.as_str(),
                        movement.source_as_of_month.as_str(),
                    );
                    let destination_key = (
                        movement.destination_category_id.as_str(),
                        movement.destination_as_of_month.as_str(),
                    );
                    let amount = movement.amount.minor_units();
                    let currency = movement.amount.currency().to_owned();
                    let source = assignment_at_prefix(ledger, &assignments, source_key)?;
                    let destination = assignment_at_prefix(ledger, &assignments, destination_key)?;
                    if source.currency() != currency || destination.currency() != currency {
                        return Err("reallocation_target_changed".into());
                    }
                    let source_delta = amount.checked_neg().ok_or("money_arithmetic_overflow")?;
                    assignments.insert(
                        source_key,
                        Money::new(
                            checked_add(source.minor_units(), source_delta)?,
                            currency.clone(),
                        ),
                    );
                    assignments.insert(
                        destination_key,
                        Money::new(checked_add(destination.minor_units(), amount)?, currency),
                    );
                }
                for precondition in &mut preconditions {
                    precondition.post_amount = assignment_at_prefix(
                        ledger,
                        &assignments,
                        (&precondition.category_id, &precondition.as_of_month),
                    )?;
                }
                result.push(ConsequentialActionDispatchPrecondition {
                    atom_index,
                    account_balances: Vec::new(),
                    assignments: preconditions,
                });
            }
            AtomicConsequentialActionIntent::ManualTransaction { transaction }
            | AtomicConsequentialActionIntent::EvidenceProjection { transaction, .. }
            | AtomicConsequentialActionIntent::EvidenceCredit { transaction, .. } => {
                let current = balance_at_prefix(ledger, &balances, &transaction.account_id)?;
                if current.currency() != transaction.amount.currency() {
                    return Err("manual_transaction_currency_or_source_mismatch".into());
                }
                balances.insert(
                    transaction.account_id.clone(),
                    Money::new(
                        checked_add(current.minor_units(), transaction.amount.minor_units())?,
                        current.currency().to_owned(),
                    ),
                );
            }
            AtomicConsequentialActionIntent::Transfer {
                source_account_id,
                destination_account_id,
                amount,
                ..
            } => {
                let mut account_balances = BTreeMap::new();
                for account_id in [source_account_id, destination_account_id] {
                    let balance = balance_at_prefix(ledger, &balances, account_id)?;
                    if balance.currency() != amount.currency() {
                        return Err("transfer_currency_or_source_mismatch".into());
                    }
                    account_balances.insert(account_id.clone(), balance);
                }
                let source = balance_at_prefix(ledger, &balances, source_account_id)?;
                let destination = balance_at_prefix(ledger, &balances, destination_account_id)?;
                let source_after = checked_sub(source.minor_units(), amount.minor_units())?;
                let destination_after =
                    checked_add(destination.minor_units(), amount.minor_units())?;
                balances.insert(
                    source_account_id.clone(),
                    Money::new(source_after, source.currency().to_owned()),
                );
                balances.insert(
                    destination_account_id.clone(),
                    Money::new(destination_after, destination.currency().to_owned()),
                );
                result.push(ConsequentialActionDispatchPrecondition {
                    atom_index,
                    account_balances: account_balances
                        .into_iter()
                        .map(|(account_id, balance)| {
                            ConsequentialActionAccountBalancePrecondition {
                                account_id,
                                balance,
                            }
                        })
                        .collect(),
                    assignments: Vec::new(),
                });
            }
            AtomicConsequentialActionIntent::WalletMaterialization { .. }
            | AtomicConsequentialActionIntent::EvidenceAmendment { .. } => {}
        }
    }
    Ok(result)
}

struct DerivedAction {
    reason_codes: Vec<ConsequentialActionReasonCode>,
    impacts: Vec<ConsequentialActionImpact>,
    expected_postconditions: Vec<ConsequentialActionPostcondition>,
    dispatch_preconditions: Vec<ConsequentialActionDispatchPrecondition>,
}
fn validate_reallocation_path_coverage<'a>(
    card: &'a DecisionCard,
    atoms: &'a [AtomicConsequentialActionIntent],
) -> Result<(), String> {
    type PathKey<'a> = (&'a str, &'a str, &'a str, &'a str, &'a str);

    fn add_path_amount<'a>(
        paths: &mut BTreeMap<PathKey<'a>, i64>,
        key: PathKey<'a>,
        amount: i64,
    ) -> Result<(), String> {
        let total = paths.entry(key).or_default();
        *total = checked_add(*total, amount)?;
        Ok(())
    }

    let mut approved = BTreeMap::new();
    for path in &card.funding_paths {
        if path["kind"] != "category_reallocation" {
            continue;
        }
        let key = (
            path["sourceCategoryId"]
                .as_str()
                .ok_or("reallocation_funding_path_invalid")?,
            path["sourceAsOfMonth"]
                .as_str()
                .ok_or("reallocation_funding_path_invalid")?,
            path["destinationCategoryId"]
                .as_str()
                .ok_or("reallocation_funding_path_invalid")?,
            path["destinationAsOfMonth"]
                .as_str()
                .ok_or("reallocation_funding_path_invalid")?,
            path["amount"]["currency"]
                .as_str()
                .ok_or("reallocation_funding_path_invalid")?,
        );
        let amount = path["amount"]["minorUnits"]
            .as_str()
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|amount| *amount > 0)
            .ok_or("reallocation_funding_path_invalid")?;
        add_path_amount(&mut approved, key, amount)?;
    }

    let mut proposed = BTreeMap::new();
    for atom in atoms {
        let AtomicConsequentialActionIntent::Reallocation { assignments } = atom else {
            continue;
        };
        for movement in assignments {
            add_path_amount(
                &mut proposed,
                (
                    &movement.source_category_id,
                    &movement.source_as_of_month,
                    &movement.destination_category_id,
                    &movement.destination_as_of_month,
                    movement.amount.currency(),
                ),
                movement.amount.minor_units(),
            )?;
        }
    }
    if proposed != approved {
        return Err("reallocation_not_native_funding_path".into());
    }
    Ok(())
}

fn add_reallocation_card_metadata(
    card: &DecisionCard,
    atoms: &[AtomicConsequentialActionIntent],
    reasons: &mut Vec<ConsequentialActionReasonCode>,
    impacts: &mut Vec<ConsequentialActionImpact>,
) -> Result<(), String> {
    let ready_accounts = card
        .items
        .iter()
        .filter(|item| item.payment_liquidity_status == "ready")
        .filter_map(|item| item.selected_account_id.as_deref())
        .collect::<BTreeSet<_>>();
    for account_id in &ready_accounts {
        for impact in [
            ConsequentialActionImpact::AccountReadiness {
                account_id: (*account_id).to_owned(),
                state: ReadinessState::Ready,
            },
            ConsequentialActionImpact::PaymentRoute {
                account_id: (*account_id).to_owned(),
                state: ReadinessState::Ready,
            },
        ] {
            if !impacts.contains(&impact) {
                impacts.push(impact);
            }
        }
    }
    if !ready_accounts.is_empty() {
        reasons.extend([
            ConsequentialActionReasonCode::AccountReadiness,
            ConsequentialActionReasonCode::PaymentRoute,
        ]);
    }

    let mut has_claims = false;
    if let Some(before) = card.before.as_ref() {
        for category in &before.categories {
            let affected = atoms.iter().any(|atom| {
                let AtomicConsequentialActionIntent::Reallocation { assignments } = atom else {
                    return false;
                };
                assignments.iter().any(|movement| {
                    (movement.source_category_id == category.category_id
                        && movement.source_as_of_month == category.as_of_month)
                        || (movement.destination_category_id == category.category_id
                            && movement.destination_as_of_month == category.as_of_month)
                })
            });
            if affected
                && (category.commitments.minor_units() != 0
                    || category.reservations.minor_units() != 0)
            {
                has_claims = true;
                let impact = ConsequentialActionImpact::ReservationCommitment {
                    category_id: category.category_id.clone(),
                    commitments: category.commitments.clone(),
                    reservations: category.reservations.clone(),
                };
                if !impacts.contains(&impact) {
                    impacts.push(impact);
                }
            }
        }
    }
    if has_claims {
        reasons.push(ConsequentialActionReasonCode::ReservationCommitment);
    }

    let transfer_items = card
        .items
        .iter()
        .filter(|item| {
            item.selected_account_id.is_some()
                && item.payment_liquidity_status == "transfer_required"
        })
        .map(|item| item.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut seen_legs = BTreeSet::new();
    let mut has_transfer_need = false;
    for path in &card.funding_paths {
        if path["kind"] != "account_transfer"
            || !path["itemIds"].as_array().is_some_and(|item_ids| {
                item_ids.iter().any(|item_id| {
                    item_id.as_str().is_some_and(|item_id| {
                        transfer_items
                            .iter()
                            .any(|transfer_item| *transfer_item == item_id)
                    })
                })
            })
        {
            continue;
        }
        let legs = path["legs"]
            .as_array()
            .ok_or("decision_card_transfer_path_invalid")?;
        for leg in legs {
            let leg_id = leg["id"]
                .as_str()
                .filter(|leg_id| !leg_id.is_empty())
                .ok_or("decision_card_transfer_path_invalid")?;
            if !seen_legs.insert(leg_id) {
                continue;
            }
            let account_id = leg["sourceAccountId"]
                .as_str()
                .filter(|account_id| !account_id.is_empty())
                .ok_or("decision_card_transfer_path_invalid")?;
            let (minor_units, currency) = parse_money(&leg["amount"])?;
            let impact = ConsequentialActionImpact::TransferNeed {
                account_id: account_id.to_owned(),
                amount: Money::new(minor_units, currency),
            };
            if !impacts.contains(&impact) {
                impacts.push(impact);
            }
            has_transfer_need = true;
        }
    }
    if has_transfer_need {
        reasons.push(ConsequentialActionReasonCode::TransferNeed);
    }
    Ok(())
}

fn derive_action(
    request: &PlanConsequentialActionRequest,
    card: Option<&DecisionCard>,
    shared: Option<&AccountAwareSpendabilityResult>,
    evidence_references: &[ConsequentialActionEvidence],
    atoms: &[AtomicConsequentialActionIntent],
) -> Result<DerivedAction, String> {
    ensure_unique_projection_subjects(request, atoms)?;
    let dispatch_preconditions =
        dispatch_preconditions_from_ledger(&request.current_ledger, atoms)?;
    let mut reasons = Vec::new();
    let mut impacts = Vec::new();
    let mut assignments = BTreeMap::<(String, String), Money>::new();
    let mut balances = BTreeMap::<String, Money>::new();
    let mut transactions = Vec::new();
    let mut wallets = Vec::new();
    let mut transfers = Vec::new();
    let mut reallocation_targets = BTreeSet::<(String, String, String, String)>::new();
    let mut transaction_ids: HashSet<String> = request
        .current_ledger
        .transactions
        .iter()
        .map(|row| row.parent_id.clone())
        .collect();
    let mut transaction_correlations: HashSet<String> = request
        .current_ledger
        .transfers
        .iter()
        .map(|mapping| mapping.correlation_id.clone())
        .collect();
    let mut wallet_ids: HashSet<String> = request
        .current_ledger
        .wallets
        .iter()
        .map(|mapping| mapping.wallet_id.clone())
        .collect();
    let mut transfer_ids: HashSet<String> = request
        .current_ledger
        .transfers
        .iter()
        .map(|mapping| mapping.transfer_id.clone())
        .collect();
    let mut evidence_impact_ids = HashSet::new();
    for evidence in evidence_references {
        if evidence_impact_ids.insert(evidence.evidence_id.clone()) {
            impacts.push(ConsequentialActionImpact::EvidenceResolution {
                evidence_id: evidence.evidence_id.clone(),
                state: evidence.state,
            });
        }
    }
    if !evidence_references.is_empty() {
        reasons.push(ConsequentialActionReasonCode::EvidenceResolution);
    }
    let mut transfer_outflows = BTreeMap::<String, i64>::new();
    let mut manual_spend = BTreeMap::<String, i64>::new();
    let mut manual_category_spend = BTreeMap::<String, i64>::new();
    let mut manual_total = 0_i64;
    let trusted_charges = if atoms.iter().any(|atom| {
        matches!(
            atom,
            AtomicConsequentialActionIntent::ManualTransaction { .. }
                | AtomicConsequentialActionIntent::EvidenceProjection { .. }
        )
    }) {
        Some(card_charges(
            card.ok_or("decision_card_required_for_transaction")?,
        )?)
    } else {
        None
    };
    let mut envelopes = BTreeMap::<(String, String), CategoryEnvelope>::new();

    if let Some(before) = card.and_then(|card| card.before.as_ref()) {
        for category in &before.categories {
            envelopes.insert(
                (category.category_id.clone(), category.as_of_month.clone()),
                CategoryEnvelope {
                    baseline_availability: category.availability.clone(),
                    availability: category.availability.clone(),
                    uncommitted: category.uncommitted_availability.clone(),
                    commitments: category.commitments.clone(),
                    reservations: category.reservations.clone(),
                },
            );
        }
    }
    let mut reallocation_path_validated = false;

    for atom in atoms {
        match atom {
            AtomicConsequentialActionIntent::Reallocation { assignments: moves } => {
                let card = card.ok_or("decision_card_required_for_reallocation")?;
                if card.outcome != "safe_with_reallocation" {
                    return Err("reallocation_not_safe_in_decision_card".into());
                }
                if moves.is_empty() {
                    return Err("reallocation_empty".into());
                }
                if !reallocation_path_validated {
                    validate_reallocation_path_coverage(card, atoms)?;
                    add_reallocation_card_metadata(card, atoms, &mut reasons, &mut impacts)?;
                    reallocation_path_validated = true;
                }
                reasons.push(ConsequentialActionReasonCode::SafeReallocation);
                for movement in moves {
                    validate_reallocation(
                        request,
                        card,
                        movement,
                        &mut assignments,
                        &mut reallocation_targets,
                        &mut envelopes,
                        &mut impacts,
                    )?;
                }
            }
            AtomicConsequentialActionIntent::ManualTransaction { transaction }
            | AtomicConsequentialActionIntent::EvidenceProjection { transaction, .. } => {
                let card = card.ok_or("decision_card_required_for_transaction")?;
                if !matches!(
                    card.outcome.as_str(),
                    "funded_now" | "safe_with_reallocation"
                ) {
                    return Err("payment_route_not_ready".into());
                }
                validate_manual(
                    ManualValidationContext {
                        request,
                        charges: trusted_charges
                            .as_ref()
                            .ok_or("decision_card_cart_missing")?,
                        shared,
                        transfer_outflows: &transfer_outflows,
                        balances: &mut balances,
                        postconditions: &mut transactions,
                        seen_ids: &mut transaction_ids,
                        seen_correlations: &mut transaction_correlations,
                        manual_spend: &mut manual_spend,
                        manual_category_spend: &mut manual_category_spend,
                        manual_total: &mut manual_total,
                        envelopes: &mut envelopes,
                        impacts: &mut impacts,
                    },
                    transaction,
                )?;
                reasons.extend([
                    ConsequentialActionReasonCode::AccountReadiness,
                    ConsequentialActionReasonCode::PaymentRoute,
                    ConsequentialActionReasonCode::ReservationCommitment,
                ]);
                if let AtomicConsequentialActionIntent::EvidenceProjection {
                    evidence_ids,
                    resolution_subject_id,
                    ..
                } = atom
                {
                    validate_projection_evidence(
                        request,
                        transaction,
                        evidence_ids,
                        resolution_subject_id.as_deref(),
                    )?;
                    reasons.push(ConsequentialActionReasonCode::EvidenceResolution);
                    for evidence_id in evidence_ids {
                        if evidence_impact_ids.insert(evidence_id.clone()) {
                            impacts.push(ConsequentialActionImpact::EvidenceResolution {
                                evidence_id: evidence_id.clone(),
                                state: EvidenceState::Resolved,
                            });
                        }
                    }
                }
            }
            AtomicConsequentialActionIntent::EvidenceCredit {
                transaction,
                evidence_ids,
                resolution_subject_id,
            } => {
                validate_evidence_credit(
                    request,
                    transaction,
                    (evidence_ids, resolution_subject_id.as_deref()),
                    &mut transaction_ids,
                    &mut transaction_correlations,
                    &mut balances,
                    &mut transactions,
                )?;
            }
            AtomicConsequentialActionIntent::EvidenceAmendment {
                expected,
                expected_source,
                transaction,
                evidence_ids,
                resolution_subject_id,
            } => {
                validate_evidence_amendment(
                    request,
                    expected,
                    expected_source,
                    transaction,
                    evidence_ids,
                    resolution_subject_id.as_deref(),
                    &mut transactions,
                )?;
            }
            AtomicConsequentialActionIntent::WalletMaterialization {
                wallet_id,
                account_name,
                currency: wallet_currency,
                opening,
            } => {
                if wallet_id.trim().is_empty()
                    || account_name.trim().is_empty()
                    || !valid_currency(wallet_currency)
                    || !wallet_ids.insert(wallet_id.clone())
                {
                    return Err("invalid_or_existing_wallet".into());
                }
                if !configured_source_currency(request, wallet_currency) {
                    return Err("wallet_currency_not_configured".into());
                }
                wallets.push(ConsequentialActionPostcondition::WalletMapping {
                    wallet_id: wallet_id.clone(),
                    account_name: account_name.clone(),
                    on_budget: true,
                    closed: false,
                    opening_balance: opening
                        .as_ref()
                        .map(|value| value.amount.clone())
                        .unwrap_or_else(|| Money::zero(wallet_currency.clone())),
                });
                if let Some(opening) = opening {
                    wallet_opening_anchor(request, wallet_id, wallet_currency, opening)?;
                    wallets.push(ConsequentialActionPostcondition::WalletOpeningEquity {
                        wallet_id: wallet_id.clone(),
                        amount: opening.amount.clone(),
                        date: opening.date.clone(),
                    });
                }
            }
            AtomicConsequentialActionIntent::Transfer {
                transfer_id,
                correlation_id,
                source_account_id,
                destination_account_id,
                amount,
                date,
            } => {
                let shared_result;
                let shared = if let Some(shared) = shared {
                    shared
                } else {
                    shared_result = evaluate_shared(request);
                    &shared_result
                };
                if transfer_id.trim().is_empty()
                    || correlation_id.trim().is_empty()
                    || transfer_id.contains(':')
                    || amount.minor_units() <= 0
                    || source_account_id == destination_account_id
                    || !valid_date(date)
                    || !transfer_ids.insert(transfer_id.clone())
                    || !transaction_correlations.insert(correlation_id.clone())
                {
                    return Err("invalid_transfer_intent".into());
                }
                let source = live_account(request, source_account_id)?;
                let destination = live_account(request, destination_account_id)?;
                let source_fact = account_fact(
                    &request.decision_card_request.financial_snapshot,
                    source_account_id,
                )
                .ok_or("transfer_account_fact_missing")?;
                let destination_fact = account_fact(
                    &request.decision_card_request.financial_snapshot,
                    destination_account_id,
                )
                .ok_or("transfer_account_fact_missing")?;
                if source_fact.currency != source.currency
                    || source_fact.recorded_balance != source.balance
                    || source_fact.on_budget != source.on_budget
                    || source_fact.closed != source.closed
                    || destination_fact.currency != destination.currency
                    || destination_fact.recorded_balance != destination.balance
                    || destination_fact.on_budget != destination.on_budget
                    || destination_fact.closed != destination.closed
                {
                    return Err("transfer_account_source_mismatch".into());
                }
                if source.currency != destination.currency || amount.currency() != source.currency {
                    return Err("transfer_currency_mismatch".into());
                }
                let capacity = shared
                    .accounts_before
                    .iter()
                    .find(|account| account.account_id == *source_account_id)
                    .and_then(|account| account.safe_transfer_capacity.as_ref())
                    .filter(|capacity| capacity.currency() == amount.currency())
                    .ok_or("transfer_capacity_unavailable")?;
                let next_transfer_outflow = checked_add(
                    *transfer_outflows.get(source_account_id).unwrap_or(&0),
                    amount.minor_units(),
                )?;
                let combined_outflow = checked_add(
                    *manual_spend.get(source_account_id).unwrap_or(&0),
                    next_transfer_outflow,
                )?;
                if capacity.minor_units() < combined_outflow {
                    return Err("transfer_capacity_insufficient".into());
                }
                transfer_outflows.insert(source_account_id.clone(), next_transfer_outflow);
                let debit = amount
                    .minor_units()
                    .checked_neg()
                    .ok_or("money_arithmetic_overflow")?;
                let source_balance = balances
                    .get(source_account_id)
                    .unwrap_or(&source.balance)
                    .minor_units();
                let destination_balance = balances
                    .get(destination_account_id)
                    .unwrap_or(&destination.balance)
                    .minor_units();
                balances.insert(
                    source_account_id.clone(),
                    Money::new(checked_add(source_balance, debit)?, source.currency.clone()),
                );
                balances.insert(
                    destination_account_id.clone(),
                    Money::new(
                        checked_add(destination_balance, amount.minor_units())?,
                        source.currency.clone(),
                    ),
                );
                impacts.push(ConsequentialActionImpact::AccountReadiness {
                    account_id: source_account_id.clone(),
                    state: ReadinessState::Ready,
                });
                impacts.push(ConsequentialActionImpact::AccountReadiness {
                    account_id: destination_account_id.clone(),
                    state: ReadinessState::Ready,
                });
                impacts.push(ConsequentialActionImpact::PaymentRoute {
                    account_id: source_account_id.clone(),
                    state: ReadinessState::Ready,
                });
                impacts.push(ConsequentialActionImpact::TransferNeed {
                    account_id: source_account_id.clone(),
                    amount: amount.clone(),
                });
                reasons.extend([
                    ConsequentialActionReasonCode::AccountReadiness,
                    ConsequentialActionReasonCode::PaymentRoute,
                    ConsequentialActionReasonCode::TransferNeed,
                ]);
                transfers.push(ConsequentialActionPostcondition::TransferLedgerEntry {
                    transfer_id: transfer_id.clone(),
                    correlation_id: correlation_id.clone(),
                    source_account_id: source_account_id.clone(),
                    destination_account_id: destination_account_id.clone(),
                    amount: amount.clone(),
                    date: date.clone(),
                });
            }
        }
    }
    if manual_total > 0 {
        let charges = trusted_charges
            .as_ref()
            .ok_or("decision_card_cart_missing")?;
        if manual_total != charges.total.minor_units()
            || !charge_matches(&charges.accounts, &manual_spend)
            || !charge_matches(&charges.categories, &manual_category_spend)
        {
            return Err("manual_cart_total_mismatch".into());
        }
    }

    if atoms
        .iter()
        .any(|atom| matches!(atom, AtomicConsequentialActionIntent::Reallocation { .. }))
    {
        for account in &request.current_ledger.accounts {
            balances
                .entry(account.account_id.clone())
                .or_insert_with(|| account.balance.clone());
        }
    }
    let postconditions = assignments
        .into_iter()
        .map(
            |((category_id, as_of_month), amount)| ConsequentialActionPostcondition::Assignment {
                category_id,
                as_of_month,
                amount,
            },
        )
        .chain(balances.into_iter().map(|(account_id, balance)| {
            ConsequentialActionPostcondition::AccountBalance {
                account_id,
                balance,
            }
        }))
        .chain(transactions)
        .chain(wallets)
        .chain(transfers)
        .collect();
    let mut unique_reasons = Vec::new();
    for reason in reasons {
        if !unique_reasons.contains(&reason) {
            unique_reasons.push(reason);
        }
    }
    Ok(DerivedAction {
        reason_codes: unique_reasons,
        impacts,
        expected_postconditions: postconditions,
        dispatch_preconditions,
    })
}

fn validate_reallocation(
    request: &PlanConsequentialActionRequest,
    card: &DecisionCard,
    movement: &ReallocationAssignment,
    assignments: &mut BTreeMap<(String, String), Money>,
    seen_movements: &mut BTreeSet<(String, String, String, String)>,
    envelopes: &mut BTreeMap<(String, String), CategoryEnvelope>,
    impacts: &mut Vec<ConsequentialActionImpact>,
) -> Result<(), String> {
    let source_key = (
        movement.source_category_id.clone(),
        movement.source_as_of_month.clone(),
    );
    let destination_key = (
        movement.destination_category_id.clone(),
        movement.destination_as_of_month.clone(),
    );
    let amount = movement.amount.minor_units();
    let movement_key = (
        movement.source_category_id.clone(),
        movement.source_as_of_month.clone(),
        movement.destination_category_id.clone(),
        movement.destination_as_of_month.clone(),
    );
    if amount <= 0
        || movement.source_category_id == movement.destination_category_id
        || !valid_month(&movement.source_as_of_month)
        || !valid_month(&movement.destination_as_of_month)
        || !seen_movements.insert(movement_key)
    {
        return Err("invalid_or_duplicate_reallocation".into());
    }
    if !request
        .current_ledger
        .categories
        .iter()
        .any(|category| category.category_id == movement.source_category_id)
        || !request
            .current_ledger
            .categories
            .iter()
            .any(|category| category.category_id == movement.destination_category_id)
    {
        return Err("reallocation_category_missing".into());
    }
    let source_assignment = current_assignment(
        request,
        &movement.source_category_id,
        &movement.source_as_of_month,
    )?;
    let destination_assignment = current_assignment(
        request,
        &movement.destination_category_id,
        &movement.destination_as_of_month,
    )?;
    let currency = movement.amount.currency();
    if source_assignment.currency() != currency || destination_assignment.currency() != currency {
        return Err("reallocation_target_changed".into());
    }
    let source_fact = category_fact(
        &request.decision_card_request.financial_snapshot,
        &movement.source_category_id,
        &movement.source_as_of_month,
    )
    .ok_or("reallocation_source_fact_missing")?;
    let destination_fact = category_fact(
        &request.decision_card_request.financial_snapshot,
        &movement.destination_category_id,
        &movement.destination_as_of_month,
    )
    .ok_or("reallocation_destination_fact_missing")?;
    let source_state = card
        .before
        .as_ref()
        .and_then(|state| {
            state.categories.iter().find(|state| {
                state.category_id == movement.source_category_id
                    && state.as_of_month == movement.source_as_of_month
            })
        })
        .ok_or("reallocation_card_source_missing")?;
    let destination_state = card
        .before
        .as_ref()
        .and_then(|state| {
            state.categories.iter().find(|state| {
                state.category_id == movement.destination_category_id
                    && state.as_of_month == movement.destination_as_of_month
            })
        })
        .ok_or("reallocation_card_destination_missing")?;
    if source_fact.availability.currency() != currency
        || destination_fact.availability.currency() != currency
        || source_state.availability != source_fact.availability
        || destination_state.availability != destination_fact.availability
    {
        return Err("reallocation_source_state_mismatch".into());
    }
    let policy = request
        .decision_card_request
        .category_policies
        .iter()
        .find(|policy| policy.category_id == movement.source_category_id)
        .ok_or("reallocation_policy_missing")?;
    let source_before = envelopes
        .get(&source_key)
        .ok_or("reallocation_card_source_missing")?
        .availability
        .minor_units();
    let uncommitted_before = envelopes
        .get(&source_key)
        .ok_or("reallocation_card_source_missing")?
        .uncommitted
        .minor_units();
    if source_state.availability.currency() != currency {
        return Err("reallocation_source_state_mismatch".into());
    }
    let redirected = source_state
        .availability
        .minor_units()
        .checked_sub(source_before)
        .ok_or("money_arithmetic_overflow")?;
    let safe_remaining = source_state
        .safe_to_redirect
        .minor_units()
        .checked_sub(redirected)
        .ok_or("money_arithmetic_overflow")?;
    if safe_remaining < amount
        || policy.kind.eq_ignore_ascii_case("protected")
        || policy.kind.eq_ignore_ascii_case("goal")
        || !policy.donor_eligible
        || source_state.uncommitted_availability.currency() != currency
        || source_state.commitments.currency() != currency
        || source_state.reservations.currency() != currency
        || source_state.safe_to_redirect.currency() != currency
        || policy.minimum_retained.currency() != currency
        || policy.projected_remaining_need.currency() != currency
        || source_fact.kind
            == balanceframe_financial_core::liquidity::LiquidityCategoryKind::CreditPayment
    {
        return Err("reallocation_donor_not_eligible".into());
    }
    let source_after = checked_sub(source_before, amount)?;
    let uncommitted_after = checked_sub(uncommitted_before, amount)?;
    let required = checked_add(
        policy.minimum_retained.minor_units(),
        policy.projected_remaining_need.minor_units(),
    )?;
    if uncommitted_after < required {
        return Err("reallocation_floor_or_claims_failed".into());
    }
    let safe_to_redirect_after = checked_sub(uncommitted_after, required)?;
    let source_assignment_value = assignments
        .get(&source_key)
        .unwrap_or(source_assignment)
        .minor_units();
    let destination_assignment_value = assignments
        .get(&destination_key)
        .unwrap_or(destination_assignment)
        .minor_units();
    let source_delta = amount.checked_neg().ok_or("money_arithmetic_overflow")?;
    assignments.insert(
        source_key.clone(),
        Money::new(
            checked_add(source_assignment_value, source_delta)?,
            currency,
        ),
    );
    assignments.insert(
        destination_key.clone(),
        Money::new(checked_add(destination_assignment_value, amount)?, currency),
    );
    {
        let source = envelopes
            .get_mut(&source_key)
            .ok_or("reallocation_card_source_missing")?;
        source.availability = Money::new(source_after, currency);
        source.uncommitted = Money::new(uncommitted_after, currency);
    }
    let destination = envelopes
        .get_mut(&destination_key)
        .ok_or("reallocation_card_destination_missing")?;
    destination.availability = Money::new(
        checked_add(destination.availability.minor_units(), amount)?,
        currency,
    );
    destination.uncommitted = Money::new(
        checked_add(destination.uncommitted.minor_units(), amount)?,
        currency,
    );
    impacts.push(ConsequentialActionImpact::CategoryReallocation {
        source_category_id: movement.source_category_id.clone(),
        source_as_of_month: movement.source_as_of_month.clone(),
        destination_category_id: movement.destination_category_id.clone(),
        destination_as_of_month: movement.destination_as_of_month.clone(),
        amount: movement.amount.clone(),
        source_protected: false,
        source_availability_before: Money::new(source_before, currency),
        source_availability_after: Money::new(source_after, currency),
        source_uncommitted_availability_before: Money::new(uncommitted_before, currency),
        source_uncommitted_availability_after: Money::new(uncommitted_after, currency),
        minimum_retained: policy.minimum_retained.clone(),
        projected_remaining_need: policy.projected_remaining_need.clone(),
        safe_to_redirect_after: Money::new(safe_to_redirect_after, currency),
        rationale: "donor_category_surplus_redirected".into(),
    });
    Ok(())
}

struct ManualValidationContext<'a> {
    request: &'a PlanConsequentialActionRequest,
    charges: &'a CardCharges,
    shared: Option<&'a AccountAwareSpendabilityResult>,
    transfer_outflows: &'a BTreeMap<String, i64>,
    balances: &'a mut BTreeMap<String, Money>,
    postconditions: &'a mut Vec<ConsequentialActionPostcondition>,
    seen_ids: &'a mut HashSet<String>,
    seen_correlations: &'a mut HashSet<String>,
    manual_spend: &'a mut BTreeMap<String, i64>,
    manual_category_spend: &'a mut BTreeMap<String, i64>,
    manual_total: &'a mut i64,
    envelopes: &'a mut BTreeMap<(String, String), CategoryEnvelope>,
    impacts: &'a mut Vec<ConsequentialActionImpact>,
}

fn validate_manual(
    context: ManualValidationContext<'_>,
    transaction: &ManualTransactionIntent,
) -> Result<(), String> {
    let ManualValidationContext {
        request,
        charges,
        shared,
        transfer_outflows,
        balances,
        postconditions,
        seen_ids,
        seen_correlations,
        manual_spend,
        manual_category_spend,
        manual_total,
        envelopes,
        impacts,
    } = context;
    if transaction.parent_id.trim().is_empty()
        || transaction.correlation_id.trim().is_empty()
        || !seen_ids.insert(transaction.parent_id.clone())
        || !seen_correlations.insert(transaction.correlation_id.clone())
        || !valid_date(&transaction.date)
        || transaction.amount.minor_units() >= 0
    {
        return Err("invalid_or_duplicate_manual_transaction".into());
    }
    let account = live_account(request, &transaction.account_id)?;
    let source_account = account_fact(
        &request.decision_card_request.financial_snapshot,
        &transaction.account_id,
    )
    .ok_or("manual_account_fact_missing")?;
    let account_charge = charges
        .accounts
        .get(&transaction.account_id)
        .ok_or("manual_account_not_charged")?;
    if transaction.amount.currency() != account.currency
        || source_account.currency != account.currency
        || source_account.recorded_balance != account.balance
        || source_account.on_budget != account.on_budget
        || source_account.closed != account.closed
        || account_charge.currency() != account.currency
    {
        return Err("manual_transaction_currency_or_source_mismatch".into());
    }
    let spend = transaction
        .amount
        .minor_units()
        .checked_neg()
        .ok_or("money_arithmetic_overflow")?;
    let next_account_spend = checked_add(
        *manual_spend.get(&transaction.account_id).unwrap_or(&0),
        spend,
    )?;
    let transfer_outflow = *transfer_outflows.get(&transaction.account_id).unwrap_or(&0);
    if transfer_outflow > 0 {
        ensure_composite_outflow_capacity(
            shared.ok_or("transfer_capacity_unavailable")?,
            &transaction.account_id,
            &account.currency,
            next_account_spend,
            transfer_outflow,
        )?;
    }
    if next_account_spend > account_charge.minor_units() {
        return Err("manual_account_charge_exceeded".into());
    }
    let next_manual_total = checked_add(*manual_total, spend)?;
    if next_manual_total > charges.total.minor_units() {
        return Err("manual_cart_total_exceeded".into());
    }

    let month = transaction
        .date
        .get(..7)
        .ok_or("invalid_transaction_date")?;
    let category_effects: Vec<(&str, i64)> = if transaction.splits.is_empty() {
        vec![(
            transaction
                .category_id
                .as_deref()
                .ok_or("manual_category_required")?,
            transaction.amount.minor_units(),
        )]
    } else {
        if transaction.category_id.is_some() {
            return Err("split_parent_category_must_be_null".into());
        }
        let mut total = 0_i64;
        for split in &transaction.splits {
            if split.category_id.trim().is_empty()
                || split.amount.minor_units() >= 0
                || split.amount.currency() != account.currency
            {
                return Err("invalid_split_amount".into());
            }
            total = checked_add(total, split.amount.minor_units())?;
        }
        if total != transaction.amount.minor_units() {
            return Err("split_total_mismatch".into());
        }
        transaction
            .splits
            .iter()
            .map(|split| (split.category_id.as_str(), split.amount.minor_units()))
            .collect()
    };
    for (category_id, delta) in category_effects {
        if !request
            .current_ledger
            .categories
            .iter()
            .any(|category| category.category_id == category_id)
        {
            return Err("manual_category_missing".into());
        }
        let charge = charges
            .categories
            .get(category_id)
            .ok_or("manual_category_not_charged")?;
        if charge.currency() != account.currency {
            return Err("manual_category_currency_mismatch".into());
        }
        let category_spend = delta.checked_neg().ok_or("manual_amount_overflow")?;
        let previous_category_spend = *manual_category_spend.get(category_id).unwrap_or(&0);
        let next_category_spend = checked_add(previous_category_spend, category_spend)?;
        if next_category_spend > charge.minor_units() {
            return Err("manual_category_charge_exceeded".into());
        }

        let fact = category_fact(
            &request.decision_card_request.financial_snapshot,
            category_id,
            month,
        )
        .ok_or("manual_category_fact_missing")?;
        let key = (category_id.to_owned(), month.to_owned());
        let envelope = envelopes
            .get_mut(&key)
            .ok_or("manual_category_card_state_missing")?;
        if fact.availability.currency() != account.currency
            || fact.availability != envelope.baseline_availability
        {
            return Err("manual_category_target_changed".into());
        }
        let key = (category_id.to_owned(), month.to_owned());
        let envelope = envelopes
            .get_mut(&key)
            .ok_or("manual_category_card_state_missing")?;
        let next_uncommitted = checked_add(envelope.uncommitted.minor_units(), delta)?;
        if next_uncommitted < 0 {
            return Err("manual_category_insufficient".into());
        }
        envelope.availability = Money::new(
            checked_add(envelope.availability.minor_units(), delta)?,
            account.currency.clone(),
        );
        envelope.uncommitted = Money::new(next_uncommitted, account.currency.clone());
        manual_category_spend.insert(category_id.to_owned(), next_category_spend);
        impacts.push(ConsequentialActionImpact::ReservationCommitment {
            category_id: category_id.to_owned(),
            commitments: envelope.commitments.clone(),
            reservations: envelope.reservations.clone(),
        });
    }
    manual_spend.insert(transaction.account_id.clone(), next_account_spend);
    *manual_total = next_manual_total;
    let current = balances
        .get(&transaction.account_id)
        .unwrap_or(&account.balance);
    balances.insert(
        transaction.account_id.clone(),
        Money::new(
            checked_add(current.minor_units(), transaction.amount.minor_units())?,
            account.currency.clone(),
        ),
    );
    impacts.push(ConsequentialActionImpact::AccountReadiness {
        account_id: transaction.account_id.clone(),
        state: ReadinessState::Ready,
    });
    impacts.push(ConsequentialActionImpact::PaymentRoute {
        account_id: transaction.account_id.clone(),
        state: ReadinessState::Ready,
    });
    postconditions.push(ConsequentialActionPostcondition::Transaction {
        parent_id: transaction.parent_id.clone(),
        account_id: transaction.account_id.clone(),
        amount: transaction.amount.clone(),
        date: transaction.date.clone(),
        category_id: transaction.category_id.clone(),
        payee_name: transaction.payee_name.clone(),
        notes: transaction.notes.clone(),
        splits: transaction.splits.clone(),
    });
    Ok(())
}

fn validate_projection_evidence(
    request: &PlanConsequentialActionRequest,
    transaction: &ManualTransactionIntent,
    evidence_ids: &[String],
    resolution_subject_id: Option<&str>,
) -> Result<(), String> {
    if evidence_ids.is_empty() {
        return Err("projection_evidence_required".into());
    }
    let mut seen = HashSet::new();
    let mut subject = None;
    for evidence_id in evidence_ids {
        if evidence_id.trim().is_empty() || !seen.insert(evidence_id.as_str()) {
            return Err("duplicate_projection_evidence".into());
        }
        let observation =
            event_resolution_for_evidence(request, evidence_id, resolution_subject_id)?;
        let subject_id = event_subject(observation)?;
        if subject.is_some_and(|previous| previous != subject_id) {
            return Err("projection_multiple_event_subjects".into());
        }
        subject = Some(subject_id);
        if observation
            .ledger_effect
            .as_ref()
            .is_none_or(|effect| !source_effect_matches_transaction(effect, transaction))
        {
            return Err("projection_source_effect_mismatch".into());
        }
        let evidence = request
            .resolved_evidence
            .iter()
            .find(|evidence| {
                evidence.evidence_id == *evidence_id && evidence.subject_id == subject_id
            })
            .ok_or("projection_evidence_missing")?;
        if evidence.state != EvidenceState::Resolved
            || evidence.subject_id != subject_id
            || evidence.content_hash.as_deref() != observation.content_hash.as_deref()
            || evidence.version.as_deref() != observation.version.as_deref()
        {
            return Err("projection_evidence_mismatch".into());
        }
    }
    Ok(())
}

fn configured_source_currency(request: &PlanConsequentialActionRequest, currency: &str) -> bool {
    request.current_ledger.accounts.iter().any(|account| {
        account.currency == currency
            && account_fact(
                &request.decision_card_request.financial_snapshot,
                &account.account_id,
            )
            .is_some_and(|fact| {
                fact.currency == currency
                    && fact.currency_evidence.state
                        == balanceframe_financial_core::liquidity::FactState::Known
            })
    })
}

fn live_account<'a>(
    request: &'a PlanConsequentialActionRequest,
    id: &str,
) -> Result<&'a ConsequentialActionAccount, String> {
    let account = request
        .current_ledger
        .accounts
        .iter()
        .find(|account| account.account_id == id)
        .ok_or("ledger_account_missing")?;
    if !account.on_budget || account.closed {
        return Err("ledger_account_not_live_on_budget".into());
    }
    let fact = account_fact(&request.decision_card_request.financial_snapshot, id)
        .ok_or("account_liquidity_fact_missing")?;
    if fact.currency != account.currency
        || fact.recorded_balance != account.balance
        || fact.closed
        || !fact.on_budget
    {
        return Err("account_source_changed".into());
    }
    Ok(account)
}

fn current_assignment<'a>(
    request: &'a PlanConsequentialActionRequest,
    category_id: &str,
    month: &str,
) -> Result<&'a Money, String> {
    request
        .current_ledger
        .assignments
        .iter()
        .find(|assignment| assignment.category_id == category_id && assignment.as_of_month == month)
        .map(|assignment| &assignment.amount)
        .ok_or_else(|| "current_assignment_missing".into())
}

fn parse_money(value: &Value) -> Result<(i64, String), String> {
    let units = value
        .get("minorUnits")
        .and_then(Value::as_str)
        .ok_or("money_missing_minor_units")?
        .parse::<i64>()
        .map_err(|_| "money_out_of_range")?;
    let currency = value
        .get("currency")
        .and_then(Value::as_str)
        .ok_or("money_missing_currency")?;
    if !valid_currency(currency) {
        return Err("invalid_currency".into());
    }
    Ok((units, currency.to_owned()))
}

fn adjust_money(value: &mut Value, delta: i64, currency: &str) -> Result<(), String> {
    let (current, current_currency) = parse_money(value)?;
    if current_currency != currency {
        return Err("money_currency_mismatch".into());
    }
    *value = json!({"minorUnits": checked_add(current, delta)?.to_string(), "currency": currency});
    Ok(())
}

struct NamedMoneyTarget<'a> {
    id_key: &'a str,
    id: &'a str,
    month: Option<(&'a str, &'a str)>,
    money_key: &'a str,
}

fn adjust_named_money(
    array: &mut Value,
    target: NamedMoneyTarget<'_>,
    delta: i64,
    currency: &str,
) -> Result<(), String> {
    let NamedMoneyTarget {
        id_key,
        id,
        month,
        money_key,
    } = target;
    let rows = array.as_array_mut().ok_or("source_collection_not_array")?;
    let mut matches = rows.iter_mut().filter(|row| {
        row[id_key].as_str() == Some(id)
            && month.is_none_or(|(key, value)| row[key].as_str() == Some(value))
    });
    let row = matches.next().ok_or("source_target_missing")?;
    if matches.next().is_some() {
        return Err("duplicate_source_target".into());
    }
    adjust_money(&mut row[money_key], delta, currency)
}

fn reverse_legacy_account_balance(
    card: &mut Value,
    account_id: &str,
    delta: i64,
    currency: &str,
) -> Result<(), String> {
    let accounts = &mut card["financialSnapshot"]["legacySnapshot"]["accounts"];
    adjust_named_money(
        accounts,
        NamedMoneyTarget {
            id_key: "id",
            id: account_id,
            month: None,
            money_key: "clearedBalance",
        },
        delta,
        currency,
    )?;
    adjust_named_money(
        accounts,
        NamedMoneyTarget {
            id_key: "id",
            id: account_id,
            month: None,
            money_key: "importedBalance",
        },
        delta,
        currency,
    )
}

fn remove_action_transaction_observation(
    card: &mut Value,
    account_id: &str,
    transaction_id: &str,
) -> Result<(), String> {
    if card["financialSnapshot"]["source"]["ledgerBackend"] != "actual" {
        return Ok(());
    }
    let captured_at = card["financialSnapshot"]["capturedAt"]
        .as_str()
        .ok_or("snapshot_capture_time_missing")?
        .to_owned();
    let observations = card["financialSnapshot"]["observations"]
        .as_array_mut()
        .ok_or("source_observation_collection_missing")?;
    let mut found = None;
    for (index, observation) in observations.iter().enumerate() {
        let action_generated = matches!(
            observation["kind"].as_str(),
            Some("pending_activity" | "uncleared_activity")
        ) && observation["scope"]["kind"] == "account"
            && observation["scope"]["id"] == account_id
            && observation["state"] == "included"
            && observation["observedAt"] == captured_at
            && observation.get("contentHash").is_none()
            && observation.get("version").is_none()
            && observation.get("ledgerEffect").is_none()
            && observation["evidence"]
                .as_array()
                .is_some_and(|references| {
                    references.len() == 1
                        && references[0]["evidenceId"] == transaction_id
                        && references[0]["kind"] == "transaction"
                        && references[0]["authorized"] == true
                        && references[0]["redaction"] == "visible"
                });
        if action_generated && found.replace(index).is_some() {
            return Err("duplicate_action_transaction_observation".into());
        }
    }
    if let Some(index) = found {
        observations.remove(index);
    }
    Ok(())
}

fn remove_action_transaction_projection(
    card: &mut Value,
    account_id: &str,
    transaction_id: &str,
) -> Result<(), String> {
    remove_action_transaction_observation(card, account_id, transaction_id)?;
    let Some(accounts) = card
        .get_mut("financialSnapshot")
        .and_then(|snapshot| snapshot.get_mut("liquidity"))
        .and_then(|liquidity| liquidity.get_mut("accounts"))
        .and_then(Value::as_array_mut)
    else {
        return Ok(());
    };
    let mut matching_accounts = accounts
        .iter()
        .enumerate()
        .filter(|(_, account)| account["accountId"].as_str() == Some(account_id));
    let Some((account_index, _)) = matching_accounts.next() else {
        return Ok(());
    };
    if matching_accounts.next().is_some() {
        return Err("postcondition_account_duplicate".into());
    }
    let account = &mut accounts[account_index];
    if let Some(ids) = account
        .get_mut("baselineTransactionIds")
        .and_then(Value::as_array_mut)
    {
        let mut matches = ids
            .iter()
            .enumerate()
            .filter(|(_, id)| id.as_str() == Some(transaction_id));
        if let Some((index, _)) = matches.next() {
            if matches.next().is_some() {
                return Err("postcondition_transaction_projection_duplicate".into());
            }
            ids.remove(index);
        }
    }
    let mut remove_transfer_credit_reason = false;
    if let Some(flows) = account
        .get_mut("unsettledFlows")
        .and_then(Value::as_array_mut)
    {
        let mut matches = flows
            .iter()
            .enumerate()
            .filter(|(_, flow)| flow["id"].as_str() == Some(transaction_id));
        if let Some((index, flow)) = matches.next() {
            if matches.next().is_some() {
                return Err("postcondition_flow_projection_duplicate".into());
            }
            if flow["provenance"] != "manual_ledger"
                || !flow["matchedTransactionIds"]
                    .as_array()
                    .is_some_and(|ids| ids.len() == 1 && ids[0].as_str() == Some(transaction_id))
            {
                return Err("postcondition_flow_projection_mismatch".into());
            }
            let was_unverified_transfer_credit = flow["direction"] == "inflow"
                && !flow["transferTransactionId"].is_null()
                && (flow["importedId"].is_null() || flow["reconciled"] != true);
            flows.remove(index);
            remove_transfer_credit_reason = was_unverified_transfer_credit
                && !flows.iter().any(|flow| {
                    flow["direction"] == "inflow"
                        && !flow["transferTransactionId"].is_null()
                        && (flow["importedId"].is_null() || flow["reconciled"] != true)
                });
        }
    }
    if remove_transfer_credit_reason {
        if let Some(evidence) = account
            .get_mut("activityEvidence")
            .filter(|evidence| evidence["source"] == "actual_ledger")
        {
            if let Some(reasons) = evidence.get_mut("reasons").and_then(Value::as_array_mut) {
                reasons
                    .retain(|reason| reason.as_str() != Some("manual_transfer_credit_unverified"));
            }
        }
    }
    Ok(())
}

fn reverse_legacy_payee(
    card: &mut Value,
    transaction: &ManualTransactionIntent,
    binding: Option<&ConsequentialActionManualPayeeBinding>,
    row: &Value,
    payee_bindings: &[ConsequentialActionManualPayeeBinding],
) -> Result<(), String> {
    let Some(payee_name) = manual_payee_name(transaction) else {
        return if binding.is_none() && row["payeeId"].is_null() && row["payeeName"].is_null() {
            Ok(())
        } else {
            Err("manual_payee_binding_mismatch".into())
        };
    };
    let binding = binding.ok_or("manual_payee_binding_missing")?;
    if binding.parent_id != transaction.parent_id
        || binding.payee_name != payee_name
        || row["payeeName"].as_str().map(str::trim) != Some(payee_name)
    {
        return Err("manual_payee_binding_mismatch".into());
    }
    let payee_id = row["payeeId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("manual_payee_id_missing")?;
    let transaction_rows = card["financialSnapshot"]["legacySnapshot"]["transactions"]
        .as_array()
        .ok_or("legacy_transaction_collection_missing")?;
    let mut shared_authorized_user = false;
    let mut unrelated_user = false;
    for candidate in transaction_rows
        .iter()
        .filter(|candidate| candidate["payeeId"] == payee_id)
    {
        let authorized_user = payee_bindings.iter().any(|other| {
            other.parent_id != transaction.parent_id
                && other.payee_name == payee_name
                && other.existing_payee_id.is_none()
                && candidate["id"] == other.parent_id
        });
        shared_authorized_user |= authorized_user;
        unrelated_user |= !authorized_user;
    }
    let payees = card["financialSnapshot"]["legacySnapshot"]["payees"]
        .as_array_mut()
        .ok_or("legacy_payee_collection_missing")?;
    let matches = payees
        .iter()
        .filter(|payee| payee["id"] == payee_id)
        .count();
    if matches != 1 {
        return Err("manual_payee_postcondition_mismatch".into());
    }
    let index = unique_row_index(payees, |payee| payee["id"].as_str() == Some(payee_id))?;
    let payee = &payees[index];
    if payee["name"].as_str().map(str::trim) != Some(payee_name) {
        return Err("manual_payee_postcondition_mismatch".into());
    }
    match binding.existing_payee_id.as_deref() {
        Some(existing_id) if existing_id == payee_id => Ok(()),
        Some(_) => Err("manual_payee_postcondition_mismatch".into()),
        None if payee["transferAccountId"].is_null()
            && payee["mtid"].is_null()
            && !unrelated_user =>
        {
            if shared_authorized_user {
                Ok(())
            } else {
                payees.remove(index);
                Ok(())
            }
        }
        None => Err("manual_payee_postcondition_mismatch".into()),
    }
}

fn reverse_legacy_manual_transaction(
    card: &mut Value,
    transaction: &ManualTransactionIntent,
    payee_bindings: &[ConsequentialActionManualPayeeBinding],
) -> Result<(), String> {
    let (index, row) = {
        let rows = card["financialSnapshot"]["legacySnapshot"]["transactions"]
            .as_array()
            .ok_or("legacy_transaction_collection_missing")?;
        let Some(index) = rows
            .iter()
            .position(|row| row["id"] == transaction.parent_id)
        else {
            return Ok(());
        };
        if rows
            .iter()
            .filter(|row| row["id"] == transaction.parent_id)
            .count()
            != 1
        {
            return Err("postcondition_row_duplicate".into());
        }
        (index, rows[index].clone())
    };
    let children = row["subtransactions"]
        .as_array()
        .ok_or("legacy_transaction_children_missing")?;
    let splits_match = children.len() == transaction.splits.len()
        && children
            .iter()
            .zip(&transaction.splits)
            .all(|(child, split)| {
                child["accountId"] == transaction.account_id
                    && child["date"] == transaction.date
                    && child["categoryId"] == split.category_id
                    && child["amount"] == serde_json::to_value(&split.amount).unwrap_or(Value::Null)
            });
    if row["accountId"] != transaction.account_id
        || row["date"] != transaction.date
        || row["amount"] != serde_json::to_value(&transaction.amount).unwrap_or(Value::Null)
        || row["categoryId"]
            != serde_json::to_value(&transaction.category_id).unwrap_or(Value::Null)
        || row["payeeName"]
            != serde_json::to_value(manual_payee_name(transaction)).unwrap_or(Value::Null)
        || row["notes"] != serde_json::to_value(&transaction.notes).unwrap_or(Value::Null)
        || !row["transferAccountId"].is_null()
        || row["cleared"] != false
        || row["reconciled"] != false
        || !row["importedId"].is_null()
        || !row["importedPayee"].is_null()
        || row["tags"] != json!([])
        || !splits_match
    {
        return Err("manual_postcondition_mismatch".into());
    }
    let mut bindings = payee_bindings
        .iter()
        .filter(|binding| binding.parent_id == transaction.parent_id);
    let binding = bindings.next();
    if bindings.next().is_some() {
        return Err("manual_payee_binding_ambiguous".into());
    }
    card["financialSnapshot"]["legacySnapshot"]["transactions"]
        .as_array_mut()
        .ok_or("legacy_transaction_collection_missing")?
        .remove(index);
    reverse_legacy_payee(card, transaction, binding, &row, payee_bindings)?;
    let inverse = transaction
        .amount
        .minor_units()
        .checked_neg()
        .ok_or("money_arithmetic_overflow")?;
    reverse_legacy_account_balance(
        card,
        &transaction.account_id,
        inverse,
        transaction.amount.currency(),
    )?;
    remove_action_transaction_projection(card, &transaction.account_id, &transaction.parent_id)
}

fn reverse_legacy_transfer(
    card: &mut Value,
    ledger: &Value,
    mapping: &Value,
    action: &AtomicConsequentialActionIntent,
) -> Result<(), String> {
    let AtomicConsequentialActionIntent::Transfer {
        source_account_id,
        destination_account_id,
        amount,
        date,
        ..
    } = action
    else {
        return Err("transfer_postcondition_mismatch".into());
    };
    let marker = mapping["marker"]
        .as_str()
        .ok_or("transfer_mapping_missing")?;
    let transactions = &mut card["financialSnapshot"]["legacySnapshot"]["transactions"];
    let rows = transactions
        .as_array_mut()
        .ok_or("legacy_transaction_collection_missing")?;
    let source_id = mapping["sourceTransactionId"]
        .as_str()
        .ok_or("transfer_mapping_missing")?;
    let destination_id = mapping["destinationTransactionId"]
        .as_str()
        .ok_or("transfer_mapping_missing")?;
    let source_matches = rows.iter().filter(|row| row["id"] == source_id).count();
    let destination_matches = rows
        .iter()
        .filter(|row| row["id"] == destination_id)
        .count();
    if source_matches == 0 && destination_matches == 0 {
        return Ok(());
    }
    if source_matches != 1 || destination_matches != 1 || source_id == destination_id {
        return Err("transfer_postcondition_mismatch".into());
    }
    let source_index = unique_row_index(rows, |row| row["id"].as_str() == Some(source_id))?;
    let destination_index =
        unique_row_index(rows, |row| row["id"].as_str() == Some(destination_id))?;
    let source = &rows[source_index];
    let destination = &rows[destination_index];
    let minor = amount.minor_units();
    let inverse = minor.checked_neg().ok_or("money_arithmetic_overflow")?;
    let source_ledger = ledger["transactions"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["parentId"] == source_id));
    let destination_ledger = ledger["transactions"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["parentId"] == destination_id));
    let normalized_pair_matches = |row: &Value, expected: Option<&Value>| {
        expected.is_some_and(|expected| {
            row["payeeName"] == expected["payeeName"]
                && row["notes"] == expected["notes"]
                && row["categoryId"] == expected["categoryId"]
        })
    };
    let row_matches = |row: &Value,
                       id: &str,
                       account: &str,
                       counterparty: &str,
                       signed: i64,
                       expected: Option<&Value>| {
        row["id"] == id
            && row["accountId"] == account
            && row["date"].as_str() == Some(date.as_str())
            && parse_money(&row["amount"]).ok() == Some((signed, amount.currency().to_owned()))
            && row["categoryId"].is_null()
            && row["transferAccountId"] == counterparty
            && row["notes"] == marker
            && row["cleared"] == false
            && row["reconciled"] == false
            && row["importedId"].is_null()
            && row["importedPayee"].is_null()
            && row["tags"] == json!([])
            && row["subtransactions"] == json!([])
            && normalized_pair_matches(row, expected)
    };
    if !row_matches(
        source,
        source_id,
        source_account_id,
        destination_account_id,
        inverse,
        source_ledger,
    ) || !row_matches(
        destination,
        destination_id,
        destination_account_id,
        source_account_id,
        minor,
        destination_ledger,
    ) {
        return Err("transfer_postcondition_mismatch".into());
    }
    let high = source_index.max(destination_index);
    let low = source_index.min(destination_index);
    rows.remove(high);
    rows.remove(low);
    reverse_legacy_account_balance(card, source_account_id, minor, amount.currency())?;
    reverse_legacy_account_balance(card, destination_account_id, inverse, amount.currency())?;
    remove_action_transaction_projection(card, source_account_id, source_id)?;
    remove_action_transaction_projection(card, destination_account_id, destination_id)
}

fn reverse_legacy_assignment(
    card: &mut Value,
    category_id: &str,
    month: &str,
    delta: i64,
    currency: &str,
) -> Result<(), String> {
    let budgets = card["financialSnapshot"]["legacySnapshot"]["budgets"]
        .as_array_mut()
        .ok_or("legacy_budget_collection_missing")?;
    let matches = budgets
        .iter()
        .filter(|budget| budget["month"] == month)
        .count();
    if matches == 0 {
        return Ok(());
    }
    if matches > 1 {
        return Err("duplicate_source_target".into());
    }
    let budget = budgets
        .iter_mut()
        .find(|budget| budget["month"] == month)
        .ok_or("legacy_budget_month_missing")?;
    let category = budget["categories"]
        .as_object_mut()
        .and_then(|categories| categories.get_mut(category_id))
        .ok_or("legacy_budget_category_missing")?;
    adjust_money(&mut category["amount"], delta, currency)
}

fn remove_action_wallet_observations(card: &mut Value, account_id: &str) -> Result<(), String> {
    let captured_at = card["financialSnapshot"]["capturedAt"]
        .as_str()
        .ok_or("snapshot_capture_time_missing")?
        .to_owned();
    let observations = card["financialSnapshot"]["observations"]
        .as_array_mut()
        .ok_or("source_observation_collection_missing")?;
    let mut seen_kinds = HashSet::new();
    let mut remove = Vec::new();
    for (index, observation) in observations.iter().enumerate() {
        if observation["scope"]["kind"] != "account"
            || observation["scope"]["id"] != account_id
            || !observation["evidence"]
                .as_array()
                .is_some_and(|references| {
                    references.len() == 1
                        && references[0]["evidenceId"] == account_id
                        && references[0]["kind"] == "account"
                        && references[0]["authorized"] == true
                        && references[0]["redaction"] == "visible"
                })
        {
            continue;
        }
        let kind = observation["kind"]
            .as_str()
            .ok_or("invalid_source_observation")?;
        let observed_at = observation["observedAt"].as_str();
        let state = observation["state"].as_str();
        let generated = match kind {
            "account_freshness" => state == Some("unknown") && observed_at.is_none(),
            "account_coverage" | "account_balance" => {
                (state == Some("complete") && observed_at == Some(captured_at.as_str()))
                    || (state == Some("unavailable") && observed_at.is_none())
            }
            "account_type" => {
                (state == Some("complete") && observed_at == Some(captured_at.as_str()))
                    || (state == Some("unknown") && observed_at.is_none())
            }
            "credit_card_obligation_coverage" => {
                state == Some("unavailable") && observed_at.is_none()
            }
            _ => false,
        };
        if generated {
            if !seen_kinds.insert(kind.to_owned()) {
                return Err("duplicate_action_wallet_observation".into());
            }
            remove.push(index);
        }
    }
    for index in remove.into_iter().rev() {
        observations.remove(index);
    }
    Ok(())
}

fn valid_opening_equity(ledger: &ConsequentialActionLedger, equity: &WalletOpeningEquity) -> bool {
    equity.starting_balance
        && hash_valid(&equity.sdk_fingerprint)
        && equity.amount.minor_units() > 0
        && valid_date(&equity.date)
        && equity
            .payee_id
            .as_ref()
            .is_some_and(|id| !id.trim().is_empty())
        && ledger.wallets.iter().any(|mapping| {
            mapping.wallet_id == equity.wallet_id && mapping.account_id == equity.account_id
        })
        && ledger
            .transactions
            .iter()
            .filter(|row| {
                row.parent_id == equity.transaction_id
                    && row.account_id == equity.account_id
                    && row.amount == equity.amount
                    && row.date == equity.date
                    && row.category_id == equity.category_id
                    && row.payee_name.as_deref() == Some("Starting Balance")
                    && row.notes.is_none()
                    && row.splits.is_empty()
                    && row.transfer_account_id.is_none()
            })
            .count()
            == 1
}
fn reverse_wallet_opening(
    card: &mut Value,
    ledger: &mut Value,
    wallet_id: &str,
    account_id: &str,
    opening: &WalletOpeningIntent,
    bindings: &[ConsequentialActionManualPayeeBinding],
) -> Result<(), String> {
    let equities = ledger["walletOpeningEquities"]
        .as_array()
        .ok_or("wallet_opening_equity_missing")?;
    let equity_index = unique_row_index(equities, |row| row["walletId"] == wallet_id)?;
    let equity = equities[equity_index].clone();
    let transaction_id = equity["transactionId"]
        .as_str()
        .ok_or("wallet_opening_equity_missing")?;
    let rows = card["financialSnapshot"]["legacySnapshot"]["transactions"]
        .as_array()
        .ok_or("legacy_transaction_collection_missing")?;
    let index = unique_row_index(rows, |row| row["id"] == transaction_id)?;
    let row = rows[index].clone();
    if row["accountId"] != account_id
        || row["amount"] != serde_json::to_value(&opening.amount).unwrap_or(Value::Null)
        || row["date"] != opening.date
        || row["cleared"] != true
        || row["reconciled"] != false
        || row["payeeId"] != equity["payeeId"]
        || row["categoryId"] != equity["categoryId"]
        || row["payeeName"] != "Starting Balance"
        || !row["notes"].is_null()
        || !row["importedId"].is_null()
        || !row["importedPayee"].is_null()
        || !row["transferAccountId"].is_null()
        || row["tags"] != json!([])
        || row["subtransactions"] != json!([])
    {
        return Err("wallet_opening_equity_changed".into());
    }
    let virtual_id = format!("wallet-opening:{wallet_id}");
    let source = bindings
        .iter()
        .find(|binding| binding.parent_id == virtual_id)
        .ok_or("wallet_opening_payee_binding_missing")?;
    let binding = ConsequentialActionManualPayeeBinding {
        parent_id: transaction_id.into(),
        payee_name: source.payee_name.clone(),
        existing_payee_id: source.existing_payee_id.clone(),
    };
    let transaction = ManualTransactionIntent {
        parent_id: transaction_id.into(),
        correlation_id: String::new(),
        account_id: account_id.into(),
        amount: opening.amount.clone(),
        date: opening.date.clone(),
        category_id: equity["categoryId"].as_str().map(str::to_owned),
        payee_name: Some("Starting Balance".into()),
        notes: None,
        splits: vec![],
    };
    card["financialSnapshot"]["legacySnapshot"]["transactions"]
        .as_array_mut()
        .unwrap()
        .remove(index);
    // SDK starting-balance payees may be shared by multiple approved wallet openings.
    // Replace only virtual bindings backed by another verified opening proof.
    let opening_bindings: Vec<_> = bindings
        .iter()
        .map(|source| {
            let parent_id = source
                .parent_id
                .strip_prefix("wallet-opening:")
                .and_then(|wallet| equities.iter().find(|equity| equity["walletId"] == wallet))
                .and_then(|equity| equity["transactionId"].as_str())
                .unwrap_or(&source.parent_id);
            ConsequentialActionManualPayeeBinding {
                parent_id: parent_id.to_owned(),
                payee_name: source.payee_name.clone(),
                existing_payee_id: source.existing_payee_id.clone(),
            }
        })
        .collect();
    reverse_legacy_payee(card, &transaction, Some(&binding), &row, &opening_bindings)?;
    reverse_legacy_account_balance(
        card,
        account_id,
        opening
            .amount
            .minor_units()
            .checked_neg()
            .ok_or("money_arithmetic_overflow")?,
        opening.amount.currency(),
    )?;
    remove_action_transaction_projection(card, account_id, transaction_id)?;
    ledger["transactions"]
        .as_array_mut()
        .ok_or("transaction_collection_missing")?
        .retain(|row| row["parentId"] != transaction_id);
    ledger["walletOpeningEquities"]
        .as_array_mut()
        .unwrap()
        .remove(equity_index);
    if ledger["walletOpeningEquities"] == json!([]) {
        ledger
            .as_object_mut()
            .unwrap()
            .remove("walletOpeningEquities");
    }
    Ok(())
}

fn reverse_legacy_wallet_account(
    card: &mut Value,
    account_id: &str,
    name: &str,
    currency: &str,
) -> Result<(), String> {
    let accounts = card["financialSnapshot"]["legacySnapshot"]["accounts"]
        .as_array()
        .ok_or("legacy_account_collection_missing")?;
    let matches = accounts
        .iter()
        .filter(|account| account["id"] == account_id)
        .count();
    if matches == 0 {
        return Ok(());
    }
    if matches != 1 {
        return Err("duplicate_source_target".into());
    }
    let index = unique_row_index(accounts, |account| {
        account["id"].as_str() == Some(account_id)
    })?;
    let account = &accounts[index];
    if account["name"] != name
        || account["accountType"] != "checking"
        || account["offBudget"] != false
        || account["isClosed"] != false
        || !account["mtid"].is_null()
        || parse_money(&account["clearedBalance"])? != (0, currency.to_owned())
        || parse_money(&account["importedBalance"])? != (0, currency.to_owned())
    {
        return Err("wallet_postcondition_mismatch".into());
    }
    let payees = card["financialSnapshot"]["legacySnapshot"]["payees"]
        .as_array()
        .ok_or("legacy_payee_collection_missing")?;
    let payee_matches = payees
        .iter()
        .filter(|payee| payee["transferAccountId"] == account_id)
        .count();
    if payee_matches != 1 {
        return Err("wallet_payee_postcondition_mismatch".into());
    }
    let payee_index = unique_row_index(payees, |payee| {
        payee["transferAccountId"].as_str() == Some(account_id)
    })?;
    card["financialSnapshot"]["legacySnapshot"]["accounts"]
        .as_array_mut()
        .ok_or("legacy_account_collection_missing")?
        .remove(index);
    card["financialSnapshot"]["legacySnapshot"]["payees"]
        .as_array_mut()
        .ok_or("legacy_payee_collection_missing")?
        .remove(payee_index);
    Ok(())
}

fn reverse_action_in_value(
    action: &AtomicConsequentialActionIntent,
    decision_card_request: &mut Value,
    ledger: &mut Value,
    payee_bindings: &[ConsequentialActionManualPayeeBinding],
) -> Result<(), ConsequentialActionVerificationReason> {
    let result: Result<(), String> = (|| {
        match action {
            AtomicConsequentialActionIntent::Reallocation { assignments } => {
                for movement in assignments.iter().rev() {
                    let amount = movement.amount.minor_units();
                    if amount <= 0 {
                        return Err("invalid_reallocation_amount".into());
                    }
                    let inverse = amount.checked_neg().ok_or("money_arithmetic_overflow")?;
                    let currency = movement.amount.currency();
                    adjust_named_money(
                        &mut ledger["assignments"],
                        NamedMoneyTarget {
                            id_key: "categoryId",
                            id: &movement.source_category_id,
                            month: Some(("asOfMonth", &movement.source_as_of_month)),
                            money_key: "amount",
                        },
                        amount,
                        currency,
                    )?;
                    adjust_named_money(
                        &mut ledger["assignments"],
                        NamedMoneyTarget {
                            id_key: "categoryId",
                            id: &movement.destination_category_id,
                            month: Some(("asOfMonth", &movement.destination_as_of_month)),
                            money_key: "amount",
                        },
                        inverse,
                        currency,
                    )?;
                    let categories =
                        &mut decision_card_request["financialSnapshot"]["liquidity"]["categories"];
                    adjust_named_money(
                        categories,
                        NamedMoneyTarget {
                            id_key: "categoryId",
                            id: &movement.source_category_id,
                            month: Some(("asOfMonth", &movement.source_as_of_month)),
                            money_key: "availability",
                        },
                        amount,
                        currency,
                    )?;
                    adjust_named_money(
                        categories,
                        NamedMoneyTarget {
                            id_key: "categoryId",
                            id: &movement.destination_category_id,
                            month: Some(("asOfMonth", &movement.destination_as_of_month)),
                            money_key: "availability",
                        },
                        inverse,
                        currency,
                    )?;
                    reverse_legacy_assignment(
                        decision_card_request,
                        &movement.source_category_id,
                        &movement.source_as_of_month,
                        amount,
                        currency,
                    )?;
                    reverse_legacy_assignment(
                        decision_card_request,
                        &movement.destination_category_id,
                        &movement.destination_as_of_month,
                        inverse,
                        currency,
                    )?;
                }
            }
            AtomicConsequentialActionIntent::ManualTransaction { transaction }
            | AtomicConsequentialActionIntent::EvidenceProjection { transaction, .. }
            | AtomicConsequentialActionIntent::EvidenceCredit { transaction, .. } => {
                let tx_rows = ledger["transactions"]
                    .as_array_mut()
                    .ok_or("transaction_collection_missing")?;
                let index = unique_row_index(tx_rows, |row| {
                    row["parentId"].as_str() == Some(&transaction.parent_id)
                })?;
                if !manual_row_matches(&tx_rows[index], transaction) {
                    return Err("manual_postcondition_mismatch".into());
                }
                reverse_legacy_manual_transaction(
                    decision_card_request,
                    transaction,
                    payee_bindings,
                )?;
                tx_rows.remove(index);
                let inverse = transaction
                    .amount
                    .minor_units()
                    .checked_neg()
                    .ok_or("money_arithmetic_overflow")?;
                adjust_named_money(
                    &mut ledger["accounts"],
                    NamedMoneyTarget {
                        id_key: "accountId",
                        id: &transaction.account_id,
                        month: None,
                        money_key: "balance",
                    },
                    inverse,
                    transaction.amount.currency(),
                )?;
                adjust_named_money(
                    &mut decision_card_request["financialSnapshot"]["liquidity"]["accounts"],
                    NamedMoneyTarget {
                        id_key: "accountId",
                        id: &transaction.account_id,
                        month: None,
                        money_key: "recordedBalance",
                    },
                    inverse,
                    transaction.amount.currency(),
                )?;
                let month = transaction
                    .date
                    .get(..7)
                    .ok_or("invalid_transaction_date")?;
                for (category, amount) in transaction_category_deltas(transaction) {
                    let inverse = amount.checked_neg().ok_or("money_arithmetic_overflow")?;
                    adjust_named_money(
                        &mut decision_card_request["financialSnapshot"]["liquidity"]["categories"],
                        NamedMoneyTarget {
                            id_key: "categoryId",
                            id: category,
                            month: Some(("asOfMonth", month)),
                            money_key: "availability",
                        },
                        inverse,
                        transaction.amount.currency(),
                    )?;
                }
            }
            AtomicConsequentialActionIntent::EvidenceAmendment {
                expected,
                expected_source,
                transaction,
                ..
            } => {
                reverse_evidence_amendment(
                    decision_card_request,
                    ledger,
                    expected,
                    expected_source,
                    transaction,
                )?;
            }
            AtomicConsequentialActionIntent::WalletMaterialization {
                wallet_id,
                account_name,
                currency,
                opening,
            } => {
                let opening_amount = opening
                    .as_ref()
                    .map_or(0, |value| value.amount.minor_units());
                let (mapping_index, account_id) = {
                    let mappings = ledger["wallets"]
                        .as_array()
                        .ok_or("wallet_mapping_missing")?;
                    let index = unique_row_index(mappings, |row| {
                        row["walletId"].as_str() == Some(wallet_id)
                    })?;
                    (
                        index,
                        mappings[index]["accountId"]
                            .as_str()
                            .ok_or("wallet_mapping_missing_account")?
                            .to_owned(),
                    )
                };
                let account = {
                    let accounts = ledger["accounts"]
                        .as_array()
                        .ok_or("account_collection_missing")?;
                    let index = unique_row_index(accounts, |row| {
                        row["accountId"].as_str() == Some(&account_id)
                    })?;
                    accounts[index].clone()
                };
                let (balance, balance_currency) = parse_money(&account["balance"])?;
                if account["name"] != *account_name
                    || account["onBudget"] != true
                    || account["closed"] != false
                    || account["currency"] != *currency
                    || balance != opening_amount
                    || balance_currency != *currency
                {
                    return Err("wallet_postcondition_mismatch".into());
                }
                let (fact_index, fact) = {
                    let facts = decision_card_request["financialSnapshot"]["liquidity"]["accounts"]
                        .as_array()
                        .ok_or("account_facts_missing")?;
                    let index = unique_row_index(facts, |row| {
                        row["accountId"].as_str() == Some(&account_id)
                    })?;
                    (index, facts[index].clone())
                };
                if fact["currency"] != *currency
                    || fact["onBudget"] != true
                    || fact["closed"] != false
                    || parse_money(&fact["recordedBalance"])? != (opening_amount, currency.clone())
                {
                    return Err("wallet_source_postcondition_mismatch".into());
                }
                if let Some(opening) = opening {
                    reverse_wallet_opening(
                        decision_card_request,
                        ledger,
                        wallet_id,
                        &account_id,
                        opening,
                        payee_bindings,
                    )?;
                }
                remove_action_wallet_observations(decision_card_request, &account_id)?;
                reverse_legacy_wallet_account(
                    decision_card_request,
                    &account_id,
                    account_name,
                    currency,
                )?;
                ledger["accounts"]
                    .as_array_mut()
                    .ok_or("account_collection_missing")?
                    .retain(|row| row["accountId"].as_str() != Some(account_id.as_str()));
                ledger["wallets"]
                    .as_array_mut()
                    .ok_or("wallet_mapping_missing")?
                    .remove(mapping_index);
                decision_card_request["financialSnapshot"]["liquidity"]["accounts"]
                    .as_array_mut()
                    .ok_or("account_facts_missing")?
                    .remove(fact_index);
            }
            AtomicConsequentialActionIntent::Transfer {
                transfer_id,
                correlation_id,
                source_account_id,
                destination_account_id,
                amount,
                date,
            } => {
                let marker = format!("balanceframe:transfer:{transfer_id}:{correlation_id}");
                if amount.minor_units() <= 0 || !valid_date(date) {
                    return Err("transfer_postcondition_mismatch".into());
                }
                let (mapping_index, mapping) = {
                    let mappings = ledger["transfers"]
                        .as_array()
                        .ok_or("transfer_mapping_missing")?;
                    let index = unique_row_index(mappings, |row| {
                        row["transferId"].as_str() == Some(transfer_id)
                    })?;
                    (index, mappings[index].clone())
                };
                if mapping["correlationId"] != *correlation_id
                    || mapping["marker"] != marker
                    || mapping["sourceAccountId"] != *source_account_id
                    || mapping["destinationAccountId"] != *destination_account_id
                    || mapping["amount"]
                        != serde_json::to_value(amount).map_err(|_| "invalid_amount")?
                    || mapping["date"] != *date
                {
                    return Err("transfer_postcondition_mismatch".into());
                }
                let (source_index, destination_index, source, destination) = {
                    let rows = ledger["transactions"]
                        .as_array()
                        .ok_or("transaction_collection_missing")?;
                    let source_index = unique_row_index(rows, |row| {
                        row["parentId"].as_str() == mapping["sourceTransactionId"].as_str()
                    })?;
                    let destination_index = unique_row_index(rows, |row| {
                        row["parentId"].as_str() == mapping["destinationTransactionId"].as_str()
                    })?;
                    (
                        source_index,
                        destination_index,
                        rows[source_index].clone(),
                        rows[destination_index].clone(),
                    )
                };
                let minor = amount.minor_units();
                if source_index == destination_index
                    || source["accountId"] != *source_account_id
                    || destination["accountId"] != *destination_account_id
                    || source["transferAccountId"] != *destination_account_id
                    || destination["transferAccountId"] != *source_account_id
                    || source["notes"] != marker
                    || destination["notes"] != marker
                    || parse_money(&source["amount"])?
                        != (
                            minor.checked_neg().ok_or("money_arithmetic_overflow")?,
                            amount.currency().to_owned(),
                        )
                    || parse_money(&destination["amount"])? != (minor, amount.currency().to_owned())
                    || source["date"] != *date
                    || destination["date"] != *date
                    || !source["splits"].as_array().is_some_and(Vec::is_empty)
                    || !destination["splits"].as_array().is_some_and(Vec::is_empty)
                    || !source["categoryId"].is_null()
                    || !destination["categoryId"].is_null()
                {
                    return Err("transfer_postcondition_mismatch".into());
                }
                reverse_legacy_transfer(decision_card_request, ledger, &mapping, action)?;
                let high = source_index.max(destination_index);
                let low = source_index.min(destination_index);
                let rows = ledger["transactions"]
                    .as_array_mut()
                    .ok_or("transaction_collection_missing")?;
                rows.remove(high);
                rows.remove(low);
                ledger["transfers"]
                    .as_array_mut()
                    .ok_or("transfer_mapping_missing")?
                    .remove(mapping_index);
                adjust_named_money(
                    &mut ledger["accounts"],
                    NamedMoneyTarget {
                        id_key: "accountId",
                        id: source_account_id,
                        month: None,
                        money_key: "balance",
                    },
                    minor,
                    amount.currency(),
                )?;
                let inverse = minor.checked_neg().ok_or("money_arithmetic_overflow")?;
                adjust_named_money(
                    &mut ledger["accounts"],
                    NamedMoneyTarget {
                        id_key: "accountId",
                        id: destination_account_id,
                        month: None,
                        money_key: "balance",
                    },
                    inverse,
                    amount.currency(),
                )?;
                adjust_named_money(
                    &mut decision_card_request["financialSnapshot"]["liquidity"]["accounts"],
                    NamedMoneyTarget {
                        id_key: "accountId",
                        id: source_account_id,
                        month: None,
                        money_key: "recordedBalance",
                    },
                    minor,
                    amount.currency(),
                )?;
                adjust_named_money(
                    &mut decision_card_request["financialSnapshot"]["liquidity"]["accounts"],
                    NamedMoneyTarget {
                        id_key: "accountId",
                        id: destination_account_id,
                        month: None,
                        money_key: "recordedBalance",
                    },
                    inverse,
                    amount.currency(),
                )?;
            }
        }
        Ok(())
    })();
    result.map_err(|error| match error.as_str() {
        "manual_postcondition_mismatch"
        | "wallet_postcondition_mismatch"
        | "wallet_mapping_missing"
        | "postcondition_row_missing"
        | "postcondition_row_duplicate"
        | "transfer_postcondition_mismatch"
        | "transfer_mapping_missing"
        | "transfer_pair_not_distinct" => {
            ConsequentialActionVerificationReason::PostconditionMismatch
        }
        _ => ConsequentialActionVerificationReason::SourceChanged,
    })
}

/// Verify that a plan still matches its source before dispatch or that exact effects are present afterward.
///
/// Revalidates the immutable hash and source-bound facts without writing or repairing state.
/// Source drift and mismatched effects return `valid: false`; postcondition verification
/// may prove an already-dispatched effect after proposal expiry. Serialization failures
/// remain errors rather than becoming approval or execution authority.
pub fn verify_consequential_action(
    request: VerifyConsequentialActionRequest,
) -> Result<ConsequentialActionVerification, String> {
    let action_hash = request.plan.action_hash.clone();
    let invalid = |reason| ConsequentialActionVerification {
        valid: false,
        reason: Some(reason),
        action_hash: action_hash.clone(),
    };
    if plan_hash(&request.plan).ok().as_deref() != Some(request.plan.action_hash.as_str())
        || request.plan.version != "1"
    {
        return Ok(invalid(ConsequentialActionVerificationReason::InvalidPlan));
    }
    let now = match parse_utc(&request.evaluated_at) {
        Some(now) => now,
        None => return Ok(invalid(ConsequentialActionVerificationReason::InvalidPlan)),
    };
    if request.phase == VerificationPhase::Preconditions {
        if now >= parse_utc(&request.plan.expires_at).unwrap_or(i128::MIN) {
            return Ok(invalid(ConsequentialActionVerificationReason::Expired));
        }
        if request.plan.source.policy_version
            != request.decision_card_request.liquidity_policy.version
            || request.plan.source.policy_version
                != request.decision_card_request.context.policy_version
        {
            return Ok(invalid(
                ConsequentialActionVerificationReason::PolicyChanged,
            ));
        }
        if request.plan.source.claim_set_revision
            != request.decision_card_request.claim_set.revision
        {
            return Ok(invalid(
                ConsequentialActionVerificationReason::ClaimsChanged,
            ));
        }
        if request.financial_policy_version != request.plan.source.financial_policy_version {
            return Ok(invalid(
                ConsequentialActionVerificationReason::PolicyChanged,
            ));
        }
        if evidence_material_changed(&request) {
            return Ok(invalid(
                ConsequentialActionVerificationReason::EvidenceChanged,
            ));
        }
        if targets_changed(&request) {
            return Ok(invalid(
                ConsequentialActionVerificationReason::TargetChanged,
            ));
        }
        let candidate = request_to_plan_request(
            &request,
            request.plan.action.clone(),
            request.plan.source.financial_policy_version.clone(),
        );
        match build_plan(candidate, true) {
            Ok(replanned)
                if replanned.source.preconditions_hash
                    == request.plan.source.preconditions_hash
                    && replanned.source.invariants_hash == request.plan.source.invariants_hash
                    && replanned.source.invalidated_freshness_accounts
                        == request.plan.source.invalidated_freshness_accounts
                    && replanned.source.invalidated_supplemental_facts
                        == request.plan.source.invalidated_supplemental_facts
                    && replanned.source.manual_payee_bindings
                        == request.plan.source.manual_payee_bindings
                    && replanned.dispatch_preconditions == request.plan.dispatch_preconditions =>
            {
                Ok(ConsequentialActionVerification {
                    valid: true,
                    reason: None,
                    action_hash: request.plan.action_hash,
                })
            }
            Ok(_) => Ok(invalid(
                ConsequentialActionVerificationReason::SourceChanged,
            )),
            Err(error) => Ok(invalid(classify_source_error(&error))),
        }
    } else {
        verify_postconditions(request, invalid)
    }
}
fn postconditions_match_current(request: &VerifyConsequentialActionRequest) -> bool {
    request
        .plan
        .expected_postconditions
        .iter()
        .all(|condition| match condition {
            ConsequentialActionPostcondition::Assignment {
                category_id,
                as_of_month,
                amount,
            } => request.current_ledger.assignments.iter().any(|assignment| {
                assignment.category_id == *category_id
                    && assignment.as_of_month == *as_of_month
                    && assignment.amount == *amount
            }),
            ConsequentialActionPostcondition::AccountBalance {
                account_id,
                balance,
            } => request
                .current_ledger
                .accounts
                .iter()
                .any(|account| account.account_id == *account_id && account.balance == *balance),
            ConsequentialActionPostcondition::Transaction { parent_id, .. } => {
                let Some(transaction) =
                    request
                        .plan
                        .action
                        .atoms()
                        .into_iter()
                        .find_map(|atom| match atom {
                            AtomicConsequentialActionIntent::ManualTransaction { transaction }
                            | AtomicConsequentialActionIntent::EvidenceProjection {
                                transaction,
                                ..
                            }
                            | AtomicConsequentialActionIntent::EvidenceCredit {
                                transaction, ..
                            }
                            | AtomicConsequentialActionIntent::EvidenceAmendment {
                                transaction,
                                ..
                            } if transaction.parent_id == *parent_id => Some(transaction),
                            _ => None,
                        })
                else {
                    return false;
                };
                request
                    .current_ledger
                    .transactions
                    .iter()
                    .filter(|row| row.parent_id == *parent_id)
                    .count()
                    == 1
                    && request
                        .current_ledger
                        .transactions
                        .iter()
                        .find(|row| row.parent_id == *parent_id)
                        .is_some_and(|row| {
                            manual_row_matches(
                                &serde_json::to_value(row).unwrap_or(Value::Null),
                                &transaction,
                            )
                        })
            }
            ConsequentialActionPostcondition::WalletMapping {
                wallet_id,
                account_name,
                on_budget,
                closed,
                opening_balance,
            } => request
                .current_ledger
                .wallets
                .iter()
                .find(|mapping| mapping.wallet_id == *wallet_id)
                .and_then(|mapping| {
                    request
                        .current_ledger
                        .accounts
                        .iter()
                        .find(|account| account.account_id == mapping.account_id)
                })
                .is_some_and(|account| {
                    account.name == *account_name
                        && account.on_budget == *on_budget
                        && account.closed == *closed
                        && account.balance == *opening_balance
                        && account.currency == opening_balance.currency()
                }),
            ConsequentialActionPostcondition::WalletOpeningEquity {
                wallet_id,
                amount,
                date,
            } => {
                request
                    .current_ledger
                    .wallet_opening_equities
                    .iter()
                    .filter(|equity| {
                        equity.wallet_id == *wallet_id
                            && equity.amount == *amount
                            && equity.date == *date
                            && valid_opening_equity(&request.current_ledger, equity)
                    })
                    .count()
                    == 1
            }
            ConsequentialActionPostcondition::TransferLedgerEntry {
                transfer_id,
                correlation_id,
                source_account_id,
                destination_account_id,
                amount,
                date,
            } => request
                .current_ledger
                .transfers
                .iter()
                .find(|mapping| mapping.transfer_id == *transfer_id)
                .is_some_and(|mapping| {
                    mapping.correlation_id == *correlation_id
                        && mapping.source_account_id == *source_account_id
                        && mapping.destination_account_id == *destination_account_id
                        && mapping.amount == *amount
                        && mapping.date == *date
                        && validate_transfer_mapping(&request.current_ledger, mapping).is_ok()
                }),
        })
}

fn restore_empty_coverage_transitions(
    card: &mut Value,
    accounts_before: CoverageState,
    transactions_before: CoverageState,
) {
    for (collection, coverage_key, before) in [
        ("accounts", "accounts", accounts_before),
        ("transactions", "transactions", transactions_before),
    ] {
        if before == CoverageState::Empty
            && card["financialSnapshot"]["coverage"][coverage_key] == "complete"
            && card["financialSnapshot"]["legacySnapshot"][collection]
                .as_array()
                .is_some_and(Vec::is_empty)
        {
            card["financialSnapshot"]["coverage"][coverage_key] = json!("empty");
        }
    }
}

fn verify_postconditions<F>(
    request: VerifyConsequentialActionRequest,
    invalid: F,
) -> Result<ConsequentialActionVerification, String>
where
    F: Fn(ConsequentialActionVerificationReason) -> ConsequentialActionVerification,
{
    if request.plan.source.policy_version != request.decision_card_request.liquidity_policy.version
        || request.plan.source.policy_version
            != request.decision_card_request.context.policy_version
    {
        return Ok(invalid(
            ConsequentialActionVerificationReason::PolicyChanged,
        ));
    }
    if request.plan.source.claim_set_revision != request.decision_card_request.claim_set.revision {
        return Ok(invalid(
            ConsequentialActionVerificationReason::ClaimsChanged,
        ));
    }
    if request.financial_policy_version != request.plan.source.financial_policy_version {
        return Ok(invalid(
            ConsequentialActionVerificationReason::PolicyChanged,
        ));
    }
    if validate_postcondition_times(&request.decision_card_request, &request.evaluated_at).is_err()
    {
        return Ok(invalid(
            ConsequentialActionVerificationReason::SourceChanged,
        ));
    }
    if validate_ledger(&request.current_ledger).is_err() || !postconditions_match_current(&request)
    {
        return Ok(invalid(
            ConsequentialActionVerificationReason::PostconditionMismatch,
        ));
    }
    if !postcondition_freshness_invalidations_match(&request)
        || !postcondition_supplemental_invalidations_match(&request)
    {
        return Ok(invalid(
            ConsequentialActionVerificationReason::SourceChanged,
        ));
    }
    let mut card =
        serde_json::to_value(&request.decision_card_request).map_err(|error| error.to_string())?;
    let mut ledger =
        serde_json::to_value(&request.current_ledger).map_err(|error| error.to_string())?;
    for atom in request.plan.action.atoms().iter().rev() {
        if let Err(reason) = reverse_action_in_value(
            atom,
            &mut card,
            &mut ledger,
            &request.plan.source.manual_payee_bindings,
        ) {
            return Ok(invalid(reason));
        }
    }
    restore_empty_coverage_transitions(
        &mut card,
        request.plan.source.accounts_coverage_before,
        request.plan.source.transactions_coverage_before,
    );
    let restored_card: DecisionCardRequest = match serde_json::from_value(card.clone()) {
        Ok(value) => value,
        Err(_) => {
            return Ok(invalid(
                ConsequentialActionVerificationReason::SourceChanged,
            ))
        }
    };
    let restored_ledger: ConsequentialActionLedger = match serde_json::from_value(ledger.clone()) {
        Ok(value) => value,
        Err(_) => {
            return Ok(invalid(
                ConsequentialActionVerificationReason::SourceChanged,
            ))
        }
    };
    let evaluated_at = restored_card.context.evaluated_at.clone();
    let supplemental_observations = request
        .plan
        .source
        .invalidated_supplemental_facts
        .iter()
        .map(|facts| ConsequentialActionSupplementalObservation {
            account_id: facts.account_id.clone(),
            fields: facts.fields.clone(),
            flow_ids: facts.flow_ids.clone(),
            obligation_ids: facts.obligation_ids.clone(),
        })
        .collect();
    let mut restored = PlanConsequentialActionRequest {
        decision_card_request: restored_card,
        intent: request.plan.action.clone(),
        current_ledger: restored_ledger,
        resolved_evidence: request.resolved_evidence.clone(),
        financial_policy_version: request.plan.source.financial_policy_version.clone(),
        evaluated_at,
        idempotency_key: request.plan.idempotency_key.clone(),
        supplemental_observations,
    };
    let expected_dispatch_preconditions = match dispatch_preconditions_from_ledger(
        &restored.current_ledger,
        &request.plan.action.atoms(),
    ) {
        Ok(preconditions) => preconditions,
        Err(_) => return Ok(invalid(ConsequentialActionVerificationReason::InvalidPlan)),
    };
    if expected_dispatch_preconditions != request.plan.dispatch_preconditions {
        return Ok(invalid(ConsequentialActionVerificationReason::InvalidPlan));
    }
    let invalidated_freshness_accounts = request.plan.source.invalidated_freshness_accounts.clone();
    let mut source_hash_material = SourceHashMaterial {
        decision_card_request: &restored.decision_card_request,
        action: &restored.intent,
        ledger: &restored.current_ledger,
        evidence: &restored.resolved_evidence,
        financial_policy_version: &restored.financial_policy_version,
        idempotency_key: &restored.idempotency_key,
        invalidated_freshness_accounts: &invalidated_freshness_accounts,
        invalidated_supplemental_facts: &request.plan.source.invalidated_supplemental_facts,
        manual_payee_bindings: &request.plan.source.manual_payee_bindings,
    };
    if hash_material(&source_hash_material, true)? != request.plan.source.invariants_hash {
        let snapshot = &restored.decision_card_request.financial_snapshot;
        let creates_payee = request
            .plan
            .source
            .manual_payee_bindings
            .iter()
            .any(|binding| binding.existing_payee_id.is_none())
            || request.plan.action.atoms().iter().any(|atom| {
                matches!(
                    atom,
                    AtomicConsequentialActionIntent::WalletMaterialization { .. }
                )
            });
        if snapshot.coverage.payees != CoverageState::Complete
            || !snapshot.legacy_snapshot.payees.is_empty()
            || !creates_payee
        {
            return Ok(invalid(
                ConsequentialActionVerificationReason::SourceChanged,
            ));
        }
        // Restore first-payee coverage only when the exact approved source hash proves it.
        let mut empty_payee_card = restored.decision_card_request.clone();
        empty_payee_card.financial_snapshot.coverage.payees = CoverageState::Empty;
        source_hash_material.decision_card_request = &empty_payee_card;
        if hash_material(&source_hash_material, true)? != request.plan.source.invariants_hash {
            return Ok(invalid(
                ConsequentialActionVerificationReason::SourceChanged,
            ));
        }
        restored.decision_card_request = empty_payee_card;
    }
    // Replanning after this write would require a freshness attestation the source correctly invalidated.
    if invalidated_freshness_accounts.is_empty() {
        let replay_hashes = |replay: &PlanConsequentialActionRequest| -> Result<_, String> {
            let material = SourceHashMaterial {
                decision_card_request: &replay.decision_card_request,
                action: &replay.intent,
                ledger: &replay.current_ledger,
                evidence: &replay.resolved_evidence,
                financial_policy_version: &replay.financial_policy_version,
                idempotency_key: &replay.idempotency_key,
                invalidated_freshness_accounts: &invalidated_freshness_accounts,
                invalidated_supplemental_facts: &request.plan.source.invalidated_supplemental_facts,
                manual_payee_bindings: &request.plan.source.manual_payee_bindings,
            };
            Ok((
                hash_material(&material, false)?,
                hash_material(&material, true)?,
                evidence_material_hash(&replay.decision_card_request, &replay.resolved_evidence)?,
            ))
        };
        let before = replay_hashes(&restored)?;
        if rebase_actual_postcondition_capture(&mut restored).is_err()
            || replay_hashes(&restored)? != before
        {
            return Ok(invalid(
                ConsequentialActionVerificationReason::SourceChanged,
            ));
        }
        let expected = match build_plan(restored, false) {
            Ok(plan) => plan,
            Err(error) => return Ok(invalid(classify_source_error(&error))),
        };
        if expected.source.preconditions_hash != request.plan.source.preconditions_hash
            || expected.source.evidence_hash != request.plan.source.evidence_hash
            || expected.source.manual_payee_bindings != request.plan.source.manual_payee_bindings
            || expected.reason_codes != request.plan.reason_codes
            || expected.impacts != request.plan.impacts
            || expected.expected_postconditions != request.plan.expected_postconditions
            || expected.evidence_references != request.plan.evidence_references
            || expected.expires_at != request.plan.expires_at
        {
            return Ok(invalid(ConsequentialActionVerificationReason::InvalidPlan));
        }
    }
    Ok(ConsequentialActionVerification {
        valid: true,
        reason: None,
        action_hash: request.plan.action_hash,
    })
}

fn validate_postcondition_times(
    card: &DecisionCardRequest,
    verified_at: &str,
) -> Result<(), String> {
    let verified = parse_utc(verified_at).ok_or("invalid_evaluated_at")?;
    let snapshot = &card.financial_snapshot;
    if parse_utc(&snapshot.captured_at).is_none_or(|time| time > verified)
        || parse_utc(&card.context.evaluated_at).is_none_or(|time| time > verified)
    {
        return Err("invalid_or_future_observation_time".into());
    }
    validate_resolution_observations(snapshot, verified_at)?;
    let validate_fact = |evidence: &FactEvidence| -> Result<(), String> {
        if evidence
            .observed_at
            .as_deref()
            .is_some_and(|value| parse_utc(value).is_none_or(|time| time > verified))
        {
            return Err("invalid_or_future_observation_time".into());
        }
        Ok(())
    };
    if let Some(liquidity) = &snapshot.liquidity {
        for category in &liquidity.categories {
            validate_fact(&category.evidence)?;
        }
        for account in &liquidity.accounts {
            for evidence in [
                &account.currency_evidence,
                &account.kind_evidence,
                &account.ownership_evidence,
                &account.balance_evidence,
                &account.freshness_evidence,
                &account.activity_evidence,
                &account.schedule_evidence,
                &account.holds_evidence,
            ] {
                validate_fact(evidence)?;
            }
            if let Some(credit) = &account.credit {
                validate_fact(&credit.evidence)?;
            }
        }
    }
    for route in &card.liquidity_policy.transfer_routes {
        validate_fact(&route.evidence)?;
    }
    Ok(())
}

// Replay only capture metadata already excluded from exact source hashes; financial and human facts stay intact.
fn rebase_actual_postcondition_capture(
    request: &mut PlanConsequentialActionRequest,
) -> Result<(), String> {
    let historical = request.evaluated_at.clone();
    let snapshot = &mut request.decision_card_request.financial_snapshot;
    let captured = snapshot.captured_at.clone();
    if snapshot.source.ledger_backend != "actual" {
        return Ok(());
    }
    for observation in &mut snapshot.observations {
        let value = serde_json::to_value(&*observation).map_err(|error| error.to_string())?;
        if actual_generated_observation_clock(&value, &captured) {
            observation.observed_at = Some(historical.clone());
        }
    }
    let rebase_fact = |evidence: &mut FactEvidence| {
        if actual_fact_capture_clock(evidence, &captured) {
            evidence.observed_at = Some(historical.clone());
        }
    };
    if let Some(liquidity) = &mut snapshot.liquidity {
        for category in &mut liquidity.categories {
            rebase_fact(&mut category.evidence);
        }
        for account in &mut liquidity.accounts {
            for evidence in [
                &mut account.currency_evidence,
                &mut account.kind_evidence,
                &mut account.ownership_evidence,
                &mut account.balance_evidence,
                &mut account.freshness_evidence,
                &mut account.activity_evidence,
                &mut account.schedule_evidence,
                &mut account.holds_evidence,
            ] {
                rebase_fact(evidence);
            }
            if let Some(credit) = &mut account.credit {
                rebase_fact(&mut credit.evidence);
            }
        }
    }
    for route in &mut request
        .decision_card_request
        .liquidity_policy
        .transfer_routes
    {
        rebase_fact(&mut route.evidence);
    }
    if snapshot.legacy_snapshot.snapshot_date == captured {
        snapshot.legacy_snapshot.snapshot_date = historical.clone();
    }
    if snapshot.legacy_snapshot.actual_downloaded_at.as_deref() == Some(&captured) {
        snapshot.legacy_snapshot.actual_downloaded_at = Some(historical.clone());
    }
    snapshot.captured_at = historical;
    Ok(())
}

fn postcondition_freshness_invalidations_match(request: &VerifyConsequentialActionRequest) -> bool {
    let snapshot = &request.decision_card_request.financial_snapshot;
    let invalidated = &request.plan.source.invalidated_freshness_accounts;
    if invalidated.windows(2).any(|pair| pair[0] >= pair[1]) {
        return false;
    }
    let touched = action_accounts(&request.plan.action);
    invalidated.iter().all(|account_id| {
        touched.contains(account_id.as_str())
            && account_fact(snapshot, account_id).is_some_and(|account| {
                actual_unknown_fact(
                    &account.freshness_evidence,
                    snapshot,
                    "institution_freshness_not_exposed",
                )
            })
    })
}

fn actual_capture_evidence(evidence: &FactEvidence, snapshot: &FinancialSnapshot) -> bool {
    actual_fact_capture_clock(evidence, &snapshot.captured_at)
}
fn actual_fact_capture_clock(evidence: &FactEvidence, captured_at: &str) -> bool {
    evidence.source == FactSource::ActualLedger
        && evidence.observed_at.as_deref() == Some(captured_at)
        && evidence.expires_at.is_none()
}

// Actual unknown facts may omit observedAt when the source does not expose it.
fn actual_unknown_fact(
    evidence: &FactEvidence,
    snapshot: &FinancialSnapshot,
    reason: &str,
) -> bool {
    evidence.source == FactSource::ActualLedger
        && (evidence.observed_at.is_none()
            || evidence.observed_at.as_deref() == Some(snapshot.captured_at.as_str()))
        && evidence.expires_at.is_none()
        && evidence.state == FactState::Unknown
        && evidence.reasons == [reason]
}

fn postcondition_supplemental_invalidations_match(
    request: &VerifyConsequentialActionRequest,
) -> bool {
    let snapshot = &request.decision_card_request.financial_snapshot;
    let invalidated_accounts = &request.plan.source.invalidated_freshness_accounts;
    let invalidations = &request.plan.source.invalidated_supplemental_facts;
    if invalidations
        .iter()
        .map(|facts| facts.account_id.as_str())
        .collect::<Vec<_>>()
        != invalidated_accounts
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
    {
        return false;
    }
    for invalidation in invalidations {
        if invalidation
            .fields
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
            || invalidation.paths.windows(2).any(|pair| pair[0] >= pair[1])
            || invalidation
                .flow_ids
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
            || invalidation
                .obligation_ids
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
            || !invalidation
                .fields
                .contains(&ConsequentialActionSupplementalField::CurrentLedgerConfirmed)
            || !invalidation
                .paths
                .contains(&ConsequentialActionSupplementalFactPath::FreshnessEvidence)
        {
            return false;
        }
        let Some(account) = account_fact(snapshot, &invalidation.account_id) else {
            return false;
        };
        let Some(ledger_account) = request
            .current_ledger
            .accounts
            .iter()
            .find(|candidate| candidate.account_id == invalidation.account_id)
        else {
            return false;
        };
        let mut allowed_paths = BTreeSet::new();
        for field in &invalidation.fields {
            match field {
                ConsequentialActionSupplementalField::Currency => {
                    allowed_paths.extend([
                        ConsequentialActionSupplementalFactPath::Currency,
                        ConsequentialActionSupplementalFactPath::CurrencyEvidence,
                    ]);
                }
                ConsequentialActionSupplementalField::Kind => {
                    allowed_paths.extend([
                        ConsequentialActionSupplementalFactPath::Kind,
                        ConsequentialActionSupplementalFactPath::KindEvidence,
                    ]);
                }
                ConsequentialActionSupplementalField::Owned => {
                    allowed_paths.extend([
                        ConsequentialActionSupplementalFactPath::Owned,
                        ConsequentialActionSupplementalFactPath::OwnershipEvidence,
                    ]);
                }
                ConsequentialActionSupplementalField::CurrentLedgerConfirmed => {
                    allowed_paths
                        .insert(ConsequentialActionSupplementalFactPath::FreshnessEvidence);
                }
                ConsequentialActionSupplementalField::Holds => {
                    allowed_paths.extend([
                        ConsequentialActionSupplementalFactPath::Holds,
                        ConsequentialActionSupplementalFactPath::HoldsEvidence,
                    ]);
                }
                ConsequentialActionSupplementalField::UnsettledFlows => {
                    allowed_paths.insert(ConsequentialActionSupplementalFactPath::ActivityEvidence);
                }
                ConsequentialActionSupplementalField::Obligations => {
                    allowed_paths.insert(ConsequentialActionSupplementalFactPath::ScheduleEvidence);
                }
                ConsequentialActionSupplementalField::Credit => {
                    allowed_paths.insert(ConsequentialActionSupplementalFactPath::Credit);
                }
            }
        }
        if invalidation
            .paths
            .iter()
            .any(|path| !allowed_paths.contains(path))
            || (invalidation
                .fields
                .contains(&ConsequentialActionSupplementalField::Currency)
                && (!invalidation
                    .paths
                    .contains(&ConsequentialActionSupplementalFactPath::Currency)
                    || !invalidation
                        .paths
                        .contains(&ConsequentialActionSupplementalFactPath::CurrencyEvidence)))
            || (invalidation
                .fields
                .contains(&ConsequentialActionSupplementalField::Kind)
                && (!invalidation
                    .paths
                    .contains(&ConsequentialActionSupplementalFactPath::Kind)
                    || !invalidation
                        .paths
                        .contains(&ConsequentialActionSupplementalFactPath::KindEvidence)))
            || (invalidation
                .fields
                .contains(&ConsequentialActionSupplementalField::Owned)
                && (!invalidation
                    .paths
                    .contains(&ConsequentialActionSupplementalFactPath::Owned)
                    || !invalidation
                        .paths
                        .contains(&ConsequentialActionSupplementalFactPath::OwnershipEvidence)))
            || (invalidation
                .fields
                .contains(&ConsequentialActionSupplementalField::CurrentLedgerConfirmed)
                && !invalidation
                    .paths
                    .contains(&ConsequentialActionSupplementalFactPath::FreshnessEvidence))
            || (invalidation
                .fields
                .contains(&ConsequentialActionSupplementalField::Holds)
                && (!invalidation
                    .paths
                    .contains(&ConsequentialActionSupplementalFactPath::Holds)
                    || !invalidation
                        .paths
                        .contains(&ConsequentialActionSupplementalFactPath::HoldsEvidence)))
            || (!invalidation
                .fields
                .contains(&ConsequentialActionSupplementalField::UnsettledFlows)
                && !invalidation.flow_ids.is_empty())
            || (!invalidation
                .fields
                .contains(&ConsequentialActionSupplementalField::Obligations)
                && !invalidation.obligation_ids.is_empty())
        {
            return false;
        }
        for path in &invalidation.paths {
            let valid = match path {
                ConsequentialActionSupplementalFactPath::Currency => {
                    account.currency == ledger_account.currency
                }
                ConsequentialActionSupplementalFactPath::CurrencyEvidence => actual_unknown_fact(
                    &account.currency_evidence,
                    snapshot,
                    "account_currency_not_exposed",
                ),
                ConsequentialActionSupplementalFactPath::Kind => {
                    serde_json::to_value(account.kind).ok() == Some(json!("unknown"))
                }
                ConsequentialActionSupplementalFactPath::KindEvidence => actual_unknown_fact(
                    &account.kind_evidence,
                    snapshot,
                    "account_type_not_exposed",
                ),
                ConsequentialActionSupplementalFactPath::Owned => !account.owned,
                ConsequentialActionSupplementalFactPath::OwnershipEvidence => actual_unknown_fact(
                    &account.ownership_evidence,
                    snapshot,
                    "account_ownership_not_exposed",
                ),
                ConsequentialActionSupplementalFactPath::FreshnessEvidence => actual_unknown_fact(
                    &account.freshness_evidence,
                    snapshot,
                    "institution_freshness_not_exposed",
                ),
                ConsequentialActionSupplementalFactPath::Holds => {
                    account.holds.minor_units() == 0 && account.holds.currency() == account.currency
                }
                ConsequentialActionSupplementalFactPath::HoldsEvidence => actual_unknown_fact(
                    &account.holds_evidence,
                    snapshot,
                    "institution_holds_not_exposed",
                ),
                ConsequentialActionSupplementalFactPath::ActivityEvidence => {
                    actual_capture_evidence(&account.activity_evidence, snapshot)
                }
                ConsequentialActionSupplementalFactPath::ScheduleEvidence => {
                    actual_capture_evidence(&account.schedule_evidence, snapshot)
                }
                ConsequentialActionSupplementalFactPath::Credit => account.credit.is_none(),
            };
            if !valid {
                return false;
            }
        }
        if invalidation
            .flow_ids
            .iter()
            .any(|id| account.unsettled_flows.iter().any(|flow| flow.id == *id))
            || invalidation.obligation_ids.iter().any(|id| {
                account
                    .obligations
                    .iter()
                    .any(|obligation| obligation.id == *id)
            })
        {
            return false;
        }
    }
    true
}

fn request_to_plan_request(
    request: &VerifyConsequentialActionRequest,
    intent: ConsequentialActionIntent,
    policy_version: String,
) -> PlanConsequentialActionRequest {
    PlanConsequentialActionRequest {
        decision_card_request: request.decision_card_request.clone(),
        intent,
        current_ledger: request.current_ledger.clone(),
        resolved_evidence: request.resolved_evidence.clone(),
        financial_policy_version: policy_version,
        evaluated_at: request.evaluated_at.clone(),
        idempotency_key: request.plan.idempotency_key.clone(),
        supplemental_observations: request
            .plan
            .source
            .invalidated_supplemental_facts
            .iter()
            .map(|facts| ConsequentialActionSupplementalObservation {
                account_id: facts.account_id.clone(),
                fields: facts.fields.clone(),
                flow_ids: facts.flow_ids.clone(),
                obligation_ids: facts.obligation_ids.clone(),
            })
            .collect(),
    }
}

fn classify_source_error(error: &str) -> ConsequentialActionVerificationReason {
    if error.starts_with("evidence_")
        || error.contains("resolution_observation")
        || error.contains("economic_event_resolution")
        || error.contains("economic_event_ledger_effect")
        || error.contains("projection_source_effect")
        || error.contains("projection_evidence")
        || error.contains("decision_card_evidence")
    {
        ConsequentialActionVerificationReason::EvidenceChanged
    } else if error.contains("policy") || error.contains("source_identity") {
        ConsequentialActionVerificationReason::PolicyChanged
    } else if error.contains("claim") {
        ConsequentialActionVerificationReason::ClaimsChanged
    } else {
        ConsequentialActionVerificationReason::SourceChanged
    }
}

fn evidence_material_changed(request: &VerifyConsequentialActionRequest) -> bool {
    evidence_material_hash(&request.decision_card_request, &request.resolved_evidence)
        .map_or(true, |hash| hash != request.plan.source.evidence_hash)
}

fn targets_changed(request: &VerifyConsequentialActionRequest) -> bool {
    let atoms = request.plan.action.atoms();
    // Expected postconditions are cumulative; undo ordered movements to compare source targets.
    let mut expected_before = BTreeMap::new();
    for condition in &request.plan.expected_postconditions {
        if let ConsequentialActionPostcondition::Assignment {
            category_id,
            as_of_month,
            amount,
        } = condition
        {
            if expected_before
                .insert(
                    (category_id.as_str(), as_of_month.as_str()),
                    amount.minor_units(),
                )
                .is_some()
            {
                return true;
            }
        }
    }
    for atom in atoms.iter().rev() {
        if let AtomicConsequentialActionIntent::Reallocation { assignments } = atom {
            for movement in assignments.iter().rev() {
                let source_key = (
                    movement.source_category_id.as_str(),
                    movement.source_as_of_month.as_str(),
                );
                let destination_key = (
                    movement.destination_category_id.as_str(),
                    movement.destination_as_of_month.as_str(),
                );
                if source_key == destination_key {
                    return true;
                }
                let amount = movement.amount.minor_units();
                let Some(source) = expected_before.get_mut(&source_key) else {
                    return true;
                };
                let Some(source_before) = (*source).checked_add(amount) else {
                    return true;
                };
                *source = source_before;
                let Some(destination) = expected_before.get_mut(&destination_key) else {
                    return true;
                };
                let Some(destination_before) = (*destination).checked_sub(amount) else {
                    return true;
                };
                *destination = destination_before;
            }
        }
    }
    for atom in &atoms {
        if let AtomicConsequentialActionIntent::Reallocation { assignments } = atom {
            for movement in assignments {
                let source_key = (
                    movement.source_category_id.as_str(),
                    movement.source_as_of_month.as_str(),
                );
                let destination_key = (
                    movement.destination_category_id.as_str(),
                    movement.destination_as_of_month.as_str(),
                );
                let expected_source = expected_before.get(&source_key).copied();
                let expected_dest = expected_before.get(&destination_key).copied();
                let current_source = request
                    .current_ledger
                    .assignments
                    .iter()
                    .find(|assignment| {
                        assignment.category_id == movement.source_category_id
                            && assignment.as_of_month == movement.source_as_of_month
                    })
                    .map(|assignment| assignment.amount.minor_units());
                let current_dest = request
                    .current_ledger
                    .assignments
                    .iter()
                    .find(|assignment| {
                        assignment.category_id == movement.destination_category_id
                            && assignment.as_of_month == movement.destination_as_of_month
                    })
                    .map(|assignment| assignment.amount.minor_units());
                if current_source != expected_source || current_dest != expected_dest {
                    return true;
                }
            }
        }
    }
    false
}

fn plan_hash(plan: &ConsequentialActionPlan) -> Result<String, String> {
    let mut value = serde_json::to_value(plan).map_err(|error| error.to_string())?;
    value
        .as_object_mut()
        .ok_or("invalid_plan")?
        .remove("actionHash");
    hash_value(&value)
}

#[derive(Clone, Copy)]
struct SourceHashMaterial<'a> {
    decision_card_request: &'a DecisionCardRequest,
    action: &'a ConsequentialActionIntent,
    ledger: &'a ConsequentialActionLedger,
    evidence: &'a [ConsequentialActionEvidence],
    financial_policy_version: &'a str,
    idempotency_key: &'a str,
    invalidated_freshness_accounts: &'a [String],
    invalidated_supplemental_facts: &'a [ConsequentialActionInvalidatedSupplementalFacts],
    manual_payee_bindings: &'a [ConsequentialActionManualPayeeBinding],
}

fn hash_material(
    material: &SourceHashMaterial<'_>,
    normalize_invalidated_supplemental: bool,
) -> Result<String, String> {
    let SourceHashMaterial {
        decision_card_request,
        action,
        ledger,
        evidence,
        financial_policy_version,
        idempotency_key,
        invalidated_freshness_accounts,
        invalidated_supplemental_facts,
        manual_payee_bindings,
    } = *material;
    let mut card =
        serde_json::to_value(decision_card_request).map_err(|error| error.to_string())?;
    let captured_at = card["financialSnapshot"]["capturedAt"]
        .as_str()
        .ok_or("snapshot_capture_time_missing")?
        .to_owned();
    let is_actual_backend = card["financialSnapshot"]["source"]["ledgerBackend"] == "actual";
    if let Some(observations) = card["financialSnapshot"].get_mut("observations") {
        normalize_actual_generated_observation_clocks(
            observations,
            &captured_at,
            is_actual_backend,
        );
    }
    for path in [
        &["requestId"][..],
        &["correlationId"],
        &["decisionId"],
        &["financialSnapshot", "snapshotId"][..],
        &["financialSnapshot", "contentHash"],
        &["financialSnapshot", "capturedAt"],
        &["context", "snapshotId"],
        &["context", "contentHash"],
        &["context", "evaluatedAt"],
        &["financialSnapshot", "liquidity", "ledgerContentHash"],
        &["priorAllocation", "snapshotId"],
        &["priorAllocation", "contentHash"],
    ] {
        remove_path(&mut card, path);
    }
    if is_actual_backend {
        for path in [
            &["financialSnapshot", "legacySnapshot", "snapshotDate"][..],
            &["financialSnapshot", "legacySnapshot", "actualDownloadedAt"],
        ] {
            remove_path(&mut card, path);
        }
    }
    if let Some(snapshot) = card.get_mut("financialSnapshot") {
        normalize_actual_ledger_fact_clocks(snapshot);
    }
    normalize_actual_ledger_transfer_route_clocks(&mut card);
    if normalize_invalidated_supplemental {
        remove_invalidated_supplemental_facts(&mut card, invalidated_supplemental_facts);
    }
    let material = json!({
        "decisionCardRequest": card,
        "intent": action,
        "currentLedger": ledger,
        "resolvedEvidence": evidence,
        "financialPolicyVersion": financial_policy_version,
        "idempotencyKey": idempotency_key,
        "invalidatedFreshnessAccounts": invalidated_freshness_accounts,
        "invalidatedSupplementalFacts": invalidated_supplemental_facts,
        "manualPayeeBindings": manual_payee_bindings,
    });
    hash_value(&material)
}

fn normalize_actual_generated_observation_clocks(
    observations: &mut Value,
    captured_at: &str,
    actual_backend: bool,
) {
    if !actual_backend {
        return;
    }
    let Some(observations) = observations.as_array_mut() else {
        return;
    };
    for observation in observations {
        if actual_generated_observation_clock(observation, captured_at) {
            if let Some(object) = observation.as_object_mut() {
                object.remove("observedAt");
            }
        }
    }
}
fn actual_generated_observation_clock(observation: &Value, captured_at: &str) -> bool {
    let no_source_identity = observation.get("contentHash").is_none()
        && observation.get("version").is_none()
        && observation.get("ledgerEffect").is_none();
    let generated = match observation["kind"].as_str() {
        Some("account_collection_coverage" | "currency_compatibility") => {
            observation["scope"]["kind"] == "global"
                && observation["state"] == "complete"
                && observation["evidence"]
                    .as_array()
                    .is_some_and(Vec::is_empty)
        }
        Some("account_coverage" | "account_type" | "account_balance") => {
            let account_id = observation["scope"]["id"].as_str();
            observation["scope"]["kind"] == "account"
                && observation["state"] == "complete"
                && account_id.is_some_and(|id| !id.is_empty())
                && observation["evidence"]
                    .as_array()
                    .is_some_and(|references| {
                        references.len() == 1
                            && references[0]["evidenceId"].as_str() == account_id
                            && references[0]["kind"] == "account"
                            && references[0]["authorized"] == true
                            && references[0]["redaction"] == "visible"
                    })
        }
        Some("transfer_ambiguity") => {
            let transaction_id = observation["scope"]["id"].as_str();
            observation["scope"]["kind"] == "transaction"
                && observation["state"] == "ambiguous"
                && transaction_id.is_some_and(|id| !id.is_empty())
                && observation["evidence"]
                    .as_array()
                    .is_some_and(|references| {
                        references.len() == 1
                            && references[0]["evidenceId"].as_str() == transaction_id
                            && references[0]["kind"] == "transaction"
                            && references[0]["authorized"] == true
                            && references[0]["redaction"] == "visible"
                    })
        }
        Some("pending_activity" | "uncleared_activity") => {
            let account_id = observation["scope"]["id"].as_str();
            observation["scope"]["kind"] == "account"
                && observation["state"] == "included"
                && account_id.is_some_and(|id| !id.is_empty())
                && observation["evidence"]
                    .as_array()
                    .is_some_and(|references| {
                        references.len() == 1
                            && references[0]["evidenceId"]
                                .as_str()
                                .is_some_and(|id| !id.is_empty())
                            && references[0]["kind"] == "transaction"
                            && references[0]["authorized"] == true
                            && references[0]["redaction"] == "visible"
                    })
        }
        _ => false,
    };
    generated && no_source_identity && observation["observedAt"].as_str() == Some(captured_at)
}

fn normalize_actual_ledger_fact_clock(evidence: &mut Value) {
    if evidence.get("source").and_then(Value::as_str) == Some("actual_ledger") {
        if let Some(object) = evidence.as_object_mut() {
            object.remove("observedAt");
        }
    }
}

fn normalize_actual_ledger_fact_clocks(snapshot: &mut Value) {
    let Some(liquidity) = snapshot.get_mut("liquidity") else {
        return;
    };
    if let Some(categories) = liquidity
        .get_mut("categories")
        .and_then(Value::as_array_mut)
    {
        for category in categories {
            if let Some(evidence) = category.get_mut("evidence") {
                normalize_actual_ledger_fact_clock(evidence);
            }
        }
    }
    if let Some(accounts) = liquidity.get_mut("accounts").and_then(Value::as_array_mut) {
        for account in accounts {
            for field in [
                "currencyEvidence",
                "kindEvidence",
                "ownershipEvidence",
                "balanceEvidence",
                "freshnessEvidence",
                "activityEvidence",
                "scheduleEvidence",
                "holdsEvidence",
            ] {
                if let Some(evidence) = account.get_mut(field) {
                    normalize_actual_ledger_fact_clock(evidence);
                }
            }
            if let Some(evidence) = account
                .get_mut("credit")
                .and_then(|credit| credit.get_mut("evidence"))
            {
                normalize_actual_ledger_fact_clock(evidence);
            }
        }
    }
}

fn normalize_actual_ledger_transfer_route_clocks(request: &mut Value) {
    let Some(routes) = request
        .get_mut("liquidityPolicy")
        .and_then(|policy| policy.get_mut("transferRoutes"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for route in routes {
        if let Some(evidence) = route.get_mut("evidence") {
            normalize_actual_ledger_fact_clock(evidence);
        }
    }
}

fn remove_invalidated_supplemental_facts(
    card: &mut Value,
    invalidations: &[ConsequentialActionInvalidatedSupplementalFacts],
) {
    let Some(accounts) = card
        .get_mut("financialSnapshot")
        .and_then(|snapshot| snapshot.get_mut("liquidity"))
        .and_then(|liquidity| liquidity.get_mut("accounts"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for invalidation in invalidations {
        let Some(account) = accounts.iter_mut().find(|account| {
            account.get("accountId").and_then(Value::as_str) == Some(&invalidation.account_id)
        }) else {
            continue;
        };
        if let Some(object) = account.as_object_mut() {
            for path in &invalidation.paths {
                let field = match path {
                    ConsequentialActionSupplementalFactPath::Currency => "currency",
                    ConsequentialActionSupplementalFactPath::CurrencyEvidence => "currencyEvidence",
                    ConsequentialActionSupplementalFactPath::Kind => "kind",
                    ConsequentialActionSupplementalFactPath::KindEvidence => "kindEvidence",
                    ConsequentialActionSupplementalFactPath::Owned => "owned",
                    ConsequentialActionSupplementalFactPath::OwnershipEvidence => {
                        "ownershipEvidence"
                    }
                    ConsequentialActionSupplementalFactPath::FreshnessEvidence => {
                        "freshnessEvidence"
                    }
                    ConsequentialActionSupplementalFactPath::Holds => "holds",
                    ConsequentialActionSupplementalFactPath::HoldsEvidence => "holdsEvidence",
                    ConsequentialActionSupplementalFactPath::ActivityEvidence => "activityEvidence",
                    ConsequentialActionSupplementalFactPath::ScheduleEvidence => "scheduleEvidence",
                    ConsequentialActionSupplementalFactPath::Credit => "credit",
                };
                object.remove(field);
            }
            if let Some(flows) = object
                .get_mut("unsettledFlows")
                .and_then(Value::as_array_mut)
            {
                flows.retain(|flow| {
                    !invalidation
                        .flow_ids
                        .iter()
                        .any(|id| flow["id"].as_str() == Some(id))
                });
            }
            if let Some(obligations) = object.get_mut("obligations").and_then(Value::as_array_mut) {
                obligations.retain(|obligation| {
                    !invalidation
                        .obligation_ids
                        .iter()
                        .any(|id| obligation["id"].as_str() == Some(id))
                });
            }
        }
    }
}

fn fact_evidence_value(evidence: &FactEvidence) -> Value {
    let observed_at = if evidence.source == FactSource::ActualLedger {
        None
    } else {
        evidence.observed_at.as_deref()
    };
    json!({
        "state": evidence.state,
        "source": evidence.source,
        "observedAt": observed_at,
        "expiresAt": evidence.expires_at,
        "reasons": evidence.reasons,
    })
}

fn evidence_material_hash(
    decision_card_request: &DecisionCardRequest,
    resolved_evidence: &[ConsequentialActionEvidence],
) -> Result<String, String> {
    let mut observations =
        serde_json::to_value(&decision_card_request.financial_snapshot.observations)
            .map_err(|error| error.to_string())?;
    normalize_actual_generated_observation_clocks(
        &mut observations,
        &decision_card_request.financial_snapshot.captured_at,
        decision_card_request
            .financial_snapshot
            .source
            .ledger_backend
            == "actual",
    );
    let facts = decision_card_request
        .financial_snapshot
        .liquidity
        .as_ref()
        .map(|facts| {
            json!({
                "categories": facts.categories.iter().map(|category| json!({
                    "categoryId": category.category_id,
                    "evidence": fact_evidence_value(&category.evidence),
                })).collect::<Vec<_>>(),
                "accounts": facts.accounts.iter().map(|account| json!({
                    "accountId": account.account_id,
                    "currencyEvidence": fact_evidence_value(&account.currency_evidence),
                    "kindEvidence": fact_evidence_value(&account.kind_evidence),
                    "ownershipEvidence": fact_evidence_value(&account.ownership_evidence),
                    "balanceEvidence": fact_evidence_value(&account.balance_evidence),
                    "freshnessEvidence": fact_evidence_value(&account.freshness_evidence),
                    "activityEvidence": fact_evidence_value(&account.activity_evidence),
                    "scheduleEvidence": fact_evidence_value(&account.schedule_evidence),
                    "holdsEvidence": fact_evidence_value(&account.holds_evidence),
                    "creditEvidence": account.credit.as_ref()
                        .map(|credit| fact_evidence_value(&credit.evidence)),
                })).collect::<Vec<_>>(),
            })
        });
    let route_evidence = decision_card_request
        .liquidity_policy
        .transfer_routes
        .iter()
        .map(|route| {
            json!({
                "routeId": route.id,
                "evidence": fact_evidence_value(&route.evidence),
            })
        })
        .collect::<Vec<_>>();
    hash_value(&json!({
        "observations": observations,
        "liquidityFactEvidence": facts,
        "transferRouteEvidence": route_evidence,
        "resolvedEvidence": resolved_evidence,
    }))
}

fn remove_path(value: &mut Value, path: &[&str]) {
    let mut current = value;
    for key in &path[..path.len().saturating_sub(1)] {
        let Some(next) = current.get_mut(*key) else {
            return;
        };
        current = next;
    }
    if let (Some(parent), Some(last)) = (current.as_object_mut(), path.last()) {
        parent.remove(*last);
    }
}

fn hash_value(value: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn manual_payee_name(transaction: &ManualTransactionIntent) -> Option<&str> {
    transaction
        .payee_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

fn manual_row_matches(row: &Value, transaction: &ManualTransactionIntent) -> bool {
    row["parentId"] == transaction.parent_id
        && row["accountId"] == transaction.account_id
        && row["amount"] == serde_json::to_value(&transaction.amount).unwrap_or(Value::Null)
        && row["date"] == transaction.date
        && row["categoryId"]
            == serde_json::to_value(&transaction.category_id).unwrap_or(Value::Null)
        && row["payeeName"]
            == serde_json::to_value(manual_payee_name(transaction)).unwrap_or(Value::Null)
        && row["notes"] == serde_json::to_value(&transaction.notes).unwrap_or(Value::Null)
        && row["splits"] == serde_json::to_value(&transaction.splits).unwrap_or(Value::Null)
        && row["transferAccountId"].is_null()
}

fn transaction_category_deltas(transaction: &ManualTransactionIntent) -> Vec<(&str, i64)> {
    if transaction.splits.is_empty() {
        transaction
            .category_id
            .as_deref()
            .map(|category| vec![(category, transaction.amount.minor_units())])
            .unwrap_or_default()
    } else {
        transaction
            .splits
            .iter()
            .map(|split| (split.category_id.as_str(), split.amount.minor_units()))
            .collect()
    }
}

fn unique_row_index(rows: &[Value], predicate: impl Fn(&Value) -> bool) -> Result<usize, String> {
    let mut matches = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| predicate(row))
        .map(|(index, _)| index);
    let index = matches.next().ok_or("postcondition_row_missing")?;
    if matches.next().is_some() {
        return Err("postcondition_row_duplicate".into());
    }
    Ok(index)
}

fn checked_add(left: i64, right: i64) -> Result<i64, String> {
    left.checked_add(right)
        .ok_or_else(|| "money_arithmetic_overflow".into())
}
fn checked_sub(left: i64, right: i64) -> Result<i64, String> {
    left.checked_sub(right)
        .ok_or_else(|| "money_arithmetic_overflow".into())
}

fn valid_currency(value: &str) -> bool {
    value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase())
}
fn valid_month(value: &str) -> bool {
    let Some((year, month)) = value.split_once('-') else {
        return false;
    };
    year.len() == 4
        && year.bytes().all(|byte| byte.is_ascii_digit())
        && month.len() == 2
        && month
            .parse::<u8>()
            .is_ok_and(|month| (1..=12).contains(&month))
}

fn valid_date(value: &str) -> bool {
    if value.len() != 10
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || !value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 4 | 7) {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
    {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (
        value[..4].parse::<i32>().ok(),
        value[5..7].parse::<u32>().ok(),
        value[8..].parse::<u32>().ok(),
    ) else {
        return false;
    };
    calendar_date_valid(year, month, day)
}

fn parse_utc(value: &str) -> Option<i128> {
    let (date, clock) = value.strip_suffix('Z')?.split_once('T')?;
    if !valid_date(date) {
        return None;
    }
    let (time, fraction) = clock
        .split_once('.')
        .map_or((clock, ""), |(time, fraction)| (time, fraction));
    let time_bytes = time.as_bytes();
    if time_bytes.len() != 8
        || time_bytes[2] != b':'
        || time_bytes[5] != b':'
        || !time_bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 2 | 5) {
                *byte == b':'
            } else {
                byte.is_ascii_digit()
            }
        })
        || (clock.len() > time.len() && fraction.is_empty())
        || fraction.len() > 9
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let hour = time[..2].parse::<u32>().ok()?;
    let minute = time[3..5].parse::<u32>().ok()?;
    let second = time[6..8].parse::<u32>().ok()?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let year = date[..4].parse::<i64>().ok()?;
    let month = date[5..7].parse::<i64>().ok()?;
    let day = date[8..].parse::<i64>().ok()?;
    let days = days_from_civil(year, month, day);
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hour * 3600 + minute * 60 + second))?;
    let mut nanos = 0_i64;
    let mut digits = 0;
    for byte in fraction.bytes() {
        nanos = nanos * 10 + i64::from(byte - b'0');
        digits += 1;
    }
    while digits < 9 {
        nanos *= 10;
        digits += 1;
    }
    Some(i128::from(seconds) * 1_000_000_000 + i128::from(nanos))
}

fn calendar_date_valid(year: i32, month: u32, day: u32) -> bool {
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    day > 0 && day <= days
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}

#[cfg(test)]
mod temporal_debit_tests {
    use super::matches_positive_debit;
    use balanceframe_financial_core::Money;

    #[test]
    fn retiming_matches_only_exact_checked_positive_debits() {
        for (purchase, debit, matches) in [
            (1, -1, true),
            (i64::MAX, -i64::MAX, true),
            (2, -1, false),
            (0, 0, false),
            (-1, 1, false),
            (i64::MIN, i64::MIN, false),
            (i64::MAX, i64::MIN, false),
        ] {
            assert_eq!(
                matches_positive_debit(&Money::new(purchase, "USD"), &Money::new(debit, "USD")),
                matches,
                "purchase={purchase}, debit={debit}"
            );
        }
        assert!(!matches_positive_debit(
            &Money::new(1, "EUR"),
            &Money::new(-1, "USD")
        ));
    }
    #[test]
    fn transfer_ambiguity_capture_clock_preserves_source_identity_and_authority() {
        let captured = "2026-09-06T10:00:00Z";
        let observation = serde_json::json!({
            "kind":"transfer_ambiguity","scope":{"kind":"transaction","id":"transfer"},
            "state":"ambiguous","observedAt":captured,
            "evidence":[{"evidenceId":"transfer","kind":"transaction","authorized":true,"redaction":"visible"}]
        });
        let mut generated = serde_json::json!([observation.clone()]);
        super::normalize_actual_generated_observation_clocks(&mut generated, captured, true);
        assert!(generated[0].get("observedAt").is_none());
        let mut expected = observation.clone();
        expected.as_object_mut().unwrap().remove("observedAt");
        assert_eq!(generated[0], expected);
        for (field, value) in [
            ("observedAt", serde_json::json!("2026-09-06T09:30:00Z")),
            ("state", serde_json::json!("missing")),
            ("contentHash", serde_json::json!("changed")),
            ("version", serde_json::json!("v2")),
            (
                "scope",
                serde_json::json!({"kind":"transaction","id":"other"}),
            ),
            (
                "evidence",
                serde_json::json!([{"evidenceId":"other","kind":"transaction","authorized":true,"redaction":"visible"}]),
            ),
            (
                "evidence",
                serde_json::json!([{"evidenceId":"transfer","kind":"transaction","authorized":false,"redaction":"visible"}]),
            ),
            (
                "evidence",
                serde_json::json!([{"evidenceId":"transfer","kind":"transaction","authorized":true,"redaction":"redacted"}]),
            ),
        ] {
            let mut source = observation.clone();
            source[field] = value;
            let mut normalized = serde_json::json!([source.clone()]);
            super::normalize_actual_generated_observation_clocks(&mut normalized, captured, true);
            assert_eq!(normalized[0], source);
        }
        let mut external = serde_json::json!([observation.clone()]);
        super::normalize_actual_generated_observation_clocks(&mut external, captured, false);
        assert_eq!(external[0], observation);
    }
}
