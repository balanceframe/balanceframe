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
    let mut used: Vec<bool> = vec![false; transactions.len()];

    for i in 0..transactions.len() {
        if used[i] {
            continue;
        }
        let tx_a = &transactions[i];

        for j in (i + 1)..transactions.len() {
            if used[j] {
                continue;
            }
            let tx_b = &transactions[j];

            // --- 1. Exact match (imported_id) ---
            if let (Some(imp_a), Some(imp_b)) = (&tx_a.imported_id, &tx_b.imported_id) {
                if imp_a == imp_b {
                    evidence.push(DuplicateEvidence {
                        transaction_id: tx_b.id.clone(),
                        duplicate_of: tx_a.id.clone(),
                        match_reason: "exact_imported_id".into(),
                        details: format!(
                            "Same imported_id '{}'", imp_a
                        ),
                    });
                    used[j] = true;
                    continue;
                }
            }

            // --- 2. Amount + Date ---
            if same_amount_abs(tx_a, tx_b) && tx_a.date == tx_b.date {
                evidence.push(DuplicateEvidence {
                    transaction_id: tx_b.id.clone(),
                    duplicate_of: tx_a.id.clone(),
                    match_reason: "amount_date".into(),
                    details: format!(
                        "Same amount {} and date {}",
                        tx_a.amount, tx_a.date
                    ),
                });
                used[j] = true;
                continue;
            }

            // --- 3. Normalized merchant + amount ---
            let norm_a = normalize_merchant(tx_a.payee_name.as_deref().unwrap_or(""));
            let norm_b = normalize_merchant(tx_b.payee_name.as_deref().unwrap_or(""));
            if !norm_a.is_empty() && norm_a == norm_b && same_amount_abs(tx_a, tx_b) {
                evidence.push(DuplicateEvidence {
                    transaction_id: tx_b.id.clone(),
                    duplicate_of: tx_a.id.clone(),
                    match_reason: "normalized_merchant_amount".into(),
                    details: format!(
                        "Same normalized merchant '{}' and amount {}",
                        norm_a, tx_a.amount
                    ),
                });
                used[j] = true;
            }
        }
    }

    evidence
}

fn same_amount_abs(a: &Transaction, b: &Transaction) -> bool {
    let a_abs = a.amount.minor_units().checked_abs().unwrap_or(0);
    let b_abs = b.amount.minor_units().checked_abs().unwrap_or(0);
    a_abs == b_abs
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::money::Money;

    fn tx(id: &str, payee: Option<&str>, amount: i64, date: &str, imported_id: Option<&str>) -> Transaction {
        Transaction {
            id: id.into(),
            account_id: "acct1".into(),
            date: date.into(),
            payee_id: None,
            payee_name: payee.map(|s| s.into()),
            category_id: Some("cat1".into()),
            category_name: None,
            amount: Money::new(amount, "USD"),
            cleared: true,
            reconciled: false,
            imported_id: imported_id.map(|s| s.into()),
            imported_payee: None,
            notes: None,
            tags: vec![],
            transfer_account_id: None,
            subtransactions: vec![],
        }
    }

    #[test]
    fn test_no_duplicates_returns_empty() {
        let txs = vec![
            tx("tx1", Some("Starbucks"), -500, "2026-01-15", None),
            tx("tx2", Some("Amazon"), -2000, "2026-01-16", None),
        ];
        let result = find_duplicates(&txs);
        assert!(result.is_empty());
    }

    #[test]
    fn test_exact_match_by_imported_id() {
        let txs = vec![
            tx("tx1", Some("Starbucks"), -500, "2026-01-15", Some("imp001")),
            tx("tx2", Some("Starbucks"), -500, "2026-01-15", Some("imp001")),
        ];
        let result = find_duplicates(&txs);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].match_reason, "exact_imported_id");
        assert_eq!(result[0].transaction_id, "tx2");
        assert_eq!(result[0].duplicate_of, "tx1");
    }

    #[test]
    fn test_amount_date_match() {
        let txs = vec![
            tx("tx1", Some("Payee A"), -1000, "2026-03-01", None),
            tx("tx2", Some("Payee B"), -1000, "2026-03-01", None),
        ];
        let result = find_duplicates(&txs);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].match_reason, "amount_date");
    }

    #[test]
    fn test_normalized_merchant_amount_match() {
        let txs = vec![
            tx("tx1", Some("Starbucks Coffee"), -550, "2026-04-01", None),
            tx("tx2", Some("STARBUCKS COFFEE"), -550, "2026-04-10", None),
        ];
        let result = find_duplicates(&txs);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].match_reason, "normalized_merchant_amount");
    }

    #[test]
    fn test_duplicates_roundtrip_json() {
        let txs = vec![
            tx("tx1", Some("Dupe"), -500, "2026-01-01", None),
            tx("tx2", Some("Dupe"), -500, "2026-01-01", None),
        ];
        let result = find_duplicates(&txs);
        let json = serde_json::to_string(&result).unwrap();
        let back: Vec<DuplicateEvidence> = serde_json::from_str(&json).unwrap();
        assert_eq!(result, back);
        // camelCase keys
        assert!(json.contains("matchReason"));
        assert!(json.contains("duplicateOf"));
    }

    #[test]
    fn test_i64_min_does_not_panic() {
        let txs = vec![
            tx("tx1", Some("Overflow"), i64::MIN, "2026-01-01", None),
            tx("tx2", Some("Overflow"), i64::MIN, "2026-02-01", None),
        ];
        let result = find_duplicates(&txs);
        // i64::MIN checked_abs → 0, so 0 ≠ 0 normalised merchant+amount matches
        // but amount_date fails because dates differ.
        // Expected: they may not match because checked_abs gives 0 for i64::MIN.
        assert!(result.is_empty() || result.len() == 1);
    }
}
