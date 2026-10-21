use balanceframe_core_protocol::{resolve_transaction_evidence, TransactionEvidenceRequest};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence.json"
    ))
    .unwrap()
}
fn receipt_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-receipt.json"
    ))
    .unwrap()
}

fn resolve(value: Value) -> balanceframe_core_protocol::TransactionEvidenceResult {
    resolve_transaction_evidence(
        &serde_json::from_value::<TransactionEvidenceRequest>(value).unwrap(),
    )
    .unwrap()
}
#[test]
fn resolves_exact_funding_with_provenance_without_models() {
    let result = resolve(fixture());
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].state, "resolved");
    assert!(result.blockers.is_empty());
    assert_eq!(result.events[0].amount.minor_units(), 1200);
    assert_eq!(result.resolution_hash.len(), 64);
}
#[test]
fn receipt_collection_sizes_are_bounded_before_indexing_or_allocation_analysis() {
    for (field, maximum) in [("lines", 1000), ("tenders", 100)] {
        let mut v = receipt_fixture();
        let item = v["receipts"][0][field][0].clone();
        v["receipts"][0][field] = Value::Array(
            (0..=maximum)
                .map(|index| {
                    let mut value = item.clone();
                    value["id"] = json!(format!("bounded-{index}"));
                    if field == "tenders" {
                        value["observationId"] = Value::Null;
                    }
                    value
                })
                .collect(),
        );
        let error = resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).unwrap_err();
        assert_eq!(error.0, "receipt_size");
    }
}
#[test]
fn ambiguity_does_not_choose_identical_amount_settlements() {
    let mut value = fixture();
    let mut duplicate = value["observations"][1].clone();
    duplicate["id"] = json!("bank-2");
    duplicate["provenance"]["documentId"] = json!("doc-bank-2");
    value["observations"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let result = resolve(value);
    assert!(result
        .blockers
        .iter()
        .any(|b| b.code == "economic_event_ambiguity"));
    assert!(result.events.iter().all(|e| e.state != "resolved"));
}
#[test]
fn rejects_double_consumption_and_unproven_projection_amounts() {
    let mut value = fixture();
    let relationship = json!({"id":"r1","fromId":"wallet-1","toId":"bank-1","kind":"funding","state":"confirmed","allocatedAmount":{"minorUnits":"1200","currency":"USD"},"partial":false,"score":100,"reasonCodes":["approved"],"evidenceIds":["doc-wallet"]});
    let mut second = relationship.clone();
    second["id"] = json!("r2");
    value["relationships"] = json!([relationship, second]);
    assert!(resolve_transaction_evidence(&serde_json::from_value(value).unwrap()).is_err());
}
#[test]
fn explicit_many_to_many_requires_partial_allocations_and_conserves() {
    let mut v = fixture();
    let mut second = v["observations"][0].clone();
    second["id"] = json!("wallet-2");
    second["amount"]["minorUnits"] = json!("800");
    v["observations"][0]["amount"]["minorUnits"] = json!("400");
    v["observations"].as_array_mut().unwrap().push(second);
    v["relationships"] = json!([
        {"id":"r1","fromId":"wallet-1","toId":"bank-1","kind":"partial_funding","state":"confirmed","allocatedAmount":{"minorUnits":"400","currency":"USD"},"partial":true,"score":100,"reasonCodes":[],"evidenceIds":[]},
        {"id":"r2","fromId":"wallet-2","toId":"bank-1","kind":"partial_funding","state":"confirmed","allocatedAmount":{"minorUnits":"800","currency":"USD"},"partial":true,"score":100,"reasonCodes":[],"evidenceIds":[]}
    ]);
    let result = resolve(v.clone());
    assert_eq!(result.events[0].state, "resolved");
    assert_eq!(result.events[0].amount.minor_units(), 1200);
    v["relationships"][0]["partial"] = json!(false);
    assert!(resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).is_err());
}
#[test]
fn unknown_wallet_opening_is_explicit_and_materialization_is_stable() {
    let mut v = fixture();
    v["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":null,"closingBalance":null,"completeActivity":true,"materializedAccountId":"actual-wallet","requiresStoredValue":false}]);
    let result = resolve(v);
    assert_eq!(result.wallets[0].balance_state, "balance_unknown");
    assert_eq!(result.wallets[0].projection, "materialized");
}
#[test]
fn normalized_identity_is_order_invariant_but_amount_changes_invalidate_hash() {
    let v = fixture();
    let a = resolve(v.clone());
    let mut reordered = v.clone();
    reordered["observations"].as_array_mut().unwrap().reverse();
    assert_eq!(a.resolution_hash, resolve(reordered).resolution_hash);
    let mut changed = v;
    changed["observations"][0]["amount"]["minorUnits"] = json!("1199");
    assert_ne!(a.resolution_hash, resolve(changed).resolution_hash);
}
#[test]
fn receipt_quantity_tender_and_tax_are_never_repaired_silently() {
    let mut v = receipt_fixture();

    assert!(resolve(v.clone()).receipts[0].valid);
    v["receipts"][0]["lines"][0]["quantityMicros"] = json!(1000000);
    let out = resolve(v);
    assert!(!out.receipts[0].valid);
    assert!(out
        .blockers
        .iter()
        .any(|b| b.code == "receipt_total_mismatch"));
    assert_eq!(out.events[0].state, "blocked");
}
#[test]
fn invalid_money_currency_date_and_versions_fail_closed() {
    for (field, value) in [
        ("date", json!("2026-02-30")),
        ("status", json!("invented")),
        ("reliability", json!(101)),
    ] {
        let mut v = fixture();
        v["observations"][0][field] = value;
        assert!(resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).is_err());
    }
    let mut v = fixture();
    v["contractVersion"] = json!("2");
    assert!(resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).is_err());
    let mut v = fixture();
    v["observations"][0]["amount"]["minorUnits"] = json!("-1");
    assert!(resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).is_err());
}
#[test]
fn stable_external_identity_resolves_aggregate_settlement() {
    let mut v = fixture();
    let mut second = v["observations"][0].clone();
    second["id"] = json!("wallet-2");
    second["amount"]["minorUnits"] = json!("800");
    v["observations"][0]["amount"]["minorUnits"] = json!("400");
    v["observations"].as_array_mut().unwrap().push(second);
    let result = resolve(v);
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].state, "resolved");
    assert_eq!(result.events[0].amount.minor_units(), 1200);
}
#[test]
fn no_projection_from_unapproved_source_semantics_or_existing_actual_rows() {
    let mut v = fixture();
    v["observations"][0]["ledgerEffect"] = json!({"accountId":"acct","amount":{"minorUnits":"-1200","currency":"USD"},"date":"2026-10-15","categoryId":"cat","payeeName":null,"notes":null,"splits":[]});
    assert!(resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).is_err());
    assert!(resolve(fixture()).events[0]
        .projection_observation
        .is_none());
}
#[test]
fn all_normalized_fields_are_required_even_when_null() {
    for field in [
        "externalEventId",
        "counterparty",
        "fundingInstrumentId",
        "walletId",
        "ledgerTransactionId",
        "ledgerEffect",
    ] {
        let mut v = fixture();
        v["observations"][0].as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<TransactionEvidenceRequest>(v).is_err(),
            "{field}"
        );
    }
}
#[test]
fn historical_rules_require_context_and_report_category_conflicts() {
    use balanceframe_core_protocol::{
        simulate_transaction_evidence_rule, EvidenceRuleSimulationRequest,
    };
    let request = json!({"contractVersion":"1","rule":{"id":"rule","sourceId":"wallet-source","counterparty":"person-1","fundingInstrumentId":"card-1","sku":"sku-1","normalizedDescription":null,"categoryId":"food"},"evidence":fixture(),"actualRuleCategories":["other"]});
    let result = simulate_transaction_evidence_rule(
        &serde_json::from_value::<EvidenceRuleSimulationRequest>(request.clone()).unwrap(),
    )
    .unwrap();
    assert!(result.requires_approval);
    assert_eq!(result.matches.len(), 0);
    assert!(result
        .conflicts
        .contains(&"actual_rule_category_conflict".to_string()));
    let mut invalid = request;
    invalid["rule"]["sku"] = Value::Null;
    assert!(simulate_transaction_evidence_rule(&serde_json::from_value(invalid).unwrap()).is_err());
}
#[test]
fn fully_funded_zero_balance_wallet_can_collapse_without_inventing_balance_flow() {
    let mut v = fixture();
    v["observations"][0]["walletId"] = json!("wallet");
    v["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":{"minorUnits":"0","currency":"USD"},"closingBalance":{"minorUnits":"0","currency":"USD"},"completeActivity":true,"materializedAccountId":null,"requiresStoredValue":false}]);
    let result = resolve(v);
    assert_eq!(result.wallets[0].balance_state, "known");
    assert_eq!(result.wallets[0].projection, "collapsed");
}
#[test]
fn approved_correction_can_project_only_exact_unwritten_effect() {
    let mut v = fixture();
    v["observations"][0]["kind"] = json!("user_correction");
    v["observations"][0]["reviewedLedgerEffect"] = json!(true);
    v["observations"][0]["ledgerEffect"] = json!({"accountId":"acct","amount":{"minorUnits":"-1200","currency":"USD"},"date":"2026-10-15","categoryId":"cat","payeeName":null,"notes":null,"splits":[]});
    v["observations"][1]["ledgerTransactionId"] = Value::Null;
    v["observations"][1]["kind"] = json!("receipt");
    v["relationships"] = json!([{"id":"confirmed","fromId":"wallet-1","toId":"bank-1","kind":"funding","state":"confirmed","allocatedAmount":{"minorUnits":"1200","currency":"USD"},"partial":false,"score":100,"reasonCodes":["human_reviewed"],"evidenceIds":["doc-wallet","doc-bank"]}]);

    let result = resolve(v.clone());
    let observation = result.events[0].projection_observation.as_ref().unwrap();
    assert_eq!(
        observation.content_hash.as_ref(),
        Some(&result.resolution_hash)
    );
    assert_eq!(
        observation
            .ledger_effect
            .as_ref()
            .unwrap()
            .amount
            .minor_units(),
        -1200
    );
    v["observations"][0]["ledgerEffect"]["amount"]["minorUnits"] = json!("-1199");
    assert!(resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).is_err());
}
#[test]
fn event_identity_cannot_collide_through_delimiters() {
    let mut a = fixture();
    a["observations"][0]["id"] = json!("a:b");
    a["observations"][1]["id"] = json!("c");
    let mut b = fixture();
    b["observations"][0]["id"] = json!("a");
    b["observations"][1]["id"] = json!("b:c");
    assert_ne!(resolve(a).events[0].id, resolve(b).events[0].id);
}
#[test]
fn refunds_cannot_consume_an_original_payment_more_than_once() {
    let mut v = fixture();
    v["observations"][1]["direction"] = json!("inflow");
    v["observations"][1]["eventType"] = json!("refund");
    let rel = json!({"id":"refund-1","fromId":"wallet-1","toId":"bank-1","kind":"refund","state":"confirmed","allocatedAmount":{"minorUnits":"800","currency":"USD"},"partial":true,"score":100,"reasonCodes":[],"evidenceIds":[]});
    let mut second = rel.clone();
    second["id"] = json!("refund-2");
    v["relationships"] = json!([rel, second]);
    assert!(resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).is_err());
}
#[test]
fn pending_to_posted_supersession_is_explicit_and_never_double_settles() {
    let mut v = fixture();
    let mut pending = v["observations"][0].clone();
    pending["id"] = json!("pending-wallet");
    pending["status"] = json!("pending");
    v["observations"].as_array_mut().unwrap().push(pending);
    let result = resolve(v);
    assert!(result.relationships.iter().any(|r| r.kind == "supersession"
        && r.from_id == "pending-wallet"
        && r.to_id == "wallet-1"));
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].state, "resolved");
}
#[test]
fn ledger_observations_require_actual_identity_and_reject_fabricated_unwritten_ledger() {
    let mut v = fixture();
    v["observations"][1]["ledgerTransactionId"] = Value::Null;
    assert!(resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).is_err());
}
#[test]
fn scoped_item_rules_match_only_valid_history_and_expose_conflicts() {
    use balanceframe_core_protocol::simulate_transaction_evidence_rule;
    let mut v: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-rule.json"
    ))
    .unwrap();
    let simulation = |value: Value| {
        simulate_transaction_evidence_rule(&serde_json::from_value(value).unwrap()).unwrap()
    };
    let result = simulation(v.clone());
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.false_positive_risk, "review_required");
    v["evidence"]["receipts"][0]["lines"][0]["categoryId"] = json!("other");
    let result = simulation(v.clone());
    assert!(result.matches[0].conflict);
    assert_eq!(result.false_positive_risk, "conflicting_history");
    v["rule"]["fundingInstrumentId"] = json!("different-account");
    assert!(simulation(v.clone()).matches.is_empty());
    v["rule"]["fundingInstrumentId"] = json!("card-1");
    v["rule"]["sku"] = Value::Null;
    v["rule"]["normalizedDescription"] = json!("item");
    assert_eq!(simulation(v.clone()).matches.len(), 1);
    v["rule"]["normalizedDescription"] = json!("different item");
    assert!(simulation(v).matches.is_empty());
}
#[test]
fn wallet_balances_infer_only_from_complete_activity_and_preserve_unknown() {
    let mut v = fixture();
    v["observations"][0]["walletId"] = json!("wallet");
    v["observations"][0]["fundingInstrumentId"] = json!("wallet");
    v["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":null,"closingBalance":{"minorUnits":"500","currency":"USD"},"completeActivity":true,"materializedAccountId":null,"requiresStoredValue":true}]);
    let out = resolve(v.clone());
    assert_eq!(
        out.wallets[0]
            .opening_balance
            .as_ref()
            .unwrap()
            .minor_units(),
        1700
    );
    assert_eq!(out.wallets[0].projection, "materialize");
    v["wallets"][0]["completeActivity"] = json!(false);
    let out = resolve(v.clone());
    assert!(out.wallets[0].opening_balance.is_none());
    assert_eq!(out.wallets[0].balance_state, "balance_unknown");
    v["wallets"][0]["completeActivity"] = json!(true);
    v["wallets"][0]["openingBalance"] = json!({"minorUnits":"2000","currency":"USD"});
    assert_eq!(resolve(v.clone()).wallets[0].balance_state, "discontinuous");
    v["wallets"][0]["closingBalance"] = Value::Null;
    assert_eq!(
        resolve(v).wallets[0]
            .closing_balance
            .as_ref()
            .unwrap()
            .minor_units(),
        800
    );
}
#[test]
fn split_tenders_conserve_gift_cards_and_rewards_as_positive_funding() {
    let mut v = receipt_fixture();
    v["receipts"][0]["tenders"] = json!([
        {"id":"card","kind":"card","amount":{"minorUnits":"600","currency":"USD"},"observationId":null},
        {"id":"gift","kind":"gift_card","amount":{"minorUnits":"400","currency":"USD"},"observationId":null},
        {"id":"reward","kind":"reward","amount":{"minorUnits":"200","currency":"USD"},"observationId":null}
    ]);
    assert!(resolve(v.clone()).receipts[0].valid);
    v["receipts"][0]["tenders"][1]["amount"]["minorUnits"] = json!("399");
    assert!(!resolve(v).receipts[0].valid);
}
#[test]
fn cross_currency_direction_date_pending_and_low_reliability_never_match() {
    for (pointer, value) in [
        ("/observations/1/amount/currency", json!("EUR")),
        ("/observations/1/direction", json!("inflow")),
        ("/observations/1/date", json!("2026-11-30")),
        ("/observations/0/status", json!("pending")),
        ("/observations/0/reliability", json!(79)),
        ("/observations/1/fundingInstrumentId", json!("other")),
    ] {
        let mut v = fixture();
        *v.pointer_mut(pointer).unwrap() = value;
        assert!(
            resolve(v).events.iter().all(|e| e.state != "resolved"),
            "{pointer}"
        );
    }
}
#[test]
fn wallet_funding_is_a_transfer_and_does_not_become_an_expense() {
    let mut v = fixture();
    v["observations"][0]["kind"] = json!("wallet_transfer");
    v["observations"][0]["eventType"] = json!("transfer");
    v["observations"][0]["direction"] = json!("inflow");
    let result = resolve(v);
    assert_eq!(result.events[0].state, "resolved");
    assert_eq!(result.events[0].event_type, "transfer");
    assert_eq!(result.relationships[0].kind, "transfer");
}
#[test]
fn return_quantity_and_refund_amount_cannot_exceed_the_purchased_item() {
    let mut v = receipt_fixture();
    let mut refund_observation = v["observations"][0].clone();
    refund_observation["id"] = json!("refund-observation");
    refund_observation["direction"] = json!("inflow");
    refund_observation["eventType"] = json!("refund");
    refund_observation["externalEventId"] = json!("refund-event");
    v["observations"]
        .as_array_mut()
        .unwrap()
        .push(refund_observation);
    let mut returned = v["receipts"][0].clone();
    returned["id"] = json!("return-1");
    returned["observationId"] = json!("refund-observation");
    returned["lines"][0]["id"] = json!("return-line");
    returned["lines"][0]["returnOfLineId"] = json!("line-1");
    returned["tenders"][0]["observationId"] = Value::Null;
    v["receipts"].as_array_mut().unwrap().push(returned);
    assert!(resolve(v.clone()).receipts.iter().all(|r| r.valid));
    v["receipts"][1]["lines"][0]["quantityMicros"] = json!(3000000);
    assert!(!resolve(v.clone()).receipts[1].valid);
    v["receipts"][1]["lines"][0]["quantityMicros"] = json!(2000000);
    v["receipts"][1]["lines"][0]["net"]["minorUnits"] = json!("1300");
    v["receipts"][1]["lines"][0]["tax"]["minorUnits"] = json!("200");
    v["receipts"][1]["total"]["minorUnits"] = json!("1300");
    v["receipts"][1]["tax"]["minorUnits"] = json!("200");
    v["receipts"][1]["tenders"][0]["amount"]["minorUnits"] = json!("1300");
    v["observations"][2]["amount"]["minorUnits"] = json!("1300");
    assert!(!resolve(v).receipts[1].valid);
}
#[test]
fn updated_invoice_supersedes_prior_source_without_double_counting() {
    let mut v = receipt_fixture();
    let mut updated = v["receipts"][0].clone();
    updated["id"] = json!("receipt-2");
    updated["version"] = json!(2);
    updated["supersedesId"] = json!("receipt-1");
    updated["observationId"] = json!("wallet-updated");
    updated["lines"][0]["id"] = json!("line-updated");
    v["receipts"].as_array_mut().unwrap().push(updated);
    let mut obs = v["observations"][0].clone();
    obs["id"] = json!("wallet-updated");
    v["observations"].as_array_mut().unwrap().push(obs);
    let result = resolve(v);
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.events[0].state, "resolved");
    assert!(!result.events[0]
        .observation_ids
        .contains(&"wallet-1".to_string()));
}
#[test]
fn compatible_unlinked_actual_row_blocks_duplicate_projection_even_without_source_metadata() {
    let mut v: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-projection.json"
    ))
    .unwrap();
    let mut actual = fixture()["observations"][1].clone();
    actual["id"] = json!("fresh-actual");
    actual["externalEventId"] = Value::Null;
    actual["fundingInstrumentId"] = Value::Null;
    actual["counterparty"] = Value::Null;
    v["observations"].as_array_mut().unwrap().push(actual);
    let result = resolve(v);
    let event = result
        .events
        .iter()
        .find(|e| e.observation_ids.contains(&"wallet-1".to_string()))
        .unwrap();
    assert!(event.projection_observation.is_none());
    assert!(result
        .blockers
        .iter()
        .any(|b| b.code == "ledger_overlap_ambiguity"));
}
#[test]
fn exact_split_effect_preserves_categories_and_rejects_sign_currency_and_sum_changes() {
    let mut v: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-projection.json"
    ))
    .unwrap();
    v["observations"][0]["ledgerEffect"]["categoryId"] = Value::Null;
    v["observations"][0]["ledgerEffect"]["splits"] = json!([{"categoryId":"food","amount":{"minorUnits":"-400","currency":"USD"}},{"categoryId":"home","amount":{"minorUnits":"-800","currency":"USD"}}]);
    assert!(resolve(v.clone()).events[0]
        .projection_observation
        .is_some());
    for (pointer, value) in [
        (
            "/observations/0/ledgerEffect/splits/0/amount/minorUnits",
            json!("-399"),
        ),
        (
            "/observations/0/ledgerEffect/splits/0/amount/minorUnits",
            json!("400"),
        ),
        (
            "/observations/0/ledgerEffect/splits/0/amount/currency",
            json!("EUR"),
        ),
    ] {
        let mut invalid = v.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(resolve_transaction_evidence(&serde_json::from_value(invalid).unwrap()).is_err());
    }
}
#[test]
fn nonmonetary_links_never_allocate_money_and_incompatible_identity_is_rejected() {
    let mut v = fixture();
    let rel = json!({"id":"same","fromId":"wallet-1","toId":"bank-1","kind":"same_event","state":"confirmed","allocatedAmount":null,"partial":false,"score":100,"reasonCodes":[],"evidenceIds":[]});
    v["relationships"] = json!([rel]);
    assert_eq!(resolve(v.clone()).events[0].state, "resolved");
    v["observations"][0]["amount"]["minorUnits"] = json!("1199");
    assert!(resolve_transaction_evidence(&serde_json::from_value(v.clone()).unwrap()).is_err());
    v["relationships"][0]["state"] = json!("rejected");
    assert!(resolve(v).events.iter().all(|e| e.state != "resolved"));
}
#[test]
fn reviewed_wallet_payment_retains_balance_activity_and_requires_exact_review_flag() {
    let mut v = fixture();
    v["observations"][0]["ledgerEffect"] = json!({"accountId":"wallet-account","amount":{"minorUnits":"-1200","currency":"USD"},"date":"2026-10-15","categoryId":"food","payeeName":null,"notes":null,"splits":[]});
    v["observations"][0]["reviewedLedgerEffect"] = json!(true);
    v["observations"][0]["walletId"] = json!("wallet");
    v["observations"][0]["fundingInstrumentId"] = json!("wallet");
    v["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":{"minorUnits":"2000","currency":"USD"},"closingBalance":{"minorUnits":"800","currency":"USD"},"completeActivity":true,"materializedAccountId":"wallet-account","requiresStoredValue":true}]);
    let out = resolve(v.clone());
    assert_eq!(out.wallets[0].balance_state, "known");
    assert_eq!(
        out.wallets[0]
            .closing_balance
            .as_ref()
            .unwrap()
            .minor_units(),
        800
    );
    v["observations"][0]["reviewedLedgerEffect"] = json!(false);
    assert!(resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).is_err());
}
#[test]
fn wallet_discontinuity_blocks_its_projection_but_preserves_unrelated_projection() {
    let mut v: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-projection.json"
    ))
    .unwrap();
    v["observations"][0]["kind"] = json!("wallet_payment");
    v["observations"][0]["reviewedLedgerEffect"] = json!(true);
    v["observations"][0]["walletId"] = json!("wallet");
    v["observations"][0]["fundingInstrumentId"] = json!("wallet");
    v["observations"][1]["fundingInstrumentId"] = json!("wallet");
    v["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":{"minorUnits":"1200","currency":"USD"},"closingBalance":{"minorUnits":"100","currency":"USD"},"completeActivity":true,"materializedAccountId":null,"requiresStoredValue":true}]);
    let mut unrelated_source = v["observations"][0].clone();
    unrelated_source["id"] = json!("unrelated-source");
    unrelated_source["walletId"] = Value::Null;
    unrelated_source["fundingInstrumentId"] = json!("other");
    let mut unrelated_target = v["observations"][1].clone();
    unrelated_target["id"] = json!("unrelated-target");
    unrelated_target["fundingInstrumentId"] = json!("other");
    v["observations"]
        .as_array_mut()
        .unwrap()
        .extend([unrelated_source, unrelated_target]);
    let mut relationship = v["relationships"][0].clone();
    relationship["id"] = json!("unrelated-relationship");
    relationship["fromId"] = json!("unrelated-source");
    relationship["toId"] = json!("unrelated-target");
    v["relationships"]
        .as_array_mut()
        .unwrap()
        .push(relationship);
    let out = resolve(v);
    let affected = out
        .events
        .iter()
        .find(|e| e.observation_ids.contains(&"wallet-1".into()))
        .unwrap();
    assert_eq!(affected.state, "blocked");
    assert!(affected.projection_observation.is_none());
    let unrelated = out
        .events
        .iter()
        .find(|e| e.observation_ids.contains(&"unrelated-source".into()))
        .unwrap();
    assert!(unrelated.projection_observation.is_some());
}
#[test]
fn purchase_tender_cannot_consume_an_inflow_or_pending_settlement() {
    for (field, value) in [("direction", json!("inflow")), ("status", json!("pending"))] {
        let mut v = receipt_fixture();
        v["observations"][1][field] = value;
        assert!(!resolve(v).receipts[0].valid, "{field}");
    }
}
#[test]
fn duplicate_receipt_ids_and_lines_cannot_double_consume_a_tender_observation() {
    let mut v = receipt_fixture();
    let mut duplicate = v["receipts"][0].clone();
    duplicate["id"] = json!("duplicate-receipt");
    duplicate["lines"][0]["id"] = json!("duplicate-line");
    v["receipts"].as_array_mut().unwrap().push(duplicate);
    let out = resolve(v);
    assert!(out.receipts.iter().all(|r| !r.valid));
    assert!(out
        .events
        .iter()
        .all(|e| e.projection_observation.is_none()));
}
#[test]
fn low_reliability_imports_produce_reviewable_candidates_without_confirming_money() {
    let mut v = fixture();
    v["observations"][0]["reliability"] = json!(0);
    v["observations"][0]["externalEventId"] = Value::Null;
    v["observations"][0]["counterparty"] = Value::Null;
    v["observations"][0]["fundingInstrumentId"] = Value::Null;
    let out = resolve(v.clone());
    let candidates: Vec<_> = out
        .relationships
        .iter()
        .filter(|r| r.state == "candidate")
        .collect();
    assert_eq!(candidates.len(), 1);
    assert!(candidates[0].score > 0 && candidates[0].score < 80);
    assert!(candidates[0]
        .reason_codes
        .contains(&"low_source_reliability".into()));
    assert!(out.events.iter().all(|e| e.state != "resolved"));
    let mut second = v["observations"][1].clone();
    second["id"] = json!("bank-2");
    second["ledgerTransactionId"] = json!("actual-bank-2");
    v["observations"].as_array_mut().unwrap().push(second);
    let out = resolve(v);
    assert_eq!(
        out.relationships
            .iter()
            .filter(|r| r.state == "candidate")
            .count(),
        2
    );
    assert!(out
        .blockers
        .iter()
        .any(|b| b.code == "economic_event_ambiguity"));
}
#[test]
fn shared_tender_requires_explicit_partial_allocations_and_conserves_across_receipts() {
    let mut v = receipt_fixture();
    v["observations"][0]["amount"]["minorUnits"] = json!("600");
    let mut second = v["observations"][0].clone();
    second["id"] = json!("wallet-2");
    v["observations"].as_array_mut().unwrap().push(second);
    let receipt = &mut v["receipts"][0];
    receipt["total"]["minorUnits"] = json!("600");
    receipt["discount"]["minorUnits"] = json!("50");
    receipt["tax"]["minorUnits"] = json!("50");
    receipt["lines"][0]["quantityMicros"] = json!(1000000);
    for field in ["gross", "net"] {
        receipt["lines"][0][field]["minorUnits"] = json!("600");
    }
    for field in ["discount", "tax"] {
        receipt["lines"][0][field]["minorUnits"] = json!("50");
    }
    receipt["tenders"][0]["amount"]["minorUnits"] = json!("600");
    receipt["tenders"][0]["partial"] = json!(true);
    let mut second = receipt.clone();
    second["id"] = json!("receipt-2");
    second["observationId"] = json!("wallet-2");
    second["lines"][0]["id"] = json!("line-2");
    v["receipts"].as_array_mut().unwrap().push(second);
    assert!(resolve(v.clone())
        .receipts
        .iter()
        .all(|receipt| receipt.valid));
    v["receipts"][0]["tenders"][0]["partial"] = json!(false);
    assert!(!resolve(v).receipts[0].valid);
}
#[test]
fn candidate_relationships_are_deterministic_and_explicit_rejection_stays_rejected() {
    let mut v = fixture();
    v["observations"][0]["reliability"] = json!(0);
    let first = resolve(v.clone());
    v["observations"].as_array_mut().unwrap().reverse();
    assert_eq!(first.relationships, resolve(v.clone()).relationships);
    let mut rejected = first.relationships[0].clone();
    rejected.state = "rejected".into();
    v["relationships"] = serde_json::to_value(vec![rejected]).unwrap();
    let out = resolve(v);
    assert!(
        out.relationships
            .iter()
            .all(|relationship| relationship.state != "confirmed"
                && relationship.state != "candidate")
    );
}
#[test]
fn generated_candidates_respect_the_normalized_relationship_limit() {
    let mut v = fixture();
    let source = v["observations"][0].clone();
    let target = v["observations"][1].clone();
    v["observations"] = json!([]);
    for index in 0..142 {
        let mut observation = source.clone();
        observation["id"] = json!(format!("source-{index}"));
        observation["reliability"] = json!(0);
        v["observations"].as_array_mut().unwrap().push(observation);
        let mut observation = target.clone();
        observation["id"] = json!(format!("target-{index}"));
        observation["ledgerTransactionId"] = json!(format!("actual-{index}"));
        v["observations"].as_array_mut().unwrap().push(observation);
    }
    assert!(resolve_transaction_evidence(&serde_json::from_value(v).unwrap()).is_err());
}
#[test]
fn unknown_wallet_balance_blocks_only_effects_requiring_that_wallet() {
    let mut v: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-projection.json"
    ))
    .unwrap();
    v["observations"][0]["kind"] = json!("wallet_payment");
    v["observations"][0]["walletId"] = json!("wallet");
    v["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":null,"closingBalance":null,"completeActivity":true,"materializedAccountId":"checking-1","requiresStoredValue":true}]);
    let out = resolve(v.clone());
    assert!(out.events[0].projection_observation.is_none());
    assert_eq!(out.events[0].state, "blocked");
    assert_eq!(
        out.blockers
            .iter()
            .find(|blocker| blocker.code == "wallet_balance_unknown")
            .unwrap()
            .evidence_ids,
        vec!["doc-wallet"]
    );
    v["wallets"][0]["materializedAccountId"] = Value::Null;
    assert!(resolve(v).events[0].projection_observation.is_some());
}
#[test]
fn received_wallet_funds_preserve_inflow_and_unknown_purpose() {
    let mut v = fixture();
    v["observations"][0]["walletId"] = json!("wallet");
    v["observations"][0]["direction"] = json!("inflow");
    v["observations"][0]["eventType"] = json!("unknown");
    v["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":{"minorUnits":"0","currency":"USD"},"closingBalance":null,"completeActivity":true,"materializedAccountId":null,"requiresStoredValue":false}]);
    let out = resolve(v);
    assert_eq!(
        out.wallets[0]
            .closing_balance
            .as_ref()
            .unwrap()
            .minor_units(),
        1200
    );
    assert_eq!(out.wallets[0].projection, "materialize");
    assert!(out.events.iter().all(|e| e.event_type != "income"));
}
#[test]
fn wallet_balance_attention_references_only_its_active_source_documents() {
    let mut v = fixture();
    v["observations"][0]["walletId"] = json!("wallet");
    let mut second = v["observations"][0].clone();
    second["id"] = json!("second");
    second["externalEventId"] = Value::Null;
    second["provenance"]["documentId"] = json!("doc-second");
    let mut pending = second.clone();
    pending["id"] = json!("pending");
    pending["status"] = json!("pending");
    pending["provenance"]["documentId"] = json!("doc-pending");
    let mut other = second.clone();
    other["id"] = json!("other-wallet");
    other["walletId"] = json!("other");
    other["provenance"]["documentId"] = json!("doc-other");
    v["observations"]
        .as_array_mut()
        .unwrap()
        .extend([second, pending, other]);
    v["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":null,"closingBalance":null,"completeActivity":false,"materializedAccountId":null,"requiresStoredValue":true}]);
    let out = resolve(v);
    let blocker = out
        .blockers
        .iter()
        .find(|blocker| blocker.code == "wallet_balance_unknown" && blocker.subject_id == "wallet")
        .unwrap();
    assert_eq!(blocker.evidence_ids, vec!["doc-second", "doc-wallet"]);
}
#[test]
fn context_candidate_scores_are_explicit_without_stable_identity() {
    let mut v = fixture();
    v["observations"][0]["externalEventId"] = Value::Null;
    v["observations"][0]["reliability"] = json!(0);
    let out = resolve(v);
    let candidate = out
        .relationships
        .iter()
        .find(|r| r.state == "candidate")
        .unwrap();
    assert_eq!(candidate.score, 65);
    assert!(candidate
        .reason_codes
        .contains(&"funding_counterparty_corroboration".into()));
}
#[test]
fn large_unmatched_capture_keeps_each_exception_scoped_to_its_own_event() {
    let mut v = fixture();
    let source = v["observations"][0].clone();
    v["observations"] = json!([]);
    for index in 0..2000 {
        let mut observation = source.clone();
        observation["id"] = json!(format!("unmatched-{index}"));
        observation["externalEventId"] = Value::Null;
        v["observations"].as_array_mut().unwrap().push(observation);
    }
    let result = resolve(v);
    assert_eq!(result.events.len(), 2000);
    assert_eq!(result.blockers.len(), 2000);
    assert!(result.events.iter().all(|event| event.state == "blocked"
        && event.projection_observation.is_none()
        && event.observation_ids.len() == 1));
    let event_ids: std::collections::BTreeSet<_> = result
        .events
        .iter()
        .map(|event| event.id.as_str())
        .collect();
    assert_eq!(event_ids.len(), 2000);
    assert!(result
        .blockers
        .iter()
        .all(|blocker| event_ids.contains(blocker.subject_id.as_str())
            && blocker.code == "unmatched_funds"));
}
#[test]
fn complete_wallet_history_cannot_overdraw_before_later_funding_even_when_final_net_is_zero() {
    let mut v = fixture();
    v["observations"].as_array_mut().unwrap().remove(1);
    v["observations"][0]["walletId"] = json!("wallet");
    v["observations"][0]["fundingInstrumentId"] = json!("wallet");
    let mut funding = v["observations"][0].clone();
    funding["id"] = json!("later-funding");
    funding["kind"] = json!("wallet_transfer");
    funding["externalEventId"] = json!("later-funding");
    funding["date"] = json!("2026-10-16");
    funding["direction"] = json!("inflow");
    funding["eventType"] = json!("transfer");
    v["observations"].as_array_mut().unwrap().push(funding);
    v["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":{"minorUnits":"0","currency":"USD"},"closingBalance":{"minorUnits":"0","currency":"USD"},"completeActivity":true,"materializedAccountId":null,"requiresStoredValue":true}]);
    let out = resolve(v.clone());
    assert_eq!(out.wallets[0].balance_state, "discontinuous");
    assert!(out
        .blockers
        .iter()
        .any(|b| b.code == "wallet_balance_discontinuity"));
    v["observations"][1]["date"] = json!("2026-10-15");
    let out = resolve(v.clone());
    assert_eq!(out.wallets[0].balance_state, "balance_unknown");
    assert!(out.wallets[0]
        .reason_codes
        .contains(&"wallet_activity_order_unknown".into()));
    v["observations"][1]["date"] = json!("2026-10-14");
    assert_eq!(resolve(v).wallets[0].balance_state, "known");
}
#[test]
fn wallet_daily_continuity_includes_fees_and_refunds_and_never_orders_same_day_flows() {
    let mut v = fixture();
    v["observations"].as_array_mut().unwrap().remove(1);
    v["observations"][0]["walletId"] = json!("wallet");
    v["observations"][0]["fundingInstrumentId"] = json!("wallet");
    v["observations"][0]["kind"] = json!("wallet_fee");
    let mut refund = v["observations"][0].clone();
    refund["id"] = json!("refund");
    refund["kind"] = json!("wallet_refund");
    refund["externalEventId"] = json!("refund");
    refund["direction"] = json!("inflow");
    v["observations"].as_array_mut().unwrap().push(refund);
    v["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":{"minorUnits":"1200","currency":"USD"},"closingBalance":{"minorUnits":"1200","currency":"USD"},"completeActivity":true,"materializedAccountId":null,"requiresStoredValue":true}]);
    assert_eq!(resolve(v.clone()).wallets[0].balance_state, "known");
    v["wallets"][0]["openingBalance"]["minorUnits"] = json!("0");
    v["wallets"][0]["closingBalance"]["minorUnits"] = json!("0");
    assert_eq!(resolve(v).wallets[0].balance_state, "balance_unknown");
}
#[test]
fn wallet_and_receipt_imports_have_local_candidates_without_ledger_or_hints() {
    let mut v = fixture();
    v["observations"][1]["kind"] = json!("receipt");
    v["observations"][1]["ledgerTransactionId"] = Value::Null;
    v["observations"][0]["reliability"] = json!(0);
    v["observations"][1]["reliability"] = json!(0);
    let out = resolve(v.clone());
    assert_eq!(out.relationships.len(), 1);
    assert_eq!(out.relationships[0].state, "candidate");
    assert!(out.relationships[0]
        .reason_codes
        .contains(&"evidence_to_evidence_candidate".into()));
    assert!(out.events.iter().all(|e| e.state != "resolved"));
    v["observations"][0]["reliability"] = json!(100);
    v["observations"][1]["reliability"] = json!(100);
    assert!(resolve(v.clone())
        .relationships
        .iter()
        .all(|r| r.state == "candidate"));
    v["observations"][1]["sourceId"] = v["observations"][0]["sourceId"].clone();
    assert!(resolve(v).relationships.is_empty());
}
#[test]
fn local_candidates_preserve_identical_amount_ambiguity_and_rejections_in_either_orientation() {
    let mut v = fixture();
    v["observations"][1]["kind"] = json!("receipt");
    v["observations"][1]["ledgerTransactionId"] = Value::Null;
    v["observations"][0]["reliability"] = json!(0);
    let mut second = v["observations"][1].clone();
    second["id"] = json!("receipt-2");
    second["sourceId"] = json!("retailer-2");
    v["observations"].as_array_mut().unwrap().push(second);
    let out = resolve(v.clone());
    assert_eq!(
        out.relationships
            .iter()
            .filter(|r| r.state == "candidate")
            .count(),
        2
    );
    assert!(out
        .blockers
        .iter()
        .any(|b| b.code == "economic_event_ambiguity"));
    let mut rejected = out.relationships[0].clone();
    rejected.state = "rejected".into();
    std::mem::swap(&mut rejected.from_id, &mut rejected.to_id);
    v["relationships"] = serde_json::to_value(vec![rejected]).unwrap();
    assert_eq!(
        resolve(v)
            .relationships
            .iter()
            .filter(|r| r.state == "candidate")
            .count(),
        1
    );
}
#[test]
fn reviewed_receipt_can_propose_category_amendment_only_for_proven_existing_settlement() {
    let mut v = fixture();
    v["observations"][1]["ledgerAccountId"] = json!("checking");
    v["observations"][0]["reviewedLedgerEffect"] = json!(true);
    v["observations"][0]["ledgerEffect"] = json!({"accountId":"checking","amount":{"minorUnits":"-1200","currency":"USD"},"date":"2026-10-16","categoryId":"food","payeeName":null,"notes":null,"splits":[]});
    let out = resolve(v.clone());
    let projection = out.events[0].projection_observation.as_ref().unwrap();
    assert_eq!(
        projection.scope,
        balanceframe_core_protocol::DecisionScope::Transaction("actual-bank-1".into())
    );
    assert_eq!(
        projection.ledger_effect.as_ref().unwrap().date,
        "2026-10-16"
    );
    v["observations"][1]
        .as_object_mut()
        .unwrap()
        .remove("ledgerAccountId");
    v["observations"][0]["ledgerEffect"]["date"] = json!("2026-10-15");
    assert!(resolve(v).events[0].projection_observation.is_none());
}
#[test]
fn reviewed_inflow_credit_preserves_refund_purpose_and_never_defaults_to_income() {
    let mut v: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-projection.json"
    ))
    .unwrap();
    for observation in v["observations"].as_array_mut().unwrap() {
        observation["direction"] = json!("inflow");
        observation["eventType"] = json!("refund");
    }
    v["observations"][0]["ledgerEffect"]["amount"]["minorUnits"] = json!("1200");
    let out = resolve(v);
    assert_eq!(out.events[0].event_type, "refund");
    assert_eq!(
        out.events[0]
            .projection_observation
            .as_ref()
            .unwrap()
            .ledger_effect
            .as_ref()
            .unwrap()
            .amount
            .minor_units(),
        1200
    );
}

#[test]
fn item_rule_merchants_remain_exact_even_with_generic_source_and_reused_sku() {
    use balanceframe_core_protocol::simulate_transaction_evidence_rule;
    let mut v: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-rule.json"
    ))
    .unwrap();
    let mut other = v["evidence"]["observations"][0].clone();
    other["id"] = json!("other-merchant-payment");
    other["externalEventId"] = Value::Null;
    other["counterparty"] = json!("Store B");
    v["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let mut receipt = v["evidence"]["receipts"][0].clone();
    receipt["id"] = json!("other-merchant-receipt");
    receipt["observationId"] = json!("other-merchant-payment");
    receipt["lines"][0]["id"] = json!("other-merchant-line");
    receipt["lines"][0]["rawDescription"] = json!("shampoo");
    receipt["lines"][0]["categoryId"] = json!("other");
    receipt["tenders"][0]["id"] = json!("other-merchant-tender");
    receipt["tenders"][0]["observationId"] = Value::Null;
    v["evidence"]["receipts"]
        .as_array_mut()
        .unwrap()
        .push(receipt);
    let simulate = |value: Value| {
        simulate_transaction_evidence_rule(&serde_json::from_value(value).unwrap()).unwrap()
    };
    let result = simulate(v.clone());
    assert_eq!(result.matches.len(), 1);
    assert_eq!(result.matches[0].receipt_id, "receipt-1");
    assert!(result.conflicts.is_empty());
    // The same constraint applies when each retailer also has its own source family.
    v["evidence"]["observations"][2]["sourceId"] = json!("store-b-specific");
    assert_eq!(simulate(v.clone()).matches.len(), 1);
    v["evidence"]["observations"][0]["counterparty"] = Value::Null;
    assert!(simulate(v.clone()).matches.is_empty());
    v["evidence"]["observations"][0]["counterparty"] = json!("PERSON-1");
    assert!(simulate(v).matches.is_empty());
}

#[test]
fn item_rule_counterparty_is_required_nonblank_and_never_inferred() {
    use balanceframe_core_protocol::{
        simulate_transaction_evidence_rule, EvidenceRuleSimulationRequest,
    };
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-rule.json"
    ))
    .unwrap();
    for invalid in [Value::Null, json!(""), json!("   "), json!("Store\nA")] {
        let mut request = fixture.clone();
        request["rule"]["counterparty"] = invalid;
        if let Ok(request) = serde_json::from_value::<EvidenceRuleSimulationRequest>(request) {
            assert!(simulate_transaction_evidence_rule(&request).is_err());
        }
    }
    let mut missing = fixture;
    missing["rule"]
        .as_object_mut()
        .unwrap()
        .remove("counterparty");
    assert!(serde_json::from_value::<EvidenceRuleSimulationRequest>(missing).is_err());
}

#[test]
fn learned_item_rules_require_two_distinct_current_human_outcomes_and_exact_context() {
    use balanceframe_core_protocol::learn_transaction_evidence_item_rules;
    let bundle: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-rule.json"
    ))
    .unwrap();
    let mut evidence = bundle["evidence"].clone();
    let mut second = evidence["observations"][0].clone();
    second["id"] = json!("reviewed-payment-2");
    second["externalEventId"] = json!("event-2");
    second["provenance"]["documentId"] = json!("reviewed-doc-2");
    second["provenance"]["contentHash"] = json!("c".repeat(64));
    evidence["observations"]
        .as_array_mut()
        .unwrap()
        .push(second);
    let mut receipt = evidence["receipts"][0].clone();
    receipt["id"] = json!("reviewed-receipt-2");
    receipt["observationId"] = json!("reviewed-payment-2");
    receipt["lines"][0]["id"] = json!("reviewed-line-2");
    receipt["lines"][0]["categoryId"] = json!("imported-untrusted");
    receipt["tenders"][0]["id"] = json!("reviewed-tender-2");
    receipt["tenders"][0]["observationId"] = Value::Null;
    evidence["receipts"].as_array_mut().unwrap().push(receipt);
    let first = json!({"sourceIdentity":"a".repeat(64),"documentId":"doc-wallet","contentHash":"a".repeat(64),"parserVersion":"wallet-v1","receiptId":"receipt-1","lineId":"line-1","accountId":"checking","categoryId":"food","policyVersion":"policy-1"});
    let mut second = first.clone();
    second["sourceIdentity"] = json!("b".repeat(64));
    second["documentId"] = json!("reviewed-doc-2");
    second["contentHash"] = json!("c".repeat(64));
    second["receiptId"] = json!("reviewed-receipt-2");
    second["lineId"] = json!("reviewed-line-2");
    let request = json!({"contractVersion":"1","policyVersion":"policy-1","accountId":"checking","evidence":evidence,"outcomes":[first,second]});
    let learn = |value: Value| {
        learn_transaction_evidence_item_rules(&serde_json::from_value(value).unwrap()).unwrap()
    };
    let result = learn(request.clone());
    assert_eq!(result.candidates.len(), 1);
    assert_eq!(result.candidates[0].review_count, 2);
    assert_eq!(result.candidates[0].rule.category_id, "food");
    assert!(result.candidates[0].requires_approval);
    assert!(learn({
        let mut v = request.clone();
        v["outcomes"].as_array_mut().unwrap().pop();
        v
    })
    .candidates
    .is_empty());
    for (path, value) in [
        ("/outcomes/1/sourceIdentity", json!("a".repeat(64))),
        ("/evidence/observations/2/counterparty", json!("Store B")),
        (
            "/evidence/observations/2/fundingInstrumentId",
            json!("other-card"),
        ),
        ("/outcomes/1/accountId", json!("other-account")),
        ("/outcomes/1/categoryId", Value::Null),
    ] {
        let mut v = request.clone();
        *v.pointer_mut(path).unwrap() = value;
        assert!(learn(v).candidates.is_empty(), "{path}");
    }
    let mut conflict = request.clone();
    conflict["outcomes"][1]["categoryId"] = json!("other");
    let conflict = learn(conflict);
    assert!(conflict.candidates.is_empty());
    assert!(!conflict.conflicts.is_empty());
    let mut stale = request.clone();
    stale["outcomes"][1]["contentHash"] = json!("d".repeat(64));
    assert!(
        learn_transaction_evidence_item_rules(&serde_json::from_value(stale).unwrap()).is_err()
    );
    let mut wrong_policy = request;
    wrong_policy["policyVersion"] = json!("policy-2");
    assert!(learn(wrong_policy).candidates.is_empty());
}

#[test]
fn item_learning_abstains_on_ambiguous_identity_and_rejects_stale_or_forged_proof() {
    use balanceframe_core_protocol::learn_transaction_evidence_item_rules;
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-item-learning.json"
    ))
    .unwrap();
    let learn = |value: Value| {
        learn_transaction_evidence_item_rules(&serde_json::from_value(value).unwrap())
    };
    for (path, value) in [
        ("/contractVersion", json!("2")),
        ("/accountId", json!("")),
        ("/outcomes/0/sourceIdentity", json!("forged")),
        ("/outcomes/0/receiptId", json!("absent")),
        ("/outcomes/0/lineId", json!("absent")),
        ("/outcomes/0/parserVersion", json!("stale-parser")),
        ("/outcomes/0/documentId", json!("other-doc")),
    ] {
        let mut v = fixture.clone();
        *v.pointer_mut(path).unwrap() = value;
        assert!(learn(v).is_err(), "{path}");
    }
    let mut duplicate = fixture.clone();
    let first = duplicate["outcomes"][0].clone();
    duplicate["outcomes"].as_array_mut().unwrap().push(first);
    assert!(learn(duplicate).is_err());
    let mut same_content = fixture.clone();
    same_content["evidence"]["observations"][2]["provenance"]["contentHash"] =
        json!("a".repeat(64));
    same_content["outcomes"][1]["contentHash"] = json!("a".repeat(64));
    assert!(learn(same_content).unwrap().candidates.is_empty());
    for (path, value) in [
        ("/evidence/observations/2/counterparty", Value::Null),
        ("/evidence/observations/2/fundingInstrumentId", Value::Null),
        ("/evidence/observations/2/sourceId", json!("other-source")),
        ("/evidence/receipts/1/total/minorUnits", json!("1201")),
    ] {
        let mut v = fixture.clone();
        *v.pointer_mut(path).unwrap() = value;
        assert!(learn(v).unwrap().candidates.is_empty(), "{path}");
    }
    let mut description = fixture.clone();
    for receipt in description["evidence"]["receipts"].as_array_mut().unwrap() {
        receipt["lines"][0]["sku"] = Value::Null;
    }
    let result = learn(description.clone()).unwrap();
    assert_eq!(
        result.candidates[0].rule.normalized_description.as_deref(),
        Some("item")
    );
    assert!(result.candidates[0].rule.sku.is_none());
    description["evidence"]["receipts"][1]["lines"][0]["normalizedDescription"] =
        json!("different item");
    assert!(learn(description).unwrap().candidates.is_empty());
    let first = learn(fixture.clone()).unwrap().candidates[0]
        .candidate_hash
        .clone();
    let mut changed = fixture;
    changed["outcomes"][1]["categoryId"] = json!("other");
    changed["outcomes"][0]["categoryId"] = json!("other");
    assert_ne!(learn(changed).unwrap().candidates[0].candidate_hash, first);
}

#[test]
fn learned_patterns_do_not_count_a_retried_known_event_as_another_review() {
    use balanceframe_core_protocol::learn_transaction_evidence_item_rules;
    let mut fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-item-learning.json"
    ))
    .unwrap();
    fixture["evidence"]["observations"][2]["externalEventId"] =
        fixture["evidence"]["observations"][0]["externalEventId"].clone();
    let result =
        learn_transaction_evidence_item_rules(&serde_json::from_value(fixture).unwrap()).unwrap();
    assert!(result.candidates.is_empty());
    let mut manual: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-item-learning.json"
    ))
    .unwrap();
    manual["evidence"]["observations"][0]["externalEventId"] = Value::Null;
    manual["evidence"]["observations"][2]["externalEventId"] = Value::Null;
    assert_eq!(
        learn_transaction_evidence_item_rules(&serde_json::from_value(manual).unwrap())
            .unwrap()
            .candidates
            .len(),
        1
    );
}

#[test]
fn contextual_item_rules_match_only_approved_exact_scope_and_report_broader_risk() {
    use balanceframe_core_protocol::{
        simulate_transaction_evidence_rule, EvidenceRuleSimulationRequest,
    };
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-rule.json"
    ))
    .unwrap();
    for (kind, value, field) in [
        ("retailer_mapping", "two items", "rawDescription"),
        ("department", "produce", "department"),
        ("product_family", "fruit", "productFamily"),
        (
            "historical_similarity",
            "fresh green organic apples",
            "normalizedDescription",
        ),
    ] {
        let mut request = fixture.clone();
        request["rule"]["sku"] = Value::Null;
        request["rule"]["normalizedDescription"] = Value::Null;
        request["rule"]["criterion"] = json!({"kind":kind,"value":value});
        request["evidence"]["receipts"][0]["lines"][0][field] = json!(value);
        let simulate = |request: Value| {
            simulate_transaction_evidence_rule(
                &serde_json::from_value::<EvidenceRuleSimulationRequest>(request).unwrap(),
            )
            .unwrap()
        };
        let matched = simulate(request.clone());
        assert_eq!(matched.matches.len(), 1, "{kind}");
        assert_eq!(matched.false_positive_risk, "broader_scope_review_required");
        request["evidence"]["observations"][0]["counterparty"] = json!("other retailer");
        assert!(simulate(request.clone()).matches.is_empty());
        request["evidence"]["observations"][0]["counterparty"] =
            fixture["rule"]["counterparty"].clone();
        request["evidence"]["receipts"][0]["lines"][0][field] = json!("unrelated cleaning shampoo");
        assert!(simulate(request).matches.is_empty());
    }
}

#[test]
fn approved_historical_text_match_uses_bounded_token_overlap_and_rejects_mixed_criteria() {
    use balanceframe_core_protocol::{
        simulate_transaction_evidence_rule, EvidenceRuleSimulationRequest,
    };
    let mut request: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-rule.json"
    ))
    .unwrap();
    request["rule"]["sku"] = Value::Null;
    request["rule"]["normalizedDescription"] = Value::Null;
    request["rule"]["criterion"] =
        json!({"kind":"historical_similarity","value":"fresh green organic apples"});
    let simulate = |request: Value| {
        serde_json::from_value::<EvidenceRuleSimulationRequest>(request)
            .map_err(|e| e.to_string())
            .and_then(|request| {
                simulate_transaction_evidence_rule(&request).map_err(|e| e.to_string())
            })
    };
    request["evidence"]["receipts"][0]["lines"][0]["normalizedDescription"] =
        json!("Fresh GREEN organic apples bag");
    assert_eq!(simulate(request.clone()).unwrap().matches.len(), 1);
    request["evidence"]["receipts"][0]["lines"][0]["normalizedDescription"] =
        json!("green organic apples bag");
    assert!(simulate(request.clone()).unwrap().matches.is_empty());
    for invalid in [
        json!({"kind":"historical_similarity","value":"apple"}),
        json!({"kind":"department","value":"   "}),
        json!({"kind":"opaque_model","value":"produce"}),
        Value::Null,
    ] {
        let mut bad = request.clone();
        bad["rule"]["criterion"] = invalid;
        assert!(simulate(bad).is_err());
    }
    request["rule"]["sku"] = json!("sku-1");
    assert!(simulate(request).is_err());
}

#[test]
fn broader_learning_requires_distinct_human_reviews_and_never_uses_imported_labels() {
    use balanceframe_core_protocol::{
        learn_transaction_evidence_item_rules, EvidenceItemRuleLearningRequest,
    };
    let mut request: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-item-learning.json"
    ))
    .unwrap();
    request["includeBroaderCriteria"] = json!(true);
    for receipt in request["evidence"]["receipts"].as_array_mut().unwrap() {
        receipt["lines"][0]["department"] = json!("produce");
        receipt["lines"][0]["productFamily"] = json!("fruit");
        receipt["lines"][0]["normalizedDescription"] = json!("fresh green apples");
    }
    let learn = |request: Value| {
        learn_transaction_evidence_item_rules(
            &serde_json::from_value::<EvidenceItemRuleLearningRequest>(request).unwrap(),
        )
        .unwrap()
    };
    let result = learn(request.clone());
    assert_eq!(result.candidates.len(), 5);
    for kind in [
        "retailer_mapping",
        "department",
        "product_family",
        "historical_similarity",
    ] {
        let candidate = result
            .candidates
            .iter()
            .find(|candidate| {
                candidate
                    .rule
                    .criterion
                    .as_ref()
                    .is_some_and(|criterion| criterion.kind == kind)
            })
            .unwrap();
        assert_eq!(candidate.review_count, 2);
        assert!(candidate.requires_approval);
    }
    request["outcomes"][1]["categoryId"] = Value::Null;
    assert!(learn(request.clone()).candidates.is_empty());
    request["outcomes"][1]["categoryId"] = json!("different");
    assert!(learn(request.clone()).candidates.is_empty());
    request["outcomes"][1]["categoryId"] = request["outcomes"][0]["categoryId"].clone();
    request["outcomes"][1]["sourceIdentity"] = request["outcomes"][0]["sourceIdentity"].clone();
    assert!(learn(request).candidates.is_empty());
}

#[test]
fn omitted_contextual_rule_fields_keep_legacy_serialization_and_null_is_rejected() {
    use balanceframe_core_protocol::EvidenceRuleSimulationRequest;
    let mut fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-rule.json"
    ))
    .unwrap();
    let request: EvidenceRuleSimulationRequest = serde_json::from_value(fixture.clone()).unwrap();
    assert_eq!(serde_json::to_value(request.rule).unwrap(), fixture["rule"]);
    fixture["rule"]["criterion"] = Value::Null;
    assert!(serde_json::from_value::<EvidenceRuleSimulationRequest>(fixture).is_err());
}
