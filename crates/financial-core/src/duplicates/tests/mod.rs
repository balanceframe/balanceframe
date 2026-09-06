use super::*;
use crate::money::Money;

fn tx(
    id: &str,
    payee: Option<&str>,
    amount: i64,
    date: &str,
    imported_id: Option<&str>,
) -> Transaction {
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
    assert!(
        result.is_empty(),
        "i64::MIN amounts must not match as duplicates: {:?}",
        result
    );
}

#[test]
fn test_same_i64_min_with_same_date_not_matched() {
    // Even with same date and payee, i64::MIN must not match (abs overflow).
    let txs = vec![
        tx("tx1", Some("Same Payee"), i64::MIN, "2026-01-01", None),
        tx("tx2", Some("Same Payee"), i64::MIN, "2026-01-01", None),
    ];
    let result = find_duplicates(&txs);
    assert!(
        result.is_empty(),
        "i64::MIN must not create false duplicate matches: {:?}",
        result
    );
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
    assert_eq!(
        result.len(),
        3,
        "chain of 3 should produce 3 evidence entries: {:?}",
        result
    );
    // Verify orientations: transaction_id > duplicate_of alphabetically
    for ev in &result {
        assert!(
            ev.transaction_id >= ev.duplicate_of,
            "pair orientation: {} should be >= {}",
            ev.transaction_id,
            ev.duplicate_of
        );
    }
    // Verify specific pairs exist
    let pairs: Vec<(&str, &str)> = result
        .iter()
        .map(|e| (e.transaction_id.as_str(), e.duplicate_of.as_str()))
        .collect();
    assert!(
        pairs.contains(&("tx2", "tx1")),
        "missing tx2→tx1: {:?}",
        pairs
    );
    assert!(
        pairs.contains(&("tx3", "tx1")),
        "missing tx3→tx1: {:?}",
        pairs
    );
    assert!(
        pairs.contains(&("tx3", "tx2")),
        "missing tx3→tx2: {:?}",
        pairs
    );
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
        assert!(
            key_a <= key_b,
            "output not sorted: {:?} > {:?}",
            key_a,
            key_b
        );
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
    assert_eq!(
        json1, json2,
        "duplicate evidence JSON must be deterministic"
    );
}
