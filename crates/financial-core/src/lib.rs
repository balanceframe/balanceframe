#![forbid(unsafe_code)]

pub mod categorization;
pub mod data_quality;
pub mod merchant;
pub mod money;
pub mod reconciliation;
pub mod snapshots;

pub use categorization::{
    classify_exact_match, classify_historical, find_candidates, CategorizationCandidate,
    Evidence, EvidenceKind, HistoryRecord,
};
pub use data_quality::{
    analyze_accounts, analyze_categories, analyze_readiness, analyze_transactions,
    DataQualityReport, QualityIssue, QualitySummary, Severity,
};
pub use merchant::normalize_merchant;
pub use money::{Money, MoneyError};
pub use reconciliation::{reconcile_by_imported_id, MatchType, ReconciliationMatch};
pub use snapshots::{
    Account, BudgetCategory, BudgetMonth, Category, ImportTransaction, Payee, Rule, Schedule, Tag,
    Transaction,
};
