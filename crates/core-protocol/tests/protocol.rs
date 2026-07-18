use balanceframe_core_protocol::{
    analyze_snapshot, find_categorization_candidates, plan_set_category, simulate_rule,
    validate_suggestion, verify_mutation, AnalysisOptions, AnalysisRequest, MutationPlan,
    Postcondition, PostconditionType, ProtocolSnapshot, Suggestion,
};
use balanceframe_financial_core::{Account, Category, Money, Rule, Transaction};

fn empty_snapshot() -> ProtocolSnapshot {
    ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![],
        transactions: vec![],
        categories: vec![],
        payees: vec![],
        rules: vec![],
        schedules: vec![],
        budgets: vec![],
        tags: vec![],
        actual_downloaded_at: None,
        encrypted: None,
        bank_synced_at: None,
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

fn sample_transaction(id: &str, category_id: Option<&str>, amount: i64) -> Transaction {
    Transaction {
        id: id.into(),
        account_id: "acct1".into(),
        date: "2026-07-15".into(),
        payee_id: None,
        payee_name: Some("Test Payee".into()),
        category_id: category_id.map(|s| s.into()),
        category_name: None,
        amount: Money::new(amount, "USD"),
        cleared: true,
        reconciled: false,
        imported_id: None,
        imported_payee: None,
        notes: None,
        tags: vec![],
        transfer_account_id: None,
        subtransactions: vec![],
    }
}

// ---------------------------------------------------------------------------
// Round-trip serialization of ProtocolSnapshot
// ---------------------------------------------------------------------------

#[test]
fn test_protocol_snapshot_roundtrip() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![Account {
            id: "acct1".into(),
            name: "Checking".into(),
            account_type: "checking".into(),
            off_budget: false,
            is_closed: false,
            cleared_balance: Money::new(100000, "USD"),
            imported_balance: Money::new(100000, "USD"),
            mtid: None,
        }],
        transactions: vec![sample_transaction("tx1", Some("cat1"), 5000)],
        categories: vec![sample_category("cat1", "Food", false)],
        payees: vec![],
        rules: vec![],
        schedules: vec![],
        budgets: vec![],
        tags: vec![],
        actual_downloaded_at: None,
        encrypted: None,
        bank_synced_at: None,
    };

    let json = serde_json::to_string(&snapshot).unwrap();
    let back: ProtocolSnapshot = serde_json::from_str(&json).unwrap();
    assert_eq!(snapshot, back);
}

#[test]
fn test_shared_fixtures_deserialize_from_camel_case_protocol() {
    for fixture in [
        include_str!("../../../protocol/fixtures/representative.json"),
        include_str!("../../../protocol/fixtures/data-quality.json"),
    ] {
        let snapshot: ProtocolSnapshot =
            serde_json::from_str(fixture).expect("shared fixture must match the Rust protocol");
        assert_eq!(snapshot.schema_version, "1");
    }
}

// ---------------------------------------------------------------------------
// Empty snapshot analysis
// ---------------------------------------------------------------------------

#[test]
fn test_empty_snapshot_analysis() {
    let request = AnalysisRequest {
        snapshot: empty_snapshot(),
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
    };

    let result = analyze_snapshot(request);
    assert_eq!(result.result_code, "success");
    assert!(result.reason_codes.is_empty());
}

// ---------------------------------------------------------------------------
// Analysis with uncategorized transactions
// ---------------------------------------------------------------------------

#[test]
fn test_analysis_uncategorized() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![],
        transactions: vec![
            sample_transaction("tx1", None, 1000),
            sample_transaction("tx2", Some(""), 2000),
        ],
        categories: vec![],
        payees: vec![],
        rules: vec![],
        schedules: vec![],
        budgets: vec![],
        tags: vec![],
        actual_downloaded_at: None,
        encrypted: None,
        bank_synced_at: None,
    };

    let request = AnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
    };

    let result = analyze_snapshot(request);
    assert_eq!(result.result_code, "warning");
    assert!(result.findings.iter().any(|f| f.finding_type == "uncategorized"));
}

// ---------------------------------------------------------------------------
// Invalid category reference in mutation plan
// ---------------------------------------------------------------------------

#[test]
fn test_verify_mutation_invalid_category() {
    let snapshot = empty_snapshot();

    let plan = MutationPlan {
        plan_id: "plan_test".into(),
        transaction_id: "nonexistent_tx".into(),
        current_category_id: None,
        proposed_category_id: "nonexistent_cat".into(),
        hash: "abc123".into(),
        postconditions: vec![Postcondition {
            condition_type: PostconditionType::CategoryExists,
            category_id: "nonexistent_cat".into(),
        }],
    };

    let result = verify_mutation(&plan, &snapshot);
    assert!(!result.verified);
    assert!(result
        .reason_codes
        .contains(&"transaction_not_found".to_string()));
}

// ---------------------------------------------------------------------------
// Validate suggestion: category not found
// ---------------------------------------------------------------------------

#[test]
fn test_validate_suggestion_invalid_category() {
    let snapshot = empty_snapshot();

    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "nonexistent".into(),
        category_name: "Missing".into(),
        confidence: 0.9,
        reason_codes: vec![],
        evidence: vec![],
    };

    let result = validate_suggestion(&suggestion, &snapshot);
    assert!(!result.valid);
    assert!(result
        .reason_codes
        .contains(&"transaction_not_found".to_string()));
}

// ---------------------------------------------------------------------------
// Validate suggestion valid
// ---------------------------------------------------------------------------

#[test]
fn test_validate_suggestion_valid() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![],
        transactions: vec![sample_transaction("tx1", None, 1000)],
        categories: vec![sample_category("cat1", "Food", false)],
        payees: vec![],
        rules: vec![],
        schedules: vec![],
        budgets: vec![],
        tags: vec![],
        actual_downloaded_at: None,
        encrypted: None,
        bank_synced_at: None,
    };

    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec!["historical_match".into()],
        evidence: vec!["Previously categorized as Food".into()],
    };

    let result = validate_suggestion(&suggestion, &snapshot);
    assert!(result.valid);
    assert!(result.reason_codes.is_empty());
}

// ---------------------------------------------------------------------------
// Plan set category
// ---------------------------------------------------------------------------

#[test]
fn test_plan_set_category() {
    let tx = sample_transaction("tx1", None, 5000);
    let cat = sample_category("cat1", "Groceries", false);
    let plan = plan_set_category(&tx, &cat);
    assert_eq!(plan.transaction_id, "tx1");
    assert_eq!(plan.proposed_category_id, "cat1");
    assert!(plan.postconditions.iter().any(|pc| matches!(
        pc.condition_type,
        PostconditionType::CategoryExists
    )));
}

// ---------------------------------------------------------------------------
// Simulate rule
// ---------------------------------------------------------------------------

#[test]
fn test_simulate_rule() {
    let rule = Rule {
        id: "rule1".into(),
        name: "Auto-categorize".into(),
        order: 1,
        trigger: serde_json::json!({}),
        actions: serde_json::json!({}),
        inactive: false,
    };

    let transactions = vec![
        sample_transaction("tx1", None, 1000),
        sample_transaction("tx2", Some("cat1"), 2000),
    ];

    let result = simulate_rule(&rule, &transactions);
    assert_eq!(result.transactions_matched, 1);
    assert_eq!(result.transactions_affected, vec!["tx1"]);
}

// ---------------------------------------------------------------------------
// Find categorization candidates
// ---------------------------------------------------------------------------

#[test]
fn test_find_categorization_candidates() {
    let transactions = vec![
        sample_transaction("tx1", None, 5000),
        sample_transaction("tx2", Some("cat1"), 7500),
        sample_transaction("tx3", Some(""), 3000),
    ];

    let candidates = find_categorization_candidates(transactions);
    assert_eq!(candidates.len(), 2);
    assert!(candidates.iter().any(|c| c.transaction_id == "tx1"));
    assert!(candidates.iter().any(|c| c.transaction_id == "tx3"));
}

// ---------------------------------------------------------------------------
// Verify mutation with valid data
// ---------------------------------------------------------------------------

#[test]
fn test_verify_mutation_valid() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![],
        transactions: vec![sample_transaction("tx1", None, 5000)],
        categories: vec![sample_category("cat1", "Food", false)],
        payees: vec![],
        rules: vec![],
        schedules: vec![],
        budgets: vec![],
        tags: vec![],
        actual_downloaded_at: None,
        encrypted: None,
        bank_synced_at: None,
    };

    let plan = MutationPlan {
        plan_id: "plan_test".into(),
        transaction_id: "tx1".into(),
        current_category_id: None,
        proposed_category_id: "cat1".into(),
        hash: "abc".into(),
        postconditions: vec![],
    };

    let result = verify_mutation(&plan, &snapshot);
    assert!(result.verified);
}

// ---------------------------------------------------------------------------
// i64::MIN must not panic or silently wrap
// ---------------------------------------------------------------------------

#[test]
fn test_analysis_i64_min_overflow_as_finding() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![],
        transactions: vec![sample_transaction("overflow_tx", None, i64::MIN)],
        categories: vec![],
        payees: vec![],
        rules: vec![],
        schedules: vec![],
        budgets: vec![],
        tags: vec![],
        actual_downloaded_at: None,
        encrypted: None,
        bank_synced_at: None,
    };

    let request = AnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
    };

    // Must not panic; must produce a finding about the overflow
    let result = analyze_snapshot(request);
    assert!(
        result.findings.iter().any(|f| f.finding_type == "amount_overflow"),
        "i64::MIN abs overflow should produce an amount_overflow finding; got: {:?}",
        result.findings,
    );
}

// ---------------------------------------------------------------------------
// Unsupported schema version must be rejected
// ---------------------------------------------------------------------------

#[test]
fn test_analysis_rejects_unsupported_schema_version() {
    let snapshot = ProtocolSnapshot {
        schema_version: "2.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![],
        transactions: vec![],
        categories: vec![],
        payees: vec![],
        rules: vec![],
        schedules: vec![],
        budgets: vec![],
        tags: vec![],
        actual_downloaded_at: None,
        encrypted: None,
        bank_synced_at: None,
    };

    let request = AnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
    };

    let result = analyze_snapshot(request);
    assert_eq!(result.result_code, "error");
    assert!(
        result.reason_codes.contains(&"unsupported_schema_version".into()),
        "reason_codes should contain unsupported_schema_version; got: {:?}",
        result.reason_codes,
    );
    assert!(
        result.findings.iter().any(|f| f.finding_type == "unsupported_schema_version"),
        "findings should include unsupported_schema_version",
    );
}

// ---------------------------------------------------------------------------
// Data-quality fixture must surface readiness findings
// ---------------------------------------------------------------------------

#[test]
fn test_analysis_data_quality_readiness_findings() {
    let fixture = include_str!("../../../protocol/fixtures/data-quality.json");
    let snapshot: ProtocolSnapshot = serde_json::from_str(fixture)
        .expect("data-quality fixture must be valid");

    let request = AnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
    };

    let result = analyze_snapshot(request);

    // Should have readiness findings -- at minimum pending exposure from
    // the many cleared=false filler transactions and uncategorized summary.
    assert!(!result.findings.is_empty(), "analysis of data-quality fixture must return findings");

    // The readiness analyzer surfaces per-transaction PENDING_EXPOSURE
    assert!(
        result.findings.iter().any(|f| f.finding_type == "PENDING_EXPOSURE"),
        "expected PENDING_EXPOSURE finding from readiness analysis; got: {:?}",
        result.findings.iter().map(|f| &f.finding_type).collect::<Vec<_>>(),
    );

    // The readiness analyzer surfaces an UNCATEGORIZED_TRANSACTIONS summary
    assert!(
        result.findings.iter().any(|f| f.finding_type == "UNCATEGORIZED_TRANSACTIONS"),
        "expected UNCATEGORIZED_TRANSACTIONS finding from readiness analysis",
    );
}
