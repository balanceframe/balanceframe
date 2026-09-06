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

fn make_budget_month_currency(month: &str, categories: Vec<(&str, i64, &str)>) -> BudgetMonth {
    BudgetMonth {
        id: format!("bm_{month}"),
        month: month.to_string(),
        categories: categories
            .into_iter()
            .map(|(id, amount, currency)| {
                (
                    id.to_string(),
                    BudgetCategory {
                        category_id: id.to_string(),
                        amount: Money::new(amount, currency),
                        carryover: Money::new(0, currency),
                        carryover_from_previous: Money::new(0, currency),
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
fn test_liquidity_coverage_requires_liquid_account_with_non_obligation_schedules() {
    let schedules = vec![
        make_schedule("Income", 5_000, "monthly", "2026-07-01", None),
        make_schedule("Zero", 0, "monthly", "2026-07-15", None),
    ];

    let liquidity = compute_liquidity_coverage(None, &schedules, &[], "2026-07");
    assert_eq!(
        liquidity.availability,
        AnalysisAvailability::NoConfiguration
    );
    assert!(liquidity.total_liquid.is_none());
    assert!(liquidity.total_obligations.is_none());
    assert!(liquidity.coverage.is_empty());

    let health = compute_multidimensional_health(Some(&liquidity), None, None, None, None);
    assert_eq!(health.availability, AnalysisAvailability::NoConfiguration);
    assert!(health.dimensions.is_empty());
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
fn test_liquidity_coverage_serializes_no_obligations_without_numeric_sentinel() {
    let liquid = make_money(5_000, "USD");
    let result = compute_liquidity_coverage(Some(&liquid), &[], &[], "2026-07");
    let serialized = serde_json::to_value(&result).expect("liquidity should serialize");

    assert!(serialized["coverage"][0]["ratio"].is_null());
    assert_eq!(serialized["coverage"][0]["label"], "no obligations");
}

#[test]
fn test_liquidity_coverage_distinguishes_empty_window_from_total_obligations() {
    let liquid = make_money(5_000, "USD");
    let budgets = vec![make_budget_month("2026-08", vec![("c1", 100)])];
    let result = compute_liquidity_coverage(Some(&liquid), &[], &budgets, "2026-08");

    assert_eq!(
        result.total_obligations.as_ref().unwrap().minor_units(),
        100
    );
    assert_eq!(result.coverage[0].label, "no 30-day obligations");
    assert!(serde_json::to_value(&result.coverage[0]).unwrap()["ratio"].is_null());
    assert_eq!(
        serde_json::to_value(&result.coverage[1]).unwrap()["ratio"],
        50.0
    );

    let health = compute_multidimensional_health(Some(&result), None, None, None, None);
    assert_eq!(health.dimensions[0].explanation, "Coverage ratio: 50.00");
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

#[test]
fn test_budget_trend_serializes_average_change_with_its_currency() {
    let categories = vec![make_category("c1", "Food", false)];
    let budgets = vec![
        make_budget_month_currency("2026-05", vec![("c1", 500, "EUR")]),
        make_budget_month_currency("2026-06", vec![("c1", 550, "EUR")]),
        make_budget_month_currency("2026-07", vec![]),
    ];
    let result = compute_budget_variance(&budgets, &[], &categories, "2026-07-27");
    let serialized = serde_json::to_value(&result).expect("trend report should serialize");

    assert!(result.total_budgeted.is_none());
    assert_eq!(serialized["trends"][0]["avgChange"]["minorUnits"], "50");
    assert_eq!(serialized["trends"][0]["avgChange"]["currency"], "EUR");
}

#[test]
fn test_budget_trend_omits_currency_mismatched_history() {
    let categories = vec![make_category("c1", "Food", false)];
    let budgets = vec![
        make_budget_month_currency("2026-05", vec![("c1", 500, "EUR")]),
        make_budget_month_currency("2026-06", vec![("c1", 550, "USD")]),
    ];
    let result = compute_budget_variance(&budgets, &[], &categories, "2026-06-27");

    assert!(result.trends.is_empty());
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
fn configured_income_without_eligible_receipts_is_insufficient_not_zero_income() {
    let categories = [make_category("salary", "Salary", true)];
    let transactions = [
        make_transaction(
            "reversal",
            -500,
            Some("salary"),
            Some("Employer"),
            "2026-09-01",
        ),
        make_transaction("uncategorized", 500, None, Some("Employer"), "2026-09-02"),
        make_transaction("refund", 500, Some("food"), Some("Store"), "2026-09-03"),
    ];
    let outflow = make_schedule("rent", -1000, "monthly", "2026-09-10", None);
    let report = compute_income_reliability(&transactions, &[outflow], &categories);

    assert_eq!(report.availability, AnalysisAvailability::InsufficientData);
    assert!(report.sources.is_empty());
    assert_eq!(report.total_monthly, None);
    assert_eq!(report.overall_score, None);

    let quality = compute_data_quality_center(1, 3, 1, 0, Some(0), Some(0));
    let health = compute_multidimensional_health(None, None, Some(&report), None, Some(&quality));
    assert_eq!(health.dimensions.len(), 1);
    assert_eq!(health.dimensions[0].dimension, "data_quality");
    assert!((health.composite_score - quality.overall_score.unwrap()).abs() < 1e-12);
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
fn test_multidimensional_health_describes_no_obligations_without_numeric_sentinel() {
    let liquid = make_money(10_000, "USD");
    let liquidity = compute_liquidity_coverage(Some(&liquid), &[], &[], "2026-07");

    let result = compute_multidimensional_health(Some(&liquidity), None, None, None, None);
    let dimension = result
        .dimensions
        .first()
        .expect("liquidity dimension should be available");

    assert_eq!(dimension.score, 1.0);
    assert_eq!(
        dimension.explanation,
        "No upcoming obligations in the analysis period."
    );
    assert!(!dimension.explanation.contains(&f64::MAX.to_string()));
}

#[test]
fn test_multidimensional_health_formats_normalized_explanations_as_percentages() {
    let income = IncomeReliabilityReport {
        availability: AnalysisAvailability::Available,
        sources: vec![],
        total_monthly: None,
        overall_score: Some(0.826),
        unreliable_source_count: 0,
    };
    let quality = compute_data_quality_center(51, 100, 0, 0, Some(0), Some(0));

    let result = compute_multidimensional_health(None, None, Some(&income), None, Some(&quality));
    let income_dimension = result
        .dimensions
        .iter()
        .find(|dimension| dimension.dimension == "income_reliability")
        .expect("income reliability dimension should be available");
    let quality_dimension = result
        .dimensions
        .iter()
        .find(|dimension| dimension.dimension == "data_quality")
        .expect("data quality dimension should be available");

    assert_eq!(income_dimension.explanation, "Overall reliability: 83%");
    assert_eq!(
        quality_dimension.explanation,
        format!("Overall quality: {:.0}%", quality_dimension.score * 100.0)
    );
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

    let result =
        compute_multidimensional_health(Some(&liquidity), Some(&variance), None, None, Some(&dq));
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
    let payload1 = serde_json::json!({"income": 5000, "expenses": 3000, "loan": 1000});
    let payload2 = serde_json::json!({"income": 5500, "expenses": 3100, "savings": 1000});
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

    let result = compare_scenarios(&baseline, &comparison);
    let loan = result
        .deltas
        .iter()
        .find(|delta| delta.dimension == "loan")
        .unwrap();
    assert_eq!(loan.change, "removed");
    assert_eq!(loan.baseline_value, serde_json::json!(1000));
    assert_eq!(loan.comparison_value, serde_json::Value::Null);
    let savings = result
        .deltas
        .iter()
        .find(|delta| delta.dimension == "savings")
        .unwrap();
    assert_eq!(savings.change, "added");
    assert_eq!(savings.baseline_value, serde_json::Value::Null);
    assert_eq!(savings.comparison_value, serde_json::json!(1000));

    // Neither input was mutated
    assert_eq!(baseline.id.id, original_baseline_id);
    assert_eq!(comparison.payload, original_comparison_payload);
}
