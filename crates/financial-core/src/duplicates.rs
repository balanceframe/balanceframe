//! Duplicate evidence detection for transactions.

use serde::{Deserialize, Serialize};

use crate::merchant::normalize_merchant;
// use crate::money::Money;
use crate::snapshots::Transaction;

// ---------------------------------------------------------------------------
// DuplicateEvidence
// ---------------------------------------------------------------------------

/// Structured evidence that a transaction may be a duplicate of another.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateEvidence {
    /// Id of the transaction being reported.
    pub transaction_id: String,
    /// Id of the transaction it may duplicate.
    pub duplicate_of: String,
    /// The strategy that matched (e.g. `"exact"`, `"amount_date"`,
    /// `"normalized_merchant_amount"`).
    pub match_reason: String,
    /// Human‑readable explanation.
    pub details: String,
}

// ---------------------------------------------------------------------------
// find_duplicates
// ---------------------------------------------------------------------------

/// Scan a list of transactions for potential duplicates using multiple
/// strategies:
///
/// 1. **Exact** — identical imported_id, payee_name (raw), amount (abs), and
///    date.
/// 2. **Amount+Date** — same absolute amount and date (ignoring payee).
/// 3. **Normalized merchant + amount** — same normalized merchant name and
///    absolute amount (ignoring date).
pub fn find_duplicates(transactions: &[Transaction]) -> Vec<DuplicateEvidence> {
    let mut evidence: Vec<DuplicateEvidence> = Vec::new();

    for i in 0..transactions.len() {
        let tx_a = &transactions[i];

        for tx_b in transactions.iter().skip(i + 1) {
            // --- 1. Exact match (imported_id) ---
            if let (Some(imp_a), Some(imp_b)) = (&tx_a.imported_id, &tx_b.imported_id) {
                if imp_a == imp_b {
                    let (tx_id, dupe_of) = canonical_pair(&tx_a.id, &tx_b.id);
                    evidence.push(DuplicateEvidence {
                        transaction_id: tx_id,
                        duplicate_of: dupe_of,
                        match_reason: "exact_imported_id".into(),
                        details: format!("Same imported_id '{}'", imp_a),
                    });
                    continue;
                }
            }

            // --- 2. Amount + Date (within ±1 day) ---
            if same_amount_abs(tx_a, tx_b) && dates_within_one_day(&tx_a.date, &tx_b.date) {
                let (tx_id, dupe_of) = canonical_pair(&tx_a.id, &tx_b.id);
                evidence.push(DuplicateEvidence {
                    transaction_id: tx_id,
                    duplicate_of: dupe_of,
                    match_reason: "amount_date".into(),
                    details: format!("Same amount {} and date window ±1d", tx_a.amount),
                });
                continue;
            }

            // --- 3. Normalized merchant + amount ---
            let norm_a = normalize_merchant(tx_a.payee_name.as_deref().unwrap_or(""));
            let norm_b = normalize_merchant(tx_b.payee_name.as_deref().unwrap_or(""));
            if !norm_a.is_empty() && norm_a == norm_b && same_amount_abs(tx_a, tx_b) {
                let (tx_id, dupe_of) = canonical_pair(&tx_a.id, &tx_b.id);
                evidence.push(DuplicateEvidence {
                    transaction_id: tx_id,
                    duplicate_of: dupe_of,
                    match_reason: "normalized_merchant_amount".into(),
                    details: format!(
                        "Same normalized merchant '{}' and amount {}",
                        norm_a, tx_a.amount
                    ),
                });
            }
        }
    }

    // Canonical sort for deterministic JSON output.
    evidence.sort_by(|a, b| {
        a.transaction_id
            .cmp(&b.transaction_id)
            .then_with(|| a.duplicate_of.cmp(&b.duplicate_of))
            .then_with(|| a.match_reason.cmp(&b.match_reason))
    });

    evidence
}

/// Compare absolute amounts, skipping pairs where either amount overflows
/// (e.g. i64::MIN). Returns `false` when computation is unsafe so that
/// i64::MIN amounts are never matched as duplicates.
fn same_amount_abs(a: &Transaction, b: &Transaction) -> bool {
    match (
        a.amount.minor_units().checked_abs(),
        b.amount.minor_units().checked_abs(),
    ) {
        (Some(a_abs), Some(b_abs)) => a_abs == b_abs,
        _ => false, // overflow — cannot safely compare
    }
}

/// Canonical pair orientation: the lexicographically greater ID becomes
/// `transaction_id` so that JSON output is deterministic regardless of
/// input ordering.
fn canonical_pair(a_id: &str, b_id: &str) -> (String, String) {
    if a_id > b_id {
        (a_id.to_string(), b_id.to_string())
    } else {
        (b_id.to_string(), a_id.to_string())
    }
}

/// Convert a `YYYY-MM-DD` date string to a day number relative to the
/// Unix epoch (1970-01-01 = day 0). Returns `None` for unparseable dates.
fn date_to_days(date: &str) -> Option<i64> {
    let y: i64 = date.get(..4)?.parse().ok()?;
    let m: i64 = date.get(5..7)?.parse().ok()?;
    let d: i64 = date.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Howard Hinnant's civil‑to‑days algorithm.
    let m_adj = if m <= 2 { m + 12 } else { m };
    let y_adj = if m <= 2 { y - 1 } else { y };
    let era = (if y_adj >= 0 { y_adj } else { y_adj - 399 }) / 400;
    let yoe = y_adj - era * 400; // [0, 399]
    let doy = (153 * (m_adj - 3) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    Some(era * 146097 + doe - 719468)
}

/// Check whether two `YYYY-MM-DD` dates are within one calendar day of
/// each other (inclusive of exact matches).
fn dates_within_one_day(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (date_to_days(a), date_to_days(b)) {
        (Some(da), Some(db)) => (da - db).abs() <= 1,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[cfg(test)]
mod tests;
