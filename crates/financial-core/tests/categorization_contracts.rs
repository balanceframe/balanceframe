use balanceframe_financial_core::{
    classify_historical, find_candidates, CandidateStatus, EvidenceKind, HistoryRecord, Money,
    Payee, Transaction,
};
use serde_json::Value;

fn transaction(id: &str, payee: Option<&str>, category: Option<&str>) -> Transaction {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/financial-decision-foundation.json"
    ))
    .unwrap();
    let mut tx: Transaction =
        serde_json::from_value(fixture["full"]["legacySnapshot"]["transactions"][0].clone())
            .unwrap();
    tx.id = id.into();
    tx.payee_name = payee.map(str::to_string);
    tx.category_id = category.map(str::to_string);
    tx
}

fn historical(payee: &str, category: &str, date: &str) -> HistoryRecord {
    HistoryRecord {
        transaction_id: format!("history-{category}"),
        payee_name: payee.into(),
        category_id: category.into(),
        category_name: category.into(),
        amount: Money::new(-100, "USD"),
        date: date.into(),
    }
}

#[test]
fn exact_evidence_wins_and_resolved_or_unidentifiable_transactions_are_not_reclassified() {
    let payees = [Payee {
        id: "market".into(),
        name: "Market".into(),
        transfer_account_id: None,
        mtid: None,
    }];
    let history = [
        historical("Market", "food", "2026-09-01"),
        historical("Books", "education", "2026-09-01"),
    ];
    let transactions = [
        transaction("exact", Some(" MARKET "), None),
        transaction("assigned", Some("Market"), Some("existing")),
        transaction("historical", Some("Books"), Some("")),
        transaction("unmatched", Some("Unrelated"), None),
        transaction("missing", None, None),
        transaction("blank", Some("   "), None),
    ];
    let candidates = find_candidates(&transactions, &payees, &history);
    assert_eq!(
        candidates
            .iter()
            .map(|c| c.transaction_id.as_str())
            .collect::<Vec<_>>(),
        ["exact", "historical"]
    );
    assert_eq!(candidates[0].reasons[0].kind, EvidenceKind::ExactPayee);
    assert_eq!(candidates[1].reasons[0].kind, EvidenceKind::Historical);
    assert!(candidates
        .iter()
        .all(|c| c.eligibility() == CandidateStatus::Resolved));
}

#[test]
fn latest_same_merchant_history_is_stable_when_older_or_unrelated_records_are_added() {
    let tx = transaction("candidate", Some(" MARKET "), None);
    let latest = historical("Market", "groceries", "2026-09-05");
    let expected = classify_historical(&tx, std::slice::from_ref(&latest)).unwrap();
    let mut history = vec![
        historical("market", "old-category", "2026-01-01"),
        latest,
        historical("Other", "unrelated", "2026-12-31"),
    ];
    assert_eq!(classify_historical(&tx, &history), Some(expected.clone()));
    history.reverse();
    assert_eq!(classify_historical(&tx, &history), Some(expected));
}
