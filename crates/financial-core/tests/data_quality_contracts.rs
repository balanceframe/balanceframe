use balanceframe_financial_core::{
    analyze_readiness, analyze_transactions, Account, Category, Money, Severity, Transaction,
};
use serde_json::Value;

fn transaction(id: &str, amount: i64) -> Transaction {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/financial-decision-foundation.json"
    ))
    .unwrap();
    let mut transaction: Transaction =
        serde_json::from_value(fixture["full"]["legacySnapshot"]["transactions"][0].clone())
            .unwrap();
    transaction.id = id.into();
    transaction.account_id = "checking".into();
    transaction.date = "2026-09-06".into();
    transaction.amount = Money::new(amount, "USD");
    transaction.payee_name = Some("Market".into());
    transaction.category_id = None;
    transaction.subtransactions.clear();
    transaction.cleared = true;
    transaction.reconciled = true;
    transaction
}

fn category(id: &str, name: &str, deleted: bool) -> Category {
    Category {
        id: id.into(),
        name: name.into(),
        group_name: None,
        is_income: false,
        mtid: None,
        deleted,
    }
}

#[test]
fn readiness_distinguishes_split_deletion_duplicate_and_pending_evidence() {
    let categories = vec![
        category("food", "Food", false),
        category("old-meals", "Meals", true),
        category("new-meals", "Meals revised", false),
    ];
    let mut parent = transaction("split", -100);
    parent.category_id = Some("food".into());
    parent.cleared = false;
    let mut child = transaction("child", -90);
    child.category_id = Some("old-meals".into());
    parent.subtransactions.push(child);
    let mut duplicate = transaction("duplicate", -100);
    duplicate.category_id = Some("food".into());
    let report = analyze_readiness(&[], &[parent, duplicate], &categories, "2026-09-06");
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == "DELETED_CATEGORY_REFERENCED"
            && issue.entity_id == "old-meals"
            && issue.severity == Severity::Blocker));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == "SPLIT_MISMATCH" && issue.entity_id == "split"));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == "DUPLICATE_CANDIDATE" && issue.entity_id == "duplicate"));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == "PENDING_EXPOSURE" && issue.entity_id == "split"));
    assert!(report
        .issues
        .iter()
        .any(|issue| issue.code == "CATEGORY_RENAMED" && issue.entity_id == "old-meals"));
    assert_eq!(
        (
            report.summary.blockers,
            report.summary.warnings,
            report.summary.info
        ),
        (1, 2, 2)
    );
}

#[test]
fn reconciled_and_closed_accounts_do_not_create_stale_balance_warnings() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/financial-decision-foundation.json"
    ))
    .unwrap();
    let mut account: Account =
        serde_json::from_value(fixture["full"]["legacySnapshot"]["accounts"][0].clone()).unwrap();
    account.id = "checking".into();
    let mut old = transaction("old", -10);
    old.date = "2025-01-01".into();
    old.category_id = Some("food".into());
    let categories = [category("food", "Food", false)];
    assert!(!analyze_readiness(
        &[account.clone()],
        &[old.clone()],
        &categories,
        "2026-09-06"
    )
    .issues
    .iter()
    .any(|issue| issue.code == "STALE_BALANCE"));
    old.reconciled = false;
    assert!(analyze_readiness(
        &[account.clone()],
        &[old.clone()],
        &categories,
        "2026-09-06"
    )
    .issues
    .iter()
    .any(|issue| issue.code == "STALE_BALANCE"));
    account.is_closed = true;
    assert!(
        !analyze_readiness(&[account], &[old], &categories, "2026-09-06")
            .issues
            .iter()
            .any(|issue| issue.code == "STALE_BALANCE")
    );
}

#[test]
fn uncategorized_total_overflow_is_a_data_blocker_not_a_panic_or_wrapped_total() {
    let issues = analyze_transactions(
        &[transaction("large", i64::MAX), transaction("extra", 1)],
        &[],
    );
    assert!(issues
        .iter()
        .any(|issue| issue.code == "AMOUNT_OVERFLOW" && issue.severity == Severity::Blocker));
}

#[test]
fn split_total_overflow_is_a_data_blocker_not_a_panic_or_wrapped_sum() {
    let mut parent = transaction("split-overflow", i64::MAX);
    parent.category_id = Some("food".into());
    parent.subtransactions = vec![
        transaction("large-child", i64::MAX),
        transaction("extra-child", 1),
    ];
    let issues = analyze_transactions(&[parent], &[category("food", "Food", false)]);
    assert!(issues.iter().any(|issue| issue.code == "AMOUNT_OVERFLOW"
        && issue.severity == Severity::Blocker
        && issue.entity_id == "split-overflow"));
}

#[test]
fn split_signed_cancellation_is_order_independent_at_integer_boundaries() {
    for (amount, mut children) in [
        (i64::MAX, vec![i64::MAX, 1, -1]),
        (i64::MIN + 1, vec![i64::MIN, -1, 2]),
    ] {
        for _ in 0..children.len() {
            let mut parent = transaction("cancelled-split", amount);
            parent.category_id = Some("food".into());
            parent.subtransactions = children
                .iter()
                .enumerate()
                .map(|(index, amount)| transaction(&format!("child-{index}"), *amount))
                .collect();
            let issues = analyze_transactions(&[parent], &[category("food", "Food", false)]);
            assert!(
                !issues
                    .iter()
                    .any(|issue| issue.code == "AMOUNT_OVERFLOW" || issue.code == "SPLIT_MISMATCH"),
                "{children:?}: {issues:?}"
            );
            children.rotate_left(1);
        }
    }
}
