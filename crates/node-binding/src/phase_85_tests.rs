use super::*;

fn empty_snapshot_input(extra: &str) -> String {
    format!(
        r#"{{"snapshot":{{"schemaVersion":"1","actualVersion":"1","snapshotDate":"2026-01-01","accounts":[],"transactions":[],"categories":[],"payees":[],"rules":[],"schedules":[],"budgets":[],"tags":[]}}{extra}}}"#
    )
}

#[test]
fn phase_85_exports_delegate_valid_json() {
    assert!(compute_data_quality(empty_snapshot_input("")).is_ok());
    assert!(
        compute_liquidity_coverage(empty_snapshot_input(r#","currentMonth":"2026-01""#)).is_ok()
    );
    assert!(
        compute_bill_calendar(empty_snapshot_input(r#","referenceDate":"2026-01-01""#)).is_ok()
    );
    assert!(
        compute_budget_variance(empty_snapshot_input(r#","referenceDate":"2026-01-01""#)).is_ok()
    );
    assert!(detect_irregular_obligations(empty_snapshot_input("")).is_ok());
    assert!(assess_income_reliability(empty_snapshot_input("")).is_ok());
    assert!(evaluate_forecast_calibration(empty_snapshot_input("")).is_ok());
    assert!(compare_scenarios(empty_snapshot_input(r#","baseline":{},"comparison":{}"#)).is_ok());
    assert!(
        evaluate_multidimensional_health(empty_snapshot_input(r#","currentMonth":"2026-01""#))
            .is_ok()
    );
}

#[test]
fn phase_85_exports_reject_malformed_json() {
    let malformed = String::from("{");
    assert!(compute_data_quality(malformed.clone()).is_err());
    assert!(compute_liquidity_coverage(malformed.clone()).is_err());
    assert!(compute_bill_calendar(malformed.clone()).is_err());
    assert!(compute_budget_variance(malformed.clone()).is_err());
    assert!(detect_irregular_obligations(malformed.clone()).is_err());
    assert!(assess_income_reliability(malformed.clone()).is_err());
    assert!(evaluate_forecast_calibration(malformed.clone()).is_err());
    assert!(compare_scenarios(malformed.clone()).is_err());
    assert!(evaluate_multidimensional_health(malformed).is_err());
}
