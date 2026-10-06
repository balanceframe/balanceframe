use balanceframe_financial_core::{
    analyze_merchant_intelligence, MerchantAnalysisRequest, MerchantAnalysisResult,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/fixtures/merchant-intelligence.json"
    ))
    .unwrap()
}

fn request() -> Value {
    let mut input = fixture()["request"].clone();
    input["sourceAdmission"]["sourceAccountIds"] =
        json!(["account-checking", "account-other", "account-private"]);
    let coverage = input["sourceAdmission"]["accountCoverage"][0].clone();
    for account in ["account-other", "account-private"] {
        let mut admitted = coverage.clone();
        admitted["accountId"] = json!(account);
        input["sourceAdmission"]["accountCoverage"]
            .as_array_mut()
            .unwrap()
            .push(admitted);
    }
    input
}

fn transaction(id: &str, date: &str, category: Option<&str>) -> Value {
    let mut tx = request()["transactions"][0].clone();
    tx["id"] = json!(id);
    tx["occurrenceId"] = json!(id);
    tx["importedId"] = json!(format!("import-{id}"));
    tx["date"] = json!(date);
    tx["categoryId"] = json!(category);
    tx
}

fn typed(input: &Value) -> MerchantAnalysisRequest {
    let mut normalized = input.clone();
    normalized["sourceAdmission"]["originalTransactionCount"] =
        json!(input["transactions"].as_array().unwrap().len());
    serde_json::from_value(normalized).unwrap()
}

fn analyze(input: &Value) -> Value {
    let result: MerchantAnalysisResult = analyze_merchant_intelligence(&typed(input)).unwrap();
    serde_json::to_value(result).unwrap()
}

fn suggestion<'a>(output: &'a Value, id: &str) -> &'a Value {
    output["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|suggestion| suggestion["transactionId"] == id)
        .expect("eligible source transaction must receive an explainable result")
}

fn recurrence(output: &Value) -> &Value {
    let recurrences = output["recurrences"].as_array().unwrap();
    assert_eq!(recurrences.len(), 1, "one scoped merchant group expected");
    &recurrences[0]
}

fn cadence(dates: &[&str]) -> Value {
    let mut input = request();
    input["transactions"] = Value::Array(
        dates
            .iter()
            .enumerate()
            .map(|(index, date)| transaction(&format!("tx-{index:02}"), date, None))
            .collect(),
    );
    input
}

fn history() -> Vec<Value> {
    ["2024-01-01", "2024-02-01", "2024-03-01"]
        .iter()
        .enumerate()
        .map(|(index, date)| transaction(&format!("history-{index}"), date, Some("category-food")))
        .collect()
}

fn rule(id: &str, category: &str) -> Value {
    json!({
        "id": id, "name": id, "order": 1, "inactive": false,
        "trigger": {"stage": null, "conditionsOp": "and", "conditions": [
            {"field": "payee", "op": "is", "value": "payee-market", "type": "id"}
        ]},
        "actions": [{"field": "category", "op": "set", "value": category, "type": "id"}]
    })
}

fn correction(category: &str, verified: bool) -> Value {
    json!({
        "transactionId": "tx-source", "payeeId": "payee-market", "accountId": "account-checking",
        "categoryId": category, "state": "confirmed", "verified": verified,
        "actorId": "actor-fixture", "version": 1
    })
}

fn alias(target: &str, state: &str) -> Value {
    json!({
        "id": format!("alias-{target}"), "sourceText": "  CORNER—MARKET  ",
        "sourceField": "importedPayee", "targetPayeeId": target, "accountId": "account-checking",
        "state": state, "actorId": "actor-fixture", "version": 1,
        "updatedAt": "2024-04-01T12:00:00Z", "sourceTransactionIds": ["tx-source"]
    })
}

#[test]
fn sparse_inputs_preserve_source_availability_and_raw_text_without_fabricated_category() {
    let input = request();
    let output = analyze(&input);
    assert_eq!(output["scope"], input["scope"]);
    assert_eq!(output["snapshotId"], input["snapshotId"]);
    assert_eq!(output["normalizationVersion"], "merchant/2");
    let found = suggestion(&output, "tx-source");
    assert_eq!(found["payeeId"], "payee-market");
    assert!(found["categoryId"].is_null());
    assert_eq!(found["tier"], "deterministic_match");
    assert!(found["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .any(|evidence| {
            evidence["kind"] == "source_observation"
                && evidence["field"] == "importedPayee"
                && evidence["rawText"] == "  CORNER—MARKET  "
        }));
    assert!(found["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .all(|evidence| {
            evidence["field"] != "description" && evidence["field"] != "verboseTitle"
        }));
    assert_eq!(serde_json::to_value(typed(&input)).unwrap(), input);
}

#[test]
fn missing_identity_and_empty_or_absent_source_text_abstain() {
    let mut input = request();
    input["transactions"][0]["payeeId"] = Value::Null;
    input["transactions"][0]["payeeName"] = Value::Null;
    input["transactions"][0]["importedPayee"] = json!({"state": "absent", "value": null});
    let output = analyze(&input);
    let found = suggestion(&output, "tx-source");
    assert_eq!(found["tier"], "insufficient_data");
    assert!(found["payeeId"].is_null() && found["categoryId"].is_null());
    input["transactions"][0]["importedPayee"] = json!({"state": "empty", "value": ""});
    assert_eq!(
        suggestion(&analyze(&input), "tx-source")["tier"],
        "insufficient_data"
    );
}

#[test]
fn stable_ids_survive_duplicate_display_names_and_display_renames() {
    let mut input = request();
    input["payees"][1]["name"] = json!("CORNER MARKET");
    input["rules"] = json!([rule("native", "category-bills")]);
    let output = analyze(&input);
    let found = suggestion(&output, "tx-source");
    assert_eq!(found["payeeId"], "payee-market");
    assert_eq!(found["categoryId"], "category-bills");
    input["payees"][0]["name"] = json!("Renamed Merchant");
    input["transactions"][0]["payeeName"] = json!("Renamed Merchant");
    let renamed = analyze(&input);
    assert_eq!(
        suggestion(&renamed, "tx-source")["categoryId"],
        "category-bills"
    );
    input["transactions"][0]["payeeId"] = Value::Null;
    input["transactions"][0]["payeeName"] = Value::Null;
    input["payees"][0]["name"] = json!("Corner Market");
    let ambiguous = analyze(&input);
    assert!(suggestion(&ambiguous, "tx-source")["payeeId"].is_null());
    assert!(suggestion(&ambiguous, "tx-source")["categoryId"].is_null());
}

#[test]
fn unique_normalized_imported_payee_resolves_without_claiming_category() {
    let mut input = request();
    input["transactions"][0]["payeeId"] = Value::Null;
    input["transactions"][0]["payeeName"] = Value::Null;
    input["transactions"][0]["importedPayee"]["value"] = json!("  ＣＯＲＮＥＲ—ＭＡＲＫＥＴ  ");
    let output = analyze(&input);
    let found = suggestion(&output, "tx-source");
    assert_eq!(found["payeeId"], "payee-market");
    assert!(found["categoryId"].is_null());
    assert_eq!(found["tier"], "deterministic_match");
}

#[test]
fn multi_field_known_secondary_identity_conflicts_without_aliases() {
    for field in ["description", "verboseTitle", "notes"] {
        let mut input = request();
        input["transactions"][0]["payeeId"] = Value::Null;
        input["transactions"][0]["payeeName"] = Value::Null;
        input["transactions"][0][field] = json!({"state": "present", "value": "OTHER—MARKET"});
        input["transactions"]
            .as_array_mut()
            .unwrap()
            .extend(history());
        let output = analyze(&input);
        let found = suggestion(&output, "tx-source");
        assert!(
            found["payeeId"].is_null(),
            "{field} must veto a different imported identity"
        );
        assert!(
            found["categoryId"].is_null(),
            "{field} conflict must not inherit category history"
        );
        assert_eq!(found["tier"], "conflicting", "{field}");
        assert!(found["reasonCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("identity_conflict")));
        assert!(
            found["contradictions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| { row["field"] == field && row["rawText"] == "OTHER—MARKET" }),
            "{field} contradiction must retain attributable source evidence"
        );
        assert_eq!(found["ruleCandidates"], json!([]));
    }
}

#[test]
fn multi_field_resolution_cache_isolates_secondary_fields_and_selected_pages() {
    for field in ["description", "verboseTitle", "notes"] {
        // Exercise both cache insertion orders, not just source input order (rows sort by ID).
        for conflict_first in [false, true] {
            let mut input = request();
            let mut same = transaction(
                if conflict_first {
                    "candidate-b"
                } else {
                    "candidate-a"
                },
                "2024-04-01",
                None,
            );
            same["payeeId"] = Value::Null;
            same["payeeName"] = Value::Null;
            same[field] = json!({"state": "present", "value": "Corner Market"});
            let mut different = same.clone();
            different["id"] = json!(if conflict_first {
                "candidate-a"
            } else {
                "candidate-b"
            });
            different["occurrenceId"] = different["id"].clone();
            different["importedId"] = json!("import-different");
            different[field]["value"] = json!("Other Market");
            let same_id = same["id"].as_str().unwrap();
            let different_id = different["id"].as_str().unwrap();
            input["transactions"] = json!([same, different]);
            input["transactions"]
                .as_array_mut()
                .unwrap()
                .extend(history());
            let full = analyze(&input);
            assert_eq!(
                suggestion(&full, same_id)["payeeId"],
                "payee-market",
                "{field}"
            );
            assert_eq!(
                suggestion(&full, same_id)["categoryId"],
                "category-food",
                "{field}"
            );
            assert_eq!(suggestion(&full, same_id)["supportCount"], 3, "{field}");
            assert!(
                suggestion(&full, different_id)["payeeId"].is_null(),
                "{field}"
            );
            assert!(
                suggestion(&full, different_id)["categoryId"].is_null(),
                "{field}"
            );
            assert_eq!(
                suggestion(&full, different_id)["tier"],
                "conflicting",
                "{field}"
            );
            for id in [same_id, different_id] {
                input["suggestionSelection"] =
                    json!({"transactionIds": [id], "cursor": null, "limit": 1});
                assert_eq!(
                    suggestion(&analyze(&input), id),
                    suggestion(&full, id),
                    "{field} selected page"
                );
            }
        }
    }
}

#[test]
fn multi_field_single_strong_source_resolves_but_notes_alone_do_not() {
    for field in ["importedPayee", "description", "verboseTitle", "notes"] {
        let mut input = request();
        input["transactions"][0]["payeeId"] = Value::Null;
        input["transactions"][0]["payeeName"] = Value::Null;
        input["transactions"][0]["importedPayee"] = json!({"state": "absent", "value": null});
        input["transactions"][0][field] =
            json!({"state": "present", "value": "  ＣＯＲＮＥＲ—ＭＡＲＫＥＴ  "});
        input["transactions"]
            .as_array_mut()
            .unwrap()
            .extend(history());
        input["rules"] = json!([rule("native", "category-bills")]);
        let output = analyze(&input);
        let found = suggestion(&output, "tx-source");
        if field == "notes" {
            // Free-form notes are weak: corroborate/veto a strong source, never establish identity.
            assert!(found["payeeId"].is_null() && found["categoryId"].is_null());
            assert_eq!(found["tier"], "insufficient_data");
        } else {
            assert_eq!(found["payeeId"], "payee-market", "{field}");
            assert_eq!(found["categoryId"], "category-food", "{field}");
            assert_eq!(found["tier"], "inferred", "{field}");
        }
        assert_eq!(
            found["ruleCandidates"],
            json!([]),
            "resolved text is not an actual stable payee"
        );
        assert!(output["nativeRuleClassifications"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| { row["transactionId"] != "tx-source" }));
    }
}

#[test]
fn multi_field_unknown_unavailable_and_rejected_secondary_sources_are_not_identity() {
    let mut input = request();
    input["transactions"][0]["payeeId"] = Value::Null;
    input["transactions"][0]["payeeName"] = Value::Null;
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .extend(history());
    for field in ["description", "verboseTitle", "notes"] {
        for source in [
            json!({"state": "present", "value": "private memo not a known merchant"}),
            json!({"state": "unavailable", "value": null}),
        ] {
            input["transactions"][0][field] = source;
            let output = analyze(&input);
            assert_eq!(
                suggestion(&output, "tx-source")["payeeId"],
                "payee-market",
                "{field}"
            );
            assert_eq!(
                suggestion(&output, "tx-source")["categoryId"],
                "category-food",
                "{field}"
            );
        }
        input["transactions"][0][field] = json!({"state": "absent", "value": null});
    }
    input["transactions"][0]["importedPayee"] = json!({"state": "absent", "value": null});
    input["transactions"][0]["description"] = json!({"state": "present", "value": "Corner Market"});
    let mut rejected = alias("payee-market", "rejected");
    rejected["sourceField"] = json!("description");
    input["aliases"] = json!([rejected]);
    let rejected = analyze(&input);
    assert!(suggestion(&rejected, "tx-source")["payeeId"].is_null());
    assert!(suggestion(&rejected, "tx-source")["categoryId"].is_null());
    input["aliases"] = json!([]);
    input["payees"][1]["name"] = json!("CORNER MARKET");
    let duplicate = analyze(&input);
    assert_eq!(suggestion(&duplicate, "tx-source")["tier"], "conflicting");
    assert!(suggestion(&duplicate, "tx-source")["payeeId"].is_null());
}

#[test]
fn multi_field_stable_identity_and_confirmed_decisions_precede_raw_name_conflicts() {
    let mut input = request();
    for field in ["description", "verboseTitle", "notes"] {
        input["transactions"][0][field] = json!({"state": "present", "value": "Other Market"});
    }
    input["rules"] = json!([rule("native", "category-bills")]);
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .extend(history());
    let stable = analyze(&input);
    assert_eq!(suggestion(&stable, "tx-source")["payeeId"], "payee-market");
    assert_eq!(
        suggestion(&stable, "tx-source")["categoryId"],
        "category-bills"
    );
    input["corrections"] = json!([correction("category-other", true)]);
    let corrected = analyze(&input);
    assert_eq!(
        suggestion(&corrected, "tx-source")["payeeId"],
        "payee-market"
    );
    assert_eq!(
        suggestion(&corrected, "tx-source")["categoryId"],
        "category-other"
    );
    assert_eq!(suggestion(&corrected, "tx-source")["tier"], "confirmed");
    input["transactions"][0]["payeeId"] = Value::Null;
    input["transactions"][0]["payeeName"] = Value::Null;
    input["aliases"] = json!([alias("payee-market", "accepted")]);
    let accepted = analyze(&input);
    assert_eq!(
        suggestion(&accepted, "tx-source")["payeeId"],
        "payee-market"
    );
    assert_eq!(
        suggestion(&accepted, "tx-source")["categoryId"],
        "category-other"
    );
    assert_eq!(suggestion(&accepted, "tx-source")["tier"], "confirmed");
    input["corrections"] = json!([]);
    let accepted = analyze(&input);
    assert_eq!(
        suggestion(&accepted, "tx-source")["payeeId"],
        "payee-market"
    );
    assert_eq!(
        suggestion(&accepted, "tx-source")["categoryId"],
        "category-food"
    );
    assert_eq!(
        suggestion(&accepted, "tx-source")["ruleCandidates"],
        json!([])
    );
}

#[test]
fn conflicting_confirmed_alias_does_not_rewrite_native_identity() {
    let mut input = request();
    input["aliases"] = json!([alias("payee-other", "accepted")]);
    let output = analyze(&input);
    let found = suggestion(&output, "tx-source");
    assert_eq!(found["payeeId"], "payee-market");
    assert_eq!(found["tier"], "conflicting");
    assert!(found["categoryId"].is_null());
    assert!(!found["contradictions"].as_array().unwrap().is_empty());
}

#[test]
fn alias_matching_is_field_and_account_scoped_and_rejection_suppresses_target() {
    let mut input = request();
    input["transactions"][0]["payeeId"] = Value::Null;
    input["transactions"][0]["payeeName"] = Value::Null;
    input["transactions"][0]["importedPayee"]["value"] = json!("Opaque Import");
    let mut mapping = alias("payee-other", "accepted");
    mapping["sourceText"] = json!("Opaque Import");
    input["aliases"] = json!([mapping.clone()]);
    assert_eq!(
        suggestion(&analyze(&input), "tx-source")["payeeId"],
        "payee-other"
    );
    mapping["sourceField"] = json!("notes");
    input["aliases"] = json!([mapping.clone()]);
    assert!(suggestion(&analyze(&input), "tx-source")["payeeId"].is_null());
    mapping["sourceField"] = json!("importedPayee");
    mapping["accountId"] = json!("account-other");
    input["aliases"] = json!([mapping.clone()]);
    assert!(suggestion(&analyze(&input), "tx-source")["payeeId"].is_null());
    mapping["accountId"] = json!("account-checking");
    mapping["state"] = json!("rejected");
    input["aliases"] = json!([mapping]);
    assert!(suggestion(&analyze(&input), "tx-source")["payeeId"].is_null());
}

#[test]
fn two_current_confirmed_alias_targets_abstain_instead_of_lexical_tie_break() {
    let mut input = request();
    input["transactions"][0]["payeeId"] = Value::Null;
    input["transactions"][0]["payeeName"] = Value::Null;
    input["aliases"] = json!([
        alias("payee-market", "accepted"),
        alias("payee-other", "accepted")
    ]);
    let output = analyze(&input);
    assert_eq!(suggestion(&output, "tx-source")["tier"], "conflicting");
    assert!(suggestion(&output, "tx-source")["payeeId"].is_null());
}

#[test]
fn confirmed_verified_correction_precedes_native_rule_and_history() {
    let mut input = request();
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .extend(history());
    input["rules"] = json!([rule("native", "category-bills")]);
    input["corrections"] = json!([correction("category-other", true)]);
    let output = analyze(&input);
    let found = suggestion(&output, "tx-source");
    assert_eq!(found["categoryId"], "category-other");
    assert_eq!(found["tier"], "confirmed");
    assert!(found["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["kind"] == "confirmed_decision"));
    assert!(!found["contradictions"].as_array().unwrap().is_empty());
    input["corrections"][0]["verified"] = json!(false);
    assert_eq!(
        suggestion(&analyze(&input), "tx-source")["categoryId"],
        "category-bills"
    );
    input["corrections"][0]["verified"] = json!(true);
    input["corrections"][0]["state"] = json!("revoked");
    assert_eq!(
        suggestion(&analyze(&input), "tx-source")["categoryId"],
        "category-bills"
    );
}

#[test]
fn contradictory_authoritative_categories_abstain_and_unsupported_rules_are_not_training() {
    let mut input = request();
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .extend(history());
    input["rules"] = json!([
        rule("native-a", "category-bills"),
        rule("native-b", "category-other")
    ]);
    let conflicting = analyze(&input);
    assert_eq!(suggestion(&conflicting, "tx-source")["tier"], "conflicting");
    assert!(suggestion(&conflicting, "tx-source")["categoryId"].is_null());
    input["rules"] = json!([]);
    let mut second = correction("category-bills", true);
    second["actorId"] = json!("second-actor");
    input["corrections"] = json!([correction("category-other", true), second]);
    assert_eq!(
        suggestion(&analyze(&input), "tx-source")["tier"],
        "conflicting"
    );
    input["corrections"] = json!([]);
    input["rules"] = json!([rule("unsupported", "category-bills")]);
    input["rules"][0]["trigger"]["conditions"][0]["op"] = json!("regex");
    let unsupported = analyze(&input);
    let found = suggestion(&unsupported, "tx-source");
    assert_eq!(found["categoryId"], "category-food");
    assert_eq!(found["tier"], "inferred");
    assert!(found["reasonCodes"]
        .as_array()
        .unwrap()
        .contains(&json!("unsupported_rule")));
}

#[test]
fn category_history_requires_three_observations_and_ninety_percent_consistency() {
    let mut input = request();
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .extend(history().into_iter().take(2));
    assert!(suggestion(&analyze(&input), "tx-source")["categoryId"].is_null());
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .push(history()[2].clone());
    assert_eq!(
        suggestion(&analyze(&input), "tx-source")["categoryId"],
        "category-food"
    );
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .push(transaction("dissent", "2024-03-02", Some("category-bills")));
    assert!(suggestion(&analyze(&input), "tx-source")["categoryId"].is_null());
    for index in 3..9 {
        input["transactions"]
            .as_array_mut()
            .unwrap()
            .push(transaction(
                &format!("support-{index}"),
                &format!("2024-03-{:02}", index + 1),
                Some("category-food"),
            ));
    }
    assert_eq!(
        suggestion(&analyze(&input), "tx-source")["categoryId"],
        "category-food"
    );
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .push(transaction(
            "dissent-two",
            "2024-03-20",
            Some("category-bills"),
        ));
    assert!(suggestion(&analyze(&input), "tx-source")["categoryId"].is_null());
}

#[test]
fn histories_do_not_cross_account_currency_direction_or_distinct_stable_payee() {
    for partition in ["account", "currency", "direction", "payee"] {
        let mut input = request();
        let mut observations = history();
        for observation in &mut observations {
            match partition {
                "account" => observation["accountId"] = json!("account-private"),
                "currency" => observation["amount"]["currency"] = json!("CAD"),
                "direction" => observation["amount"]["minorUnits"] = json!("100"),
                "payee" => observation["payeeId"] = json!("payee-other"),
                _ => unreachable!(),
            }
        }
        input["transactions"]
            .as_array_mut()
            .unwrap()
            .extend(observations);
        assert!(
            suggestion(&analyze(&input), "tx-source")["categoryId"].is_null(),
            "partition: {partition}"
        );
    }
}

#[test]
fn exclusions_and_identical_duplicate_evidence_do_not_inflate_support() {
    for exclusion in [
        "deleted",
        "pending",
        "uncleared",
        "transfer",
        "split-parent",
        "opening-balance",
    ] {
        let mut input = request();
        let mut observations = history();
        for observation in &mut observations {
            match exclusion {
                "deleted" => observation["deleted"] = json!(true),
                "pending" => observation["pending"] = json!(true),
                "uncleared" => observation["cleared"] = json!(false),
                "transfer" => observation["transferAccountId"] = json!("account-other"),
                "split-parent" => observation["isSplitParent"] = json!(true),
                "opening-balance" => observation["startingBalance"] = json!(true),
                _ => unreachable!(),
            }
        }
        input["transactions"]
            .as_array_mut()
            .unwrap()
            .extend(observations);
        let output = analyze(&input);
        assert!(
            suggestion(&output, "tx-source")["categoryId"].is_null(),
            "exclusion: {exclusion}"
        );
        assert_eq!(
            output["coverage"]["eligibleCount"], 1,
            "exclusion: {exclusion}"
        );
        assert_eq!(output["coverage"]["excludedCount"], 3);
    }
    let mut input = request();
    let observation = history()[0].clone();
    input["transactions"].as_array_mut().unwrap().extend([
        observation.clone(),
        observation.clone(),
        observation,
    ]);
    let output = analyze(&input);
    assert!(suggestion(&output, "tx-source")["categoryId"].is_null());
    assert_eq!(output["coverage"]["eligibleCount"], 2);
}

#[test]
fn flattened_split_children_are_counted_once_per_complete_parent() {
    let mut input = cadence(&["2024-01-31", "2024-02-29", "2024-03-31"]);
    let children = input["transactions"].as_array_mut().unwrap();
    let mut extra = Vec::new();
    for (index, child) in children.iter_mut().enumerate() {
        let parent_id = format!("parent-{index}");
        child["isSplitChild"] = json!(true);
        child["parentId"] = json!(parent_id);
        child["occurrenceId"] = json!(parent_id);
        let mut sibling = child.clone();
        sibling["id"] = json!(format!("sibling-{index}"));
        sibling["importedId"] = sibling["id"].clone();
        extra.push(sibling);
        let mut parent = transaction(&parent_id, child["date"].as_str().unwrap(), None);
        parent["isSplitParent"] = json!(true);
        parent["amount"]["minorUnits"] = json!("-200");
        extra.push(parent);
    }
    children.extend(extra);
    let output = analyze(&input);
    assert_eq!(output["coverage"]["eligibleCount"], 6);
    assert_eq!(recurrence(&output)["occurrences"], 3);
    assert_eq!(recurrence(&output)["minimumAmount"]["minorUnits"], "-200");
    for child in input["transactions"].as_array_mut().unwrap() {
        if child["isSplitChild"] == true {
            child["occurrenceComplete"] = json!(false);
        }
    }
    assert!(analyze(&input)["recurrences"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["tier"] == "insufficient_data"));
}

#[test]
fn two_observations_and_same_day_counts_do_not_establish_recurrence() {
    for dates in [
        vec!["2024-01-31", "2024-02-29"],
        vec!["2024-03-31", "2024-03-31", "2024-03-31"],
    ] {
        let output = analyze(&cadence(&dates));
        assert!(output["recurrences"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["tier"] == "insufficient_data"));
    }
}

#[test]
fn civil_month_end_and_leap_dates_produce_real_intervals_and_distribution_maps() {
    let input = cadence(&["2024-01-31", "2024-02-29", "2024-03-31"]);
    let typed_result = analyze_merchant_intelligence(&typed(&input)).unwrap();
    let day_map: &BTreeMap<String, u32> = &typed_result.recurrences[0].day_of_month;
    assert_eq!(day_map.get("31"), Some(&2));
    let period_map: &BTreeMap<String, u32> = &typed_result.recurrences[0]
        .occurrences_per_month
        .period_counts;
    assert_eq!(period_map.get("2024-02"), Some(&1));
    let output = serde_json::to_value(typed_result).unwrap();
    let found = recurrence(&output);
    assert_eq!(found["kind"], "observed");
    assert_eq!(found["frequency"], "monthly");
    assert_eq!(found["intervalDays"], json!([29, 31]));
    assert_eq!(found["dayOfMonth"], json!({"29": 1, "31": 2}));
    assert_eq!(found["dayOfWeek"], json!({"3": 1, "4": 1, "7": 1}));
    assert_eq!(
        found["occurrencesPerWeek"]["countDistribution"],
        json!({"0": 6, "1": 3})
    );
    assert_eq!(found["occurrencesPerWeek"]["averageNumerator"], "1");
    assert_eq!(found["occurrencesPerWeek"]["averageDenominator"], "3");
    assert_eq!(
        found["occurrencesPerMonth"]["periodCounts"],
        json!({"2024-01": 1, "2024-02": 1, "2024-03": 1})
    );
    assert_eq!(found["yearDistribution"], json!({"2024": 3}));
}

#[test]
fn weekly_biweekly_quarterly_and_annual_intervals_use_gregorian_arithmetic() {
    for (dates, expected, intervals) in [
        (
            vec!["2024-03-03", "2024-03-10", "2024-03-17"],
            "weekly",
            vec![7, 7],
        ),
        (
            vec!["2024-03-03", "2024-03-17", "2024-03-31"],
            "biweekly",
            vec![14, 14],
        ),
        (
            vec!["2024-01-31", "2024-04-30", "2024-07-31"],
            "quarterly",
            vec![90, 92],
        ),
        (
            vec!["2020-02-29", "2021-02-28", "2022-02-28"],
            "annual",
            vec![365, 365],
        ),
    ] {
        let output = analyze(&cadence(&dates));
        assert_eq!(recurrence(&output)["frequency"], expected);
        assert_eq!(recurrence(&output)["intervalDays"], json!(intervals));
    }
    let output = analyze(&cadence(&["2023-03-01", "2024-03-01", "2025-03-01"]));
    // A fixed asOfDate excludes future input rather than silently counting it.
    assert!(output["recurrences"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["tier"] == "insufficient_data"));
}

#[test]
fn multiple_within_month_phases_and_irregular_history_are_not_count_based_monthly() {
    let multiple = analyze(&cadence(&[
        "2024-01-01",
        "2024-01-05",
        "2024-02-01",
        "2024-02-05",
        "2024-03-01",
        "2024-03-05",
    ]));
    assert_eq!(recurrence(&multiple)["frequency"], "multiple");
    assert_eq!(
        recurrence(&multiple)["occurrencesPerMonth"]["countDistribution"],
        json!({"2": 3})
    );
    let irregular = analyze(&cadence(&["2024-01-01", "2024-01-11", "2024-03-27"]));
    assert_eq!(recurrence(&irregular)["frequency"], "irregular");
    assert_eq!(
        recurrence(&irregular)["occurrencesPerMonth"]["periodCounts"],
        json!({"2024-01": 2, "2024-02": 0, "2024-03": 1})
    );
}

#[test]
fn calendars_explain_first_business_day_without_claiming_bank_closure() {
    let mut input = cadence(&["2024-01-02", "2024-02-01", "2024-03-01", "2024-04-01"]);
    let output = analyze(&input);
    let found = recurrence(&output);
    assert_eq!(found["frequency"], "monthly");
    assert_eq!(found["calendarVersion"], "synthetic-calendar/1");
    assert!(found["reasonCodes"]
        .as_array()
        .unwrap()
        .contains(&json!("first_business_day")));
    assert!(found["reasonCodes"]
        .as_array()
        .unwrap()
        .contains(&json!("possible_holiday_shift")));
    assert!(!found["reasonCodes"]
        .as_array()
        .unwrap()
        .contains(&json!("confirmed_bank_closure")));
    let mut account = input["calendars"][0].clone();
    account["accountId"] = json!("account-checking");
    account["version"] = json!("account-calendar/2");
    input["calendars"].as_array_mut().unwrap().push(account);
    assert_eq!(
        recurrence(&analyze(&input))["calendarVersion"],
        "account-calendar/2"
    );
}

#[test]
fn missing_calendar_or_unsupported_year_degrades_to_ordinary_cadence() {
    for coverage in ["missing", "unsupported-year", "unknown-jurisdiction"] {
        let mut input = cadence(&["2024-01-31", "2024-02-29", "2024-03-31"]);
        match coverage {
            "missing" => input["calendars"] = json!([]),
            "unsupported-year" => input["calendars"][0]["coverageStart"] = json!("2025-01-01"),
            "unknown-jurisdiction" => input["calendars"][0]["jurisdiction"] = json!("ZZ"),
            _ => unreachable!(),
        }
        let output = analyze(&input);
        let found = recurrence(&output);
        assert_eq!(found["frequency"], "monthly");
        assert!(found["calendarVersion"].is_null());
        assert!(found["reasonCodes"]
            .as_array()
            .unwrap()
            .contains(&json!("calendar_unknown")));
    }
}

#[test]
fn recurrence_groups_never_mix_currency_account_or_refund_direction() {
    let mut input = cadence(&["2024-01-31", "2024-02-29", "2024-03-31"]);
    let originals = input["transactions"].as_array().unwrap().clone();
    for (partition, currency, account, amount) in [
        ("cad", "CAD", "account-checking", "-100"),
        ("other-account", "USD", "account-other", "-100"),
        ("refund", "USD", "account-checking", "100"),
    ] {
        for mut tx in originals.clone() {
            tx["id"] = json!(format!("{partition}-{}", tx["id"].as_str().unwrap()));
            tx["importedId"] = tx["id"].clone();
            tx["occurrenceId"] = tx["id"].clone();
            tx["amount"]["currency"] = json!(currency);
            tx["amount"]["minorUnits"] = json!(amount);
            tx["accountId"] = json!(account);
            input["transactions"].as_array_mut().unwrap().push(tx);
        }
    }
    let output = analyze(&input);
    assert_eq!(output["recurrences"].as_array().unwrap().len(), 4);
    for found in output["recurrences"].as_array().unwrap() {
        assert_eq!(found["occurrences"], 3);
        assert_eq!(found["frequency"], "monthly");
    }
}

#[test]
fn amount_range_and_variance_are_exact_minor_unit_rationals() {
    let mut input = cadence(&["2024-01-31", "2024-02-29", "2024-03-31"]);
    for (index, tx) in input["transactions"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        tx["amount"]["minorUnits"] = json!((-(index as i64 + 1) * 100).to_string());
        tx["amount"]["currency"] = json!("JPY");
    }
    let output = analyze(&input);
    let found = recurrence(&output);
    assert_eq!(
        found["minimumAmount"],
        json!({"minorUnits": "-300", "currency": "JPY"})
    );
    assert_eq!(
        found["maximumAmount"],
        json!({"minorUnits": "-100", "currency": "JPY"})
    );
    assert_eq!(found["varianceNumerator"], "20000");
    assert_eq!(found["varianceDenominator"], "3");
}

#[test]
fn equal_signed_i64_extrema_do_not_spuriously_overflow_and_zero_is_not_cadence() {
    for amount in [i64::MIN, i64::MAX] {
        let mut input = cadence(&["2024-01-31", "2024-02-29", "2024-03-31"]);
        for tx in input["transactions"].as_array_mut().unwrap() {
            tx["amount"]["minorUnits"] = json!(amount.to_string());
        }
        let output = analyze(&input);
        let found = recurrence(&output);
        assert_eq!(found["minimumAmount"]["minorUnits"], amount.to_string());
        assert_eq!(found["varianceNumerator"], "0");
        assert_eq!(found["varianceDenominator"], "1");
    }
    let mut zero = cadence(&["2024-01-31", "2024-02-29", "2024-03-31"]);
    for tx in zero["transactions"].as_array_mut().unwrap() {
        tx["amount"]["minorUnits"] = json!("0");
    }
    assert!(analyze(&zero)["recurrences"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["tier"] == "insufficient_data"));
}

#[test]
fn irreducible_i128_statistics_overflow_is_explicit_not_a_fake_zero() {
    let mut input = cadence(&[
        "2024-01-31",
        "2024-02-29",
        "2024-03-31",
        "2024-04-30",
        "2024-05-31",
        "2024-06-30",
        "2024-07-31",
    ]);
    for (index, tx) in input["transactions"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        tx["amount"]["minorUnits"] = json!(if index < 3 {
            i64::MIN.to_string()
        } else {
            "-2".into()
        });
    }
    let output = analyze(&input);
    let found = recurrence(&output);
    assert_eq!(found["minimumAmount"]["minorUnits"], i64::MIN.to_string());
    assert_eq!(found["maximumAmount"]["minorUnits"], "-2");
    assert!(found["varianceNumerator"].is_null() && found["varianceDenominator"].is_null());
    assert!(found["reasonCodes"]
        .as_array()
        .unwrap()
        .contains(&json!("amount_statistics_overflow")));
}

#[test]
fn bounded_evidence_preserves_full_statistics_and_explicit_horizon_coverage() {
    let mut input = cadence(&[
        "2024-01-31",
        "2024-02-29",
        "2024-03-31",
        "2024-04-30",
        "2024-05-31",
    ]);
    input["maxEvidence"] = json!(2);
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .push(transaction("too-old", "2018-01-31", Some("category-food")));
    let output = analyze(&input);
    assert_eq!(output["coverage"]["inputCount"], 6);
    assert_eq!(output["coverage"]["eligibleCount"], 5);
    assert_eq!(output["coverage"]["excludedCount"], 1);
    assert_eq!(output["coverage"]["startDate"], "2024-01-31");
    assert_eq!(output["coverage"]["endDate"], "2024-05-31");
    let found = recurrence(&output);
    assert_eq!(found["occurrences"], 5);
    assert_eq!(found["transactionIds"].as_array().unwrap().len(), 2);
    assert_eq!(found["dates"].as_array().unwrap().len(), 2);
    assert_eq!(found["intervalDays"].as_array().unwrap().len(), 2);
    assert_eq!(
        found["intervalDistribution"],
        json!({"29": 1, "30": 1, "31": 2})
    );
    assert_eq!(found["dayOfMonth"], json!({"29": 1, "30": 1, "31": 3}));
    assert!(output["suggestions"].as_array().unwrap().iter().all(|s| {
        s["evidence"].as_array().unwrap().len() <= 2
            && s["contradictions"].as_array().unwrap().len() <= 2
    }));
}

#[test]
fn input_permutation_is_deterministic_and_source_versions_change_revisions() {
    let mut input = cadence(&["2024-01-02", "2024-02-01", "2024-03-01"]);
    input["aliases"] = json!([alias("payee-market", "accepted")]);
    input["aliases"][0]["sourceTransactionIds"] = json!(["tx-00", "tx-01", "tx-02"]);
    input["rules"] = json!([rule("native", "category-bills")]);
    let expected = analyze(&input);
    input["transactions"].as_array_mut().unwrap().reverse();
    input["payees"].as_array_mut().unwrap().reverse();
    input["categories"].as_array_mut().unwrap().reverse();
    assert_eq!(analyze(&input), expected);
    let original_revision = recurrence(&expected)["evidenceRevision"].clone();
    for version in ["calendar", "alias"] {
        let mut changed = input.clone();
        match version {
            "calendar" => changed["calendars"][0]["version"] = json!("synthetic-calendar/2"),
            "alias" => changed["aliases"][0]["version"] = json!(2),
            _ => unreachable!(),
        }
        let updated = analyze(&changed);
        assert_ne!(
            recurrence(&updated)["evidenceRevision"],
            original_revision,
            "version: {version}"
        );
        assert_ne!(
            suggestion(&updated, "tx-00")["evidenceRevision"],
            suggestion(&expected, "tx-00")["evidenceRevision"]
        );
        assert_eq!(
            suggestion(&updated, "tx-00")["categoryId"],
            "category-bills"
        );
    }
}

#[test]
fn refreshed_capture_provenance_does_not_change_semantic_evidence_revisions() {
    let input = cadence(&["2024-01-02", "2024-02-01", "2024-03-01"]);
    let original = analyze(&input);
    let mut refreshed = input.clone();
    refreshed["snapshotId"] = json!("snapshot-refreshed");
    refreshed["sourceAdmission"]["capturedAt"] = json!("2024-04-01T12:01:00Z");
    refreshed["sourceAdmission"]["expiresAt"] = json!("2024-04-01T12:06:00Z");
    let output = analyze(&refreshed);
    assert_eq!(output["snapshotId"], "snapshot-refreshed");
    assert_eq!(
        output["sourceAdmission"]["capturedAt"],
        refreshed["sourceAdmission"]["capturedAt"]
    );
    assert_eq!(
        output["sourceAdmission"]["expiresAt"],
        refreshed["sourceAdmission"]["expiresAt"]
    );
    assert_eq!(
        recurrence(&output)["evidenceRevision"],
        recurrence(&original)["evidenceRevision"]
    );
    for row in original["suggestions"].as_array().unwrap() {
        assert_eq!(
            suggestion(&output, row["transactionId"].as_str().unwrap())["evidenceRevision"],
            row["evidenceRevision"]
        );
    }
}

#[test]
fn invalid_dates_and_conflicting_duplicate_ids_fail_instead_of_becoming_evidence() {
    for date in [
        "2023-02-29",
        "2024-02-30",
        "2024-13-01",
        "2024-01-01T00:00:00Z",
    ] {
        let mut input = request();
        input["transactions"][0]["date"] = json!(date);
        match serde_json::from_value::<MerchantAnalysisRequest>(input) {
            Err(_) => {}
            Ok(request) => assert!(
                analyze_merchant_intelligence(&request).is_err(),
                "date: {date}"
            ),
        }
    }
    let mut input = request();
    let mut conflicting = input["transactions"][0].clone();
    conflicting["amount"]["minorUnits"] = json!("-200");
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .push(conflicting);
    match serde_json::from_value::<MerchantAnalysisRequest>(input) {
        Err(_) => {}
        Ok(request) => assert!(analyze_merchant_intelligence(&request).is_err()),
    }
    let mut input = request();
    let mut conflicting = transaction("different-ledger-id", "2024-03-31", None);
    conflicting["importedId"] = input["transactions"][0]["importedId"].clone();
    conflicting["amount"]["minorUnits"] = json!("-300");
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .push(conflicting);
    match serde_json::from_value::<MerchantAnalysisRequest>(input) {
        Err(_) => {}
        Ok(request) => assert!(analyze_merchant_intelligence(&request).is_err()),
    }
}

#[test]
fn schedules_remain_lossless_expectations_and_do_not_replace_observed_recurrence() {
    let mut input = cadence(&["2024-01-31", "2024-02-29", "2024-03-31"]);
    let source = fixture()["recurrenceResult"]["scheduledExpectations"][0]["source"].clone();
    input["schedules"] = json!([{"payeeId": "payee-market", "source": source}]);
    let output = analyze(&input);
    assert_eq!(recurrence(&output)["kind"], "observed");
    assert_eq!(recurrence(&output)["occurrences"], 3);
    assert_eq!(output["scheduledExpectations"].as_array().unwrap().len(), 1);
    assert_eq!(output["scheduledExpectations"][0]["source"], source);
    assert!(output["scheduledExpectations"][0]
        .get("varianceNumerator")
        .is_none());
    assert!(output["scheduledExpectations"][0]
        .get("transactionIds")
        .is_none());
    input["schedules"][0]["source"]["certainty"] = json!("unknown");
    input["schedules"][0]["source"]["minimum"] = Value::Null;
    input["schedules"][0]["source"]["maximum"] = Value::Null;
    let uncertain = analyze(&input);
    assert!(uncertain["scheduledExpectations"][0]["source"]["amount"].is_null());
    assert_eq!(
        uncertain["scheduledExpectations"][0]["source"]["certainty"],
        "unknown"
    );
}

#[test]
fn rejected_pattern_survives_changed_calendar_and_snapshot_without_reconfirmation() {
    let mut input = cadence(&["2024-01-31", "2024-02-29", "2024-03-31"]);
    let original = analyze(&input);
    let pattern_id = recurrence(&original)["id"].clone();
    input["patternDecisions"] = json!([{
        "id": "decision-pattern", "patternId": pattern_id, "state": "rejected",
        "actorId": "actor-fixture", "version": 1, "updatedAt": "2024-04-01T12:00:00Z"
    }]);
    let rejected = analyze(&input);
    assert_eq!(recurrence(&rejected)["decisionState"], "rejected");
    assert!(recurrence(&rejected)["reasonCodes"]
        .as_array()
        .unwrap()
        .contains(&json!("pattern_rejected")));
    input["calendars"][0]["version"] = json!("synthetic-calendar/2");
    input["snapshotId"] = json!("snapshot-fixture-2");
    let refreshed = analyze(&input);
    assert_eq!(recurrence(&refreshed)["id"], pattern_id);
    assert_eq!(recurrence(&refreshed)["decisionState"], "rejected");
    assert_eq!(recurrence(&refreshed)["occurrences"], 3);
    assert_ne!(
        recurrence(&refreshed)["evidenceRevision"],
        recurrence(&rejected)["evidenceRevision"]
    );
    input["patternDecisions"][0]["state"] = json!("accepted");
    input["patternDecisions"][0]["version"] = json!(2);
    assert_eq!(recurrence(&analyze(&input))["tier"], "confirmed");
    input["patternDecisions"][0]["state"] = json!("revoked");
    input["patternDecisions"][0]["version"] = json!(3);
    assert_eq!(recurrence(&analyze(&input))["decisionState"], "unreviewed");
}

#[test]
fn source_admission_is_retained_and_incomplete_authoritative_collections_block_inference() {
    for collection in ["payees", "categories", "rules"] {
        let mut input = request();
        input["transactions"]
            .as_array_mut()
            .unwrap()
            .extend(history());
        input["sourceAdmission"]["collections"][collection] = json!("unavailable");
        let output = analyze(&input);
        assert_eq!(
            output["sourceAdmission"],
            serde_json::to_value(typed(&input)).unwrap()["sourceAdmission"]
        );
        assert!(suggestion(&output, "tx-source")["categoryId"].is_null());
        assert!(!suggestion(&output, "tx-source")["reasonCodes"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    let mut input = cadence(&["2024-01-31", "2024-02-29", "2024-03-31"]);
    input["sourceAdmission"]["accountCoverage"][0]["currencyState"] = json!("unknown");
    let output = analyze(&input);
    assert!(output["recurrences"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["tier"] == "insufficient_data"));
}

#[test]
fn interval_tolerances_are_calendar_days_and_same_day_observations_remain_distinct() {
    let weekly = analyze(&cadence(&["2024-01-01", "2024-01-10", "2024-01-17"]));
    assert_eq!(recurrence(&weekly)["frequency"], "weekly");
    let monthly = analyze(&cadence(&["2024-01-15", "2024-02-18", "2024-03-15"]));
    assert_eq!(recurrence(&monthly)["frequency"], "monthly");
    let too_far = analyze(&cadence(&["2024-01-15", "2024-02-23", "2024-03-15"]));
    assert_eq!(recurrence(&too_far)["frequency"], "irregular");
    let same_day = analyze(&cadence(&[
        "2024-01-01",
        "2024-01-01",
        "2024-02-01",
        "2024-03-01",
    ]));
    assert_eq!(recurrence(&same_day)["intervalDays"], json!([0, 31, 29]));
    assert_eq!(recurrence(&same_day)["occurrences"], 4);
    assert_eq!(
        recurrence(&same_day)["occurrencesPerMonth"]["periodCounts"],
        json!({"2024-01": 2, "2024-02": 1, "2024-03": 1})
    );
}

#[test]
fn selected_suggestion_pages_are_bounded_without_losing_history_or_changing_revisions() {
    let mut input = request();
    input["transactions"] = json!([
        transaction("tx-c", "2024-04-03", None),
        transaction("tx-a", "2024-04-01", None),
        transaction("tx-b", "2024-04-02", None),
    ]);
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .extend(history());
    let full = analyze(&input);
    input["suggestionSelection"] = json!({
        "transactionIds": ["tx-c", "missing", "tx-a", "tx-b"],
        "cursor": null, "limit": 2
    });
    let first = analyze(&input);
    assert_eq!(
        first["suggestionPage"],
        json!({
            "eligibleCandidates": 3, "returned": 2, "nextCursor": "tx-b"
        })
    );
    assert_eq!(
        first["suggestions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["transactionId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["tx-a", "tx-b"]
    );
    assert_eq!(suggestion(&first, "tx-a")["categoryId"], "category-food");
    assert_eq!(suggestion(&first, "tx-a")["supportCount"], 3);
    assert_eq!(
        suggestion(&first, "tx-a")["evidenceRevision"],
        suggestion(&full, "tx-a")["evidenceRevision"]
    );
    assert_eq!(first["coverage"], full["coverage"]);
    assert_eq!(first["recurrences"], full["recurrences"]);
    input["suggestionSelection"]["cursor"] = json!("tx-b");
    let second = analyze(&input);
    assert_eq!(
        second["suggestionPage"],
        json!({
            "eligibleCandidates": 3, "returned": 1, "nextCursor": null
        })
    );
    assert_eq!(second["suggestions"].as_array().unwrap().len(), 1);
    assert_eq!(suggestion(&second, "tx-c")["categoryId"], "category-food");
    assert_eq!(
        suggestion(&second, "tx-c")["evidenceRevision"],
        suggestion(&full, "tx-c")["evidenceRevision"]
    );
}

#[test]
fn unavailable_source_fields_cannot_match_private_aliases_but_native_id_rules_remain_usable() {
    let mut input = request();
    input["transactions"][0]["importedPayee"] = json!({"state": "unavailable", "value": null});
    input["transactions"][0]["notes"] = json!({"state": "unavailable", "value": null});
    input["transactions"][0]["importedId"] = Value::Null;
    input["aliases"] = json!([alias("payee-other", "accepted")]);
    input["rules"] = json!([rule("native", "category-bills")]);
    let output = analyze(&input);
    let found = suggestion(&output, "tx-source");
    assert_eq!(found["payeeId"], "payee-market");
    assert_eq!(found["categoryId"], "category-bills");
    assert_eq!(found["tier"], "deterministic_match");
    assert!(found["reasonCodes"]
        .as_array()
        .unwrap()
        .contains(&json!("source_unavailable")));
    assert!(found["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| { row["field"] != "importedPayee" && row["field"] != "notes" }));
    assert!(found["contradictions"].as_array().unwrap().is_empty());
    assert_eq!(
        serde_json::to_value(typed(&input)).unwrap()["transactions"][0]["notes"],
        json!({
            "state": "unavailable", "value": null
        })
    );
    input["transactions"][0]["notes"]["value"] = json!("private-sentinel");
    assert!(serde_json::from_value::<MerchantAnalysisRequest>(input.clone()).is_err());
    input["transactions"][0]["notes"]
        .as_object_mut()
        .unwrap()
        .remove("value");
    assert!(serde_json::from_value::<MerchantAnalysisRequest>(input).is_err());
}

#[test]
fn payee_name_aliases_require_explicit_targets_and_never_replace_native_ids() {
    let mut input = request();
    input["transactions"][0]["importedPayee"] = json!({"state": "absent", "value": null});
    let mut mapping = alias("payee-market", "accepted");
    mapping["sourceField"] = json!("payeeName");
    mapping["sourceText"] = input["transactions"][0]["payeeName"].clone();
    input["aliases"] = json!([mapping.clone()]);
    assert_eq!(
        serde_json::to_value(typed(&input)).unwrap()["aliases"][0]["sourceField"],
        "payeeName"
    );
    let same = analyze(&input);
    let found = suggestion(&same, "tx-source");
    assert_eq!(found["payeeId"], "payee-market");
    assert_ne!(found["tier"], "conflicting");
    assert!(found["evidence"].as_array().unwrap().iter().any(|row| {
        row["kind"] == "confirmed_decision"
            && row["sourceId"] == mapping["id"]
            && row["field"] == "payeeName"
    }));
    assert!(found["evidence"].as_array().unwrap().iter().any(|row| {
        row["kind"] == "source_observation"
            && row["field"] == "payeeName"
            && row["rawText"] == input["transactions"][0]["payeeName"]
    }));
    mapping["targetPayeeId"] = json!("payee-other");
    input["aliases"] = json!([mapping]);
    let other = analyze(&input);
    let conflicting = suggestion(&other, "tx-source");
    assert_eq!(conflicting["payeeId"], "payee-market");
    assert_eq!(conflicting["tier"], "conflicting");
    assert!(!conflicting["contradictions"].as_array().unwrap().is_empty());
    input["aliases"] = json!([]);
    input["transactions"][0]["payeeId"] = Value::Null;
    assert!(suggestion(&analyze(&input), "tx-source")["payeeId"].is_null());
}

#[test]
fn full_observation_endpoints_survive_bounded_recurrence_samples() {
    let input_dates = [
        "2024-01-01",
        "2024-02-01",
        "2024-03-01",
        "2024-04-01",
        "2024-05-01",
        "2024-06-01",
        "2024-07-01",
        "2024-08-01",
    ];
    let mut input = cadence(&input_dates);
    input["maxEvidence"] = json!(2);
    let bounded = analyze(&input);
    let pattern = recurrence(&bounded);
    assert_eq!(pattern["firstDate"], "2024-01-01");
    assert_eq!(pattern["lastDate"], "2024-08-01");
    assert_eq!(pattern["occurrences"], 8);
    assert_eq!(pattern["dates"].as_array().unwrap().len(), 2);
    assert_eq!(pattern["transactionIds"].as_array().unwrap().len(), 2);
    input["maxEvidence"] = json!(8);
    let full = analyze(&input);
    assert_eq!(recurrence(&full)["firstDate"], pattern["firstDate"]);
    assert_eq!(recurrence(&full)["lastDate"], pattern["lastDate"]);
    assert_eq!(
        recurrence(&full)["evidenceRevision"],
        pattern["evidenceRevision"]
    );
}

#[test]
fn legacy_recurring_projection_partitions_native_facts_and_abstains_about_source_authority() {
    use balanceframe_financial_core::{
        run_deterministic_analysis, CompatibilityMetadata, InclusionScope, Money, Transaction,
    };
    let mut transactions = Vec::new();
    for account in ["account-a", "account-b"] {
        for payee in ["payee-a", "payee-b"] {
            for currency in ["USD", "EUR"] {
                for sign in [-1, 1] {
                    for (index, date) in ["2024-01-31", "2024-02-29", "2024-03-31"]
                        .iter()
                        .enumerate()
                    {
                        transactions.push(Transaction {
                            id: format!("{account}-{payee}-{currency}-{sign}-{index}"),
                            account_id: account.into(),
                            date: (*date).into(),
                            payee_id: Some(payee.into()),
                            payee_name: Some("Identical Display Name".into()),
                            category_id: None,
                            category_name: None,
                            amount: Money::new(sign * (index as i64 + 1) * 100, currency),
                            cleared: true,
                            reconciled: false,
                            imported_id: None,
                            imported_payee: None,
                            notes: None,
                            tags: vec![],
                            transfer_account_id: None,
                            subtransactions: vec![],
                        });
                    }
                }
            }
        }
    }
    let legacy = run_deterministic_analysis(
        &[],
        &transactions,
        &[],
        &[],
        &[],
        &[],
        CompatibilityMetadata::new(false, true, "26.10.0".into()),
        None,
        None,
        &InclusionScope::new(false, true),
        "2024-12-31",
    );
    let output = serde_json::to_value(legacy).unwrap();
    let observed = output["recurringCharges"].as_array().unwrap();
    assert_eq!(
        observed.len(),
        16,
        "identity/account/currency/direction cannot collapse by display name"
    );
    for group in observed {
        assert_eq!(group["occurrences"], 3);
        assert_eq!(group["firstDate"], "2024-01-31");
        assert_eq!(group["lastDate"], "2024-03-31");
        assert_eq!(group["frequencyLabel"], "monthly");
        assert_eq!(group["tier"], "insufficient_data");
        assert!(
            group.get("confidence").is_none(),
            "no fabricated calibrated probability"
        );
        for reason in ["legacy_source_unavailable", "calendar_unknown"] {
            assert!(group["reasonCodes"]
                .as_array()
                .unwrap()
                .contains(&json!(reason)));
        }
        assert_eq!(group["transactionIds"].as_array().unwrap().len(), 3);
        assert!(group["payeeId"] == "payee-a" || group["payeeId"] == "payee-b");
    }
    let mut full_history: Vec<_> = (0..120)
        .map(|index| {
            let mut tx = transactions[0].clone();
            tx.id = format!("long-{index:03}");
            tx.date = format!("{:04}-{:02}-01", 2015 + index / 12, index % 12 + 1);
            tx
        })
        .collect();
    full_history.push(Transaction {
        payee_id: None,
        id: "unresolved".into(),
        ..transactions[0].clone()
    });
    let full = run_deterministic_analysis(
        &[],
        &full_history,
        &[],
        &[],
        &[],
        &[],
        CompatibilityMetadata::new(false, true, "26.10.0".into()),
        None,
        None,
        &InclusionScope::new(false, true),
        "2024-12-31",
    );
    let full = serde_json::to_value(full).unwrap();
    assert_eq!(full["recurringCharges"].as_array().unwrap().len(), 1);
    assert_eq!(full["recurringCharges"][0]["occurrences"], 120);
    assert_eq!(full["recurringCharges"][0]["firstDate"], "2015-01-01");
    assert_eq!(full["recurringCharges"][0]["lastDate"], "2024-12-01");
    assert!(
        full["recurringCharges"][0]["transactionIds"]
            .as_array()
            .unwrap()
            .len()
            <= 100
    );
}

#[test]
fn category_history_aggregates_preserve_full_outcomes_and_correction_roles_beyond_samples() {
    let mut input = request();
    input["maxEvidence"] = json!(2);
    let mut rows = vec![input["transactions"][0].clone()];
    for day in 1..=29 {
        rows.push(transaction(
            &format!("history-{day:02}"),
            &format!("2024-01-{day:02}"),
            Some("category-food"),
        ));
    }
    rows.push(transaction(
        "history-corrected",
        "2024-01-30",
        Some("category-bills"),
    ));
    rows.push(transaction(
        "history-other",
        "2024-02-01",
        Some("category-other"),
    ));
    rows.push(transaction(
        "history-bills",
        "2024-02-02",
        Some("category-bills"),
    ));
    input["transactions"] = json!(rows);
    let mut verified = correction("category-food", true);
    verified["transactionId"] = json!("history-corrected");
    input["corrections"] = json!([verified]);
    let output = analyze(&input);
    let found = suggestion(&output, "tx-source");
    assert_eq!(
        found["categoryHistory"],
        json!({
            "totalCount": 32, "categoryCount": 3, "truncated": true, "entries": [
                {"categoryId": "category-food", "count": 30, "ledgerCount": 29, "correctionCount": 1,
                    "firstDate": "2024-01-01", "lastDate": "2024-01-30"},
                {"categoryId": "category-bills", "count": 1, "ledgerCount": 1, "correctionCount": 0,
                    "firstDate": "2024-02-02", "lastDate": "2024-02-02"}
            ]
        })
    );
    assert_eq!(
        found["ruleCandidates"],
        json!([{
            "payeeId": "payee-market", "categoryId": "category-food", "supportCount": 30,
            "consistencyNumerator": 30, "consistencyDenominator": 32
        }])
    );
    for alternative in found["alternatives"].as_array().unwrap() {
        assert_eq!(alternative["supportCount"], 1);
        assert_eq!(alternative["tier"], "insufficient_data");
    }
    assert_eq!(found["alternatives"].as_array().unwrap().len(), 2);
    let mut permuted = input.clone();
    permuted["transactions"].as_array_mut().unwrap().reverse();
    assert_eq!(analyze(&permuted), output);
    input["rules"] = json!([rule("native-other", "category-other")]);
    let native = analyze(&input);
    assert_eq!(
        suggestion(&native, "tx-source")["categoryHistory"]["entries"][0]["categoryId"],
        "category-other"
    );
    assert_eq!(
        suggestion(&native, "tx-source")["categoryHistory"]["entries"][1]["categoryId"],
        "category-food"
    );
    input["rules"] = json!([
        rule("native-other", "category-other"),
        rule("native-bills", "category-bills")
    ]);
    let conflicting = analyze(&input);
    assert_eq!(
        suggestion(&conflicting, "tx-source")["ruleCandidates"],
        json!([])
    );
    assert!(suggestion(&conflicting, "tx-source")["alternatives"]
        .as_array()
        .unwrap()
        .iter()
        .take(2)
        .all(|entry| entry["tier"] == "conflicting"));
    input["rules"] = json!([]);
    input["sourceAdmission"]["collections"]["transactions"] = json!("partial");
    assert_eq!(
        suggestion(&analyze(&input), "tx-source")["ruleCandidates"],
        json!([])
    );
    input["sourceAdmission"]["collections"]["transactions"] = json!("complete");
    input["transactions"][0]["payeeId"] = Value::Null;
    assert_eq!(
        suggestion(&analyze(&input), "tx-source")["ruleCandidates"],
        json!([]),
        "text resolution cannot invent a native trigger"
    );
}

#[test]
fn full_native_rule_classifications_survive_explanation_pages_and_authority_precedence() {
    let mut input = request();
    let mut rows: Vec<_> = (0..301)
        .map(|index| transaction(&format!("candidate-{index:03}"), "2024-03-01", None))
        .collect();
    for (id, account, currency, amount) in [
        ("scope-account", "account-other", "USD", "-100"),
        ("scope-currency", "account-checking", "EUR", "-100"),
        ("scope-income", "account-checking", "USD", "100"),
    ] {
        let mut row = transaction(id, "2024-03-01", None);
        row["accountId"] = json!(account);
        row["amount"] = json!({"minorUnits": amount, "currency": currency});
        rows.push(row);
    }
    rows.push(transaction(
        "already-assigned",
        "2024-03-01",
        Some("category-food"),
    ));
    let selected: Vec<_> = rows.iter().map(|row| row["id"].clone()).collect();
    input["transactions"] = json!(rows);
    input["maxEvidence"] = json!(1);
    input["rules"] = json!([
        rule("rule-c", "category-bills"),
        rule("rule-a", "category-bills"),
        rule("rule-b", "category-bills")
    ]);
    input["suggestionSelection"] =
        json!({"transactionIds": selected, "cursor": null, "limit": 200});
    let first = analyze(&input);
    let full = first["nativeRuleClassifications"].as_array().unwrap();
    assert_eq!(full.len(), 304);
    assert_eq!(
        first["nativeRuleBlocks"],
        json!([{"ruleIds": ["rule-a", "rule-b", "rule-c"]}])
    );
    assert_eq!(first["nativeRuleParts"], json!([{"blockIndexes": [0]}]));
    assert_eq!(
        first["nativeRuleSets"],
        json!([{"orPartIndexes": [], "andPartIndexes": [[0], [0], [0], [0]], "categoryPartIndex": 0}])
    );
    assert!(full
        .iter()
        .all(|entry| entry["ruleSetIndex"] == 0 && entry.get("ruleIds").is_none()));
    assert_eq!(first["suggestions"].as_array().unwrap().len(), 200);
    input["suggestionSelection"]["cursor"] = first["suggestionPage"]["nextCursor"].clone();
    let second = analyze(&input);
    assert_eq!(
        second["nativeRuleClassifications"],
        first["nativeRuleClassifications"]
    );
    assert_eq!(second["nativeRuleSets"], first["nativeRuleSets"]);
    assert_eq!(second["nativeRuleBlocks"], first["nativeRuleBlocks"]);
    assert_eq!(second["nativeRuleParts"], first["nativeRuleParts"]);
    let mut overridden = correction("category-food", true);
    overridden["transactionId"] = json!("candidate-000");
    let mut aligned = correction("category-bills", true);
    aligned["transactionId"] = json!("candidate-001");
    let mut conflict_a = correction("category-food", true);
    conflict_a["transactionId"] = json!("candidate-002");
    let mut conflict_b = correction("category-bills", true);
    conflict_b["transactionId"] = json!("candidate-002");
    conflict_b["actorId"] = json!("actor-other");
    input["corrections"] = json!([overridden, aligned, conflict_a, conflict_b]);
    let corrected = analyze(&input);
    let corrected = corrected["nativeRuleClassifications"].as_array().unwrap();
    assert_eq!(corrected.len(), 302);
    assert!(!corrected
        .iter()
        .any(|entry| entry["transactionId"] == "candidate-000"
            || entry["transactionId"] == "candidate-002"));
    assert!(corrected
        .iter()
        .any(|entry| entry["transactionId"] == "candidate-001"));
    input["rules"]
        .as_array_mut()
        .unwrap()
        .push(rule("conflicting-rule", "category-food"));
    let conflict = analyze(&input);
    assert_eq!(
        conflict["nativeRuleClassifications"],
        json!([
            {"transactionId": "candidate-000", "accountId": "account-checking", "categoryId": "category-food", "ruleSetIndex": 0},
            {"transactionId": "candidate-001", "accountId": "account-checking", "categoryId": "category-bills", "ruleSetIndex": 1}
        ])
    );
    assert_eq!(
        conflict["nativeRuleBlocks"],
        json!([
            {"ruleIds": ["conflicting-rule"]}, {"ruleIds": ["rule-a", "rule-b", "rule-c"]}
        ])
    );
    assert_eq!(
        posting_rule_ids(&conflict, &conflict["nativeRuleSets"][0]),
        vec!["conflicting-rule".to_owned()]
    );
    assert_eq!(
        posting_rule_ids(&conflict, &conflict["nativeRuleSets"][1]),
        vec![
            "rule-a".to_owned(),
            "rule-b".to_owned(),
            "rule-c".to_owned()
        ]
    );
    let mut reordered_conflict = input.clone();
    reordered_conflict["transactions"]
        .as_array_mut()
        .unwrap()
        .reverse();
    reordered_conflict["rules"]
        .as_array_mut()
        .unwrap()
        .reverse();
    reordered_conflict["corrections"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let reordered_conflict = analyze(&reordered_conflict);
    assert_eq!(
        reordered_conflict["nativeRuleSets"],
        conflict["nativeRuleSets"]
    );
    assert_eq!(
        reordered_conflict["nativeRuleBlocks"],
        conflict["nativeRuleBlocks"]
    );
    assert_eq!(
        reordered_conflict["nativeRuleParts"],
        conflict["nativeRuleParts"]
    );
    assert_eq!(
        reordered_conflict["nativeRuleClassifications"],
        conflict["nativeRuleClassifications"]
    );
    input["corrections"] = json!([]);
    input["rules"] = json!([rule("rule-a", "category-bills")]);
    input["aliases"] = json!([alias("payee-other", "accepted")]);
    let identity_conflict = analyze(&input);
    assert_eq!(
        identity_conflict["nativeRuleClassifications"],
        json!([
            {"transactionId": "scope-account", "accountId": "account-other", "categoryId": "category-bills", "ruleSetIndex": 0}
        ]),
        "an account-scoped alias cannot conflict with another account's native identity"
    );
    input["aliases"] = json!([]);
    input["transactions"].as_array_mut().unwrap().reverse();
    input["rules"] = json!([
        rule("rule-b", "category-bills"),
        rule("rule-c", "category-bills"),
        rule("rule-a", "category-bills")
    ]);
    assert_eq!(
        analyze(&input)["nativeRuleClassifications"],
        first["nativeRuleClassifications"]
    );
    assert_eq!(analyze(&input)["nativeRuleSets"], first["nativeRuleSets"]);
    assert_eq!(
        analyze(&input)["nativeRuleBlocks"],
        first["nativeRuleBlocks"]
    );
    assert_eq!(analyze(&input)["nativeRuleParts"], first["nativeRuleParts"]);
}

#[test]
fn shared_native_rule_sets_serialize_complete_equivalent_many_ids_once() {
    let mut input = request();
    let ids: Vec<_> = (0..128)
        .map(|index| format!("shared-native-rule-{index:03}"))
        .collect();
    input["transactions"] = json!((0..240)
        .map(|index| {
            let mut row = transaction(&format!("shared-candidate-{index:03}"), "2024-03-01", None);
            row["payeeId"] = json!(format!("shared-payee-{index:03}"));
            row["payeeName"] = json!(format!("Distinct merchant {index:03}"));
            row
        })
        .collect::<Vec<_>>());
    input["payees"] = json!((0..240).map(|index| json!({
        "id": format!("shared-payee-{index:03}"), "name": format!("Distinct merchant {index:03}"),
        "transferAccountId": null, "mtid": null
    })).collect::<Vec<_>>());
    input["rules"] = json!(ids
        .iter()
        .rev()
        .map(|id| {
            let mut admitted = rule(id, "category-bills");
            admitted["trigger"]["conditions"] = json!([
                {"field": "account", "op": "is", "value": "account-checking", "type": "id"},
                {"field": "category", "op": "is", "value": null, "type": "id"}
            ]);
            admitted
        })
        .collect::<Vec<_>>());
    input["maxEvidence"] = json!(1);
    input["suggestionSelection"] = json!({"transactionIds": [], "cursor": null, "limit": 1});
    let output = analyze(&input);
    assert_eq!(output["nativeRuleBlocks"], json!([{"ruleIds": ids}]));
    assert_eq!(output["nativeRuleParts"], json!([{"blockIndexes": [0]}]));
    assert_eq!(
        output["nativeRuleSets"],
        json!([{"orPartIndexes": [], "andPartIndexes": [[0], [0], [0], [0]], "categoryPartIndex": 0}])
    );
    let rows = output["nativeRuleClassifications"].as_array().unwrap();
    assert_eq!(rows.len(), 240);
    for (index, row) in rows.iter().enumerate() {
        assert_eq!(row["transactionId"], format!("shared-candidate-{index:03}"));
        assert_eq!(row["accountId"], "account-checking");
        assert_eq!(row["categoryId"], "category-bills");
        assert_eq!(row["ruleSetIndex"], 0);
        assert!(row.get("ruleIds").is_none());
    }
    let serialized = serde_json::to_string(&output).unwrap();
    for id in &ids {
        assert_eq!(
            serialized.matches(&format!("\"{id}\"")).count(),
            1,
            "complete IDs belong only in the shared table"
        );
    }
    assert!(
        serialized.len() < 60_000,
        "equivalent rows must not serialize the rule table repeatedly"
    );
    input["transactions"].as_array_mut().unwrap().reverse();
    input["rules"].as_array_mut().unwrap().reverse();
    input["payees"].as_array_mut().unwrap().reverse();
    let reordered = analyze(&input);
    assert_eq!(reordered["nativeRuleSets"], output["nativeRuleSets"]);
    assert_eq!(reordered["nativeRuleBlocks"], output["nativeRuleBlocks"]);
    assert_eq!(
        reordered["nativeRuleClassifications"],
        output["nativeRuleClassifications"]
    );
    input["rules"]
        .as_array_mut()
        .unwrap()
        .push(rule("unmatched-payee-rule", "category-food"));
    let relevant_but_equal = analyze(&input);
    assert_eq!(
        relevant_but_equal["nativeRuleSets"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(posting_rule_ids(&relevant_but_equal, &relevant_but_equal["nativeRuleSets"][0]), ids,
        "unmatched dimensions do not change complete matching IDs; fixed expressions need no Boolean minimizer");
    assert_eq!(
        relevant_but_equal["nativeRuleClassifications"],
        output["nativeRuleClassifications"]
    );
}

#[test]
fn native_category_is_null_keeps_permitted_action_and_unsupported_null_predicates_abstain() {
    let mut input = request();
    input["rules"] = json!([rule("null-category-rule", "category-bills")]);
    input["rules"][0]["trigger"]["conditions"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "field": "category", "op": "is", "value": null, "type": "id"
        }));
    let output = analyze(&input);
    assert_eq!(
        output["nativeRuleBlocks"],
        json!([{"ruleIds": ["null-category-rule"]}])
    );
    assert_eq!(output["nativeRuleParts"], json!([{"blockIndexes": [0]}]));
    assert_eq!(
        output["nativeRuleSets"],
        json!([{"orPartIndexes": [], "andPartIndexes": [[0], [0], [0], [0]], "categoryPartIndex": 0}])
    );
    assert_eq!(
        output["nativeRuleClassifications"],
        json!([{
            "transactionId": "tx-source", "accountId": "account-checking",
            "categoryId": "category-bills", "ruleSetIndex": 0
        }])
    );
    for op in ["contains", "oneOf"] {
        input["rules"][0]["trigger"]["conditions"][1]["op"] = json!(op);
        let unsupported = analyze(&input);
        assert_eq!(unsupported["nativeRuleSets"], json!([]));
        assert_eq!(unsupported["nativeRuleBlocks"], json!([]));
        assert_eq!(unsupported["nativeRuleClassifications"], json!([]));
    }
}

#[test]
fn overlapping_native_rule_sets_share_common_blocks_with_complete_outcomes_across_pages() {
    let mut input = request();
    let common_ids: Vec<_> = (0..64)
        .map(|index| format!("overlap-common-{index:03}"))
        .collect();
    input["transactions"] = json!((0..240)
        .map(|index| {
            let mut row = transaction(&format!("overlap-tx-{index:03}"), "2024-03-01", None);
            row["payeeId"] = json!(format!("overlap-payee-{:03}", index % 48));
            row["payeeName"] = json!(format!("Overlap merchant {:03}", index % 48));
            row
        })
        .collect::<Vec<_>>());
    input["payees"] = json!((0..48).map(|index| json!({
        "id": format!("overlap-payee-{index:03}"), "name": format!("Overlap merchant {index:03}"),
        "transferAccountId": null, "mtid": null
    })).collect::<Vec<_>>());
    let mut rules: Vec<_> = common_ids
        .iter()
        .map(|id| {
            let mut row = rule(id, "category-bills");
            row["trigger"]["conditions"] = json!([
                {"field": "account", "op": "is", "value": "account-checking", "type": "id"},
                {"field": "category", "op": "is", "value": null, "type": "id"}
            ]);
            row
        })
        .collect();
    for index in 0..48 {
        let mut row = rule(&format!("overlap-private-{index:03}"), "category-bills");
        row["trigger"]["conditions"][0]["value"] = json!(format!("overlap-payee-{index:03}"));
        rules.push(row);
    }
    input["rules"] = json!(rules);
    input["maxEvidence"] = json!(1);
    input["suggestionSelection"] = json!({"transactionIds": [], "cursor": null, "limit": 1});
    let output = analyze(&input);
    let blocks = output["nativeRuleBlocks"]
        .as_array()
        .expect("overlapping unequal sets require complete shared native rule blocks");
    assert_eq!(blocks.len(), 49);
    assert_eq!(
        blocks
            .iter()
            .map(|block| block["ruleIds"].as_array().unwrap().len())
            .sum::<usize>(),
        112,
        "the 64 common IDs belong to one block, not each of the 48 unequal sets"
    );
    assert_eq!(
        blocks
            .iter()
            .filter(|block| block["ruleIds"] == json!(common_ids))
            .count(),
        1
    );
    let all_ids: std::collections::BTreeSet<_> = blocks
        .iter()
        .flat_map(|block| {
            block["ruleIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap())
        })
        .collect();
    assert_eq!(all_ids.len(), 112, "rule blocks must have disjoint IDs");
    let sets = output["nativeRuleSets"].as_array().unwrap();
    assert_eq!(sets.len(), 48);
    for set in sets {
        assert!(set.get("ruleIds").is_none());
        assert_eq!(posting_rule_ids(&output, set).len(), 65);
    }
    let outcomes = output["nativeRuleClassifications"].as_array().unwrap();
    assert_eq!(outcomes.len(), 240);
    for (index, row) in outcomes.iter().enumerate() {
        assert_eq!(row["transactionId"], format!("overlap-tx-{index:03}"));
        assert_eq!(row["accountId"], "account-checking");
        assert_eq!(row["categoryId"], "category-bills");
        assert!(row.get("ruleIds").is_none());
        let set = &sets[row["ruleSetIndex"].as_u64().unwrap() as usize];
        let complete = posting_rule_ids(&output, set);
        let mut expected = common_ids.clone();
        expected.push(format!("overlap-private-{:03}", index % 48));
        assert_eq!(
            complete, expected,
            "every source rule ID and outcome must be preserved"
        );
    }
    let serialized = serde_json::to_string(&output).unwrap();
    for id in &all_ids {
        assert_eq!(serialized.matches(&format!("\"{id}\"")).count(), 1);
    }
    let native_serialized = serde_json::to_string(&json!({
        "nativeRuleBlocks": output["nativeRuleBlocks"], "nativeRuleSets": output["nativeRuleSets"],
        "nativeRuleClassifications": output["nativeRuleClassifications"]
    }))
    .unwrap();
    assert!(
        native_serialized.len() < 65_000,
        "overlapping unequal sets must not repeat complete common ID arrays"
    );
    let selected: Vec<_> = input["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].clone())
        .collect();
    input["suggestionSelection"] =
        json!({"transactionIds": selected, "cursor": null, "limit": 200});
    let page = analyze(&input);
    assert_eq!(page["suggestions"].as_array().unwrap().len(), 200);
    input["suggestionSelection"]["cursor"] = page["suggestionPage"]["nextCursor"].clone();
    let next = analyze(&input);
    assert_eq!(next["suggestions"].as_array().unwrap().len(), 40);
    input["transactions"].as_array_mut().unwrap().reverse();
    input["payees"].as_array_mut().unwrap().reverse();
    input["rules"].as_array_mut().unwrap().reverse();
    let reordered = analyze(&input);
    for specimen in [&page, &next, &reordered] {
        for field in [
            "nativeRuleBlocks",
            "nativeRuleSets",
            "nativeRuleClassifications",
        ] {
            assert_eq!(
                specimen[field], output[field],
                "native {field} must survive pages/source enumeration"
            );
        }
    }
}

fn posting_rule_ids(output: &Value, set: &Value) -> Vec<String> {
    let parts = output["nativeRuleParts"]
        .as_array()
        .expect("literal source posting table is required");
    let union = |references: &Value| -> std::collections::BTreeSet<usize> {
        let references = references.as_array().unwrap();
        assert!(references
            .windows(2)
            .all(|pair| pair[0].as_u64().unwrap() < pair[1].as_u64().unwrap()));
        references
            .iter()
            .flat_map(|reference| {
                parts[reference.as_u64().unwrap() as usize]["blockIndexes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|index| index.as_u64().unwrap() as usize)
            })
            .collect()
    };
    let or = set["orPartIndexes"]
        .as_array()
        .expect("fixed OR references are required");
    let and = set["andPartIndexes"]
        .as_array()
        .expect("fixed AND operands are required");
    assert!(or.len() <= 4);
    assert!(and.is_empty() || and.len() == 4);
    assert!(and
        .iter()
        .all(|operand| (1..=2).contains(&operand.as_array().unwrap().len())));
    assert!(
        or.len()
            + and
                .iter()
                .map(|operand| operand.as_array().unwrap().len())
                .sum::<usize>()
            < 13
    );
    assert!(set.get("blockIndexes").is_none() && set.get("ruleIds").is_none());
    let mut indexes = union(&set["orPartIndexes"]);
    if let Some(first) = and.first() {
        let mut intersection = union(first);
        for operand in &and[1..] {
            intersection = intersection
                .intersection(&union(operand))
                .copied()
                .collect();
        }
        indexes.extend(intersection);
    }
    let category = set["categoryPartIndex"]
        .as_u64()
        .expect("selected category filter is required") as usize;
    let category_indexes: std::collections::BTreeSet<_> = parts[category]["blockIndexes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|index| index.as_u64().unwrap() as usize)
        .collect();
    indexes = indexes.intersection(&category_indexes).copied().collect();
    let blocks = output["nativeRuleBlocks"].as_array().unwrap();
    let mut ids: Vec<_> = indexes
        .into_iter()
        .flat_map(|index| {
            blocks[index]["ruleIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap().to_owned())
        })
        .collect();
    ids.sort_unstable();
    ids
}

#[test]
fn or_postings_preserve_complete_unequal_native_outcomes_with_constant_descriptors_across_pages() {
    let mut input = request();
    input["transactions"] = json!((0..160)
        .map(|index| {
            let mut row = transaction(&format!("posting-tx-{index:03}"), "2024-03-01", None);
            row["payeeId"] = json!(format!("posting-payee-{:03}", index % 32));
            row["payeeName"] = json!(format!("Posting merchant {:03}", index % 32));
            row
        })
        .collect::<Vec<_>>());
    input["payees"] = json!((0..32).map(|index| json!({
        "id": format!("posting-payee-{index:03}"), "name": format!("Posting merchant {index:03}"),
        "transferAccountId": null, "mtid": null
    })).collect::<Vec<_>>());
    let mut rules = Vec::new();
    for index in 0..32 {
        let mut common = rule(&format!("posting-or-{index:03}"), "category-bills");
        common["trigger"]["conditionsOp"] = json!("or");
        common["trigger"]["conditions"] = json!([
            {"field": "account", "op": "is", "value": "account-checking", "type": "id"},
            {"field": "payee", "op": "is", "value": format!("posting-payee-{index:03}"), "type": "id"}
        ]);
        rules.push(common);
        let mut private = rule(&format!("posting-private-{index:03}"), "category-bills");
        private["trigger"]["conditions"][0]["value"] = json!(format!("posting-payee-{index:03}"));
        rules.push(private);
    }
    input["rules"] = json!(rules);
    input["maxEvidence"] = json!(1);
    input["suggestionSelection"] = json!({"transactionIds": [], "cursor": null, "limit": 1});
    let output = analyze(&input);
    let rows = output["nativeRuleClassifications"].as_array().unwrap();
    assert_eq!(rows.len(), 160, "all real native outcomes remain present");
    assert!(rows
        .iter()
        .all(|row| row["categoryId"] == "category-bills" && row.get("ruleIds").is_none()));
    let blocks = output["nativeRuleBlocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 64);
    assert_eq!(
        blocks
            .iter()
            .map(|block| block["ruleIds"].as_array().unwrap().len())
            .sum::<usize>(),
        64
    );
    let common_indexes: Vec<_> = blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            block["ruleIds"][0]
                .as_str()
                .unwrap()
                .starts_with("posting-or-")
                .then_some(index)
        })
        .collect();
    assert_eq!(common_indexes.len(), 32);
    let parts = output["nativeRuleParts"]
        .as_array()
        .expect("OR outcomes must reference shared literal source postings");
    assert_eq!(
        parts
            .iter()
            .filter(|part| part["blockIndexes"] == json!(common_indexes))
            .count(),
        1,
        "the common account OR posting is materialized once, not once per payee"
    );
    assert!(
        parts
            .iter()
            .map(|part| part["blockIndexes"].as_array().unwrap().len())
            .sum::<usize>()
            <= 4 * 64,
        "literal source posting data must not contain one expanded 33-block union per outcome"
    );
    let mut contents = std::collections::BTreeSet::new();
    for part in parts {
        let indexes: Vec<_> = part["blockIndexes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|index| index.as_u64().unwrap())
            .collect();
        assert!(!indexes.is_empty() && indexes.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(indexes.iter().all(|index| *index < blocks.len() as u64));
        assert!(
            contents.insert(indexes),
            "equal literal parts must be interned once"
        );
        assert!(part.get("ruleIds").is_none());
    }
    let sets = output["nativeRuleSets"].as_array().unwrap();
    assert_eq!(sets.len(), 32);
    for (index, row) in rows.iter().enumerate() {
        assert_eq!(row["transactionId"], format!("posting-tx-{index:03}"));
        let actual = posting_rule_ids(
            &output,
            &sets[row["ruleSetIndex"].as_u64().unwrap() as usize],
        );
        let mut expected: Vec<_> = (0..32)
            .map(|rule| format!("posting-or-{rule:03}"))
            .collect();
        expected.push(format!("posting-private-{:03}", index % 32));
        assert_eq!(
            actual, expected,
            "overlapping OR operands cannot double count or lose any matching ID"
        );
    }
    let wire = serde_json::to_string(&output).unwrap();
    for rule in input["rules"].as_array().unwrap() {
        assert_eq!(
            wire.matches(&format!("\"{}\"", rule["id"].as_str().unwrap()))
                .count(),
            1
        );
    }
    let selected: Vec<_> = input["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].clone())
        .collect();
    input["suggestionSelection"] =
        json!({"transactionIds": selected, "cursor": null, "limit": 100});
    let page = analyze(&input);
    assert_eq!(page["suggestions"].as_array().unwrap().len(), 100);
    assert!(page["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["supportCount"] == 33));
    input["suggestionSelection"]["cursor"] = page["suggestionPage"]["nextCursor"].clone();
    let next = analyze(&input);
    assert_eq!(next["suggestions"].as_array().unwrap().len(), 60);
    assert!(next["suggestions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["supportCount"] == 33));
    input["transactions"].as_array_mut().unwrap().reverse();
    input["payees"].as_array_mut().unwrap().reverse();
    input["rules"].as_array_mut().unwrap().reverse();
    let reordered = analyze(&input);
    for specimen in [&page, &next, &reordered] {
        for field in [
            "nativeRuleBlocks",
            "nativeRuleParts",
            "nativeRuleSets",
            "nativeRuleClassifications",
        ] {
            assert_eq!(
                specimen[field], output[field],
                "posting {field} must survive pages/source enumeration"
            );
        }
    }
}

#[test]
fn posting_overlap_weights_multi_id_blocks_once_and_deduplicates_native_evidence() {
    let mut input = request();
    let mut rules = Vec::new();
    for id in ["weighted-or-a", "weighted-or-b", "weighted-or-c"] {
        let mut row = rule(id, "category-bills");
        row["trigger"]["conditionsOp"] = json!("or");
        row["trigger"]["conditions"] = json!([
            {"field": "account", "op": "is", "value": "account-checking"},
            {"field": "payee", "op": "is", "value": "payee-market"}
        ]);
        rules.push(row);
    }
    rules.extend(["weighted-private-a", "weighted-private-b"].map(|id| rule(id, "category-bills")));
    input["rules"] = json!(rules);
    input["maxEvidence"] = json!(100);
    let output = analyze(&input);
    let found = suggestion(&output, "tx-source");
    assert_eq!(
        found["supportCount"], 5,
        "a three-ID block hit by account and payee contributes three, not six"
    );
    let evidence_ids: Vec<_> = found["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "native_rule")
        .map(|row| row["sourceId"].as_str().unwrap().to_owned())
        .collect();
    let expected: Vec<_> = [
        "weighted-or-a",
        "weighted-or-b",
        "weighted-or-c",
        "weighted-private-a",
        "weighted-private-b",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(
        evidence_ids, expected,
        "bounded native evidence remains unique and globally scalar-sorted"
    );
    let row = &output["nativeRuleClassifications"][0];
    let set = &output["nativeRuleSets"][row["ruleSetIndex"].as_u64().unwrap() as usize];
    assert_eq!(posting_rule_ids(&output, set), expected);
    assert_eq!(
        output["nativeRuleBlocks"].as_array().unwrap().len(),
        2,
        "equivalent IDs compile before posting construction"
    );
    let mut reordered = output.clone();
    let block_count = reordered["nativeRuleBlocks"].as_array().unwrap().len();
    reordered["nativeRuleBlocks"]
        .as_array_mut()
        .unwrap()
        .reverse();
    for part in reordered["nativeRuleParts"].as_array_mut().unwrap() {
        let indexes = part["blockIndexes"].as_array_mut().unwrap();
        for index in indexes.iter_mut() {
            *index = json!(block_count - 1 - index.as_u64().unwrap() as usize);
        }
        indexes.sort_unstable_by_key(|index| index.as_u64().unwrap());
    }
    let part_count = reordered["nativeRuleParts"].as_array().unwrap().len();
    reordered["nativeRuleParts"]
        .as_array_mut()
        .unwrap()
        .reverse();
    for set in reordered["nativeRuleSets"].as_array_mut().unwrap() {
        let or = set["orPartIndexes"].as_array_mut().unwrap();
        for index in or.iter_mut() {
            *index = json!(part_count - 1 - index.as_u64().unwrap() as usize);
        }
        or.sort_unstable_by_key(|index| index.as_u64().unwrap());
        for operand in set["andPartIndexes"].as_array_mut().unwrap() {
            let indexes = operand.as_array_mut().unwrap();
            for index in indexes.iter_mut() {
                *index = json!(part_count - 1 - index.as_u64().unwrap() as usize);
            }
            indexes.sort_unstable_by_key(|index| index.as_u64().unwrap());
        }
        set["categoryPartIndex"] =
            json!(part_count - 1 - set["categoryPartIndex"].as_u64().unwrap() as usize);
    }
    assert_eq!(
        posting_rule_ids(&reordered, &reordered["nativeRuleSets"][0]),
        expected
    );
    let parsed: MerchantAnalysisResult = serde_json::from_value(reordered.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), reordered);
    reordered["nativeRuleBlocks"]
        .as_array_mut()
        .unwrap()
        .push(json!({"ruleIds": ["unreferenced-native-id"]}));
    reordered["nativeRuleParts"]
        .as_array_mut()
        .unwrap()
        .push(json!({"blockIndexes": [block_count]}));
    assert_eq!(
        posting_rule_ids(&reordered, &reordered["nativeRuleSets"][0]),
        expected,
        "unreferenced block/part additions cannot alter complete selected IDs"
    );
    let parsed: MerchantAnalysisResult = serde_json::from_value(reordered.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), reordered);
}

#[test]
fn posting_category_filter_preserves_only_correction_selected_native_subset_in_conflict() {
    let mut input = request();
    input["rules"] = json!([
        rule("correction-bills-a", "category-bills"),
        rule("correction-bills-b", "category-bills"),
        rule("correction-other-a", "category-other"),
        rule("correction-other-b", "category-other")
    ]);
    input["corrections"] = json!([]);
    let conflicting = analyze(&input);
    assert_eq!(suggestion(&conflicting, "tx-source")["tier"], "conflicting");
    assert_eq!(conflicting["nativeRuleClassifications"], json!([]));
    assert_eq!(conflicting["nativeRuleSets"], json!([]));
    assert_eq!(
        conflicting["nativeRuleParts"],
        json!([]),
        "conflict-only matching cannot emit unreferenced source parts"
    );
    input["corrections"] = json!([correction("category-other", true)]);
    let output = analyze(&input);
    assert_eq!(suggestion(&output, "tx-source")["tier"], "confirmed");
    assert_eq!(
        output["nativeRuleClassifications"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let row = &output["nativeRuleClassifications"][0];
    assert_eq!(row["categoryId"], "category-other");
    let set = &output["nativeRuleSets"][row["ruleSetIndex"].as_u64().unwrap() as usize];
    assert_eq!(posting_rule_ids(&output, set), vec!["correction-other-a".to_owned(), "correction-other-b".to_owned()],
        "matching opposite-category rules cannot acquire attribution to the correction-selected classification");
}

#[test]
fn posting_omitted_empty_and_paged_selection_preserve_existing_explanation_branches() {
    let mut input = request();
    input["rules"] = json!([rule("selection-native", "category-bills")]);
    let extra = transaction("selection-extra", "2024-03-01", None);
    input["transactions"].as_array_mut().unwrap().push(extra);
    input.as_object_mut().unwrap().remove("suggestionSelection");
    let omitted = analyze(&input);
    assert!(omitted.get("suggestionPage").is_none());
    assert_eq!(
        omitted["suggestions"].as_array().unwrap().len(),
        2,
        "omitted selection still explains every prepared eligible row"
    );
    let row = &omitted["nativeRuleClassifications"][0];
    assert_eq!(
        posting_rule_ids(
            &omitted,
            &omitted["nativeRuleSets"][row["ruleSetIndex"].as_u64().unwrap() as usize]
        ),
        vec!["selection-native".to_owned()]
    );
    input["suggestionSelection"] = json!({"transactionIds": [], "cursor": null, "limit": 1});
    let empty = analyze(&input);
    assert_eq!(empty["suggestions"], json!([]));
    assert_eq!(
        empty["suggestionPage"],
        json!({"eligibleCandidates": 0, "returned": 0, "nextCursor": null})
    );
    input["suggestionSelection"] =
        json!({"transactionIds": ["selection-extra", "tx-source"], "cursor": null, "limit": 1});
    let page = analyze(&input);
    assert_eq!(page["suggestions"].as_array().unwrap().len(), 1);
    assert_eq!(page["suggestions"][0]["transactionId"], "selection-extra");
    input["suggestionSelection"]["cursor"] = page["suggestionPage"]["nextCursor"].clone();
    let next = analyze(&input);
    assert_eq!(next["suggestions"][0]["transactionId"], "tx-source");
    for specimen in [&empty, &page, &next] {
        for field in [
            "nativeRuleBlocks",
            "nativeRuleParts",
            "nativeRuleSets",
            "nativeRuleClassifications",
        ] {
            assert_eq!(
                specimen[field], omitted[field],
                "{field} cannot depend on explanation branch"
            );
        }
    }
}

#[test]
fn posting_large_or_summary_counts_overlapping_small_multi_id_posting_once() {
    let mut input = request();
    let mut rules = Vec::new();
    for index in 0..1025 {
        for duplicate in 0..if index == 0 { 3 } else { 1 } {
            let mut row = rule(
                &format!("large-or-{index:04}-{duplicate}"),
                "category-bills",
            );
            row["trigger"]["conditionsOp"] = json!("or");
            row["trigger"]["conditions"] = json!([
                {"field": "account", "op": "is", "value": "account-checking"},
                {"field": "payee", "op": "is", "value": if index == 0 { "payee-market".to_owned() } else { format!("large-payee-{index:04}") }}
            ]);
            rules.push(row);
        }
    }
    rules.extend(["large-private-a", "large-private-b"].map(|id| rule(id, "category-bills")));
    let mut expected: Vec<_> = rules
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect();
    expected.sort_unstable();
    assert_eq!(expected.len(), 1029);
    input["rules"] = json!(rules);
    input["maxEvidence"] = json!(100);
    let output = analyze(&input);
    let found = suggestion(&output, "tx-source");
    assert_eq!(
        found["supportCount"], 1029,
        "small payee posting overlaps the large account posting's three-ID block"
    );
    let native_evidence: Vec<_> = found["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["kind"] == "native_rule")
        .map(|row| row["sourceId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        native_evidence,
        expected[..100],
        "large-summary evidence stays bounded, sorted and duplicate-free"
    );
    let row = &output["nativeRuleClassifications"][0];
    assert_eq!(
        posting_rule_ids(
            &output,
            &output["nativeRuleSets"][row["ruleSetIndex"].as_u64().unwrap() as usize]
        ),
        expected
    );
    assert!(
        output["nativeRuleParts"].as_array().unwrap().len() <= 13,
        "only referenced source parts may be emitted for one classified outcome"
    );
    for row in rules
        .iter_mut()
        .filter(|row| row["id"].as_str().unwrap().starts_with("large-private-"))
    {
        row["actions"][0]["value"] = json!("category-other");
    }
    input["rules"] = json!(rules);
    input["corrections"] = json!([correction("category-other", true)]);
    let corrected = analyze(&input);
    let found = suggestion(&corrected, "tx-source");
    let bills = found["alternatives"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["categoryId"] == "category-bills")
        .unwrap();
    assert_eq!(
        bills["supportCount"], 1027,
        "mixed-category advice reuses weighted large OR summaries without counting overlap twice"
    );
    let row = &corrected["nativeRuleClassifications"][0];
    assert_eq!(
        posting_rule_ids(
            &corrected,
            &corrected["nativeRuleSets"][row["ruleSetIndex"].as_u64().unwrap() as usize]
        ),
        vec!["large-private-a".to_owned(), "large-private-b".to_owned()]
    );
}

#[test]
fn recurrence_distributions_remain_population_specific_and_do_not_share_money() {
    let mut input = request();
    let month_end_dates = ["2024-01-31", "2024-02-29", "2024-03-31"];
    let other_dates = ["2024-01-31", "2024-02-15", "2024-03-31"];
    let repeated_dates = ["2024-01-31", "2024-02-29", "2024-02-29", "2024-03-31"];
    let mut rows = Vec::new();
    for (population, dates) in [
        ("outflow", month_end_dates.as_slice()),
        ("inflow", month_end_dates.as_slice()),
        ("other", other_dates.as_slice()),
        ("repeated", repeated_dates.as_slice()),
    ] {
        for (index, observed) in dates.iter().enumerate() {
            let mut row = transaction(&format!("{population}-{index}"), observed, None);
            if population == "inflow" {
                row["amount"]["minorUnits"] = json!("100");
            } else if population == "other" {
                row["payeeId"] = json!("payee-other");
                row["payeeName"] = json!("Other Market");
            } else if population == "repeated" {
                row["accountId"] = json!("account-other");
            }
            rows.push(row);
        }
    }
    input["transactions"] = json!(rows);
    let output = analyze(&input);
    let patterns = output["recurrences"].as_array().unwrap();
    assert_eq!(patterns.len(), 4);
    let find = |account: &str, payee: &str, direction: &str| {
        patterns
            .iter()
            .find(|pattern| {
                pattern["accountId"] == account
                    && pattern["payeeId"] == payee
                    && pattern["direction"] == direction
            })
            .unwrap()
    };
    let outgoing = find("account-checking", "payee-market", "outflow");
    let incoming = find("account-checking", "payee-market", "inflow");
    let other = find("account-checking", "payee-other", "outflow");
    let repeated = find("account-other", "payee-market", "outflow");
    assert_eq!(
        outgoing["occurrencesPerWeek"],
        incoming["occurrencesPerWeek"]
    );
    assert_eq!(outgoing["minimumAmount"]["minorUnits"], "-100");
    assert_eq!(incoming["minimumAmount"]["minorUnits"], "100");
    assert_eq!(
        outgoing["transactionIds"],
        json!(["outflow-0", "outflow-1", "outflow-2"])
    );
    assert_eq!(
        incoming["transactionIds"],
        json!(["inflow-0", "inflow-1", "inflow-2"])
    );
    assert_eq!(
        outgoing["occurrencesPerWeek"]["periodCounts"]["2024-W07"],
        0
    );
    assert_eq!(
        outgoing["occurrencesPerWeek"]["periodCounts"]["2024-W09"],
        1
    );
    assert_eq!(other["occurrencesPerWeek"]["periodCounts"]["2024-W07"], 1);
    assert_eq!(other["occurrencesPerWeek"]["periodCounts"]["2024-W09"], 0);
    assert_eq!(
        repeated["occurrencesPerWeek"]["periodCounts"]["2024-W09"],
        2
    );
    assert_eq!(repeated["occurrencesPerWeek"]["averageNumerator"], "4");
    assert_eq!(repeated["occurrencesPerWeek"]["averageDenominator"], "9");
    let decoded: MerchantAnalysisResult = serde_json::from_value(output.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), output);
}

#[test]
fn compact_category_classifications_are_complete_stable_and_independent_of_explanation_pages() {
    let mut input = request();
    let mut rows = history();
    rows.extend(
        (0..301).map(|index| transaction(&format!("compact-{index:03}"), "2024-03-31", None)),
    );
    rows.extend((0..240).map(|index| {
        let mut row = transaction(&format!("native-full-{index:03}"), "2024-03-31", None);
        row["payeeId"] = json!("payee-other");
        row["payeeName"] = json!("Other Market");
        row
    }));
    let mut native_rules = vec![
        rule("complete-native-a", "category-bills"),
        rule("complete-native-b", "category-bills"),
    ];
    for native in &mut native_rules {
        native["trigger"]["conditions"][0]["value"] = json!("payee-other");
    }
    input["rules"] = json!(native_rules);
    input["transactions"] = json!(rows);
    let ids: Vec<_> = (0..301)
        .map(|index| format!("compact-{index:03}"))
        .collect();
    input["suggestionSelection"] = json!({"transactionIds": ids, "cursor": null, "limit": 200});
    let first = analyze(&input);
    let classifications = first["categoryClassifications"]
        .as_array()
        .expect("complete compact category classifications are mandatory at runtime");
    assert_eq!(
        classifications.len(),
        301,
        "no explanation-page coverage cap"
    );
    assert_eq!(
        first["nativeRuleClassifications"].as_array().unwrap().len(),
        240
    );
    assert_eq!(
        first["nativeRuleBlocks"],
        json!([{"ruleIds": ["complete-native-a", "complete-native-b"]}])
    );
    assert_eq!(first["nativeRuleParts"], json!([{"blockIndexes": [0]}]));
    assert_eq!(
        first["nativeRuleSets"],
        json!([{"orPartIndexes": [], "andPartIndexes": [[0], [0], [0], [0]], "categoryPartIndex": 0}])
    );
    for (index, row) in classifications.iter().enumerate() {
        assert_eq!(
            row,
            &json!({
                "transactionId": format!("compact-{index:03}"), "accountId": "account-checking",
                "payeeId": "payee-market", "categoryId": "category-food", "tier": "inferred",
                "evidenceRevision": row["evidenceRevision"]
            })
        );
        assert!(row["evidenceRevision"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        if index < 200 {
            assert_eq!(
                row["evidenceRevision"],
                suggestion(&first, &format!("compact-{index:03}"))["evidenceRevision"]
            );
        }
    }
    assert_eq!(first["suggestions"].as_array().unwrap().len(), 200);
    input["suggestionSelection"]["cursor"] = first["suggestionPage"]["nextCursor"].clone();
    input["snapshotId"] = json!("fresh-snapshot");
    input["sourceAdmission"]["capturedAt"] = json!("2024-12-31T13:00:00Z");
    input["sourceAdmission"]["expiresAt"] = json!("2025-01-01T13:00:00Z");
    let second = analyze(&input);
    assert_eq!(second["suggestions"].as_array().unwrap().len(), 101);
    assert_eq!(
        second["categoryClassifications"],
        first["categoryClassifications"]
    );
    for field in [
        "nativeRuleBlocks",
        "nativeRuleParts",
        "nativeRuleSets",
        "nativeRuleClassifications",
    ] {
        assert_eq!(second[field], first[field]);
    }
    for row in second["suggestions"].as_array().unwrap() {
        let compact = classifications
            .iter()
            .find(|entry| entry["transactionId"] == row["transactionId"])
            .unwrap();
        assert_eq!(compact["evidenceRevision"], row["evidenceRevision"]);
    }
    input["suggestionSelection"] = json!({"transactionIds": [], "cursor": null, "limit": 1});
    input["transactions"].as_array_mut().unwrap().reverse();
    let empty = analyze(&input);
    assert_eq!(empty["suggestions"], json!([]));
    assert_eq!(
        empty["categoryClassifications"],
        first["categoryClassifications"]
    );
    for field in [
        "nativeRuleBlocks",
        "nativeRuleParts",
        "nativeRuleSets",
        "nativeRuleClassifications",
    ] {
        assert_eq!(empty[field], first[field]);
    }
}

#[test]
fn compact_category_classifications_isolate_boundaries_and_abstain_on_partial_or_conflicting_authority(
) {
    for boundary in [
        "account",
        "currency",
        "direction",
        "payee",
        "categorized",
        "identity-conflict",
        "native-conflict",
        "partial-rules",
        "partial-payees",
        "partial-categories",
        "unknown-currency",
        "pending-unsupported",
    ] {
        let mut input = request();
        input["transactions"]
            .as_array_mut()
            .unwrap()
            .extend(history());
        match boundary {
            "account" => input["transactions"][0]["accountId"] = json!("account-other"),
            "currency" => input["transactions"][0]["amount"]["currency"] = json!("CAD"),
            "direction" => input["transactions"][0]["amount"]["minorUnits"] = json!("100"),
            "payee" => input["transactions"][0]["payeeId"] = json!("payee-other"),
            "categorized" => input["transactions"][0]["categoryId"] = json!("category-bills"),
            "identity-conflict" => input["aliases"] = json!([alias("payee-other", "accepted")]),
            "native-conflict" => {
                input["rules"] = json!([
                    rule("conflict-a", "category-bills"),
                    rule("conflict-b", "category-other")
                ])
            }
            "partial-rules" => input["sourceAdmission"]["collections"]["rules"] = json!("partial"),
            "partial-payees" => {
                input["sourceAdmission"]["collections"]["payees"] = json!("partial")
            }
            "partial-categories" => {
                input["sourceAdmission"]["collections"]["categories"] = json!("partial")
            }
            "unknown-currency" => {
                input["sourceAdmission"]["accountCoverage"][0]["currencyState"] = json!("unknown")
            }
            "pending-unsupported" => {
                input["sourceAdmission"]["pendingState"] = json!("unsupported")
            }
            _ => unreachable!(),
        }
        let output = analyze(&input);
        assert_eq!(output["categoryClassifications"], json!([]), "{boundary}");
    }
    let mut input = request();
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .extend(history());
    input["rules"] = json!([rule("readable-native", "category-bills")]);
    input["sourceAdmission"]["collections"]["rules"] = json!("partial");
    let partial = analyze(&input);
    assert_eq!(
        partial["categoryClassifications"],
        json!([]),
        "partial native authority must not be promoted to inferred"
    );
    assert_eq!(
        partial["nativeRuleClassifications"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "kernel retains the full readable native graph for consumer authorization"
    );
    assert_eq!(
        posting_rule_ids(&partial, &partial["nativeRuleSets"][0]),
        vec!["readable-native"]
    );
}

#[test]
fn compact_confirmed_corrections_precede_different_native_categories_without_duplicate_targets() {
    let mut input = request();
    input["transactions"]
        .as_array_mut()
        .unwrap()
        .extend(history());
    input["rules"] = json!([rule("different-native", "category-bills")]);
    input["corrections"] = json!([correction("category-other", true)]);
    input["suggestionSelection"] = json!({"transactionIds": [], "cursor": null, "limit": 1});
    let output = analyze(&input);
    let compact = output["categoryClassifications"]
        .as_array()
        .expect("compact confirmed targets are mandatory");
    assert_eq!(compact.len(), 1);
    assert_eq!(compact[0]["transactionId"], "tx-source");
    assert_eq!(compact[0]["accountId"], "account-checking");
    assert_eq!(compact[0]["payeeId"], "payee-market");
    assert_eq!(compact[0]["categoryId"], "category-other");
    assert_eq!(compact[0]["tier"], "confirmed");
    assert_eq!(output["nativeRuleClassifications"], json!([]));
    input["rules"]
        .as_array_mut()
        .unwrap()
        .push(rule("aligned-native", "category-other"));
    let aligned = analyze(&input);
    assert_eq!(
        aligned["categoryClassifications"],
        json!([]),
        "resolver-selected native witness stays native"
    );
    assert_eq!(
        aligned["nativeRuleClassifications"][0]["categoryId"],
        "category-other"
    );
    assert_eq!(
        posting_rule_ids(&aligned, &aligned["nativeRuleSets"][0]),
        vec!["aligned-native"]
    );
    let mut conflicting = correction("category-food", true);
    conflicting["actorId"] = json!("another-actor");
    input["corrections"]
        .as_array_mut()
        .unwrap()
        .push(conflicting);
    let conflict = analyze(&input);
    assert_eq!(conflict["categoryClassifications"], json!([]));
    assert_eq!(conflict["nativeRuleClassifications"], json!([]));
}

#[test]
fn native_financial_leaves_include_pending_uncleared_actual_fields_without_training_history() {
    let mut input = request();
    let mut rows = vec![transaction("target", "2024-03-31", None)];
    for (id, pending, cleared) in [
        ("native-pending", true, true),
        ("native-uncleared", false, false),
    ] {
        let mut row = transaction(id, "2024-03-01", None);
        row["pending"] = json!(pending);
        row["cleared"] = json!(cleared);
        rows.push(row);
        for index in 0..3 {
            let mut excluded = transaction(
                &format!("{id}-history-{index}"),
                "2024-02-01",
                Some("category-food"),
            );
            excluded["pending"] = json!(pending);
            excluded["cleared"] = json!(cleared);
            rows.push(excluded);
        }
    }
    for flag in ["deleted", "isSplitParent", "startingBalance"] {
        let mut row = transaction(&format!("excluded-{flag}"), "2024-03-01", None);
        row[flag] = json!(true);
        rows.push(row);
    }
    for boundary in ["payee", "name", "account", "category"] {
        let mut row = transaction(
            &format!("predicate-mismatch-{boundary}"),
            "2024-03-01",
            None,
        );
        row["pending"] = json!(true);
        match boundary {
            "payee" => row["payeeId"] = json!("payee-other"),
            "name" => row["payeeName"] = json!("Other Market"),
            "account" => row["accountId"] = json!("account-other"),
            "category" => row["categoryId"] = json!("category-food"),
            _ => unreachable!(),
        }
        rows.push(row);
    }
    let mut child = transaction("native-split-child", "2024-03-01", None);
    child["isSplitChild"] = json!(true);
    child["parentId"] = json!("split-parent");
    child["occurrenceId"] = json!("split-parent");
    child["pending"] = json!(true);
    rows.push(child);
    let mut alias_only = transaction("alias-only", "2024-03-01", None);
    alias_only["payeeId"] = Value::Null;
    alias_only["payeeName"] = json!("Not the actual native name");
    alias_only["pending"] = json!(true);
    rows.push(alias_only);
    input["transactions"] = json!(rows);
    input["aliases"] = json!([alias("payee-market", "accepted")]);
    let mut native = rule("actual-native", "category-bills");
    native["trigger"]["conditions"] = json!([
        {"field": "payee", "op": "is", "value": "payee-market", "type": "id"},
        {"field": "payee_name", "op": "is", "value": "corner market", "type": "string"},
        {"field": "account", "op": "is", "value": "account-checking", "type": "id"},
        {"field": "category", "op": "is", "value": null, "type": "id"}
    ]);
    input["rules"] = json!([native]);
    let mut null_payee_native = rule("actual-null-payee-native", "category-other");
    null_payee_native["trigger"]["conditions"] = json!([
        {"field": "payee", "op": "is", "value": null, "type": "id"},
        {"field": "payee_name", "op": "is", "value": "not the actual native name", "type": "string"},
        {"field": "account", "op": "is", "value": "account-checking", "type": "id"},
        {"field": "category", "op": "is", "value": null, "type": "id"}
    ]);
    input["rules"]
        .as_array_mut()
        .unwrap()
        .push(null_payee_native);
    input["suggestionSelection"] = json!({"transactionIds": [], "cursor": null, "limit": 1});
    let output = analyze(&input);
    let native = output["nativeRuleClassifications"].as_array().unwrap();
    assert_eq!(
        native
            .iter()
            .map(|row| row["transactionId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "alias-only",
            "native-pending",
            "native-split-child",
            "native-uncleared",
            "target"
        ],
        "financial leaves match actual fields, not history eligibility or aliases"
    );
    assert_eq!(
        native[0]["categoryId"], "category-other",
        "actual null payee ID is not replaced by accepted alias identity"
    );
    assert_eq!(output["coverage"]["eligibleCount"], 1);
    assert_eq!(
        output["coverage"]["excludedCount"],
        input["transactions"].as_array().unwrap().len() - 1
    );
    assert_eq!(
        output["recurrences"],
        json!([]),
        "pending and uncleared leaves do not create cadence"
    );
    assert_eq!(output["categoryClassifications"], json!([]));
    input["rules"] = json!([]);
    input["suggestionSelection"] =
        json!({"transactionIds": ["target"], "cursor": null, "limit": 1});
    let history_only = analyze(&input);
    assert!(suggestion(&history_only, "target")["categoryId"].is_null());
    assert_eq!(
        suggestion(&history_only, "target")["categoryHistory"]["totalCount"],
        0
    );
}
