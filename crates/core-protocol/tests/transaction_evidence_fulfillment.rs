use balanceframe_core_protocol::{
    derive_evidence_settlement_plan, resolve_transaction_evidence,
    DeriveEvidenceSettlementPlanRequest, TransactionEvidenceRequest,
};
use serde_json::{json, Value};
#[test]
fn order_totals_never_become_additional_expenses_alongside_shipment_invoices() {
    let mut value: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/evidence-settlement-plan.json"
    ))
    .unwrap();
    let mut order = value["evidence"]["observations"][0].clone();
    order["id"] = json!("order-total");
    order["kind"] = json!("order");
    order["amount"]["minorUnits"] = json!("1200");
    order["externalEventId"] = Value::Null;
    order["ledgerTransactionId"] = Value::Null;
    order.as_object_mut().unwrap().remove("ledgerAccountId");
    order["sourceId"] = json!("retail-order");
    order["provenance"]["documentId"] = json!("doc-order");
    value["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(order);
    for receipt in value["evidence"]["receipts"].as_array_mut().unwrap() {
        receipt["fulfillmentGroupId"] = json!("order-one");
    }
    let request: DeriveEvidenceSettlementPlanRequest =
        serde_json::from_value(value.clone()).unwrap();
    let plan = derive_evidence_settlement_plan(&request).unwrap();
    assert_eq!(plan.ledger_effect.amount.minor_units(), -1200);
    let resolution = resolve_transaction_evidence(&request.evidence).unwrap();
    let order = resolution
        .events
        .iter()
        .find(|event| event.observation_ids.contains(&"order-total".into()))
        .unwrap();
    assert_ne!(order.state, "resolved");
    assert!(order.projection_observation.is_none());
    let original = &value["evidence"]["observations"][0];
    value["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["ledgerEffect"] = json!({"accountId":"checking","amount":{"minorUnits":"-1200","currency":"USD"},"date":original["date"],"categoryId":"food","payeeName":null,"notes":null,"splits":[]});
    value["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["reviewedLedgerEffect"] = json!(true);
    let evidence: TransactionEvidenceRequest =
        serde_json::from_value(value["evidence"].clone()).unwrap();
    assert!(resolve_transaction_evidence(&evidence).is_err());
}
