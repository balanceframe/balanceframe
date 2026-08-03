#![forbid(unsafe_code)]
pub mod analysis;
pub mod analytics;
pub mod blockers;
pub mod cash_flow;
pub mod categorization;
pub mod coverage;
pub mod data_quality;
pub mod duplicates;
pub mod envelope;
pub mod financial_state;
pub mod freshness;
pub mod merchant;
pub mod money;
pub mod purchase;
pub mod reconciliation;
pub mod snapshots;
pub mod targets;

pub use analysis::{
    generate_rule_candidates, generate_rule_candidates_from_corrections,
    run_deterministic_analysis, CorrectionEvidence, DeterministicAnalysis, HistoricalCorrection,
    RecurringCharge, RepeatedMerchant, RuleCandidate, UncategorizedBacklog,
};
pub use analytics::{
    compare_scenarios, compute_bill_calendar, compute_budget_variance, compute_data_quality_center,
    compute_forecast_calibration, compute_income_reliability, compute_irregular_obligations,
    compute_liquidity_coverage, compute_multidimensional_health, AnalysisAvailability,
    BillCalendar, BillCalendarEntry, BudgetVarianceReport, CalibrationMetric, CategoryTrend,
    CategoryVariance, CoverageRatio, DataQualityCenter, ForecastCalibration, HealthDimension,
    IncomeReliabilityReport, IncomeSource, IrregularObligation, IrregularObligationsReport,
    IrregularityKind, LiquidityCoverage, MultidimensionalHealth, QualityDimension, Scenario,
    ScenarioComparisonDelta, ScenarioComparisonResult, ScenarioId, ScenarioVersion, TrendDirection,
    UpcomingObligation,
};
pub use blockers::{Blocker, BlockerCollector, ReasonCode};
pub use cash_flow::{compute_cash_flow_projection, CashFlowProjection};
pub use categorization::{
    classify_exact_match, classify_historical, find_candidates, CandidateStatus,
    CategorizationCandidate, Evidence, EvidenceKind, HistoryRecord, InferencePolicy, Provenance,
};
pub use coverage::{
    build_coverage_report, AccountCoverage, CoverageReport, DateRange, InclusionScope,
};
pub use data_quality::{
    analyze_accounts, analyze_categories, analyze_readiness, analyze_transactions,
    DataQualityReport, QualityIssue, QualitySummary, Severity,
};
pub use duplicates::{find_duplicates, DuplicateEvidence};
pub use envelope::{AuthorizationContext, ErrorInfo, RequestEnvelope, ResponseEnvelope};
pub use financial_state::{
    AccountOverrides, DecisionDataPolicy, FinancialStateLabel, PendingMode, UncategorizedMode,
    UnclearedMode,
};
pub use freshness::{CompatibilityMetadata, DataFreshness};
pub use merchant::normalize_merchant;
pub use money::{Money, MoneyError};
pub use purchase::{
    evaluate_purchase, PurchaseDataBlocker, PurchaseEvidence, PurchaseOutcome, PurchaseOutcomeKind,
    PurchasePolicy, PurchaseReasonCode, TransactionSemantic,
};
pub use reconciliation::{reconcile_by_imported_id, MatchType, ReconciliationMatch};
pub use snapshots::{
    Account, BudgetCategory, BudgetMonth, Category, ImportTransaction, Payee, Rule, Schedule, Tag,
    Transaction,
};
pub use targets::{compute_target_status, TargetHealth, TargetStatus};
