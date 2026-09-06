use super::*;

#[test]
fn test_reason_code_as_str() {
    assert_eq!(ReasonCode::StaleSnapshot.as_str(), "stale_snapshot");
    assert_eq!(ReasonCode::MissingAccount.as_str(), "missing_account");
    assert_eq!(ReasonCode::DuplicateDetected.as_str(), "duplicate_detected");
    assert_eq!(
        ReasonCode::UnsupportedSchemaVersion.as_str(),
        "unsupported_schema_version"
    );
}

#[test]
fn test_reason_code_roundtrip_json() {
    let r = ReasonCode::StaleSnapshot;
    let json = serde_json::to_string(&r).unwrap();
    assert_eq!(json, r#""stale_snapshot""#);
    let back: ReasonCode = serde_json::from_str(&json).unwrap();
    assert_eq!(back, ReasonCode::StaleSnapshot);
}

#[test]
fn test_reason_code_deserialize_unknown() {
    let result: Result<ReasonCode, _> = serde_json::from_str(r#""bogus_code""#);
    assert!(result.is_err());
}

#[test]
fn test_blocker_collector() {
    let mut bc = BlockerCollector::new();
    assert!(!bc.has_blockers());
    bc.add_blocker("stale_snapshot", "Snapshot is stale", "_overview");
    bc.add_reason(ReasonCode::StaleSnapshot);
    assert!(bc.has_blockers());
    assert_eq!(bc.blockers.len(), 1);
    assert_eq!(bc.reason_codes.len(), 1);
    assert_eq!(bc.string_reasons(), vec!["stale_snapshot"]);
}

#[test]
fn test_blocker_collector_deduplicates() {
    let mut bc = BlockerCollector::new();
    bc.add_reason(ReasonCode::StaleSnapshot);
    bc.add_reason(ReasonCode::StaleSnapshot);
    assert_eq!(bc.reason_codes.len(), 1);
}

#[test]
fn test_blocker_roundtrip_json() {
    let b = Blocker::new(
        "missing_account",
        "Account 'Savings' not found",
        "savings_acct",
    );
    let json = serde_json::to_string(&b).unwrap();
    let back: Blocker = serde_json::from_str(&json).unwrap();
    assert_eq!(b, back);
    assert!(json.contains("missing_account"));
}
