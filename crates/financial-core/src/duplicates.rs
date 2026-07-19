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
    fn test_i64_min_skipped_not_matched() {
        // i64::MIN abs overflows; these should never match as duplicates.
        let txs = vec![
            tx("tx1", Some("Overflow"), i64::MIN, "2026-01-01", None),
            tx("tx2", Some("Overflow"), i64::MIN, "2026-02-01", None),
        ];
        let result = find_duplicates(&txs);
        assert!(result.is_empty(), "i64::MIN amounts must not match as duplicates: {:?}", result);
    }

    #[test]
    fn test_same_i64_min_with_same_date_not_matched() {
        // Even with same date and payee, i64::MIN must not match (abs overflow).
        let txs = vec![
            tx("tx1", Some("Same Payee"), i64::MIN, "2026-01-01", None),
            tx("tx2", Some("Same Payee"), i64::MIN, "2026-01-01", None),
        ];
        let result = find_duplicates(&txs);
        assert!(result.is_empty(), "i64::MIN must not create false duplicate matches: {:?}", result);
    }

    #[test]
    fn test_plus_one_day_window_matches() {
        let txs = vec![
            tx("tx1", Some("Payee A"), -1000, "2026-03-01", None),
            tx("tx2", Some("Payee B"), -1000, "2026-03-02", None),
        ];
        let result = find_duplicates(&txs);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].match_reason, "amount_date");
        assert_eq!(result[0].transaction_id, "tx2");
        assert_eq!(result[0].duplicate_of, "tx1");
    }

    #[test]
    fn test_minus_one_day_window_matches() {
        let txs = vec![
            tx("tx1", Some("Payee A"), -1000, "2026-04-15", None),
            tx("tx2", Some("Payee B"), -1000, "2026-04-14", None),
        ];
        let result = find_duplicates(&txs);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].match_reason, "amount_date");
    }

    #[test]
    fn test_month_boundary_window_matches() {
        // Jan 31 and Feb 1 are ±1 day even across month boundary.
        let txs = vec![
            tx("tx1", Some("Payee A"), -1000, "2026-01-31", None),
            tx("tx2", Some("Payee B"), -1000, "2026-02-01", None),
        ];
        let result = find_duplicates(&txs);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].match_reason, "amount_date");
    }

    #[test]
    fn test_year_boundary_window_matches() {
        let txs = vec![
            tx("tx1", Some("Payee A"), -1000, "2025-12-31", None),
            tx("tx2", Some("Payee B"), -1000, "2026-01-01", None),
        ];
        let result = find_duplicates(&txs);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].match_reason, "amount_date");
    }

    #[test]
    fn test_outside_one_day_window_no_match() {
        let txs = vec![
            tx("tx1", Some("Payee A"), -1000, "2026-03-01", None),
            tx("tx2", Some("Payee B"), -1000, "2026-03-03", None),
        ];
        let result = find_duplicates(&txs);
        assert!(result.is_empty());
    }

    #[test]
    fn test_chain_candidates_preserved() {
        // Three transactions forming a chain:
        // tx1 (imp001) → tx2 (same imported_id imp001, exact match)
        // tx2 (imp001, also same date/amount as tx3) → tx3 should also match
        let txs = vec![
            tx("tx1", Some("Starbucks"), -500, "2026-01-15", Some("imp001")),
            tx("tx2", Some("Starbucks"), -500, "2026-01-15", Some("imp001")),
            tx("tx3", Some("Payee B"), -500, "2026-01-15", None),
        ];
        let result = find_duplicates(&txs);
        // Chain: tx1→tx2 (exact), tx1→tx3 (amount_date), tx2→tx3 (amount_date)
        assert_eq!(result.len(), 3, "chain of 3 should produce 3 evidence entries: {:?}", result);
        // Verify orientations: transaction_id > duplicate_of alphabetically
        for ev in &result {
            assert!(ev.transaction_id >= ev.duplicate_of,
                "pair orientation: {} should be >= {}", ev.transaction_id, ev.duplicate_of);
        }
        // Verify specific pairs exist
        let pairs: Vec<(&str, &str)> = result.iter()
            .map(|e| (e.transaction_id.as_str(), e.duplicate_of.as_str()))
            .collect();
        assert!(pairs.contains(&("tx2", "tx1")), "missing tx2→tx1: {:?}", pairs);
        assert!(pairs.contains(&("tx3", "tx1")), "missing tx3→tx1: {:?}", pairs);
        assert!(pairs.contains(&("tx3", "tx2")), "missing tx3→tx2: {:?}", pairs);
    }

    #[test]
    fn test_deterministic_output_ordering() {
        // Input transactions in arbitrary order; output must be sorted.
        let txs = vec![
            tx("tx_b", Some("Payee"), -500, "2026-01-15", Some("imp_b")),
            tx("tx_c", Some("Payee"), -500, "2026-01-16", None),
            tx("tx_a", Some("Payee"), -500, "2026-01-14", Some("imp_a")),
        ];
        let result = find_duplicates(&txs);
        // Should not be empty (at least both exact matches fire)
        assert!(!result.is_empty());
        // Verify sorted: ascending by (transaction_id, duplicate_of, match_reason)
        for window in result.windows(2) {
            let a = &window[0];
            let b = &window[1];
            let key_a = (&a.transaction_id, &a.duplicate_of, &a.match_reason);
            let key_b = (&b.transaction_id, &b.duplicate_of, &b.match_reason);
            assert!(key_a <= key_b, "output not sorted: {:?} > {:?}", key_a, key_b);
        }
    }

    #[test]
    fn test_json_output_deterministic() {
        let txs = vec![
            tx("tx2", Some("Payee"), -500, "2026-01-15", Some("imp_a")),
            tx("tx3", Some("Payee"), -500, "2026-01-16", None),
            tx("tx1", Some("Payee"), -500, "2026-01-14", Some("imp_b")),
        ];
        // Run twice — must produce identical JSON
        let json1 = serde_json::to_string(&find_duplicates(&txs)).unwrap();
        let json2 = serde_json::to_string(&find_duplicates(&txs)).unwrap();
        assert_eq!(json1, json2, "duplicate evidence JSON must be deterministic");
    }
}
