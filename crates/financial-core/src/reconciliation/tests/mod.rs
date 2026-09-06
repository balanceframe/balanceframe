use super::*;
use crate::money::Money;

fn make_tx(
    id: &str,
    imported_id: Option<&str>,
    payee: Option<&str>,
    amount: i64,
    date: &str,
) -> Transaction {
    Transaction {
        id: id.into(),
        account_id: "acct1".into(),
        date: date.into(),
        payee_id: None,
        payee_name: payee.map(|s| s.into()),
        category_id: Some("cat1".into()),
        category_name: Some("Food".into()),
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

fn make_import(id: &str, amount: i64, date: &str, payee: Option<&str>) -> ImportTransaction {
    ImportTransaction {
        id: id.into(),
        account_id: "acct1".into(),
        date: date.into(),
        payee_name: payee.map(|s| s.into()),
        amount: Money::new(amount, "USD"),
        memo: None,
        flags_count: 0,
    }
}

#[test]
fn test_exact_match() {
    let txs = vec![make_tx("tx1", Some("imp1"), None, 100, "2026-01-15")];
    let imports = vec![make_import("imp1", 100, "2026-01-15", None)];
    let result = reconcile_by_imported_id(&txs, &imports);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].match_type, MatchType::Exact);
}

#[test]
fn test_amount_date_match() {
    let txs = vec![make_tx("tx1", None, None, 5000, "2026-03-01")];
    let imports = vec![make_import("imp1", 5000, "2026-03-01", None)];
    let result = reconcile_by_imported_id(&txs, &imports);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].match_type, MatchType::AmountDate);
}

#[test]
fn test_partial_match() {
    let txs = vec![make_tx("tx1", None, Some("Starbucks"), 450, "2026-06-10")];
    let imports = vec![make_import("imp1", 450, "2026-06-10", Some("STARBUCKS"))];
    let result = reconcile_by_imported_id(&txs, &imports);
    // amount+date should match before partial, but here the date is the same,
    // so it's an AmountDate match
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].match_type, MatchType::AmountDate);
}

#[test]
fn test_no_match() {
    let txs = vec![make_tx("tx1", None, Some("Unrelated"), 999, "2026-01-01")];
    let imports = vec![make_import("imp1", 111, "2026-06-01", Some("Other"))];
    let result = reconcile_by_imported_id(&txs, &imports);
    assert_eq!(result.len(), 0);
}
