use balanceframe_financial_core::{allocate_evidence_amount, Money};
#[test]
fn allocation_conserves_minor_units_with_stable_remainders() {
    let shares = allocate_evidence_amount(&Money::new(5, "USD"), &[1, 1, 1]).unwrap();
    assert_eq!(
        shares.iter().map(Money::minor_units).collect::<Vec<_>>(),
        [2, 2, 1]
    );
    assert!(allocate_evidence_amount(&Money::new(-1, "USD"), &[1]).is_err());
    assert!(allocate_evidence_amount(&Money::new(1, "USD"), &[0]).is_err());
    assert!(allocate_evidence_amount(&Money::new(i64::MAX, "USD"), &[u64::MAX, u64::MAX]).is_ok());
}
#[test]
fn civil_dates_and_timestamps_are_strict() {
    use balanceframe_financial_core::evidence::{evidence_date_ordinal, evidence_timestamp_valid};
    assert_eq!(
        evidence_date_ordinal("2026-10-16").unwrap() - evidence_date_ordinal("2026-10-15").unwrap(),
        1
    );
    assert!(evidence_date_ordinal("2026-02-30").is_none());
    assert!(evidence_date_ordinal("2026-2-03").is_none());
    assert!(evidence_timestamp_valid("2026-10-15T12:00:00Z"));
    assert!(!evidence_timestamp_valid("2026-10-15"));
}
#[test]
fn zero_and_empty_allocations_preserve_unknown_without_losing_units() {
    assert!(allocate_evidence_amount(&Money::new(0, "USD"), &[])
        .unwrap()
        .is_empty());
    assert_eq!(
        allocate_evidence_amount(&Money::new(0, "USD"), &[0, 0]).unwrap(),
        [Money::new(0, "USD"), Money::new(0, "USD")]
    );
    assert!(allocate_evidence_amount(&Money::new(1, "USD"), &[]).is_err());
    assert_eq!(
        allocate_evidence_amount(&Money::new(2, "USD"), &[0, 1]).unwrap(),
        [Money::new(0, "USD"), Money::new(2, "USD")]
    );
    assert!(balanceframe_financial_core::evidence::evidence_date_ordinal("0000-01-01").is_none());
}
