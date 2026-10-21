use balanceframe_core_protocol::{
    derive_evidence_allocation_plan, resolve_transaction_evidence,
    DeriveEvidenceAllocationPlanRequest,
};
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/fixtures/evidence-allocation-plan.json"
    ))
    .unwrap()
}
fn derive(value: Value) -> Result<Value, String> {
    let request: DeriveEvidenceAllocationPlanRequest =
        serde_json::from_value(value).map_err(|e| e.to_string())?;
    derive_evidence_allocation_plan(&request)
        .map_err(|e| e.to_string())
        .map(|r| serde_json::to_value(r).unwrap())
}
fn publish(input: &Value, plan: &Value) -> Value {
    let mut evidence = input["evidence"].clone();
    evidence["allocationReview"] = plan["review"].clone();
    for projection in plan["projections"].as_array().unwrap() {
        let target = projection["targetObservationId"].as_str().unwrap();
        let observation = evidence["observations"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|o| o["id"] == target)
            .unwrap();
        observation["ledgerEffect"] = projection["ledgerEffect"].clone();
        observation["reviewedLedgerEffect"] = json!(true);
    }
    evidence
}
#[test]
fn twelve_receipt_explicitly_funds_seven_and_five_with_two_parent_proofs() {
    let input = fixture();
    let plan = derive(input.clone()).unwrap();
    assert_eq!(plan["projections"].as_array().unwrap().len(), 2);
    assert_eq!(plan["remainders"], json!([]));
    let evidence = publish(&input, &plan);
    let result = resolve_transaction_evidence(&serde_json::from_value(evidence).unwrap()).unwrap();
    let output = serde_json::to_value(result).unwrap();
    assert!(output["events"][0]["projectionObservation"].is_null());
    assert_eq!(
        output["events"][0]["projectionObservations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        output["events"][0]["allocationSetHash"],
        plan["allocationSetHash"]
    );
    for (i, parent) in ["actual-bank-1", "actual-bank-2"].iter().enumerate() {
        assert_eq!(
            output["events"][0]["projectionObservations"][i]["scope"]["id"],
            json!(parent)
        );
    }
}
#[test]
fn changing_a_cell_or_missing_the_manifest_cannot_publish_multi_effects() {
    let input = fixture();
    let plan = derive(input.clone()).unwrap();
    let mut evidence = publish(&input, &plan);
    evidence["allocationReview"]["cells"][0]["amount"]["minorUnits"] = json!("699");
    assert!(
        resolve_transaction_evidence(&serde_json::from_value(evidence.clone()).unwrap()).is_err()
    );
    evidence.as_object_mut().unwrap().remove("allocationReview");
    let result = serde_json::to_value(
        resolve_transaction_evidence(&serde_json::from_value(evidence).unwrap()).unwrap(),
    )
    .unwrap();
    assert!(result["events"][0]["projectionObservation"].is_null());
    assert!(result["events"][0].get("projectionObservations").is_none());
}

fn two_by_two() -> Value {
    let old: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/evidence-settlement-plan.json"
    ))
    .unwrap();
    let mut input = fixture();
    input["evidence"]["receipts"] = old["evidence"]["receipts"].clone();
    input["evidence"]["observations"][1] = old["evidence"]["observations"][1].clone();
    input["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(old["evidence"]["observations"][2].clone());
    input["receiptIds"] = json!(["receipt-1", "receipt-2"]);
    input["lineCategories"] = old["lineCategories"].clone();
    input["cells"] = json!([]);
    input["evidence"]["relationships"] = json!([]);
    for (r, amounts) in [(0, [200, 200]), (1, [500, 300])] {
        input["evidence"]["receipts"][r]["tenders"] = json!([]);
        for (t, amount) in amounts.into_iter().enumerate() {
            let target = format!("bank-{}", t + 1);
            let receipt = format!("receipt-{}", r + 1);
            let money = json!({"minorUnits":amount.to_string(),"currency":"USD"});
            input["cells"].as_array_mut().unwrap().push(json!({"receiptId":receipt,"lineId":format!("line-{}",r+1),"targetObservationId":target,"amount":money}));
            input["evidence"]["receipts"][r]["tenders"].as_array_mut().unwrap().push(json!({"id":target,"kind":"card","observationId":target,"amount":money,"partial":true}));
            input["evidence"]["relationships"].as_array_mut().unwrap().push(json!({"id":format!("edge-{r}-{t}"),"fromId":format!("purchase-{}",r+1),"toId":target,"kind":"partial_funding","state":"confirmed","allocatedAmount":money,"partial":true,"score":100,"reasonCodes":[],"evidenceIds":[]}));
        }
    }
    input
}
#[test]
fn true_two_by_two_preserves_explicit_category_cells_and_global_source_capacity() {
    let input = two_by_two();
    let plan = derive(input.clone()).unwrap();
    assert_eq!(
        plan["projections"][0]["ledgerEffect"]["splits"],
        json!([{"categoryId":"food","amount":{"minorUnits":"-200","currency":"USD"}},{"categoryId":"household","amount":{"minorUnits":"-500","currency":"USD"}}])
    );
    assert_eq!(
        plan["projections"][1]["ledgerEffect"]["splits"][1]["amount"]["minorUnits"],
        "-300"
    );
    let output = serde_json::to_value(
        resolve_transaction_evidence(&serde_json::from_value(publish(&input, &plan)).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        output["events"][0]["projectionObservations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
fn partial() -> Value {
    let mut input = fixture();
    input["targetObservationIds"] = json!(["bank-1"]);
    input["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .pop();
    input["cells"].as_array_mut().unwrap().pop();
    input["evidence"]["relationships"]
        .as_array_mut()
        .unwrap()
        .pop();
    input["evidence"]["receipts"][0]["tenders"][1] = json!({"id":"gift","kind":"gift_card","amount":{"minorUnits":"500","currency":"USD"},"observationId":null});
    input
}
#[test]
fn independently_proven_bank_portion_keeps_gift_value_as_unresolved_remainder() {
    let input = partial();
    let plan = derive(input.clone()).unwrap();
    assert_eq!(plan["projections"].as_array().unwrap().len(), 1);
    assert_eq!(plan["remainders"][0]["amount"]["minorUnits"], "500");
    let output = serde_json::to_value(
        resolve_transaction_evidence(&serde_json::from_value(publish(&input, &plan)).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(output["events"][0]["state"], "blocked");
    assert_eq!(
        output["events"][0]["projectionObservation"]["ledgerEffect"]["amount"]["minorUnits"],
        "-700"
    );
    assert!(output["events"][0].get("projectionObservations").is_none());
}
#[test]
fn incomplete_target_is_never_projected_or_hidden_as_complete() {
    let mut input = partial();
    input["evidence"]["observations"][0]["amount"]["minorUnits"] = json!("800");
    input["evidence"]["receipts"][0]["tenders"][0]["partial"] = json!(true);
    let plan = derive(input.clone()).unwrap();
    assert_eq!(plan["projections"], json!([]));
    assert_eq!(plan["targetRemainders"][0]["amount"]["minorUnits"], "100");
    let evidence = publish(&input, &plan);
    let output = serde_json::to_value(
        resolve_transaction_evidence(&serde_json::from_value(evidence).unwrap()).unwrap(),
    )
    .unwrap();
    assert!(output["events"][0]["projectionObservation"].is_null());
}
#[test]
fn neither_gift_value_nor_a_known_other_card_can_fund_the_selected_bank() {
    for change in ["gift", "other"] {
        let mut input = partial();
        if change == "gift" {
            input["evidence"]["receipts"][0]["tenders"][0]["kind"] = json!("reward");
        } else {
            input["evidence"]["receipts"][0]["tenders"][0]["observationId"] = Value::Null;
            input["evidence"]["receipts"][0]["tenders"][0]["amount"]["minorUnits"] = json!("600");
            input["evidence"]["receipts"][0]["tenders"][1]["amount"]["minorUnits"] = json!("600");
        }
        assert!(derive(input).is_err(), "{change}");
    }
}
#[test]
fn row_capacity_is_checked_even_when_graph_target_columns_and_receipt_total_agree() {
    let mut input = fixture();
    let mut second = input["evidence"]["receipts"][0]["lines"][0].clone();
    second["id"] = json!("line-2");
    for line in [
        &mut input["evidence"]["receipts"][0]["lines"][0],
        &mut second,
    ] {
        for field in ["unitGross", "gross", "net"] {
            line[field]["minorUnits"] = json!("600");
        }
    }
    input["evidence"]["receipts"][0]["lines"]
        .as_array_mut()
        .unwrap()
        .push(second);
    input["lineCategories"]
        .as_array_mut()
        .unwrap()
        .push(json!({"receiptId":"receipt-1","lineId":"line-2","categoryId":"household"}));
    input["cells"][1]["lineId"] = json!("line-2");
    assert!(derive(input).unwrap_err().contains("line_capacity"));
}
#[test]
fn manifest_is_bound_to_sources_categories_targets_and_reviewed_financial_effects() {
    let input = fixture();
    let plan = derive(input.clone()).unwrap();
    for change in ["source", "category", "hash", "effect", "review", "missing"] {
        let mut evidence = publish(&input, &plan);
        match change {
            "source" => {
                evidence["observations"][1]["provenance"]["contentHash"] = json!("f".repeat(64))
            }
            "category" => {
                evidence["allocationReview"]["lineCategories"][0]["categoryId"] = json!("other")
            }
            "hash" => evidence["allocationReview"]["allocationSetHash"] = json!("f".repeat(64)),
            "effect" => evidence["observations"][0]["ledgerEffect"]["categoryId"] = json!("other"),
            "review" => evidence["observations"][0]["reviewedLedgerEffect"] = json!(false),
            _ => evidence["observations"][0]["ledgerEffect"] = Value::Null,
        }
        assert!(
            resolve_transaction_evidence(&serde_json::from_value(evidence).unwrap()).is_err(),
            "{change}"
        );
    }
}
#[test]
fn canonical_selection_and_cells_order_does_not_change_set_hash() {
    let input = two_by_two();
    let first = derive(input.clone()).unwrap();
    let mut reordered = input;
    for field in [
        "receiptIds",
        "targetObservationIds",
        "lineCategories",
        "cells",
    ] {
        reordered[field].as_array_mut().unwrap().reverse();
    }
    reordered["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_eq!(first, derive(reordered).unwrap());
}
#[test]
fn duplicate_cells_parents_and_graph_mismatch_fail_closed() {
    for change in [
        "cell",
        "parent",
        "edge",
        "target",
        "category",
        "duplicateReceipt",
        "currency",
        "negative",
    ] {
        let mut input = fixture();
        match change {
            "cell" => {
                let cell = input["cells"][0].clone();
                input["cells"].as_array_mut().unwrap().push(cell);
            }
            "parent" => {
                input["evidence"]["observations"][2]["ledgerTransactionId"] =
                    json!("actual-bank-1");
            }
            "edge" => input["cells"][0]["amount"]["minorUnits"] = json!("699"),
            "target" => input["cells"][0]["targetObservationId"] = json!("unknown"),
            "category" => input["lineCategories"] = json!([]),
            "duplicateReceipt" => input["receiptIds"] = json!(["receipt-1", "receipt-1"]),
            "currency" => input["cells"][0]["amount"]["currency"] = json!("JPY"),
            _ => input["cells"][0]["amount"]["minorUnits"] = json!("-1"),
        };
        assert!(derive(input).is_err(), "{change}");
    }
}

#[test]
fn incompatible_existing_purposes_are_not_silently_reclassified_as_receipt_purchases() {
    for purpose in ["fee", "p2p_payment", "rent_contribution"] {
        let mut input = fixture();
        input["evidence"]["observations"][0]["eventType"] = json!(purpose);
        assert!(derive(input).is_err(), "{purpose}");
    }
}
#[test]
fn every_matrix_proof_carries_the_exact_inspectable_manifest_and_same_global_source_hash() {
    let input = fixture();
    let plan = derive(input.clone()).unwrap();
    let output = serde_json::to_value(
        resolve_transaction_evidence(&serde_json::from_value(publish(&input, &plan)).unwrap())
            .unwrap(),
    )
    .unwrap();
    for proof in output["events"][0]["projectionObservations"]
        .as_array()
        .unwrap()
    {
        assert_eq!(proof["allocationReview"], plan["review"]);
        let parsed =
            serde_json::from_value::<balanceframe_core_protocol::SourceObservation>(proof.clone())
                .unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), *proof);
        assert_eq!(proof["contentHash"], output["resolutionHash"]);
        assert!(proof["allocationReview"].get("rawDescription").is_none());
        let mut invalid = proof.clone();
        invalid["allocationReview"] = Value::Null;
        assert!(
            serde_json::from_value::<balanceframe_core_protocol::SourceObservation>(invalid)
                .is_err()
        );
    }
}
#[test]
fn unknown_wallet_dependencies_remain_blocking_while_unrelated_unknown_wallet_does_not_spread() {
    let mut input = partial();
    input["evidence"]["wallets"] = json!([{"walletId":"wallet","currency":"USD","openingBalance":null,"closingBalance":null,"completeActivity":false,"materializedAccountId":null,"requiresStoredValue":true}]);
    assert!(derive(input.clone()).is_ok());
    input["evidence"]["observations"][1]["walletId"] = json!("wallet");
    input["evidence"]["observations"][1]["fundingInstrumentId"] = json!("wallet");
    input["evidence"]["observations"][0]["fundingInstrumentId"] = Value::Null;
    assert!(derive(input).unwrap_err().contains("blocked"));
}

#[test]
fn planner_can_recompute_a_published_manifest_without_recursion_or_clearing_unselected_effects() {
    let mut input = fixture();
    let mut other = input["evidence"]["observations"][1].clone();
    other["id"] = json!("unselected-source");
    other["kind"] = json!("user_correction");
    other["sourceId"] = json!("unselected");
    other["amount"]["minorUnits"] = json!("100");
    other["reviewedLedgerEffect"] = json!(true);
    other["ledgerEffect"] = json!({"accountId":"checking","date":"2026-10-15","amount":{"minorUnits":"-100","currency":"USD"},"categoryId":"misc","payeeName":null,"notes":null,"splits":[]});
    input["evidence"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let plan = derive(input.clone()).unwrap();
    input["evidence"] = publish(&input, &plan);
    assert_eq!(derive(input.clone()).unwrap(), plan);
    let mut changed = input["evidence"].clone();
    changed["observations"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["ledgerEffect"]["categoryId"] = json!("other");
    assert!(
        resolve_transaction_evidence(&serde_json::from_value(changed).unwrap())
            .unwrap_err()
            .0
            .contains("source_changed")
    );
}
#[test]
fn malformed_selections_and_nonpurchase_sources_do_not_become_proofs() {
    for (field, value) in [
        ("contractVersion", json!("2")),
        ("receiptIds", json!([])),
        ("targetObservationIds", json!([])),
        ("receiptIds", json!(["missing"])),
        ("targetObservationIds", json!(["missing"])),
        ("cells", json!([])),
    ] {
        let mut input = fixture();
        input[field] = value;
        assert!(derive(input).is_err(), "{field}");
    }
    for (pointer, value) in [
        ("/evidence/observations/0/reliability", json!(0)),
        ("/evidence/observations/0/status", json!("pending")),
        ("/evidence/observations/1/status", json!("pending")),
        ("/evidence/receipts/0/lines/0/net/minorUnits", json!("1199")),
        ("/lineCategories/0/categoryId", json!(" ")),
    ] {
        let mut input = fixture();
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(derive(input).is_err(), "{pointer}");
    }
}
#[test]
fn sources_cannot_be_split_across_unselected_group_nodes_and_metadata_is_preserved_only_as_reviewed_claim(
) {
    let mut input = fixture();
    input["targetObservationIds"] = json!(["bank-1"]);
    input["cells"].as_array_mut().unwrap().pop();
    assert!(derive(input).unwrap_err().contains("unselected_group"));
    let input = fixture();
    let plan = derive(input.clone()).unwrap();
    let mut evidence = publish(&input, &plan);
    evidence["observations"][0]["ledgerEffect"]["notes"] =
        json!("Existing metadata preserved by the governed amendment verifier");
    let output = serde_json::to_value(
        resolve_transaction_evidence(&serde_json::from_value(evidence).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(
        output["events"][0]["projectionObservations"][0]["ledgerEffect"]["notes"],
        "Existing metadata preserved by the governed amendment verifier"
    );
}

#[test]
fn canonical_allocation_plan_and_manifest_proofs_match_cross_language_fixtures() {
    let input = fixture();
    let plan = derive(input.clone()).unwrap();
    let expected: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/evidence-allocation-plan-result.json"
    ))
    .unwrap();
    assert_eq!(plan, expected);
    let resolved = serde_json::to_value(
        resolve_transaction_evidence(&serde_json::from_value(publish(&input, &plan)).unwrap())
            .unwrap(),
    )
    .unwrap();
    let expected: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/evidence-allocation-resolution.json"
    ))
    .unwrap();
    assert_eq!(resolved, expected);
}

#[test]
fn explicit_matrix_can_build_checked_funding_relationships_without_client_sums() {
    let mut input = fixture();
    input["evidence"]["relationships"] = json!([]);
    input["deriveFundingRelationships"] = json!(true);
    let plan = derive(input.clone()).unwrap();
    let edges = plan["fundingRelationships"].as_array().unwrap();
    assert_eq!(edges.len(), 2);
    assert_eq!(edges[0]["allocatedAmount"]["minorUnits"], "700");
    assert_eq!(edges[1]["allocatedAmount"]["minorUnits"], "500");
    assert_eq!(edges[0]["state"], "confirmed");
    input["evidence"]["relationships"] = plan["fundingRelationships"].clone();
    let result =
        resolve_transaction_evidence(&serde_json::from_value(publish(&input, &plan)).unwrap())
            .unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap()["events"][0]["projectionObservations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let duplicate = input["cells"][0].clone();
    input["cells"].as_array_mut().unwrap().push(duplicate);
    assert!(derive(input).is_err());
}

#[test]
fn bounded_inputs_cannot_amplify_one_manifest_into_a_million_published_cells() {
    let mut input = fixture();
    let source = input["evidence"]["observations"][1].clone();
    let target = input["evidence"]["observations"][0].clone();
    let observations = input["evidence"]["observations"].as_array_mut().unwrap();
    observations.clear();
    observations.push(source);
    for index in 0..100 {
        let mut value = target.clone();
        value["id"] = json!(format!("bank-{index}"));
        value["ledgerTransactionId"] = json!(format!("parent-{index}"));
        value["amount"]["minorUnits"] = json!("100");
        observations.push(value);
    }
    input["evidence"]["observations"][0]["amount"]["minorUnits"] = json!("10000");
    input["evidence"]["relationships"] = json!([]);
    input["deriveFundingRelationships"] = json!(true);
    input["targetObservationIds"] =
        json!((0..100).map(|i| format!("bank-{i}")).collect::<Vec<_>>());
    let receipt = &mut input["evidence"]["receipts"][0];
    receipt["total"]["minorUnits"] = json!("10000");
    receipt["tenders"] = json!([{"id":"card","kind":"card","amount":{"minorUnits":"10000","currency":"USD"},"observationId":null,"partial":false}]);
    let line = receipt["lines"][0].clone();
    receipt["lines"] = json!((0..100)
        .map(|index| {
            let mut value = line.clone();
            value["id"] = json!(format!("line-{index}"));
            for field in ["unitGross", "gross", "net"] {
                value[field]["minorUnits"] = json!("100");
            }
            value
        })
        .collect::<Vec<_>>());
    input["lineCategories"]=json!((0..100).map(|index|json!({"receiptId":"receipt-1","lineId":format!("line-{index}"),"categoryId":"food"})).collect::<Vec<_>>());
    input["cells"]=json!((0..100).flat_map(|line|(0..100).map(move|target|json!({"receiptId":"receipt-1","lineId":format!("line-{line}"),"targetObservationId":format!("bank-{target}"),"amount":{"minorUnits":"1","currency":"USD"}}))).collect::<Vec<_>>());
    match derive(input) {
        Err(failure) => assert!(
            failure.contains("allocation_publication_limit"),
            "{failure}"
        ),
        Ok(_) => panic!("oversized published allocation was accepted"),
    };
}
