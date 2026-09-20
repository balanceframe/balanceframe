use balanceframe_financial_core::{
    reconcile_by_imported_id, ImportTransaction, MatchType, Money, Transaction,
};
use serde_json::Value;

fn transaction(id: &str, amount: i64, date: &str, payee: Option<&str>) -> Transaction {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/financial-decision-foundation.json"
    ))
    .unwrap();
    let mut tx: Transaction =
        serde_json::from_value(fixture["full"]["legacySnapshot"]["transactions"][0].clone())
            .unwrap();
    tx.id = id.into();
    tx.account_id = "checking".into();
    tx.imported_id = None;
    tx.amount = Money::new(amount, "USD");
    tx.date = date.into();
    tx.payee_name = payee.map(str::to_string);
    tx
}

fn imported(id: &str, amount: i64, date: &str, payee: Option<&str>) -> ImportTransaction {
    ImportTransaction {
        id: id.into(),
        account_id: "checking".into(),
        amount: Money::new(amount, "USD"),
        date: date.into(),
        payee_name: payee.map(str::to_string),
        memo: None,
        flags_count: 0,
    }
}

#[test]
fn exact_matches_reserve_imports_before_earlier_weak_matches_and_each_import_is_used_once() {
    let mut exact = transaction("exact", -100, "2026-09-01", Some("Market"));
    exact.imported_id = Some("exact-import".into());
    let txs = [
        transaction("weak", -100, "2026-09-01", Some(" MARKET ")),
        exact,
        transaction("unknown", -100, "2026-09-03", Some("Other")),
        transaction("missing", -100, "2026-09-03", None),
    ];
    let imports = [
        imported("wrong-amount", 999, "2026-09-04", Some("Market")),
        imported("exact-import", 100, "2026-09-01", Some("Market")),
        imported("partial-import", 100, "2026-09-02", Some("Market")),
        imported("missing-payee", 100, "2026-09-04", None),
    ];
    let matches = reconcile_by_imported_id(&txs, &imports);
    assert_eq!(
        matches
            .iter()
            .map(|m| (m.tx_id.as_str(), m.import_id.as_str(), &m.match_type))
            .collect::<Vec<_>>(),
        [
            ("exact", "exact-import", &MatchType::Exact),
            ("weak", "partial-import", &MatchType::Partial)
        ]
    );
}

#[test]
fn minimum_signed_amount_uses_exact_unsigned_magnitude_without_overflow() {
    let txs = [
        transaction("dated", i64::MIN, "2026-09-06", Some("Market")),
        transaction("partial", i64::MIN, "2026-09-05", Some("Second")),
    ];
    let imports = [
        imported("dated-import", i64::MIN, "2026-09-06", Some("Market")),
        imported("partial-import", i64::MIN, "2026-09-04", Some("Second")),
    ];
    let matches = reconcile_by_imported_id(&txs, &imports);
    assert_eq!(
        matches
            .iter()
            .map(|m| (m.tx_id.as_str(), m.import_id.as_str(), &m.match_type))
            .collect::<Vec<_>>(),
        [
            ("dated", "dated-import", &MatchType::AmountDate),
            ("partial", "partial-import", &MatchType::Partial)
        ]
    );
}
