#![forbid(unsafe_code)]

use balanceframe_financial_core::data_quality::{analyze_readiness, Severity as DqSeverity};
use balanceframe_financial_core::{
    Account, BudgetMonth, CategorizationCandidate, Category, CompatibilityMetadata, Payee, Rule,
    Schedule, Tag, Transaction,
};
use balanceframe_financial_core as fc;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/// Schema versions accepted by the v1 analysis pipeline.
const SUPPORTED_SCHEMA_VERSIONS: &[&str] = &["1", "1.0"];

fn is_supported_schema_version(version: &str) -> bool {
    SUPPORTED_SCHEMA_VERSIONS.contains(&version)
}

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolSnapshot {
    pub schema_version: String,
    pub actual_version: String,
    pub snapshot_date: String,
    pub accounts: Vec<Account>,
    pub transactions: Vec<Transaction>,
    pub categories: Vec<Category>,
    pub payees: Vec<Payee>,
    pub rules: Vec<Rule>,
    pub schedules: Vec<Schedule>,
    pub budgets: Vec<BudgetMonth>,
    pub tags: Vec<Tag>,
    /// ISO‑8601 timestamp of when the Actual data was last downloaded.
    /// `None` when unknown (legacy snapshots).
    #[serde(default)]
    pub actual_downloaded_at: Option<String>,
    /// Whether the Actual budget requires an encryption key. `None` when
    /// the connector could not determine encryption state.
    #[serde(default)]
    pub encrypted: Option<bool>,
    /// ISO‑8601 timestamp of the last bank sync. `None` when unknown.
    #[serde(default)]
    pub bank_synced_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRequest {
    pub snapshot: ProtocolSnapshot,
    pub options: AnalysisOptions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisOptions {
    pub include_pending: bool,
    pub include_cleared: bool,
    pub max_results: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub result_code: String,
    pub reason_codes: Vec<String>,
    pub findings: Vec<Finding>,
    pub suggestions: Vec<Suggestion>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub finding_type: String,
    pub severity: String,
    pub entity_id: String,
    pub message: String,
    pub drill_down: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub transaction_id: String,
    pub proposed_category_id: String,
    pub category_name: String,
    pub confidence: f64,
    pub reason_codes: Vec<String>,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationPlan {
    pub plan_id: String,
    pub transaction_id: String,
    pub current_category_id: Option<String>,
    pub proposed_category_id: String,
    pub hash: String,
    pub postconditions: Vec<Postcondition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Postcondition {
    #[serde(rename = "type")]
    pub condition_type: PostconditionType,
    pub category_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum PostconditionType {
    CategoryExists,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSimulationResult {
    pub rule_id: String,
    pub name: String,
    pub transactions_matched: u32,
    pub transactions_affected: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub valid: bool,
    pub reason_codes: Vec<String>,
    pub message: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub verified: bool,
    pub reason_codes: Vec<String>,
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Deterministic analysis types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeterministicAnalysisRequest {
    pub snapshot: ProtocolSnapshot,
    pub options: AnalysisOptions,
    pub request_id: Option<String>,
    pub actor_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeterministicAnalysisResponse {
    pub schema_version: String,
    pub request_id: String,
    pub status: String,
    pub freshness: fc::DataFreshness,
    pub compatibility: CompatibilityMetadata,
    pub coverage: fc::CoverageReport,
    pub analysis: fc::DeterministicAnalysis,
    pub reason_codes: Vec<String>,
    pub error: Option<fc::ErrorInfo>,
}

// Re-export types from financial-core for convenience, with aliases
// that match the protocol naming convention.
pub type ProtocolTransaction = Transaction;
pub type ProtocolCategory = Category;

// ---------------------------------------------------------------------------
// Protocol functions
// ---------------------------------------------------------------------------

/// Run a full analysis on a snapshot and produce an `AnalysisResult`.
pub fn analyze_snapshot(request: AnalysisRequest) -> AnalysisResult {
    let snapshot = &request.snapshot;
    let options = &request.options;

    // -----------------------------------------------------------------------
    // 1. Protocol version validation
    // -----------------------------------------------------------------------
    if !is_supported_schema_version(&snapshot.schema_version) {
        return AnalysisResult {
            result_code: "error".into(),
            reason_codes: vec!["unsupported_schema_version".into()],
            findings: vec![Finding {
                finding_type: "unsupported_schema_version".into(),
                severity: "blocker".into(),
                entity_id: "_overview".into(),
                message: format!("Unsupported schema version: {}", snapshot.schema_version),
                drill_down: vec![],
            }],
            suggestions: vec![],
        };
    }

    let mut findings: Vec<Finding> = Vec::new();
    let mut suggestions: Vec<Suggestion> = Vec::new();
    let mut reason_codes: Vec<String> = Vec::new();

    // -----------------------------------------------------------------------
    // 2. Readiness analysis (from financial-core data quality module)
    // -----------------------------------------------------------------------
    {
        let report = analyze_readiness(
            &snapshot.accounts,
            &snapshot.transactions,
            &snapshot.categories,
            &snapshot.snapshot_date,
        );
        for issue in report.issues {
            let severity_str = match issue.severity {
                DqSeverity::Blocker => "blocker",
                DqSeverity::Warning => "warning",
                DqSeverity::Info => "info",
            };
            if severity_str == "blocker" {
                reason_codes.push(issue.code.clone());
            }
            findings.push(Finding {
                finding_type: issue.code,
                severity: severity_str.into(),
                entity_id: issue.entity_id,
                message: issue.message,
                drill_down: vec![],
            });
        }
    }

    // -----------------------------------------------------------------------
    // 3. Transaction-level checks
    // -----------------------------------------------------------------------
    if options.include_pending {
        let pending_count = snapshot
            .transactions
            .iter()
            .filter(|tx| !tx.cleared)
            .count();
        if pending_count > 0 {
            findings.push(Finding {
                finding_type: "pending_transactions".into(),
                severity: "info".into(),
                entity_id: "_overview".into(),
                message: format!("{} pending transaction(s)", pending_count),
                drill_down: vec![],
            });
        }
    }

    // -----------------------------------------------------------------------
    // 4. Uncategorized transactions (checked arithmetic)
    // -----------------------------------------------------------------------
    let uncategorized: Vec<&Transaction> = snapshot
        .transactions
        .iter()
        .filter(|tx| tx.category_id.is_none() || tx.category_id.as_deref() == Some(""))
        .collect();

    if !uncategorized.is_empty() {
        // Use Money::abs() (checked) instead of i64::abs() which panics on
        // i64::MIN.  Accumulate with checked_add so the total never silently
        // wraps.
        let mut total_minor: i64 = 0;
        for tx in &uncategorized {
            match tx.amount.abs() {
                Ok(abs) => {
                    match total_minor.checked_add(abs.minor_units()) {
                        Some(sum) => total_minor = sum,
                        None => {
                            findings.push(Finding {
                                finding_type: "amount_overflow".into(),
                                severity: "blocker".into(),
                                entity_id: tx.id.clone(),
                                message: "Accumulation overflow while summing uncategorized transactions".to_string(),
                                drill_down: vec![],
                            });
                            reason_codes.push("amount_overflow".into());
                        }
                    }
                }
                Err(_) => {
                    findings.push(Finding {
                        finding_type: "amount_overflow".into(),
                        severity: "blocker".into(),
                        entity_id: tx.id.clone(),
                        message: format!(
                            "Transaction {} amount absolute value causes arithmetic overflow",
                            tx.id,
                        ),
                        drill_down: vec![],
                    });
                    reason_codes.push("amount_overflow".into());
                }
            }
        }

        findings.push(Finding {
            finding_type: "uncategorized".into(),
            severity: "warning".into(),
            entity_id: "_overview".into(),
            message: format!(
                "{} uncategorized transaction(s), {} total minor units",
                uncategorized.len(),
                total_minor
            ),
            drill_down: uncategorized.iter().map(|tx| tx.id.clone()).collect(),
        });

        // Build suggestions for uncategorized transactions
        for tx in &uncategorized {
            suggestions.push(Suggestion {
                transaction_id: tx.id.clone(),
                proposed_category_id: String::new(),
                category_name: String::new(),
                confidence: 0.0,
                reason_codes: vec!["uncategorized".into()],
                evidence: vec![],
            });
        }
    }

    // -----------------------------------------------------------------------
    // 5. Category integrity
    // -----------------------------------------------------------------------
    let deleted_ids: Vec<&str> = snapshot
        .categories
        .iter()
        .filter(|c| c.deleted)
        .map(|c| c.id.as_str())
        .collect();

    for &del_id in &deleted_ids {
        let ref_count = snapshot
            .transactions
            .iter()
            .filter(|tx| tx.category_id.as_deref() == Some(del_id))
            .count();
        if ref_count > 0 {
            findings.push(Finding {
                finding_type: "deleted_category_referenced".into(),
                severity: "blocker".into(),
                entity_id: del_id.to_string(),
                message: format!(
                    "Deleted category {} is used by {} transaction(s)",
                    del_id, ref_count
                ),
                drill_down: vec![],
            });
            reason_codes.push("deleted_category_referenced".into());
        }
    }

    // -----------------------------------------------------------------------
    // 6. Budget coverage
    // -----------------------------------------------------------------------
    let uncategorized_ids: std::collections::HashSet<&str> = uncategorized
        .iter()
        .filter_map(|tx| tx.category_id.as_deref())
        .collect();

    if !uncategorized_ids.is_empty() {
        reason_codes.push("uncategorized".into());
    }

    // -----------------------------------------------------------------------
    // 7. Apply max_results limit
    // -----------------------------------------------------------------------
    if let Some(max) = options.max_results {
        let max = max as usize;
        findings.truncate(max);
        suggestions.truncate(max);
    }

    // -----------------------------------------------------------------------
    // 8. Determine result code
    // -----------------------------------------------------------------------
    let has_blockers = findings.iter().any(|f| f.severity == "blocker");
    let has_warnings = findings.iter().any(|f| f.severity == "warning");

    let result_code = if has_blockers {
        "error"
    } else if has_warnings {
        "warning"
    } else {
        "success"
    };

    AnalysisResult {
        result_code: result_code.to_string(),
        reason_codes,
        findings,
        suggestions,
    }
}

/// Run the deterministic (no‑model) analysis pipeline on a snapshot.
///
/// This is a protocol-level wrapper around
/// [`fc::analysis::run_deterministic_analysis`] that builds the
/// compatibility metadata from the snapshot and returns the wrapped
/// [`DeterministicAnalysisResponse`].
pub fn analyze_deterministic(request: DeterministicAnalysisRequest) -> DeterministicAnalysisResponse {
    let snapshot = &request.snapshot;
    let options = &request.options;

    // Version check
    if !is_supported_schema_version(&snapshot.schema_version) {
        let scope = fc::InclusionScope::new(options.include_pending, options.include_cleared);
        return DeterministicAnalysisResponse {
            schema_version: "1.0".into(),
            request_id: request.request_id.clone().unwrap_or_default(),
            status: "error".into(),
            freshness: fc::DataFreshness::compute(None, None, options.include_pending, &snapshot.snapshot_date),
            compatibility: fc::CompatibilityMetadata::new(
                snapshot.encrypted.unwrap_or(false),
                snapshot.actual_downloaded_at.is_some() || !snapshot.encrypted.unwrap_or(true),
                snapshot.actual_version.clone(),
            ),
            coverage: fc::build_coverage_report(
                &snapshot.accounts,
                &snapshot.transactions,
                &scope,
            ),
            analysis: fc::DeterministicAnalysis {
                freshness: fc::DataFreshness::compute(None, None, false, ""),
                compatibility: fc::CompatibilityMetadata::new(false, false, String::new()),
                coverage: fc::build_coverage_report(&[], &[], &scope),
                readiness: fc::analyze_readiness(&[], &[], &[], ""),
                uncategorized_backlog: fc::UncategorizedBacklog {
                    count: 0, oldest_date: None, total_amount: fc::Money::zero("USD"),
                    transaction_ids: vec![],
                },
                repeated_merchants: vec![],
                deterministic_classifications: vec![],
                rule_candidates: vec![],
                duplicate_evidence: vec![],
                recurring_charges: vec![],
                historical_corrections: vec![],
                blockers: vec![],
                reason_codes: vec!["unsupported_schema_version".into()],
                result_code: "error".into(),
            },
            reason_codes: vec!["unsupported_schema_version".into()],
            error: Some(fc::ErrorInfo::new(
                "unsupported_schema_version",
                format!("Unsupported schema version: {}", snapshot.schema_version),
                false,
            )),
        };
    }
    let actual_downloaded_at = snapshot.actual_downloaded_at.clone();
    let reference_date = &snapshot.snapshot_date;

    // Build compatibility metadata.
    // If the data was actually downloaded (actual_downloaded_at is present),
    // encryption must have been unlocked — treat it as such regardless of
    // the raw `encrypted` flag from the connector.
    let has_download = snapshot.actual_downloaded_at.is_some();
    let compatibility = fc::CompatibilityMetadata::new(
        snapshot.encrypted.unwrap_or(false),
        has_download || !snapshot.encrypted.unwrap_or(true),
        snapshot.actual_version.clone(),
    );

    let scope = fc::InclusionScope::new(options.include_pending, options.include_cleared);

    let analysis = fc::run_deterministic_analysis(
        &snapshot.accounts,
        &snapshot.transactions,
        &snapshot.categories,
        &snapshot.payees,
        &snapshot.rules,
        &snapshot.schedules,
        &snapshot.budgets,
        compatibility.clone(),
        actual_downloaded_at,
        snapshot.bank_synced_at.clone(),
        &scope,
        reference_date,
    );

    let status = if analysis.result_code == "error" {
        "error"
    } else {
        "ok"
    };

    DeterministicAnalysisResponse {
        schema_version: "1.0".into(),
        request_id: request.request_id.unwrap_or_default(),
        status: status.into(),
        freshness: analysis.freshness.clone(),
        compatibility: analysis.compatibility.clone(),
        coverage: analysis.coverage.clone(),
        reason_codes: analysis.reason_codes.clone(),
        analysis,
        error: None,
    }
}

/// Find categorization candidates from a list of transactions.
/// This is a protocol-level wrapper; it performs a simple check for
/// transactions without a category.
pub fn find_categorization_candidates(
    transactions: Vec<Transaction>,
) -> Vec<CategorizationCandidate> {
    transactions
        .into_iter()
        .filter(|tx| tx.category_id.is_none() || tx.category_id.as_deref() == Some(""))
        .map(|tx| CategorizationCandidate {
            transaction_id: tx.id,
            amount: tx.amount,
            payee_name: tx.payee_name,
            date: tx.date,
            reasons: vec![],
        })
        .collect()
}

/// Validate that a suggestion is applicable to the given snapshot.
pub fn validate_suggestion(
    suggestion: &Suggestion,
    snapshot: &ProtocolSnapshot,
) -> ValidationResult {
    let mut reason_codes: Vec<String> = Vec::new();

    // Check that the target transaction exists
    let tx_exists = snapshot
        .transactions
        .iter()
        .any(|tx| tx.id == suggestion.transaction_id);

    if !tx_exists {
        reason_codes.push("transaction_not_found".into());
        return ValidationResult {
            valid: false,
            reason_codes,
            message: Some(format!(
                "Transaction {} not found in snapshot",
                suggestion.transaction_id
            )),
        };
    }

    // Check that the proposed category exists (unless empty/uncategorize)
    if !suggestion.proposed_category_id.is_empty() {
        let cat_exists = snapshot
            .categories
            .iter()
            .any(|c| c.id == suggestion.proposed_category_id && !c.deleted);
        if !cat_exists {
            reason_codes.push("category_not_found".into());
            return ValidationResult {
                valid: false,
                reason_codes,
                message: Some(format!(
                    "Category {} not found or deleted in snapshot",
                    suggestion.proposed_category_id
                )),
            };
        }
    }

    ValidationResult {
        valid: reason_codes.is_empty(),
        reason_codes,
        message: None,
    }
}

/// Plan the mutation of a transaction's category.
pub fn plan_set_category(
    transaction: &Transaction,
    category: &Category,
) -> MutationPlan {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    transaction.id.hash(&mut hasher);
    category.id.hash(&mut hasher);
    let hash = format!("{:x}", hasher.finish());

    MutationPlan {
        plan_id: format!("plan_{}", hash),
        transaction_id: transaction.id.clone(),
        current_category_id: transaction.category_id.clone(),
        proposed_category_id: category.id.clone(),
        hash,
        postconditions: vec![Postcondition {
            condition_type: PostconditionType::CategoryExists,
            category_id: category.id.clone(),
        }],
    }
}

/// Verify that a mutation plan is still valid against a snapshot.
pub fn verify_mutation(
    plan: &MutationPlan,
    snapshot: &ProtocolSnapshot,
) -> VerificationResult {
    let mut reason_codes: Vec<String> = Vec::new();

    // Transaction still exists and still has the expected current category
    let tx = match snapshot
        .transactions
        .iter()
        .find(|tx| tx.id == plan.transaction_id)
    {
        Some(tx) => tx,
        None => {
            reason_codes.push("transaction_not_found".into());
            return VerificationResult {
                verified: false,
                reason_codes,
                message: Some(format!(
                    "Transaction {} no longer exists",
                    plan.transaction_id
                )),
            };
        }
    };

    if tx.category_id != plan.current_category_id {
        reason_codes.push("category_changed".into());
    }

    // Proposed category still exists and is not deleted
    let cat_exists = snapshot
        .categories
        .iter()
        .any(|c| c.id == plan.proposed_category_id && !c.deleted);
    if !cat_exists {
        reason_codes.push("proposed_category_not_found".into());
    }

    let empty = reason_codes.is_empty();
    let reasons = reason_codes.clone();
    VerificationResult {
        verified: empty,
        reason_codes,
        message: if empty {
            None
        } else {
            Some(format!("Verification failed: {:?}", reasons))
        },
    }
}

/// Simulate what would happen if a rule were applied to a set of transactions.
pub fn simulate_rule(
    rule: &Rule,
    transactions: &[Transaction],
) -> RuleSimulationResult {
    let mut matched: u32 = 0;
    let mut affected: Vec<String> = Vec::new();

    for tx in transactions {
        // Simple simulation: check if the transaction is uncategorized and
        // the rule is active.  A real implementation would evaluate the
        // rule's trigger conditions against each transaction.
        if !rule.inactive
            && (tx.category_id.is_none() || tx.category_id.as_deref() == Some(""))
        {
            matched += 1;
            affected.push(tx.id.clone());
        }
    }

    RuleSimulationResult {
        rule_id: rule.id.clone(),
        name: rule.name.clone(),
        transactions_matched: matched,
        transactions_affected: affected,
    }
}
