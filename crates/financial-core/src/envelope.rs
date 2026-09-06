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

    pub fn error(request_id: impl Into<String>, error: ErrorInfo) -> Self {
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
#[cfg(test)]
mod tests;
