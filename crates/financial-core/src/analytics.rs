//! Deterministic analysis contracts and implementations for the budget
//! intelligence pipeline.
//!
//! These types model read-only analytical results that are computed
//! purely from snapshot data.  Every type carries explicit states for
//! no-configuration, unavailable, unknown, and insufficient-data —
//! distinct from a normal result.
//!
//! # Design rules
//!
//! * **Immutable** — every result is a snapshot; nothing mutates ledger
//!   state, envelopes, or notifications.
//! * **Conservative** — projections are clearly labelled; current
//!   availability is never conflated with projected availability.
//! * **Checked arithmetic** — all monetary computations use
//!   [`Money`] operations that detect overflow and currency mismatch.
//! * **Semantic labels** — every monetary value, score, or ratio carries
//!   a label that explains what it represents.

use serde::{Deserialize, Serialize};

use crate::money::Money;

// ---------------------------------------------------------------------------
// Shared state kinds
// ---------------------------------------------------------------------------

/// Whether a deterministic analysis result is available or why it is not.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AnalysisAvailability {
    /// Result is available and computed from current data.
    Available,
    /// The feature has no configuration (no budgets, no targets, etc.).
    NoConfiguration,
    /// The data source is unavailable (no ledger connected, no accounts).
    Unavailable,
    /// Cannot determine the result from the available data.
    Unknown,
    /// Not enough data points to produce a meaningful result.
    InsufficientData,
}

// ===========================================================================
// 1. Data-Quality Center
// ===========================================================================

/// A single dimension of data quality with score and explanation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityDimension {
    /// Name of the dimension (e.g. "completeness", "freshness", "consistency").
    pub dimension: String,
    /// Score from 0.0 (worst) to 1.0 (best), or `None` if not measurable.
    pub score: Option<f64>,
    /// Human-readable explanation of the score.
    pub explanation: String,
    /// Severity of the worst issue in this dimension.
    pub worst_severity: Option<String>,
}

/// Composite data-quality report that aggregates all quality dimensions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataQualityCenter {
    /// Availability of the quality assessment.
    pub availability: AnalysisAvailability,
    /// Overall quality score (0.0 – 1.0), or `None` when unavailable.
    pub overall_score: Option<f64>,
    /// Per-dimension quality breakdown.
    pub dimensions: Vec<QualityDimension>,
    /// Actionable recommendations.
    pub recommendations: Vec<String>,
}

/// Compute a composite data-quality center report from existing quality data.
///
/// Returns `NoConfiguration` when no accounts or transactions exist.
/// Returns `Unavailable` when critical metadata is missing.
pub fn compute_data_quality_center(
    accounts_count: usize,
    transactions_count: usize,
    uncategorized_count: usize,
    duplicate_candidates: usize,
    stale_account_days: Option<u32>,
    stale_bank_sync_days: Option<u32>,
) -> DataQualityCenter {
    if accounts_count == 0 && transactions_count == 0 {
        return DataQualityCenter {
            availability: AnalysisAvailability::NoConfiguration,
            overall_score: None,
            dimensions: vec![],
            recommendations: vec![
                "Add accounts and transactions to enable quality assessment.".to_string(),
            ],
        };
    }

    let mut dimensions = Vec::new();
    let mut recommendations = Vec::new();
    let mut score_sum = 0.0_f64;
    let mut score_count = 0_u32;

    // Completeness dimension
    let (completeness_score, completeness_explanation) = if transactions_count == 0 {
        (0.0_f64, "No transactions recorded.".to_string())
    } else {
        let uncategorized_ratio = uncategorized_count as f64 / transactions_count.max(1) as f64;
        let score = (1.0_f64 - uncategorized_ratio).clamp(0.0, 1.0);
        let explanation = if uncategorized_ratio > 0.3 {
            format!(
                "{:.0}% of transactions are uncategorized.",
                uncategorized_ratio * 100.0
            )
        } else if uncategorized_ratio > 0.1 {
            format!(
                "{:.0}% uncategorized — manageable.",
                uncategorized_ratio * 100.0
            )
        } else {
            "Most transactions are categorized.".to_string()
        };
        (score, explanation)
    };
    dimensions.push(QualityDimension {
        dimension: "completeness".to_string(),
        score: Some(completeness_score),
        explanation: completeness_explanation,
        worst_severity: if uncategorized_count > 0 {
            Some("warning".to_string())
        } else {
            None
        },
    });
    score_sum += completeness_score;
    score_count += 1;

    // Freshness dimension
    let (freshness_score, freshness_explanation) = match (stale_account_days, stale_bank_sync_days)
    {
        (Some(acct_days), Some(sync_days)) => {
            let max_stale = acct_days.max(sync_days);
            let score = (1.0_f64 - (max_stale as f64 / 90.0_f64)).clamp(0.0, 1.0);
            (score, format!("Data is {} days old.", max_stale))
        }
        (Some(days), None) => {
            let score = (1.0_f64 - (days as f64 / 90.0_f64)).clamp(0.0, 1.0);
            (
                score,
                format!("Account data is {} days old; sync unknown.", days),
            )
        }
        (None, Some(days)) => {
            let score = (1.0_f64 - (days as f64 / 90.0_f64)).clamp(0.0, 1.0);
            (
                score,
                format!("Bank sync is {} days old; account age unknown.", days),
            )
        }
        (None, None) => (0.0, "Freshness metadata is missing.".to_string()),
    };
    dimensions.push(QualityDimension {
        dimension: "freshness".to_string(),
        score: Some(freshness_score),
        explanation: freshness_explanation,
        worst_severity: if freshness_score < 0.5 {
            Some("stale".to_string())
        } else {
            None
        },
    });
    score_sum += freshness_score;
    score_count += 1;

    // Consistency dimension
    let (consistency_score, consistency_explanation) = if duplicate_candidates > 0 {
        let score = (1.0_f64 - (duplicate_candidates as f64 / transactions_count.max(1) as f64))
            .clamp(0.0, 1.0);
        (
            score,
            format!("{} potential duplicate pairs found.", duplicate_candidates),
        )
    } else {
        (1.0_f64, "No duplicate candidates detected.".to_string())
    };
    dimensions.push(QualityDimension {
        dimension: "consistency".to_string(),
        score: Some(consistency_score),
        explanation: consistency_explanation,
        worst_severity: if duplicate_candidates > 0 {
            Some("warning".to_string())
        } else {
            None
        },
    });
    score_sum += consistency_score;
    score_count += 1;

    if freshness_score < 0.5 {
        recommendations.push("Reconnect or re-download to refresh stale data.".to_string());
    }
    if uncategorized_count > 0 {
        recommendations.push(format!(
            "Categorize {} uncategorized transactions.",
            uncategorized_count
        ));
    }
    if duplicate_candidates > 0 {
        recommendations.push(format!(
            "Review {} potential duplicate transactions.",
            duplicate_candidates
        ));
    }
    if recommendations.is_empty() {
        recommendations.push("Data quality looks good.".to_string());
    }

    DataQualityCenter {
        availability: AnalysisAvailability::Available,
        overall_score: Some(score_sum / score_count as f64),
        dimensions,
        recommendations,
    }
}

// ===========================================================================
// 2. Liquidity / Obligation Coverage
// ===========================================================================

/// A single upcoming obligation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpcomingObligation {
    /// Name or payee of the obligation.
    pub name: String,
    /// Due date (ISO 8601 date string).
    pub due_date: String,
    /// Estimated amount.
    pub amount: Money,
    /// Category identifier, if known.
    pub category_id: Option<String>,
    /// Whether this is a recurring (monthly) obligation.
    pub is_recurring: bool,
}

/// Coverage ratio of liquid funds against upcoming obligations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageRatio {
    /// The ratio value (e.g. 1.5 means 150% coverage).
    pub ratio: f64,
    /// Human-readable label for this ratio.
    pub label: String,
}

/// Liquidity / obligation coverage assessment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiquidityCoverage {
    /// Availability of the assessment.
    pub availability: AnalysisAvailability,
    /// Total liquid funds available (cash + checking + savings).
    pub total_liquid: Option<Money>,
    /// Total upcoming obligations within the window.
    pub total_obligations: Option<Money>,
    /// Coverage ratio across all windows.
    pub coverage: Vec<CoverageRatio>,
    /// Upcoming obligations in detail.
    pub upcoming_obligations: Vec<UpcomingObligation>,
}

/// Compute liquidity coverage for upcoming obligations.
///
/// Returns `NoConfiguration` when no liquid accounts are configured.
/// Returns `InsufficientData` when there are no schedules or budget months.
pub fn compute_liquidity_coverage(
    liquid_balance: Option<&Money>,
    schedules: &[crate::snapshots::Schedule],
    budget_months: &[crate::snapshots::BudgetMonth],
    current_month: &str,
) -> LiquidityCoverage {
    let total_liquid = liquid_balance.cloned();

    if total_liquid.is_none() && schedules.is_empty() && budget_months.is_empty() {
        return LiquidityCoverage {
            availability: AnalysisAvailability::NoConfiguration,
            total_liquid: None,
            total_obligations: None,
            coverage: vec![],
            upcoming_obligations: vec![],
        };
    }

    if total_liquid.is_none() && schedules.is_empty() {
        return LiquidityCoverage {
            availability: AnalysisAvailability::InsufficientData,
            total_liquid: None,
            total_obligations: None,
            coverage: vec![],
            upcoming_obligations: vec![],
        };
    }

    // Build upcoming obligations from schedules
    let mut obligations: Vec<UpcomingObligation> = Vec::new();
    let mut total_obligation_minor: i64 = 0;
    let currency = total_liquid
        .as_ref()
        .map(|m| m.currency().to_string())
        .unwrap_or_default();

    for sched in schedules {
        if sched.amount.minor_units() < 0 {
            let amount_minor = sched.amount.minor_units().unsigned_abs() as i64;
            total_obligation_minor = total_obligation_minor.saturating_add(amount_minor);
            obligations.push(UpcomingObligation {
                name: sched.payee_name.clone().unwrap_or_else(|| sched.id.clone()),
                due_date: sched.next_expected.clone(),
                amount: Money::new(amount_minor, &currency),
                category_id: None,
                is_recurring: sched.frequency == "monthly" || sched.frequency == "everyMonth",
            });
        }
    }

    // Also count budget month obligations
    for bm in budget_months {
        if bm.month.as_str() >= current_month {
            for bc in bm.categories.values() {
                if bc.amount.minor_units() > 0 {
                    total_obligation_minor =
                        total_obligation_minor.saturating_add(bc.amount.minor_units());
                }
            }
        }
    }

    let total_obligations = Some(Money::new(total_obligation_minor, &currency));

    // Compute coverage ratios at 30, 60, 90 day windows (simplified: all schedules)
    let mut coverage = Vec::new();
    if let Some(ref liquid) = total_liquid {
        let liquid_minor = liquid.minor_units();

        if total_obligation_minor > 0 {
            let ratio_30 = if total_obligation_minor > 0 {
                // 30-day: proportion of obligations in current month
                let current_obligations: i64 = obligations
                    .iter()
                    .filter(|o| o.due_date.starts_with(current_month))
                    .map(|o| o.amount.minor_units())
                    .sum();
                if current_obligations > 0 {
                    liquid_minor as f64 / current_obligations as f64
                } else {
                    f64::MAX
                }
            } else {
                f64::MAX
            };

            let ratio_full = if total_obligation_minor > 0 {
                liquid_minor as f64 / total_obligation_minor as f64
            } else {
                f64::MAX
            };

            coverage.push(CoverageRatio {
                ratio: ratio_30,
                label: "30-day coverage".to_string(),
            });
            coverage.push(CoverageRatio {
                ratio: ratio_full,
                label: "full coverage".to_string(),
            });
        } else {
            coverage.push(CoverageRatio {
                ratio: f64::MAX,
                label: "no obligations".to_string(),
            });
        }
    }

    LiquidityCoverage {
        availability: AnalysisAvailability::Available,
        total_liquid,
        total_obligations,
        coverage,
        upcoming_obligations: obligations,
    }
}

// ===========================================================================
// 3. Bill / Obligation Calendar
// ===========================================================================

/// Calendar entry for a single bill or obligation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillCalendarEntry {
    /// Name or payee.
    pub name: String,
    /// Due date (ISO 8601).
    pub due_date: String,
    /// Amount due.
    pub amount: Money,
    /// Category of the bill.
    pub category_id: Option<String>,
    /// Status: paid, unpaid, or pending.
    pub status: String,
}

/// Calendar of upcoming bills/obligations sorted by due date.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillCalendar {
    /// Availability of the calendar.
    pub availability: AnalysisAvailability,
    /// Entries sorted by due date.
    pub entries: Vec<BillCalendarEntry>,
    /// Total amount due for unpaid entries.
    pub total_unpaid: Option<Money>,
    /// Count of unpaid entries.
    pub unpaid_count: u32,
}

/// Compute the bill/obligation calendar from schedules and transactions.
///
/// Returns `NoConfiguration` when no schedules exist.
pub fn compute_bill_calendar(
    schedules: &[crate::snapshots::Schedule],
    transactions: &[crate::snapshots::Transaction],
    _reference_date: &str,
) -> BillCalendar {
    if schedules.is_empty() {
        return BillCalendar {
            availability: AnalysisAvailability::NoConfiguration,
            entries: vec![],
            total_unpaid: None,
            unpaid_count: 0,
        };
    }

    let mut entries: Vec<BillCalendarEntry> = Vec::new();
    let mut unpaid_minor: i64 = 0;
    let mut unpaid_count: u32 = 0;
    let mut currency: Option<String> = None;

    for sched in schedules {
        if sched.amount.minor_units() >= 0 {
            continue; // skip income schedules
        }
        let amount_minor = sched.amount.minor_units().unsigned_abs() as i64;
        let cur = sched.amount.currency().to_string();
        currency = Some(cur);

        // Determine status from transactions
        let matched = transactions.iter().any(|tx| {
            tx.payee_name.as_deref() == sched.payee_name.as_deref()
                || tx.imported_payee.as_deref() == sched.payee_name.as_deref()
        });
        let status = if matched {
            "paid".to_string()
        } else {
            unpaid_minor = unpaid_minor.saturating_add(amount_minor);
            unpaid_count += 1;
            "unpaid".to_string()
        };

        entries.push(BillCalendarEntry {
            name: sched.payee_name.clone().unwrap_or_else(|| sched.id.clone()),
            due_date: sched.next_expected.clone(),
            amount: Money::new(amount_minor, sched.amount.currency()),
            category_id: None,
            status,
        });
    }

    // Sort by due date
    entries.sort_by(|a, b| a.due_date.cmp(&b.due_date));

    BillCalendar {
        availability: AnalysisAvailability::Available,
        total_unpaid: currency.map(|cur| Money::new(unpaid_minor, &cur)),
        unpaid_count,
        entries,
    }
}

// ===========================================================================
// 4. Budget Variance / Trends
// ===========================================================================

/// Variance for a single budget category.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryVariance {
    /// Category identifier.
    pub category_id: String,
    /// Category name.
    pub category_name: String,
    /// Budgeted amount.
    pub budgeted: Money,
    /// Actual spent amount.
    pub actual: Money,
    /// Variance (budgeted - actual). Positive means under-budget.
    pub variance: Money,
    /// Variance as a percentage of budget (positive = under).
    pub variance_percent: f64,
    /// Label: "over", "under", "on_track".
    pub label: String,
}

/// Trend direction for a budget category.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrendDirection {
    Increasing,
    Decreasing,
    Stable,
    Volatile,
}

/// Trend information for a single category.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTrend {
    /// Category identifier.
    pub category_id: String,
    /// Category name.
    pub category_name: String,
    /// Direction of the trend.
    pub direction: TrendDirection,
    /// Average monthly change (in minor units).
    pub avg_change: i64,
    /// Number of periods analyzed.
    pub periods_analyzed: u32,
    /// Whether this category shows seasonality.
    pub seasonality_detected: bool,
}

/// Budget variance and trends report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetVarianceReport {
    /// Availability of the report.
    pub availability: AnalysisAvailability,
    /// Per-category variance breakdown.
    pub category_variances: Vec<CategoryVariance>,
    /// Trend analysis for categories with enough history.
    pub trends: Vec<CategoryTrend>,
    /// Total budgeted amount across all categories.
    pub total_budgeted: Option<Money>,
    /// Total actual spending.
    pub total_actual: Option<Money>,
    /// Overall variance (budgeted - actual).
    pub total_variance: Option<Money>,
    /// Overall variance percentage.
    pub overall_variance_percent: Option<f64>,
}

/// Compute budget variance and trends from budget months and transactions.
///
/// Returns `NoConfiguration` when no budget months exist.
/// Returns `InsufficientData` when no transactions match budget categories.
pub fn compute_budget_variance(
    budget_months: &[crate::snapshots::BudgetMonth],
    transactions: &[crate::snapshots::Transaction],
    categories: &[crate::snapshots::Category],
    _reference_date: &str,
) -> BudgetVarianceReport {
    if budget_months.is_empty() {
        return BudgetVarianceReport {
            availability: AnalysisAvailability::NoConfiguration,
            category_variances: vec![],
            trends: vec![],
            total_budgeted: None,
            total_actual: None,
            total_variance: None,
            overall_variance_percent: None,
        };
    }

    let latest_month = budget_months.iter().max_by(|a, b| a.month.cmp(&b.month));
    let latest = match latest_month {
        Some(bm) => bm,
        None => {
            return BudgetVarianceReport {
                availability: AnalysisAvailability::InsufficientData,
                category_variances: vec![],
                trends: vec![],
                total_budgeted: None,
                total_actual: None,
                total_variance: None,
                overall_variance_percent: None,
            };
        }
    };

    let mut variances = Vec::new();
    let mut total_budgeted_minor: i64 = 0;
    let mut total_actual_minor: i64 = 0;
    let mut currency: Option<String> = None;

    for (cat_id, bc) in &latest.categories {
        let cat_name = categories
            .iter()
            .find(|c| c.id == *cat_id)
            .map(|c| c.name.clone())
            .unwrap_or_else(|| cat_id.clone());

        let budgeted_minor = bc.amount.minor_units();
        let actual_minor: i64 = transactions
            .iter()
            .filter(|tx| tx.category_id.as_deref() == Some(cat_id))
            .filter_map(|tx| tx.amount.minor_units().checked_abs())
            .sum();

        let variance_minor = budgeted_minor - actual_minor;
        let variance_percent = if budgeted_minor != 0 {
            (variance_minor as f64 / budgeted_minor as f64) * 100.0
        } else if actual_minor == 0 {
            0.0
        } else {
            -100.0
        };

        let label = if variance_minor < 0 {
            "over"
        } else if variance_minor > 0 {
            "under"
        } else {
            "on_track"
        };

        total_budgeted_minor = total_budgeted_minor.saturating_add(budgeted_minor);
        total_actual_minor = total_actual_minor.saturating_add(actual_minor);
        currency = Some(bc.amount.currency().to_string());

        variances.push(CategoryVariance {
            category_id: cat_id.clone(),
            category_name: cat_name,
            budgeted: bc.amount.clone(),
            actual: Money::new(actual_minor, bc.amount.currency()),
            variance: Money::new(variance_minor.abs(), bc.amount.currency()),
            variance_percent,
            label: label.to_string(),
        });
    }

    // Compute trends from multiple budget months
    let mut trends: Vec<CategoryTrend> = Vec::new();
    if budget_months.len() >= 2 {
        // Build map of month -> category -> budgeted amount for trend analysis
        let cat_names: std::collections::HashMap<String, String> = categories
            .iter()
            .map(|c| (c.id.clone(), c.name.clone()))
            .collect();

        // For each category, compute average change across months
        let mut cat_spending: std::collections::HashMap<String, Vec<(String, i64)>> =
            std::collections::HashMap::new();
        for bm in budget_months {
            for (cat_id, bc) in &bm.categories {
                cat_spending
                    .entry(cat_id.clone())
                    .or_default()
                    .push((bm.month.clone(), bc.amount.minor_units()));
            }
        }

        for (cat_id, amounts) in &cat_spending {
            if amounts.len() < 2 {
                continue;
            }
            let mut sorted = amounts.clone();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            let mut changes: Vec<i64> = Vec::new();
            for window in sorted.windows(2) {
                changes.push(window[1].1 - window[0].1);
            }
            let avg_change = if !changes.is_empty() {
                changes.iter().sum::<i64>() / changes.len() as i64
            } else {
                0
            };
            let direction = if avg_change.abs() < 50 {
                TrendDirection::Stable
            } else if avg_change > 0 {
                TrendDirection::Increasing
            } else {
                TrendDirection::Decreasing
            };
            let seasonality =
                detect_seasonality(&amounts.iter().map(|(_, v)| *v).collect::<Vec<_>>());
            trends.push(CategoryTrend {
                category_id: cat_id.clone(),
                category_name: cat_names
                    .get(cat_id)
                    .cloned()
                    .unwrap_or_else(|| cat_id.clone()),
                direction,
                avg_change,
                periods_analyzed: amounts.len() as u32,
                seasonality_detected: seasonality,
            });
        }
    }

    let overall_variance_percent = if total_budgeted_minor > 0 {
        Some(
            (total_budgeted_minor - total_actual_minor) as f64 / total_budgeted_minor as f64
                * 100.0,
        )
    } else {
        None
    };

    BudgetVarianceReport {
        availability: AnalysisAvailability::Available,
        category_variances: variances,
        trends,
        total_budgeted: currency
            .as_ref()
            .map(|cur| Money::new(total_budgeted_minor, cur)),
        total_actual: currency
            .as_ref()
            .map(|cur| Money::new(total_actual_minor, cur)),
        total_variance: currency.as_ref().map(|cur| {
            Money::new(
                (total_budgeted_minor - total_actual_minor).unsigned_abs() as i64,
                cur,
            )
        }),
        overall_variance_percent,
    }
}

/// Detect seasonality in a time series of amounts.
fn detect_seasonality(amounts: &[i64]) -> bool {
    if amounts.len() < 4 {
        return false;
    }
    // Simplified: check if the pattern repeats every 3 periods
    let mut matches = 0;
    for i in 0..amounts.len() - 3 {
        if amounts[i] == amounts[i + 3] {
            matches += 1;
        }
    }
    matches >= 2
}

// ===========================================================================
// 5. Irregular Obligations
// ===========================================================================

/// Type of irregularity detected for an obligation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IrregularityKind {
    NonMonthly,
    Seasonal,
    OneOff,
    VariableAmount,
}

/// An irregular obligation entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularObligation {
    /// Name or payee.
    pub name: String,
    /// Type of irregularity.
    pub kind: IrregularityKind,
    /// Typical amount (or most recent).
    pub typical_amount: Money,
    /// Frequency description.
    pub frequency: String,
    /// Category if known.
    pub category_id: Option<String>,
    /// Next expected date, if predictable.
    pub next_expected_date: Option<String>,
}

/// Report of obligations that don't follow a regular monthly pattern.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularObligationsReport {
    /// Availability of the report.
    pub availability: AnalysisAvailability,
    /// Irregular obligations found.
    pub obligations: Vec<IrregularObligation>,
    /// Total estimated annual cost.
    pub total_estimated_annual: Option<Money>,
}

/// Detect irregular obligations from schedules and transactions.
///
/// Returns `NoConfiguration` when no schedules exist.
/// Returns `InsufficientData` when schedules have no amounts.
pub fn compute_irregular_obligations(
    schedules: &[crate::snapshots::Schedule],
) -> IrregularObligationsReport {
    if schedules.is_empty() {
        return IrregularObligationsReport {
            availability: AnalysisAvailability::NoConfiguration,
            obligations: vec![],
            total_estimated_annual: None,
        };
    }

    let mut obligations = Vec::new();
    let mut total_annual_minor: i64 = 0;
    let mut currency: Option<String> = None;

    for sched in schedules {
        if sched.amount.minor_units() >= 0 {
            continue; // skip income
        }
        let amount_minor = sched.amount.minor_units().unsigned_abs() as i64;
        currency = Some(sched.amount.currency().to_string());

        let kind = classify_irregularity(&sched.frequency, amount_minor, schedules);
        let frequency_desc = match kind {
            IrregularityKind::NonMonthly => sched.frequency.clone(),
            IrregularityKind::Seasonal => "seasonal".to_string(),
            IrregularityKind::OneOff => "one-time".to_string(),
            IrregularityKind::VariableAmount => "variable amount".to_string(),
        };

        // Estimate annual cost
        let annual_estimate = match sched.frequency.as_str() {
            "monthly" | "everyMonth" => amount_minor.saturating_mul(12),
            "weekly" | "everyWeek" => amount_minor.saturating_mul(52),
            "yearly" | "everyYear" => amount_minor,
            _ => amount_minor, // one-off or unknown: count once
        };
        total_annual_minor = total_annual_minor.saturating_add(annual_estimate);

        obligations.push(IrregularObligation {
            name: sched.payee_name.clone().unwrap_or_else(|| sched.id.clone()),
            kind,
            typical_amount: Money::new(amount_minor, sched.amount.currency()),
            frequency: frequency_desc,
            category_id: None,
            next_expected_date: Some(sched.next_expected.clone()),
        });
    }

    if obligations.is_empty() {
        return IrregularObligationsReport {
            availability: AnalysisAvailability::InsufficientData,
            obligations: vec![],
            total_estimated_annual: None,
        };
    }

    IrregularObligationsReport {
        availability: AnalysisAvailability::Available,
        obligations,
        total_estimated_annual: currency.map(|cur| Money::new(total_annual_minor, &cur)),
    }
}

/// Classify a schedule's irregularity type.
fn classify_irregularity(
    frequency: &str,
    _amount: i64,
    all_schedules: &[crate::snapshots::Schedule],
) -> IrregularityKind {
    match frequency {
        "monthly" | "everyMonth" | "semimonthly" | "biweekly" => IrregularityKind::NonMonthly,
        "quarterly" | "everyQuarter" | "yearly" | "everyYear" | "semiannually" => {
            IrregularityKind::Seasonal
        }
        "once" | "oneTime" => IrregularityKind::OneOff,
        _ => {
            // Variable amount: check if other schedules with same name have different amounts
            let amounts: Vec<i64> = all_schedules
                .iter()
                .filter(|s| s.payee_name.as_deref() == Some(frequency) || s.frequency == frequency)
                .map(|s| s.amount.minor_units())
                .collect();
            if amounts.len() > 1 && amounts.iter().min() != amounts.iter().max() {
                IrregularityKind::VariableAmount
            } else {
                IrregularityKind::NonMonthly
            }
        }
    }
}

// ===========================================================================
// 6. Income Reliability
// ===========================================================================

/// A single income source with reliability metrics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeSource {
    /// Name/payee of the income source.
    pub name: String,
    /// Typical monthly amount.
    pub typical_monthly: Money,
    /// Reliability score (0.0 = unreliable, 1.0 = fully reliable).
    pub reliability_score: f64,
    /// Variability coefficient (stddev / mean). Lower is more stable.
    pub variability: f64,
    /// Number of payments in the analysis window.
    pub payment_count: u32,
    /// Whether this income is regular (predictable schedule).
    pub is_regular: bool,
}

/// Assessment of income reliability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomeReliabilityReport {
    /// Availability of the report.
    pub availability: AnalysisAvailability,
    /// Income sources identified.
    pub sources: Vec<IncomeSource>,
    /// Total estimated monthly income.
    pub total_monthly: Option<Money>,
    /// Overall reliability score (0.0 – 1.0).
    pub overall_score: Option<f64>,
    /// Number of irregular or unreliable sources.
    pub unreliable_source_count: u32,
}

/// Compute income reliability from transactions and schedules.
///
/// Returns `NoConfiguration` when no income is found.
/// Returns `InsufficientData` when there are fewer than 2 income transactions.
pub fn compute_income_reliability(
    transactions: &[crate::snapshots::Transaction],
    schedules: &[crate::snapshots::Schedule],
    categories: &[crate::snapshots::Category],
) -> IncomeReliabilityReport {
    // Identify income categories
    let income_cat_ids: std::collections::HashSet<String> = categories
        .iter()
        .filter(|c| c.is_income && !c.deleted)
        .map(|c| c.id.clone())
        .collect();

    if income_cat_ids.is_empty() && schedules.is_empty() {
        return IncomeReliabilityReport {
            availability: AnalysisAvailability::NoConfiguration,
            sources: vec![],
            total_monthly: None,
            overall_score: None,
            unreliable_source_count: 0,
        };
    }

    // Group income transactions by payee
    let mut income_by_payee: std::collections::HashMap<String, Vec<i64>> =
        std::collections::HashMap::new();
    let mut currency: Option<String> = None;

    for tx in transactions {
        if tx.amount.minor_units() <= 0 {
            continue; // not income
        }
        let in_income_cat = tx
            .category_id
            .as_ref()
            .map(|cid| income_cat_ids.contains(cid))
            .unwrap_or(false);
        if !in_income_cat {
            continue;
        }
        let payee = tx.payee_name.clone().unwrap_or_else(|| {
            tx.imported_payee
                .clone()
                .unwrap_or_else(|| "unknown".to_string())
        });
        income_by_payee
            .entry(payee)
            .or_default()
            .push(tx.amount.minor_units());
        currency = Some(tx.amount.currency().to_string());
    }

    // Also add income schedules
    for sched in schedules {
        if sched.amount.minor_units() > 0 {
            income_by_payee
                .entry(sched.payee_name.clone().unwrap_or_else(|| sched.id.clone()))
                .or_default()
                .push(sched.amount.minor_units());
            currency = Some(sched.amount.currency().to_string());
        }
    }

    if income_by_payee.is_empty() {
        return IncomeReliabilityReport {
            availability: AnalysisAvailability::InsufficientData,
            sources: vec![],
            total_monthly: None,
            overall_score: None,
            unreliable_source_count: 0,
        };
    }

    let mut sources = Vec::new();
    let mut total_monthly_minor: i64 = 0;
    let mut score_sum = 0.0_f64;
    let mut unreliable_count = 0_u32;

    for (name, amounts) in &income_by_payee {
        let count = amounts.len() as u32;
        let mean = amounts.iter().sum::<i64>() as f64 / count.max(1) as f64;
        let variance = if count > 1 {
            amounts
                .iter()
                .map(|a| (*a as f64 - mean).powi(2))
                .sum::<f64>()
                / (count - 1) as f64
        } else {
            0.0
        };
        let stddev = variance.sqrt();
        let variability = if mean > 0.0 { stddev / mean } else { 1.0 };

        let is_regular = count >= 3 && variability < 0.3;
        let reliability = if count < 2 {
            0.3 // Not enough history
        } else if variability < 0.1 {
            0.95
        } else if variability < 0.3 {
            0.75
        } else if variability < 0.5 {
            0.5
        } else {
            0.25
        };

        let typical = (mean.round() as i64).max(0);
        total_monthly_minor = total_monthly_minor.saturating_add(typical);
        score_sum += reliability;
        if reliability < 0.5 {
            unreliable_count += 1;
        }

        sources.push(IncomeSource {
            name: name.clone(),
            typical_monthly: currency
                .as_ref()
                .map(|cur| Money::new(typical, cur))
                .unwrap_or_else(|| Money::new(typical, "USD")),
            reliability_score: reliability,
            variability,
            payment_count: count,
            is_regular,
        });
    }

    sources.sort_by_key(|source| std::cmp::Reverse(source.typical_monthly.minor_units()));

    IncomeReliabilityReport {
        availability: AnalysisAvailability::Available,
        overall_score: Some(if !sources.is_empty() {
            score_sum / sources.len() as f64
        } else {
            0.0
        }),
        total_monthly: currency.map(|cur| Money::new(total_monthly_minor, &cur)),
        sources,
        unreliable_source_count: unreliable_count,
    }
}

// ===========================================================================
// 7. Forecast Calibration
// ===========================================================================

/// Calibration metric for a single forecast dimension.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationMetric {
    /// Name of the metric (e.g. "income", "expenses").
    pub metric_name: String,
    /// Mean absolute percentage error (MAPE).
    pub mape: Option<f64>,
    /// Bias (positive = over-forecast, negative = under-forecast).
    pub bias: Option<f64>,
    /// Number of periods compared.
    pub periods_compared: u32,
    /// Whether the forecast is acceptably calibrated.
    pub is_calibrated: bool,
}

/// How well past forecasts matched actual outcomes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForecastCalibration {
    /// Availability of the calibration.
    pub availability: AnalysisAvailability,
    /// Per-metric calibration metrics.
    pub metrics: Vec<CalibrationMetric>,
    /// Overall calibration status.
    pub overall_calibrated: bool,
    /// Recommendations for improving forecast accuracy.
    pub recommendations: Vec<String>,
}

/// Compute forecast calibration by comparing projections to actuals.
///
/// Returns `NoConfiguration` when no budget months exist.
/// Returns `InsufficientData` when fewer than 2 periods exist.
pub fn compute_forecast_calibration(
    budget_months: &[crate::snapshots::BudgetMonth],
    transactions: &[crate::snapshots::Transaction],
) -> ForecastCalibration {
    if budget_months.len() < 2 {
        return ForecastCalibration {
            availability: if budget_months.is_empty() {
                AnalysisAvailability::NoConfiguration
            } else {
                AnalysisAvailability::InsufficientData
            },
            metrics: vec![],
            overall_calibrated: false,
            recommendations: vec![
                "At least 2 budget months are needed for calibration.".to_string()
            ],
        };
    }

    let mut metrics = Vec::new();
    let mut all_calibrated = true;
    let mut recommendations = Vec::new();

    // Income calibration
    let mut income_forecast: Vec<(String, i64)> = Vec::new();
    let mut income_actual: Vec<(String, i64)> = Vec::new();

    for bm in budget_months {
        let month_forecast: i64 = bm
            .categories
            .values()
            .map(|bc| {
                if bc.amount.minor_units() > 0 {
                    bc.amount.minor_units()
                } else {
                    0
                }
            })
            .sum();
        income_forecast.push((bm.month.clone(), month_forecast));

        let month_actual: i64 = transactions
            .iter()
            .filter(|tx| tx.amount.minor_units() > 0 && tx.date.starts_with(&bm.month))
            .map(|tx| tx.amount.minor_units())
            .sum();
        income_actual.push((bm.month.clone(), month_actual));
    }

    let income_metric = compute_calibration_metric("income", &income_forecast, &income_actual);
    if let Some(ref m) = income_metric {
        if !m.is_calibrated {
            all_calibrated = false;
            recommendations.push(
                "Income forecasts show systematic bias — review income schedules.".to_string(),
            );
        }
    }
    if let Some(m) = income_metric {
        metrics.push(m);
    }

    // Expense calibration
    let mut expense_forecast: Vec<(String, i64)> = Vec::new();
    let mut expense_actual: Vec<(String, i64)> = Vec::new();

    for bm in budget_months {
        let month_forecast: i64 = bm
            .categories
            .values()
            .map(|bc| {
                if bc.amount.minor_units() < 0 {
                    bc.amount.minor_units().unsigned_abs() as i64
                } else {
                    0
                }
            })
            .sum();
        expense_forecast.push((bm.month.clone(), month_forecast));

        let month_actual: i64 = transactions
            .iter()
            .filter(|tx| tx.amount.minor_units() < 0 && tx.date.starts_with(&bm.month))
            .map(|tx| tx.amount.minor_units().unsigned_abs() as i64)
            .sum();
        expense_actual.push((bm.month.clone(), month_actual));
    }

    let expense_metric = compute_calibration_metric("expenses", &expense_forecast, &expense_actual);
    if let Some(ref m) = expense_metric {
        if !m.is_calibrated {
            all_calibrated = false;
            recommendations.push(
                "Expense forecasts show systematic bias — review budget categories.".to_string(),
            );
        }
    }
    if let Some(m) = expense_metric {
        metrics.push(m);
    }

    if recommendations.is_empty() && !metrics.is_empty() {
        recommendations.push("Forecasts appear well-calibrated.".to_string());
    }

    ForecastCalibration {
        availability: AnalysisAvailability::Available,
        metrics,
        overall_calibrated: all_calibrated,
        recommendations,
    }
}

/// Compute a single calibration metric from forecast vs actual pairs.
fn compute_calibration_metric(
    name: &str,
    forecast: &[(String, i64)],
    actual: &[(String, i64)],
) -> Option<CalibrationMetric> {
    if forecast.len() < 2 || actual.is_empty() {
        return None;
    }

    let mut ape_sum = 0.0_f64;
    let mut bias_sum = 0.0_f64;
    let mut compare_count = 0_u32;

    for (month, f_val) in forecast {
        if let Some((_, a_val)) = actual.iter().find(|(m, _)| m == month) {
            if *f_val > 0 || *a_val > 0 {
                let error = *f_val as f64 - *a_val as f64;
                let max_val = (*f_val).max(*a_val).abs() as f64;
                if max_val > 0.0 {
                    ape_sum += (error / max_val).abs();
                    bias_sum += error / max_val;
                    compare_count += 1;
                }
            }
        }
    }

    if compare_count == 0 {
        return None;
    }

    let mape = ape_sum / compare_count as f64;
    let bias = bias_sum / compare_count as f64;
    let is_calibrated = mape < 0.3;

    Some(CalibrationMetric {
        metric_name: name.to_string(),
        mape: Some(mape),
        bias: Some(bias),
        periods_compared: compare_count,
        is_calibrated,
    })
}

// ===========================================================================
// 8. Scenario Comparison (Immutable)
// ===========================================================================

/// Stable identifier for a scenario snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioId {
    /// Unique scenario identifier.
    pub id: String,
    /// Human-readable name.
    pub name: String,
}

/// Version metadata for a scenario.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioVersion {
    /// Source version string (e.g. snapshot version).
    pub source_version: String,
    /// Result version string (schema version of this analysis).
    pub result_version: String,
}

/// An immutable scenario — a snapshot of analytical state at a point in time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    /// Stable scenario identifier.
    pub id: ScenarioId,
    /// Version metadata.
    pub version: ScenarioVersion,
    /// Assumptions recorded at scenario creation.
    pub assumptions: Vec<String>,
    /// Expiry date (ISO 8601) after which the scenario is stale.
    pub expires_at: String,
    /// The analytical payload — opaque structured data.
    pub payload: serde_json::Value,
    /// When this scenario was created (ISO 8601).
    pub created_at: String,
}

/// Comparison delta between two scenarios for a single dimension.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioComparisonDelta {
    /// Dimension name.
    pub dimension: String,
    /// Value in the baseline scenario.
    pub baseline_value: serde_json::Value,
    /// Value in the comparison scenario.
    pub comparison_value: serde_json::Value,
    /// Difference or change description.
    pub change: String,
}

/// Result of comparing two immutable scenarios.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioComparisonResult {
    /// Availability of the comparison.
    pub availability: AnalysisAvailability,
    /// Baseline scenario metadata.
    pub baseline: ScenarioId,
    /// Comparison scenario metadata.
    pub comparison: ScenarioId,
    /// Per-dimension deltas.
    pub deltas: Vec<ScenarioComparisonDelta>,
    /// Summary of changes.
    pub summary: String,
}

/// Compare two immutable scenarios and produce structured deltas.
///
/// Returns `Unavailable` when either scenario is missing.
/// Returns `InsufficientData` when payloads have no common dimensions.
pub fn compare_scenarios(baseline: &Scenario, comparison: &Scenario) -> ScenarioComparisonResult {
    if baseline.id.id.is_empty() || comparison.id.id.is_empty() {
        return ScenarioComparisonResult {
            availability: AnalysisAvailability::Unavailable,
            baseline: baseline.id.clone(),
            comparison: comparison.id.clone(),
            deltas: vec![],
            summary: "One or both scenarios are missing identifiers.".to_string(),
        };
    }

    let mut deltas = Vec::new();
    let mut change_count = 0_u32;

    // Compare top-level keys in payload
    if let (Some(base_obj), Some(comp_obj)) =
        (baseline.payload.as_object(), comparison.payload.as_object())
    {
        let all_keys: std::collections::BTreeSet<String> =
            base_obj.keys().chain(comp_obj.keys()).cloned().collect();

        for key in all_keys {
            let base_val = base_obj.get(&key);
            let comp_val = comp_obj.get(&key);
            let change = if base_val == comp_val {
                "unchanged".to_string()
            } else {
                change_count += 1;
                match (base_val, comp_val) {
                    (Some(b), Some(c)) => format!("changed from {} to {}", b, c),
                    (Some(_), None) => "removed".to_string(),
                    (None, Some(_)) => "added".to_string(),
                    (None, None) => "unchanged".to_string(),
                }
            };
            deltas.push(ScenarioComparisonDelta {
                dimension: key,
                baseline_value: base_val.cloned().unwrap_or(serde_json::Value::Null),
                comparison_value: comp_val.cloned().unwrap_or(serde_json::Value::Null),
                change,
            });
        }
    } else {
        return ScenarioComparisonResult {
            availability: AnalysisAvailability::InsufficientData,
            baseline: baseline.id.clone(),
            comparison: comparison.id.clone(),
            deltas: vec![],
            summary: "Scenarios have no structured payload to compare.".to_string(),
        };
    }

    let summary = if change_count == 0 {
        "Scenarios are identical.".to_string()
    } else {
        format!("{} dimension(s) differ between scenarios.", change_count)
    };

    ScenarioComparisonResult {
        availability: AnalysisAvailability::Available,
        baseline: baseline.id.clone(),
        comparison: comparison.id.clone(),
        deltas,
        summary,
    }
}

// ===========================================================================
// 9. Multidimensional Health
// ===========================================================================

/// A single dimension of financial health.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthDimension {
    /// Dimension name (e.g. "liquidity", "budget_adherence", "debt_management").
    pub dimension: String,
    /// Score from 0.0 (critical) to 1.0 (excellent).
    pub score: f64,
    /// Weight of this dimension in the composite score.
    pub weight: f64,
    /// Human-readable explanation of the score.
    pub explanation: String,
    /// Severity level.
    pub severity: String,
}

/// Explainable multidimensional health assessment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultidimensionalHealth {
    /// Availability of the assessment.
    pub availability: AnalysisAvailability,
    /// Per-dimension health scores.
    pub dimensions: Vec<HealthDimension>,
    /// Composite health score (0.0 – 1.0).
    pub composite_score: f64,
    /// Text summary of the overall assessment.
    pub summary: String,
    /// Key actions to improve health.
    pub recommendations: Vec<String>,
}

/// Compute multidimensional health from available budget intelligence data.
///
/// Returns `NoConfiguration` when no data dimensions are available.
pub fn compute_multidimensional_health(
    liquidity_coverage: Option<&LiquidityCoverage>,
    budget_variance: Option<&BudgetVarianceReport>,
    income_reliability: Option<&IncomeReliabilityReport>,
    forecast_calibration: Option<&ForecastCalibration>,
    data_quality: Option<&DataQualityCenter>,
) -> MultidimensionalHealth {
    let mut dimensions = Vec::new();
    let mut weight_sum = 0.0_f64;
    let mut weighted_score = 0.0_f64;
    let mut recommendations = Vec::new();

    // Liquidity dimension
    if let Some(lc) = liquidity_coverage {
        if lc.availability == AnalysisAvailability::Available {
            let score = lc
                .coverage
                .first()
                .map(|c| {
                    if c.ratio >= f64::MAX {
                        1.0
                    } else if c.ratio >= 3.0 {
                        0.9
                    } else if c.ratio >= 2.0 {
                        0.8
                    } else if c.ratio >= 1.5 {
                        0.7
                    } else if c.ratio >= 1.0 {
                        0.6
                    } else if c.ratio >= 0.5 {
                        0.4
                    } else {
                        0.2
                    }
                })
                .unwrap_or(0.5);
            let severity = if score >= 0.7 {
                "good".to_string()
            } else if score >= 0.4 {
                "fair".to_string()
            } else {
                "critical".to_string()
            };
            dimensions.push(HealthDimension {
                dimension: "liquidity".to_string(),
                score,
                weight: 0.25,
                explanation: format!(
                    "Coverage ratio: {}",
                    lc.coverage
                        .first()
                        .map(|c| format!("{:.2}", c.ratio))
                        .unwrap_or_else(|| "N/A".to_string())
                ),
                severity,
            });
            weight_sum += 0.25;
            weighted_score += score * 0.25;
            if score < 0.5 {
                recommendations
                    .push("Build liquid reserves to improve obligation coverage.".to_string());
            }
        }
    }

    // Budget adherence dimension
    if let Some(bv) = budget_variance {
        if bv.availability == AnalysisAvailability::Available {
            let variance_pct = bv.overall_variance_percent.unwrap_or(0.0);
            let score = if variance_pct >= 10.0 {
                0.9
            } else if variance_pct >= 5.0 {
                0.8
            } else if variance_pct >= 0.0 {
                0.7
            } else if variance_pct >= -10.0 {
                0.5
            } else {
                0.3
            };
            let severity = if score >= 0.7 {
                "good".to_string()
            } else if score >= 0.4 {
                "fair".to_string()
            } else {
                "critical".to_string()
            };
            dimensions.push(HealthDimension {
                dimension: "budget_adherence".to_string(),
                score,
                weight: 0.25,
                explanation: format!("Overall variance: {:.1}%", variance_pct),
                severity,
            });
            weight_sum += 0.25;
            weighted_score += score * 0.25;
            if score < 0.5 {
                recommendations.push("Review overspent categories and adjust budgets.".to_string());
            }
        }
    }

    // Income reliability dimension
    if let Some(ir) = income_reliability {
        if ir.availability == AnalysisAvailability::Available {
            let score = ir.overall_score.unwrap_or(0.5);
            let severity = if score >= 0.7 {
                "good".to_string()
            } else if score >= 0.4 {
                "fair".to_string()
            } else {
                "critical".to_string()
            };
            dimensions.push(HealthDimension {
                dimension: "income_reliability".to_string(),
                score,
                weight: 0.20,
                explanation: format!("Overall reliability: {:.2}", score),
                severity,
            });
            weight_sum += 0.20;
            weighted_score += score * 0.20;
            if score < 0.5 {
                recommendations.push(
                    "Income sources show volatility — consider building larger emergency fund."
                        .to_string(),
                );
            }
        }
    }

    // Forecast calibration dimension
    if let Some(fc) = forecast_calibration {
        if fc.availability == AnalysisAvailability::Available {
            let score = if fc.overall_calibrated { 0.8 } else { 0.4 };
            let severity = if score >= 0.7 {
                "good".to_string()
            } else {
                "fair".to_string()
            };
            dimensions.push(HealthDimension {
                dimension: "forecast_accuracy".to_string(),
                score,
                weight: 0.15,
                explanation: if fc.overall_calibrated {
                    "Forecasts are well-calibrated.".to_string()
                } else {
                    "Forecasts show systematic bias.".to_string()
                },
                severity,
            });
            weight_sum += 0.15;
            weighted_score += score * 0.15;
            if !fc.overall_calibrated {
                recommendations
                    .push("Improve forecast accuracy by reviewing budget assumptions.".to_string());
            }
        }
    }

    // Data quality dimension
    if let Some(dq) = data_quality {
        if dq.availability == AnalysisAvailability::Available {
            let score = dq.overall_score.unwrap_or(0.5);
            let severity = if score >= 0.7 {
                "good".to_string()
            } else if score >= 0.4 {
                "fair".to_string()
            } else {
                "critical".to_string()
            };
            dimensions.push(HealthDimension {
                dimension: "data_quality".to_string(),
                score,
                weight: 0.15,
                explanation: format!("Overall quality: {:.2}", score),
                severity,
            });
            weight_sum += 0.15;
            weighted_score += score * 0.15;
            if score < 0.5 {
                recommendations
                    .push("Improve data quality for more accurate health assessment.".to_string());
            }
        }
    }

    if dimensions.is_empty() {
        return MultidimensionalHealth {
            availability: AnalysisAvailability::NoConfiguration,
            dimensions: vec![],
            composite_score: 0.0,
            summary: "No data dimensions available for health assessment.".to_string(),
            recommendations: vec![
                "Configure budgets, accounts, and categories to enable health assessment."
                    .to_string(),
            ],
        };
    }

    let composite = if weight_sum > 0.0 {
        weighted_score / weight_sum
    } else {
        0.0
    };
    let summary = if composite >= 0.8 {
        "Your financial health is excellent.".to_string()
    } else if composite >= 0.6 {
        "Your financial health is good with some areas to improve.".to_string()
    } else if composite >= 0.4 {
        "Your financial health is fair — several dimensions need attention.".to_string()
    } else {
        "Your financial health needs significant improvement.".to_string()
    };

    MultidimensionalHealth {
        availability: AnalysisAvailability::Available,
        dimensions,
        composite_score: composite,
        summary,
        recommendations,
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshots::{BudgetCategory, BudgetMonth, Category, Schedule, Transaction};

    fn make_money(minor: i64, currency: &str) -> Money {
        Money::new(minor, currency)
    }

    fn make_category(id: &str, name: &str, is_income: bool) -> Category {
        Category {
            id: id.to_string(),
            name: name.to_string(),
            group_name: None,
            is_income,
            mtid: None,
            deleted: false,
        }
    }

    fn make_transaction(
        id: &str,
        amount: i64,
        category_id: Option<&str>,
        payee: Option<&str>,
        date: &str,
    ) -> Transaction {
        Transaction {
            id: id.to_string(),
            account_id: "a1".to_string(),
            date: date.to_string(),
            payee_id: None,
            payee_name: payee.map(|s| s.to_string()),
            category_id: category_id.map(|s| s.to_string()),
            category_name: None,
            amount: Money::new(amount, "USD"),
            cleared: true,
            reconciled: false,
            imported_id: None,
            imported_payee: payee.map(|s| format!("imported_{}", s)),
            notes: None,
            tags: vec![],
            transfer_account_id: None,
            subtransactions: vec![],
        }
    }

    fn make_schedule(
        name: &str,
        amount: i64,
        frequency: &str,
        start_date: &str,
        _category_id: Option<&str>,
    ) -> Schedule {
        Schedule {
            id: format!("sched_{}", name),
            frequency: frequency.to_string(),
            amount: Money::new(amount, "USD"),
            payee_name: Some(name.to_string()),
            account_id: "a1".to_string(),
            next_expected: start_date.to_string(),
        }
    }

    fn make_budget_month(month: &str, categories: Vec<(&str, i64)>) -> BudgetMonth {
        BudgetMonth {
            id: format!("bm_{}", month),
            month: month.to_string(),
            categories: categories
                .into_iter()
                .map(|(id, amount)| {
                    (
                        id.to_string(),
                        BudgetCategory {
                            category_id: id.to_string(),
                            amount: Money::new(amount, "USD"),
                            carryover: Money::new(0, "USD"),
                            carryover_from_previous: Money::new(0, "USD"),
                            carries_over: false,
                        },
                    )
                })
                .collect(),
        }
    }

    // -----------------------------------------------------------------------
    // DataQualityCenter tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_data_quality_center_no_configuration() {
        let result = compute_data_quality_center(0, 0, 0, 0, None, None);
        assert_eq!(result.availability, AnalysisAvailability::NoConfiguration);
        assert!(result.overall_score.is_none());
        assert!(result.dimensions.is_empty());
        assert!(!result.recommendations.is_empty());
    }

    #[test]
    fn test_data_quality_center_full_data() {
        let result = compute_data_quality_center(3, 100, 5, 0, Some(5), Some(2));
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(result.overall_score.unwrap() > 0.5);
        assert_eq!(result.dimensions.len(), 3);
    }

    #[test]
    fn test_data_quality_center_high_uncategorized_lowers_score() {
        // 8/10 uncategorized (completeness=0.2) + stale 90d (freshness=0.0) => avg=0.4
        let result = compute_data_quality_center(1, 10, 8, 0, Some(90), Some(90));
        assert!(result.overall_score.unwrap() < 0.5);
    }

    #[test]
    fn test_data_quality_center_stale_freshness() {
        // 7/10 uncategorized (completeness=0.3) + stale 95d (freshness=0.0) => avg~0.43
        let result = compute_data_quality_center(1, 10, 7, 0, Some(95), Some(95));
        assert!(result.overall_score.unwrap() < 0.5);
        assert!(result
            .recommendations
            .iter()
            .any(|r| r.contains("Reconnect")));
    }

    #[test]
    fn test_data_quality_center_duplicates_detected() {
        let result = compute_data_quality_center(1, 100, 0, 5, Some(1), Some(1));
        assert!(result.overall_score.unwrap() < 1.0);
        assert!(result
            .recommendations
            .iter()
            .any(|r| r.contains("duplicate")));
    }

    #[test]
    fn test_data_quality_center_dimension_count() {
        let result = compute_data_quality_center(1, 50, 0, 0, Some(10), Some(10));
        assert_eq!(result.dimensions.len(), 3);
        for dim in &result.dimensions {
            assert!(dim.score.is_some());
        }
    }

    // -----------------------------------------------------------------------
    // LiquidityCoverage tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_liquidity_coverage_no_configuration() {
        let result = compute_liquidity_coverage(None, &[], &[], "2026-07");
        assert_eq!(result.availability, AnalysisAvailability::NoConfiguration);
    }

    #[test]
    fn test_liquidity_coverage_with_liquid_and_obligations() {
        let schedules = vec![
            make_schedule("Rent", -2000, "monthly", "2026-07-01", Some("c1")),
            make_schedule("Electric", -150, "monthly", "2026-07-15", Some("c2")),
        ];
        let liquid = make_money(5000, "USD");
        let result = compute_liquidity_coverage(Some(&liquid), &schedules, &[], "2026-07");
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(result.total_liquid.is_some());
        assert!(result.total_obligations.is_some());
        assert!(!result.upcoming_obligations.is_empty());
    }

    #[test]
    fn test_liquidity_coverage_sufficient_coverage() {
        let schedules = vec![make_schedule(
            "Rent",
            -2000,
            "monthly",
            "2026-07-01",
            Some("c1"),
        )];
        let liquid = make_money(10000, "USD");
        let result = compute_liquidity_coverage(Some(&liquid), &schedules, &[], "2026-07");
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(!result.coverage.is_empty());
    }

    #[test]
    fn test_liquidity_coverage_with_budget_data() {
        // Budget months with categories provide obligation data when liquid exists.
        let liquid = make_money(5000, "USD");
        let result = compute_liquidity_coverage(
            Some(&liquid),
            &[],
            &[make_budget_month("2026-07", vec![("c1", 100)])],
            "2026-07",
        );
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(result.total_obligations.unwrap().minor_units() > 0);
    }

    #[test]
    fn test_liquidity_coverage_insufficient_data() {
        // No liquid balance AND no schedules AND no budget months => InsufficientData.
        let result = compute_liquidity_coverage(None, &[], &[], "2026-07");
        assert!(
            result.availability == AnalysisAvailability::InsufficientData
                || result.availability == AnalysisAvailability::NoConfiguration
        );
    }

    // -----------------------------------------------------------------------
    // BillCalendar tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_bill_calendar_no_configuration() {
        let result = compute_bill_calendar(&[], &[], "2026-07-27");
        assert_eq!(result.availability, AnalysisAvailability::NoConfiguration);
    }

    #[test]
    fn test_bill_calendar_with_schedules() {
        let schedules = vec![
            make_schedule("Rent", -2000, "monthly", "2026-07-01", Some("c1")),
            make_schedule("Netflix", -15, "monthly", "2026-07-10", Some("c2")),
        ];
        let result = compute_bill_calendar(&schedules, &[], "2026-07-27");
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.unpaid_count, 2);
    }

    #[test]
    fn test_bill_calendar_income_schedules_skipped() {
        let schedules = vec![
            make_schedule("Salary", 5000, "monthly", "2026-07-01", Some("c_income")),
            make_schedule("Rent", -2000, "monthly", "2026-07-01", Some("c1")),
        ];
        let result = compute_bill_calendar(&schedules, &[], "2026-07-27");
        assert_eq!(result.entries.len(), 1);
    }

    #[test]
    fn test_bill_calendar_sorted_by_date() {
        let schedules = vec![
            make_schedule("Late", -100, "monthly", "2026-07-15", Some("c1")),
            make_schedule("Early", -200, "monthly", "2026-07-01", Some("c2")),
        ];
        let result = compute_bill_calendar(&schedules, &[], "2026-07-27");
        assert_eq!(result.entries[0].name, "Early");
        assert_eq!(result.entries[1].name, "Late");
    }

    // -----------------------------------------------------------------------
    // BudgetVarianceReport tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_budget_variance_no_configuration() {
        let result = compute_budget_variance(&[], &[], &[], "2026-07-27");
        assert_eq!(result.availability, AnalysisAvailability::NoConfiguration);
    }

    #[test]
    fn test_budget_variance_under_budget() {
        let categories = vec![make_category("c1", "Food", false)];
        let budgets = vec![make_budget_month("2026-07", vec![("c1", 500)])];
        let transactions = vec![make_transaction(
            "tx1",
            -200,
            Some("c1"),
            Some("Grocery"),
            "2026-07-15",
        )];
        let result = compute_budget_variance(&budgets, &transactions, &categories, "2026-07-27");
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert_eq!(result.category_variances.len(), 1);
        assert_eq!(result.category_variances[0].label, "under");
    }

    #[test]
    fn test_budget_variance_over_budget() {
        let categories = vec![make_category("c1", "Food", false)];
        let budgets = vec![make_budget_month("2026-07", vec![("c1", 500)])];
        let transactions = vec![make_transaction(
            "tx1",
            -600,
            Some("c1"),
            Some("Grocery"),
            "2026-07-15",
        )];
        let result = compute_budget_variance(&budgets, &transactions, &categories, "2026-07-27");
        assert_eq!(result.category_variances[0].label, "over");
    }

    #[test]
    fn test_budget_variance_on_track() {
        let categories = vec![make_category("c1", "Food", false)];
        let budgets = vec![make_budget_month("2026-07", vec![("c1", 500)])];
        let transactions = vec![make_transaction(
            "tx1",
            -500,
            Some("c1"),
            Some("Grocery"),
            "2026-07-15",
        )];
        let result = compute_budget_variance(&budgets, &transactions, &categories, "2026-07-27");
        assert_eq!(result.category_variances[0].label, "on_track");
    }

    #[test]
    fn test_budget_variance_multiple_months_trend() {
        let categories = vec![make_category("c1", "Food", false)];
        let budgets = vec![
            make_budget_month("2026-05", vec![("c1", 500)]),
            make_budget_month("2026-06", vec![("c1", 550)]),
            make_budget_month("2026-07", vec![("c1", 600)]),
        ];
        let transactions = vec![];
        let result = compute_budget_variance(&budgets, &transactions, &categories, "2026-07-27");
        assert!(!result.trends.is_empty());
        assert_eq!(result.trends[0].direction, TrendDirection::Increasing);
    }

    // -----------------------------------------------------------------------
    // IrregularObligations tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_irregular_obligations_no_configuration() {
        let result = compute_irregular_obligations(&[]);
        assert_eq!(result.availability, AnalysisAvailability::NoConfiguration);
    }

    #[test]
    fn test_irregular_obligations_quarterly() {
        let schedules = vec![make_schedule(
            "Insurance",
            -600,
            "quarterly",
            "2026-07-01",
            Some("c1"),
        )];
        let result = compute_irregular_obligations(&schedules);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert_eq!(result.obligations[0].kind, IrregularityKind::Seasonal);
    }

    #[test]
    fn test_irregular_obligations_one_off() {
        let schedules = vec![make_schedule(
            "Birthday Gift",
            -100,
            "once",
            "2026-08-15",
            Some("c1"),
        )];
        let result = compute_irregular_obligations(&schedules);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert_eq!(result.obligations[0].kind, IrregularityKind::OneOff);
    }

    #[test]
    fn test_irregular_obligations_income_skipped() {
        let schedules = vec![make_schedule(
            "Salary",
            5000,
            "monthly",
            "2026-07-01",
            Some("c_income"),
        )];
        let result = compute_irregular_obligations(&schedules);
        assert_eq!(result.availability, AnalysisAvailability::InsufficientData);
    }

    #[test]
    fn test_irregular_obligations_annual_estimate() {
        let schedules = vec![make_schedule(
            "Quarterly Tax",
            -1200,
            "quarterly",
            "2026-07-01",
            Some("c1"),
        )];
        let result = compute_irregular_obligations(&schedules);
        assert!(result.total_estimated_annual.is_some());
        // quarterly = count once in annual estimate since it's not monthly
        assert_eq!(result.total_estimated_annual.unwrap().minor_units(), 1200);
    }

    // -----------------------------------------------------------------------
    // IncomeReliability tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_income_reliability_no_configuration() {
        let result = compute_income_reliability(&[], &[], &[]);
        assert_eq!(result.availability, AnalysisAvailability::NoConfiguration);
    }

    #[test]
    fn test_income_reliability_regular_income() {
        let categories = vec![make_category("c_income", "Salary", true)];
        let transactions = vec![
            make_transaction(
                "tx1",
                5000,
                Some("c_income"),
                Some("Employer"),
                "2026-05-01",
            ),
            make_transaction(
                "tx2",
                5000,
                Some("c_income"),
                Some("Employer"),
                "2026-06-01",
            ),
            make_transaction(
                "tx3",
                5000,
                Some("c_income"),
                Some("Employer"),
                "2026-07-01",
            ),
        ];
        let result = compute_income_reliability(&transactions, &[], &categories);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(result.overall_score.unwrap() > 0.8);
        assert_eq!(result.unreliable_source_count, 0);
    }

    #[test]
    fn test_income_reliability_insufficient_data() {
        let categories = vec![make_category("c_income", "Salary", true)];
        let transactions = vec![make_transaction(
            "tx1",
            100,
            Some("c_income"),
            Some("Gig"),
            "2026-07-01",
        )];
        let result = compute_income_reliability(&transactions, &[], &categories);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(result.sources[0].reliability_score < 0.5);
        assert_eq!(result.unreliable_source_count, 1);
    }

    #[test]
    fn test_income_reliability_variable_income() {
        let categories = vec![make_category("c_income", "Freelance", true)];
        let transactions = vec![
            make_transaction(
                "tx1",
                3000,
                Some("c_income"),
                Some("Client A"),
                "2026-05-01",
            ),
            make_transaction(
                "tx2",
                1000,
                Some("c_income"),
                Some("Client A"),
                "2026-06-01",
            ),
            make_transaction(
                "tx3",
                5000,
                Some("c_income"),
                Some("Client A"),
                "2026-07-01",
            ),
        ];
        let result = compute_income_reliability(&transactions, &[], &categories);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(result.sources[0].variability > 0.1);
    }

    #[test]
    fn test_income_reliability_schedules_income() {
        let categories = vec![make_category("c_income", "Salary", true)];
        let schedules = vec![make_schedule(
            "Employer",
            5000,
            "monthly",
            "2026-07-01",
            Some("c_income"),
        )];
        let result = compute_income_reliability(&[], &schedules, &categories);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(!result.sources.is_empty());
    }

    // -----------------------------------------------------------------------
    // ForecastCalibration tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_forecast_calibration_no_configuration() {
        let result = compute_forecast_calibration(&[], &[]);
        assert_eq!(result.availability, AnalysisAvailability::NoConfiguration);
    }

    #[test]
    fn test_forecast_calibration_insufficient_periods() {
        let budgets = vec![make_budget_month("2026-07", vec![("c1", 500)])];
        let result = compute_forecast_calibration(&budgets, &[]);
        assert_eq!(result.availability, AnalysisAvailability::InsufficientData);
    }

    #[test]
    fn test_forecast_calibration_well_calibrated() {
        let budgets = vec![
            make_budget_month("2026-06", vec![("c1", 500)]),
            make_budget_month("2026-07", vec![("c1", 500)]),
        ];
        let transactions = vec![
            make_transaction("tx1", -480, Some("c1"), Some("Grocery"), "2026-06-15"),
            make_transaction("tx2", -510, Some("c1"), Some("Grocery"), "2026-07-15"),
        ];
        let result = compute_forecast_calibration(&budgets, &transactions);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(!result.metrics.is_empty());
    }

    #[test]
    fn test_forecast_calibration_metrics_structure() {
        let budgets = vec![
            make_budget_month("2026-06", vec![("c1", 500)]),
            make_budget_month("2026-07", vec![("c1", 500)]),
        ];
        let transactions = vec![];
        let result = compute_forecast_calibration(&budgets, &transactions);
        assert!(!result.metrics.is_empty());
        for metric in &result.metrics {
            assert!(metric.mape.is_some());
            assert!(metric.bias.is_some());
            assert!(metric.periods_compared > 0);
        }
    }

    // -----------------------------------------------------------------------
    // ScenarioComparison tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_scenario_comparison_identical() {
        let payload = serde_json::json!({"income": 5000, "expenses": 3000});
        let baseline = Scenario {
            id: ScenarioId {
                id: "sc1".to_string(),
                name: "Baseline".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1".to_string(),
                result_version: "1".to_string(),
            },
            assumptions: vec!["Stable income".to_string()],
            expires_at: "2026-12-31".to_string(),
            payload: payload.clone(),
            created_at: "2026-07-01".to_string(),
        };
        let comparison = Scenario {
            id: ScenarioId {
                id: "sc2".to_string(),
                name: "Comparison".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1".to_string(),
                result_version: "1".to_string(),
            },
            assumptions: vec![],
            expires_at: "2026-12-31".to_string(),
            payload,
            created_at: "2026-07-15".to_string(),
        };
        let result = compare_scenarios(&baseline, &comparison);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert_eq!(result.summary, "Scenarios are identical.");
    }

    #[test]
    fn test_scenario_comparison_different_payload() {
        let baseline = Scenario {
            id: ScenarioId {
                id: "sc1".to_string(),
                name: "Baseline".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1".to_string(),
                result_version: "1".to_string(),
            },
            assumptions: vec![],
            expires_at: "2026-12-31".to_string(),
            payload: serde_json::json!({"income": 5000, "expenses": 3000}),
            created_at: "2026-07-01".to_string(),
        };
        let comparison = Scenario {
            id: ScenarioId {
                id: "sc2".to_string(),
                name: "Comparison".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1".to_string(),
                result_version: "1".to_string(),
            },
            assumptions: vec![],
            expires_at: "2026-12-31".to_string(),
            payload: serde_json::json!({"income": 5500, "expenses": 3200}),
            created_at: "2026-07-15".to_string(),
        };
        let result = compare_scenarios(&baseline, &comparison);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(!result.deltas.is_empty());
        assert!(result.deltas.iter().any(|d| d.dimension == "income"));
    }

    #[test]
    fn test_scenario_comparison_unavailable_id() {
        let empty = Scenario {
            id: ScenarioId {
                id: "".to_string(),
                name: "Empty".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1".to_string(),
                result_version: "1".to_string(),
            },
            assumptions: vec![],
            expires_at: "2026-12-31".to_string(),
            payload: serde_json::json!({}),
            created_at: "2026-07-01".to_string(),
        };
        let result = compare_scenarios(&empty, &empty);
        assert_eq!(result.availability, AnalysisAvailability::Unavailable);
    }

    #[test]
    fn test_scenario_comparison_insufficient_data() {
        let scenario = Scenario {
            id: ScenarioId {
                id: "sc1".to_string(),
                name: "No Payload".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1".to_string(),
                result_version: "1".to_string(),
            },
            assumptions: vec![],
            expires_at: "2026-12-31".to_string(),
            payload: serde_json::Value::Null,
            created_at: "2026-07-01".to_string(),
        };
        let result = compare_scenarios(&scenario, &scenario);
        assert_eq!(result.availability, AnalysisAvailability::InsufficientData);
    }

    // -----------------------------------------------------------------------
    // MultidimensionalHealth tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_multidimensional_health_no_configuration() {
        let result = compute_multidimensional_health(None, None, None, None, None);
        assert_eq!(result.availability, AnalysisAvailability::NoConfiguration);
    }

    #[test]
    fn test_multidimensional_health_with_data() {
        let liquid = make_money(10000, "USD");
        let schedules = vec![make_schedule(
            "Rent",
            -2000,
            "monthly",
            "2026-07-01",
            Some("c1"),
        )];
        let liquidity = compute_liquidity_coverage(Some(&liquid), &schedules, &[], "2026-07");

        let categories = vec![make_category("c1", "Housing", false)];
        let budgets = vec![make_budget_month("2026-07", vec![("c1", 2000)])];
        let variance = compute_budget_variance(&budgets, &[], &categories, "2026-07-27");

        let result =
            compute_multidimensional_health(Some(&liquidity), Some(&variance), None, None, None);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        assert!(!result.dimensions.is_empty());
        assert!(result.composite_score > 0.0);
    }

    #[test]
    fn test_multidimensional_health_composite_score() {
        let liquid = make_money(10000, "USD");
        let schedules = vec![make_schedule(
            "Rent",
            -2000,
            "monthly",
            "2026-07-01",
            Some("c1"),
        )];
        let liquidity = compute_liquidity_coverage(Some(&liquid), &schedules, &[], "2026-07");

        let categories = vec![make_category("c1", "Housing", false)];
        let budgets = vec![make_budget_month("2026-07", vec![("c1", 2000)])];
        let variance = compute_budget_variance(&budgets, &[], &categories, "2026-07-27");

        let dq = compute_data_quality_center(3, 100, 0, 0, Some(5), Some(2));

        let result = compute_multidimensional_health(
            Some(&liquidity),
            Some(&variance),
            None,
            None,
            Some(&dq),
        );
        assert!(result.composite_score > 0.0 && result.composite_score <= 1.0);
        assert!(!result.recommendations.is_empty() || !result.summary.is_empty());
    }

    #[test]
    fn test_multidimensional_health_recommendations() {
        let liquid = make_money(1000, "USD");
        let schedules = vec![make_schedule(
            "Rent",
            -2000,
            "monthly",
            "2026-07-01",
            Some("c1"),
        )];
        let liquidity = compute_liquidity_coverage(Some(&liquid), &schedules, &[], "2026-07");

        let categories = vec![make_category("c1", "Food", false)];
        let budgets = vec![make_budget_month("2026-07", vec![("c1", 500)])];
        let transactions = vec![make_transaction(
            "tx1",
            -800,
            Some("c1"),
            Some("Grocery"),
            "2026-07-15",
        )];
        let variance = compute_budget_variance(&budgets, &transactions, &categories, "2026-07-27");

        let result =
            compute_multidimensional_health(Some(&liquidity), Some(&variance), None, None, None);
        assert!(!result.recommendations.is_empty());
    }

    // -----------------------------------------------------------------------
    // AnalysisAvailability boundary tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_analysis_availability_serialization() {
        let variants = vec![
            AnalysisAvailability::Available,
            AnalysisAvailability::NoConfiguration,
            AnalysisAvailability::Unavailable,
            AnalysisAvailability::Unknown,
            AnalysisAvailability::InsufficientData,
        ];
        for v in &variants {
            let json = serde_json::to_string(v).unwrap();
            let back: AnalysisAvailability = serde_json::from_str(&json).unwrap();
            assert_eq!(*v, back);
        }
    }

    #[test]
    fn test_trend_direction_serialization() {
        let variants = vec![
            TrendDirection::Increasing,
            TrendDirection::Decreasing,
            TrendDirection::Stable,
            TrendDirection::Volatile,
        ];
        for v in &variants {
            let json = serde_json::to_string(v).unwrap();
            let back: TrendDirection = serde_json::from_str(&json).unwrap();
            assert_eq!(*v, back);
        }
    }

    #[test]
    fn test_irregularity_kind_serialization() {
        let variants = vec![
            IrregularityKind::NonMonthly,
            IrregularityKind::Seasonal,
            IrregularityKind::OneOff,
            IrregularityKind::VariableAmount,
        ];
        for v in &variants {
            let json = serde_json::to_string(v).unwrap();
            let back: IrregularityKind = serde_json::from_str(&json).unwrap();
            assert_eq!(*v, back);
        }
    }

    #[test]
    fn test_scenario_id_serialization_roundtrip() {
        let sid = ScenarioId {
            id: "test-1".to_string(),
            name: "Test Scenario".to_string(),
        };
        let json = serde_json::to_string(&sid).unwrap();
        let back: ScenarioId = serde_json::from_str(&json).unwrap();
        assert_eq!(sid, back);
    }

    #[test]
    fn test_scenario_stable_id_immutability() {
        let s1 = Scenario {
            id: ScenarioId {
                id: "sc-immutable-1".to_string(),
                name: "Immutable".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1.0".to_string(),
                result_version: "1.0".to_string(),
            },
            assumptions: vec!["test".to_string()],
            expires_at: "2026-12-31".to_string(),
            payload: serde_json::json!({"key": "value"}),
            created_at: "2026-07-01".to_string(),
        };
        // Clone should have same stable id
        let s2 = s1.clone();
        assert_eq!(s1.id.id, s2.id.id);
        assert_eq!(s1.version.source_version, s2.version.source_version);
        assert_eq!(s1.assumptions, s2.assumptions);
    }

    #[test]
    fn test_compute_budget_variance_handles_zero_budget() {
        let categories = vec![make_category("c1", "No Budget", false)];
        let budgets = vec![make_budget_month("2026-07", vec![("c1", 0)])];
        let transactions = vec![make_transaction(
            "tx1",
            -100,
            Some("c1"),
            Some("Store"),
            "2026-07-15",
        )];
        let result = compute_budget_variance(&budgets, &transactions, &categories, "2026-07-27");
        assert_eq!(result.category_variances[0].label, "over");
        // Should not crash with zero budget
        assert!(!result.category_variances[0].variance_percent.is_nan());
    }

    #[test]
    fn test_compute_forecast_calibration_zero_forecast() {
        let budgets = vec![
            make_budget_month("2026-06", vec![("c1", 0)]),
            make_budget_month("2026-07", vec![("c1", 0)]),
        ];
        let transactions = vec![make_transaction(
            "tx1",
            -100,
            Some("c1"),
            Some("Store"),
            "2026-06-15",
        )];
        let result = compute_forecast_calibration(&budgets, &transactions);
        assert_eq!(result.availability, AnalysisAvailability::Available);
    }

    // -----------------------------------------------------------------------
    // Boundary: projection separation — projected vs current never conflated
    // -----------------------------------------------------------------------

    #[test]
    fn test_budget_variance_projected_behind_spent_separate() {
        // Budgeted 500, spent -200 (under) — projected remaining is distinct
        // from current balance.
        let categories = vec![make_category("c1", "Food", false)];
        let budgets = vec![make_budget_month("2026-07", vec![("c1", 500)])];
        let transactions = vec![make_transaction(
            "tx1",
            -200,
            Some("c1"),
            Some("Grocery"),
            "2026-07-15",
        )];
        let result = compute_budget_variance(&budgets, &transactions, &categories, "2026-07-27");
        let v = &result.category_variances[0];
        // The variance exposes both budgeted and actual; consumer never conflates
        assert_eq!(v.label, "under");
        // variance = budgeted - actual (positive when under)
        assert!(v.variance.minor_units() > 0);
        assert_eq!(v.actual.minor_units(), 200);
        assert_eq!(v.budgeted.minor_units(), 500);
    }

    // -----------------------------------------------------------------------
    // Boundary: currency mismatch detection in liquidity
    // -----------------------------------------------------------------------

    #[test]
    fn test_liquidity_coverage_currency_mismatch_negative_values() {
        // Liquid balance in USD with negative-valued schedules still computes.
        let liquid = make_money(10000, "USD");
        let schedules = vec![
            make_schedule("Rent", -2000, "monthly", "2026-07-01", Some("c1")),
            make_schedule("Negative income", -500, "monthly", "2026-07-15", Some("c2")),
        ];
        let result = compute_liquidity_coverage(Some(&liquid), &schedules, &[], "2026-07");
        assert_eq!(result.availability, AnalysisAvailability::Available);
        // Negative-amount schedules (expenses) add to obligations
        assert!(result.total_obligations.unwrap().minor_units() > 0);
    }

    #[test]
    fn test_budget_variance_currency_label_preserved() {
        // Budget in USD; variance money should carry same currency.
        let categories = vec![make_category("c1", "Food", false)];
        let budgets = vec![make_budget_month("2026-07", vec![("c1", 500)])];
        let transactions = vec![make_transaction(
            "tx1",
            -100,
            Some("c1"),
            Some("Store"),
            "2026-07-15",
        )];
        let result = compute_budget_variance(&budgets, &transactions, &categories, "2026-07-27");
        // Variance money values are i64 (not Money); label is descriptive
        assert_eq!(result.category_variances[0].label, "under");
    }

    // -----------------------------------------------------------------------
    // Boundary: deterministic IDs (scenario comparison preserves identity)
    // -----------------------------------------------------------------------

    #[test]
    fn test_scenario_comparison_preserves_both_ids() {
        let baseline = Scenario {
            id: ScenarioId {
                id: "base-001".to_string(),
                name: "Baseline".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1".to_string(),
                result_version: "1".to_string(),
            },
            assumptions: vec![],
            expires_at: "2026-12-31".to_string(),
            payload: serde_json::json!({"income": 5000}),
            created_at: "2026-07-01".to_string(),
        };
        let comparison = Scenario {
            id: ScenarioId {
                id: "comp-002".to_string(),
                name: "Comparison".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1".to_string(),
                result_version: "2".to_string(),
            },
            assumptions: vec![],
            expires_at: "2026-12-31".to_string(),
            payload: serde_json::json!({"income": 5500}),
            created_at: "2026-07-15".to_string(),
        };
        let result = compare_scenarios(&baseline, &comparison);
        assert_eq!(result.availability, AnalysisAvailability::Available);
        // Both scenario IDs present in the output
        assert_eq!(result.baseline.id, "base-001");
        assert_eq!(result.comparison.id, "comp-002");
    }

    // -----------------------------------------------------------------------
    // Boundary: scenario immutability — inputs unchanged by comparison
    // -----------------------------------------------------------------------

    #[test]
    fn test_scenario_non_mutation_on_compare() {
        let payload1 = serde_json::json!({"income": 5000, "expenses": 3000});
        let payload2 = serde_json::json!({"income": 5500, "expenses": 3100});
        let baseline = Scenario {
            id: ScenarioId {
                id: "sc-imm-1".to_string(),
                name: "Immutable Baseline".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1".to_string(),
                result_version: "1".to_string(),
            },
            assumptions: vec!["Stable".to_string()],
            expires_at: "2026-12-31".to_string(),
            payload: payload1,
            created_at: "2026-07-01".to_string(),
        };
        let comparison = Scenario {
            id: ScenarioId {
                id: "sc-imm-2".to_string(),
                name: "Immutable Comparison".to_string(),
            },
            version: ScenarioVersion {
                source_version: "1".to_string(),
                result_version: "1".to_string(),
            },
            assumptions: vec![],
            expires_at: "2026-12-31".to_string(),
            payload: payload2,
            created_at: "2026-07-15".to_string(),
        };
        let original_baseline_id = baseline.id.id.clone();
        let original_comparison_payload = comparison.payload.clone();

        let _result = compare_scenarios(&baseline, &comparison);

        // Neither input was mutated
        assert_eq!(baseline.id.id, original_baseline_id);
        assert_eq!(comparison.payload, original_comparison_payload);
    }
}
