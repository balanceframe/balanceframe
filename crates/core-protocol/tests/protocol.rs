use balanceframe_core_protocol::{
    analyze_deterministic,
    analyze_snapshot,
    find_categorization_candidates,
    plan_set_category,
    simulate_rule,
    validate_suggestion,
    verify_mutation,
    AnalysisOptions,
    AnalysisRequest,
    DeterministicAnalysisRequest,
    MutationPlan,
    Postcondition,
    PostconditionType,
    ProtocolSnapshot,
    Suggestion,
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

// ---------------------------------------------------------------------------
// Duplicate evidence regression tests (via find_duplicates)
// ---------------------------------------------------------------------------

use balanceframe_financial_core::find_duplicates;

#[test]
fn test_protocol_duplicate_i64_min_skipped() {
    let txs = vec![
        sample_transaction("tx_a", None, i64::MIN),
        sample_transaction("tx_b", None, i64::MIN),
    ];
    let result = find_duplicates(&txs);
    assert!(result.is_empty(), "i64::MIN must not produce duplicates: {:?}", result);
}

#[test]
fn test_protocol_duplicate_plus_one_day_window() {
    let txs = vec![
        Transaction { date: "2026-03-01".into(), ..sample_transaction("tx_1", None, -1000) },
        Transaction { date: "2026-03-02".into(), ..sample_transaction("tx_2", None, -1000) },
    ];
    let result = find_duplicates(&txs);
    assert_eq!(result.len(), 1, "±1 day window should match: {:?}", result);
    assert_eq!(result[0].match_reason, "amount_date");
}

 #[test]
 fn test_protocol_duplicate_outside_window_no_match() {
     let payee_a = Some("Different Store");
     let payee_b = Some("Other Shop");
     let tx_a = Transaction {
         date: "2026-03-01".into(),
         payee_name: payee_a.map(|s| s.into()),
         ..sample_transaction("tx_a", None, -1000)
     };
     let tx_b = Transaction {
         date: "2026-03-03".into(),
         payee_name: payee_b.map(|s| s.into()),
         ..sample_transaction("tx_b", None, -1000)
     };
     let txs = vec![tx_a, tx_b];
     let result = find_duplicates(&txs);
     assert!(result.is_empty(), "2 days apart and different merchants must not match: {:?}", result);
 }

#[test]
fn test_protocol_duplicate_chain_preserved() {
    let txs = vec![
        Transaction { imported_id: Some("imp001".into()), ..sample_transaction("tx_a", None, -500) },
        Transaction { imported_id: Some("imp001".into()), ..sample_transaction("tx_b", None, -500) },
        Transaction { imported_id: None, payee_name: Some("Other".into()), ..sample_transaction("tx_c", None, -500) },
    ];
    let result = find_duplicates(&txs);
    assert_eq!(result.len(), 3, "chain of 3 should produce 3 evidence entries: {:?}", result);
}

#[test]
fn test_protocol_duplicate_json_deterministic() {
    let txs = vec![
        Transaction { imported_id: Some("imp1".into()), ..sample_transaction("tx_z", None, -300) },
        Transaction { imported_id: None, ..sample_transaction("tx_y", None, -300) },
        Transaction { imported_id: Some("imp2".into()), ..sample_transaction("tx_x", None, -300) },
    ];
    let json1 = serde_json::to_string(&find_duplicates(&txs)).unwrap();
    let json2 = serde_json::to_string(&find_duplicates(&txs)).unwrap();
    assert_eq!(json1, json2, "duplicate evidence JSON must be deterministic");
}

#[test]
fn test_protocol_duplicate_same_date_exact_match() {
    // Existing contract: exact date match still works (regression)
    let txs = vec![
        Transaction { date: "2026-05-15".into(), ..sample_transaction("tx_p", None, -200) },
        Transaction { date: "2026-05-15".into(), ..sample_transaction("tx_q", None, -200) },
    ];
    let result = find_duplicates(&txs);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].match_reason, "amount_date");
}

// ---------------------------------------------------------------------------
// Deterministic analysis — schema version contract
// ---------------------------------------------------------------------------

#[test]
fn test_deterministic_analysis_schema_version_ok() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
        actual_downloaded_at: Some("2026-07-18T00:00:00Z".into()),
        encrypted: Some(false),
        bank_synced_at: Some("2026-07-17T00:00:00Z".into()),
    };
    let request = DeterministicAnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
        request_id: Some("det-int-req".into()),
        actor_id: None,
    };
    let response = analyze_deterministic(request);
    assert_eq!(response.schema_version, "1",
        "deterministic analysis ok response must emit canonical schemaVersion '1'");
    assert_eq!(response.status, "ok");
}

#[test]
fn test_deterministic_analysis_unsupported_version_emits_schema_version_1() {
    let snapshot = ProtocolSnapshot {
        schema_version: "2.0".into(),
        actual_version: "25.1.0".into(),
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

    let request = DeterministicAnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
        request_id: Some("det-uv-req".into()),
        actor_id: None,
    };
    let response = analyze_deterministic(request);
    assert_eq!(response.schema_version, "1",
        "deterministic analysis error response must emit canonical schemaVersion '1'");
    assert_eq!(response.status, "error");
    if let Some(err) = &response.error {
        assert_eq!(err.code, "unsupported_schema_version");
    } else {
        panic!("expected error info for unsupported schema version");
    }
}

#[test]
fn test_deterministic_analysis_accepts_legacy_schema_version_1_0() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
        actual_downloaded_at: Some("2026-07-18T00:00:00Z".into()),
        encrypted: Some(false),
        bank_synced_at: Some("2026-07-17T00:00:00Z".into()),
    };

    let request = DeterministicAnalysisRequest {
        snapshot,
        options: AnalysisOptions {
            include_pending: true,
            include_cleared: true,
            max_results: None,
        },
        request_id: Some("det-legacy-req".into()),
        actor_id: None,
    };
    let response = analyze_deterministic(request);
    assert_eq!(response.schema_version, "1",
        "response for legacy '1.0' input must emit canonical schemaVersion '1'");
    assert_eq!(response.status, "ok");
}
