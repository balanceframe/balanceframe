use super::*;
use fc::Money;

fn sample_account(id: &str, name: &str) -> Account {
    Account {
        id: id.into(),
        name: name.into(),
        account_type: "checking".into(),
        off_budget: false,
        is_closed: false,
        cleared_balance: Money::new(1000, "USD"),
        imported_balance: Money::new(1000, "USD"),
        mtid: None,
    }
}

fn sample_tx(
    id: &str,
    account_id: &str,
    date: &str,
    cleared: bool,
    category_id: Option<&str>,
) -> Transaction {
    Transaction {
        id: id.into(),
        account_id: account_id.into(),
        date: date.into(),
        payee_id: None,
        payee_name: None,
        category_id: category_id.map(|s| s.into()),
        category_name: None,
        amount: Money::new(100, "USD"),
        cleared,
        reconciled: false,
        imported_id: None,
        imported_payee: None,
        notes: None,
        tags: vec![],
        transfer_account_id: None,
        subtransactions: vec![],
    }
}

fn sample_category(id: &str, name: &str, deleted: bool) -> Category {
    Category {
        id: id.into(),
        name: name.into(),
        group_name: None,
        is_income: false,
        mtid: None,
        deleted,
    }
}

fn make_snapshot() -> ProtocolSnapshot {
    ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
        accounts: vec![sample_account("a1", "Checking")],
        transactions: vec![sample_tx("tx1", "a1", "2026-07-01", true, None)],
        categories: vec![sample_category("c1", "Food", false)],
        payees: vec![],
        rules: vec![],
        schedules: vec![],
        budgets: vec![],
        tags: vec![],
        actual_downloaded_at: Some("2026-07-18T00:00:00Z".into()),
        encrypted: Some(false),
        bank_synced_at: Some("2026-07-17T00:00:00Z".into()),
    }
}

#[test]
fn test_analyze_deterministic_max_results_limits_findings() {
    let snapshot = make_snapshot();
    let request = DeterministicAnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: Some(0),
        },
        request_id: Some("req-1".into()),
        actor_id: None,
    };
    let response = analyze_deterministic(request);
    // max_results=0 should limit non-essential collections to empty
    assert!(response.analysis.repeated_merchants.is_empty());
    assert!(response.analysis.deterministic_classifications.is_empty());
    assert_eq!(
        response.schema_version, "1",
        "deterministic response must emit schemaVersion '1'"
    );
}

#[test]
fn test_analyze_deterministic_error_info_on_blocker() {
    let mut snapshot = make_snapshot();
    // Remove download timestamp to trigger staleness blocker
    snapshot.actual_downloaded_at = None;
    snapshot.encrypted = Some(true);
    let request = DeterministicAnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
        request_id: Some("req-2".into()),
        actor_id: None,
    };
    let response = analyze_deterministic(request);
    // When there are blockers, status should be "error" and error should be populated
    assert_eq!(response.status, "error");
    assert!(
        response.error.is_some(),
        "ErrorInfo should be populated when status is error"
    );
    if let Some(err) = &response.error {
        assert_eq!(err.code, "analysis_error");
    }
    assert_eq!(
        response.schema_version, "1",
        "blocker error response must emit schemaVersion '1'"
    );
}

#[test]
fn test_analyze_deterministic_ok_no_error_info() {
    let snapshot = make_snapshot();
    let request = DeterministicAnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
        request_id: Some("req-3".into()),
        actor_id: None,
    };
    let response = analyze_deterministic(request);
    assert_eq!(response.status, "ok");
    assert!(response.error.is_none(), "No error when status is ok");
    assert_eq!(
        response.schema_version, "1",
        "ok response must emit schemaVersion '1'"
    );
}

// -- maxResults applied to analyze_snapshot ------------------------------

#[test]
fn test_analyze_snapshot_max_results_truncates() {
    let snapshot = make_snapshot();
    let request = AnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: Some(0),
        },
    };
    let result = analyze_snapshot(request);
    // max_results=0 should truncate findings and suggestions, leading to "success"
    assert_eq!(
        result.result_code, "success",
        "max_results=0 truncates all findings -> no issues"
    );
    assert!(result.findings.is_empty());
    assert!(result.suggestions.is_empty());
}

// -----------------------------------------------------------------------
// Schema version contract: emit "1", accept "1.0"
// -----------------------------------------------------------------------

#[test]
fn test_deterministic_response_schema_version_on_unsupported_version() {
    let mut snapshot = make_snapshot();
    snapshot.schema_version = "2.0".into(); // unsupported
    let request = DeterministicAnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
        request_id: Some("req-uv".into()),
        actor_id: None,
    };
    let response = analyze_deterministic(request);
    assert_eq!(
        response.schema_version, "1",
        "error response for unsupported version must still emit schemaVersion '1'"
    );
    assert_eq!(response.status, "error");
    assert!(response.error.is_some());
}

#[test]
fn test_deterministic_accepts_legacy_schema_version_1_0() {
    // "1.0" must still be accepted as input
    let mut snapshot = make_snapshot();
    snapshot.schema_version = "1.0".into();
    let request = DeterministicAnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
        request_id: Some("req-legacy".into()),
        actor_id: None,
    };
    let response = analyze_deterministic(request);
    assert_eq!(
        response.schema_version, "1",
        "response for legacy '1.0' input must emit canonical schemaVersion '1'"
    );
    assert_eq!(response.status, "ok");
}

#[test]
fn test_analysis_accepts_schema_version_1() {
    // Canonical "1" must work as input
    let mut snapshot = make_snapshot();
    snapshot.schema_version = "1".into();
    let request = AnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
    };
    let result = analyze_snapshot(request);
    assert_ne!(
        result.result_code, "error",
        "canonical schema_version '1' must be accepted; got error"
    );
}
