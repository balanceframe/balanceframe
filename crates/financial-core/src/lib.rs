#![forbid(unsafe_code)]
pub mod analysis;
pub mod blockers;
pub mod categorization;
pub mod coverage;
pub mod data_quality;
pub mod duplicates;
pub mod envelope;
pub mod freshness;
pub mod merchant;
pub mod money;
pub mod reconciliation;
pub mod snapshots;

pub use analysis::{
    run_deterministic_analysis, DeterministicAnalysis, HistoricalCorrection, RecurringCharge,
    RepeatedMerchant, RuleCandidate, UncategorizedBacklog,
};
pub use blockers::{Blocker, BlockerCollector, ReasonCode};
pub use categorization::{
    classify_exact_match, classify_historical, find_candidates, CandidateStatus,
    CategorizationCandidate, Evidence, EvidenceKind, HistoryRecord, InferencePolicy, Provenance,
};
pub use coverage::{build_coverage_report, AccountCoverage, CoverageReport, DateRange, InclusionScope};
pub use data_quality::{
    analyze_accounts, analyze_categories, analyze_readiness, analyze_transactions,
    DataQualityReport, QualityIssue, QualitySummary, Severity,
};
pub use duplicates::{find_duplicates, DuplicateEvidence};
pub use envelope::{AuthorizationContext, ErrorInfo, RequestEnvelope, ResponseEnvelope};
pub use freshness::{CompatibilityMetadata, DataFreshness};
pub use merchant::normalize_merchant;
pub use money::{Money, MoneyError};
pub use reconciliation::{reconcile_by_imported_id, MatchType, ReconciliationMatch};
pub use snapshots::{
    Account, BudgetCategory, BudgetMonth, Category, ImportTransaction, Payee, Rule, Schedule, Tag,
    Transaction,
};
