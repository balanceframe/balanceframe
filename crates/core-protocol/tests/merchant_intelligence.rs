use balanceframe_core_protocol::{MerchantAnalysisRequest, MerchantAnalysisResult};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/fixtures/merchant-intelligence.json"
    ))
    .unwrap()
}

fn rejects_request(input: Value) {
    assert!(serde_json::from_value::<MerchantAnalysisRequest>(input).is_err());
}

fn rejects_result(input: Value) {
    assert!(serde_json::from_value::<MerchantAnalysisResult>(input).is_err());
}

#[test]
fn shared_request_preserves_ids_raw_text_and_all_four_availability_states() {
    let expected = fixture()["request"].clone();
    let request: MerchantAnalysisRequest = serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), expected);
    assert_eq!(
        expected["transactions"][0]["importedPayee"]["value"],
        "  CORNER—MARKET  "
    );
    assert_eq!(
        expected["transactions"][0]["description"]["state"],
        "unsupported"
    );
    assert_eq!(
        expected["transactions"][0]["verboseTitle"]["state"],
        "absent"
    );
    assert_eq!(
        expected["transactions"][0]["notes"],
        json!({"state": "empty", "value": ""})
    );
}

#[test]
fn result_round_trips_evidence_source_admission_maps_and_lossless_schedule_range() {
    for specimen in ["result", "recurrenceResult"] {
        let expected = fixture()[specimen].clone();
        let result: MerchantAnalysisResult = serde_json::from_value(expected.clone()).unwrap();
        if specimen == "recurrenceResult" {
            let days: &BTreeMap<String, u32> = &result.recurrences[0].day_of_month;
            let periods: &BTreeMap<String, u32> =
                &result.recurrences[0].occurrences_per_week.period_counts;
            let counts: &BTreeMap<String, u32> = &result.recurrences[0]
                .occurrences_per_week
                .count_distribution;
            assert_eq!(days.get("31"), Some(&2));
            assert_eq!(periods.get("2024-W06"), Some(&0));
            assert_eq!(counts.get("0"), Some(&6));
        }
        assert_eq!(serde_json::to_value(result).unwrap(), expected);
    }
}

#[test]
fn wrong_versions_unknown_fields_and_missing_admission_fail_closed() {
    let base = fixture()["request"].clone();
    for (path, replacement) in [
        ("schemaVersion", json!("2")),
        ("normalizationVersion", json!("merchant/1")),
        ("horizonYears", json!(0)),
        ("horizonYears", json!(11)),
        ("maxEvidence", json!(0)),
        ("maxEvidence", json!(101)),
    ] {
        let mut input = base.clone();
        input[path] = replacement;
        rejects_request(input);
    }
    let mut input = base.clone();
    input["providerResults"] = json!([]);
    rejects_request(input);
    let mut input = base.clone();
    input["transactions"][0]["nativeExecutionConfirmed"] = json!(true);
    rejects_request(input);
    let mut input = base.clone();
    input["sourceAdmission"]["collections"]["rules"] = json!("assumed_complete");
    rejects_request(input);
    let mut input = base;
    input.as_object_mut().unwrap().remove("sourceAdmission");
    rejects_request(input);
    let mut output = fixture()["result"].clone();
    output["confidence"] = json!(1.0);
    rejects_result(output);
}

#[test]
fn availability_state_value_pairs_are_not_silently_completed_or_coerced() {
    for field in ["importedPayee", "description", "verboseTitle", "notes"] {
        for invalid in [
            json!({"state": "present", "value": null}),
            json!({"state": "present", "value": ""}),
            json!({"state": "empty", "value": null}),
            json!({"state": "empty", "value": "not empty"}),
            json!({"state": "absent", "value": ""}),
            json!({"state": "unsupported", "value": "invented"}),
            json!({"state": "unknown", "value": null}),
            json!({"state": "present", "value": "text", "sourceObject": {}}),
        ] {
            let mut input = fixture()["request"].clone();
            input["transactions"][0][field] = invalid;
            rejects_request(input);
        }
    }
}

#[test]
fn civil_dates_and_money_strings_are_validated_without_utc_conversion() {
    for invalid in [
        "2023-02-29",
        "2024-02-30",
        "2024-13-01",
        "2024-3-01",
        "2024-03-31T00:00:00Z",
    ] {
        let mut input = fixture()["request"].clone();
        input["transactions"][0]["date"] = json!(invalid);
        rejects_request(input);
        let mut input = fixture()["request"].clone();
        input["asOfDate"] = json!(invalid);
        rejects_request(input);
    }
    for amount in ["9223372036854775807", "-9223372036854775808", "0"] {
        let mut input = fixture()["request"].clone();
        input["transactions"][0]["amount"]["minorUnits"] = json!(amount);
        let parsed: MerchantAnalysisRequest = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), input);
    }
    for amount in [
        json!(1),
        json!("1.5"),
        json!("01"),
        json!("-0"),
        json!("9223372036854775808"),
        json!("-9223372036854775809"),
    ] {
        let mut input = fixture()["request"].clone();
        input["transactions"][0]["amount"]["minorUnits"] = amount;
        rejects_request(input);
    }
    for currency in ["usd", "", "US", "USDD"] {
        let mut input = fixture()["request"].clone();
        input["transactions"][0]["amount"]["currency"] = json!(currency);
        rejects_request(input);
    }
}

#[test]
fn rational_statistics_maps_and_overflow_uncertainty_have_one_canonical_shape() {
    let base = fixture()["recurrenceResult"].clone();
    let mut overflow = base.clone();
    overflow["recurrences"][0]["varianceNumerator"] = Value::Null;
    overflow["recurrences"][0]["varianceDenominator"] = Value::Null;
    overflow["recurrences"][0]["reasonCodes"] = json!(["amount_statistics_overflow"]);
    let parsed: MerchantAnalysisResult = serde_json::from_value(overflow.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), overflow);
    for (field, invalid) in [
        ("varianceNumerator", json!("-1")),
        ("varianceNumerator", json!("01")),
        (
            "varianceNumerator",
            json!("170141183460469231731687303715884105728"),
        ),
        ("varianceDenominator", json!("0")),
        ("varianceDenominator", Value::Null),
        ("dayOfMonth", json!({"32": 1})),
        ("dayOfWeek", json!({"0": 1})),
        ("monthOfYear", json!({"13": 1})),
        ("yearDistribution", json!({"twenty": 1})),
        ("kind", json!("scheduled")),
        ("decisionState", json!("executed")),
    ] {
        let mut output = base.clone();
        output["recurrences"][0][field] = invalid;
        rejects_result(output);
    }
    let mut output = base.clone();
    output["recurrences"][0]["occurrencesPerWeek"]["periodCounts"] = json!([["2024-W05", 1]]);
    rejects_result(output);
    let mut output = base;
    output["recurrences"][0]["occurrencesPerMonth"]["averageDenominator"] = json!("0");
    rejects_result(output);
}

#[test]
fn semantic_suggestions_cannot_assert_execution_or_economic_relationship_fields() {
    for (field, value) in [
        ("transactionIdentity", json!("other-transaction")),
        ("economicObligationId", json!("obligation-1")),
        ("executionResult", json!({"verified": true})),
    ] {
        let mut output = fixture()["result"].clone();
        output["suggestions"][0]["evidence"][0][field] = value;
        rejects_result(output);
    }
    let mut output = fixture()["recurrenceResult"].clone();
    output["scheduledExpectations"][0]["source"]["amount"] =
        json!({"minorUnits": 100, "currency": "USD"});
    rejects_result(output);
}

#[test]
fn full_category_history_and_compact_native_classifications_roundtrip_with_strict_counts() {
    let mut output = fixture()["result"].clone();
    output["suggestions"][0]["categoryHistory"] = json!({
        "totalCount": 7, "categoryCount": 2, "truncated": true, "entries": [{
            "categoryId": "category-food", "count": 6, "ledgerCount": 5, "correctionCount": 1,
            "firstDate": "2024-01-01", "lastDate": "2024-03-31"
        }]
    });
    output["suggestions"][0]["alternatives"] = json!([{
        "categoryId": "category-bills", "supportCount": 1, "tier": "insufficient_data", "reasonCodes": ["scoped_history"]
    }]);
    output["suggestions"][0]["ruleCandidates"] = json!([]);
    output["nativeRuleBlocks"] = json!([{"ruleIds": ["native-rule"]}]);
    output["nativeRuleParts"] = json!([{"blockIndexes": [0]}]);
    output["nativeRuleSets"] =
        json!([{"orPartIndexes": [0], "andPartIndexes": [], "categoryPartIndex": 0}]);
    output["nativeRuleClassifications"] = json!([{
        "transactionId": "tx-source", "accountId": "account-checking",
        "categoryId": "category-bills", "ruleSetIndex": 0
    }]);
    let parsed: MerchantAnalysisResult = serde_json::from_value(output.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), output);
    for (field, value) in [
        ("count", json!(-1)),
        ("count", json!(4294967296u64)),
        ("correctionCount", json!(2)),
        ("firstDate", json!("2024-02-30")),
        ("lastDate", json!("2023-01-01")),
    ] {
        let mut invalid = output.clone();
        invalid["suggestions"][0]["categoryHistory"]["entries"][0][field] = value;
        rejects_result(invalid);
    }
    let mut invalid = output.clone();
    invalid["suggestions"][0]["categoryHistory"]["truncated"] = json!(false);
    rejects_result(invalid);
    let mut invalid = output.clone();
    invalid["nativeRuleClassifications"]
        .as_array_mut()
        .unwrap()
        .push(output["nativeRuleClassifications"][0].clone());
    rejects_result(invalid);
    let mut invalid = output;
    invalid["suggestions"][0]["ruleCandidates"] = json!([{
        "payeeId": "payee-market", "categoryId": "category-food",
        "supportCount": 6, "consistencyNumerator": 5, "consistencyDenominator": 7
    }]);
    rejects_result(invalid);
}

#[test]
fn shared_native_rule_sets_are_required_and_deny_invalid_indexes_and_inline_ids() {
    let mut output = fixture()["result"].clone();
    output["nativeRuleBlocks"] = json!([{"ruleIds": ["native-rule-a", "native-rule-b"]}]);
    output["nativeRuleParts"] = json!([{"blockIndexes": [0]}]);
    output["nativeRuleSets"] =
        json!([{"orPartIndexes": [0], "andPartIndexes": [], "categoryPartIndex": 0}]);
    output["nativeRuleClassifications"] = json!([{
        "transactionId": "tx-source", "accountId": "account-checking",
        "categoryId": "category-bills", "ruleSetIndex": 0
    }]);
    let parsed: MerchantAnalysisResult = serde_json::from_value(output.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), output);
    let mut missing = output.clone();
    missing.as_object_mut().unwrap().remove("nativeRuleSets");
    rejects_result(missing);
    let mut empty = output.clone();
    empty["nativeRuleSets"] = json!([]);
    rejects_result(empty);
    for index in [
        Value::Null,
        json!(-1),
        json!(0.5),
        json!("0"),
        json!(1),
        json!(4294967296u64),
    ] {
        let mut invalid = output.clone();
        invalid["nativeRuleClassifications"][0]["ruleSetIndex"] = index;
        rejects_result(invalid);
    }
    let mut missing_index = output.clone();
    missing_index["nativeRuleClassifications"][0]
        .as_object_mut()
        .unwrap()
        .remove("ruleSetIndex");
    rejects_result(missing_index);
    let mut inline = output.clone();
    inline["nativeRuleClassifications"][0]["ruleIds"] = json!(["native-rule-a", "native-rule-b"]);
    rejects_result(inline);
    for ids in [
        json!([]),
        json!(["native-rule-a", "native-rule-a"]),
        json!([""]),
        json!(["native-rule-b", "native-rule-a"]),
    ] {
        let mut invalid = output.clone();
        invalid["nativeRuleBlocks"][0]["ruleIds"] = ids;
        rejects_result(invalid);
    }
    let mut duplicate = output.clone();
    duplicate["nativeRuleClassifications"]
        .as_array_mut()
        .unwrap()
        .push(output["nativeRuleClassifications"][0].clone());
    rejects_result(duplicate);
    let mut valid_empty = fixture()["result"].clone();
    valid_empty["nativeRuleSets"] = json!([]);
    assert!(serde_json::from_value::<MerchantAnalysisResult>(valid_empty.clone()).is_ok());
    valid_empty
        .as_object_mut()
        .unwrap()
        .remove("nativeRuleSets");
    rejects_result(valid_empty);
}

#[test]
fn native_rule_blocks_validate_global_id_closure_and_complete_references() {
    let mut output = fixture()["result"].clone();
    output["nativeRuleBlocks"] = json!([
        {"ruleIds": ["native-rule-a", "native-rule-b"]}, {"ruleIds": ["native-rule-c"]}
    ]);
    output["nativeRuleParts"] = json!([{"blockIndexes": [0, 1]}]);
    output["nativeRuleSets"] =
        json!([{"orPartIndexes": [0], "andPartIndexes": [], "categoryPartIndex": 0}]);
    output["nativeRuleClassifications"] = json!([{
        "transactionId": "tx-source", "accountId": "account-checking",
        "categoryId": "category-bills", "ruleSetIndex": 0
    }]);
    let parsed: MerchantAnalysisResult = serde_json::from_value(output.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), output);
    for field in ["nativeRuleBlocks", "nativeRuleParts", "nativeRuleSets"] {
        let mut missing = output.clone();
        missing.as_object_mut().unwrap().remove(field);
        rejects_result(missing);
    }
    let mut duplicate = output.clone();
    duplicate["nativeRuleBlocks"][1]["ruleIds"] = json!(["native-rule-b"]);
    rejects_result(duplicate);
    for indexes in [
        json!([]),
        json!([0, 0]),
        json!([1, 0]),
        json!([0, 2]),
        json!([-1]),
        json!([0.5]),
        json!(["0"]),
        json!([4294967296u64]),
        Value::Null,
    ] {
        let mut invalid = output.clone();
        invalid["nativeRuleParts"][0]["blockIndexes"] = indexes;
        rejects_result(invalid);
    }
    let mut inline_set = output.clone();
    inline_set["nativeRuleSets"][0]["ruleIds"] =
        json!(["native-rule-a", "native-rule-b", "native-rule-c"]);
    rejects_result(inline_set);
    let mut unicode = output.clone();
    unicode["nativeRuleBlocks"][0]["ruleIds"] = json!(["rule-\u{e000}", "rule-\u{10000}"]);
    let parsed: MerchantAnalysisResult = serde_json::from_value(unicode.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), unicode);
    unicode["nativeRuleBlocks"][0]["ruleIds"]
        .as_array_mut()
        .unwrap()
        .reverse();
    rejects_result(unicode);
    let mut byte_bound = output.clone();
    byte_bound["nativeRuleBlocks"][0]["ruleIds"] = json!(["é".repeat(128)]);
    assert!(serde_json::from_value::<MerchantAnalysisResult>(byte_bound.clone()).is_ok());
    byte_bound["nativeRuleBlocks"][0]["ruleIds"] = json!(["é".repeat(129)]);
    rejects_result(byte_bound);
    let mut over_total = output.clone();
    over_total["nativeRuleBlocks"] = json!([
        {"ruleIds": (0..50_000).map(|index| format!("total-rule-{index:06}")).collect::<Vec<_>>()},
        {"ruleIds": (50_000..100_001).map(|index| format!("total-rule-{index:06}")).collect::<Vec<_>>()}
    ]);
    rejects_result(over_total);
}

#[test]
fn posting_expressions_accept_overlap_and_deny_empty_classified_intersections_and_noncanonical_operands(
) {
    let mut output = fixture()["result"].clone();
    output["nativeRuleBlocks"] = json!([
        {"ruleIds": ["posting-a", "posting-b"]}, {"ruleIds": ["posting-c"]}
    ]);
    output["nativeRuleParts"] = json!([
        {"blockIndexes": [0, 1]}, {"blockIndexes": [0]}, {"blockIndexes": [1]}
    ]);
    output["nativeRuleSets"] = json!([{
        "orPartIndexes": [0, 1], "andPartIndexes": [[1, 2], [0], [0], [0]], "categoryPartIndex": 0
    }]);
    output["nativeRuleClassifications"] = json!([{
        "transactionId": "tx-source", "accountId": "account-checking", "categoryId": "category-bills", "ruleSetIndex": 0
    }]);
    let parsed: MerchantAnalysisResult = serde_json::from_value(output.clone()).expect(
        "literal overlapping parts and fixed category-filtered OR/AND expression are valid",
    );
    assert_eq!(serde_json::to_value(parsed).unwrap(), output);
    let mut missing = output.clone();
    missing.as_object_mut().unwrap().remove("nativeRuleParts");
    rejects_result(missing);
    for indexes in [
        json!([]),
        json!([0, 0]),
        json!([1, 0]),
        json!([-1]),
        json!([0.5]),
        json!(["0"]),
        json!([2]),
        json!([4294967296u64]),
        Value::Null,
    ] {
        let mut invalid = output.clone();
        invalid["nativeRuleParts"][0]["blockIndexes"] = indexes;
        rejects_result(invalid);
    }
    for expression in [
        json!({"orPartIndexes": [], "andPartIndexes": [], "categoryPartIndex": 0}),
        json!({"orPartIndexes": [], "andPartIndexes": [[1], [2], [1], [2]], "categoryPartIndex": 0}),
        json!({"orPartIndexes": [1], "andPartIndexes": [], "categoryPartIndex": 2}),
        json!({"orPartIndexes": [0, 0], "andPartIndexes": [], "categoryPartIndex": 0}),
        json!({"orPartIndexes": [0], "andPartIndexes": [[0], [0]], "categoryPartIndex": 0}),
        json!({"orPartIndexes": [0], "andPartIndexes": [[0], [0], [0]], "categoryPartIndex": 0}),
        json!({"orPartIndexes": [], "andPartIndexes": [[], [0], [0], [0]], "categoryPartIndex": 0}),
        json!({"orPartIndexes": [0], "andPartIndexes": [[0, 1, 2], [0], [0], [0]], "categoryPartIndex": 0}),
        json!({"orPartIndexes": [0], "andPartIndexes": [[0, 0], [0], [0], [0]], "categoryPartIndex": 0}),
        json!({"orPartIndexes": [0], "andPartIndexes": [[1, 0], [0], [0], [0]], "categoryPartIndex": 0}),
        json!({"orPartIndexes": [0], "andPartIndexes": [], "categoryPartIndex": 3}),
        json!({"orPartIndexes": [3], "andPartIndexes": [], "categoryPartIndex": 0}),
        json!({"orPartIndexes": [0], "andPartIndexes": [], "categoryPartIndex": null}),
        json!({"orPartIndexes": [0], "andPartIndexes": []}),
        json!({"orPartIndexes": [0], "andPartIndexes": [], "categoryPartIndex": 0, "blockIndexes": [0]}),
    ] {
        let mut invalid = output.clone();
        invalid["nativeRuleSets"][0] = expression;
        rejects_result(invalid);
    }
    let mut unused = output.clone();
    unused["nativeRuleSets"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "orPartIndexes": [], "andPartIndexes": [], "categoryPartIndex": 0
        }));
    rejects_result(unused);
}

#[test]
fn empty_and_operands_normalize_after_original_reference_closure_validation() {
    let mut output = fixture()["result"].clone();
    output["nativeRuleBlocks"] = json!([{"ruleIds": ["native-rule"]}]);
    output["nativeRuleParts"] = json!([{"blockIndexes": [0]}]);
    output["nativeRuleSets"] = json!([{"orPartIndexes": [0], "andPartIndexes": [[], [0], [0], [0]], "categoryPartIndex": 0}]);
    output["nativeRuleClassifications"] = json!([{
        "transactionId": "tx-source", "accountId": "account-checking", "categoryId": "category-bills", "ruleSetIndex": 0
    }]);
    let parsed: MerchantAnalysisResult = serde_json::from_value(output.clone()).unwrap();
    assert!(parsed.native_rule_sets[0].and_part_indexes.is_empty());
    let mut canonical = output.clone();
    canonical["nativeRuleSets"][0]["andPartIndexes"] = json!([]);
    assert_eq!(serde_json::to_value(parsed).unwrap(), canonical);
    for operands in [
        json!([[], [1], [0], [0]]),
        json!([[], [0, 0], [0], [0]]),
        json!([[], [-1], [0], [0]]),
        json!([[], [0]]),
        json!([[], [0], [0]]),
        json!([[], [0, 1, 2], [0], [0]]),
    ] {
        let mut invalid = output.clone();
        invalid["nativeRuleSets"][0]["andPartIndexes"] = operands;
        rejects_result(invalid);
    }
}

#[test]
fn compact_category_classifications_are_mandatory_strict_and_close_native_target_identity() {
    let mut output = fixture()["result"].clone();
    output["categoryClassifications"] = json!([{
        "transactionId": "compact-target", "accountId": "account-checking", "payeeId": "payee-market",
        "categoryId": "category-food", "tier": "inferred", "evidenceRevision": "sha256:compact-fixture"
    }]);
    let parsed: MerchantAnalysisResult = serde_json::from_value(output.clone())
        .expect("canonical result accepts the mandatory complete compact table");
    assert_eq!(serde_json::to_value(parsed).unwrap(), output);
    for tier in ["confirmed", "inferred"] {
        let mut nullable = output.clone();
        nullable["categoryClassifications"][0]["payeeId"] = Value::Null;
        nullable["categoryClassifications"][0]["tier"] = json!(tier);
        assert!(serde_json::from_value::<MerchantAnalysisResult>(nullable).is_ok());
    }
    let mut missing = output.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("categoryClassifications");
    rejects_result(missing);
    for field in [
        "transactionId",
        "accountId",
        "payeeId",
        "categoryId",
        "tier",
        "evidenceRevision",
    ] {
        let mut missing = output.clone();
        missing["categoryClassifications"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        rejects_result(missing);
    }
    for (field, value) in [
        ("transactionId", json!("")),
        ("accountId", json!("")),
        ("payeeId", json!("")),
        ("categoryId", Value::Null),
        ("categoryId", json!("")),
        ("evidenceRevision", json!("")),
        ("tier", json!("deterministic_match")),
        ("tier", json!("conflicting")),
        ("tier", json!("insufficient_data")),
        ("ruleSetIndex", json!(0)),
        ("evidence", json!([])),
        ("accountId", json!("outside-source-account")),
        ("categoryId", json!("outside-source-category")),
    ] {
        let mut invalid = output.clone();
        invalid["categoryClassifications"][0][field] = value;
        rejects_result(invalid);
    }
    let mut duplicate = output.clone();
    duplicate["categoryClassifications"]
        .as_array_mut()
        .unwrap()
        .push(output["categoryClassifications"][0].clone());
    rejects_result(duplicate);
    let mut both = output.clone();
    both["nativeRuleBlocks"] = json!([{"ruleIds": ["native-fixture"]}]);
    both["nativeRuleParts"] = json!([{"blockIndexes": [0]}]);
    both["nativeRuleSets"] =
        json!([{"orPartIndexes": [0], "andPartIndexes": [], "categoryPartIndex": 0}]);
    both["nativeRuleClassifications"] = json!([{
        "transactionId": "compact-target", "accountId": "account-checking",
        "categoryId": "category-food", "ruleSetIndex": 0
    }]);
    rejects_result(both);
    let mut empty = output;
    empty["categoryClassifications"] = json!([]);
    assert!(serde_json::from_value::<MerchantAnalysisResult>(empty).is_ok());
}
