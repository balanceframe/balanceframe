use balanceframe_financial_core::*;

fn usd(amount: i64) -> Money {
    Money::new(amount, "USD")
}

fn purchase(
    amount: i64,
    balance: i64,
    policy: &PurchasePolicy,
    donor: Option<i64>,
    protected: bool,
) -> PurchaseOutcome {
    let donor = donor.map(usd);
    evaluate_purchase(
        &usd(amount),
        &usd(1000),
        &usd(0),
        Some(&usd(balance)),
        &usd(0),
        &usd(0),
        &usd(0),
        policy,
        &DecisionDataPolicy::default(),
        TransactionSemantic::Card,
        None,
        donor.as_ref(),
        protected,
        false,
        false,
    )
    .unwrap()
}

#[test]
fn donor_must_cover_the_entire_protected_minimum_deficit_and_cannot_override_an_existing_breach() {
    let policy = PurchasePolicy::new(usd(100), usd(0));
    let insufficient = purchase(100, 150, &policy, Some(49), true);
    let exact = purchase(100, 150, &policy, Some(50), true);
    assert_eq!(insufficient.outcome, PurchaseOutcomeKind::Declined);
    assert!(insufficient
        .reason_codes
        .iter()
        .any(|code| code == "exceeds_protected_balance"));
    assert_eq!(exact.outcome, PurchaseOutcomeKind::Approved);
    assert!(exact
        .reason_codes
        .iter()
        .any(|code| code == "donor_covered"));
    assert_eq!(
        purchase(1, 99, &policy, Some(10000), true).outcome,
        PurchaseOutcomeKind::Declined
    );
}

#[test]
fn donor_must_restore_the_full_buffer_before_a_buffer_only_purchase_can_be_approved() {
    let policy = PurchasePolicy::new(usd(100), usd(50));
    let insufficient = purchase(100, 200, &policy, Some(49), false);
    let exact = purchase(100, 200, &policy, Some(50), false);
    assert_eq!(insufficient.outcome, PurchaseOutcomeKind::FlaggedForReview);
    assert!(insufficient
        .reason_codes
        .iter()
        .any(|code| code == "exceeds_buffer"));
    assert_eq!(exact.outcome, PurchaseOutcomeKind::Approved);
    assert!(exact
        .reason_codes
        .iter()
        .any(|code| code == "donor_covered"));
}

#[test]
fn purchase_evidence_projects_requested_amount_after_reserved_outflows() {
    let outcome = evaluate_purchase(
        &usd(200),
        &usd(500),
        &usd(50),
        Some(&usd(1000)),
        &usd(10),
        &usd(20),
        &usd(30),
        &PurchasePolicy::new(usd(100), usd(50)),
        &DecisionDataPolicy::default(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();
    assert_eq!(outcome.outcome, PurchaseOutcomeKind::Approved);
    assert_eq!(outcome.evidence.available_balance, Some(usd(940)));
    assert_eq!(outcome.evidence.projected_balance, Some(usd(740)));
    assert_eq!(outcome.evidence.buffer_remaining, Some(usd(640)));
    assert_eq!(outcome.evidence.category_remaining, usd(450));
}

#[test]
fn purchase_evidence_does_not_hide_projection_overflow_on_early_reimbursement() {
    let result = evaluate_purchase(
        &usd(i64::MAX),
        &usd(0),
        &usd(0),
        Some(&usd(i64::MIN)),
        &usd(0),
        &usd(0),
        &usd(0),
        &PurchasePolicy::default(),
        &DecisionDataPolicy::default(),
        TransactionSemantic::Reimbursement,
        None,
        None,
        false,
        false,
        false,
    );
    assert_eq!(result, Err(MoneyError::Overflow));
}

#[test]
fn purchase_evidence_does_not_hide_policy_currency_mismatch_on_reimbursement() {
    let policy = PurchasePolicy::new(Money::new(1, "EUR"), Money::zero("EUR"));
    let result = evaluate_purchase(
        &usd(1),
        &usd(10),
        &usd(0),
        Some(&usd(100)),
        &usd(0),
        &usd(0),
        &usd(0),
        &policy,
        &DecisionDataPolicy::default(),
        TransactionSemantic::Reimbursement,
        None,
        None,
        false,
        false,
        false,
    );
    assert_eq!(
        result,
        Err(MoneyError::CurrencyMismatch("USD".into(), "EUR".into()))
    );
}

#[test]
fn excluded_exposure_classes_restore_cash_without_leaving_reservation_reason_codes() {
    let included = evaluate_purchase(
        &usd(50),
        &usd(1000),
        &usd(0),
        Some(&usd(1000)),
        &usd(10),
        &usd(20),
        &usd(30),
        &PurchasePolicy::default(),
        &DecisionDataPolicy::default(),
        TransactionSemantic::Transfer,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();
    let policy = DecisionDataPolicy {
        pending_mode: PendingMode::Exclude,
        uncategorized_mode: UncategorizedMode::Ignore,
        uncleared_mode: UnclearedMode::Exclude,
        ..DecisionDataPolicy::default()
    };
    let excluded = evaluate_purchase(
        &usd(50),
        &usd(1000),
        &usd(0),
        Some(&usd(1000)),
        &usd(10),
        &usd(20),
        &usd(30),
        &PurchasePolicy::default(),
        &policy,
        TransactionSemantic::Transfer,
        None,
        None,
        false,
        false,
        false,
    )
    .unwrap();
    assert_eq!(included.evidence.available_balance, Some(usd(940)));
    assert_eq!(excluded.evidence.available_balance, Some(usd(1000)));
    assert!(included
        .reason_codes
        .iter()
        .any(|code| code == "pending_exposure"));
    assert!(included
        .reason_codes
        .iter()
        .any(|code| code == "uncategorized_exposure"));
    assert!(!excluded
        .reason_codes
        .iter()
        .any(|code| code == "pending_exposure" || code == "uncategorized_exposure"));
    assert!(excluded
        .reason_codes
        .iter()
        .any(|code| code == "transfer_pair"));
}

#[test]
fn monetary_exposures_rollover_and_donors_never_cross_currency_even_when_optional_zero() {
    let exposure = Money::new(1, "EUR");
    let foreign_zero = Money::zero("EUR");
    let zero = usd(0);
    for (pending, rollover, donor) in [
        (&exposure, None, None),
        (&zero, Some(&foreign_zero), None),
        (&zero, None, Some(&foreign_zero)),
    ] {
        let result = evaluate_purchase(
            &usd(1),
            &usd(10),
            &usd(0),
            Some(&usd(100)),
            pending,
            &usd(0),
            &usd(0),
            &PurchasePolicy::default(),
            &DecisionDataPolicy::default(),
            TransactionSemantic::Card,
            rollover,
            donor,
            false,
            false,
            false,
        );
        assert_eq!(
            result,
            Err(MoneyError::CurrencyMismatch("USD".into(), "EUR".into()))
        );
    }
}

#[test]
fn purchase_policy_rejects_foreign_buffer_on_reimbursement() {
    let policy = PurchasePolicy::new(usd(0), Money::new(1, "EUR"));
    let result = evaluate_purchase(
        &usd(1),
        &usd(10),
        &usd(0),
        Some(&usd(100)),
        &usd(0),
        &usd(0),
        &usd(0),
        &policy,
        &DecisionDataPolicy::default(),
        TransactionSemantic::Reimbursement,
        None,
        None,
        false,
        false,
        false,
    );
    assert_eq!(
        result,
        Err(MoneyError::CurrencyMismatch("USD".into(), "EUR".into()))
    );
}

#[test]
fn purchase_policy_rejects_foreign_minimum_or_buffer_without_account_evidence() {
    for policy in [
        PurchasePolicy::new(Money::new(1, "EUR"), usd(0)),
        PurchasePolicy::new(usd(0), Money::new(1, "EUR")),
    ] {
        for (semantic, stale_snapshot, stale_sync, uncategorized) in [
            (TransactionSemantic::Reimbursement, false, false, 0),
            (TransactionSemantic::Card, true, false, 0),
            (TransactionSemantic::Card, false, true, 0),
            (TransactionSemantic::Card, false, false, 1),
            (TransactionSemantic::Card, false, false, 0),
        ] {
            let data_policy = DecisionDataPolicy {
                uncategorized_mode: UncategorizedMode::Block,
                ..DecisionDataPolicy::default()
            };
            let result = evaluate_purchase(
                &usd(1),
                &usd(10),
                &usd(0),
                None,
                &usd(0),
                &usd(uncategorized),
                &usd(0),
                &policy,
                &data_policy,
                semantic,
                None,
                None,
                false,
                stale_snapshot,
                stale_sync,
            );
            assert_eq!(
                result,
                Err(MoneyError::CurrencyMismatch("USD".into(), "EUR".into())),
                "{policy:?} {semantic:?} {stale_snapshot} {stale_sync} {uncategorized}"
            );
        }
    }
}

#[test]
fn persisted_purchase_reason_codes_preserve_their_stable_machine_meanings() {
    use PurchaseReasonCode::*;
    let (wire_codes, expected): (Vec<_>, Vec<_>) = [
        ("within_budget", WithinBudget),
        ("within_buffer", WithinBuffer),
        ("donor_covered", DonorCovered),
        ("rollover_applied", RolloverApplied),
        ("reimbursement_expected", ReimbursementExpected),
        ("stale_snapshot", StaleSnapshot),
        ("stale_bank_sync", StaleBankSync),
        ("pending_exposure", PendingExposure),
        ("uncategorized_exposure", UncategorizedExposure),
        ("exceeds_category_budget", ExceedsCategoryBudget),
        ("exceeds_available_balance", ExceedsAvailableBalance),
        ("exceeds_buffer", ExceedsBuffer),
        ("exceeds_protected_balance", ExceedsProtectedBalance),
        ("insufficient_minimum_balance", InsufficientMinimumBalance),
        ("account_excluded_by_policy", AccountExcludedByPolicy),
        ("category_excluded", CategoryExcluded),
        ("split_applied", SplitApplied),
        ("transfer_pair", TransferPair),
        ("scheduled_payment", ScheduledPayment),
    ]
    .into_iter()
    .unzip();
    let persisted = serde_json::to_value(wire_codes).unwrap();
    let restored: Vec<PurchaseReasonCode> = serde_json::from_value(persisted.clone()).unwrap();
    assert_eq!(restored, expected);
    assert_eq!(serde_json::to_value(restored).unwrap(), persisted);
}

#[test]
fn outcome_labels_and_structured_values_are_not_accepted_as_machine_reason_codes() {
    for invalid in [
        serde_json::json!("approved"),
        serde_json::json!({"reason": "within_budget"}),
    ] {
        assert!(serde_json::from_value::<PurchaseReasonCode>(invalid).is_err());
    }
}

#[test]
fn missing_or_stale_data_does_not_mask_unrepresentable_category_evidence() {
    for (stale_snapshot, stale_sync, uncategorized) in
        [(true, false, 0), (false, true, 0), (false, false, 1)]
    {
        let data_policy = DecisionDataPolicy {
            uncategorized_mode: UncategorizedMode::Block,
            ..DecisionDataPolicy::default()
        };
        let result = evaluate_purchase(
            &usd(1),
            &usd(i64::MIN),
            &usd(1),
            None,
            &usd(0),
            &usd(uncategorized),
            &usd(0),
            &PurchasePolicy::default(),
            &data_policy,
            TransactionSemantic::Card,
            None,
            None,
            false,
            stale_snapshot,
            stale_sync,
        );
        assert_eq!(result, Err(MoneyError::Overflow));
    }
}

#[test]
fn pending_reservation_overflow_is_not_converted_to_cash_or_a_stale_data_result() {
    for stale_sync in [false, true] {
        let result = evaluate_purchase(
            &usd(1),
            &usd(100),
            &usd(0),
            Some(&usd(i64::MIN)),
            &usd(1),
            &usd(0),
            &usd(0),
            &PurchasePolicy::default(),
            &DecisionDataPolicy::default(),
            TransactionSemantic::Card,
            None,
            None,
            false,
            false,
            stale_sync,
        );
        assert_eq!(result, Err(MoneyError::Overflow));
    }
}

#[test]
fn rollover_cannot_overflow_category_funding_even_for_reimbursable_purchases() {
    let result = evaluate_purchase(
        &usd(1),
        &usd(i64::MAX),
        &usd(0),
        Some(&usd(i64::MAX)),
        &usd(0),
        &usd(0),
        &usd(0),
        &PurchasePolicy::default(),
        &DecisionDataPolicy::default(),
        TransactionSemantic::Reimbursement,
        Some(&usd(1)),
        None,
        false,
        false,
        false,
    );
    assert_eq!(result, Err(MoneyError::Overflow));
}

#[test]
fn minimum_and_buffer_reservations_cannot_wrap_into_an_approvable_floor() {
    let result = evaluate_purchase(
        &usd(1),
        &usd(i64::MAX),
        &usd(0),
        Some(&usd(i64::MAX)),
        &usd(0),
        &usd(0),
        &usd(0),
        &PurchasePolicy::new(usd(i64::MAX), usd(1)),
        &DecisionDataPolicy::default(),
        TransactionSemantic::Card,
        None,
        None,
        false,
        false,
        false,
    );
    assert_eq!(result, Err(MoneyError::Overflow));
}

#[test]
fn breached_protected_accounts_do_not_hide_overflow_in_remaining_reserve_evidence() {
    let result = evaluate_purchase(
        &usd(1),
        &usd(100),
        &usd(0),
        Some(&usd(i64::MIN + 1)),
        &usd(0),
        &usd(0),
        &usd(0),
        &PurchasePolicy::new(usd(i64::MAX), usd(0)),
        &DecisionDataPolicy::default(),
        TransactionSemantic::Card,
        None,
        None,
        true,
        false,
        false,
    );
    assert_eq!(result, Err(MoneyError::Overflow));
}

#[test]
fn donor_cannot_cover_an_unrepresentable_category_deficit() {
    let result = evaluate_purchase(
        &usd(1),
        &usd(i64::MIN),
        &usd(0),
        Some(&usd(i64::MAX)),
        &usd(0),
        &usd(0),
        &usd(0),
        &PurchasePolicy::default(),
        &DecisionDataPolicy::default(),
        TransactionSemantic::Card,
        None,
        Some(&usd(i64::MAX)),
        false,
        false,
        false,
    );
    assert_eq!(result, Err(MoneyError::Overflow));
}

#[test]
fn zero_rollover_is_neutral_and_does_not_fund_an_unbudgeted_purchase() {
    let evaluate = |rollover| {
        evaluate_purchase(
            &usd(10),
            &usd(0),
            &usd(0),
            Some(&usd(100)),
            &usd(0),
            &usd(0),
            &usd(0),
            &PurchasePolicy::default(),
            &DecisionDataPolicy::default(),
            TransactionSemantic::Rollover,
            rollover,
            None,
            false,
            false,
            false,
        )
        .unwrap()
    };
    let no_rollover = evaluate(None);
    let zero_rollover = evaluate(Some(&usd(0)));
    assert_eq!(zero_rollover.outcome, PurchaseOutcomeKind::FlaggedForReview);
    assert_eq!(zero_rollover.evidence.projected_balance, Some(usd(90)));
    assert_eq!(zero_rollover, no_rollover);
    assert!(!zero_rollover
        .reason_codes
        .iter()
        .any(|code| code == "rollover_applied"));
}

#[test]
fn a_purchase_leaving_the_exact_protected_floor_needs_no_donor_or_buffer_override() {
    let result = purchase(50, 150, &PurchasePolicy::new(usd(100), usd(0)), None, true);
    assert_eq!(result.outcome, PurchaseOutcomeKind::Approved);
    assert_eq!(result.evidence.projected_balance, Some(usd(100)));
    assert_eq!(result.evidence.buffer_remaining, Some(usd(0)));
    assert!(!result
        .reason_codes
        .iter()
        .any(|code| code == "exceeds_protected_balance" || code == "donor_covered"));
}
