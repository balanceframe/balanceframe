//! Target / sinking-fund health assessment.
//!
//! These types model progress toward savings goals with behind/on-track/
//! complete semantics.

use serde::{Deserialize, Serialize};

use crate::financial_state::FinancialStateLabel;
use crate::money::Money;

// ---------------------------------------------------------------------------
// TargetHealth
// ---------------------------------------------------------------------------

/// Health status of a target (sinking fund or savings goal).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetHealth {
    /// Progress is behind the expected pace for the elapsed time.
    Behind,
    /// Progress meets or exceeds the expected pace, but the goal is not
    /// yet fully reached.
    OnTrack,
    /// The goal amount has been fully saved.
    Complete,
}

// ---------------------------------------------------------------------------
// TargetStatus
// ---------------------------------------------------------------------------

/// Status of a single target or sinking fund at a point in time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetStatus {
    /// Stable identifier for the target.
    pub target_id: String,
    /// Human-readable name for the target.
    pub target_name: String,
    /// Total goal amount to save.
    pub goal_amount: Money,
    /// Current amount saved toward the goal.
    pub current_amount: Money,
    /// Regular monthly contribution amount.
    pub monthly_contribution: Money,
    /// Computed health status.
    pub health: TargetHealth,
    /// Percentage of goal achieved (0.0 – 100.0).
    pub progress_percent: f64,
    /// Estimated months remaining to reach the goal at the current
    /// contribution rate.  `None` when the goal is met or the
    /// contribution is zero.
    pub months_remaining: Option<u32>,
    /// Financial state label (always [`FinancialStateLabel::Advice`]).
    #[serde(default)]
    pub label: FinancialStateLabel,
    /// Assumptions made during this assessment.
    #[serde(default)]
    pub assumptions: Vec<String>,
    /// Uncertainty metric (0.0 = certain, 1.0 = highly uncertain).
    /// Computed from months remaining / 36.0, capped at 1.0.
    #[serde(default)]
    pub uncertainty: Option<f64>,
}

// ---------------------------------------------------------------------------
// compute_target_status
// ---------------------------------------------------------------------------

/// Compute the health of a target based on its goal, current savings,
/// monthly contribution, elapsed months, and total months allocated.
///
/// Returns `TargetHealth::Complete` when `current_amount >= goal_amount`.
/// Returns `TargetHealth::Behind` when the current amount is less than the
/// expected progress (`months_elapsed / total_months * goal_amount`).
/// Otherwise returns `TargetHealth::OnTrack`.
///
/// # Panics
///
/// Panics when `goal_amount` and `current_amount` have different currencies.
pub fn compute_target_status(
    target_id: impl Into<String>,
    target_name: impl Into<String>,
    goal_amount: &Money,
    current_amount: &Money,
    monthly_contribution: &Money,
    months_elapsed: u32,
    total_months: u32,
) -> TargetStatus {
    assert_eq!(
        goal_amount.currency(),
        current_amount.currency(),
        "currency mismatch between goal_amount and current_amount",
    );

    let progress_percent = compute_progress_percent(goal_amount, current_amount);

    // Determine health
    let health = if !current_amount.is_negative()
        && current_amount.minor_units() >= goal_amount.minor_units()
    {
        TargetHealth::Complete
    } else if is_behind(goal_amount, current_amount, months_elapsed, total_months) {
        TargetHealth::Behind
    } else {
        TargetHealth::OnTrack
    };

    // Estimated months remaining
    let months_remaining =
        compute_months_remaining(goal_amount, current_amount, monthly_contribution);

    // Uncertainty: further out → more uncertain, capped at 3 years = 1.0
    let uncertainty = months_remaining.map(|m| (m as f64 / 36.0).clamp(0.0, 1.0));

    let assumptions = vec![
        "Monthly contribution remains constant".to_string(),
        "Linear progress toward goal".to_string(),
        "No unexpected expenses affecting goal progress".to_string(),
    ];

    TargetStatus {
        target_id: target_id.into(),
        target_name: target_name.into(),
        goal_amount: goal_amount.clone(),
        current_amount: current_amount.clone(),
        monthly_contribution: monthly_contribution.clone(),
        health,
        progress_percent,
        months_remaining,
        label: FinancialStateLabel::Advice,
        assumptions,
        uncertainty,
    }
}

/// Compute progress as a percentage of goal (0.0 – 100.0).
fn compute_progress_percent(goal: &Money, current: &Money) -> f64 {
    if goal.is_zero() || goal.minor_units() == 0 {
        return 100.0; // no goal means "complete" by default
    }
    let cur = current.minor_units() as f64;
    let g = goal.minor_units() as f64;
    ((cur / g) * 100.0).clamp(0.0, 100.0)
}

/// Whether progress is behind the expected linear pace.
fn is_behind(goal: &Money, current: &Money, months_elapsed: u32, total_months: u32) -> bool {
    if total_months == 0 {
        return false;
    }
    if months_elapsed == 0 {
        return false;
    }
    // Expected = (elapsed / total) * goal
    // Avoid floating point: compare using cross-multiplication on minor_units
    // current * total < goal * months_elapsed  → behind
    let cur = current.minor_units();
    let g = goal.minor_units();
    let elapsed = months_elapsed as i64;
    let total = total_months as i64;

    // Use checked multiplication to avoid overflow
    match cur.checked_mul(total) {
        Some(lhs) => match g.checked_mul(elapsed) {
            Some(rhs) => lhs < rhs,
            None => false, // rhs overflow → can't determine, assume not behind
        },
        None => false, // lhs overflow → can't determine, assume not behind
    }
}

/// Compute months remaining to reach the goal at the current contribution
/// rate.  Returns `None` when the goal is met or contribution is zero.
fn compute_months_remaining(goal: &Money, current: &Money, monthly: &Money) -> Option<u32> {
    if monthly.is_zero() || monthly.minor_units() == 0 {
        return None;
    }
    let remaining = goal.minor_units() - current.minor_units();
    if remaining <= 0 {
        return None; // goal already met
    }
    let contrib = monthly.minor_units();
    // Ceiling division for conservative estimate
    let months = (remaining + contrib - 1) / contrib;
    Some(months.min(u32::MAX as i64) as u32)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[cfg(test)]
mod tests;
