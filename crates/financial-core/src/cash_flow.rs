//! Cash-flow projection types.
//!
//! These types model forward-looking cash availability separately from
//! envelope-budget availability.  The projection computes a future balance
//! from current cleared balance plus expected inflows and outflows over
//! a given number of days.

use serde::{Deserialize, Serialize};

use crate::financial_state::FinancialStateLabel;
use crate::money::{Money, MoneyError};

// ---------------------------------------------------------------------------
// CashFlowProjection
// ---------------------------------------------------------------------------

/// Result of a forward-looking cash-flow projection, computed separately
/// from envelope-budget availability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashFlowProjection {
    /// Projected balance at the end of the projection period.
    pub projected_balance: Money,
    /// Current cleared balance at the start of the projection.
    pub current_balance: Money,
    /// Sum of expected inflows over the projection period.
    pub expected_inflows: Money,
    /// Sum of expected outflows over the projection period.
    pub expected_outflows: Money,
    /// Number of days the projection covers.
    pub projection_days: u32,
    /// `true` when the projected balance is non-negative.
    pub is_sufficient: bool,
    /// Estimated number of days until the running balance becomes
    /// negative, assuming even daily burn.  `None` when the projection
    /// never goes negative.
    pub days_until_negative: Option<u32>,
    /// Financial state label (always [`FinancialStateLabel::CashFlowProjection`]).
    #[serde(default)]
    pub label: FinancialStateLabel,
    /// Assumptions made during this projection.
    #[serde(default)]
    pub assumptions: Vec<String>,
    /// Uncertainty metric (0.0 = certain, 1.0 = highly uncertain).
    /// Computed as projection_days / 365.0, capped at 1.0.
    #[serde(default)]
    pub uncertainty: Option<f64>,
}

// ---------------------------------------------------------------------------
// compute_cash_flow_projection
// ---------------------------------------------------------------------------

/// Compute a simple cash-flow projection from the current cleared balance
/// and expected net flow over a given number of days.
///
/// Returns `Err(MoneyError::CurrencyMismatch)` when currencies do not
/// agree, or `Err(MoneyError::Overflow)` on arithmetic overflow.
///
/// The projection is a deterministic computation that does NOT model
/// envelope availability — callers must combine both concerns separately.
pub fn compute_cash_flow_projection(
    current_balance: &Money,
    expected_inflows: &Money,
    expected_outflows: &Money,
    projection_days: u32,
) -> Result<CashFlowProjection, MoneyError> {
    // Currency consistency
    if current_balance.currency() != expected_inflows.currency()
        || current_balance.currency() != expected_outflows.currency()
    {
        return Err(MoneyError::CurrencyMismatch(
            current_balance.currency().to_string(),
            expected_inflows.currency().to_string(),
        ));
    }

    // projected = current + inflows - outflows
    let after_inflows = current_balance.add(expected_inflows)?;
    let projected_balance = after_inflows.sub(expected_outflows)?;

    let is_sufficient = !projected_balance.is_negative();

    // Estimate days until balance would become negative.
    let net_flow = expected_inflows.sub(expected_outflows)?; // signed
    let days_until_negative = compute_days_until_negative(
        current_balance,
        &net_flow,
        projection_days,
    );

    let uncertainty = if projection_days > 0 {
        Some((projection_days as f64 / 365.0).clamp(0.0, 1.0))
    } else {
        None
    };

    let assumptions = vec![
        "Even daily burn rate across projection period".to_string(),
        "No additional inflows or outflows beyond expected".to_string(),
        "Net flow remains constant throughout the period".to_string(),
    ];

    Ok(CashFlowProjection {
        projected_balance,
        current_balance: current_balance.clone(),
        expected_inflows: expected_inflows.clone(),
        expected_outflows: expected_outflows.clone(),
        projection_days,
        is_sufficient,
        days_until_negative,
        label: FinancialStateLabel::CashFlowProjection,
        assumptions,
        uncertainty,
    })
}

/// Estimate days until the running balance becomes negative, assuming
/// even daily net burn across the projection period.
///
/// Returns `None` when the net flow is non-negative (balance will not
/// decrease), or when the denominator is zero.
fn compute_days_until_negative(
    current: &Money,
    net_flow: &Money,
    projection_days: u32,
) -> Option<u32> {
    if current.is_negative() {
        return Some(0);
    }
    if !net_flow.is_negative() {
        return None;
    }
    if projection_days == 0 {
        return None;
    }

    // Conservative (ceiling) burn-per-day estimate.
    let burn_abs = net_flow.minor_units().unsigned_abs();
    let days = projection_days as u64;
    let burn_per_day = (burn_abs + days - 1) / days; // ceiling division

    if burn_per_day == 0 {
        return None;
    }

    let cur = current.minor_units() as u64;
    let raw_days = cur / burn_per_day;
    Some(raw_days.min(u32::MAX as u64) as u32)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
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
            &Money::new(1000, "USD"), &Money::zero("USD"), &Money::zero("USD"), 30,
        ).unwrap();
        assert_eq!(proj.label, FinancialStateLabel::CashFlowProjection);
    }

    #[test]
    fn test_projection_assumptions_populated() {
        let proj = compute_cash_flow_projection(
            &Money::new(1000, "USD"), &Money::zero("USD"), &Money::zero("USD"), 30,
        ).unwrap();
        assert!(!proj.assumptions.is_empty());
        assert!(proj.assumptions.iter().any(|a| a.contains("burn rate")));
    }

    #[test]
    fn test_projection_uncertainty_scales_with_days() {
        let proj_0 = compute_cash_flow_projection(
            &Money::new(1000, "USD"), &Money::zero("USD"), &Money::zero("USD"), 0,
        ).unwrap();
        assert!(proj_0.uncertainty.is_none());

        let proj_365 = compute_cash_flow_projection(
            &Money::new(1000, "USD"), &Money::zero("USD"), &Money::zero("USD"), 365,
        ).unwrap();
        assert!(proj_365.uncertainty.is_some());
        assert!((proj_365.uncertainty.unwrap() - 1.0).abs() < 0.001);

        let proj_182 = compute_cash_flow_projection(
            &Money::new(1000, "USD"), &Money::zero("USD"), &Money::zero("USD"), 182,
        ).unwrap();
        let u = proj_182.uncertainty.unwrap();
        assert!((0.48..=0.50).contains(&u), "uncertainty={} for 182 days", u);
    }

    #[test]
    fn test_projection_new_fields_camelcase_json() {
        let proj = compute_cash_flow_projection(
            &Money::new(1000, "USD"), &Money::zero("USD"), &Money::zero("USD"), 30,
        ).unwrap();
        let json = serde_json::to_string(&proj).unwrap();
        assert!(json.contains("label"));
        assert!(json.contains("cashFlowProjection"));
        assert!(json.contains("assumptions"));
        assert!(json.contains("uncertainty"));
    }

    #[test]
    fn test_projection_new_fields_roundtrip() {
        let proj = compute_cash_flow_projection(
            &Money::new(1000, "USD"), &Money::new(500, "USD"), &Money::new(300, "USD"), 30,
        ).unwrap();
        let json = serde_json::to_string(&proj).unwrap();
        let back: CashFlowProjection = serde_json::from_str(&json).unwrap();
        assert_eq!(proj.label, back.label);
        assert_eq!(proj.assumptions, back.assumptions);
        assert_eq!(proj.uncertainty, back.uncertainty);
    }
}
