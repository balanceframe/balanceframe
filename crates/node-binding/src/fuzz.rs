//! Fuzz-style tests for the N-API binding layer.
//!
//! These tests verify that invalid JSON input produces `Err` results rather
//! than panics, and that minimal valid input is handled gracefully.

use super::*;

#[test]
fn test_invalid_json_returns_error_not_panic() {
    let result = analyze_snapshot("not json".into());
    assert!(
        result.is_err(),
        "expected Err for unparseable JSON, got Ok: {:?}",
        result
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("deserialize"),
        "error should mention deserialization failure: {err_msg}"
    );
}

#[test]
fn test_malformed_transaction_missing_fields() {
    let result = plan_set_category(r#"{"id":"tx1"}"#.into());
    assert!(
        result.is_err(),
        "expected Err for malformed input, got Ok: {:?}",
        result
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("deserialize"),
        "error should mention deserialization failure: {err_msg}"
    );
}

#[test]
fn test_null_fields_handled_gracefully() {
    // validate_suggestion expects { suggestion, snapshot }
    // All field names are camelCase due to #[serde(rename_all = "camelCase")]
    // on core_protocol types which re-export financial_core types.
    let input = serde_json::json!({
        "suggestion": {
            "transactionId": "tx1",
            "proposedCategoryId": "cat1",
            "categoryName": "Groceries",
            "confidence": 0.5,
            "reasonCodes": ["exact_payee"],
            "evidence": ["Known payee"]
        },
        "snapshot": {
            "schemaVersion": "1",
            "actualVersion": "25.1.0",
            "snapshotDate": "2026-07-17T00:00:00Z",
            "accounts": [],
            "transactions": [
                {
                    "id": "tx1",
                    "accountId": "a1",
                    "date": "2026-07-17",
                    "payeeId": null,
                    "payeeName": null,
                    "categoryId": null,
                    "categoryName": null,
                    "amount": { "minorUnits": "1000", "currency": "USD" },
                    "cleared": false,
                    "reconciled": false,
                    "importedId": null,
                    "importedPayee": null,
                    "notes": null,
                    "tags": [],
                    "transferAccountId": null,
                    "subtransactions": []
                }
            ],
            "categories": [
                {
                    "id": "cat1",
                    "name": "Groceries",
                    "groupName": null,
                    "isIncome": false,
                    "mtid": null,
                    "deleted": false
                }
            ],
            "payees": [],
            "rules": [],
            "schedules": [],
            "budgets": [],
            "tags": []
        }
    })
    .to_string();

    let result = validate_suggestion(input);
    assert!(
        result.is_ok(),
        "expected Ok for valid input, got Err: {:?}",
        result
    );

    let parsed: serde_json::Value =
        serde_json::from_str(&result.unwrap()).expect("result should be valid JSON");
    assert_eq!(parsed["valid"], true, "suggestion should be valid");
    assert!(
        parsed["reasonCodes"].as_array().unwrap().is_empty(),
        "errors should be empty"
    );
}

#[test]
fn test_validate_provider_suggestion_invalid_json() {
    let result = validate_provider_suggestion("not json at all".into());
    assert!(
        result.is_err(),
        "expected Err for unparseable JSON, got Ok: {:?}",
        result
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("deserialize"),
        "error should mention deserialization failure: {err_msg}"
    );
}

#[test]
fn test_validate_provider_suggestion_missing_fields() {
    // validate_provider_suggestion expects { suggestion, snapshot, candidate, effectivePolicy }
    let result = validate_provider_suggestion(r#"{"suggestion":{}}"#.into());
    assert!(
        result.is_err(),
        "expected Err for partial input, got Ok: {:?}",
        result
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("deserialize"),
        "error should mention deserialization failure: {err_msg}"
    );
}

#[test]
fn test_validate_provider_suggestion_valid() {
    // Full valid input: unresolved candidate, local provider, provenance present.
    let input = serde_json::json!({
        "suggestion": {
            "transactionId": "tx1",
            "proposedCategoryId": "cat1",
            "categoryName": "Groceries",
            "confidence": 0.85,
            "reasonCodes": ["amount_pattern"],
            "evidence": ["Regular amount matches grocery pattern"],
            "provider": "local",
            "createdAt": "2026-07-18T10:00:00Z",
            "provenance": {
                "payloadHash": "abc123",
                "provider": "local",
                "model": "local-classifier-v1",
                "promptVersion": "1.0",
                "inferencePolicyVersion": "1.0",
                "createdAt": "2026-07-18T10:00:00Z",
                "actorId": null
            }
        },
        "snapshot": {
            "schemaVersion": "1",
            "actualVersion": "25.1.0",
            "snapshotDate": "2026-07-18T00:00:00Z",
            "accounts": [],
            "transactions": [
                {
                    "id": "tx1",
                    "accountId": "a1",
                    "date": "2026-07-18",
                    "payeeId": null,
                    "payeeName": null,
                    "categoryId": null,
                    "categoryName": null,
                    "amount": { "minorUnits": "1000", "currency": "USD" },
                    "cleared": false,
                    "reconciled": false,
                    "importedId": null,
                    "importedPayee": null,
                    "notes": null,
                    "tags": [],
                    "transferAccountId": null,
                    "subtransactions": []
                }
            ],
            "categories": [
                {
                    "id": "cat1",
                    "name": "Groceries",
                    "groupName": null,
                    "isIncome": false,
                    "mtid": null,
                    "deleted": false
                }
            ],
            "payees": [],
            "rules": [],
            "schedules": [],
            "budgets": [],
            "tags": []
        },
        "candidate": {
            "transactionId": "tx1",
            "amount": { "minorUnits": "1000", "currency": "USD" },
            "payeeName": null,
            "date": "2026-07-18",
            "reasons": []
        },
        "effectivePolicy": null
    })
    .to_string();

    let result = validate_provider_suggestion(input);
    assert!(
        result.is_ok(),
        "expected Ok for valid provider suggestion, got Err: {:?}",
        result
    );

    let parsed: serde_json::Value =
        serde_json::from_str(&result.unwrap()).expect("result should be valid JSON");
    assert_eq!(parsed["valid"], true, "provider suggestion should be valid");
    assert!(
        parsed["reasonCodes"].as_array().unwrap().is_empty(),
        "reasonCodes should be empty"
    );
    assert!(
        parsed["message"].is_null(),
        "message should be null for valid result"
    );
}

#[test]
fn test_validate_provider_suggestion_disabled_policy() {
    // Valid suggestion blocked by a Disabled inference policy.
    let input = serde_json::json!({
        "suggestion": {
            "transactionId": "tx1",
            "proposedCategoryId": "cat1",
            "categoryName": "Groceries",
            "confidence": 0.85,
            "reasonCodes": ["amount_pattern"],
            "evidence": ["Regular amount matches grocery pattern"],
            "provider": "openai",
            "createdAt": "2026-07-18T10:00:00Z",
            "provenance": {
                "payloadHash": "def456",
                "provider": "openai",
                "model": "gpt-4",
                "promptVersion": "2.0",
                "inferencePolicyVersion": "1.0",
                "createdAt": "2026-07-18T10:00:00Z",
                "actorId": null
            }
        },
        "snapshot": {
            "schemaVersion": "1",
            "actualVersion": "25.1.0",
            "snapshotDate": "2026-07-18T00:00:00Z",
            "accounts": [],
            "transactions": [
                {
                    "id": "tx1",
                    "accountId": "a1",
                    "date": "2026-07-18",
                    "payeeId": null,
                    "payeeName": null,
                    "categoryId": null,
                    "categoryName": null,
                    "amount": { "minorUnits": "1000", "currency": "USD" },
                    "cleared": false,
                    "reconciled": false,
                    "importedId": null,
                    "importedPayee": null,
                    "notes": null,
                    "tags": [],
                    "transferAccountId": null,
                    "subtransactions": []
                }
            ],
            "categories": [
                {
                    "id": "cat1",
                    "name": "Groceries",
                    "groupName": null,
                    "isIncome": false,
                    "mtid": null,
                    "deleted": false
                }
            ],
            "payees": [],
            "rules": [],
            "schedules": [],
            "budgets": [],
            "tags": []
        },
        "candidate": {
            "transactionId": "tx1",
            "amount": { "minorUnits": "1000", "currency": "USD" },
            "payeeName": null,
            "date": "2026-07-18",
            "reasons": []
        },
        "effectivePolicy": "disabled"
    })
    .to_string();

    let result = validate_provider_suggestion(input);
    assert!(
        result.is_ok(),
        "expected Ok (not panic) for policy-blocked input, got Err: {:?}",
        result
    );

    let parsed: serde_json::Value =
        serde_json::from_str(&result.unwrap()).expect("result should be valid JSON");
    assert_eq!(parsed["valid"], false, "should be invalid under disabled policy");
    let codes: Vec<&str> = parsed["reasonCodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(
        codes.contains(&"provider_inference_disabled"),
        "expected provider_inference_disabled in reasonCodes, got: {:?}",
        codes
    );
}
