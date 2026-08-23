//! Shared vocabulary for explaining prospective financial decisions.

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// A stable machine-readable classification for an issue affecting a decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecisionIssueCode {
    /// Account observations are missing or too stale for the required coverage.
    AccountFreshnessCoverage,
    /// Pending funds do not have sufficiently certain availability.
    PendingAvailability,
    /// Scheduled financial activity is not covered sufficiently.
    ScheduleCoverage,
    /// Multiple transfers may represent the same economic movement.
    DuplicateTransferAmbiguity,
    /// A credit payment cannot be resolved with sufficient certainty.
    CreditPaymentUncertainty,
    /// A reservation conflicts with another financial commitment.
    ReservationConflict,
    /// A wallet balance cannot be established with sufficient certainty.
    WalletBalanceUncertainty,
    /// A receipt total does not match its linked financial record.
    ReceiptTotalMismatch,
    /// Records cannot be resolved to one unambiguous economic event.
    EconomicEventAmbiguity,
    /// Values use currencies that cannot be compared directly.
    CurrencyMismatch,
    /// An issue code not recognized by this version of the vocabulary.
    Unknown(String),
}

impl DecisionIssueCode {
    fn as_str(&self) -> &str {
        match self {
            Self::AccountFreshnessCoverage => "account_freshness_coverage",
            Self::PendingAvailability => "pending_availability",
            Self::ScheduleCoverage => "schedule_coverage",
            Self::DuplicateTransferAmbiguity => "duplicate_transfer_ambiguity",
            Self::CreditPaymentUncertainty => "credit_payment_uncertainty",
            Self::ReservationConflict => "reservation_conflict",
            Self::WalletBalanceUncertainty => "wallet_balance_uncertainty",
            Self::ReceiptTotalMismatch => "receipt_total_mismatch",
            Self::EconomicEventAmbiguity => "economic_event_ambiguity",
            Self::CurrencyMismatch => "currency_mismatch",
            Self::Unknown(code) => code,
        }
    }

    fn known(code: &str) -> Option<Self> {
        match code {
            "account_freshness_coverage" => Some(Self::AccountFreshnessCoverage),
            "pending_availability" => Some(Self::PendingAvailability),
            "schedule_coverage" => Some(Self::ScheduleCoverage),
            "duplicate_transfer_ambiguity" => Some(Self::DuplicateTransferAmbiguity),
            "credit_payment_uncertainty" => Some(Self::CreditPaymentUncertainty),
            "reservation_conflict" => Some(Self::ReservationConflict),
            "wallet_balance_uncertainty" => Some(Self::WalletBalanceUncertainty),
            "receipt_total_mismatch" => Some(Self::ReceiptTotalMismatch),
            "economic_event_ambiguity" => Some(Self::EconomicEventAmbiguity),
            "currency_mismatch" => Some(Self::CurrencyMismatch),
            _ => None,
        }
    }
}

impl Serialize for DecisionIssueCode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for DecisionIssueCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct DecisionIssueCodeVisitor;

        impl<'de> Visitor<'de> for DecisionIssueCodeVisitor {
            type Value = DecisionIssueCode;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a decision issue code string")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DecisionIssueCode::known(value)
                    .unwrap_or_else(|| DecisionIssueCode::Unknown(value.to_owned())))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DecisionIssueCode::known(&value).unwrap_or(DecisionIssueCode::Unknown(value)))
            }
        }

        deserializer.deserialize_string(DecisionIssueCodeVisitor)
    }
}

/// The significance of an issue independent of its decision effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionIssueSeverity {
    /// Informational context that does not indicate immediate concern.
    Info,
    /// A condition that warrants caution.
    Warning,
    /// A safety-sensitive or otherwise critical condition.
    Critical,
}

/// How an issue affects the ability to reach a decision conclusion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionIssueEffect {
    /// The issue qualifies the conclusion without preventing it.
    Qualifies,
    /// The issue prevents a conclusion.
    Blocks,
}

/// The domain entity to which a decision issue applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum DecisionScope {
    /// The issue applies to the decision as a whole.
    Global,
    /// The issue applies to the account with the supplied identifier.
    Account(String),
    /// The issue applies to the category with the supplied identifier.
    Category(String),
    /// The issue applies to the transaction with the supplied identifier.
    Transaction(String),
    /// The issue applies to the schedule with the supplied identifier.
    Schedule(String),
    /// The issue applies to the claim with the supplied identifier.
    Claim(String),
}

/// Whether authorized output may expose a referenced value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RedactionState {
    /// The value may be included in authorized output.
    Visible,
    /// The value must remain redacted from output.
    Redacted,
}

/// A typed reference to evidence supporting a decision issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReference {
    /// Stable identifier of the referenced evidence.
    pub evidence_id: String,
    /// Machine-readable kind of the referenced evidence.
    pub kind: String,
    /// Whether the decision actor is authorized to use the evidence.
    pub authorized: bool,
    /// Whether the evidence may be exposed in authorized output.
    pub redaction: RedactionState,
}

/// A concrete action that can resolve or reduce a decision issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remediation {
    /// Stable machine-readable remediation code.
    pub code: String,
    /// Human-readable action to take.
    pub action: String,
}

/// A structured issue that affects a prospective financial decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionIssue {
    /// Stable machine-readable issue classification.
    pub code: DecisionIssueCode,
    /// Significance of the issue.
    pub severity: DecisionIssueSeverity,
    /// Declared effect on the decision conclusion.
    pub effect: DecisionIssueEffect,
    /// Entity or domain area affected by the issue.
    pub scope: DecisionScope,
    /// Evidence references supporting the issue.
    pub evidence: Vec<EvidenceReference>,
    /// Optional action that can resolve or reduce the issue.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<Remediation>,
    /// Whether the issue itself may be exposed in authorized output.
    pub redaction: RedactionState,
}

impl DecisionIssue {
    /// Returns whether this issue prevents a decision conclusion.
    ///
    /// Unknown issue codes fail closed even when their declared effect only
    /// qualifies a conclusion.
    pub fn blocks_conclusion(&self) -> bool {
        matches!(self.code, DecisionIssueCode::Unknown(_))
            || self.effect == DecisionIssueEffect::Blocks
    }
}
