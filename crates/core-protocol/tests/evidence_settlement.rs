use balanceframe_core_protocol::{
    derive_evidence_settlement_plan, resolve_transaction_evidence,
    DeriveEvidenceSettlementPlanRequest,
};
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/fixtures/evidence-settlement-plan.json"
    ))
    .unwrap()
}
fn derive(input: Value) -> Result<Value, String> {
    let request: DeriveEvidenceSettlementPlanRequest =
        serde_json::from_value(input).map_err(|e| e.to_string())?;
    derive_evidence_settlement_plan(&request)
        .map_err(|e| e.to_string())
        .map(|r| serde_json::to_value(r).unwrap())
}
#[test]
fn derives_two_conserved_receipts_into_one_existing_parent_amendment() {
    let mut input = fixture();
    let plan = derive(input.clone()).unwrap();
    assert_eq!(plan["ledgerTransactionId"], "actual-bank-1");
    assert_eq!(
        plan["ledgerEffect"],
        json!({"accountId":"checking","date":"2026-10-16","amount":{"minorUnits":"-1200","currency":"USD"},"categoryId":null,"payeeName":null,"notes":null,"splits":[{"categoryId":"food","amount":{"minorUnits":"-400","currency":"USD"}},{"categoryId":"household","amount":{"minorUnits":"-800","currency":"USD"}}]})
    );
    assert_eq!(plan["contributions"].as_array().unwrap().len(), 2);
    assert_eq!(plan["sources"].as_array().unwrap().len(), 3);
    input["evidence"]["observations"][0]["ledgerEffect"] = plan["ledgerEffect"].clone();
    input["evidence"]["observations"][0]["reviewedLedgerEffect"] = json!(true);
    let resolved =
        resolve_transaction_evidence(&serde_json::from_value(input["evidence"].clone()).unwrap())
            .unwrap();
    assert_eq!(resolved.events.len(), 1);
    let proof = resolved.events[0].projection_observation.as_ref().unwrap();
    assert_eq!(
        proof.scope,
        balanceframe_core_protocol::DecisionScope::Transaction("actual-bank-1".into())
    );
    assert_eq!(
        serde_json::to_value(proof.ledger_effect.as_ref().unwrap()).unwrap(),
        plan["ledgerEffect"]
    );
}
#[test]
fn rejects_missing_categories_incomplete_allocations_and_reused_lines() {
    for (pointer, value) in [
        ("/lineCategories", json!([])),
        ("/receiptIds", json!(["receipt-1"])),
        ("/evidence/relationships/0/state", json!("candidate")),
        (
            "/evidence/relationships/0/allocatedAmount/minorUnits",
            json!("399"),
        ),
        ("/evidence/receipts/0/lines/0/net/minorUnits", json!("399")),
        ("/evidence/observations/0/status", json!("pending")),
        ("/evidence/observations/0/direction", json!("inflow")),
    ] {
        let mut input = fixture();
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(derive(input).is_err(), "{pointer}");
    }
    let mut input = fixture();
    let duplicate = input["lineCategories"][0].clone();
    input["lineCategories"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert!(derive(input).is_err());
}

#[test]
fn exact_hash_binds_line_choices_sources_and_targets_but_not_selection_order() {
    let input = fixture();
    let first = derive(input.clone()).unwrap();
    let mut reordered = input.clone();
    for field in ["receiptIds", "lineCategories"] {
        reordered[field].as_array_mut().unwrap().reverse();
    }
    reordered["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_eq!(first, derive(reordered).unwrap());
    for (pointer, value) in [
        ("/lineCategories/0/categoryId", json!("different")),
        (
            "/evidence/observations/1/provenance/contentHash",
            json!("f".repeat(64)),
        ),
        (
            "/evidence/observations/1/provenance/parserVersion",
            json!("new-parser"),
        ),
        (
            "/evidence/observations/0/ledgerTransactionId",
            json!("other-parent"),
        ),
    ] {
        let mut changed = input.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        assert_ne!(
            first["allocationHash"],
            derive(changed).unwrap()["allocationHash"]
        );
    }
}
#[test]
fn explicit_categories_override_imported_hints_and_merge_without_inventing_money() {
    let mut input = fixture();
    input["lineCategories"][1]["categoryId"] = json!("food");
    input["evidence"]["receipts"][0]["lines"][0]["categoryId"] = json!("untrusted-category");
    let result = derive(input).unwrap();
    assert_eq!(result["ledgerEffect"]["categoryId"], "food");
    assert_eq!(result["ledgerEffect"]["splits"], json!([]));
    assert_eq!(result["ledgerEffect"]["amount"]["minorUnits"], "-1200");
}
#[test]
fn category_allocation_uses_conserved_line_net_including_exact_tax_and_discount_cents() {
    let mut input = fixture();
    let receipt = &mut input["evidence"]["receipts"][0];
    receipt["lines"][0]["unitGross"]["minorUnits"] = json!("401");
    receipt["lines"][0]["gross"]["minorUnits"] = json!("401");
    receipt["lines"][0]["discount"]["minorUnits"] = json!("2");
    receipt["discount"]["minorUnits"] = json!("2");
    receipt["lines"][0]["tax"]["minorUnits"] = json!("1");
    receipt["tax"]["minorUnits"] = json!("1");
    let result = derive(input).unwrap();
    assert_eq!(result["contributions"][0]["amount"]["minorUnits"], "400");
    assert_eq!(
        result["ledgerEffect"]["splits"][0]["amount"]["minorUnits"],
        "-400"
    );
}
#[test]
fn authoritative_target_is_required_without_promoting_imported_or_inflow_observations() {
    for (field, value) in [
        ("kind", json!("receipt")),
        ("reliability", json!(0)),
        ("ledgerAccountId", Value::Null),
        ("ledgerTransactionId", Value::Null),
        ("eventType", json!("transfer")),
        ("direction", json!("inflow")),
    ] {
        let mut input = fixture();
        input["evidence"]["observations"][0][field] = value;
        assert!(derive(input).is_err(), "{field}");
    }
    let mut input = fixture();
    input["targetObservationId"] = json!("missing");
    assert!(derive(input).is_err());
}
#[test]
fn unsupported_tenders_cannot_be_assigned_to_a_bank_parent() {
    for kind in ["gift_card", "reward", "cash", "wallet"] {
        let mut input = fixture();
        input["evidence"]["receipts"][0]["tenders"][0]["kind"] = json!(kind);
        assert!(derive(input).is_err(), "{kind}");
    }
    let mut input = fixture();
    input["evidence"]["receipts"][0]["tenders"][0]["observationId"] = Value::Null;
    assert!(derive(input).is_ok());
}
#[test]
fn duplicate_receipts_unknown_lines_and_additional_category_claims_fail_closed() {
    for (field, value) in [
        ("receiptIds", json!(["receipt-1", "receipt-1"])),
        ("receiptIds", json!(["missing"])),
        ("receiptIds", json!([])),
        (
            "lineCategories",
            json!([{"receiptId":"receipt-1","lineId":"missing","categoryId":"food"}]),
        ),
        (
            "lineCategories",
            json!([{"receiptId":"receipt-1","lineId":"line-1","categoryId":" "}]),
        ),
    ] {
        let mut input = fixture();
        input[field] = value;
        assert!(derive(input).is_err(), "{field}");
    }
    let mut input = fixture();
    input["lineCategories"]
        .as_array_mut()
        .unwrap()
        .push(json!({"receiptId":"unknown","lineId":"other","categoryId":"food"}));
    assert!(derive(input).is_err());
}
#[test]
fn amount_date_currency_and_global_source_capacity_are_not_repaired() {
    for (pointer, value) in [
        ("/evidence/observations/0/amount/minorUnits", json!("1199")),
        ("/evidence/observations/0/date", json!("2026-11-30")),
        ("/evidence/observations/0/amount/currency", json!("JPY")),
        ("/evidence/relationships/0/partial", json!(false)),
        ("/evidence/receipts/0/tenders/0/partial", json!(false)),
    ] {
        let mut input = fixture();
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(derive(input).is_err(), "{pointer}");
    }
    let mut input = fixture();
    let mut duplicate = input["evidence"]["relationships"][0].clone();
    duplicate["id"] = json!("duplicate-funding");
    input["evidence"]["relationships"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert!(derive(input).is_err());
}
#[test]
fn confirmed_selection_can_resolve_identical_unconnected_candidates_without_consuming_them() {
    let mut input = fixture();
    let mut competing = input["evidence"]["observations"][0].clone();
    competing["id"] = json!("other-bank");
    competing["ledgerTransactionId"] = json!("other-parent");
    competing["provenance"]["documentId"] = json!("other-source");
    input["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(competing);
    let result = derive(input).unwrap();
    assert_eq!(result["ledgerTransactionId"], "actual-bank-1");
    assert_eq!(result["sources"].as_array().unwrap().len(), 3);
}
#[test]
fn duplicate_actual_identity_cannot_be_used_as_two_distinct_settlement_targets() {
    let mut input = fixture();
    let mut duplicate = input["evidence"]["observations"][0].clone();
    duplicate["id"] = json!("same-parent-duplicate");
    input["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert!(derive(input).is_err());
}

#[test]
fn exact_i64_boundary_is_preserved_and_overflow_is_rejected() {
    let mut input = fixture();
    input["evidence"]["observations"][0]["amount"]["minorUnits"] = json!(i64::MAX.to_string());
    for (index, amount) in [(0, i64::MAX - 1), (1, 1)] {
        input["evidence"]["observations"][index + 1]["amount"]["minorUnits"] =
            json!(amount.to_string());
        input["evidence"]["relationships"][index]["allocatedAmount"]["minorUnits"] =
            json!(amount.to_string());
        let receipt = &mut input["evidence"]["receipts"][index];
        receipt["total"]["minorUnits"] = json!(amount.to_string());
        receipt["tenders"][0]["amount"]["minorUnits"] = json!(amount.to_string());
        for field in ["unitGross", "gross", "net"] {
            receipt["lines"][0][field]["minorUnits"] = json!(amount.to_string());
        }
    }
    let plan = derive(input.clone()).unwrap();
    assert_eq!(
        plan["ledgerEffect"]["amount"]["minorUnits"],
        (-i64::MAX).to_string()
    );
    input["evidence"]["observations"][2]["amount"]["minorUnits"] = json!("2");
    input["evidence"]["relationships"][1]["allocatedAmount"]["minorUnits"] = json!("2");
    assert!(derive(input).unwrap_err().contains("overflow"));
}
#[test]
fn zero_net_promotional_lines_are_reviewed_without_zero_ledger_children() {
    let mut input = fixture();
    let mut line = input["evidence"]["receipts"][0]["lines"][0].clone();
    line["id"] = json!("zero-line");
    for field in ["unitGross", "gross", "net"] {
        line[field]["minorUnits"] = json!("0");
    }
    input["evidence"]["receipts"][0]["lines"]
        .as_array_mut()
        .unwrap()
        .push(line);
    input["lineCategories"]
        .as_array_mut()
        .unwrap()
        .push(json!({"receiptId":"receipt-1","lineId":"zero-line","categoryId":"gift"}));
    let plan = derive(input).unwrap();
    assert_eq!(plan["contributions"].as_array().unwrap().len(), 3);
    assert_eq!(plan["ledgerEffect"]["splits"].as_array().unwrap().len(), 2);
}
#[test]
fn plural_targets_need_an_explicit_line_to_target_matrix_and_never_greedy_category_assignment() {
    let mut input = fixture();
    let mut other = input["evidence"]["observations"][0].clone();
    input["evidence"]["observations"][0]["amount"]["minorUnits"] = json!("700");
    other["id"] = json!("bank-2");
    other["ledgerTransactionId"] = json!("actual-2");
    other["amount"]["minorUnits"] = json!("500");
    input["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(other);
    input["evidence"]["relationships"][1]["allocatedAmount"]["minorUnits"] = json!("300");
    let mut extra = input["evidence"]["relationships"][1].clone();
    extra["id"] = json!("other-funding");
    extra["toId"] = json!("bank-2");
    extra["allocatedAmount"]["minorUnits"] = json!("500");
    input["evidence"]["relationships"]
        .as_array_mut()
        .unwrap()
        .push(extra);
    for receipt in input["evidence"]["receipts"].as_array_mut().unwrap() {
        receipt["tenders"][0]["observationId"] = Value::Null;
    }
    assert!(derive(input).is_err());
}
#[test]
fn unsupported_scope_and_malformed_claims_are_bounded_before_aggregation() {
    for (field, value) in [
        ("contractVersion", json!("2")),
        ("targetObservationId", json!(" ")),
        ("receiptIds", json!(vec!["receipt"; 101])),
        (
            "lineCategories",
            json!(vec![
                json!({"receiptId":"receipt","lineId":"line","categoryId":"category"});
                10001
            ]),
        ),
    ] {
        let mut input = fixture();
        input[field] = value;
        assert!(derive(input).is_err(), "{field}");
    }
    let mut input = fixture();
    input["ledgerEffect"] = json!({});
    assert!(derive(input).is_err());
}

#[test]
fn native_plan_matches_the_shared_canonical_contract_fixture() {
    let expected: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/evidence-settlement-plan-result.json"
    ))
    .unwrap();
    assert_eq!(derive(fixture()).unwrap(), expected);
}
