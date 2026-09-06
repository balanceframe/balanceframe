use balanceframe_financial_core::*;
use serde_json::Value;

fn transaction(id: &str, amount: i64, category: &str, date: &str) -> Transaction {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/financial-decision-foundation.json"
    ))
    .unwrap();
    let mut tx: Transaction =
        serde_json::from_value(fixture["full"]["legacySnapshot"]["transactions"][0].clone())
            .unwrap();
    tx.id = id.into();
    tx.amount = Money::new(amount, "USD");
    tx.category_id = Some(category.into());
    tx.date = date.into();
    tx.payee_name = Some(id.into());
    tx.imported_payee = None;
    tx
}

fn month(date: &str, amounts: &[(&str, i64)]) -> BudgetMonth {
    BudgetMonth {
        id: date.into(),
        month: date.into(),
        categories: amounts
            .iter()
            .map(|(id, amount)| {
                (
                    (*id).into(),
                    BudgetCategory {
                        category_id: (*id).into(),
                        amount: Money::new(*amount, "USD"),
                        carryover: Money::zero("USD"),
                        carryover_from_previous: Money::zero("USD"),
                        carries_over: false,
                    },
                )
            })
            .collect(),
    }
}

fn schedule(id: &str, amount: i64, frequency: &str) -> Schedule {
    Schedule {
        id: id.into(),
        amount: Money::new(amount, "USD"),
        frequency: frequency.into(),
        payee_name: None,
        account_id: "checking".into(),
        next_expected: "2026-09-10".into(),
    }
}

#[test]
fn quality_uses_worst_known_age_and_distinguishes_missing_configuration_from_poor_evidence() {
    let healthy = compute_data_quality_center(1, 10, 2, 1, Some(15), Some(45));
    let freshness = |report: &DataQualityCenter| {
        report
            .dimensions
            .iter()
            .find(|d| d.dimension == "freshness")
            .unwrap()
            .score
            .unwrap()
    };
    assert_eq!(freshness(&healthy), 0.5);
    assert_eq!(
        freshness(&compute_data_quality_center(1, 10, 2, 1, Some(45), None)),
        0.5
    );
    assert_eq!(
        freshness(&compute_data_quality_center(1, 10, 2, 1, None, Some(45))),
        0.5
    );
    assert_eq!(
        freshness(&compute_data_quality_center(
            1,
            10,
            2,
            1,
            Some(100),
            Some(1)
        )),
        0.0
    );
    let poor = compute_data_quality_center(1, 0, 0, 0, None, None);
    let moderate = compute_data_quality_center(1, 10, 5, 2, Some(45), None);
    let absent = compute_data_quality_center(0, 0, 0, 0, None, None);
    assert_eq!(poor.availability, AnalysisAvailability::Available);
    assert_eq!(absent.availability, AnalysisAvailability::NoConfiguration);
    assert!(absent.overall_score.is_none());
    for (report, severity) in [(&poor, "critical"), (&moderate, "fair"), (&healthy, "good")] {
        let health = compute_multidimensional_health(None, None, None, None, Some(report));
        assert_eq!(health.dimensions[0].severity, severity);
        assert!((health.composite_score - report.overall_score.unwrap()).abs() < 1e-12);
    }
    let unknown_forecast = compute_forecast_calibration(&[], &[]);
    let with_missing =
        compute_multidimensional_health(None, None, None, Some(&unknown_forecast), Some(&healthy));
    let without_missing = compute_multidimensional_health(None, None, None, None, Some(&healthy));
    assert_eq!(with_missing.dimensions, without_missing.dimensions);
    assert_eq!(
        with_missing.composite_score,
        without_missing.composite_score
    );
}

#[test]
fn liquidity_health_changes_monotonically_at_obligation_coverage_boundaries() {
    let obligations = [schedule("rent", -100, "monthly")];
    let mut previous = 0.0;
    for (balance, severity) in [
        (40, "critical"),
        (50, "fair"),
        (100, "fair"),
        (150, "good"),
        (200, "good"),
        (300, "good"),
    ] {
        let coverage = compute_liquidity_coverage(
            Some(&Money::new(balance, "USD")),
            &obligations,
            &[],
            "2026-09",
        );
        let health = compute_multidimensional_health(Some(&coverage), None, None, None, None);
        assert_eq!(health.dimensions[0].severity, severity);
        assert!(health.composite_score > previous);
        previous = health.composite_score;
    }
}

#[test]
fn latest_budget_variances_and_directional_trends_are_independent_of_input_month_order() {
    let july = month(
        "2026-07",
        &[
            ("rising", 100),
            ("falling", 300),
            ("stable", 100),
            ("currency-change", 100),
        ],
    );
    let mut august = month(
        "2026-08",
        &[
            ("rising", 200),
            ("falling", 200),
            ("stable", 110),
            ("currency-change", 100),
        ],
    );
    august.categories.get_mut("currency-change").unwrap().amount = Money::new(100, "EUR");
    let september = month(
        "2026-09",
        &[
            ("rising", 300),
            ("falling", 100),
            ("stable", 105),
            ("new", 0),
            ("unbudgeted", 0),
            ("currency-change", 100),
        ],
    );
    let transactions = [
        transaction("over", -350, "rising", "2026-09-01"),
        transaction("on-track", -100, "falling", "2026-09-02"),
        transaction("under", -10, "stable", "2026-09-03"),
        transaction("unbudgeted", -5, "unbudgeted", "2026-09-04"),
    ];
    let report =
        compute_budget_variance(&[september, july, august], &transactions, &[], "2026-09-06");
    let rising = report
        .category_variances
        .iter()
        .find(|v| v.category_id == "rising")
        .unwrap();
    assert_eq!(rising.budgeted, Money::new(300, "USD"));
    assert_eq!(rising.actual, Money::new(350, "USD"));
    assert_eq!(rising.variance, Money::new(50, "USD"));
    assert_eq!(rising.label, "over");
    assert_eq!(
        report
            .category_variances
            .iter()
            .find(|v| v.category_id == "falling")
            .unwrap()
            .label,
        "on_track"
    );
    assert_eq!(
        report
            .category_variances
            .iter()
            .find(|v| v.category_id == "stable")
            .unwrap()
            .label,
        "under"
    );
    assert_eq!(
        report
            .category_variances
            .iter()
            .find(|v| v.category_id == "new")
            .unwrap()
            .variance_percent,
        0.0
    );
    assert_eq!(
        report
            .category_variances
            .iter()
            .find(|v| v.category_id == "unbudgeted")
            .unwrap()
            .variance_percent,
        -100.0
    );
    for (id, direction, change) in [
        ("rising", TrendDirection::Increasing, 100),
        ("falling", TrendDirection::Decreasing, -100),
        ("stable", TrendDirection::Stable, 2),
    ] {
        let trend = report.trends.iter().find(|t| t.category_id == id).unwrap();
        assert_eq!(trend.direction, direction);
        assert_eq!(trend.avg_change, Money::new(change, "USD"));
        assert_eq!(trend.periods_analyzed, 3);
    }
    assert!(!report
        .trends
        .iter()
        .any(|t| t.category_id == "new" || t.category_id == "currency-change"));
    assert_eq!(report.total_budgeted, Some(Money::new(605, "USD")));
    assert_eq!(report.total_actual, Some(Money::new(465, "USD")));
    assert_eq!(report.total_variance, Some(Money::new(140, "USD")));
}

#[test]
fn forecast_bias_preserves_direction_and_poor_calibration_reduces_health() {
    let months = [
        month("2026-08", &[("income", 100), ("expense", -200)]),
        month("2026-09", &[("income", 100), ("expense", -200)]),
    ];
    let actual = [
        transaction("aug-income", 50, "income", "2026-08-01"),
        transaction("sep-income", 50, "income", "2026-09-01"),
        transaction("aug-expense", -300, "expense", "2026-08-02"),
        transaction("sep-expense", -300, "expense", "2026-09-02"),
    ];
    let poor = compute_forecast_calibration(&months, &actual);
    assert!(!poor.overall_calibrated);
    let income = poor
        .metrics
        .iter()
        .find(|m| m.metric_name == "income")
        .unwrap();
    let expense = poor
        .metrics
        .iter()
        .find(|m| m.metric_name == "expenses")
        .unwrap();
    assert_eq!(income.bias, Some(0.5));
    assert_eq!(income.mape, Some(0.5));
    assert!((expense.bias.unwrap() + 1.0 / 3.0).abs() < 1e-12);
    assert_eq!(expense.periods_compared, 2);
    let mut exact = actual;
    for tx in &mut exact {
        tx.amount = Money::new(if tx.amount.is_negative() { -200 } else { 100 }, "USD");
    }
    let calibrated = compute_forecast_calibration(&months, &exact);
    assert!(calibrated.overall_calibrated);
    assert!(calibrated
        .metrics
        .iter()
        .all(|m| m.mape == Some(0.0) && m.bias == Some(0.0)));
    let low = compute_multidimensional_health(None, None, None, Some(&poor), None);
    let high = compute_multidimensional_health(None, None, None, Some(&calibrated), None);
    assert_eq!(low.dimensions[0].severity, "fair");
    assert_eq!(high.dimensions[0].severity, "good");
    assert!(low.composite_score < high.composite_score);
}

#[test]
fn income_sources_preserve_imported_identity_and_distinguish_regular_variable_and_sparse_history() {
    let categories = [
        Category {
            id: "salary".into(),
            name: "Salary".into(),
            group_name: None,
            is_income: true,
            mtid: None,
            deleted: false,
        },
        Category {
            id: "deleted".into(),
            name: "Old salary".into(),
            group_name: None,
            is_income: true,
            mtid: None,
            deleted: true,
        },
    ];
    let mut transactions = Vec::new();
    for (name, amounts) in [
        ("Regular", vec![800, 1000, 1200]),
        ("Variable", vec![600, 1000, 1400]),
        ("Volatile", vec![100, 1900]),
    ] {
        for (index, amount) in amounts.into_iter().enumerate() {
            let mut tx = transaction(&format!("{name}-{index}"), amount, "salary", "2026-09-01");
            tx.payee_name = None;
            tx.imported_payee = Some(name.into());
            transactions.push(tx);
        }
    }
    let mut unknown = transaction("unknown-id", 100, "salary", "2026-09-02");
    unknown.payee_name = None;
    transactions.extend([
        unknown,
        transaction("deleted-income", 10000, "deleted", "2026-09-03"),
        transaction("not-income", 10000, "food", "2026-09-03"),
        transaction("outflow", -100, "salary", "2026-09-03"),
    ]);
    let report = compute_income_reliability(
        &transactions,
        &[schedule("scheduled", 300, "monthly")],
        &categories,
    );
    assert_eq!(report.total_monthly, Some(Money::new(3400, "USD")));
    assert_eq!(report.unreliable_source_count, 3);
    let regular = report.sources.iter().find(|s| s.name == "Regular").unwrap();
    assert!(regular.is_regular);
    assert_eq!(regular.payment_count, 3);
    assert!((regular.variability - 0.2).abs() < 1e-12);
    assert!(
        !report
            .sources
            .iter()
            .find(|s| s.name == "Variable")
            .unwrap()
            .is_regular
    );
    assert_eq!(
        report
            .sources
            .iter()
            .find(|s| s.name == "unknown")
            .unwrap()
            .typical_monthly,
        Money::new(100, "USD")
    );
    assert_eq!(
        report
            .sources
            .iter()
            .find(|s| s.name == "scheduled")
            .unwrap()
            .typical_monthly,
        Money::new(300, "USD")
    );
    for (name, severity) in [
        ("Regular", "good"),
        ("Variable", "fair"),
        ("Volatile", "critical"),
    ] {
        let selected: Vec<_> = transactions
            .iter()
            .filter(|tx| tx.imported_payee.as_deref() == Some(name))
            .cloned()
            .collect();
        let income = compute_income_reliability(&selected, &[], &categories);
        let health = compute_multidimensional_health(None, None, Some(&income), None, None);
        assert_eq!(health.dimensions[0].severity, severity);
    }
}

#[test]
fn irregular_obligations_exclude_income_and_annualize_each_outflow_frequency() {
    let schedules = [
        schedule("monthly", -100, "monthly"),
        schedule("weekly", -20, "weekly"),
        schedule("annual", -1000, "yearly"),
        schedule("once", -50, "once"),
        schedule("variable-a", -10, "custom"),
        schedule("variable-b", -20, "custom"),
        schedule("income", 10000, "monthly"),
    ];
    let report = compute_irregular_obligations(&schedules);
    assert_eq!(report.total_estimated_annual, Some(Money::new(3320, "USD")));
    assert!(!report.obligations.iter().any(|o| o.name == "income"));
    assert_eq!(
        report
            .obligations
            .iter()
            .find(|o| o.name == "annual")
            .unwrap()
            .kind,
        IrregularityKind::Seasonal
    );
    assert_eq!(
        report
            .obligations
            .iter()
            .find(|o| o.name == "once")
            .unwrap()
            .kind,
        IrregularityKind::OneOff
    );
    assert_eq!(
        report
            .obligations
            .iter()
            .find(|o| o.name == "variable-a")
            .unwrap()
            .kind,
        IrregularityKind::VariableAmount
    );
    let income_only = compute_irregular_obligations(&[schedule("income", 1000, "monthly")]);
    assert_eq!(
        income_only.availability,
        AnalysisAvailability::InsufficientData
    );
    assert_eq!(income_only.total_estimated_annual, None);
}

#[test]
fn budget_health_degrades_at_surplus_and_overspend_boundaries() {
    let budgets = [month("2026-09", &[("food", 100)])];
    let mut previous = 1.0;
    for (spent, severity) in [
        (90, "good"),
        (95, "good"),
        (100, "good"),
        (110, "fair"),
        (111, "critical"),
    ] {
        let variance = compute_budget_variance(
            &budgets,
            &[transaction("purchase", -spent, "food", "2026-09-01")],
            &[],
            "2026-09-06",
        );
        let health = compute_multidimensional_health(None, Some(&variance), None, None, None);
        assert_eq!(health.dimensions[0].severity, severity);
        assert!(health.composite_score < previous);
        previous = health.composite_score;
    }
}

#[test]
fn budget_trends_omit_unrepresentable_changes_without_losing_current_variances() {
    let history = [
        month(
            "2026-07",
            &[
                ("jump", i64::MIN),
                ("cumulative", i64::MIN),
                ("regular", 100),
            ],
        ),
        month(
            "2026-08",
            &[("jump", i64::MIN), ("cumulative", -1), ("regular", 150)],
        ),
        month(
            "2026-09",
            &[("jump", 1), ("cumulative", 1), ("regular", 200)],
        ),
    ];
    let report = compute_budget_variance(&history, &[], &[], "2026-09-06");

    assert_eq!(report.availability, AnalysisAvailability::Available);
    assert_eq!(report.total_budgeted, Some(Money::new(202, "USD")));
    assert_eq!(report.total_variance, Some(Money::new(202, "USD")));
    for id in ["jump", "cumulative"] {
        let variance = report
            .category_variances
            .iter()
            .find(|v| v.category_id == id)
            .unwrap();
        assert_eq!(variance.variance, Money::new(1, "USD"));
        assert!(!report.trends.iter().any(|trend| trend.category_id == id));
    }
    assert_eq!(report.trends.len(), 1);
    assert_eq!(report.trends[0].category_id, "regular");
    assert_eq!(report.trends[0].avg_change, Money::new(50, "USD"));
    assert_eq!(report.trends[0].direction, TrendDirection::Increasing);
}

#[test]
fn seasonal_budget_trends_require_repeated_chronological_matches() {
    let history = [
        month("2026-05", &[("quarterly", 100), ("near-match", 100)]),
        month("2026-06", &[("quarterly", 200), ("near-match", 200)]),
        month("2026-07", &[("quarterly", 300), ("near-match", 300)]),
        month("2026-08", &[("quarterly", 100), ("near-match", 100)]),
        month("2026-09", &[("quarterly", 200), ("near-match", 250)]),
    ];
    let chronological = compute_budget_variance(&history, &[], &[], "2026-09-06");
    let quarterly = chronological
        .trends
        .iter()
        .find(|t| t.category_id == "quarterly")
        .unwrap();
    assert!(quarterly.seasonality_detected);
    assert_eq!(quarterly.avg_change, Money::new(25, "USD"));
    assert!(
        !chronological
            .trends
            .iter()
            .find(|t| t.category_id == "near-match")
            .unwrap()
            .seasonality_detected
    );

    let reordered = [
        history[0].clone(),
        history[3].clone(),
        history[1].clone(),
        history[4].clone(),
        history[2].clone(),
    ];
    let shuffled = compute_budget_variance(&reordered, &[], &[], "2026-09-06");
    for expected in &chronological.trends {
        assert_eq!(
            shuffled
                .trends
                .iter()
                .find(|t| t.category_id == expected.category_id)
                .unwrap(),
            expected,
        );
    }
}

#[test]
fn bill_calendar_excludes_matched_payees_from_unpaid_obligations() {
    let mut rent = schedule("rent", -120_000, "monthly");
    rent.payee_name = Some("Landlord".into());
    let utilities = schedule("utilities", -15_000, "monthly");
    let mut paid = transaction("rent-payment", -120_000, "housing", "2026-09-01");
    paid.payee_name = Some("Bank transfer".into());
    paid.imported_payee = Some("Landlord".into());

    let calendar = compute_bill_calendar(&[rent, utilities], &[paid], "2026-09-06");
    assert_eq!(calendar.total_unpaid, Some(Money::new(15_000, "USD")));
    assert_eq!(calendar.unpaid_count, 1);
    let rent_entry = calendar
        .entries
        .iter()
        .find(|e| e.name == "Landlord")
        .unwrap();
    assert_eq!(rent_entry.status, "paid");
    assert_eq!(rent_entry.amount, Money::new(120_000, "USD"));
    let unpaid = calendar
        .entries
        .iter()
        .find(|e| e.name == "utilities")
        .unwrap();
    assert_eq!(unpaid.status, "unpaid");
    assert_eq!(unpaid.amount, Money::new(15_000, "USD"));
}
