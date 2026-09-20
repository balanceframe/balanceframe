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
    let days_until_negative =
        compute_days_until_negative(current_balance, &net_flow, projection_days);

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
    let burn_per_day = burn_abs.div_ceil(days);

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
#[cfg(test)]
mod tests;
