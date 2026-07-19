//! Versioned request / result / error envelope types.
//!
//! These types wrap analysis payloads with the metadata required by the
//! CLI JSON envelope contract (schema version, request ID, freshness,
//! authorization context).

use serde::{Deserialize, Serialize};

use std::time::{SystemTime, UNIX_EPOCH};

use crate::freshness::DataFreshness;

// ---------------------------------------------------------------------------
// RequestEnvelope
// ---------------------------------------------------------------------------

/// Every API request carries its schema version and a unique request ID.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEnvelope {
    pub schema_version: String,
    pub request_id: String,
    pub timestamp: String,
}

impl RequestEnvelope {
    /// Create a new request envelope with the current UTC timestamp in ISO 8601
    /// format (`YYYY-MM-DDTHH:MM:SSZ`).
    pub fn new(request_id: impl Into<String>) -> Self {
        RequestEnvelope {
            schema_version: "1".into(),
            request_id: request_id.into(),
            timestamp: iso8601_now(),
        }
    }
}

/// Current UTC time as an ISO 8601 string (`YYYY-MM-DDTHH:MM:SSZ`).
///
/// Uses only [`std::time`] — no external dependency.
pub(crate) fn iso8601_now() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();

    // ---- date (Hinnant civil‑from‑days) ----------------------------------
    let z = (secs / 86_400) as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    // ---- time -------------------------------------------------------------
    let tod = secs % 86_400;
    let h = tod / 3_600;
    let mi = (tod % 3_600) / 60;
    let s = tod % 60;

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, h, mi, s)
}

// ---------------------------------------------------------------------------
// AuthorizationContext
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationContext {
    pub actor_id: String,
    pub capability: String,
    pub allowed: bool,
}

impl AuthorizationContext {
    pub fn observe(actor_id: impl Into<String>) -> Self {
        AuthorizationContext {
            actor_id: actor_id.into(),
            capability: "observe".into(),
            allowed: true,
        }
    }

    pub fn denied(actor_id: impl Into<String>, capability: impl Into<String>) -> Self {
        AuthorizationContext {
            actor_id: actor_id.into(),
            capability: capability.into(),
            allowed: false,
        }
    }
}

// ---------------------------------------------------------------------------
// ErrorInfo
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorInfo {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub reason_codes: Vec<String>,
}

impl ErrorInfo {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        ErrorInfo {
            code: code.into(),
            message: message.into(),
            retryable,
            reason_codes: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// ResponseEnvelope
// ---------------------------------------------------------------------------

/// Standard JSON envelope for every CLI / API response.
///
/// The `result` field contains the actual payload as a `serde_json::Value`
/// so that a single type can wrap any structured result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseEnvelope {
    pub schema_version: String,
    pub request_id: String,
    pub status: String,
    pub data_freshness: Option<DataFreshness>,
    pub authorization: Option<AuthorizationContext>,
    pub result: serde_json::Value,
    pub error: Option<ErrorInfo>,
}

impl ResponseEnvelope {
    pub fn ok(
        request_id: impl Into<String>,
        data_freshness: Option<DataFreshness>,
        auth: Option<AuthorizationContext>,
        result: serde_json::Value,
    ) -> Self {
        ResponseEnvelope {
            schema_version: "1".into(),
            request_id: request_id.into(),
            status: "ok".into(),
            data_freshness,
            authorization: auth,
            result,
            error: None,
        }
    }

    pub fn error(
        request_id: impl Into<String>,
        error: ErrorInfo,
    ) -> Self {
        ResponseEnvelope {
            schema_version: "1".into(),
            request_id: request_id.into(),
            status: "error".into(),
            data_freshness: None,
            authorization: None,
            result: serde_json::Value::Null,
            error: Some(error),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
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
        assert_eq!(env.timestamp.len(), 20, "ISO 8601 format is YYYY-MM-DDTHH:MM:SSZ (20 chars)");
        // Check the basic pattern: 2026-07-18T12:34:56Z
        assert_eq!(env.timestamp.as_bytes()[10], b'T', "expected T separator");
        assert_eq!(env.timestamp.as_bytes()[19], b'Z', "expected Z suffix");
        assert_eq!(env.timestamp.as_bytes()[4], b'-', "expected dash after year");
        assert_eq!(env.timestamp.as_bytes()[7], b'-', "expected dash after month");
        assert_eq!(env.timestamp.as_bytes()[13], b':', "expected colon after hour");
        assert_eq!(env.timestamp.as_bytes()[16], b':', "expected colon after minute");

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
        assert_eq!(env.schema_version, "1", "request envelope must emit canonical schemaVersion '1'");
    }

    #[test]
    fn test_response_envelope_ok_schema_version() {
        let env = ResponseEnvelope::ok("req_sv", None, None, serde_json::json!({}));
        assert_eq!(env.schema_version, "1", "ok response must emit canonical schemaVersion '1'");
    }

    #[test]
    fn test_response_envelope_error_schema_version() {
        let err = ErrorInfo::new("err", "test", false);
        let env = ResponseEnvelope::error("req_sv", err);
        assert_eq!(env.schema_version, "1", "error response must emit canonical schemaVersion '1'");
    }

    #[test]
    fn test_deserialize_legacy_schema_version_1_0() {
        // Backward compatibility: "1.0" must still be accepted as input.
        let legacy_req = r#"{"schemaVersion":"1.0","requestId":"req_legacy","timestamp":"2026-07-18T00:00:00Z"}"#;
        let req: RequestEnvelope = serde_json::from_str(legacy_req)
            .expect("legacy schemaVersion '1.0' must deserialize");
        assert_eq!(req.schema_version, "1.0");

        let legacy_res = r#"{"schemaVersion":"1.0","requestId":"req_legacy","status":"ok","dataFreshness":null,"authorization":null,"result":null,"error":null}"#;
        let res: ResponseEnvelope = serde_json::from_str(legacy_res)
            .expect("legacy schemaVersion '1.0' must deserialize");
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
}
