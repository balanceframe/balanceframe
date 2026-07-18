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
