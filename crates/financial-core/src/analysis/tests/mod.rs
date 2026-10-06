use super::*;
use crate::money::Money;
use crate::snapshots::{Account, Category, Transaction};

#[allow(clippy::too_many_arguments)]
fn sample_tx(
    id: &str,
    acct_id: &str,
    payee: Option<&str>,
    category_id: Option<&str>,
    category_name: Option<&str>,
    amount: i64,
    date: &str,
    cleared: bool,
) -> Transaction {
    Transaction {
        id: id.into(),
        account_id: acct_id.into(),
        date: date.into(),
        payee_id: None,
        payee_name: payee.map(|s| s.into()),
        category_id: category_id.map(|s| s.into()),
        category_name: category_name.map(|s| s.into()),
        amount: Money::new(amount, "USD"),
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

#[test]
fn recurrence_accepts_canonical_snapshot_capture_timestamps() {
    let rows = ["2026-06-30", "2026-07-31", "2026-08-31"]
        .iter()
        .enumerate()
        .map(|(index, observed)| {
            let mut row = sample_tx(
                &format!("capture-{index}"),
                "a1",
                Some("Market"),
                Some("c1"),
                Some("Food"),
                -100,
                observed,
                true,
            );
            row.payee_id = Some("payee-market".into());
            row
        })
        .collect::<Vec<_>>();
    let civil = legacy_recurrence_projection(&rows, "2026-10-04");
    assert_eq!(civil.len(), 1);
    assert_eq!(civil[0].occurrences, 3);
    for captured_at in [
        "2026-10-04T12:00:00Z",
        "2026-10-04T12:00:00.000Z",
        "2026-10-04T15:00:00+03:00",
    ] {
        assert_eq!(legacy_recurrence_projection(&rows, captured_at), civil);
    }
    for invalid in ["not-a-date", "2026-13-01T12:00:00Z", "2026-10-04junk"] {
        assert!(legacy_recurrence_projection(&rows, invalid).is_empty());
    }
}

#[test]
fn test_analysis_uncategorized_backlog_populated() {
    let txs = vec![
        sample_tx(
            "tx1",
            "a1",
            Some("Starbucks"),
            None,
            None,
            -500,
            "2026-06-01",
            true,
        ),
        sample_tx(
            "tx2",
            "a1",
            Some("Amazon"),
            None,
            None,
            -2000,
            "2026-07-01",
            true,
        ),
    ];
    let cats = vec![sample_category("c1", "Food", false)];
    let (backlog, _) = build_uncategorized_backlog(&txs, &cats);
    assert_eq!(backlog.count, 2);
    assert_eq!(backlog.oldest_date.as_deref(), Some("2026-06-01"));
}

#[test]
fn test_analysis_no_uncategorized() {
    let txs = vec![sample_tx(
        "tx1",
        "a1",
        Some("Starbucks"),
        Some("c1"),
        Some("Food"),
        -500,
        "2026-06-01",
        true,
    )];
    let cats = vec![sample_category("c1", "Food", false)];
    let (backlog, _) = build_uncategorized_backlog(&txs, &cats);
    assert_eq!(backlog.count, 0);
}

#[test]
fn test_repeated_merchant_analysis() {
    let txs = vec![
        sample_tx(
            "tx1",
            "a1",
            Some("Starbucks"),
            Some("c1"),
            Some("Food"),
            -500,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx2",
            "a1",
            Some("Starbucks"),
            Some("c1"),
            Some("Food"),
            -550,
            "2026-02-01",
            true,
        ),
        sample_tx(
            "tx3",
            "a1",
            Some("Amazon"),
            Some("c2"),
            Some("Shopping"),
            -2000,
            "2026-03-01",
            true,
        ),
    ];
    let repeated = find_repeated_merchants(&txs);
    assert_eq!(repeated.len(), 1);
    assert_eq!(repeated[0].normalized_name, "starbucks");
    assert_eq!(repeated[0].frequency, 2);
}

#[test]
fn test_generate_rule_candidates_consistent_merchant() {
    // Two transactions from the same merchant, both categorized as "Food"
    let txs = vec![
        sample_tx(
            "tx1",
            "a1",
            Some("Starbucks"),
            Some("c1"),
            Some("Food"),
            -500,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx2",
            "a2",
            Some("Starbucks"),
            Some("c1"),
            Some("Food"),
            -550,
            "2026-02-01",
            true,
        ),
    ];
    let cats = vec![sample_category("c1", "Food", false)];
    let candidates = generate_rule_candidates(&txs, &cats, 2);
    assert_eq!(candidates.len(), 1, "should propose one rule for Starbucks");
    assert_eq!(candidates[0].proposed_category_id, "c1");
    assert_eq!(candidates[0].matching_tx_count, 2);
    assert!(!candidates[0].reason.is_empty());
    // rule_id is empty since this is a new-rule suggestion
    assert!(candidates[0].rule_id.is_empty());
}

#[test]
fn test_generate_rule_candidates_below_threshold() {
    // Only one transaction — below min_consistent_count of 2
    let txs = vec![sample_tx(
        "tx1",
        "a1",
        Some("Starbucks"),
        Some("c1"),
        Some("Food"),
        -500,
        "2026-01-01",
        true,
    )];
    let cats = vec![sample_category("c1", "Food", false)];
    let candidates = generate_rule_candidates(&txs, &cats, 2);
    assert!(
        candidates.is_empty(),
        "single transaction should not meet threshold"
    );
}

#[test]
fn test_generate_rule_candidates_uncategorized_excluded() {
    // Transaction without category should not contribute
    let txs = vec![
        sample_tx(
            "tx1",
            "a1",
            Some("Starbucks"),
            None,
            None,
            -500,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx2",
            "a2",
            Some("Starbucks"),
            None,
            None,
            -550,
            "2026-02-01",
            true,
        ),
    ];
    let cats = vec![sample_category("c1", "Food", false)];
    let candidates = generate_rule_candidates(&txs, &cats, 1);
    assert!(
        candidates.is_empty(),
        "uncategorized transactions should not produce candidates"
    );
}

#[test]
fn test_generate_rule_candidates_no_payee_skipped() {
    // Transaction without payee name should be skipped
    let txs = vec![sample_tx(
        "tx1",
        "a1",
        None,
        Some("c1"),
        Some("Food"),
        -500,
        "2026-01-01",
        true,
    )];
    let cats = vec![sample_category("c1", "Food", false)];
    let candidates = generate_rule_candidates(&txs, &cats, 1);
    assert!(
        candidates.is_empty(),
        "no payee name should produce no candidates"
    );
}

#[test]
fn test_generate_rule_candidates_multiple_categories() {
    // Starbucks has 3 food and 1 coffee — dominant is food, above threshold 2
    let txs = vec![
        sample_tx(
            "tx1",
            "a1",
            Some("Starbucks"),
            Some("c1"),
            Some("Food"),
            -500,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx2",
            "a1",
            Some("Starbucks"),
            Some("c1"),
            Some("Food"),
            -550,
            "2026-02-01",
            true,
        ),
        sample_tx(
            "tx3",
            "a2",
            Some("Starbucks"),
            Some("c1"),
            Some("Food"),
            -600,
            "2026-03-01",
            true,
        ),
        sample_tx(
            "tx4",
            "a1",
            Some("Starbucks"),
            Some("c2"),
            Some("Coffee"),
            -400,
            "2026-04-01",
            true,
        ),
    ];
    let cats = vec![
        sample_category("c1", "Food", false),
        sample_category("c2", "Coffee", false),
    ];
    let candidates = generate_rule_candidates(&txs, &cats, 2);
    assert_eq!(
        candidates.len(),
        1,
        "dominant category Food should reach threshold"
    );
    assert_eq!(candidates[0].proposed_category_id, "c1");
    assert_eq!(candidates[0].matching_tx_count, 3);
}

#[test]
fn test_generate_rule_candidates_different_merchants() {
    let txs = vec![
        sample_tx(
            "tx1",
            "a1",
            Some("Starbucks"),
            Some("c1"),
            Some("Food"),
            -500,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx2",
            "a1",
            Some("Starbucks"),
            Some("c1"),
            Some("Food"),
            -550,
            "2026-02-01",
            true,
        ),
        sample_tx(
            "tx3",
            "a1",
            Some("Amazon"),
            Some("c2"),
            Some("Shopping"),
            -2000,
            "2026-03-01",
            true,
        ),
        sample_tx(
            "tx4",
            "a1",
            Some("Amazon"),
            Some("c2"),
            Some("Shopping"),
            -2500,
            "2026-04-01",
            true,
        ),
    ];
    let cats = vec![
        sample_category("c1", "Food", false),
        sample_category("c2", "Shopping", false),
    ];
    let candidates = generate_rule_candidates(&txs, &cats, 2);
    assert_eq!(candidates.len(), 2, "both merchants meet threshold");
    // Should be sorted by count descending
    assert_eq!(candidates[0].matching_tx_count, 2);
    assert_eq!(candidates[1].matching_tx_count, 2);
}

#[test]
fn test_generate_rule_candidates_empty_transactions() {
    let candidates = generate_rule_candidates(&[], &[], 1);
    assert!(candidates.is_empty());
}

#[test]
fn test_generate_rule_candidates_merchant_normalization() {
    // "The Home Depot" and "Home Depot" should normalize to same merchant
    let txs = vec![
        sample_tx(
            "tx1",
            "a1",
            Some("The Home Depot"),
            Some("c1"),
            Some("Home Improvement"),
            -5000,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx2",
            "a1",
            Some("Home Depot"),
            Some("c1"),
            Some("Home Improvement"),
            -10000,
            "2026-02-01",
            true,
        ),
    ];
    let cats = vec![sample_category("c1", "Home Improvement", false)];
    let candidates = generate_rule_candidates(&txs, &cats, 2);
    assert_eq!(candidates.len(), 1, "normalized merchants should merge");
    assert!(candidates[0].rule_name.contains("home depot"));
}
#[test]
fn test_recurring_charges_identified() {
    let mut txs = vec![
        sample_tx(
            "tx1",
            "a1",
            Some("Netflix"),
            Some("c1"),
            Some("Subs"),
            -1500,
            "2026-01-15",
            true,
        ),
        sample_tx(
            "tx2",
            "a1",
            Some("Netflix"),
            Some("c1"),
            Some("Subs"),
            -1500,
            "2026-02-15",
            true,
        ),
    ];
    for tx in &mut txs {
        tx.payee_id = Some("payee-netflix".into());
    }
    let charges = legacy_recurrence_projection(&txs, "2026-07-18");
    // Two native-ID observations remain provisional, never numeric confidence.
    assert_eq!(charges.len(), 1, "expected Netflix as recurring charge");
    if !charges.is_empty() {
        assert_eq!(charges[0].normalized_merchant, "netflix");
        assert_eq!(charges[0].tier, MerchantEvidenceTier::InsufficientData);
    }
}

#[test]
fn test_historical_corrections_empty() {
    let corrections = find_historical_corrections(&[], &[]);
    assert!(corrections.is_empty());
}

#[test]
fn test_deterministic_analysis_roundtrip_json() {
    let accounts = vec![sample_account("a1", "Checking")];
    let cats = vec![sample_category("c1", "Food", false)];
    let txs = vec![sample_tx(
        "tx1",
        "a1",
        Some("Starbucks"),
        None,
        None,
        -500,
        "2026-07-01",
        true,
    )];
    let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
    let scope = InclusionScope::new(true, true);
    let result = run_deterministic_analysis(
        &accounts,
        &txs,
        &cats,
        &[],
        &[],
        &[],
        compatibility,
        Some("2026-07-18T00:00:00Z".into()),
        None,
        &scope,
        "2026-07-18",
    );
    let json = serde_json::to_string(&result).unwrap();
    let back: DeterministicAnalysis = serde_json::from_str(&json).unwrap();
    assert_eq!(result, back);
    assert!(json.contains("uncategorizedBacklog"));
    assert!(json.contains("repeatedMerchants"));
}

// -----------------------------------------------------------------------
// Regression tests
// -----------------------------------------------------------------------

#[test]
fn test_policy_filter_excludes_pending_from_backlog() {
    // Pending transactions should be excluded from backlog when
    // include_pending=false.
    let txs = [
        sample_tx(
            "tx1",
            "a1",
            Some("Venmo"),
            None,
            None,
            -500,
            "2026-07-01",
            false,
        ), // pending
        sample_tx(
            "tx2",
            "a1",
            Some("Amazon"),
            None,
            None,
            -2000,
            "2026-07-02",
            true,
        ),
    ];
    let cats = vec![sample_category("c1", "Food", false)];
    // Only cleared (include_pending=false, include_cleared=true)
    let scope = InclusionScope::new(false, true);
    let scoped: Vec<Transaction> = txs.iter().filter(|tx| scope.matches(tx)).cloned().collect();
    let (backlog, _) = build_uncategorized_backlog(&scoped, &cats);
    assert_eq!(backlog.count, 1, "pending tx should be excluded");
    assert_eq!(
        backlog.transaction_ids,
        vec!["tx2"],
        "only the cleared tx should appear in backlog"
    );
}

#[test]
fn test_policy_filter_excludes_transfers_from_repeated_merchants() {
    // Transfer transactions should be excluded when include_transfers=false.
    let txs = vec![
        Transaction {
            transfer_account_id: Some("a2".into()),
            ..sample_tx(
                "tx1",
                "a1",
                Some("Transfer"),
                None,
                None,
                -500,
                "2026-07-01",
                true,
            )
        },
        sample_tx(
            "tx2",
            "a1",
            Some("Starbucks"),
            None,
            None,
            -500,
            "2026-07-02",
            true,
        ),
    ];
    let repeated = find_repeated_merchants(&txs);
    // Without filtering, transfer "Transfer" would be a repeated merchant.
    // With filtering, only "starbucks" appears once so no repeats.
    // This test checks the sub-function on raw data — filtering happens
    // in the orchestrator.
    assert_eq!(repeated.len(), 0, "only one non-transfer tx, no repeats");
}

#[test]
fn test_policy_filter_excludes_splits_from_duplicates() {
    // Split transactions should be excluded when include_splits=false.
    let base_tx = sample_tx(
        "tx1",
        "a1",
        Some("Dupe"),
        None,
        None,
        -500,
        "2026-07-01",
        true,
    );
    let split_tx = Transaction {
        subtransactions: vec![
            sample_tx(
                "sub1",
                "a1",
                Some("Dupe"),
                None,
                None,
                -250,
                "2026-07-01",
                true,
            ),
            sample_tx(
                "sub2",
                "a1",
                Some("Dupe"),
                None,
                None,
                -250,
                "2026-07-01",
                true,
            ),
        ],
        ..sample_tx(
            "tx2",
            "a1",
            Some("Dupe"),
            None,
            None,
            -500,
            "2026-07-01",
            true,
        )
    };
    let txs = vec![base_tx, split_tx];
    // Without split filtering, these would match as duplicates.
    let dupes = find_duplicates(&txs);
    assert_eq!(dupes.len(), 1, "split tx and base match as duplicates");
}

#[test]
fn test_encrypted_snapshot_unlocked_when_downloaded() {
    // encrypted=true but actual_downloaded_at is present → encryption
    // was effectively unlocked.
    let accounts = vec![sample_account("a1", "Checking")];
    let cats = vec![sample_category("c1", "Food", false)];
    let txs = vec![sample_tx(
        "tx1",
        "a1",
        Some("Starbucks"),
        None,
        None,
        -500,
        "2026-07-01",
        true,
    )];
    // encrypted=true but download timestamp present
    let compatibility = CompatibilityMetadata::new(true, true, "25.1.0".into());
    let scope = InclusionScope::new(true, true);
    let result = run_deterministic_analysis(
        &accounts,
        &txs,
        &cats,
        &[],
        &[],
        &[],
        compatibility,
        Some("2026-07-18T00:00:00Z".into()),
        None,
        &scope,
        "2026-07-18",
    );
    assert!(
        !result
            .reason_codes
            .contains(&"encryption_locked".to_string()),
        "encrypted+downloaded should NOT produce encryption_locked: {:?}",
        result.reason_codes
    );
}

#[test]
fn test_encrypted_snapshot_locked_when_not_downloaded() {
    // encrypted=true and no download timestamp → encryption is locked.
    let accounts = vec![sample_account("a1", "Checking")];
    let cats = vec![sample_category("c1", "Food", false)];
    let txs = vec![sample_tx(
        "tx1",
        "a1",
        Some("Starbucks"),
        None,
        None,
        -500,
        "2026-07-01",
        true,
    )];
    let compatibility = CompatibilityMetadata::new(true, false, "25.1.0".into());
    let scope = InclusionScope::new(true, true);
    let result = run_deterministic_analysis(
        &accounts,
        &txs,
        &cats,
        &[],
        &[],
        &[],
        compatibility,
        None,
        None,
        &scope,
        "2026-07-18",
    );
    assert!(
        result
            .reason_codes
            .contains(&"encryption_locked".to_string()),
        "encrypted+no download should produce encryption_locked: {:?}",
        result.reason_codes
    );
}

#[test]
fn test_stale_metadata_when_download_missing() {
    // Missing actual_downloaded_at should emit stale_metadata.
    let accounts = vec![sample_account("a1", "Checking")];
    let cats = vec![sample_category("c1", "Food", false)];
    let txs = vec![sample_tx(
        "tx1",
        "a1",
        Some("Starbucks"),
        None,
        None,
        -500,
        "2026-07-01",
        true,
    )];
    let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
    let scope = InclusionScope::new(true, true);
    let result = run_deterministic_analysis(
        &accounts,
        &txs,
        &cats,
        &[],
        &[],
        &[],
        compatibility,
        None,
        None,
        &scope,
        "2026-07-18",
    );
    assert!(
        result.reason_codes.contains(&"stale_metadata".to_string()),
        "missing download timestamp should emit stale_metadata: {:?}",
        result.reason_codes
    );
}

#[test]
fn test_deterministic_repeatability() {
    // Running analysis twice with the same input produces identical output.
    let accounts = vec![sample_account("a1", "Checking")];
    let cats = vec![sample_category("c1", "Food", false)];
    let txs = vec![
        sample_tx(
            "tx1",
            "a1",
            Some("Starbucks"),
            None,
            None,
            -500,
            "2026-07-01",
            true,
        ),
        sample_tx(
            "tx2",
            "a1",
            Some("Amazon"),
            Some("c1"),
            Some("Food"),
            -2000,
            "2026-07-02",
            true,
        ),
    ];
    let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
    let scope = InclusionScope::new(true, true);
    let result_a = run_deterministic_analysis(
        &accounts,
        &txs,
        &cats,
        &[],
        &[],
        &[],
        compatibility.clone(),
        Some("2026-07-18T00:00:00Z".into()),
        None,
        &scope,
        "2026-07-18",
    );
    let result_b = run_deterministic_analysis(
        &accounts,
        &txs,
        &cats,
        &[],
        &[],
        &[],
        compatibility,
        Some("2026-07-18T00:00:00Z".into()),
        None,
        &scope,
        "2026-07-18",
    );
    assert_eq!(
        result_a, result_b,
        "deterministic analysis must be reproducible"
    );
}

// -- deterministic ordering tests ---------------------------------------

#[test]
fn test_repeated_merchants_sorted_deterministically() {
    // Create merchants in insertion order that would differ from sorted
    let txs = vec![
        sample_tx(
            "tx3",
            "a1",
            Some("Zappos"),
            None,
            None,
            -500,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx4",
            "a1",
            Some("Zappos"),
            None,
            None,
            -550,
            "2026-02-01",
            true,
        ),
        sample_tx(
            "tx1",
            "a1",
            Some("Amazon"),
            None,
            None,
            -2000,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx2",
            "a1",
            Some("Amazon"),
            None,
            None,
            -2100,
            "2026-02-01",
            true,
        ),
        sample_tx(
            "tx5",
            "a1",
            Some("Ebay"),
            None,
            None,
            -300,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx6",
            "a1",
            Some("Ebay"),
            None,
            None,
            -350,
            "2026-02-01",
            true,
        ),
    ];
    let repeated = find_repeated_merchants(&txs);
    assert_eq!(repeated.len(), 3);
    // MUST be in alphabetical order regardless of insertion
    assert_eq!(repeated[0].normalized_name, "amazon");
    assert_eq!(repeated[1].normalized_name, "ebay");
    assert_eq!(repeated[2].normalized_name, "zappos");
}

#[test]
fn test_recurring_charges_sorted_deterministically() {
    let mut txs = vec![
        sample_tx(
            "tx3",
            "a1",
            Some("Zappos"),
            Some("c1"),
            Some("Shopping"),
            -1500,
            "2026-01-15",
            true,
        ),
        sample_tx(
            "tx4",
            "a1",
            Some("Zappos"),
            Some("c1"),
            Some("Shopping"),
            -1500,
            "2026-02-15",
            true,
        ),
        sample_tx(
            "tx1",
            "a1",
            Some("Netflix"),
            Some("c2"),
            Some("Subs"),
            -1500,
            "2026-01-15",
            true,
        ),
        sample_tx(
            "tx2",
            "a1",
            Some("Netflix"),
            Some("c2"),
            Some("Subs"),
            -1500,
            "2026-02-15",
            true,
        ),
    ];
    for tx in &mut txs {
        tx.payee_id = Some(format!(
            "payee-{}",
            tx.payee_name.as_deref().unwrap().to_lowercase()
        ));
    }
    let charges = legacy_recurrence_projection(&txs, "2026-07-18");
    assert!(
        charges.len() >= 2,
        "expected at least 2 charges, got {}",
        charges.len()
    );
    if charges.len() >= 2 {
        assert_eq!(charges[0].normalized_merchant, "netflix");
        assert_eq!(charges[1].normalized_merchant, "zappos");
    }
}

#[test]
fn test_historical_corrections_sorted_deterministically() {
    use crate::snapshots::BudgetCategory;
    use std::collections::HashMap;
    let b1 = BudgetMonth {
        id: "bm-1".into(),
        month: "2026-01".into(),
        categories: {
            let mut m = HashMap::new();
            m.insert(
                "cat_b".into(),
                BudgetCategory {
                    category_id: "cat_b".into(),
                    amount: Money::new(100, "USD"),
                    carryover: Money::zero("USD"),
                    carryover_from_previous: Money::zero("USD"),
                    carries_over: false,
                },
            );
            m.insert(
                "cat_a".into(),
                BudgetCategory {
                    category_id: "cat_a".into(),
                    amount: Money::new(200, "USD"),
                    carryover: Money::zero("USD"),
                    carryover_from_previous: Money::zero("USD"),
                    carries_over: false,
                },
            );
            m
        },
    };
    let b2 = BudgetMonth {
        id: "bm-2".into(),
        month: "2026-02".into(),
        categories: {
            let mut m = HashMap::new();
            m.insert(
                "cat_b".into(),
                BudgetCategory {
                    category_id: "cat_b".into(),
                    amount: Money::new(300, "USD"),
                    carryover: Money::zero("USD"),
                    carryover_from_previous: Money::zero("USD"),
                    carries_over: false,
                },
            );
            m.insert(
                "cat_a".into(),
                BudgetCategory {
                    category_id: "cat_a".into(),
                    amount: Money::new(200, "USD"),
                    carryover: Money::zero("USD"),
                    carryover_from_previous: Money::zero("USD"),
                    carries_over: false,
                },
            );
            m
        },
    };
    let cats = vec![
        sample_category("cat_a", "Category A", false),
        sample_category("cat_b", "Category B", false),
    ];
    let corrections = find_historical_corrections(&[b1, b2], &cats);
    // cat_b changed (100→300), cat_a stayed same (200→200)
    // So only cat_b should appear
    assert_eq!(corrections.len(), 1);
    assert_eq!(corrections[0].category_id, "cat_b");
}

// -- mixed-currency rejection -------------------------------------------

#[test]
fn test_uncategorized_backlog_rejects_mixed_currencies() {
    let txs = vec![
        Transaction {
            amount: Money::new(-500, "USD"),
            ..sample_tx(
                "tx1",
                "a1",
                Some("Shop"),
                None,
                None,
                -500,
                "2026-01-01",
                true,
            )
        },
        Transaction {
            amount: Money::new(-1000, "EUR"),
            ..sample_tx(
                "tx2",
                "a1",
                Some("Cafe"),
                None,
                None,
                -1000,
                "2026-01-02",
                true,
            )
        },
    ];
    let cats = vec![sample_category("c1", "Food", false)];
    let (_backlog, blocker_codes) = build_uncategorized_backlog(&txs, &cats);
    // Mixed currencies should produce a blocker code
    assert!(
        blocker_codes.contains(&"mixed_currency".to_string()),
        "mixed currencies should produce a blocker code: {:?}",
        blocker_codes
    );
}

#[test]
fn test_repeated_merchants_rejects_mixed_currencies() {
    let txs = vec![
        Transaction {
            amount: Money::new(-500, "USD"),
            ..sample_tx(
                "tx1",
                "a1",
                Some("Amazon"),
                None,
                None,
                -500,
                "2026-01-01",
                true,
            )
        },
        Transaction {
            amount: Money::new(-1000, "EUR"),
            ..sample_tx(
                "tx2",
                "a1",
                Some("Amazon"),
                None,
                None,
                -1000,
                "2026-02-01",
                true,
            )
        },
    ];
    let repeated = find_repeated_merchants(&txs);
    // Mixed currencies with same merchant should not be grouped
    assert!(
        repeated.is_empty(),
        "mixed-currency merchant group should be excluded"
    );
}

// -- i64::MIN handling ---------------------------------------------------

#[test]
fn test_uncategorized_backlog_rejects_i64_min() {
    let txs = vec![Transaction {
        amount: Money::new(i64::MIN, "USD"),
        ..sample_tx(
            "tx1",
            "a1",
            Some("Exploit"),
            None,
            None,
            0,
            "2026-01-01",
            true,
        )
    }];
    let cats = vec![sample_category("c1", "Food", false)];
    let (backlog, blocker_codes) = build_uncategorized_backlog(&txs, &cats);
    assert!(blocker_codes.contains(&"amount_overflow".to_string()));
    // Total must be non-negative safe value
    assert!(backlog.total_amount.minor_units() >= 0 || backlog.total_amount.minor_units() == 0);
}

// -- bank sync staleness blocker ----------------------------------------

#[test]
fn test_bank_sync_staleness_emits_blocker() {
    let accounts = vec![sample_account("a1", "Checking")];
    let cats = vec![sample_category("c1", "Food", false)];
    let txs = vec![];
    let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
    let scope = InclusionScope::new(true, true);
    // Bank sync 30 days old → stale
    let result = run_deterministic_analysis(
        &accounts,
        &txs,
        &cats,
        &[],
        &[],
        &[],
        compatibility,
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-06-18T00:00:00Z".into()),
        &scope,
        "2026-07-18",
    );
    assert!(
        result.reason_codes.contains(&"stale_bank_sync".to_string()),
        "stale bank sync should produce stale_bank_sync reason code: {:?}",
        result.reason_codes
    );
    let has_bank_blocker = result.blockers.iter().any(|b| b.code == "stale_bank_sync");
    assert!(
        has_bank_blocker,
        "stale bank sync should be promoted to a blocker"
    );
}

// -- amount overflow blocker promotion ----------------------------------

#[test]
fn test_amount_overflow_promotes_blocker() {
    let accounts = vec![sample_account("a1", "Checking")];
    let cats = vec![sample_category("c1", "Food", false)];
    let txs = vec![Transaction {
        amount: Money::new(i64::MIN, "USD"),
        category_id: None,
        ..sample_tx(
            "tx_bomb",
            "a1",
            Some("Bad"),
            None,
            None,
            0,
            "2026-01-01",
            true,
        )
    }];
    let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
    let scope = InclusionScope::new(true, true);
    let result = run_deterministic_analysis(
        &accounts,
        &txs,
        &cats,
        &[],
        &[],
        &[],
        compatibility,
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-17T00:00:00Z".into()),
        &scope,
        "2026-07-18",
    );
    assert!(
        result.reason_codes.contains(&"amount_overflow".to_string()),
        "i64::MIN should produce amount_overflow reason code: {:?}",
        result.reason_codes
    );
    let has_blocker = result.blockers.iter().any(|b| b.code == "amount_overflow");
    assert!(
        has_blocker,
        "amount overflow should be promoted to a blocker: {:?}",
        result.blockers.iter().map(|b| &b.code).collect::<Vec<_>>()
    );
}

// -- deterministic repeatability with multiple categories ----------------

#[test]
fn test_deterministic_repeatability_sorted() {
    // Ensure multiple repeated merchants come out in a stable order
    let accounts = vec![sample_account("a1", "Checking")];
    let cats = vec![
        sample_category("c1", "Food", false),
        sample_category("c2", "Shopping", false),
    ];
    let txs = vec![
        sample_tx(
            "tx1",
            "a1",
            Some("Zappos"),
            None,
            None,
            -500,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx2",
            "a1",
            Some("Zappos"),
            None,
            None,
            -550,
            "2026-02-01",
            true,
        ),
        sample_tx(
            "tx3",
            "a1",
            Some("Amazon"),
            Some("c1"),
            Some("Food"),
            -2000,
            "2026-01-01",
            true,
        ),
        sample_tx(
            "tx4",
            "a1",
            Some("Amazon"),
            Some("c1"),
            Some("Food"),
            -2100,
            "2026-02-01",
            true,
        ),
    ];
    let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
    let scope = InclusionScope::new(true, true);
    let result_a = run_deterministic_analysis(
        &accounts,
        &txs,
        &cats,
        &[],
        &[],
        &[],
        compatibility.clone(),
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-17T00:00:00Z".into()),
        &scope,
        "2026-07-18",
    );
    let result_b = run_deterministic_analysis(
        &accounts,
        &txs,
        &cats,
        &[],
        &[],
        &[],
        compatibility,
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-17T00:00:00Z".into()),
        &scope,
        "2026-07-18",
    );
    assert_eq!(result_a.repeated_merchants, result_b.repeated_merchants);
}

// -- correction direction with absent amounts --------------------------

#[test]
fn test_correction_candidate_direction_with_absent_amounts() {
    // When correction amounts are absent, direction must be derived from
    // recorded direction evidence, not falsely defaulted to "inflow".
    let outflow_ev = CorrectionEvidence {
        source_review_id: "r1".into(),
        merchant: Some("Netflix".into()),
        imported_payee: None,
        account_id: Some("a1".into()),
        direction: Some("outflow".into()),
        amount: None,
        date: Some("2026-01-15".into()),
        category_id: "c1".into(),
        category_name: Some("Subscriptions".into()),
        actor: "user".into(),
        from_status: "pending".into(),
        to_status: "approved".into(),
    };
    let outflow_ev2 = CorrectionEvidence {
        source_review_id: "r2".into(),
        direction: Some("outflow".into()),
        amount: None,
        ..outflow_ev.clone()
    };
    // Two corrections, both missing amounts, both outflow → direction is outflow
    let candidates = generate_rule_candidates_from_corrections(&[outflow_ev, outflow_ev2], 2);
    assert_eq!(
        candidates.len(),
        1,
        "should produce one candidate from outflow corrections"
    );
    assert_eq!(
        candidates[0].direction, "outflow",
        "direction must be outflow when amounts are absent but direction evidence is consistent; got '{}'",
        candidates[0].direction
    );
}

#[test]
fn test_correction_candidate_direction_without_amounts_or_direction() {
    // When both amounts and direction evidence are absent, direction must
    // be "mixed" (unknown) rather than falsely inflating to "inflow".
    let ev = CorrectionEvidence {
        source_review_id: "r1".into(),
        merchant: Some("UnknownCo".into()),
        imported_payee: None,
        account_id: Some("a1".into()),
        direction: None,
        amount: None,
        date: None,
        category_id: "c2".into(),
        category_name: Some("Misc".into()),
        actor: "user".into(),
        from_status: "pending".into(),
        to_status: "approved".into(),
    };
    let ev2 = CorrectionEvidence {
        source_review_id: "r2".into(),
        ..ev.clone()
    };
    let candidates = generate_rule_candidates_from_corrections(&[ev, ev2], 2);
    assert_eq!(candidates.len(), 1, "should produce one candidate");
    assert_eq!(
        candidates[0].direction, "mixed",
        "direction must be mixed when both amounts and direction are absent; got '{}'",
        candidates[0].direction
    );
}

#[test]
fn test_correction_candidate_direction_with_mixed_direction_evidence_no_amounts() {
    // Multiple conflicting direction values with no amounts → "mixed"
    let inflow_ev = CorrectionEvidence {
        source_review_id: "r1".into(),
        merchant: Some("FlexCo".into()),
        direction: Some("inflow".into()),
        amount: None,
        category_id: "c3".into(),
        ..sample_correction_evidence()
    };
    let outflow_ev = CorrectionEvidence {
        source_review_id: "r2".into(),
        direction: Some("outflow".into()),
        amount: None,
        ..inflow_ev.clone()
    };
    let candidates = generate_rule_candidates_from_corrections(&[inflow_ev, outflow_ev], 2);
    assert_eq!(
        candidates.len(),
        1,
        "should produce one candidate from mixed direction"
    );
    assert_eq!(
        candidates[0].direction, "mixed",
        "direction must be mixed when direction evidence conflicts and amounts absent; got '{}'",
        candidates[0].direction
    );
}

/// Shared baseline for CorrectionEvidence used in direction tests.
fn sample_correction_evidence() -> CorrectionEvidence {
    CorrectionEvidence {
        source_review_id: String::new(),
        merchant: None,
        imported_payee: None,
        account_id: None,
        direction: None,
        amount: None,
        date: None,
        category_id: String::new(),
        category_name: None,
        actor: "test".into(),
        from_status: "pending".into(),
        to_status: "approved".into(),
    }
}

#[test]
fn analysis_short_observed_history_retains_endpoints_without_source_confidence() {
    let mut txs = [
        sample_tx(
            "n2",
            "a1",
            Some("Netflix"),
            Some("c1"),
            Some("Subscriptions"),
            -1500,
            "2026-07-01",
            true,
        ),
        sample_tx(
            "n1",
            "a1",
            Some("Netflix"),
            Some("c1"),
            Some("Subscriptions"),
            -1500,
            "2026-06-01",
            true,
        ),
    ];
    for tx in &mut txs {
        tx.payee_id = Some("payee-netflix".into());
    }
    let result = run_deterministic_analysis(
        &[sample_account("a1", "Checking")],
        &txs,
        &[sample_category("c1", "Subscriptions", false)],
        &[],
        &[],
        &[],
        CompatibilityMetadata::new(false, true, "25.1.0".into()),
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-18T00:00:00Z".into()),
        &InclusionScope::new(true, true),
        "2026-07-18",
    );
    assert_eq!(result.recurring_charges.len(), 1);
    let netflix = &result.recurring_charges[0];
    assert_eq!(netflix.normalized_merchant, "netflix");
    assert_eq!(netflix.frequency_label, "monthly");
    assert_eq!(netflix.typical_amount, Money::new(-1500, "USD"));
    assert_eq!(netflix.transaction_ids, ["n1", "n2"]);
    assert_eq!(netflix.dates, ["2026-06-01", "2026-07-01"]);
    assert_eq!(netflix.occurrences, 2);
    assert_eq!(netflix.tier, MerchantEvidenceTier::InsufficientData);
    assert_eq!(netflix.first_date, "2026-06-01");
    assert_eq!(netflix.last_date, "2026-07-01");
}

#[test]
fn analysis_distinguishes_recurring_cadences_from_unusable_history() {
    let cases = [
        ("Daily", "2026-07-01", "2026-07-02", -100, -100),
        ("Weekly", "2026-07-01", "2026-07-08", -100, -100),
        ("Biweekly", "2026-07-01", "2026-07-15", -100, -100),
        ("Yearly", "2025-07-01", "2026-07-01", -100, -100),
        ("Irregular", "2026-04-01", "2026-07-01", -100, -100),
        ("Variable", "2026-06-01", "2026-07-01", -100, -1000),
        ("Undated", "unknown", "unknown", -100, -100),
        ("Salary", "2026-06-01", "2026-07-01", 100, 100),
    ];
    let mut txs: Vec<_> = cases
        .iter()
        .flat_map(|(merchant, first, last, amount1, amount2)| {
            [
                sample_tx(
                    &format!("{merchant}-1"),
                    "a1",
                    Some(merchant),
                    Some("c1"),
                    Some("Services"),
                    *amount1,
                    first,
                    true,
                ),
                sample_tx(
                    &format!("{merchant}-2"),
                    "a1",
                    Some(merchant),
                    Some("c1"),
                    Some("Services"),
                    *amount2,
                    last,
                    true,
                ),
            ]
        })
        .collect();
    for tx in &mut txs {
        tx.payee_id = Some(format!(
            "payee-{}",
            tx.payee_name.as_deref().unwrap().to_lowercase()
        ));
    }
    let result = run_deterministic_analysis(
        &[sample_account("a1", "Checking")],
        &txs,
        &[sample_category("c1", "Services", false)],
        &[],
        &[],
        &[],
        CompatibilityMetadata::new(false, true, "25.1.0".into()),
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-18T00:00:00Z".into()),
        &InclusionScope::new(true, true),
        "2026-07-18",
    );
    let recurring: Vec<_> = result
        .recurring_charges
        .iter()
        .map(|charge| {
            (
                charge.normalized_merchant.as_str(),
                charge.frequency_label.as_str(),
            )
        })
        .collect();
    assert_eq!(
        recurring,
        [
            ("biweekly", "biweekly"),
            ("daily", "irregular"),
            ("irregular", "quarterly"),
            ("salary", "monthly"),
            ("variable", "monthly"),
            ("weekly", "weekly"),
            ("yearly", "annual"),
        ]
    );
}

#[test]
fn analysis_historical_changes_use_observed_months_and_stable_ranking() {
    use crate::snapshots::BudgetCategory;

    let budgets: Vec<_> = [
        (
            "2026-03",
            vec![
                ("a", 300),
                ("b", 300),
                ("unknown", 200),
                ("single", 900),
                ("stable", 100),
            ],
        ),
        (
            "2026-01",
            vec![("a", 100), ("b", 100), ("unknown", 100), ("stable", 100)],
        ),
        ("2026-02", vec![("a", 200), ("b", 200), ("stable", 100)]),
    ]
    .into_iter()
    .map(|(month, amounts)| BudgetMonth {
        id: month.into(),
        month: month.into(),
        categories: amounts
            .into_iter()
            .map(|(id, amount)| {
                (
                    id.into(),
                    BudgetCategory {
                        category_id: id.into(),
                        amount: Money::new(amount, "USD"),
                        carryover: Money::zero("USD"),
                        carryover_from_previous: Money::zero("USD"),
                        carries_over: false,
                    },
                )
            })
            .collect(),
    })
    .collect();
    let result = run_deterministic_analysis(
        &[],
        &[],
        &[
            sample_category("a", "Food", false),
            sample_category("b", "Travel", false),
        ],
        &[],
        &[],
        &budgets,
        CompatibilityMetadata::new(false, true, "25.1.0".into()),
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-18T00:00:00Z".into()),
        &InclusionScope::new(true, true),
        "2026-07-18",
    );
    let changes: Vec<_> = result
        .historical_corrections
        .iter()
        .map(|change| {
            (
                change.category_id.as_str(),
                change.category_name.as_str(),
                change.change_count,
            )
        })
        .collect();
    assert_eq!(
        changes,
        [
            ("a", "Food", 2),
            ("b", "Travel", 2),
            ("unknown", "unknown", 1)
        ]
    );
    assert_eq!(
        result.historical_corrections[0].months,
        ["2026-01", "2026-02", "2026-03"]
    );
    assert_eq!(
        result.historical_corrections[2].months,
        ["2026-01", "2026-03"]
    );
}

#[test]
fn analysis_incompatible_version_blocks_even_without_diagnostic_metadata() {
    let mut compatibility = CompatibilityMetadata::new(false, true, "23.1.0".into());
    compatibility.compatibility_message = None;
    let result = run_deterministic_analysis(
        &[],
        &[],
        &[],
        &[],
        &[],
        &[],
        compatibility,
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-18T00:00:00Z".into()),
        &InclusionScope::new(true, true),
        "2026-07-18",
    );
    assert_eq!(result.result_code, "error");
    assert!(result
        .blockers
        .iter()
        .any(|blocker| blocker.code == "incompatible_version"));
    assert!(result
        .reason_codes
        .iter()
        .any(|code| code == "unsupported_schema_version"));
}

#[test]
fn analysis_promotes_deleted_category_and_duplicate_evidence() {
    let txs = [
        sample_tx(
            "original",
            "a1",
            Some("Shop"),
            Some("deleted"),
            Some("Old food"),
            -500,
            "2026-07-01",
            true,
        ),
        sample_tx(
            "copy",
            "a1",
            Some("Shop"),
            Some("deleted"),
            Some("Old food"),
            -500,
            "2026-07-01",
            true,
        ),
    ];
    let result = run_deterministic_analysis(
        &[sample_account("a1", "Checking")],
        &txs,
        &[sample_category("deleted", "Old food", true)],
        &[],
        &[],
        &[],
        CompatibilityMetadata::new(false, true, "25.1.0".into()),
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-18T00:00:00Z".into()),
        &InclusionScope::new(true, true),
        "2026-07-18",
    );
    assert_eq!(result.result_code, "error");
    assert!(result
        .blockers
        .iter()
        .any(|blocker| blocker.code == "deleted_category_referenced"));
    assert!(result
        .reason_codes
        .iter()
        .any(|code| code == "deleted_category_referenced"));
    assert!(result
        .reason_codes
        .iter()
        .any(|code| code == "duplicate_detected"));
    assert_eq!(result.duplicate_evidence.len(), 1);
}

#[test]
fn analysis_policy_removes_pending_and_transfer_evidence_before_findings() {
    let mut transfer = sample_tx(
        "transfer",
        "a1",
        Some("Shop"),
        None,
        None,
        -500,
        "2026-07-01",
        true,
    );
    transfer.transfer_account_id = Some("a2".into());
    let txs = [
        sample_tx(
            "kept",
            "a1",
            Some("Shop"),
            Some("c1"),
            Some("Food"),
            -500,
            "2026-07-01",
            true,
        ),
        sample_tx(
            "pending",
            "a1",
            Some("Shop"),
            None,
            None,
            -500,
            "2026-07-01",
            false,
        ),
        transfer,
    ];
    let result = run_deterministic_analysis(
        &[sample_account("a1", "Checking")],
        &txs,
        &[sample_category("c1", "Food", false)],
        &[],
        &[],
        &[],
        CompatibilityMetadata::new(false, true, "25.1.0".into()),
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-18T00:00:00Z".into()),
        &InclusionScope::new(false, true),
        "2026-07-18",
    );
    assert_eq!(result.coverage.total_transactions, 1);
    assert_eq!(result.uncategorized_backlog.count, 0);
    assert!(result.duplicate_evidence.is_empty());
    assert!(result.repeated_merchants.is_empty());
    assert!(result.rule_candidates.is_empty());
    assert!(result
        .reason_codes
        .iter()
        .any(|code| code == "pending_policy"));
    assert!(result
        .reason_codes
        .iter()
        .any(|code| code == "excluded_by_policy"));
    assert!(!result
        .reason_codes
        .iter()
        .any(|code| code == "duplicate_detected"));
}

#[test]
fn analysis_mixed_currency_backlog_is_an_error_not_an_actionable_total() {
    let txs = [
        sample_tx(
            "usd",
            "a1",
            Some("Shop"),
            None,
            None,
            -500,
            "2026-07-01",
            true,
        ),
        Transaction {
            amount: Money::new(-700, "EUR"),
            ..sample_tx(
                "eur",
                "a1",
                Some("Shop"),
                None,
                None,
                -700,
                "2026-07-02",
                true,
            )
        },
    ];
    let result = run_deterministic_analysis(
        &[sample_account("a1", "Checking")],
        &txs,
        &[],
        &[],
        &[],
        &[],
        CompatibilityMetadata::new(false, true, "25.1.0".into()),
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-18T00:00:00Z".into()),
        &InclusionScope::new(true, true),
        "2026-07-18",
    );
    assert_eq!(result.result_code, "error");
    assert_eq!(result.uncategorized_backlog.transaction_ids, ["usd", "eur"]);
    assert!(result.repeated_merchants.is_empty());
    assert!(result
        .blockers
        .iter()
        .any(|blocker| blocker.code == "mixed_currency"));
    assert!(result
        .reason_codes
        .iter()
        .any(|code| code == "unresolved_metadata_ref"));
}

#[test]
fn analysis_absolute_sum_overflow_blocks_and_omits_repeated_merchant_total() {
    let txs = [
        sample_tx(
            "large",
            "a1",
            Some("Shop"),
            None,
            None,
            i64::MAX,
            "2026-07-01",
            true,
        ),
        sample_tx(
            "small",
            "a1",
            Some("Shop"),
            None,
            None,
            -1,
            "2026-07-02",
            true,
        ),
    ];
    let result = run_deterministic_analysis(
        &[sample_account("a1", "Checking")],
        &txs,
        &[],
        &[],
        &[],
        &[],
        CompatibilityMetadata::new(false, true, "25.1.0".into()),
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-18T00:00:00Z".into()),
        &InclusionScope::new(true, true),
        "2026-07-18",
    );
    assert_eq!(result.result_code, "error");
    assert_eq!(
        result.uncategorized_backlog.transaction_ids,
        ["large", "small"]
    );
    assert!(result.repeated_merchants.is_empty());
    assert!(result
        .blockers
        .iter()
        .any(|blocker| blocker.code == "amount_overflow"));
    assert!(result
        .reason_codes
        .iter()
        .any(|code| code == "amount_overflow"));
}

fn actual_category_rule(
    id: &str,
    inactive: bool,
    stage: serde_json::Value,
    conditions_op: &str,
    conditions: serde_json::Value,
    actions: serde_json::Value,
) -> crate::snapshots::Rule {
    crate::snapshots::Rule {
        id: id.into(),
        name: format!("Rule {id}"),
        order: 1,
        trigger: serde_json::json!({
            "stage": stage,
            "conditionsOp": conditions_op,
            "conditions": conditions,
        }),
        actions,
        inactive,
    }
}

fn canonical_rule_tx(transaction_id: &str) -> Transaction {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../protocol/fixtures/financial-decision-foundation.json"
    ))
    .unwrap();
    let mut tx: Transaction =
        serde_json::from_value(fixture["full"]["legacySnapshot"]["transactions"][0].clone())
            .unwrap();
    tx.id = transaction_id.into();
    tx.account_id = "fd-account-checking".into();
    tx.payee_name = Some("Coffee".into());
    tx.category_id = None;
    tx.category_name = None;
    tx.amount = Money::new(-500, "USD");
    tx.date = "2026-07-01".into();
    tx.cleared = true;
    tx
}

fn category_rule_actions(category_id: &str) -> serde_json::Value {
    serde_json::json!([{
        "op": "set",
        "field": "category",
        "value": category_id,
    }])
}

fn analyze_with_rules(
    transactions: &[Transaction],
    categories: &[Category],
    payees: &[crate::snapshots::Payee],
    rules: &[crate::snapshots::Rule],
    scope: &InclusionScope,
) -> DeterministicAnalysis {
    run_deterministic_analysis(
        &[sample_account("fd-account-checking", "Household Checking")],
        transactions,
        categories,
        payees,
        rules,
        &[],
        CompatibilityMetadata::new(false, true, "25.1.0".into()),
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-18T00:00:00Z".into()),
        scope,
        "2026-07-18",
    )
}

fn classification_json(
    result: &DeterministicAnalysis,
    transaction_id: &str,
) -> Option<serde_json::Value> {
    result
        .deterministic_classifications
        .iter()
        .find(|candidate| candidate.transaction_id == transaction_id)
        .map(|candidate| serde_json::to_value(candidate).unwrap())
}

fn shared_classification_rule_ids(
    result: &DeterministicAnalysis,
    candidate: &serde_json::Value,
) -> serde_json::Value {
    assert!(
        candidate.get("ruleIds").is_none(),
        "native candidates must not repeat complete IDs"
    );
    let index = candidate["ruleSetIndex"]
        .as_u64()
        .expect("native candidate requires a shared index") as usize;
    let output = serde_json::to_value(result).unwrap();
    serde_json::json!(source_posting_rule_ids(
        &output,
        &output["nativeRuleSets"][index]
    ))
}

#[test]
fn analysis_enabled_actual_category_rule_proposes_target_and_rule_ids() {
    let tx = canonical_rule_tx("coffee");
    let rules = [actual_category_rule(
        "rule-coffee",
        false,
        serde_json::json!("pre"),
        "and",
        serde_json::json!([{
            "op": "is",
            "field": "payee_name",
            "value": "Coffee",
        }]),
        category_rule_actions("food"),
    )];

    let result = analyze_with_rules(
        &[tx],
        &[sample_category("food", "Food", false)],
        &[],
        &rules,
        &InclusionScope::new(true, true),
    );

    let candidate = classification_json(&result, "coffee").unwrap();
    assert_eq!(candidate["proposedCategoryId"], "food");
    assert_eq!(candidate["proposedCategoryName"], "Food");
    assert_eq!(
        shared_classification_rule_ids(&result, &candidate),
        serde_json::json!(["rule-coffee"])
    );
    assert_eq!(candidate["reasons"][0]["kind"], "AutomationRule");
}

#[test]
fn analysis_paused_rule_keeps_history_and_resume_restores_rule_target() {
    let mut history = canonical_rule_tx("history");
    history.category_id = Some("old-food".into());
    history.category_name = Some("Old Food".into());
    history.date = "2026-06-01".into();
    let txs = [history, canonical_rule_tx("coffee")];
    let categories = [
        sample_category("old-food", "Old Food", false),
        sample_category("food", "Food", false),
    ];
    let paused = [actual_category_rule(
        "rule-coffee",
        true,
        serde_json::json!(null),
        "and",
        serde_json::json!([{
            "op": "is",
            "field": "payee_name",
            "value": "Coffee",
        }]),
        category_rule_actions("food"),
    )];
    let resumed = [actual_category_rule(
        "rule-coffee",
        false,
        serde_json::json!(null),
        "and",
        serde_json::json!([{
            "op": "is",
            "field": "payee_name",
            "value": "Coffee",
        }]),
        category_rule_actions("food"),
    )];

    let paused_result = analyze_with_rules(
        &txs,
        &categories,
        &[],
        &paused,
        &InclusionScope::new(true, true),
    );
    let paused_candidate = classification_json(&paused_result, "coffee").unwrap();
    assert!(paused_candidate.get("proposedCategoryId").is_none());
    assert!(paused_candidate.get("ruleIds").is_none());
    assert!(paused_candidate.get("ruleSetIndex").is_none());
    assert_eq!(paused_candidate["reasons"][0]["kind"], "Historical");

    let resumed_result = analyze_with_rules(
        &txs,
        &categories,
        &[],
        &resumed,
        &InclusionScope::new(true, true),
    );
    let resumed_candidate = classification_json(&resumed_result, "coffee").unwrap();
    assert_eq!(resumed_candidate["proposedCategoryId"], "food");
    assert_eq!(
        shared_classification_rule_ids(&resumed_result, &resumed_candidate),
        serde_json::json!(["rule-coffee"])
    );
}

#[test]
fn analysis_actual_category_rule_rejects_deleted_or_missing_target() {
    let tx = canonical_rule_tx("coffee");
    let rules = [actual_category_rule(
        "rule-coffee",
        false,
        serde_json::json!("post"),
        "and",
        serde_json::json!([{
            "op": "is",
            "field": "payee_name",
            "value": "Coffee",
        }]),
        category_rule_actions("food"),
    )];

    for categories in [
        vec![sample_category("food", "Food", true)],
        vec![sample_category("other", "Other", false)],
    ] {
        let result = analyze_with_rules(
            std::slice::from_ref(&tx),
            &categories,
            &[],
            &rules,
            &InclusionScope::new(true, true),
        );
        assert!(classification_json(&result, "coffee").is_none());
    }
}

#[test]
fn analysis_actual_category_rule_supports_null_stage_and_or_vs_and() {
    let tx = canonical_rule_tx("coffee");
    let conditions = serde_json::json!([
        {"op": "is", "field": "payee_name", "value": "No Match"},
        {"op": "is", "field": "account", "value": "fd-account-checking"},
    ]);
    let or_rule = [actual_category_rule(
        "or-rule",
        false,
        serde_json::json!(null),
        "or",
        conditions.clone(),
        category_rule_actions("food"),
    )];
    let and_rule = [actual_category_rule(
        "and-rule",
        false,
        serde_json::json!(null),
        "and",
        conditions,
        category_rule_actions("food"),
    )];
    let categories = [sample_category("food", "Food", false)];

    let or_result = analyze_with_rules(
        std::slice::from_ref(&tx),
        &categories,
        &[],
        &or_rule,
        &InclusionScope::new(true, true),
    );
    let or_candidate = classification_json(&or_result, "coffee").unwrap();
    assert_eq!(or_candidate["proposedCategoryId"], "food");
    assert_eq!(
        shared_classification_rule_ids(&or_result, &or_candidate),
        serde_json::json!(["or-rule"])
    );

    let and_result = analyze_with_rules(
        &[tx],
        &categories,
        &[],
        &and_rule,
        &InclusionScope::new(true, true),
    );
    assert!(classification_json(&and_result, "coffee").is_none());
}

#[test]
fn analysis_actual_category_rule_matches_payee_id_and_account_category_predicates() {
    let mut tx = canonical_rule_tx("coffee");
    tx.payee_id = Some("fd-payee-coffee".into());
    let rule = [actual_category_rule(
        "actual-identifiers",
        false,
        serde_json::json!("post"),
        "and",
        serde_json::json!([
            {"op": "is", "field": "payee", "value": "fd-payee-coffee"},
            {
                "op": "oneOf",
                "field": "account",
                "value": ["fd-account-card", "fd-account-checking"],
            },
            {"op": "is", "field": "category", "value": null},
        ]),
        category_rule_actions("food"),
    )];
    let result = analyze_with_rules(
        &[tx],
        &[sample_category("food", "Food", false)],
        &[],
        &rule,
        &InclusionScope::new(true, true),
    );
    let candidate = classification_json(&result, "coffee").unwrap();
    assert_eq!(candidate["proposedCategoryId"], "food");
    assert_eq!(
        shared_classification_rule_ids(&result, &candidate),
        serde_json::json!(["actual-identifiers"])
    );
}

#[test]
fn analysis_actual_category_rule_respects_scope_and_skips_categorized_transactions() {
    let mut transfer = canonical_rule_tx("transfer");
    transfer.transfer_account_id = Some("fd-account-card".into());
    let mut categorized = canonical_rule_tx("categorized");
    categorized.category_id = Some("food".into());
    categorized.category_name = Some("Food".into());
    let rule = [actual_category_rule(
        "rule-coffee",
        false,
        serde_json::json!("pre"),
        "and",
        serde_json::json!([{
            "op": "is",
            "field": "account",
            "value": "fd-account-checking",
        }]),
        category_rule_actions("food"),
    )];
    let result = analyze_with_rules(
        &[transfer, categorized],
        &[sample_category("food", "Food", false)],
        &[],
        &rule,
        &InclusionScope::new(true, true),
    );
    assert!(classification_json(&result, "transfer").is_none());
    assert!(classification_json(&result, "categorized").is_none());
}

#[test]
fn analysis_actual_category_rule_rejects_unsupported_branches_and_actions() {
    let tx = canonical_rule_tx("coffee");
    let categories = [sample_category("food", "Food", false)];
    let scope = InclusionScope::new(true, true);
    let matching_condition = serde_json::json!({
        "op": "is",
        "field": "payee_name",
        "value": "Coffee",
    });
    let unsupported_branch = [actual_category_rule(
        "regex-rule",
        false,
        serde_json::json!("pre"),
        "or",
        serde_json::json!([
            matching_condition.clone(),
            {"op": "matches", "field": "payee_name", "value": ".*"},
        ]),
        category_rule_actions("food"),
    )];
    let extra_action = [actual_category_rule(
        "extra-action",
        false,
        serde_json::json!("pre"),
        "and",
        serde_json::json!([matching_condition.clone()]),
        serde_json::json!([
            {"op": "set", "field": "category", "value": "food"},
            {"op": "set", "field": "payee_name", "value": "Changed"},
        ]),
    )];
    let missing_stage = [actual_category_rule(
        "missing-stage",
        false,
        serde_json::Value::Null,
        "and",
        serde_json::json!([matching_condition.clone()]),
        category_rule_actions("food"),
    )];
    let mut missing_stage_rule = missing_stage[0].clone();
    missing_stage_rule
        .trigger
        .as_object_mut()
        .unwrap()
        .remove("stage");
    let missing_operator = [actual_category_rule(
        "missing-operator",
        false,
        serde_json::json!("pre"),
        "and",
        serde_json::json!([matching_condition]),
        category_rule_actions("food"),
    )];
    let mut missing_operator_rule = missing_operator[0].clone();
    missing_operator_rule
        .trigger
        .as_object_mut()
        .unwrap()
        .remove("conditionsOp");
    let legacy_trigger = [crate::snapshots::Rule {
        id: "legacy".into(),
        name: "Legacy".into(),
        order: 1,
        trigger: serde_json::json!([{"type": "payee", "value": "Coffee"}]),
        actions: category_rule_actions("food"),
        inactive: false,
    }];
    let malformed_action = [actual_category_rule(
        "malformed-action",
        false,
        serde_json::json!("pre"),
        "and",
        serde_json::json!([{
            "op": "is",
            "field": "payee_name",
            "value": "Coffee",
        }]),
        serde_json::json!([{
            "op": "set",
            "field": "category",
            "value": null,
        }]),
    )];

    for rules in [
        unsupported_branch.as_slice(),
        extra_action.as_slice(),
        std::slice::from_ref(&missing_stage_rule),
        std::slice::from_ref(&missing_operator_rule),
        legacy_trigger.as_slice(),
        malformed_action.as_slice(),
    ] {
        let result = analyze_with_rules(std::slice::from_ref(&tx), &categories, &[], rules, &scope);
        assert!(classification_json(&result, "coffee").is_none());
    }
}

#[test]
fn analysis_conflicting_actual_category_rules_do_not_choose_arbitrary_target() {
    let tx = canonical_rule_tx("coffee");
    let rules = [
        actual_category_rule(
            "a-rule",
            false,
            serde_json::json!("pre"),
            "and",
            serde_json::json!([{
                "op": "is",
                "field": "payee_name",
                "value": "Coffee",
            }]),
            category_rule_actions("food"),
        ),
        actual_category_rule(
            "z-rule",
            false,
            serde_json::json!("pre"),
            "and",
            serde_json::json!([{
                "op": "is",
                "field": "payee_name",
                "value": "Coffee",
            }]),
            category_rule_actions("coffee"),
        ),
    ];
    let result = analyze_with_rules(
        &[tx],
        &[
            sample_category("food", "Food", false),
            sample_category("coffee", "Coffee", false),
        ],
        &[],
        &rules,
        &InclusionScope::new(true, true),
    );
    assert!(classification_json(&result, "coffee").is_none());
}

#[test]
fn analysis_same_target_actual_rules_report_sorted_rule_ids() {
    let tx = canonical_rule_tx("coffee");
    let make_rule = |id| {
        actual_category_rule(
            id,
            false,
            serde_json::json!("post"),
            "and",
            serde_json::json!([{
                "op": "is",
                "field": "payee_name",
                "value": "Coffee",
            }]),
            category_rule_actions("food"),
        )
    };
    let result = analyze_with_rules(
        &[tx],
        &[sample_category("food", "Food", false)],
        &[],
        &[make_rule("z-rule"), make_rule("a-rule")],
        &InclusionScope::new(true, true),
    );
    let candidate = classification_json(&result, "coffee").unwrap();
    assert_eq!(candidate["proposedCategoryId"], "food");
    assert_eq!(
        shared_classification_rule_ids(&result, &candidate),
        serde_json::json!(["a-rule", "z-rule"])
    );
}

#[test]
fn analysis_shared_native_rule_sets_preserve_complete_ids_without_per_candidate_expansion() {
    let ids: Vec<_> = (0..64)
        .map(|index| format!("legacy-shared-rule-{index:03}"))
        .collect();
    let rules: Vec<_> = ids
        .iter()
        .rev()
        .map(|id| {
            actual_category_rule(
                id,
                false,
                serde_json::json!("post"),
                "and",
                serde_json::json!([
                    {"field": "account", "op": "is", "value": "fd-account-checking"},
                    {"field": "category", "op": "is", "value": null}
                ]),
                category_rule_actions("food"),
            )
        })
        .collect();
    let transactions: Vec<_> = (0..240)
        .map(|index| {
            let mut tx = canonical_rule_tx(&format!("legacy-shared-{index:03}"));
            tx.payee_id = Some(format!("legacy-payee-{index:03}"));
            tx.payee_name = Some(format!("Distinct legacy merchant {index:03}"));
            tx
        })
        .collect();
    let payees: Vec<_> = transactions
        .iter()
        .map(|tx| crate::snapshots::Payee {
            id: tx.payee_id.clone().unwrap(),
            name: tx.payee_name.clone().unwrap(),
            transfer_account_id: None,
            mtid: None,
        })
        .collect();
    let categories = [sample_category("food", "Food", false)];
    let result = analyze_with_rules(
        &transactions,
        &categories,
        &payees,
        &rules,
        &InclusionScope::new(true, true),
    );
    let output = serde_json::to_value(&result).unwrap();
    assert_eq!(
        output["nativeRuleBlocks"],
        serde_json::json!([{"ruleIds": ids}])
    );
    assert_eq!(
        output["nativeRuleParts"],
        serde_json::json!([{"blockIndexes": [0]}])
    );
    assert_eq!(
        output["nativeRuleSets"],
        serde_json::json!([{"orPartIndexes": [], "andPartIndexes": [[0], [0], [0], [0]], "categoryPartIndex": 0}])
    );
    let candidates = output["deterministicClassifications"].as_array().unwrap();
    assert_eq!(candidates.len(), 240);
    for candidate in candidates {
        assert_eq!(candidate["proposedCategoryId"], "food");
        assert_eq!(candidate["proposedCategoryName"], "Food");
        assert_eq!(candidate["ruleSetIndex"], 0);
        assert!(candidate.get("ruleIds").is_none());
        assert_eq!(candidate["reasons"][0]["kind"], "AutomationRule");
    }
    let serialized = serde_json::to_string(&result).unwrap();
    for id in &ids {
        assert_eq!(serialized.matches(&format!("\"{id}\"")).count(), 1);
    }
    let mut reversed_transactions = transactions.clone();
    reversed_transactions.reverse();
    let mut reversed_rules = rules.clone();
    reversed_rules.reverse();
    let reversed = analyze_with_rules(
        &reversed_transactions,
        &categories,
        &payees,
        &reversed_rules,
        &InclusionScope::new(true, true),
    );
    let reversed = serde_json::to_value(reversed).unwrap();
    assert_eq!(reversed["nativeRuleSets"], output["nativeRuleSets"]);
    assert_eq!(reversed["nativeRuleBlocks"], output["nativeRuleBlocks"]);
    assert_eq!(
        reversed["deterministicClassifications"],
        output["deterministicClassifications"]
    );
    reversed_rules.push(actual_category_rule(
        "unmatched-payee-rule",
        false,
        serde_json::json!("post"),
        "and",
        serde_json::json!([{"field": "payee", "op": "is", "value": "not-a-matching-payee"}]),
        category_rule_actions("food"),
    ));
    let relevant_but_equal = analyze_with_rules(
        &transactions,
        &categories,
        &payees,
        &reversed_rules,
        &InclusionScope::new(true, true),
    );
    let relevant_but_equal = serde_json::to_value(relevant_but_equal).unwrap();
    assert_eq!(
        relevant_but_equal["nativeRuleSets"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        source_posting_rule_ids(
            &relevant_but_equal,
            &relevant_but_equal["nativeRuleSets"][0]
        ),
        ids
    );
    assert_eq!(
        relevant_but_equal["deterministicClassifications"],
        output["deterministicClassifications"]
    );
    let historical = analyze_with_rules(
        &[canonical_rule_tx("non-native")],
        &categories,
        &[crate::snapshots::Payee {
            id: "coffee".into(),
            name: "Coffee".into(),
            transfer_account_id: None,
            mtid: None,
        }],
        &[],
        &InclusionScope::new(true, true),
    );
    let historical = serde_json::to_value(historical).unwrap();
    assert_eq!(historical["nativeRuleSets"], serde_json::json!([]));
    assert_eq!(historical["nativeRuleBlocks"], serde_json::json!([]));
    assert_eq!(historical["nativeRuleParts"], serde_json::json!([]));
    assert!(historical["deterministicClassifications"][0]
        .get("ruleSetIndex")
        .is_none());
    assert!(historical["deterministicClassifications"][0]
        .get("ruleIds")
        .is_none());
}

#[test]
fn analysis_overlapping_native_rule_sets_share_blocks_without_common_id_expansion() {
    let common_ids: Vec<_> = (0..64)
        .map(|index| format!("legacy-overlap-common-{index:03}"))
        .collect();
    let transactions: Vec<_> = (0..240)
        .map(|index| {
            let mut tx = canonical_rule_tx(&format!("legacy-overlap-tx-{index:03}"));
            tx.payee_id = Some(format!("legacy-overlap-payee-{:03}", index % 48));
            tx.payee_name = Some(format!("Legacy overlap merchant {:03}", index % 48));
            tx
        })
        .collect();
    let payees: Vec<_> = (0..48)
        .map(|index| crate::snapshots::Payee {
            id: format!("legacy-overlap-payee-{index:03}"),
            name: format!("Legacy overlap merchant {index:03}"),
            transfer_account_id: None,
            mtid: None,
        })
        .collect();
    let categories = [sample_category("food", "Food", false)];
    let mut rules: Vec<_> = common_ids
        .iter()
        .map(|id| {
            actual_category_rule(
                id,
                false,
                serde_json::json!("post"),
                "and",
                serde_json::json!([
                    {"field": "account", "op": "is", "value": "fd-account-checking"},
                    {"field": "category", "op": "is", "value": null}
                ]),
                category_rule_actions("food"),
            )
        })
        .collect();
    for index in 0..48 {
        rules.push(actual_category_rule(
            &format!("legacy-overlap-private-{index:03}"), false, serde_json::json!("post"), "and",
            serde_json::json!([{"field": "payee", "op": "is", "value": format!("legacy-overlap-payee-{index:03}")}]),
            category_rule_actions("food"),
        ));
    }
    let result = analyze_with_rules(
        &transactions,
        &categories,
        &payees,
        &rules,
        &InclusionScope::new(true, true),
    );
    let output = serde_json::to_value(&result).unwrap();
    let blocks = output["nativeRuleBlocks"]
        .as_array()
        .expect("legacy unequal overlapping outcomes must retain common IDs in shared blocks");
    assert_eq!(blocks.len(), 49);
    assert_eq!(
        blocks
            .iter()
            .map(|block| block["ruleIds"].as_array().unwrap().len())
            .sum::<usize>(),
        112
    );
    assert_eq!(
        blocks
            .iter()
            .filter(|block| block["ruleIds"] == serde_json::json!(common_ids))
            .count(),
        1
    );
    let all_ids: std::collections::BTreeSet<_> = blocks
        .iter()
        .flat_map(|block| {
            block["ruleIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap())
        })
        .collect();
    assert_eq!(
        all_ids.len(),
        112,
        "source rule IDs must belong to disjoint blocks"
    );
    let sets = output["nativeRuleSets"].as_array().unwrap();
    assert_eq!(sets.len(), 48);
    for set in sets {
        assert!(set.get("ruleIds").is_none());
        assert_eq!(source_posting_rule_ids(&output, set).len(), 65);
    }
    let candidates = output["deterministicClassifications"].as_array().unwrap();
    assert_eq!(candidates.len(), 240);
    for (index, candidate) in candidates.iter().enumerate() {
        assert_eq!(
            candidate["transactionId"],
            format!("legacy-overlap-tx-{index:03}")
        );
        assert_eq!(candidate["proposedCategoryId"], "food");
        assert_eq!(candidate["proposedCategoryName"], "Food");
        assert!(candidate.get("ruleIds").is_none());
        let set = &sets[candidate["ruleSetIndex"].as_u64().unwrap() as usize];
        let complete = source_posting_rule_ids(&output, set);
        let mut expected = common_ids.clone();
        expected.push(format!("legacy-overlap-private-{:03}", index % 48));
        assert_eq!(complete, expected);
    }
    let serialized = serde_json::to_string(&result).unwrap();
    for id in &all_ids {
        assert_eq!(serialized.matches(&format!("\"{id}\"")).count(), 1);
    }
    let mut reversed_transactions = transactions.clone();
    reversed_transactions.reverse();
    let mut reversed_payees = payees.clone();
    reversed_payees.reverse();
    rules.reverse();
    let reversed = analyze_with_rules(
        &reversed_transactions,
        &categories,
        &reversed_payees,
        &rules,
        &InclusionScope::new(true, true),
    );
    let reversed = serde_json::to_value(reversed).unwrap();
    for field in [
        "nativeRuleBlocks",
        "nativeRuleSets",
        "deterministicClassifications",
    ] {
        assert_eq!(
            reversed[field], output[field],
            "legacy {field} must survive source enumeration"
        );
    }
}

#[test]
fn rule_candidates_distinguish_income_from_refunded_spending_and_enrich_names() {
    let txs = [
        sample_tx(
            "income1",
            "a1",
            Some("Employer"),
            Some("income"),
            None,
            2000,
            "2026-06-01",
            true,
        ),
        sample_tx(
            "income2",
            "a1",
            Some("Employer"),
            Some("income"),
            Some("Salary"),
            2100,
            "2026-07-01",
            true,
        ),
        sample_tx(
            "purchase",
            "a1",
            Some("Shop"),
            Some("food"),
            Some("Food"),
            -500,
            "2026-07-01",
            true,
        ),
        sample_tx(
            "refund",
            "a1",
            Some("Shop"),
            Some("food"),
            Some("Food"),
            500,
            "2026-07-02",
            true,
        ),
        sample_tx(
            "anonymous",
            "a1",
            Some("   "),
            Some("food"),
            Some("Food"),
            -500,
            "2026-07-01",
            true,
        ),
    ];
    let candidates = generate_rule_candidates(&txs, &[], 2);
    assert_eq!(candidates.len(), 2);
    let income = candidates
        .iter()
        .find(|candidate| candidate.proposed_category_id == "income")
        .unwrap();
    assert_eq!(income.proposed_category_name, "Salary");
    assert_eq!(income.direction, "inflow");
    assert_eq!(
        (income.amount_min, income.amount_max),
        (Some(2000), Some(2100))
    );
    assert!(income.conflict_reason.is_none());
    assert!(!income.is_merchant_only);
    let spending = candidates
        .iter()
        .find(|candidate| candidate.proposed_category_id == "food")
        .unwrap();
    assert_eq!(spending.matching_tx_count, 2);
    assert_eq!(spending.direction, "mixed");
    assert_eq!(
        (spending.amount_min, spending.amount_max),
        (Some(-500), Some(500))
    );
    assert!(spending.conflict_reason.is_some());
}

#[test]
fn correction_candidates_preserve_conflicting_context_and_rank_supported_categories() {
    let corrections: Vec<_> = [
        (
            "shop1",
            Some("Shop"),
            Some("a2"),
            Some("outflow"),
            Some(-500),
            "food",
            None,
        ),
        (
            "shop2",
            Some("Shop"),
            Some("a1"),
            Some("inflow"),
            Some(500),
            "food",
            Some("Food"),
        ),
        (
            "shop3",
            Some("Shop"),
            Some("a1"),
            Some("inflow"),
            Some(500),
            "other",
            Some("Other"),
        ),
        (
            "salary1",
            Some("Employer"),
            Some("a1"),
            Some("inflow"),
            Some(2000),
            "income",
            None,
        ),
        (
            "salary2",
            Some("Employer"),
            Some("a1"),
            Some("inflow"),
            Some(2100),
            "income",
            Some("Salary"),
        ),
        (
            "salary3",
            Some("Employer"),
            Some("a1"),
            Some("inflow"),
            Some(2200),
            "income",
            Some("Salary"),
        ),
        (
            "missing",
            None,
            Some("a1"),
            None,
            None,
            "food",
            Some("Food"),
        ),
        (
            "empty",
            Some(""),
            Some("a1"),
            None,
            None,
            "food",
            Some("Food"),
        ),
        (
            "single",
            Some("Cafe"),
            Some("a1"),
            Some("outflow"),
            Some(-200),
            "food",
            Some("Food"),
        ),
    ]
    .into_iter()
    .map(
        |(id, merchant, account, direction, amount, category, name)| CorrectionEvidence {
            source_review_id: id.into(),
            merchant: merchant.map(str::to_string),
            account_id: account.map(str::to_string),
            direction: direction.map(str::to_string),
            amount,
            category_id: category.into(),
            category_name: name.map(str::to_string),
            ..sample_correction_evidence()
        },
    )
    .collect();
    let candidates = generate_rule_candidates_from_corrections(&corrections, 2);
    assert_eq!(candidates.len(), 2);
    let income = &candidates[0];
    assert_eq!(income.proposed_category_id, "income");
    assert_eq!(income.proposed_category_name, "Salary");
    assert_eq!(income.matching_tx_count, 3);
    assert_eq!(income.direction, "inflow");
    assert_eq!(
        (income.amount_min, income.amount_max),
        (Some(2000), Some(2200))
    );
    assert!(income.conflict_reason.is_none());
    let shop = &candidates[1];
    assert_eq!(shop.proposed_category_id, "food");
    assert_eq!(shop.proposed_category_name, "Food");
    assert_eq!(shop.matching_tx_count, 2);
    assert_eq!(shop.account_ids, ["a1", "a2"]);
    assert_eq!(shop.direction, "mixed");
    assert_eq!((shop.amount_min, shop.amount_max), (Some(-500), Some(500)));
    assert!(!shop.is_merchant_only);
    let conflict = shop.conflict_reason.as_deref().unwrap();
    for evidence in ["a1", "a2", "inflow", "outflow", "food", "other"] {
        assert!(
            conflict.contains(evidence),
            "missing conflicting evidence {evidence}"
        );
    }
}

fn source_posting_rules(operation: &str) -> Vec<crate::snapshots::Rule> {
    let mut rules = Vec::new();
    for index in 0..32 {
        rules.push(actual_category_rule(
            &format!("posting-{operation}-{index:03}"),
            false,
            serde_json::json!("post"),
            operation,
            serde_json::json!([
                {"field": "account", "op": "is", "value": "fd-account-checking"},
                {"field": "payee", "op": "is", "value": format!("posting-payee-{index:03}")}
            ]),
            category_rule_actions("food"),
        ));
        if operation == "or" {
            rules.push(actual_category_rule(
                &format!("posting-private-{index:03}"), false, serde_json::json!("post"), "and",
                serde_json::json!([{"field": "payee", "op": "is", "value": format!("posting-payee-{index:03}")}]),
                category_rule_actions("food"),
            ));
        }
    }
    rules
}

fn source_posting_transactions() -> Vec<Transaction> {
    (0..160)
        .map(|index| {
            let mut tx = canonical_rule_tx(&format!("legacy-posting-tx-{index:03}"));
            tx.payee_id = Some(format!("posting-payee-{:03}", index % 32));
            tx.payee_name = Some(format!("Posting merchant {:03}", index % 32));
            tx
        })
        .collect()
}

fn source_posting_rule_ids(output: &serde_json::Value, set: &serde_json::Value) -> Vec<String> {
    let parts = output["nativeRuleParts"]
        .as_array()
        .expect("literal source posting table is required");
    let union = |references: &serde_json::Value| -> std::collections::BTreeSet<usize> {
        let references = references.as_array().unwrap();
        assert!(references
            .windows(2)
            .all(|pair| pair[0].as_u64().unwrap() < pair[1].as_u64().unwrap()));
        references
            .iter()
            .flat_map(|reference| {
                parts[reference.as_u64().unwrap() as usize]["blockIndexes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|index| index.as_u64().unwrap() as usize)
            })
            .collect()
    };
    let or = set["orPartIndexes"]
        .as_array()
        .expect("fixed OR references are required");
    let and = set["andPartIndexes"]
        .as_array()
        .expect("fixed AND operands are required");
    assert!(or.len() <= 4);
    assert!(and.is_empty() || and.len() == 4);
    assert!(and
        .iter()
        .all(|operand| (1..=2).contains(&operand.as_array().unwrap().len())));
    assert!(
        or.len()
            + and
                .iter()
                .map(|operand| operand.as_array().unwrap().len())
                .sum::<usize>()
            < 13
    );
    assert!(set.get("blockIndexes").is_none() && set.get("ruleIds").is_none());
    let mut indexes = union(&set["orPartIndexes"]);
    if let Some(first) = and.first() {
        let mut intersection = union(first);
        for operand in &and[1..] {
            intersection = intersection
                .intersection(&union(operand))
                .copied()
                .collect();
        }
        indexes.extend(intersection);
    }
    let category = set["categoryPartIndex"]
        .as_u64()
        .expect("selected category filter is required") as usize;
    let category_indexes: std::collections::BTreeSet<_> = parts[category]["blockIndexes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|index| index.as_u64().unwrap() as usize)
        .collect();
    indexes = indexes.intersection(&category_indexes).copied().collect();
    let blocks = output["nativeRuleBlocks"].as_array().unwrap();
    let mut ids: Vec<_> = indexes
        .into_iter()
        .flat_map(|index| {
            blocks[index]["ruleIds"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap().to_owned())
        })
        .collect();
    ids.sort_unstable();
    ids
}

#[test]
fn analysis_or_postings_preserve_complete_unequal_outcomes_with_constant_descriptors() {
    let mut transactions = source_posting_transactions();
    let mut rules = source_posting_rules("or");
    let categories = [sample_category("food", "Food", false)];
    let result = analyze_with_rules(
        &transactions,
        &categories,
        &[],
        &rules,
        &InclusionScope::new(true, true),
    );
    let output = serde_json::to_value(result).unwrap();
    let rows = output["deterministicClassifications"].as_array().unwrap();
    assert_eq!(
        rows.len(),
        160,
        "all real legacy producer outcomes remain present"
    );
    assert!(rows
        .iter()
        .all(|row| row["proposedCategoryId"] == "food" && row.get("ruleIds").is_none()));
    let blocks = output["nativeRuleBlocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 64);
    assert_eq!(
        blocks
            .iter()
            .map(|block| block["ruleIds"].as_array().unwrap().len())
            .sum::<usize>(),
        64
    );
    let common_indexes: Vec<_> = blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            block["ruleIds"][0]
                .as_str()
                .unwrap()
                .starts_with("posting-or-")
                .then_some(index)
        })
        .collect();
    assert_eq!(common_indexes.len(), 32);
    let parts = output["nativeRuleParts"]
        .as_array()
        .expect("legacy OR outcomes must reference shared literal source postings");
    assert_eq!(
        parts
            .iter()
            .filter(|part| part["blockIndexes"] == serde_json::json!(common_indexes))
            .count(),
        1
    );
    assert!(
        parts
            .iter()
            .map(|part| part["blockIndexes"].as_array().unwrap().len())
            .sum::<usize>()
            <= 4 * 64,
        "literal source postings cannot store one expanded 33-block union per outcome"
    );
    let mut contents = std::collections::BTreeSet::new();
    for part in parts {
        let indexes: Vec<_> = part["blockIndexes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|index| index.as_u64().unwrap())
            .collect();
        assert!(!indexes.is_empty() && indexes.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(indexes.iter().all(|index| *index < blocks.len() as u64));
        assert!(
            contents.insert(indexes),
            "equal literal parts must be interned once"
        );
        assert!(part.get("ruleIds").is_none());
    }
    let sets = output["nativeRuleSets"].as_array().unwrap();
    assert_eq!(sets.len(), 32);
    for (index, row) in rows.iter().enumerate() {
        assert_eq!(
            row["transactionId"],
            format!("legacy-posting-tx-{index:03}")
        );
        let actual = source_posting_rule_ids(
            &output,
            &sets[row["ruleSetIndex"].as_u64().unwrap() as usize],
        );
        let mut expected: Vec<_> = (0..32)
            .map(|rule| format!("posting-or-{rule:03}"))
            .collect();
        expected.push(format!("posting-private-{:03}", index % 32));
        assert_eq!(
            actual, expected,
            "OR overlap cannot duplicate or lose any complete source ID"
        );
    }
    let wire = serde_json::to_string(&output).unwrap();
    for rule in &rules {
        assert_eq!(wire.matches(&format!("\"{}\"", rule.id)).count(), 1);
    }
    transactions.reverse();
    rules.reverse();
    let reordered = serde_json::to_value(analyze_with_rules(
        &transactions,
        &categories,
        &[],
        &rules,
        &InclusionScope::new(true, true),
    ))
    .unwrap();
    for field in [
        "nativeRuleBlocks",
        "nativeRuleParts",
        "nativeRuleSets",
        "deterministicClassifications",
    ] {
        assert_eq!(
            reordered[field], output[field],
            "legacy posting {field} must survive source ordering"
        );
    }
}

#[test]
fn matcher_or_postings_do_not_retain_expanded_common_membership_per_outcome() {
    let rules = source_posting_rules("or");
    let categories = [sample_category("food", "Food", false)];
    let categories = std::collections::HashMap::from([("food", &categories[0])]);
    let index =
        crate::categorization::CategoryRuleIndex::new(&rules, &categories, str::to_lowercase);
    let mut cache = crate::categorization::RuleMatchCache::default();
    for payee in 0..32 {
        let payee = format!("posting-payee-{payee:03}");
        for _ in 0..5 {
            let matching = index.cached_matches(
                [
                    Some(payee.as_str()),
                    None,
                    Some("fd-account-checking"),
                    None,
                ],
                &mut cache,
            );
            assert_eq!(matching.category, Some("food"));
            assert_eq!(
                matching.rule_count, 33,
                "account/payee OR overlap is counted once"
            );
            assert!(!matching.conflict);
        }
    }
    assert!(cache.retained_membership_entries() <= 64 * 4 + 32 * 40,
        "fixed source postings and constant-size descriptor cache must replace expanded unions; retained {} entries",
        cache.retained_membership_entries());
}

#[test]
fn analysis_and_matcher_route_selective_payee_instead_of_unioning_shared_account_posting() {
    let transactions = source_posting_transactions();
    let rules = source_posting_rules("and");
    let categories = [sample_category("food", "Food", false)];
    let output = serde_json::to_value(analyze_with_rules(
        &transactions,
        &categories,
        &[],
        &rules,
        &InclusionScope::new(true, true),
    ))
    .unwrap();
    let rows = output["deterministicClassifications"].as_array().unwrap();
    assert_eq!(rows.len(), 160);
    assert!(rows
        .iter()
        .all(|row| row["proposedCategoryId"] == "food" && row.get("ruleIds").is_none()));
    let categories = std::collections::HashMap::from([("food", &categories[0])]);
    let index =
        crate::categorization::CategoryRuleIndex::new(&rules, &categories, str::to_lowercase);
    let mut cache = crate::categorization::RuleMatchCache::default();
    for payee in 0..32 {
        let payee = format!("posting-payee-{payee:03}");
        for _ in 0..5 {
            let matching = index.cached_matches(
                [
                    Some(payee.as_str()),
                    None,
                    Some("fd-account-checking"),
                    None,
                ],
                &mut cache,
            );
            assert_eq!(matching.category, Some("food"));
            assert_eq!(matching.rule_count, 1);
            assert!(!matching.conflict);
        }
    }
    assert!(index.lookup_inspections.get() <= 32 * 8,
        "each AND lookup must route the necessary selective payee posting, not repeatedly visit all account candidates; inspected {} entries",
        index.lookup_inspections.get());
}

#[test]
fn matcher_mixed_category_counts_and_bounded_advice_use_matching_source_routes() {
    let mut rules = source_posting_rules("or");
    for rule in rules
        .iter_mut()
        .filter(|rule| rule.id.starts_with("posting-private-"))
    {
        rule.actions = category_rule_actions("other");
    }
    let categories = [
        sample_category("food", "Food", false),
        sample_category("other", "Other", false),
    ];
    let categories =
        std::collections::HashMap::from([("food", &categories[0]), ("other", &categories[1])]);
    let index =
        crate::categorization::CategoryRuleIndex::new(&rules, &categories, str::to_lowercase);
    let mut cache = crate::categorization::RuleMatchCache::default();
    for payee in 0..32 {
        let payee = format!("posting-payee-{payee:03}");
        let matching = index.cached_matches(
            [
                Some(payee.as_str()),
                None,
                Some("fd-account-checking"),
                None,
            ],
            &mut cache,
        );
        assert!(matching.conflict);
        assert_eq!(matching.rule_count, 33);
        assert!(index.has_category(matching, "food"));
        assert!(index.has_category(matching, "other"));
        assert!(!index.has_category(matching, "unmatched"));
        assert_eq!(index.category_count(matching, "food"), 32);
        assert_eq!(index.category_count(matching, "other"), 1);
        assert_eq!(index.matching_categories(matching, 1), vec!["food"]);
        assert_eq!(
            index.matching_categories(matching, 2),
            vec!["food", "other"]
        );
    }
}

#[test]
fn matcher_postings_preserve_null_empty_unmatched_and_repeated_field_boolean_semantics() {
    let make = |id, operation, conditions| {
        actual_category_rule(
            id,
            false,
            serde_json::json!("post"),
            operation,
            conditions,
            category_rule_actions("food"),
        )
    };
    let rules = [
        make(
            "repeated-and-impossible",
            "and",
            serde_json::json!([
                {"field": "payee", "op": "is", "value": "payee-a"},
                {"field": "payee", "op": "is", "value": "payee-b"}
            ]),
        ),
        make(
            "repeated-and-a",
            "and",
            serde_json::json!([
                {"field": "payee", "op": "is", "value": "payee-a"},
                {"field": "payee", "op": "is", "value": "payee-a"}
            ]),
        ),
        make(
            "repeated-or-ab",
            "or",
            serde_json::json!([
                {"field": "payee", "op": "is", "value": "payee-a"},
                {"field": "payee", "op": "is", "value": "payee-b"}
            ]),
        ),
        make(
            "both-null",
            "and",
            serde_json::json!([
                {"field": "payee", "op": "is", "value": null},
                {"field": "category", "op": "is", "value": null}
            ]),
        ),
    ];
    let categories = [sample_category("food", "Food", false)];
    let category_map = std::collections::HashMap::from([("food", &categories[0])]);
    let index =
        crate::categorization::CategoryRuleIndex::new(&rules, &category_map, str::to_lowercase);
    let mut cache = crate::categorization::RuleMatchCache::default();
    for (payee, category, expected) in [
        (Some("payee-a"), None, 2),
        (Some("payee-b"), None, 1),
        (None, None, 1),
        (Some(""), None, 0),
        (Some("unmatched"), None, 0),
        (None, Some(""), 0),
        (None, Some("unmatched-category"), 0),
    ] {
        let matching = index.cached_matches(
            [payee, None, Some("fd-account-checking"), category],
            &mut cache,
        );
        assert_eq!(
            matching.rule_count, expected,
            "payee={payee:?}, category={category:?}"
        );
        assert_eq!(matching.category, (expected > 0).then_some("food"));
        assert!(!matching.conflict);
    }
    let mut transactions: Vec<_> = [
        Some("payee-a"),
        Some("payee-b"),
        None,
        Some(""),
        Some("unmatched"),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, payee)| {
        let mut tx = canonical_rule_tx(&format!("boolean-tx-{index}"));
        tx.payee_id = payee.map(str::to_owned);
        tx
    })
    .collect();
    let result = serde_json::to_value(analyze_with_rules(
        &transactions,
        &categories,
        &[],
        &rules,
        &InclusionScope::new(true, true),
    ))
    .unwrap();
    assert_eq!(
        result["deterministicClassifications"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    for (transaction, expected) in [
        ("boolean-tx-0", vec!["repeated-and-a", "repeated-or-ab"]),
        ("boolean-tx-1", vec!["repeated-or-ab"]),
        ("boolean-tx-2", vec!["both-null"]),
    ] {
        let row = result["deterministicClassifications"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["transactionId"] == transaction)
            .unwrap();
        let actual = source_posting_rule_ids(
            &result,
            &result["nativeRuleSets"][row["ruleSetIndex"].as_u64().unwrap() as usize],
        );
        assert_eq!(
            actual,
            expected.into_iter().map(str::to_owned).collect::<Vec<_>>()
        );
    }
    transactions.reverse();
    let reordered = serde_json::to_value(analyze_with_rules(
        &transactions,
        &categories,
        &[],
        &rules,
        &InclusionScope::new(true, true),
    ))
    .unwrap();
    for field in [
        "nativeRuleBlocks",
        "nativeRuleParts",
        "nativeRuleSets",
        "deterministicClassifications",
    ] {
        assert_eq!(reordered[field], result[field]);
    }
}

#[test]
fn analysis_legacy_supported_long_rule_id_preserves_existing_source_contract() {
    let id = format!("legacy-{}", "x".repeat(293));
    assert_eq!(id.len(), 300);
    let rules = [actual_category_rule(
        &id,
        false,
        serde_json::json!("post"),
        "and",
        serde_json::json!([{"field": "account", "op": "is", "value": "fd-account-checking"}]),
        category_rule_actions("food"),
    )];
    let categories = [sample_category("food", "Food", false)];
    let result = analyze_with_rules(
        &[canonical_rule_tx("legacy-long-id")],
        &categories,
        &[],
        &rules,
        &InclusionScope::new(true, true),
    );
    let output = serde_json::to_value(result)
        .expect("generic legacy output cannot inherit a new merchant-only ID limit");
    assert_eq!(
        output["deterministicClassifications"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "a supported pre-existing legacy rule ID cannot silently become unsupported"
    );
    assert_eq!(
        output["nativeRuleBlocks"],
        serde_json::json!([{"ruleIds": [id.clone()]}])
    );
    let row = &output["deterministicClassifications"][0];
    assert_eq!(
        source_posting_rule_ids(
            &output,
            &output["nativeRuleSets"][row["ruleSetIndex"].as_u64().unwrap() as usize]
        ),
        vec![id]
    );
}

#[test]
fn analysis_legacy_source_rule_count_above_merchant_cap_preserves_every_id() {
    let rules: Vec<_> = (0..100001).map(|index| actual_category_rule(
        &format!("legacy-count-{index:06}"), false, serde_json::json!("post"), "and",
        serde_json::json!([{"field": "account", "op": "is", "value": "fd-account-checking"}]),
        category_rule_actions("food"),
    )).collect();
    let categories = [sample_category("food", "Food", false)];
    let result = analyze_with_rules(
        &[canonical_rule_tx("legacy-rule-count")],
        &categories,
        &[],
        &rules,
        &InclusionScope::new(true, true),
    );
    let output = serde_json::to_value(result)
        .expect("legacy source admission has no merchant 100k-rule limit");
    assert_eq!(
        output["deterministicClassifications"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let ids = output["nativeRuleBlocks"][0]["ruleIds"].as_array().unwrap();
    assert_eq!(
        ids.len(),
        100001,
        "a complete equivalently compiled legacy block preserves every source ID"
    );
    assert_eq!(ids.first().unwrap(), "legacy-count-000000");
    assert_eq!(ids.last().unwrap(), "legacy-count-100000");
    let row = &output["deterministicClassifications"][0];
    let complete = source_posting_rule_ids(
        &output,
        &output["nativeRuleSets"][row["ruleSetIndex"].as_u64().unwrap() as usize],
    );
    assert_eq!(
        complete,
        rules.iter().map(|rule| rule.id.clone()).collect::<Vec<_>>()
    );
}

#[test]
fn literal_witness_prefers_cheap_or_over_disjoint_and_postings() {
    use crate::merchant_intelligence::{
        native_set_has_witness, MerchantNativeRulePart, MerchantNativeRuleSet,
        NATIVE_WITNESS_VISITS,
    };
    let part = |indexes: Vec<u32>| MerchantNativeRulePart {
        block_indexes: indexes.into(),
    };
    let mut parts = vec![
        part((0..128).collect()),
        part((0..64).collect()),
        part((96..128).collect()),
        part((64..96).collect()),
        part((64..128).collect()),
    ];
    parts.extend((0..64).map(|index| part(vec![index])));
    NATIVE_WITNESS_VISITS.with(|visits| visits.set(0));
    for index in 0..64 {
        let set = MerchantNativeRuleSet {
            or_part_indexes: vec![1, index + 5],
            and_part_indexes: vec![vec![2], vec![4], vec![3], vec![4]],
            category_part_index: 0,
        };
        assert!(native_set_has_witness(&set, &parts));
    }
    let visits = NATIVE_WITNESS_VISITS.with(|visits| visits.get());
    assert!(
        visits <= 64 * 8,
        "OR witness must not repeatedly disprove 32-member disjoint AND postings: {visits}"
    );
}

#[test]
fn literal_witness_prefers_selective_and_when_or_and_category_are_disjoint() {
    use crate::merchant_intelligence::{
        native_set_has_witness, MerchantNativeRulePart, MerchantNativeRuleSet,
        NATIVE_WITNESS_VISITS,
    };
    let part = |indexes: Vec<u32>| MerchantNativeRulePart {
        block_indexes: indexes.into(),
    };
    let mut parts = vec![part((64..128).collect()), part((0..64).collect())];
    parts.extend((64..128).map(|index| part(vec![index])));
    NATIVE_WITNESS_VISITS.with(|visits| visits.set(0));
    for index in 0..64 {
        let set = MerchantNativeRuleSet {
            or_part_indexes: vec![1],
            and_part_indexes: vec![vec![index + 2], vec![0], vec![0], vec![0]],
            category_part_index: 0,
        };
        assert!(native_set_has_witness(&set, &parts));
    }
    let visits = NATIVE_WITNESS_VISITS.with(|visits| visits.get());
    assert!(visits <= 64 * 8, "category-selected AND witness must not repeatedly disprove the unrelated 64-block OR: {visits}");
}

fn broad_bounded_sample_rules(mixed: bool) -> Vec<crate::snapshots::Rule> {
    let mut rules = Vec::new();
    for index in 0..64 {
        let id = match index {
            0 => "sample-a".to_owned(),
            1 => "sample-b".to_owned(),
            _ => format!("sample-c-{index:03}"),
        };
        rules.push(actual_category_rule(&id, false, serde_json::json!("post"), "and",
            serde_json::json!([{"field": "account", "op": "oneOf", "value": ["fd-account-checking", format!("sample-account-{index:03}")]}]),
            category_rule_actions(if mixed && index % 2 == 1 { "other" } else { "food" })));
    }
    rules.push(actual_category_rule("sample-z", false, serde_json::json!("post"), "and",
        serde_json::json!([{"field": "account", "op": "oneOf", "value": ["fd-account-checking", "sample-account-000"]}]),
        category_rule_actions("food")));
    for (id, operation, conditions) in [
        (
            "sample-0-payee",
            "and",
            serde_json::json!([{"field": "payee", "op": "is", "value": "sample-payee"}]),
        ),
        (
            "sample-00-name",
            "and",
            serde_json::json!([{"field": "payee_name", "op": "is", "value": "Sample merchant"}]),
        ),
        (
            "sample-000-or",
            "or",
            serde_json::json!([
            {"field": "account", "op": "is", "value": "fd-account-checking"}, {"field": "payee", "op": "is", "value": "not-this-payee"}]),
        ),
        (
            "sample-aa-conjunction",
            "and",
            serde_json::json!([
            {"field": "account", "op": "is", "value": "fd-account-checking"}, {"field": "payee", "op": "is", "value": "sample-payee"}]),
        ),
    ] {
        rules.push(actual_category_rule(
            id,
            false,
            serde_json::json!("post"),
            operation,
            conditions,
            category_rule_actions("food"),
        ));
    }
    rules
}

#[test]
fn bounded_and_evidence_work_tracks_sample_size_and_preserves_interleaved_multi_id_order() {
    let rules = broad_bounded_sample_rules(false);
    let categories = [sample_category("food", "Food", false)];
    let categories = std::collections::HashMap::from([("food", &categories[0])]);
    let index =
        crate::categorization::CategoryRuleIndex::new(&rules, &categories, str::to_lowercase);
    assert!(
        index
            .blocks
            .windows(2)
            .all(|blocks| blocks[0].rule_ids[0] < blocks[1].rule_ids[0]),
        "frozen posting block order is minimum scalar ID order"
    );
    let mut cache = crate::categorization::RuleMatchCache::default();
    let matching = index.cached_matches(
        [
            Some("sample-payee"),
            Some("sample merchant"),
            Some("fd-account-checking"),
            None,
        ],
        &mut cache,
    );
    assert_eq!(
        matching.rule_count, 69,
        "equivalent two-ID block and OR/AND routes retain exact source weight"
    );
    let expected = [
        "sample-0-payee",
        "sample-00-name",
        "sample-000-or",
        "sample-a",
        "sample-aa-conjunction",
        "sample-b",
    ];
    for cap in [1, 4, 6] {
        index.lookup_inspections.set(0);
        for _ in 0..64 {
            let ids: Vec<_> = index
                .bounded_evidence(matching, cap)
                .into_iter()
                .map(|(block, offset)| index.blocks[block].rule_ids[offset].as_str())
                .collect();
            assert_eq!(
                ids,
                expected[..cap],
                "multi-ID tails cannot terminate sampling before an interleaved smaller ID"
            );
        }
        assert!(index.lookup_inspections.get() <= 64 * (2 * cap + 8),
            "bounded explanations must not rescan every account-oneOf block per row: cap={cap}, visits={}", index.lookup_inspections.get());
    }
}

#[test]
fn bounded_mixed_and_advice_and_category_counts_do_not_rescan_broad_matching_routes() {
    let rules = broad_bounded_sample_rules(true);
    let categories = [
        sample_category("food", "Food", false),
        sample_category("other", "Other", false),
    ];
    let categories =
        std::collections::HashMap::from([("food", &categories[0]), ("other", &categories[1])]);
    let index =
        crate::categorization::CategoryRuleIndex::new(&rules, &categories, str::to_lowercase);
    let mut cache = crate::categorization::RuleMatchCache::default();
    let matching = index.cached_matches(
        [
            Some("sample-payee"),
            Some("sample merchant"),
            Some("fd-account-checking"),
            None,
        ],
        &mut cache,
    );
    assert!(matching.conflict);
    assert_eq!(matching.rule_count, 69);
    index.lookup_inspections.set(0);
    for _ in 0..64 {
        assert_eq!(index.matching_categories(matching, 1), vec!["food"]);
        assert_eq!(index.category_count(matching, "food"), 37);
        assert_eq!(index.category_count(matching, "other"), 32);
    }
    assert!(index.lookup_inspections.get() <= 64 * 24,
        "source-owned weighted category summaries must bound repeated mixed-category advice/count work: {}",
        index.lookup_inspections.get());
}

#[test]
fn producer_large_or_witness_is_not_starved_by_smaller_disjoint_and_domains() {
    use crate::merchant_intelligence::{native_set_has_witness, NATIVE_WITNESS_VISITS};
    let mut rules = Vec::new();
    for index in 0..64 {
        rules.push(actual_category_rule(
            &format!("starve-or-{index:03}"),
            false,
            serde_json::json!("post"),
            "or",
            serde_json::json!([
                {"field": "account", "op": "is", "value": "fd-account-checking"},
                {"field": "category", "op": "is", "value": format!("starve-category-c-{index:03}")}
            ]),
            category_rule_actions("food"),
        ));
    }
    let mut duplicate = rules[0].clone();
    duplicate.id = "starve-or-000-extra".into();
    rules.push(duplicate);
    for index in 0..32 {
        rules.push(actual_category_rule(
            &format!("starve-payee-account-{index:03}"),
            false,
            serde_json::json!("post"),
            "and",
            serde_json::json!([
                {"field": "payee", "op": "is", "value": format!("starve-payee-{index:03}")},
                {"field": "account", "op": "is", "value": "not-current-account"}
            ]),
            category_rule_actions("food"),
        ));
        rules.push(actual_category_rule(&format!("starve-category-only-{index:03}"), false, serde_json::json!("post"), "and",
            serde_json::json!([{"field": "category", "op": "is", "value": format!("starve-category-d-{index:03}")}]),
            category_rule_actions("food")));
    }
    let transactions: Vec<_> = (0..32)
        .map(|index| {
            let mut tx = canonical_rule_tx(&format!("starve-tx-{index:03}"));
            tx.payee_id = Some(format!("starve-payee-{index:03}"));
            tx
        })
        .collect();
    let categories = [sample_category("food", "Food", false)];
    let result = analyze_with_rules(
        &transactions,
        &categories,
        &[],
        &rules,
        &InclusionScope::new(true, true),
    );
    assert_eq!(result.deterministic_classifications.len(), 32);
    assert_eq!(
        result.native_rule_sets.len(),
        32,
        "payee buckets retain distinct valid source expressions"
    );
    let output = serde_json::to_value(&result).unwrap();
    let mut expected: Vec<_> = (0..64)
        .map(|index| format!("starve-or-{index:03}"))
        .collect();
    expected.push("starve-or-000-extra".into());
    expected.sort_unstable();
    NATIVE_WITNESS_VISITS.with(|visits| visits.set(0));
    for (index, set) in result.native_rule_sets.iter().enumerate() {
        assert!(native_set_has_witness(set, &result.native_rule_parts));
        assert_eq!(source_posting_rule_ids(&output, &output["nativeRuleSets"][index]), expected,
            "all 65 weighted OR IDs survive although no AND predicate matches current account/category facts");
    }
    let visits = NATIVE_WITNESS_VISITS.with(|visits| visits.get());
    assert!(visits <= 32 * 8,
        "a smaller empty AND domain cannot starve an immediately available broad OR witness: {visits}");
}

#[test]
fn literal_witness_keeps_later_or_candidates_fair_after_initial_probes_fail() {
    use crate::merchant_intelligence::{
        native_set_has_witness, MerchantNativeRulePart, MerchantNativeRuleSet,
        NATIVE_WITNESS_VISITS,
    };
    let part = |indexes: Vec<u32>| MerchantNativeRulePart {
        block_indexes: indexes.into(),
    };
    let mut category = vec![2, 63];
    category.extend(64..128);
    let mut parts = vec![
        part(category),
        part((0..64).collect()),
        part((96..128).collect()),
        part((64..96).collect()),
        part((64..128).collect()),
    ];
    parts.extend((64..96).map(|index| part(vec![index])));
    let output = serde_json::json!({
        "nativeRuleParts": parts,
        "nativeRuleBlocks": (0..128).map(|index| serde_json::json!({"ruleIds": [format!("future-{index:03}")]})).collect::<Vec<_>>()
    });
    NATIVE_WITNESS_VISITS.with(|visits| visits.set(0));
    for index in 0..32 {
        let set = MerchantNativeRuleSet {
            or_part_indexes: vec![1],
            and_part_indexes: vec![vec![2, index + 5], vec![4], vec![2], vec![3]],
            category_part_index: 0,
        };
        assert!(native_set_has_witness(&set, &parts));
        assert_eq!(
            source_posting_rule_ids(&output, &serde_json::to_value(set).unwrap()),
            vec!["future-002".to_owned(), "future-063".to_owned()]
        );
    }
    let visits = NATIVE_WITNESS_VISITS.with(|visits| visits.get());
    assert!(visits <= 32 * 8,
        "after both first probes fail, future OR candidates must still advance before exhausting empty AND: {visits}");
}
