use balanceframe_core_protocol::{resolve_transaction_evidence, TransactionEvidenceRequest};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-receipt.json"
    ))
    .unwrap()
}
fn add_return(value: &mut Value, suffix: &str) {
    let mut observation = value["observations"][0].clone();
    observation["id"] = json!(format!("refund-{suffix}"));
    observation["direction"] = json!("inflow");
    observation["eventType"] = json!("refund");
    observation["externalEventId"] = json!("same-refund-event");
    let mut receipt = value["receipts"][0].clone();
    receipt["id"] = json!(format!("return-{suffix}"));
    receipt["observationId"] = observation["id"].clone();
    receipt["lines"][0]["id"] = json!(format!("returned-line-{suffix}"));
    receipt["lines"][0]["returnOfLineId"] = json!("line-1");
    receipt["tenders"][0]["observationId"] = Value::Null;
    value["observations"]
        .as_array_mut()
        .unwrap()
        .push(observation);
    value["receipts"].as_array_mut().unwrap().push(receipt);
}
fn resolve(value: Value) -> balanceframe_core_protocol::TransactionEvidenceResult {
    resolve_transaction_evidence(
        &serde_json::from_value::<TransactionEvidenceRequest>(value).unwrap(),
    )
    .unwrap()
}
fn updated_invoice() -> Value {
    let mut value = fixture();
    let mut updated = value["receipts"][0].clone();
    updated["id"] = json!("updated-receipt");
    updated["version"] = json!(2);
    updated["supersedesId"] = json!("receipt-1");
    updated["observationId"] = json!("updated-observation");
    updated["lines"][0]["id"] = json!("updated-line");
    let mut observation = value["observations"][0].clone();
    observation["id"] = json!("updated-observation");
    value["receipts"].as_array_mut().unwrap().push(updated);
    value["observations"]
        .as_array_mut()
        .unwrap()
        .push(observation);
    value
}
#[test]
fn corrected_refund_versions_consume_original_quantity_and_net_only_once() {
    let mut value = fixture();
    add_return(&mut value, "old");
    add_return(&mut value, "current");
    value["receipts"][2]["version"] = json!(2);
    value["receipts"][2]["supersedesId"] = json!("return-old");
    let result = resolve(value.clone());
    assert!(result.receipts.iter().all(|receipt| receipt.valid));
    assert!(!result
        .events
        .iter()
        .any(|event| event.observation_ids.contains(&"refund-old".into())));
    value["receipts"].as_array_mut().unwrap().reverse();
    let reordered = resolve(value);
    assert_eq!(result.resolution_hash, reordered.resolution_hash);
}
#[test]
fn excessive_active_returns_block_every_competing_refund_not_arbitrary_first() {
    let mut value = fixture();
    add_return(&mut value, "a");
    add_return(&mut value, "b");
    let result = resolve(value);
    assert!(result
        .receipts
        .iter()
        .filter(|receipt| receipt.receipt_id.starts_with("return-"))
        .all(|receipt| !receipt.valid));
}
#[test]
fn receipt_lineage_rejects_sibling_successors_cross_source_and_direction_changes() {
    let mut fork = updated_invoice();
    let mut sibling = fork["receipts"][1].clone();
    sibling["id"] = json!("sibling-receipt");
    sibling["observationId"] = json!("sibling-observation");
    sibling["lines"][0]["id"] = json!("sibling-line");
    let mut observation = fork["observations"][2].clone();
    observation["id"] = json!("sibling-observation");
    fork["receipts"].as_array_mut().unwrap().push(sibling);
    fork["observations"]
        .as_array_mut()
        .unwrap()
        .push(observation);
    assert!(resolve_transaction_evidence(&serde_json::from_value(fork).unwrap()).is_err());
    for (field, changed) in [
        ("sourceId", json!("other-source")),
        ("direction", json!("inflow")),
    ] {
        let mut value = updated_invoice();
        value["observations"][2][field] = changed;
        assert!(resolve_transaction_evidence(&serde_json::from_value(value).unwrap()).is_err());
    }
}

#[test]
fn linear_invoice_history_remains_valid_and_missing_sources_fail_closed() {
    let value = updated_invoice();
    assert!(resolve(value.clone())
        .receipts
        .iter()
        .all(|receipt| receipt.valid));
    for missing in ["wallet-1", "updated-observation"] {
        let mut invalid = value.clone();
        invalid["observations"]
            .as_array_mut()
            .unwrap()
            .retain(|observation| observation["id"] != missing);
        assert!(resolve_transaction_evidence(&serde_json::from_value(invalid).unwrap()).is_err());
    }
    let mut currency = value.clone();
    currency["observations"][2]["amount"]["currency"] = json!("EUR");
    assert!(resolve_transaction_evidence(&serde_json::from_value(currency).unwrap()).is_err());
    let mut same_observation = value;
    same_observation["receipts"][1]["observationId"] = json!("wallet-1");
    assert!(
        resolve_transaction_evidence(&serde_json::from_value(same_observation).unwrap()).is_err()
    );
}
#[test]
fn accumulated_refund_money_overflow_fails_closed_before_any_projection() {
    let mut value = fixture();
    add_return(&mut value, "a");
    add_return(&mut value, "b");
    value["receipts"][1]["lines"][0]["net"]["minorUnits"] = json!(i64::MAX.to_string());
    value["receipts"][2]["lines"][0]["net"]["minorUnits"] = json!("1");
    let error = resolve_transaction_evidence(&serde_json::from_value(value).unwrap()).unwrap_err();
    assert_eq!(error.0, "amount_overflow");
}

#[test]
fn only_completed_current_purchase_receipts_supply_return_capacity() {
    for (field, value) in [
        ("direction", json!("inflow")),
        ("eventType", json!("refund")),
        ("eventType", json!("transfer")),
        ("status", json!("pending")),
        ("kind", json!("order")),
    ] {
        let mut invalid = fixture();
        add_return(&mut invalid, "one");
        invalid["observations"][0][field] = value;
        assert!(resolve_transaction_evidence(&serde_json::from_value(invalid).unwrap()).is_err());
    }
    let mut invalid_purchase = fixture();
    add_return(&mut invalid_purchase, "one");
    invalid_purchase["receipts"][0]["total"]["minorUnits"] = json!("1199");
    let result = resolve(invalid_purchase);
    assert!(
        !result
            .receipts
            .iter()
            .find(|receipt| receipt.receipt_id == "return-one")
            .unwrap()
            .valid
    );
    let mut stale_purchase = updated_invoice();
    add_return(&mut stale_purchase, "one");
    assert!(
        resolve_transaction_evidence(&serde_json::from_value(stale_purchase).unwrap()).is_err()
    );
}
