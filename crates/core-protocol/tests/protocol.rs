use balanceframe_core_protocol::{
    analyze_deterministic,
    analyze_rule_candidates,
    analyze_snapshot,
    find_categorization_candidates,
    plan_create_rule,
    plan_set_category,
    simulate_rule,
    validate_provider_suggestion,
    validate_suggestion,
    verify_mutation,
    verify_rule_mutation,
    AnalysisOptions,
    AnalysisRequest,
    DeterministicAnalysisRequest,
    InferencePolicy,
    MutationPlan,
    PayeeCondition,
    Postcondition,
    PostconditionType,
    ProtocolSnapshot,
    Provenance,
    Suggestion,
};
use balanceframe_financial_core::{
    Account, CandidateStatus, CategorizationCandidate, Category, Evidence, EvidenceKind, Money,
    Rule, Transaction,
};
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

/// Helper for the `analyze_rule_candidates` tests: creates a transaction with
/// the given payee name and optional category.
fn sample_tx(
    id: &str,
    payee_id: Option<&str>,
    payee_name: &str,
    category_id: Option<&str>,
    amount: i64,
) -> Transaction {
    Transaction {
        id: id.into(),
        account_id: "acct1".into(),
        date: "2026-07-15".into(),
        payee_id: payee_id.map(|s| s.into()),
        payee_name: Some(payee_name.into()),
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
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: None,
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: None,
        actor_id: None,
        payload_hash: None,
        provenance: None,
        history: vec![],
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
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: None,
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: None,
        actor_id: None,
        payload_hash: None,
        provenance: None,
        history: vec![],
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
    // `transaction_added` trigger matches all transactions
    let rule = Rule {
        id: "rule1".into(),
        name: "Auto-categorize".into(),
        order: 1,
        trigger: serde_json::json!({"type": "transaction_added"}),
        actions: serde_json::json!({}),
        inactive: false,
    };

    let transactions = vec![
        sample_transaction("tx1", None, 1000),
        sample_transaction("tx2", Some("cat1"), 2000),
    ];

    let result = simulate_rule(&rule, &transactions);
    assert_eq!(result.transactions_matched, 2);
    assert_eq!(result.transactions_affected, vec!["tx1", "tx2"]);
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

#[test]
fn test_verify_mutation_emits_postcondition_verified() {
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
    assert!(
        result.reason_codes.contains(&"postcondition_verified".to_string()),
        "Expected postcondition_verified in reason_codes: {:?}",
        result.reason_codes
    );
}

#[test]
fn test_verify_mutation_category_already_matches() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![],
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

    let plan = MutationPlan {
        plan_id: "plan_test".into(),
        transaction_id: "tx1".into(),
        current_category_id: Some("cat1".into()),
        proposed_category_id: "cat1".into(),
        hash: "abc".into(),
        postconditions: vec![],
    };

    let result = verify_mutation(&plan, &snapshot);
    // Transaction already has the proposed category so verification succeeds,
    // but the reason_codes should include category_already_matches as a diagnostic.
    assert!(
        result.verified,
        "Expected verification to succeed when category already matches; got reason_codes: {:?}",
        result.reason_codes,
    );
    assert!(
        result.reason_codes.contains(&"category_already_matches".to_string()),
        "Expected category_already_matches in reason_codes: {:?}",
        result.reason_codes
    );
}

// ---------------------------------------------------------------------------
// Verify-mutation boundary: empty proposed category must fail
// ---------------------------------------------------------------------------

#[test]
fn test_verify_mutation_empty_proposed_category() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![],
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

    let plan = MutationPlan {
        plan_id: "plan_test".into(),
        transaction_id: "tx1".into(),
        current_category_id: Some("cat1".into()),
        proposed_category_id: "".into(),
        hash: "abc".into(),
        postconditions: vec![],
    };

    let result = verify_mutation(&plan, &snapshot);
    assert!(!result.verified, "Empty proposed category must not verify");
    assert!(
        result.reason_codes.contains(&"proposed_category_not_found".to_string()),
        "Expected proposed_category_not_found in reason_codes: {:?}",
        result.reason_codes
    );
}

// ---------------------------------------------------------------------------
// Regression: declared CategoryExists postcondition for a missing category
// must cause verification to fail, even if proposed_category_id is valid.
// ---------------------------------------------------------------------------

#[test]
fn test_verify_mutation_missing_postcondition_category() {
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
        postconditions: vec![Postcondition {
            condition_type: PostconditionType::CategoryExists,
            category_id: "cat_missing".into(),
        }],
    };

    let result = verify_mutation(&plan, &snapshot);
    assert!(
        !result.verified,
        "Missing declared postcondition must fail verification"
    );
    assert!(
        result.reason_codes.contains(&"postcondition_not_met".to_string()),
        "Expected postcondition_not_met in reason_codes: {:?}",
        result.reason_codes
    );
}

// ---------------------------------------------------------------------------
// Verify-mutation boundary: zero-amount transaction must not affect verification
// ---------------------------------------------------------------------------

#[test]
fn test_verify_mutation_zero_amount_transaction() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![],
        transactions: vec![sample_transaction("tx1", None, 0)],
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
    assert!(result.verified, "Zero-amount transaction must verify");
    assert!(
        result.reason_codes.contains(&"postcondition_verified".to_string()),
        "Expected postcondition_verified in reason_codes: {:?}",
        result.reason_codes
    );
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
// Analysis boundary: zero-amount transaction must not produce overflow
// ---------------------------------------------------------------------------

#[test]
fn test_analysis_zero_amount_success() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.07.01".into(),
        snapshot_date: "2026-07-17T00:00:00Z".into(),
        accounts: vec![],
        transactions: vec![sample_transaction("zero_tx", None, 0)],
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
    // Zero amount is perfectly fine — no overflow should occur.
    assert_ne!(
        result.result_code, "error",
        "Zero-amount transaction must not cause error; got: {:?}",
        result.findings,
    );
    assert!(
        !result.findings.iter().any(|f| f.finding_type == "amount_overflow"),
        "Zero amount must not produce amount_overflow finding",
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

// ---------------------------------------------------------------------------
// Provider suggestion validation — basic
// ---------------------------------------------------------------------------

fn sample_candidate(tx_id: &str, reasons: Vec<Evidence>) -> CategorizationCandidate {
    CategorizationCandidate {
        transaction_id: tx_id.into(),
        amount: Money::new(100, "USD"),
        payee_name: Some("Test Store".into()),
        date: "2026-07-18".into(),
        reasons,
    }
}

#[test]
fn test_validate_provider_suggestion_valid() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec!["provider_match".into()],
        evidence: vec!["Classifier output".into()],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: Some("Test Store".into()),
        normalized_merchant: Some("test store".into()),
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: Some("Match by provider".into()),
        provider: Some("test-provider".into()),
        model: Some("test-model-v1".into()),
        prompt_version: Some("p1".into()),
        inference_policy_version: Some("1.0".into()),
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: Some("system".into()),
        payload_hash: Some("hash123".into()),
        provenance: Some(Provenance {
            payload_hash: "hash123".into(),
            provider: Some("test-provider".into()),
            model: Some("test-model-v1".into()),
            prompt_version: Some("p1".into()),
            inference_policy_version: Some("1.0".into()),
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: Some("system".into()),
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(result.valid, "Expected valid suggestion: {:?}", result.reason_codes);
    assert!(result.reason_codes.is_empty());
}

// ---------------------------------------------------------------------------
// Provider suggestion: resolved candidate
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_resolved_candidate_rejected() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    // ExactPayee candidate -> Resolved
    let candidate = sample_candidate(
        "tx1",
        vec![Evidence::new(EvidenceKind::ExactPayee, "Payee 'Store' (id=p1)")],
    );
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.9,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: None,
        provenance: Some(Provenance {
            payload_hash: "h".into(),
            provider: Some("test".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid, "Resolved candidate must be rejected");
    assert!(result.reason_codes.contains(&"candidate_already_resolved".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: transaction not found
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_tx_not_found() {
    let snapshot = empty_snapshot();
    let candidate = sample_candidate("nonexistent", vec![]);
    let suggestion = Suggestion {
        transaction_id: "nonexistent".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.9,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: None,
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: None,
        actor_id: None,
        payload_hash: None,
        provenance: None,
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"transaction_not_found".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: deleted category
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_deleted_category_rejected() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
        accounts: vec![],
        transactions: vec![sample_transaction("tx1", None, 1000)],
        categories: vec![sample_category("cat1", "Food", true)], // deleted
        payees: vec![],
        rules: vec![],
        schedules: vec![],
        budgets: vec![],
        tags: vec![],
        actual_downloaded_at: None,
        encrypted: None,
        bank_synced_at: None,
    };
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.9,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: None,
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: None,
        actor_id: None,
        payload_hash: None,
        provenance: None,
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"category_not_found".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: disabled policy blocker
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_disabled_policy_blocked() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("openai".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: None,
        provenance: Some(Provenance {
            payload_hash: "h".into(),
            provider: Some("openai".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    // Policy = Disabled -> all provider inference blocked
    let result = validate_provider_suggestion(
        &suggestion,
        &snapshot,
        &candidate,
        Some(InferencePolicy::Disabled),
    );
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"provider_inference_disabled".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: local-only policy blocks external provider
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_local_only_blocks_external() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("openai".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: None,
        provenance: Some(Provenance {
            payload_hash: "h".into(),
            provider: Some("openai".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    // LocalOnly policy with external provider -> blocked
    let result = validate_provider_suggestion(
        &suggestion,
        &snapshot,
        &candidate,
        Some(InferencePolicy::LocalOnly),
    );
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"external_provider_not_allowed".into()));
}

#[test]
fn test_validate_provider_suggestion_local_only_allows_local() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("local".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: Some("h".into()),
        provenance: Some(Provenance {
            payload_hash: "h".into(),
            provider: Some("local".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(
        &suggestion,
        &snapshot,
        &candidate,
        Some(InferencePolicy::LocalOnly),
    );
    assert!(result.valid, "Local provider under LocalOnly policy must be accepted");
}

// ---------------------------------------------------------------------------
// Immutable metadata validation: missing provenance / created_at
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_missing_provenance() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: None,
        provenance: None, // missing
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"missing_provenance".into()));
}

#[test]
fn test_validate_provider_suggestion_missing_created_at() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: None, // missing
        actor_id: None,
        payload_hash: None,
        provenance: Some(Provenance {
            payload_hash: "h".into(),
            provider: Some("test".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"missing_created_at".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: stale transaction version
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_invalid_transaction_version() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: Some("".into()), // empty -> invalid
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: None,
        provenance: Some(Provenance {
            payload_hash: "h".into(),
            provider: Some("test".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"invalid_transaction_version".into()));
}

// ---------------------------------------------------------------------------
// Deterministic evidence / processing order handoff
// ---------------------------------------------------------------------------

#[test]
fn test_deterministic_classification_yields_resolved_candidate() {
    // ExactPayee evidence from deterministic classification produces a Resolved candidate
    let candidate = sample_candidate(
        "tx1",
        vec![Evidence::new(EvidenceKind::ExactPayee, "Payee 'Acme' (id=p1)")],
    );
    assert_eq!(candidate.eligibility(), CandidateStatus::Resolved);
    // Historical evidence also resolves
    let candidate2 = sample_candidate(
        "tx2",
        vec![Evidence::new(EvidenceKind::Historical, "Previously categorized as Food")],
    );
    assert_eq!(candidate2.eligibility(), CandidateStatus::Resolved);
}

#[test]
fn test_non_deterministic_classification_yields_unresolved_candidate() {
    // AmountPattern and ImportMatch leave candidate unresolved
    let candidate = sample_candidate(
        "tx1",
        vec![Evidence::new(EvidenceKind::AmountPattern, "Recurring $9.99")],
    );
    assert_eq!(candidate.eligibility(), CandidateStatus::Unresolved);

    let candidate2 = sample_candidate(
        "tx2",
        vec![Evidence::new(EvidenceKind::ImportMatch, "Matched by imp001")],
    );
    assert_eq!(candidate2.eligibility(), CandidateStatus::Unresolved);
}

// ---------------------------------------------------------------------------
// Extended Suggestion backward compatibility with old JSON
// ---------------------------------------------------------------------------

#[test]
fn test_extended_suggestion_deserializes_from_old_format() {
    // Old Suggestion JSON (no Phase 2 fields) must still deserialize
    let json = r#"{
        "transactionId": "tx1",
        "proposedCategoryId": "cat1",
        "categoryName": "Food",
        "confidence": 0.85,
        "reasonCodes": ["historical_match"],
        "evidence": ["Previously categorized as Food"]
    }"#;
    let suggestion: Suggestion = serde_json::from_str(json)
        .expect("Old Suggestion JSON without Phase 2 fields must deserialize");
    assert_eq!(suggestion.transaction_id, "tx1");
    assert_eq!(suggestion.proposed_category_id, "cat1");
    assert_eq!(suggestion.confidence, 0.85);
    // New fields should default
    assert_eq!(suggestion.space_id, None);
    assert!(suggestion.alternative_category_ids.is_empty());
    assert!(suggestion.history.is_empty());
    assert_eq!(suggestion.provenance, None);
}

#[test]
fn test_extended_suggestion_round_trip_full() {
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec!["provider_match".into()],
        evidence: vec!["Classifier".into()],
        space_id: Some("space-1".into()),
        connection_id: Some("conn-1".into()),
        budget_id: Some("budget-1".into()),
        transaction_version: Some("v3".into()),
        raw_merchant: Some("Test Store".into()),
        normalized_merchant: Some("test store".into()),
        research_summary: None,
        alternative_category_ids: vec!["cat2".into(), "cat3".into()],
        rationale: Some("Best match".into()),
        provider: Some("test-provider".into()),
        model: Some("v1".into()),
        prompt_version: Some("p1".into()),
        inference_policy_version: Some("2.0".into()),
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: Some("user-1".into()),
        payload_hash: Some("abc".into()),
        provenance: Some(Provenance {
            payload_hash: "abc".into(),
            provider: Some("test-provider".into()),
            model: Some("v1".into()),
            prompt_version: Some("p1".into()),
            inference_policy_version: Some("2.0".into()),
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: Some("user-1".into()),
        }),
        history: vec![],
    };
    let json = serde_json::to_string(&suggestion).unwrap();
    // Verify camelCase field naming
    assert!(json.contains("transactionId"), "must use camelCase transactionId");
    assert!(json.contains("proposedCategoryId"));
    assert!(json.contains("spaceId"), "must use camelCase spaceId");
    assert!(json.contains("connectionId"));
    assert!(json.contains("budgetId"));
    assert!(json.contains("transactionVersion"));
    assert!(json.contains("rawMerchant"));
    assert!(json.contains("normalizedMerchant"));
    assert!(json.contains("researchSummary"));
    assert!(json.contains("alternativeCategoryIds"));
    assert!(json.contains("promptVersion"));
    assert!(json.contains("inferencePolicyVersion"));
    assert!(json.contains("createdAt"));
    assert!(json.contains("actorId"));
    assert!(json.contains("payloadHash"));
    assert!(json.contains("provenance"));
    // Verify round-trip
    let back: Suggestion = serde_json::from_str(&json).unwrap();
    assert_eq!(suggestion, back);
}

// ---------------------------------------------------------------------------
// Provider suggestion: transaction ID mismatch
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_tx_id_mismatch() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx2", vec![]); // different from suggestion
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: Some("hash1".into()),
        provenance: Some(Provenance {
            payload_hash: "hash1".into(),
            provider: Some("test".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"transaction_id_mismatch".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: candidate transaction not in snapshot
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_candidate_tx_not_found() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("nonexistent", vec![]);
    let suggestion = Suggestion {
        transaction_id: "nonexistent".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: Some("hash2".into()),
        provenance: Some(Provenance {
            payload_hash: "hash2".into(),
            provider: Some("test".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"candidate_transaction_not_found".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: stale transaction version (mismatch)
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_stale_transaction_version() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        // Deliberately wrong version string — will not match computed hash
        transaction_version: Some("txv0000000000000000".into()),
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: Some("hash3".into()),
        provenance: Some(Provenance {
            payload_hash: "hash3".into(),
            provider: Some("test".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"stale_transaction_version".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: provenance provider mismatch
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_provenance_provider_mismatch() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("openai".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: Some("hash4".into()),
        provenance: Some(Provenance {
            payload_hash: "hash4".into(),
            provider: Some("local".into()), // mismatches top-level "openai"
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"provenance_provider_mismatch".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: provenance timestamp mismatch
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_provenance_timestamp_mismatch() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: Some("hash5".into()),
        provenance: Some(Provenance {
            payload_hash: "hash5".into(),
            provider: Some("test".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-17T12:00:00Z".into(), // mismatches top-level
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"provenance_timestamp_mismatch".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: missing payload hash
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_missing_payload_hash() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: None, // missing
        provenance: Some(Provenance {
            payload_hash: "hash6".into(),
            provider: Some("test".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"missing_payload_hash".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: provenance empty payload hash
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_provenance_empty_hash() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: Some("hash7".into()),
        provenance: Some(Provenance {
            payload_hash: "   ".into(), // whitespace-only — effectively empty
            provider: Some("test".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"provenance_payload_hash_empty".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: evidence ranking — deterministic evidence anywhere
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_evidence_ranking_resolves_anywhere() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    // ExactPayee is second but must still resolve the candidate
    let candidate = sample_candidate("tx1", vec![
        Evidence::new(EvidenceKind::ImportMatch, "imp001"),
        Evidence::new(EvidenceKind::ExactPayee, "Payee 'Store' (id=p1)"),
        Evidence::new(EvidenceKind::AmountPattern, "$9.99 pattern"),
    ]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: Some("test".into()),
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: Some("hash8".into()),
        provenance: Some(Provenance {
            payload_hash: "hash8".into(),
            provider: Some("test".into()),
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    let result = validate_provider_suggestion(&suggestion, &snapshot, &candidate, None);
    assert!(!result.valid);
    // Must be rejected as resolved (regardless of evidence position)
    assert!(result.reason_codes.contains(&"candidate_already_resolved".into()));
}

// ---------------------------------------------------------------------------
// Provider suggestion: policy fail‑closed — Disabled with absent provider
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_disabled_policy_no_provider() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: None, // absent
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: Some("hash9".into()),
        provenance: Some(Provenance {
            payload_hash: "hash9".into(),
            provider: None,
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    // Disabled policy must reject even when no provider is specified
    let result = validate_provider_suggestion(
        &suggestion,
        &snapshot,
        &candidate,
        Some(InferencePolicy::Disabled),
    );
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"provider_inference_disabled".into()),
        "Disabled policy must reject suggestions even without a provider field");
}

// ---------------------------------------------------------------------------
// Provider suggestion: policy fail‑closed — LocalOnly with no provider
// ---------------------------------------------------------------------------

#[test]
fn test_validate_provider_suggestion_local_only_no_provider() {
    let snapshot = ProtocolSnapshot {
        schema_version: "1".into(),
        actual_version: "25.1.0".into(),
        snapshot_date: "2026-07-18".into(),
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
    let candidate = sample_candidate("tx1", vec![]);
    let suggestion = Suggestion {
        transaction_id: "tx1".into(),
        proposed_category_id: "cat1".into(),
        category_name: "Food".into(),
        confidence: 0.85,
        reason_codes: vec![],
        evidence: vec![],
        space_id: None,
        connection_id: None,
        budget_id: None,
        transaction_version: None,
        raw_merchant: None,
        normalized_merchant: None,
        research_summary: None,
        alternative_category_ids: vec![],
        rationale: None,
        provider: None, // absent -> not "local", must be rejected
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: Some("2026-07-18T12:00:00Z".into()),
        actor_id: None,
        payload_hash: Some("hash10".into()),
        provenance: Some(Provenance {
            payload_hash: "hash10".into(),
            provider: None,
            model: None,
            prompt_version: None,
            inference_policy_version: None,
            created_at: "2026-07-18T12:00:00Z".into(),
            actor_id: None,
        }),
        history: vec![],
    };
    // LocalOnly with absent provider must reject
    let result = validate_provider_suggestion(
        &suggestion,
        &snapshot,
        &candidate,
        Some(InferencePolicy::LocalOnly),
    );
    assert!(!result.valid);
    assert!(result.reason_codes.contains(&"external_provider_not_allowed".into()),
        "LocalOnly must reject suggestions without an explicit 'local' provider");
}

// ---------------------------------------------------------------------------
// Plan create rule
// ---------------------------------------------------------------------------

#[test]
fn test_plan_create_rule() {
    let snapshot = empty_snapshot();
    let conditions = vec![PayeeCondition {
        field: "imported_payee".into(),
        operation: "is".into(),
        value: "  Whole Foods  ".into(),
    }];

    let plan = plan_create_rule("Groceries", &conditions, "c1", &snapshot);

    assert_eq!(plan.rule_name, "Groceries");
    assert_eq!(plan.trigger["type"], "payee_is");
    // Value must be normalized (trimmed, lowercased)
    assert_eq!(plan.trigger["value"], "whole foods");
    assert_eq!(plan.actions[0]["type"], "set_category");
    assert_eq!(plan.actions[0]["value"], "c1");
    assert_eq!(plan.conditions.len(), 1);
    assert_eq!(plan.conditions[0].field, "imported_payee");
    assert!(!plan.plan_id.is_empty());
    assert!(!plan.hash.is_empty());
}

#[test]
fn test_plan_create_rule_no_conditions() {
    let snapshot = empty_snapshot();
    let conditions: Vec<PayeeCondition> = vec![];

    let plan = plan_create_rule("Empty", &conditions, "c1", &snapshot);

    assert_eq!(plan.rule_name, "Empty");
    // No conditions → empty-string normalized value
    assert_eq!(plan.trigger["value"], "");
    assert_eq!(plan.actions[0]["value"], "c1");
    assert!(plan.conditions.is_empty());
}

// ---------------------------------------------------------------------------
// Verify rule mutation — no existing rule
// ---------------------------------------------------------------------------

#[test]
fn test_verify_rule_mutation_no_conflict() {
    let snapshot = empty_snapshot(); // snapshot.rules is empty
    let conditions = vec![PayeeCondition {
        field: "payee".into(),
        operation: "is".into(),
        value: "Target".into(),
    }];

    let plan = plan_create_rule("Target Rule", &conditions, "c1", &snapshot);
    let result = verify_rule_mutation(&plan, &snapshot);

    assert!(result.verified);
    assert!(result.reason_codes.contains(&"rule_creation_verified".into()));
    assert!(result.message.is_none());
}

// ---------------------------------------------------------------------------
// Verify rule mutation — rule already exists
// ---------------------------------------------------------------------------

#[test]
fn test_verify_rule_mutation_already_exists() {
    let conditions = vec![PayeeCondition {
        field: "payee".into(),
        operation: "is".into(),
        value: "Walmart".into(),
    }];

    let plan = plan_create_rule("Walmart Rule", &conditions, "c2", &empty_snapshot());

    // Create a snapshot that already has a rule matching the plan trigger/actions
    let mut snapshot = empty_snapshot();
    snapshot.rules.push(Rule {
        id: "existing-rule-1".into(),
        name: "Existing Walmart".into(),
        order: 0,
        trigger: plan.trigger.clone(),
        actions: plan.actions.clone(),
        inactive: false,
    });

    let result = verify_rule_mutation(&plan, &snapshot);

    assert!(!result.verified);
    assert!(result.reason_codes.contains(&"rule_already_exists".into()));
    assert!(result.message.is_some());
}

// ---------------------------------------------------------------------------
// Verify rule mutation — different trigger does not conflict
// ---------------------------------------------------------------------------

#[test]
fn test_verify_rule_mutation_different_trigger_no_conflict() {
    let conditions = vec![PayeeCondition {
        field: "payee".into(),
        operation: "is".into(),
        value: "Costco".into(),
    }];

    let plan = plan_create_rule("Costco Rule", &conditions, "c3", &empty_snapshot());

    let mut snapshot = empty_snapshot();
    // Add a rule with a DIFFERENT trigger
    snapshot.rules.push(Rule {
        id: "existing-rule-2".into(),
        name: "Different".into(),
        order: 0,
        trigger: serde_json::json!({"type":"payee_is","value":"something_else"}),
        actions: plan.actions.clone(),
        inactive: false,
    });

    let result = verify_rule_mutation(&plan, &snapshot);
    assert!(result.verified);
    assert!(result.reason_codes.contains(&"rule_creation_verified".into()));
}

// ---------------------------------------------------------------------------
// Plan-create rule idempotency: same inputs produce identical plan
// ---------------------------------------------------------------------------

#[test]
fn test_plan_create_rule_idempotent() {
    let snapshot = empty_snapshot();
    let conditions = vec![PayeeCondition {
        field: "payee".into(),
        operation: "contains".into(),
        value: "Amazon".into(),
    }];

    let plan_a = plan_create_rule("Amazon", &conditions, "c4", &snapshot);
    let plan_b = plan_create_rule("Amazon", &conditions, "c4", &snapshot);

    assert_eq!(plan_a.plan_id, plan_b.plan_id);
    assert_eq!(plan_a.hash, plan_b.hash);
    assert_eq!(plan_a.trigger, plan_b.trigger);
    assert_eq!(plan_a.actions, plan_b.actions);
}

// ---------------------------------------------------------------------------
// Rule candidate generation — analyze_rule_candidates
// ---------------------------------------------------------------------------

#[test]
fn test_analyze_rule_candidates_empty_snapshot() {
    let snapshot = empty_snapshot();
    let candidates = analyze_rule_candidates(&snapshot, 1);
    assert!(candidates.is_empty());
}

#[test]
fn test_analyze_rule_candidates_consistent_merchant() {
    // sample_transaction uses payee_name "Test Payee" for all tx's,
    // so two transactions with same category should match.
    let snapshot = ProtocolSnapshot {
        transactions: vec![
            sample_transaction("tx1", Some("c1"), -500),
            sample_transaction("tx2", Some("c1"), -550),
        ],
        categories: vec![sample_category("c1", "Food", false)],
        ..empty_snapshot()
    };
    let candidates = analyze_rule_candidates(&snapshot, 2);
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].proposed_category_id, "c1");
    assert_eq!(candidates[0].matching_tx_count, 2);
    assert!(candidates[0].rule_id.is_empty(), "new-rule suggestion has no rule_id");
}

#[test]
fn test_analyze_rule_candidates_below_threshold() {
    let snapshot = ProtocolSnapshot {
        transactions: vec![
            sample_transaction("tx1", Some("c1"), -500),
        ],
        categories: vec![sample_category("c1", "Food", false)],
        ..empty_snapshot()
    };
    let candidates = analyze_rule_candidates(&snapshot, 2);
    assert!(candidates.is_empty());
}

#[test]
fn test_analyze_rule_candidates_multiple_categories_dominant_wins() {
    // Two categories for the same merchant; dominant c1 meets threshold 2
    let snapshot = ProtocolSnapshot {
        transactions: vec![
            Transaction {
                payee_name: Some("Starbucks".into()),
                ..sample_transaction("tx1", Some("c1"), -500)
            },
            Transaction {
                payee_name: Some("Starbucks".into()),
                ..sample_transaction("tx2", Some("c1"), -550)
            },
            Transaction {
                payee_name: Some("Starbucks".into()),
                ..sample_transaction("tx3", Some("c2"), -400)
            },
        ],
        categories: vec![
            sample_category("c1", "Food", false),
            sample_category("c2", "Coffee", false),
        ],
        ..empty_snapshot()
    };
    let candidates = analyze_rule_candidates(&snapshot, 2);
    assert_eq!(candidates.len(), 1, "dominant category Food should reach threshold");
    assert_eq!(candidates[0].proposed_category_id, "c1");
    assert_eq!(candidates[0].matching_tx_count, 2);
}

#[test]
fn test_analyze_rule_candidates_only_categorized_counted() {
    // Transactions without a category should not contribute to count
    let snapshot = ProtocolSnapshot {
        transactions: vec![
            Transaction {
                payee_name: Some("Starbucks".into()),
                ..sample_transaction("tx1", Some("c1"), -500)
            },
            Transaction {
                payee_name: Some("Starbucks".into()),
                ..sample_transaction("tx2", None, -550) // uncategorized
            },
            Transaction {
                payee_name: Some("Starbucks".into()),
                ..sample_transaction("tx3", Some("c1"), -600)
            },
        ],
        categories: vec![sample_category("c1", "Food", false)],
        ..empty_snapshot()
    };
    let candidates = analyze_rule_candidates(&snapshot, 2);
    assert_eq!(candidates.len(), 1, "uncategorized tx excluded from count");
    assert_eq!(candidates[0].matching_tx_count, 2);
}

#[test]
fn test_analyze_rule_candidates_empty_payee_skipped() {
    let snapshot = ProtocolSnapshot {
        transactions: vec![
            Transaction {
                payee_name: None,
                ..sample_transaction("tx1", Some("c1"), -500)
            },
        ],
        categories: vec![sample_category("c1", "Food", false)],
        ..empty_snapshot()
    };
    let candidates = analyze_rule_candidates(&snapshot, 1);
    assert!(candidates.is_empty(), "no payee should yield no candidates");
}
