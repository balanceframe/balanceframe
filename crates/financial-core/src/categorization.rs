use serde::{Deserialize, Serialize};

use crate::money::Money;
use crate::snapshots::{Payee, Transaction};
use crate::merchant::normalize_merchant;

// ---------------------------------------------------------------------------
// HistoryRecord
// ---------------------------------------------------------------------------

/// A historical record of a past categorization decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub transaction_id: String,
    pub payee_name: String,
    pub category_id: String,
    pub category_name: String,
    pub amount: Money,
    pub date: String,
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum EvidenceKind {
    ExactPayee,
    Historical,
    AmountPattern,
    ImportMatch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub kind: EvidenceKind,
    pub details: String,
}

impl Evidence {
    pub fn new(kind: EvidenceKind, details: impl Into<String>) -> Self {
        Evidence {
            kind,
            details: details.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// CategorizationCandidate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorizationCandidate {
    pub transaction_id: String,
    pub amount: Money,
    pub payee_name: Option<String>,
    pub date: String,
    pub reasons: Vec<Evidence>,
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

/// Attempt to match a transaction to a known payee.  If the payee is found,
/// the returned candidate carries the payee id as context and marks the
/// evidence as `ExactPayee`.
pub fn classify_exact_match(
    tx: &Transaction,
    payees: &[Payee],
) -> Option<CategorizationCandidate> {
    let tx_normalized = normalize_merchant(tx.payee_name.as_deref().unwrap_or(""));
    if tx_normalized.is_empty() {
        return None;
    }

    let matched = payees.iter().find(|p| {
        normalize_merchant(&p.name) == tx_normalized
    })?;

    // Build a candidate referencing the matched payee
    Some(CategorizationCandidate {
        transaction_id: tx.id.clone(),
        amount: tx.amount.clone(),
        payee_name: tx.payee_name.clone(),
        date: tx.date.clone(),
        reasons: vec![Evidence::new(
            EvidenceKind::ExactPayee,
            format!("Payee '{}' (id={})", matched.name, matched.id),
        )],
    })
}

/// Attempt to match a transaction against historical categorization records.
/// Uses normalized merchant name comparison.
pub fn classify_historical(
    tx: &Transaction,
    history: &[HistoryRecord],
) -> Option<CategorizationCandidate> {
    let tx_normalized = normalize_merchant(tx.payee_name.as_deref().unwrap_or(""));
    if tx_normalized.is_empty() {
        return None;
    }

    // Find the most recent history record with the same normalized payee
    let matched = history
        .iter()
        .filter(|hr| normalize_merchant(&hr.payee_name) == tx_normalized)
        .max_by(|a, b| a.date.cmp(&b.date))?;

    Some(CategorizationCandidate {
        transaction_id: tx.id.clone(),
        amount: tx.amount.clone(),
        payee_name: tx.payee_name.clone(),
        date: tx.date.clone(),
        reasons: vec![Evidence::new(
            EvidenceKind::Historical,
            format!(
                "Previously categorized as '{}' (id={}) on {}",
                matched.category_name, matched.category_id, matched.date
            ),
        )],
    })
}

// ---------------------------------------------------------------------------
// Composite finder
// ---------------------------------------------------------------------------

/// Run all categorization classifiers in priority order and return the
/// strongest match per transaction.  Exact-payee matches take precedence
/// over historical matches.
pub fn find_candidates(
    transactions: &[Transaction],
    payees: &[Payee],
    history: &[HistoryRecord],
) -> Vec<CategorizationCandidate> {
    let mut candidates: Vec<CategorizationCandidate> = Vec::new();

    for tx in transactions {
        // Skip transactions that already have a category
        if tx.category_id.is_some() && tx.category_id.as_deref() != Some("") {
            continue;
        }

        // Exact payee match first
        if let Some(c) = classify_exact_match(tx, payees) {
            candidates.push(c);
            continue;
        }

        // Historical match second
        if let Some(c) = classify_historical(tx, history) {
            candidates.push(c);
        }
    }

    candidates
}

// ---------------------------------------------------------------------------
// CandidateStatus
// ---------------------------------------------------------------------------

/// Whether a categorization candidate has been fully resolved by deterministic
/// layers (Rust classifiers) or remains unresolved and eligible for provider
/// inference (TypeScript).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CandidateStatus {
    /// Candidate has sufficient deterministic evidence — no inference needed.
    Resolved,
    /// Candidate lacks deterministic resolution — eligible for TS provider inference.
    Unresolved,
}

impl CategorizationCandidate {
    /// Returns whether this candidate's strongest evidence resolves it
    /// deterministically.  Only [`Unresolved`](CandidateStatus::Unresolved)
    /// candidates qualify for TypeScript provider inference.
    pub fn eligibility(&self) -> CandidateStatus {
        let strongest = self.reasons.first();
        match strongest {
            None => CandidateStatus::Unresolved,
            Some(e) => match e.kind {
                EvidenceKind::ExactPayee | EvidenceKind::Historical => {
                    CandidateStatus::Resolved
                }
                EvidenceKind::AmountPattern | EvidenceKind::ImportMatch => {
                    CandidateStatus::Unresolved
                }
            },
        }
    }
}

// ---------------------------------------------------------------------------
// InferencePolicy
// ---------------------------------------------------------------------------

/// Privacy and locality policy for inference providers.
///
/// Controls which providers may be used for each capability
/// (classification, merchant research, conversation, telemetry).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum InferencePolicy {
    /// Capability is disabled entirely; no provider calls are allowed.
    #[serde(rename = "disabled")]
    Disabled,
    /// Only local (on-device / same-process) providers are allowed.
    #[serde(rename = "localOnly")]
    LocalOnly,
    /// External / remote providers are also allowed.
    #[serde(rename = "externalAllowed")]
    ExternalAllowed,
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/// Provenance metadata attached to a suggestion, recording origin,
/// integrity, and version chain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// Hash of the suggestion payload for integrity verification.
    pub payload_hash: String,
    /// Inference provider identifier (e.g. "openai", "local").
    pub provider: Option<String>,
    /// Model identifier used for inference.
    pub model: Option<String>,
    /// Version of the prompt template used.
    pub prompt_version: Option<String>,
    /// Version of the inference policy document at time of creation.
    pub inference_policy_version: Option<String>,
    /// ISO-8601 timestamp of suggestion creation.
    pub created_at: String,
    /// Identifier of the originating actor (user or system).
    pub actor_id: Option<String>,
}
