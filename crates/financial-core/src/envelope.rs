//! Versioned request / result / error envelope types.
//!
//! These types wrap analysis payloads with the metadata required by the
//! CLI JSON envelope contract (schema version, request ID, freshness,
//! authorization context).

use serde::{Deserialize, Serialize};

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
    pub fn new(request_id: impl Into<String>) -> Self {
        RequestEnvelope {
            schema_version: "1.0".into(),
            request_id: request_id.into(),
            timestamp: String::new(),
        }
    }
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
            schema_version: "1.0".into(),
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
            schema_version: "1.0".into(),
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
        let json = serde_json::to_string(&env).unwrap();
        let back: RequestEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(env, back);
        assert!(json.contains("requestId"));
        assert!(json.contains("schemaVersion"));
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
