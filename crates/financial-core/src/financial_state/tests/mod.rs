use super::*;

// -- FinancialStateLabel -----------------------------------------------

#[test]
fn test_label_serialization_camelcase() {
    assert_eq!(
        serde_json::to_string(&FinancialStateLabel::LedgerFact).unwrap(),
        r#""ledgerFact""#,
    );
    assert_eq!(
        serde_json::to_string(&FinancialStateLabel::EnvelopeAvailability).unwrap(),
        r#""envelopeAvailability""#,
    );
    assert_eq!(
        serde_json::to_string(&FinancialStateLabel::CashFlowProjection).unwrap(),
        r#""cashFlowProjection""#,
    );
    assert_eq!(
        serde_json::to_string(&FinancialStateLabel::Advice).unwrap(),
        r#""advice""#,
    );
    assert_eq!(
        serde_json::to_string(&FinancialStateLabel::Proposal).unwrap(),
        r#""proposal""#,
    );
    assert_eq!(
        serde_json::to_string(&FinancialStateLabel::ExecutionResult).unwrap(),
        r#""executionResult""#,
    );
    assert_eq!(
        serde_json::to_string(&FinancialStateLabel::PurchaseOutcome).unwrap(),
        r#""purchaseOutcome""#,
    );
}

#[test]
fn test_label_roundtrip() {
    let labels = [
        FinancialStateLabel::LedgerFact,
        FinancialStateLabel::EnvelopeAvailability,
        FinancialStateLabel::CashFlowProjection,
        FinancialStateLabel::Advice,
        FinancialStateLabel::Proposal,
        FinancialStateLabel::ExecutionResult,
        FinancialStateLabel::PurchaseOutcome,
    ];
    for label in &labels {
        let json = serde_json::to_string(label).unwrap();
        let back: FinancialStateLabel = serde_json::from_str(&json).unwrap();
        assert_eq!(*label, back);
    }
}

#[test]
fn test_label_deserialize_unknown_fails() {
    let result: Result<FinancialStateLabel, _> = serde_json::from_str(r#""bogusLabel""#);
    assert!(result.is_err());
}

// -- DecisionDataPolicy default -----------------------------------------

#[test]
fn test_policy_default_modes() {
    let p = DecisionDataPolicy::default();
    assert_eq!(p.pending_mode, PendingMode::IncludeConservatively);
    assert_eq!(p.uncategorized_mode, UncategorizedMode::ReserveFullAmount);
    assert_eq!(p.uncleared_mode, UnclearedMode::Include);
    assert_eq!(p.max_bank_sync_age_minutes, None);
    assert_eq!(p.max_budget_snapshot_age_minutes, None);
}

#[test]
fn test_policy_default_account_overrides() {
    let p = DecisionDataPolicy::default();
    assert_eq!(p.account_overrides.include_only, None);
    assert!(p.account_overrides.exclude.is_empty());
}

// -- DecisionDataPolicy roundtrip ---------------------------------------

#[test]
fn test_policy_roundtrip_json() {
    let p = DecisionDataPolicy {
        pending_mode: PendingMode::Exclude,
        uncategorized_mode: UncategorizedMode::Ignore,
        uncleared_mode: UnclearedMode::Exclude,
        max_bank_sync_age_minutes: Some(1440),
        max_budget_snapshot_age_minutes: Some(60),
        account_overrides: AccountOverrides {
            include_only: Some(vec!["acct_1".into(), "acct_2".into()]),
            exclude: vec!["acct_3".into()],
        },
    };
    let json = serde_json::to_string(&p).unwrap();
    assert!(json.contains(r#""pendingMode":"exclude""#), "{}", json);
    assert!(json.contains(r#""uncategorizedMode":"ignore""#), "{}", json);
    assert!(json.contains(r#""unclearedMode":"exclude""#), "{}", json);
    assert!(json.contains(r#""maxBankSyncAgeMinutes":1440"#), "{}", json);
    assert!(
        json.contains(r#""maxBudgetSnapshotAgeMinutes":60"#),
        "{}",
        json
    );
    assert!(json.contains(r#""includeOnly""#), "{}", json);
    assert!(json.contains(r#""exclude""#), "{}", json);

    let back: DecisionDataPolicy = serde_json::from_str(&json).unwrap();
    assert_eq!(p, back);
}

#[test]
fn test_policy_age_limits_none() {
    let p = DecisionDataPolicy {
        max_bank_sync_age_minutes: None,
        max_budget_snapshot_age_minutes: None,
        ..Default::default()
    };
    let json = serde_json::to_string(&p).unwrap();
    assert!(json.contains(r#""maxBankSyncAgeMinutes":null"#), "{}", json);
    assert!(
        json.contains(r#""maxBudgetSnapshotAgeMinutes":null"#),
        "{}",
        json
    );
    let back: DecisionDataPolicy = serde_json::from_str(&json).unwrap();
    assert_eq!(back.max_bank_sync_age_minutes, None);
    assert_eq!(back.max_budget_snapshot_age_minutes, None);
}

// -- AccountOverrides ---------------------------------------------------

#[test]
fn test_account_overrides_include_only() {
    let o = AccountOverrides {
        include_only: Some(vec!["a".into(), "b".into()]),
        exclude: vec![],
    };
    let json = serde_json::to_string(&o).unwrap();
    assert!(json.contains(r#""includeOnly""#));
    let back: AccountOverrides = serde_json::from_str(&json).unwrap();
    assert_eq!(o, back);
}

#[test]
fn test_account_overrides_exclude() {
    let o = AccountOverrides {
        include_only: None,
        exclude: vec!["x".into()],
    };
    let json = serde_json::to_string(&o).unwrap();
    assert!(json.contains(r#""includeOnly":null"#));
    let back: AccountOverrides = serde_json::from_str(&json).unwrap();
    assert_eq!(o, back);
}

// -- Mode serialization -------------------------------------------------

#[test]
fn test_pending_mode_serde() {
    assert_eq!(
        serde_json::to_string(&PendingMode::Include).unwrap(),
        r#""include""#,
    );
    assert_eq!(
        serde_json::to_string(&PendingMode::Exclude).unwrap(),
        r#""exclude""#,
    );
    assert_eq!(
        serde_json::to_string(&PendingMode::IncludeConservatively).unwrap(),
        r#""includeConservatively""#,
    );
}

#[test]
fn test_uncategorized_mode_serde() {
    assert_eq!(
        serde_json::to_string(&UncategorizedMode::Block).unwrap(),
        r#""block""#,
    );
    assert_eq!(
        serde_json::to_string(&UncategorizedMode::ReserveFullAmount).unwrap(),
        r#""reserveFullAmount""#,
    );
    assert_eq!(
        serde_json::to_string(&UncategorizedMode::Ignore).unwrap(),
        r#""ignore""#,
    );
}

#[test]
fn test_uncleared_mode_serde() {
    assert_eq!(
        serde_json::to_string(&UnclearedMode::Include).unwrap(),
        r#""include""#,
    );
    assert_eq!(
        serde_json::to_string(&UnclearedMode::Exclude).unwrap(),
        r#""exclude""#,
    );
}
