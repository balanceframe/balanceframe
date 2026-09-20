use super::*;

fn default_policy() -> PurchasePolicy {
    PurchasePolicy::default()
}

fn default_data_policy() -> DecisionDataPolicy {
    DecisionDataPolicy::default()
}

fn usd(units: i64) -> Money {
    Money::new(units, "USD")
}

// ======================================================================
// 1. Approved outcomes
// ======================================================================

#[test]
fn test_approved_within_budget_no_policy() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
    assert!(outcome.reason_codes.contains(&"within_budget".to_string()));
    assert!(outcome.data_blockers.is_empty());
}

#[test]
fn test_approved_reimbursement_always_approved() {
    let outcome = evaluate_purchase(
        &usd(50000),
        &usd(10000),
        &usd(5000),
        Some(&usd(1000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Reimbursement,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
    assert!(outcome
        .reason_codes
        .contains(&"reimbursement_expected".to_string()));
}

#[test]
fn test_approved_donor_covers_category_deficit() {
    let outcome = evaluate_purchase(
        &usd(8000),
        &usd(5000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        Some(&usd(20000)),
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
    assert!(outcome.reason_codes.contains(&"donor_covered".to_string()));
}

#[test]
fn test_approved_rollover_applied() {
    let outcome = evaluate_purchase(
        &usd(8000),
        &usd(5000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        Some(&usd(5000)),
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
    assert!(outcome
        .reason_codes
        .contains(&"rollover_applied".to_string()));
    assert!(outcome.reason_codes.contains(&"within_budget".to_string()));
}

#[test]
fn test_approved_exact_budget() {
    let outcome = evaluate_purchase(
        &usd(5000),
        &usd(10000),
        &usd(5000),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
    assert!(outcome.reason_codes.contains(&"within_budget".to_string()));
}

// ======================================================================
// 2. Declined outcomes
// ======================================================================

#[test]
fn test_declined_protected_account_below_minimum() {
    let outcome = evaluate_purchase(
        &usd(1000),
        &usd(10000),
        &usd(0),
        Some(&usd(8000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &PurchasePolicy::new(usd(10000), usd(0)),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        true,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Declined);
    assert!(outcome
        .reason_codes
        .contains(&"exceeds_protected_balance".to_string()));
}

#[test]
fn test_declined_insufficient_minimum_balance() {
    let outcome = evaluate_purchase(
        &usd(19000),
        &usd(20000),
        &usd(0),
        Some(&usd(20000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &PurchasePolicy::new(usd(10000), usd(5000)),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Declined);
    assert!(outcome
        .reason_codes
        .contains(&"insufficient_minimum_balance".to_string()));
}

#[test]
fn test_declined_protected_purchase_breaches_minimum() {
    let outcome = evaluate_purchase(
        &usd(15000),
        &usd(20000),
        &usd(0),
        Some(&usd(20000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &PurchasePolicy::new(usd(10000), usd(0)),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        true,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Declined);
    assert!(outcome
        .reason_codes
        .contains(&"exceeds_protected_balance".to_string()));
}

// ======================================================================
// 3. FlaggedForReview outcomes
// ======================================================================

#[test]
fn test_flagged_exceeds_category_budget() {
    let outcome = evaluate_purchase(
        &usd(6000),
        &usd(5000),
        &usd(5000),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::FlaggedForReview);
    assert!(outcome
        .reason_codes
        .contains(&"exceeds_category_budget".to_string()));
}

#[test]
fn test_flagged_buffer_consumed_still_above_minimum() {
    let outcome = evaluate_purchase(
        &usd(6000),
        &usd(20000),
        &usd(0),
        Some(&usd(20000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &PurchasePolicy::new(usd(10000), usd(5000)),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::FlaggedForReview);
    assert!(outcome.reason_codes.contains(&"exceeds_buffer".to_string()));
}

#[test]
fn test_flagged_no_account_balance() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        None,
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::FlaggedForReview);
}

// ======================================================================
// 4. InsufficientData outcomes
// ======================================================================

#[test]
fn test_insufficient_data_uncategorized_block() {
    let mut data_policy = default_data_policy();
    data_policy.uncategorized_mode = UncategorizedMode::Block;

    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(5000),
        &usd(0),
        &default_policy(),
        &data_policy,
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::InsufficientData);
    assert!(outcome
        .reason_codes
        .contains(&"uncategorized_exposure".to_string()));
}

#[test]
fn test_insufficient_data_stale_snapshot_no_balance() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        None,
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        true,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::InsufficientData);
    assert!(outcome.reason_codes.contains(&"stale_snapshot".to_string()));
}

// ======================================================================
// 5. Transaction semantics
// ======================================================================

#[test]
fn test_semantic_split_applied() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Split,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert!(outcome.reason_codes.contains(&"split_applied".to_string()));
}

#[test]
fn test_semantic_transfer_pair() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Transfer,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert!(outcome.reason_codes.contains(&"transfer_pair".to_string()));
}

#[test]
fn test_semantic_scheduled_payment() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Payment,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert!(outcome
        .reason_codes
        .contains(&"scheduled_payment".to_string()));
}

// ======================================================================
// 6. Data quality flags on otherwise approved
// ======================================================================

#[test]
fn test_pending_exposure_flag_approved() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(3000),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert!(outcome
        .reason_codes
        .contains(&"pending_exposure".to_string()));
    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
}

#[test]
fn test_uncategorized_exposure_flag_approved() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(5000),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    assert!(outcome
        .reason_codes
        .contains(&"uncategorized_exposure".to_string()));
    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
}

#[test]
fn test_stale_snapshot_blocker_emitted() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        true,
        false,
    )
    .unwrap();

    assert!(outcome.reason_codes.contains(&"stale_snapshot".to_string()));
    assert!(!outcome.data_blockers.is_empty());
    assert_eq!(outcome.data_blockers[0].code, "stale_snapshot");
}

// ======================================================================
// 7. PurchasePolicy defaults and edge cases
// ======================================================================

#[test]
fn test_policy_total_reservation() {
    let p = PurchasePolicy::new(usd(10000), usd(5000));
    assert_eq!(p.total_reservation().unwrap(), usd(15000));
}

#[test]
fn test_zero_amount_approved() {
    let outcome = evaluate_purchase(
        &usd(0),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();
    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
}

#[test]
fn test_zero_budget_zero_spent_approved() {
    let outcome = evaluate_purchase(
        &usd(0),
        &usd(0),
        &usd(0),
        Some(&usd(0)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();
    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
}

// ======================================================================
// 8. Error cases
// ======================================================================

#[test]
fn test_currency_mismatch_amount_vs_budget() {
    let result = evaluate_purchase(
        &Money::new(2000, "USD"),
        &Money::new(10000, "EUR"),
        &Money::new(0, "USD"),
        Some(&Money::new(50000, "USD")),
        &Money::zero("USD"),
        &Money::zero("USD"),
        &Money::zero("USD"),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    );
    assert!(result.is_err());
    assert!(matches!(result, Err(MoneyError::CurrencyMismatch(_, _))));
}

#[test]
fn test_currency_mismatch_account_balance() {
    let result = evaluate_purchase(
        &Money::new(2000, "USD"),
        &Money::new(10000, "USD"),
        &Money::new(0, "USD"),
        Some(&Money::new(50000, "EUR")),
        &Money::zero("USD"),
        &Money::zero("USD"),
        &Money::zero("USD"),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    );
    assert!(result.is_err());
}

// ======================================================================
// 10. JSON serialization
// ======================================================================

#[test]
fn test_purchase_outcome_roundtrip() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();

    let json = serde_json::to_string(&outcome).unwrap();
    let back: PurchaseOutcome = serde_json::from_str(&json).unwrap();
    assert_eq!(outcome, back);
}

#[test]
fn test_outcome_label_is_advice() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();
    assert_eq!(outcome.label, FinancialStateLabel::Advice);
}

#[test]
fn test_stale_data_with_balance_still_evaluable() {
    let outcome = evaluate_purchase(
        &usd(2000),
        &usd(10000),
        &usd(0),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        true,
        false,
    )
    .unwrap();

    assert_ne!(outcome.outcome, PurchaseOutcomeKind::InsufficientData);
    assert!(outcome.reason_codes.contains(&"stale_snapshot".to_string()));
}

#[test]
fn test_donor_insufficient_to_cover_deficit() {
    let outcome = evaluate_purchase(
        &usd(12000),
        &usd(10000),
        &usd(1000),
        Some(&usd(50000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        Some(&usd(2000)),
        false,
        false,
        false,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::FlaggedForReview);
    assert!(outcome
        .reason_codes
        .contains(&"exceeds_category_budget".to_string()));
    assert!(!outcome.reason_codes.contains(&"donor_covered".to_string()));
}

#[test]
fn stale_bank_sync_with_cached_balance_is_insufficient_data() {
    let outcome = evaluate_purchase(
        &usd(1000),
        &usd(10000),
        &usd(0),
        Some(&usd(100000)),
        &usd(0),
        &usd(0),
        &usd(0),
        &default_policy(),
        &default_data_policy(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        true,
    )
    .unwrap();

    assert_eq!(outcome.outcome, PurchaseOutcomeKind::InsufficientData);
    assert!(outcome
        .reason_codes
        .contains(&"stale_bank_sync".to_string()));
}
