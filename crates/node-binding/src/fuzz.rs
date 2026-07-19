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
            "payloadHash": "abc123",
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
        "effectivePolicy": "localOnly"
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
            "payloadHash": "def456",
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

#[test]
fn test_napi_omitted_policy_fails_closed() {
    // External provider suggestion with effectivePolicy omitted must be
    // rejected (fail-closed -> treated as Disabled).
    let input = serde_json::json!({
        "suggestion": {
            "transactionId": "tx1",
            "proposedCategoryId": "cat1",
            "categoryName": "Groceries",
            "confidence": 0.85,
            "reasonCodes": ["amount_pattern"],
            "evidence": ["Regular amount matches grocery pattern"],
            "payloadHash": "abc123",
            "provider": "openai",
            "createdAt": "2026-07-18T10:00:00Z",
            "provenance": {
                "payloadHash": "abc123",
                "provider": "openai",
                "model": "gpt-4",
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
        }
        // NOTE: effectivePolicy is intentionally omitted
    }).to_string();

    let result = validate_provider_suggestion(input);
    assert!(result.is_ok(), "policy block must not cause panic");
    let parsed: serde_json::Value =
        serde_json::from_str(&result.unwrap()).expect("valid JSON");
    assert_eq!(parsed["valid"], false, "omitted policy must be treated as Disabled");
    let codes: Vec<&str> = parsed["reasonCodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(
        codes.contains(&"provider_inference_disabled"),
        "expected provider_inference_disabled when policy is omitted, got: {:?}",
        codes
    );
}
// ---------------------------------------------------------------------------
// N-API negative tests: panic containment, stale versions, deleted
// categories, local-only/external policy, and mismatched IDs.
// ---------------------------------------------------------------------------

#[test]
fn test_napi_panic_containment() {
    // Even deeply invalid input must not crash the Node process.
    // The binding catches panics and returns Err.
    let result = analyze_snapshot(r#"{{{{"#.into());
    assert!(result.is_err(), "panicked JSON must return Err, not crash");
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("deserialize") || err.contains("Panic"),
        "error must mention deserialization failure or panic containment: {err}"
    );
}

#[test]
fn test_napi_stale_version_rejected() {
    // Suggestion with a transaction_version that does not match the computed
    // trustworthy version from the snapshot must be rejected.
    let input = serde_json::json!({
        "suggestion": {
            "transactionId": "tx1",
            "proposedCategoryId": "cat1",
            "categoryName": "Groceries",
            "confidence": 0.85,
            "reasonCodes": ["amount_pattern"],
            "evidence": ["Pattern match"],
            "transactionVersion": "txv0000000000000000",
            "provider": "openai",
            "createdAt": "2026-07-18T10:00:00Z",
            "payloadHash": "hash_stale",
            "provenance": {
                "payloadHash": "hash_stale",
                "provider": "openai",
                "model": "gpt-4",
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
            "transactions": [{
                "id": "tx1", "accountId": "a1", "date": "2026-07-18",
                "payeeId": null, "payeeName": null,
                "categoryId": null, "categoryName": null,
                "amount": { "minorUnits": "1000", "currency": "USD" },
                "cleared": false, "reconciled": false,
                "importedId": null, "importedPayee": null,
                "notes": null, "tags": [],
                "transferAccountId": null, "subtransactions": []
            }],
            "categories": [{
                "id": "cat1", "name": "Groceries",
                "groupName": null, "isIncome": false,
                "mtid": null, "deleted": false
            }],
            "payees": [], "rules": [], "schedules": [],
            "budgets": [], "tags": []
        },
        "candidate": {
            "transactionId": "tx1",
            "amount": { "minorUnits": "1000", "currency": "USD" },
            "payeeName": null, "date": "2026-07-18",
            "reasons": []
        },
        "effectivePolicy": "externalAllowed"
    }).to_string();

    let result = validate_provider_suggestion(input);
    assert!(result.is_ok(), "stale version must not cause panic");
    let parsed: serde_json::Value =
        serde_json::from_str(&result.unwrap()).expect("valid JSON");
    assert_eq!(parsed["valid"], false);
    assert!(parsed["reasonCodes"]
        .as_array().unwrap().iter()
        .any(|c| c.as_str() == Some("stale_transaction_version")),
        "must reject stale transaction version");
}

#[test]
fn test_napi_deleted_category_rejected() {
    // Suggestion proposing a deleted category must be rejected.
    let input = serde_json::json!({
        "suggestion": {
            "transactionId": "tx1",
            "proposedCategoryId": "cat_del",
            "categoryName": "Old Category",
            "confidence": 0.85,
            "reasonCodes": ["amount_pattern"],
            "evidence": ["Pattern match"],
            "provider": "openai",
            "createdAt": "2026-07-18T10:00:00Z",
            "payloadHash": "hash_del",
            "provenance": {
                "payloadHash": "hash_del",
                "provider": "openai",
                "model": "gpt-4",
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
            "transactions": [{
                "id": "tx1", "accountId": "a1", "date": "2026-07-18",
                "payeeId": null, "payeeName": null,
                "categoryId": null, "categoryName": null,
                "amount": { "minorUnits": "1000", "currency": "USD" },
                "cleared": false, "reconciled": false,
                "importedId": null, "importedPayee": null,
                "notes": null, "tags": [],
                "transferAccountId": null, "subtransactions": []
            }],
            "categories": [{
                "id": "cat_del", "name": "Old Category",
                "groupName": null, "isIncome": false,
                "mtid": null, "deleted": true
            }],
            "payees": [], "rules": [], "schedules": [],
            "budgets": [], "tags": []
        },
        "candidate": {
            "transactionId": "tx1",
            "amount": { "minorUnits": "1000", "currency": "USD" },
            "payeeName": null, "date": "2026-07-18",
            "reasons": []
        },
        "effectivePolicy": "externalAllowed"
    }).to_string();

    let result = validate_provider_suggestion(input);
    assert!(result.is_ok(), "deleted category must not cause panic");
    let parsed: serde_json::Value =
        serde_json::from_str(&result.unwrap()).expect("valid JSON");
    assert_eq!(parsed["valid"], false);
    assert!(parsed["reasonCodes"]
        .as_array().unwrap().iter()
        .any(|c| c.as_str() == Some("category_not_found")),
        "must reject deleted category");
}

#[test]
fn test_napi_local_only_blocks_external_provider() {
    // External provider suggestion under LocalOnly policy must be rejected.
    let input = serde_json::json!({
        "suggestion": {
            "transactionId": "tx1",
            "proposedCategoryId": "cat1",
            "categoryName": "Groceries",
            "confidence": 0.85,
            "reasonCodes": ["amount_pattern"],
            "evidence": ["Pattern match"],
            "provider": "openai",
            "createdAt": "2026-07-18T10:00:00Z",
            "payloadHash": "hash_ext",
            "provenance": {
                "payloadHash": "hash_ext",
                "provider": "openai",
                "model": "gpt-4",
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
            "transactions": [{
                "id": "tx1", "accountId": "a1", "date": "2026-07-18",
                "payeeId": null, "payeeName": null,
                "categoryId": null, "categoryName": null,
                "amount": { "minorUnits": "1000", "currency": "USD" },
                "cleared": false, "reconciled": false,
                "importedId": null, "importedPayee": null,
                "notes": null, "tags": [],
                "transferAccountId": null, "subtransactions": []
            }],
            "categories": [{
                "id": "cat1", "name": "Groceries",
                "groupName": null, "isIncome": false,
                "mtid": null, "deleted": false
            }],
            "payees": [], "rules": [], "schedules": [],
            "budgets": [], "tags": []
        },
        "candidate": {
            "transactionId": "tx1",
            "amount": { "minorUnits": "1000", "currency": "USD" },
            "payeeName": null, "date": "2026-07-18",
            "reasons": []
        },
        "effectivePolicy": "localOnly"
    }).to_string();

    let result = validate_provider_suggestion(input);
    assert!(result.is_ok(), "policy block must not cause panic");
    let parsed: serde_json::Value =
        serde_json::from_str(&result.unwrap()).expect("valid JSON");
    assert_eq!(parsed["valid"], false);
    assert!(parsed["reasonCodes"]
        .as_array().unwrap().iter()
        .any(|c| c.as_str() == Some("external_provider_not_allowed")),
        "LocalOnly must block external provider");
}

#[test]
fn test_napi_mismatched_tx_id_rejected() {
    // Suggestion.transactionId != candidate.transactionId must be rejected.
    let input = serde_json::json!({
        "suggestion": {
            "transactionId": "tx_sugg",
            "proposedCategoryId": "cat1",
            "categoryName": "Groceries",
            "confidence": 0.85,
            "reasonCodes": ["amount_pattern"],
            "evidence": ["Pattern match"],
            "provider": "openai",
            "createdAt": "2026-07-18T10:00:00Z",
            "payloadHash": "hash_mid",
            "provenance": {
                "payloadHash": "hash_mid",
                "provider": "openai",
                "model": "gpt-4",
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
                    "id": "tx_sugg", "accountId": "a1", "date": "2026-07-18",
                    "payeeId": null, "payeeName": null,
                    "categoryId": null, "categoryName": null,
                    "amount": { "minorUnits": "1000", "currency": "USD" },
                    "cleared": false, "reconciled": false,
                    "importedId": null, "importedPayee": null,
                    "notes": null, "tags": [],
                    "transferAccountId": null, "subtransactions": []
                }
            ],
            "categories": [{
                "id": "cat1", "name": "Groceries",
                "groupName": null, "isIncome": false,
                "mtid": null, "deleted": false
            }],
            "payees": [], "rules": [], "schedules": [],
            "budgets": [], "tags": []
        },
        "candidate": {
            "transactionId": "tx_candidate",
            "amount": { "minorUnits": "1000", "currency": "USD" },
            "payeeName": null, "date": "2026-07-18",
            "reasons": []
        },
        "effectivePolicy": "externalAllowed"
    }).to_string();

    let result = validate_provider_suggestion(input);
    assert!(result.is_ok(), "mismatched IDs must not cause panic");
    let parsed: serde_json::Value =
        serde_json::from_str(&result.unwrap()).expect("valid JSON");
    assert_eq!(parsed["valid"], false);
    assert!(parsed["reasonCodes"]
        .as_array().unwrap().iter()
        .any(|c| c.as_str() == Some("transaction_id_mismatch")),
        "must reject mismatched transaction IDs");
}
