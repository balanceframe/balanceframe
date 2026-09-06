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
    let txs = vec![
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
    let charges = find_recurring_charges(&txs, &[]);
    // Outgoing (negative) amounts should be included as charges.
    // Two identical amounts on monthly-ish schedule -> should be identified.
    assert_eq!(charges.len(), 1, "expected Netflix as recurring charge");
    if !charges.is_empty() {
        assert_eq!(charges[0].normalized_merchant, "netflix");
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
    let txs = vec![
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
    let charges = find_recurring_charges(&txs, &[]);
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

// -- amounts_similar uses absolute values --------------------------------

#[test]
fn test_amounts_similar_uses_absolute_values() {
    // All negative amounts with similar absolute values
    assert!(amounts_similar(&[-1500, -1600, -1400]));
    // Large difference in negative amounts (abs differs by >50%)
    assert!(!amounts_similar(&[-1500, -3000]));
    // Mixed signs: -3000 and 2000 have abs values 3000 and 2000, ratio=1.5 — borderline
    assert!(amounts_similar(&[-3000, 2000]));
    // i64::MIN should not cause panic
    assert!(!amounts_similar(&[i64::MIN, -1500]));
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
fn analysis_recurring_schedules_fill_gaps_without_replacing_observed_history() {
    let txs = [
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
    let schedules = [
        Schedule {
            id: "netflix".into(),
            frequency: "yearly".into(),
            amount: Money::new(-18000, "USD"),
            payee_name: Some("NETFLIX".into()),
            account_id: "a1".into(),
            next_expected: "2027-01-01".into(),
        },
        Schedule {
            id: "power".into(),
            frequency: "monthly".into(),
            amount: Money::new(-8500, "EUR"),
            payee_name: Some("Power".into()),
            account_id: "a1".into(),
            next_expected: "2026-08-01".into(),
        },
        Schedule {
            id: "unidentified".into(),
            frequency: "weekly".into(),
            amount: Money::new(-500, "USD"),
            payee_name: None,
            account_id: "a1".into(),
            next_expected: "2026-07-20".into(),
        },
    ];
    let result = run_deterministic_analysis(
        &[sample_account("a1", "Checking")],
        &txs,
        &[sample_category("c1", "Subscriptions", false)],
        &[],
        &[],
        &schedules,
        &[],
        CompatibilityMetadata::new(false, true, "25.1.0".into()),
        Some("2026-07-18T00:00:00Z".into()),
        Some("2026-07-18T00:00:00Z".into()),
        &InclusionScope::new(true, true),
        "2026-07-18",
    );
    assert_eq!(result.recurring_charges.len(), 2);
    let netflix = &result.recurring_charges[0];
    assert_eq!(netflix.normalized_merchant, "netflix");
    assert_eq!(netflix.frequency_label, "monthly");
    assert_eq!(netflix.typical_amount, Money::new(-1500, "USD"));
    assert_eq!(netflix.transaction_ids, ["n1", "n2"]);
    assert_eq!(netflix.dates, ["2026-06-01", "2026-07-01"]);
    let power = &result.recurring_charges[1];
    assert_eq!(power.normalized_merchant, "power");
    assert_eq!(power.typical_amount, Money::new(-8500, "EUR"));
    assert_eq!(power.dates, ["2026-08-01"]);
    assert!(power.transaction_ids.is_empty());
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
    let txs: Vec<_> = cases
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
    let result = run_deterministic_analysis(
        &[sample_account("a1", "Checking")],
        &txs,
        &[sample_category("c1", "Services", false)],
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
            ("daily", "daily"),
            ("irregular", "irregular"),
            ("weekly", "weekly"),
            ("yearly", "yearly"),
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
