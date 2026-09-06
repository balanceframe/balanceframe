use super::*;
use crate::money::Money;

#[test]
fn test_quality_summary_counts() {
    let issues = vec![
        QualityIssue::new(Severity::Blocker, "B1", "blocker", "T", "1"),
        QualityIssue::new(Severity::Warning, "W1", "warn", "T", "2"),
        QualityIssue::new(Severity::Info, "I1", "info", "T", "3"),
    ];
    let report = DataQualityReport {
        summary: QualitySummary {
            total_issues: issues.len(),
            blockers: issues
                .iter()
                .filter(|i| i.severity == Severity::Blocker)
                .count(),
            warnings: issues
                .iter()
                .filter(|i| i.severity == Severity::Warning)
                .count(),
            info: issues
                .iter()
                .filter(|i| i.severity == Severity::Info)
                .count(),
        },
        issues,
    };
    assert_eq!(report.summary.total_issues, 3);
    assert_eq!(report.summary.blockers, 1);
    assert_eq!(report.summary.warnings, 1);
    assert_eq!(report.summary.info, 1);
}

#[test]
fn test_analyze_accounts_stale() {
    let accounts = vec![Account {
        id: "acct1".into(),
        name: "Checking".into(),
        account_type: "checking".into(),
        off_budget: false,
        is_closed: false,
        cleared_balance: Money::new(1000, "USD"),
        imported_balance: Money::new(1000, "USD"),
        mtid: None,
    }];

    let tx = Transaction {
        id: "tx1".into(),
        account_id: "acct1".into(),
        date: "2025-01-01".into(),
        payee_id: None,
        payee_name: Some("Test".into()),
        category_id: Some("cat1".into()),
        category_name: Some("TestCat".into()),
        amount: Money::new(100, "USD"),
        cleared: true,
        reconciled: false,
        imported_id: None,
        imported_payee: None,
        notes: None,
        tags: vec![],
        transfer_account_id: None,
        subtransactions: vec![],
    };

    let issues = analyze_accounts(&accounts, &[tx], "2026-07-17");
    assert!(issues.iter().any(|i| i.code == "STALE_BALANCE"));
}

#[test]
fn test_overflow_i64_min_uncategorized() {
    // i64::MIN has no representable absolute value; the analyzer must
    // emit an AMOUNT_OVERFLOW blocker instead of panicking.
    let tx = Transaction {
        id: "overflow_tx".into(),
        account_id: "acct1".into(),
        date: "2026-07-17".into(),
        payee_id: None,
        payee_name: Some("Overflow".into()),
        category_id: None,
        category_name: None,
        amount: Money::new(i64::MIN, "USD"),
        cleared: true,
        reconciled: false,
        imported_id: None,
        imported_payee: None,
        notes: None,
        tags: vec![],
        transfer_account_id: None,
        subtransactions: vec![],
    };

    let report = analyze_readiness(&[], &[tx], &[], "2026-07-17");
    assert!(
        report.issues.iter().any(|i| i.code == "AMOUNT_OVERFLOW"),
        "expected AMOUNT_OVERFLOW blocker, got issues: {:?}",
        report.issues,
    );
    assert!(
        report
            .issues
            .iter()
            .any(|i| i.severity == Severity::Blocker),
        "expected at least one blocker",
    );
}
