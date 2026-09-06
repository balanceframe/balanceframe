use super::*;

#[test]
fn test_request_envelope_roundtrip() {
    let env = RequestEnvelope::new("req_001");
    // Timestamp must be non-empty ISO 8601 format
    assert!(!env.timestamp.is_empty(), "timestamp must not be empty");
    assert!(
        env.timestamp.ends_with('Z'),
        "timestamp must end with Z: {}",
        env.timestamp
    );
    assert_eq!(
        env.timestamp.len(),
        20,
        "ISO 8601 format is YYYY-MM-DDTHH:MM:SSZ (20 chars)"
    );
    // Check the basic pattern: 2026-07-18T12:34:56Z
    assert_eq!(env.timestamp.as_bytes()[10], b'T', "expected T separator");
    assert_eq!(env.timestamp.as_bytes()[19], b'Z', "expected Z suffix");
    assert_eq!(
        env.timestamp.as_bytes()[4],
        b'-',
        "expected dash after year"
    );
    assert_eq!(
        env.timestamp.as_bytes()[7],
        b'-',
        "expected dash after month"
    );
    assert_eq!(
        env.timestamp.as_bytes()[13],
        b':',
        "expected colon after hour"
    );
    assert_eq!(
        env.timestamp.as_bytes()[16],
        b':',
        "expected colon after minute"
    );

    let json = serde_json::to_string(&env).unwrap();
    let back: RequestEnvelope = serde_json::from_str(&json).unwrap();
    assert_eq!(env, back);
    assert!(json.contains("requestId"));
    assert!(json.contains("schemaVersion"));
}

#[test]
fn test_request_envelope_timestamp_iso_format() {
    let env = RequestEnvelope::new("req_002");
    let ts = &env.timestamp;
    // Verify full ISO 8601 regex pattern
    assert!(
        ts.len() == 20,
        "expected length 20, got '{}' (len {})",
        ts,
        ts.len()
    );
    // Verify ISO 8601: YYYY-MM-DDTHH:MM:SSZ
    let year: i32 = ts[0..4].parse().unwrap();
    let month: u32 = ts[5..7].parse().unwrap();
    let day: u32 = ts[8..10].parse().unwrap();
    let hour: u32 = ts[11..13].parse().unwrap();
    let minute: u32 = ts[14..16].parse().unwrap();
    let second: u32 = ts[17..19].parse().unwrap();
    assert!(year >= 2025, "year should be >= 2025, got {}", year);
    assert!((1..=12).contains(&month), "month 1-12, got {}", month);
    assert!((1..=31).contains(&day), "day 1-31, got {}", day);
    assert!(hour <= 23, "hour 0-23, got {}", hour);
    assert!(minute <= 59, "minute 0-59, got {}", minute);
    assert!(second <= 59, "second 0-59, got {}", second);
}

#[test]
fn test_response_envelope_ok() {
    let result = serde_json::json!({"findings": []});
    let env = ResponseEnvelope::ok(
        "req_001",
        None,
        Some(AuthorizationContext::observe("usr_1")),
        result,
    );
    assert_eq!(env.status, "ok");
    assert!(env.error.is_none());
    let json = serde_json::to_string(&env).unwrap();
    assert!(json.contains("authorization"));
    assert!(json.contains("actorId"));
}

#[test]
fn test_response_envelope_error() {
    let err = ErrorInfo::new("stale_snapshot", "Snapshot is too old", false);
    let env = ResponseEnvelope::error("req_002", err);
    assert_eq!(env.status, "error");
    assert!(env.error.is_some());
    assert!(env.result.is_null());
    let json = serde_json::to_string(&env).unwrap();
    assert!(json.contains("retryable"));
}

#[test]
fn test_request_envelope_schema_version() {
    let env = RequestEnvelope::new("req_sv");
    assert_eq!(
        env.schema_version, "1",
        "request envelope must emit canonical schemaVersion '1'"
    );
}

#[test]
fn test_response_envelope_ok_schema_version() {
    let env = ResponseEnvelope::ok("req_sv", None, None, serde_json::json!({}));
    assert_eq!(
        env.schema_version, "1",
        "ok response must emit canonical schemaVersion '1'"
    );
}

#[test]
fn test_response_envelope_error_schema_version() {
    let err = ErrorInfo::new("err", "test", false);
    let env = ResponseEnvelope::error("req_sv", err);
    assert_eq!(
        env.schema_version, "1",
        "error response must emit canonical schemaVersion '1'"
    );
}

#[test]
fn test_deserialize_legacy_schema_version_1_0() {
    // Backward compatibility: "1.0" must still be accepted as input.
    let legacy_req =
        r#"{"schemaVersion":"1.0","requestId":"req_legacy","timestamp":"2026-07-18T00:00:00Z"}"#;
    let req: RequestEnvelope =
        serde_json::from_str(legacy_req).expect("legacy schemaVersion '1.0' must deserialize");
    assert_eq!(req.schema_version, "1.0");

    let legacy_res = r#"{"schemaVersion":"1.0","requestId":"req_legacy","status":"ok","dataFreshness":null,"authorization":null,"result":null,"error":null}"#;
    let res: ResponseEnvelope =
        serde_json::from_str(legacy_res).expect("legacy schemaVersion '1.0' must deserialize");
    assert_eq!(res.schema_version, "1.0");
}

#[test]
fn test_authorization_observe() {
    let auth = AuthorizationContext::observe("usr_abc");
    assert!(auth.allowed);
    assert_eq!(auth.capability, "observe");
}

#[test]
fn test_authorization_denied() {
    let auth = AuthorizationContext::denied("usr_abc", "write");
    assert!(!auth.allowed);
}
