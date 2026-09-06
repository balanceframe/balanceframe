use super::*;
use crate::money::Money;

fn sample_account(id: &str, name: &str) -> Account {
    Account {
        id: id.into(),
        name: name.into(),
        account_type: "checking".into(),
        off_budget: false,
        is_closed: false,
        cleared_balance: Money::new(1000, "USD"),
        imported_balance: Money::new(1000, "USD"),
        mtid: None,
    }
}

fn sample_tx(
    id: &str,
    account_id: &str,
    date: &str,
    cleared: bool,
    category_id: Option<&str>,
) -> Transaction {
    Transaction {
        id: id.into(),
        account_id: account_id.into(),
        date: date.into(),
        payee_id: None,
        payee_name: None,
        category_id: category_id.map(|s| s.into()),
        category_name: None,
        amount: Money::new(100, "USD"),
        cleared,
        reconciled: false,
        imported_id: None,
        imported_payee: None,
        notes: None,
        tags: vec![],
        transfer_account_id: None,
        subtransactions: vec![],
    }
}

#[test]
fn test_coverage_single_account() {
    let accounts = vec![sample_account("a1", "Checking")];
    let txs = vec![
        sample_tx("tx1", "a1", "2026-01-01", true, Some("cat1")),
        sample_tx("tx2", "a1", "2026-06-15", true, None),
    ];
    let scope = InclusionScope::new(true, true);
    let report = build_coverage_report(&accounts, &txs, &scope);
    assert_eq!(report.total_transactions, 2);
    assert_eq!(report.accounts.len(), 1);
    assert_eq!(report.accounts[0].transaction_count, 2);
    assert_eq!(report.overall_date_range.start, "2026-01-01");
    assert_eq!(report.overall_date_range.end, "2026-06-15");
    assert!(report.accounts_missing_transactions.is_empty());
}

#[test]
fn test_coverage_missing_transactions() {
    let accounts = vec![
        sample_account("a1", "Checking"),
        sample_account("a2", "Savings"),
    ];
    let txs = vec![sample_tx("tx1", "a1", "2026-03-01", true, Some("cat1"))];
    let scope = InclusionScope::new(true, true);
    let report = build_coverage_report(&accounts, &txs, &scope);
    assert_eq!(report.accounts[1].transaction_count, 0);
    assert_eq!(report.accounts_missing_transactions, vec!["a2"]);
}

#[test]
fn test_coverage_excludes_pending() {
    let accounts = vec![sample_account("a1", "Checking")];
    let txs = vec![
        sample_tx("tx1", "a1", "2026-01-01", true, Some("cat1")),
        sample_tx("tx2", "a1", "2026-06-15", false, None),
    ];
    // include_cleared=true, include_pending=false
    let scope = InclusionScope::new(false, true);
    let report = build_coverage_report(&accounts, &txs, &scope);
    assert_eq!(report.total_transactions, 1);
    assert!(!report.inclusion_scope.include_pending);
}

#[test]
fn test_coverage_roundtrip_json() {
    let accounts = vec![sample_account("a1", "Checking")];
    let txs = vec![sample_tx("tx1", "a1", "2026-03-01", true, Some("cat1"))];
    let scope = InclusionScope::new(true, true);
    let report = build_coverage_report(&accounts, &txs, &scope);
    let json = serde_json::to_string(&report).unwrap();
    let back: CoverageReport = serde_json::from_str(&json).unwrap();
    assert_eq!(report, back);
    assert!(json.contains("overallDateRange"));
}

#[test]
fn test_coverage_empty_snapshot() {
    let scope = InclusionScope::new(true, true);
    let report = build_coverage_report(&[], &[], &scope);
    assert_eq!(report.total_transactions, 0);
    assert!(report.accounts.is_empty());
    assert!(report.overall_date_range.start.is_empty());
}
