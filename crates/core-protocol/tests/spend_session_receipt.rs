use balanceframe_core_protocol::{
    compare_spend_session_receipt, CompareSpendSessionReceiptRequest,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/fixtures/spend-session-receipt.json"
    ))
    .unwrap()
}
fn rehash(value: &mut Value) {
    let hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value["sessionSnapshot"]["intent"]).unwrap())
    );
    value["sessionSnapshot"]["intentHash"] = json!(hash);
    value["sessionSnapshot"]["contentHash"] = value["sessionSnapshot"]["intentHash"].clone();
}
fn compare(value: Value) -> Result<Value, String> {
    let input: CompareSpendSessionReceiptRequest =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    compare_spend_session_receipt(&input)
        .map_err(|error| error.to_string())
        .and_then(|result| serde_json::to_value(result).map_err(|error| error.to_string()))
}
#[test]
fn compares_only_reviewed_receipt_facts_without_settling_planned_prices() {
    let result = compare(fixture()).unwrap();
    assert_eq!(result["authority"], "comparison_only");
    assert_eq!(result["state"], "complete");
    assert_eq!(result["rows"][0]["status"], "matched");
    assert_eq!(result["rows"][0]["changes"], json!([]));
    assert_eq!(result["rows"][1]["status"], "omitted");
    assert_eq!(result["receiptTotal"]["minorUnits"], "1200");
    assert!(result.get("ledgerEffect").is_none());
    assert!(result.get("projectionObservation").is_none());
    assert_eq!(result["comparisonHash"].as_str().unwrap().len(), 64);
}
#[test]
fn unreviewed_identifier_matches_are_candidates_and_identical_identifiers_remain_ambiguous() {
    let mut input = fixture();
    input["review"]["pairs"] = json!([]);
    input["review"]["omittedItemIds"] = json!([]);
    let result = compare(input.clone()).unwrap();
    assert_eq!(result["state"], "review_required");
    assert_eq!(result["candidates"].as_array().unwrap().len(), 1);
    let mut duplicate = input["sessionSnapshot"]["intent"]["items"][0].clone();
    duplicate["id"] = json!("same-sku-item");
    input["sessionSnapshot"]["intent"]["items"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    rehash(&mut input);
    let result = compare(input).unwrap();
    assert_eq!(result["candidates"].as_array().unwrap().len(), 2);
    assert!(result["candidates"].as_array().unwrap().iter().all(
        |item| item["reasonCodes"] == json!(["identifier_text_match", "ambiguous_identifier"])
    ));
    assert!(result["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["status"] == "unresolved"));
}
#[test]
fn explicit_substitutions_quantities_and_price_bases_preserve_reference_provenance() {
    let mut input = fixture();
    input["review"]["pairs"][0]["kind"] = json!("substitution");
    input["sessionSnapshot"]["intent"]["items"][0]["quantity"] = json!(1);
    input["sessionSnapshot"]["intent"]["items"][0]["amount"]["minorUnits"] = json!("500");
    rehash(&mut input);
    let result = compare(input.clone()).unwrap();
    assert_eq!(result["rows"][0]["status"], "substituted");
    assert_eq!(
        result["rows"][0]["changes"],
        json!(["quantity_changed", "reference_price_changed"])
    );
    assert_eq!(result["rows"][0]["priceBasis"], "unit_amount_vs_unit_gross");
    assert_eq!(result["receiptTotal"]["minorUnits"], "1200");
    input["sessionSnapshot"]["intent"]["items"][0]
        .as_object_mut()
        .unwrap()
        .remove("quantity");
    rehash(&mut input);
    let result = compare(input).unwrap();
    assert_eq!(result["rows"][0]["quantityComparison"], "unknown");
    assert_eq!(result["rows"][0]["priceBasis"], "line_amount_vs_line_gross");
    assert_eq!(result["rows"][0]["changes"], json!(["line_amount_changed"]));
}
#[test]
fn invalid_receipts_and_nonpurchase_sources_cannot_produce_completed_comparisons() {
    for (pointer, value) in [
        ("/evidence/receipts/0/lines/0/net/minorUnits", json!("1")),
        ("/evidence/observations/0/status", json!("pending")),
        ("/evidence/observations/0/direction", json!("inflow")),
    ] {
        let mut input = fixture();
        *input.pointer_mut(pointer).unwrap() = value;
        let result = compare(input).unwrap();
        assert_eq!(result["state"], "blocked");
        assert_eq!(result["rows"], json!([]));
    }
    let mut refund = fixture();
    refund["evidence"]["observations"][0]["eventType"] = json!("refund");
    refund["evidence"]["observations"][0]["direction"] = json!("inflow");
    assert_eq!(compare(refund).unwrap()["state"], "blocked");
}
#[test]
fn stale_hashes_forged_selectors_duplicate_mappings_and_partial_omissions_fail_closed() {
    for (pointer, value) in [
        ("/sessionSnapshot/intentHash", json!("a".repeat(64))),
        ("/sessionSnapshot/contentHash", json!("b".repeat(64))),
        ("/receipt/documentId", json!("another-document")),
        ("/receipt/receiptId", json!("missing")),
        ("/review/pairs/0/sessionItemId", json!("missing")),
        ("/review/pairs/0/receiptLineId", json!("missing")),
        ("/review/coverage", json!("partial_purchase")),
    ] {
        let mut input = fixture();
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(compare(input).is_err(), "{pointer}");
    }
    let mut duplicate = fixture();
    let repeated = duplicate["review"]["pairs"][0].clone();
    duplicate["review"]["pairs"]
        .as_array_mut()
        .unwrap()
        .push(repeated);
    assert!(compare(duplicate).is_err());
    let mut forged = fixture();
    forged["sessionSnapshot"]["authenticated"] = json!(true);
    assert!(compare(forged).is_err());
}

#[test]
fn preserves_explicit_nullable_price_metadata_in_the_original_saved_intent_hash() {
    let mut input = fixture();
    input["sessionSnapshot"]["intent"]["items"][0]["priceProvenance"]["source"] = Value::Null;
    input["sessionSnapshot"]["intent"]["items"][0]["priceProvenance"]["store"] = Value::Null;
    rehash(&mut input);
    assert_eq!(compare(input).unwrap()["state"], "complete");
}

#[test]
fn current_typed_intent_cannot_diverge_from_archived_json() {
    let mut request: CompareSpendSessionReceiptRequest = serde_json::from_value(fixture()).unwrap();
    request.session_snapshot.intent.items[0].id = "mutated".into();
    assert!(compare_spend_session_receipt(&request)
        .unwrap_err()
        .0
        .contains("intent_changed"));
    let serialized = serde_json::to_value(request).unwrap();
    assert_eq!(
        serialized["sessionSnapshot"]["intent"]["items"][0]["id"],
        "item-1"
    );
}
#[test]
fn reference_currency_estimate_and_absent_quantity_never_invent_settlement() {
    let mut input = fixture();
    input["sessionSnapshot"]["intent"]["items"][0]["amount"]["currency"] = json!("JPY");
    input["sessionSnapshot"]["intent"]["items"][0]["priceProvenance"]["estimate"] = json!(true);
    rehash(&mut input);
    let result = compare(input.clone()).unwrap();
    assert_eq!(result["state"], "review_required");
    assert_eq!(
        result["rows"][0]["reasonCodes"],
        json!(["currency_mismatch", "estimated_reference_price"])
    );
    input["sessionSnapshot"]["intent"]["items"][0]
        .as_object_mut()
        .unwrap()
        .remove("quantity");
    input["sessionSnapshot"]["intent"]["items"][0]["amount"] =
        json!({"minorUnits":"1200","currency":"USD"});
    rehash(&mut input);
    let result = compare(input).unwrap();
    assert_eq!(result["rows"][0]["priceComparison"], "same");
    assert_eq!(result["rows"][0]["quantityComparison"], "unknown");
}
#[test]
fn explicit_new_lines_and_partial_coverage_are_inspectable_and_no_mapping_is_inferred() {
    let mut input = fixture();
    input["review"]["pairs"] = json!([]);
    input["review"]["omittedItemIds"] = json!(["item-1", "item-omitted"]);
    input["review"]["newLineIds"] = json!(["line-1"]);
    let result = compare(input.clone()).unwrap();
    assert_eq!(result["state"], "complete");
    assert_eq!(result["rows"][2]["status"], "new");
    input["review"]["omittedItemIds"] = json!([]);
    input["review"]["coverage"] = json!("partial_purchase");
    let result = compare(input).unwrap();
    assert_eq!(result["state"], "review_required");
    assert_eq!(
        result["reasonCodes"],
        json!(["purchase_coverage_incomplete"])
    );
}
#[test]
fn invalid_session_metadata_and_unreviewed_endpoints_are_rejected() {
    for (pointer, value) in [
        ("/contractVersion", json!("2")),
        ("/sessionSnapshot/documentId", json!("")),
        ("/sessionSnapshot/parserVersion", json!("bad\nparser")),
        ("/sessionSnapshot/intent/kind", json!("forged")),
        ("/sessionSnapshot/intent/version", json!(0)),
        ("/sessionSnapshot/intent/accountId", json!(" ")),
        ("/sessionSnapshot/intent/items/0/categoryId", json!("")),
        (
            "/sessionSnapshot/intent/items/0/amount/minorUnits",
            json!("0"),
        ),
        (
            "/sessionSnapshot/intent/items/0/amount/currency",
            json!("usd"),
        ),
        (
            "/sessionSnapshot/intent/items/0/purchaseAt",
            json!("2026-02-30T00:00:00Z"),
        ),
        (
            "/sessionSnapshot/intent/items/0/requiredBy",
            json!("invalid"),
        ),
        ("/sessionSnapshot/intent/items/0/quantity", json!(0)),
        ("/sessionSnapshot/intent/items/0/priority", json!("urgent")),
        ("/sessionSnapshot/intent/items/0/barcode", json!(" ")),
        (
            "/sessionSnapshot/intent/items/0/priceProvenance/kind",
            json!("unknown"),
        ),
        (
            "/sessionSnapshot/intent/items/0/priceProvenance/observedAt",
            json!("bad"),
        ),
        ("/receipt/documentId", json!("")),
        ("/review/coverage", json!("automatic")),
        ("/review/pairs/0/kind", json!("automatic")),
    ] {
        let mut input = fixture();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        input
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(key.to_owned(), value);
        rehash(&mut input);
        assert!(compare(input).is_err(), "{pointer}");
    }
    for (field, value) in [
        ("categoryAllocations", json!([])),
        (
            "categoryAllocations",
            json!([{"categoryId":"cat","amount":{"minorUnits":"1","currency":"JPY"}}]),
        ),
        (
            "priceProvenance",
            json!({"kind":"outside_price","observedAt":"2026-10-15T00:00:00Z","estimate":false}),
        ),
    ] {
        let mut input = fixture();
        input["sessionSnapshot"]["intent"]["items"][0][field] = value;
        rehash(&mut input);
        assert!(compare(input).is_err(), "{field}");
    }
    for (field, values) in [
        ("omittedItemIds", json!(["missing"])),
        ("omittedItemIds", json!(["item-omitted", "item-omitted"])),
        ("newLineIds", json!(["missing"])),
        ("newLineIds", json!(["line-1"])),
    ] {
        let mut input = fixture();
        input["review"][field] = values;
        assert!(compare(input).is_err(), "{field}");
    }
}
#[test]
fn archive_metadata_arrays_are_validated_without_becoming_receipt_charges() {
    let mut input = fixture();
    input["sessionSnapshot"]["intent"]["items"][0]["categoryAllocations"] =
        json!([{"categoryId":"cat","amount":{"minorUnits":"600","currency":"USD"}}]);
    input["sessionSnapshot"]["intent"]["adjustments"] =
        json!([{"kind":"fee","categoryId":"cat","amount":{"minorUnits":"10","currency":"USD"}}]);
    input["sessionSnapshot"]["intent"]["warningThresholds"] = json!([{"id":"warning","basis":"category_charge","categoryId":"cat","maximum":{"minorUnits":"9999","currency":"USD"}}]);
    rehash(&mut input);
    assert_eq!(
        compare(input.clone()).unwrap()["receiptTotal"]["minorUnits"],
        "1200"
    );
    for (pointer, value) in [
        ("/sessionSnapshot/intent/adjustments/0/kind", json!("other")),
        (
            "/sessionSnapshot/intent/warningThresholds/0/basis",
            json!("other"),
        ),
        (
            "/sessionSnapshot/intent/warningThresholds/0/categoryId",
            Value::Null,
        ),
    ] {
        let mut invalid = input.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        rehash(&mut invalid);
        assert!(compare(invalid).is_err());
    }
    let item = input["sessionSnapshot"]["intent"]["items"][0].clone();
    input["sessionSnapshot"]["intent"]["items"] = json!([item.clone(), item]);
    rehash(&mut input);
    assert!(compare(input).is_err());
}
#[test]
fn canonical_review_order_does_not_change_comparison_identity_but_source_version_does() {
    let mut input = fixture();
    input["review"]["pairs"] = json!([]);
    input["review"]["newLineIds"] = json!(["line-1"]);
    input["review"]["omittedItemIds"] = json!(["item-1", "item-omitted"]);
    let first = compare(input.clone()).unwrap();
    input["review"]["omittedItemIds"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_eq!(
        first["comparisonHash"],
        compare(input.clone()).unwrap()["comparisonHash"]
    );
    input["sessionSnapshot"]["intent"]["version"] = json!(3);
    rehash(&mut input);
    assert_ne!(
        first["comparisonHash"],
        compare(input).unwrap()["comparisonHash"]
    );
}

#[test]
fn multiple_reviewed_pairs_have_canonical_order_and_reject_reused_actual_lines() {
    let mut input = fixture();
    input["evidence"]["receipts"][0]["lines"][0]["quantityMicros"] = json!(1000000);
    for field in ["gross", "net"] {
        input["evidence"]["receipts"][0]["lines"][0][field]["minorUnits"] = json!("600");
    }
    for field in ["discount", "tax"] {
        input["evidence"]["receipts"][0]["lines"][0][field]["minorUnits"] = json!("0");
        input["evidence"]["receipts"][0][field]["minorUnits"] = json!("0");
    }
    let mut line = input["evidence"]["receipts"][0]["lines"][0].clone();
    line["id"] = json!("line-2");
    input["evidence"]["receipts"][0]["lines"]
        .as_array_mut()
        .unwrap()
        .push(line);
    input["review"]["omittedItemIds"] = json!([]);
    input["review"]["pairs"].as_array_mut().unwrap().push(
        json!({"sessionItemId":"item-omitted","receiptLineId":"line-2","kind":"substitution"}),
    );
    let result = compare(input.clone()).unwrap();
    assert_eq!(result["state"], "complete");
    input["review"]["pairs"].as_array_mut().unwrap().reverse();
    assert_eq!(
        result["comparisonHash"],
        compare(input.clone()).unwrap()["comparisonHash"]
    );
    input["review"]["pairs"][0]["receiptLineId"] = json!("line-1");
    assert!(compare(input.clone()).is_err());
    input["review"]["pairs"] = json!([]);
    let result = compare(input).unwrap();
    assert_eq!(result["candidates"].as_array().unwrap().len(), 2);
    assert!(result["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["reasonCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("ambiguous_identifier"))));
}
#[test]
fn invalid_evidence_graph_is_rejected_instead_of_being_repaired_for_comparison() {
    let mut input = fixture();
    input["evidence"]["contractVersion"] = json!("2");
    assert!(compare(input).is_err());
    let mut input = fixture();
    input["evidence"]["receipts"][0]["observationId"] = json!("missing");
    assert!(compare(input).is_err());
}

#[test]
fn largest_integer_quantity_and_money_remain_exact_references() {
    let mut input = fixture();
    input["sessionSnapshot"]["intent"]["items"][0]["quantity"] = json!(u32::MAX);
    input["sessionSnapshot"]["intent"]["items"][0]["amount"]["minorUnits"] =
        json!(i64::MAX.to_string());
    rehash(&mut input);
    let result = compare(input).unwrap();
    assert_eq!(
        result["rows"][0]["plannedQuantityMicros"],
        json!(4294967295000000_u64)
    );
    assert_eq!(
        result["rows"][0]["plannedReference"]["minorUnits"],
        i64::MAX.to_string()
    );
    assert_eq!(result["receiptTotal"]["minorUnits"], "1200");
}
#[test]
fn superseded_receipt_cannot_complete_an_old_session_comparison() {
    let mut input = fixture();
    let mut replacement = input["evidence"]["receipts"][0].clone();
    replacement["id"] = json!("receipt-2");
    replacement["version"] = json!(2);
    replacement["observationId"] = json!("updated-observation");
    replacement["lines"][0]["id"] = json!("updated-line");
    let mut observation = input["evidence"]["observations"][0].clone();
    observation["id"] = json!("updated-observation");
    input["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(observation);
    replacement["supersedesId"] = json!("receipt-1");
    input["evidence"]["receipts"]
        .as_array_mut()
        .unwrap()
        .push(replacement);
    assert_eq!(compare(input).unwrap()["state"], "blocked");
}
#[test]
fn native_result_matches_the_shared_canonical_fixture() {
    let expected: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/spend-session-receipt-result.json"
    ))
    .unwrap();
    assert_eq!(compare(fixture()).unwrap(), expected);
}

#[test]
fn absent_optional_saved_metadata_is_distinct_from_invalid_explicit_null() {
    for field in ["quantity", "priority", "barcode", "categoryAllocations"] {
        let mut input = fixture();
        input["sessionSnapshot"]["intent"]["items"][0][field] = Value::Null;
        rehash(&mut input);
        assert!(compare(input).is_err(), "{field}");
    }
}
