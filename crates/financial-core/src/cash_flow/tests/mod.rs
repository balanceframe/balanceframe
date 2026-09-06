use super::*;

// -- sufficient projections --------------------------------------------

#[test]
fn test_projection_sufficient_inflows_exceed_outflows() {
    let current = Money::new(1000, "USD");
    let inflows = Money::new(2000, "USD");
    let outflows = Money::new(1500, "USD");
    let proj = compute_cash_flow_projection(&current, &inflows, &outflows, 30).unwrap();

    assert_eq!(proj.projected_balance, Money::new(1500, "USD"));
    assert!(proj.is_sufficient);
    assert_eq!(proj.current_balance, Money::new(1000, "USD"));
    assert_eq!(proj.expected_inflows, Money::new(2000, "USD"));
    assert_eq!(proj.expected_outflows, Money::new(1500, "USD"));
    assert_eq!(proj.projection_days, 30);
    assert!(proj.days_until_negative.is_none());
}

#[test]
fn test_projection_sufficient_net_zero() {
    let current = Money::new(500, "USD");
    let inflows = Money::new(1000, "USD");
    let outflows = Money::new(1000, "USD");
    let proj = compute_cash_flow_projection(&current, &inflows, &outflows, 30).unwrap();
    assert_eq!(proj.projected_balance, Money::new(500, "USD"));
    assert!(proj.is_sufficient);
    assert!(proj.days_until_negative.is_none());
}

// -- insufficient projections ------------------------------------------

#[test]
fn test_projection_insufficient_outflows_exceed_inflows() {
    let current = Money::new(1000, "USD");
    let inflows = Money::new(500, "USD");
    let outflows = Money::new(2000, "USD");
    let proj = compute_cash_flow_projection(&current, &inflows, &outflows, 30).unwrap();

    assert_eq!(proj.projected_balance, Money::new(-500, "USD"));
    assert!(!proj.is_sufficient);
    // burn = ceil(1500/30) = 50/day; days = 1000/50 = 20
    assert_eq!(proj.days_until_negative, Some(20));
}

// -- special cases ------------------------------------------------------

#[test]
fn test_projection_zero_everything() {
    let z = Money::zero("USD");
    let proj = compute_cash_flow_projection(&z, &z, &z, 30).unwrap();

    assert_eq!(proj.projected_balance, Money::zero("USD"));
    assert!(proj.is_sufficient);
    assert!(proj.days_until_negative.is_none());
}

#[test]
fn test_projection_already_negative() {
    let current = Money::new(-500, "USD");
    let inflows = Money::zero("USD");
    let outflows = Money::zero("USD");
    let proj = compute_cash_flow_projection(&current, &inflows, &outflows, 30).unwrap();

    assert_eq!(proj.projected_balance, Money::new(-500, "USD"));
    assert!(!proj.is_sufficient);
    assert_eq!(proj.days_until_negative, Some(0));
}

#[test]
fn test_projection_zero_days() {
    let current = Money::new(1000, "USD");
    let inflows = Money::new(500, "USD");
    let outflows = Money::new(2000, "USD");
    let proj = compute_cash_flow_projection(&current, &inflows, &outflows, 0).unwrap();

    assert_eq!(proj.projection_days, 0);
    assert!(proj.days_until_negative.is_none());
}

#[test]
fn test_projection_burn_never_runs_out_within_period() {
    let current = Money::new(1_000_000, "USD");
    let inflows = Money::new(100, "USD");
    let outflows = Money::new(200, "USD");
    let proj = compute_cash_flow_projection(&current, &inflows, &outflows, 1).unwrap();

    assert!(proj.is_sufficient);
    // Current 1,000,000 / burn 100/day = 10,000 days
    assert_eq!(proj.days_until_negative, Some(10_000));
}

// -- error cases --------------------------------------------------------

#[test]
fn test_projection_currency_mismatch() {
    let usd = Money::new(100, "USD");
    let eur = Money::new(100, "EUR");
    let result = compute_cash_flow_projection(&usd, &eur, &usd, 30);
    assert!(matches!(result, Err(MoneyError::CurrencyMismatch(_, _))));
}

#[test]
fn test_projection_overflow_handled() {
    let current = Money::new(i64::MAX, "USD");
    let inflows = Money::new(1, "USD");
    let outflows = Money::zero("USD");
    let result = compute_cash_flow_projection(&current, &inflows, &outflows, 30);
    assert!(matches!(result, Err(MoneyError::Overflow)));
}

// -- days_until_negative edge coverage ----------------------------------

#[test]
fn test_days_until_negative_zero_current() {
    let c = Money::zero("USD");
    let net = Money::new(-100, "USD");
    assert_eq!(compute_days_until_negative(&c, &net, 30), Some(0));
}

#[test]
fn test_days_until_negative_small_burn() {
    let c = Money::new(10, "USD");
    let net = Money::new(-1, "USD");
    // burn = ceil(1/30) = 1; days = 10/1 = 10
    assert_eq!(compute_days_until_negative(&c, &net, 30), Some(10));
}

// -- CamelCase JSON keys ------------------------------------------------

#[test]
fn test_cash_flow_projection_camelcase_keys() {
    let current = Money::new(1000, "USD");
    let inflows = Money::new(500, "USD");
    let outflows = Money::new(300, "USD");
    let proj = compute_cash_flow_projection(&current, &inflows, &outflows, 30).unwrap();

    let json = serde_json::to_string(&proj).unwrap();
    assert!(json.contains("projectedBalance"));
    assert!(json.contains("currentBalance"));
    assert!(json.contains("expectedInflows"));
    assert!(json.contains("expectedOutflows"));
    assert!(json.contains("projectionDays"));
    assert!(json.contains("isSufficient"));
    assert!(json.contains("daysUntilNegative"));
}

#[test]
fn test_projection_roundtrip() {
    let current = Money::new(1000, "USD");
    let inflows = Money::new(2000, "USD");
    let outflows = Money::new(1500, "USD");
    let proj = compute_cash_flow_projection(&current, &inflows, &outflows, 30).unwrap();
    let json = serde_json::to_string(&proj).unwrap();
    let back: CashFlowProjection = serde_json::from_str(&json).unwrap();
    assert_eq!(proj, back);
}

// -- New fields: label, assumptions, uncertainty ----------------------

#[test]
fn test_projection_label_is_cash_flow() {
    let proj = compute_cash_flow_projection(
        &Money::new(1000, "USD"),
        &Money::zero("USD"),
        &Money::zero("USD"),
        30,
    )
    .unwrap();
    assert_eq!(proj.label, FinancialStateLabel::CashFlowProjection);
}

#[test]
fn test_projection_assumptions_populated() {
    let proj = compute_cash_flow_projection(
        &Money::new(1000, "USD"),
        &Money::zero("USD"),
        &Money::zero("USD"),
        30,
    )
    .unwrap();
    assert!(!proj.assumptions.is_empty());
    assert!(proj.assumptions.iter().any(|a| a.contains("burn rate")));
}

#[test]
fn test_projection_uncertainty_scales_with_days() {
    let proj_0 = compute_cash_flow_projection(
        &Money::new(1000, "USD"),
        &Money::zero("USD"),
        &Money::zero("USD"),
        0,
    )
    .unwrap();
    assert!(proj_0.uncertainty.is_none());

    let proj_365 = compute_cash_flow_projection(
        &Money::new(1000, "USD"),
        &Money::zero("USD"),
        &Money::zero("USD"),
        365,
    )
    .unwrap();
    assert!(proj_365.uncertainty.is_some());
    assert!((proj_365.uncertainty.unwrap() - 1.0).abs() < 0.001);

    let proj_182 = compute_cash_flow_projection(
        &Money::new(1000, "USD"),
        &Money::zero("USD"),
        &Money::zero("USD"),
        182,
    )
    .unwrap();
    let u = proj_182.uncertainty.unwrap();
    assert!((0.48..=0.50).contains(&u), "uncertainty={} for 182 days", u);
}

#[test]
fn test_projection_new_fields_camelcase_json() {
    let proj = compute_cash_flow_projection(
        &Money::new(1000, "USD"),
        &Money::zero("USD"),
        &Money::zero("USD"),
        30,
    )
    .unwrap();
    let json = serde_json::to_string(&proj).unwrap();
    assert!(json.contains("label"));
    assert!(json.contains("cashFlowProjection"));
    assert!(json.contains("assumptions"));
    assert!(json.contains("uncertainty"));
}

#[test]
fn test_projection_new_fields_roundtrip() {
    let proj = compute_cash_flow_projection(
        &Money::new(1000, "USD"),
        &Money::new(500, "USD"),
        &Money::new(300, "USD"),
        30,
    )
    .unwrap();
    let json = serde_json::to_string(&proj).unwrap();
    let back: CashFlowProjection = serde_json::from_str(&json).unwrap();
    assert_eq!(proj.label, back.label);
    assert_eq!(proj.assumptions, back.assumptions);
    assert_eq!(proj.uncertainty, back.uncertainty);
}
