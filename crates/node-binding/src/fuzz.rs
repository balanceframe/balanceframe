//! Fuzz-style tests for the N-API binding layer.
//!
//! These tests verify that invalid JSON input produces `Err` results rather
//! than panics, and that minimal valid input is handled gracefully.

use super::*;

// ---------------------------------------------------------------------------
// Invalid JSON → Err, not a panic
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Malformed input (valid JSON but wrong shape) → Err
// ---------------------------------------------------------------------------

#[test]
fn test_malformed_transaction_missing_fields() {
    // `plan_set_category` expects `{ transactionIds: [...], categoryId: "..." }`.
    // `{"id":"tx1"}` is valid JSON but does not match that shape.
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

// ---------------------------------------------------------------------------
// Minimal valid input → Ok
// ---------------------------------------------------------------------------

#[test]
fn test_null_fields_handled_gracefully() {
    let input = serde_json::json!({
        "transactionId": "tx1",
        "amount": { "minorUnits": "1000", "currency": "USD" },
        "date": "2026-07-17",
        "categoryId": "cat1",
        "confidence": 0.5,
        "reasons": [
            { "kind": "ExactPayee", "details": "Known payee" }
        ]
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
        parsed["errors"].as_array().unwrap().is_empty(),
        "errors should be empty"
    );
}
