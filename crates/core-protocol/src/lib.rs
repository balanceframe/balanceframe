#![forbid(unsafe_code)]

use balanceframe_financial_core::data_quality::{analyze_readiness, Severity as DqSeverity};
use balanceframe_financial_core::{
    normalize_merchant, Account, BudgetMonth, CandidateStatus, CategorizationCandidate,
    Category, CompatibilityMetadata, HistoryRecord, Payee, Rule, Schedule, Tag, Transaction,
};
pub use balanceframe_financial_core::{InferencePolicy, Provenance};
use balanceframe_financial_core as fc;
use std::collections::HashMap;
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
    /// Stable transaction identifier within the Actual budget.
    pub transaction_id: String,
    /// Proposed category identifier (empty string = uncategorize/remove).
    pub proposed_category_id: String,
    /// Human-readable name of the proposed category.
    pub category_name: String,
    /// Model confidence score (metadata only, never authorization).
    pub confidence: f64,
    /// Machine-readable reason codes for this suggestion.
    pub reason_codes: Vec<String>,
    /// Evidence strings supporting the suggestion.
    pub evidence: Vec<String>,

    // ---- Phase 2: Suggestion-only classifier fields -----------------------
    // All new fields are Option<…> / Vec-defaulted for backward compatibility
    // with existing Suggestion JSON that lacks them.

    /// Stable space identifier for multi-space deployments.
    #[serde(default)]
    pub space_id: Option<String>,
    /// Connection identifier for the data source.
    #[serde(default)]
    pub connection_id: Option<String>,
    /// Budget identifier for the current budget cycle.
    #[serde(default)]
    pub budget_id: Option<String>,
    /// Version identifier for the transaction, used for staleness detection.
    #[serde(default)]
    pub transaction_version: Option<String>,
    /// Raw merchant name as recorded in the transaction.
    #[serde(default)]
    pub raw_merchant: Option<String>,
    /// Normalized merchant name for cross-reference matching.
    #[serde(default)]
    pub normalized_merchant: Option<String>,
    /// Optional research summary from merchant research provider.
    #[serde(default)]
    pub research_summary: Option<String>,
    /// Alternative category identifiers that were considered.
    #[serde(default)]
    pub alternative_category_ids: Vec<String>,
    /// Free-text rationale for the suggestion.
    #[serde(default)]
    pub rationale: Option<String>,
    /// Inference provider identifier (e.g. "openai", "local").
    #[serde(default)]
    pub provider: Option<String>,
    /// Model identifier used for this suggestion.
    #[serde(default)]
    pub model: Option<String>,
    /// Version of the prompt template used.
    #[serde(default)]
    pub prompt_version: Option<String>,
    /// Version of the inference policy at time of suggestion.
    #[serde(default)]
    pub inference_policy_version: Option<String>,
    /// ISO-8601 timestamp of suggestion creation.
    #[serde(default)]
    pub created_at: Option<String>,
    /// Originating actor identifier (user or system).
    #[serde(default)]
    pub actor_id: Option<String>,
    /// Hash of the suggestion payload for integrity verification.
    #[serde(default)]
    pub payload_hash: Option<String>,
    /// Provenance metadata (provider, model, version chain).
    #[serde(default)]
    pub provenance: Option<Provenance>,
    /// Historical categorization records considered.
    #[serde(default)]
    pub history: Vec<HistoryRecord>,
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
    /// Maps target category ID → count of matched transactions.
    #[serde(default)]
    pub category_distribution: HashMap<String, u32>,
    /// Conflict messages when a rule overlaps with other rules.
    #[serde(default)]
    pub conflicts: Vec<String>,
    /// Example transactions that would be affected.
    #[serde(default)]
    pub examples: Vec<SimulationExample>,
}

/// A single example of a transaction that a rule would match.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationExample {
    pub tx_id: String,
    pub payee: Option<String>,
    pub amount: fc::Money,
    pub current_category: Option<String>,
    pub would_change: bool,
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
// Rule planning types
// ---------------------------------------------------------------------------

/// A condition on a payee field used to match transactions for rule creation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayeeCondition {
    /// The field to match (e.g. "payee", "imported_payee").
    pub field: String,
    /// The comparison operation (e.g. "is", "contains", "startsWith").
    pub operation: String,
    /// The value to compare against.
    pub value: String,
}

/// A plan for creating a new categorization rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRulePlan {
    /// Stable identifier for this plan.
    pub plan_id: String,
    /// Human-readable name for the rule.
    pub rule_name: String,
    /// Trigger condition as JSON (e.g. `{"type":"payee_is","value":"groceries"}`).
    pub trigger: serde_json::Value,
    /// Actions to apply as JSON (e.g. `[{"type":"set_category","value":"c1"}]`).
    pub actions: serde_json::Value,
    /// Content hash for integrity verification.
    pub hash: String,
    /// The payee conditions that generated this plan.
    pub conditions: Vec<PayeeCondition>,
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
                space_id: None,
                connection_id: None,
                budget_id: None,
                transaction_version: None,
                raw_merchant: None,
                normalized_merchant: None,
                research_summary: None,
                alternative_category_ids: vec![],
                rationale: None,
                provider: None,
                model: None,
                prompt_version: None,
                inference_policy_version: None,
                created_at: None,
                actor_id: None,
                payload_hash: None,
                provenance: None,
                history: vec![],
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
            schema_version: "1".into(),
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

    // Apply maxResults limit if specified
    let max_results = options.max_results.map(|m| m as usize);
    if let Some(max) = max_results {
        let mut limited = analysis;
        limited.repeated_merchants.truncate(max);
        limited.deterministic_classifications.truncate(max);
        limited.rule_candidates.truncate(max);
        limited.duplicate_evidence.truncate(max);
        limited.recurring_charges.truncate(max);
        limited.historical_corrections.truncate(max);
        DeterministicAnalysisResponse {
            schema_version: "1".into(),
            request_id: request.request_id.unwrap_or_default(),
            status: status.into(),
            freshness: limited.freshness.clone(),
            compatibility: limited.compatibility.clone(),
            coverage: limited.coverage.clone(),
            reason_codes: limited.reason_codes.clone(),
            analysis: limited,
            error: if status == "error" {
                Some(fc::ErrorInfo::new(
                    "analysis_error",
                    "Analysis completed with blockers",
                    false,
                ))
            } else {
                None
            },
        }
    } else {
        DeterministicAnalysisResponse {
            schema_version: "1".into(),
            request_id: request.request_id.unwrap_or_default(),
            status: status.into(),
            freshness: analysis.freshness.clone(),
            compatibility: analysis.compatibility.clone(),
            coverage: analysis.coverage.clone(),
            reason_codes: analysis.reason_codes.clone(),
            analysis,
            error: if status == "error" {
                Some(fc::ErrorInfo::new(
                    "analysis_error",
                    "Analysis completed with blockers",
                    false,
                ))
            } else {
                None
            },
        }
    }
}


// ---------------------------------------------------------------------------
// Rule candidate analysis — protocol wrapper
// ---------------------------------------------------------------------------

/// Analyze approved transaction history in a snapshot to find merchants
/// consistently categorized to the same category, above a
/// `min_consistent_count` threshold.
///
/// This is a protocol-level wrapper around
/// [`fc::analysis::generate_rule_candidates`] that extracts the relevant
/// data from a [`ProtocolSnapshot`].
pub fn analyze_rule_candidates(
    snapshot: &ProtocolSnapshot,
    min_consistent_count: u32,
) -> Vec<fc::RuleCandidate> {
    fc::generate_rule_candidates(
        &snapshot.transactions,
        &snapshot.categories,
        min_consistent_count,
    )
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
///
/// Checks that the target transaction exists and that the proposed category
/// (if non‑empty) exists in the snapshot and is not marked as deleted.
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

/// Compute a deterministic version string for a transaction from its current
/// mutable state fields.  This version is used to detect stale suggestions:
/// if the transaction's amount, category, date, or cleared status has changed
/// since the provider issued the suggestion, the version will differ.
///
/// The version is computed from fields that affect categorization relevance:
/// `id`, `amount`, `date`, `category_id`, `cleared`.  Changes to immutable
/// or unrelated fields (notes, tags, import IDs) do not alter the version.
fn compute_transaction_version(tx: &Transaction) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    tx.id.hash(&mut hasher);
    tx.amount.minor_units().hash(&mut hasher);
    tx.amount.currency().hash(&mut hasher);
    tx.date.hash(&mut hasher);
    tx.category_id.hash(&mut hasher);
    tx.cleared.hash(&mut hasher);
    format!("txv{:x}", hasher.finish())
}

/// Validate a provider-issued suggestion against the current snapshot
/// and candidate eligibility, without mutating any data.
///
/// This is the authoritative Rust gate before a provider suggestion is
/// persisted or acted upon.  It performs the same checks as
/// [`validate_suggestion`] plus:
///
/// * **Transaction ID binding** – the suggestion's `transaction_id` must
///   match both the candidate's `transaction_id` and a real transaction
///   in the snapshot.
/// * **Candidate eligibility** – only [`CandidateStatus::Unresolved`]
///   candidates may receive provider inference.  Evidence is explicitly
///   ranked by type rather than trusting insertion order.
/// * **Transaction version** – if the suggestion carries a
///   `transaction_version`, it is compared against a trustworthy version
///   computed from the snapshot transaction.  Mismatches are rejected
///   as stale.
/// * **Inference policy** – if an effective policy is supplied, the
///   provider field is checked against it (fail‑closed).
/// * **Immutable metadata** – provider suggestions must carry provenance
///   and creation timestamp.
/// * **Provenance consistency** – top‑level `provider` / `created_at`
///   must match their counterparts inside `provenance`.
/// * **Payload hash integrity** – both the top‑level `payload_hash` and
///   `provenance.payload_hash` must be present and non‑empty.
pub fn validate_provider_suggestion(
    suggestion: &Suggestion,
    snapshot: &ProtocolSnapshot,
    candidate: &CategorizationCandidate,
    effective_policy: Option<InferencePolicy>,
) -> ValidationResult {
    // 1. Run basic suggestion validation first (transaction exists + category valid)
    let basic = validate_suggestion(suggestion, snapshot);
    let mut reason_codes: Vec<String> = basic.reason_codes;

    // 2. Transaction ID binding: suggestion.transaction_id must match
    //    candidate.transaction_id and reference a real snapshot transaction
    if suggestion.transaction_id != candidate.transaction_id {
        reason_codes.push("transaction_id_mismatch".into());
    }

    // Double-check that the candidate references a real transaction
    let tx_in_snapshot = snapshot
        .transactions
        .iter()
        .find(|tx| tx.id == candidate.transaction_id);
    if tx_in_snapshot.is_none() {
        reason_codes.push("candidate_transaction_not_found".into());
    }

    // 3. Candidate eligibility: only unresolved candidates qualify
    //    (eligibility now uses explicit evidence ranking, not reasons.first())
    if candidate.eligibility() != CandidateStatus::Unresolved {
        reason_codes.push("candidate_already_resolved".into());
    }

    // 4. Stale transaction version detection
    //    If the suggestion carries a version, compute the trustworthy version
    //    from the current snapshot transaction and compare.
    if let Some(version) = &suggestion.transaction_version {
        if version.trim().is_empty() {
            reason_codes.push("invalid_transaction_version".into());
        } else if let Some(tx) = tx_in_snapshot {
            let expected = compute_transaction_version(tx);
            if *version != expected {
                reason_codes.push("stale_transaction_version".into());
            }
        }
    }

    // 5. Inference policy enforcement (fail‑closed)
    if let Some(policy) = &effective_policy {
        match policy {
            InferencePolicy::Disabled => {
                // Fail‑closed: Disabled rejects ALL provider suggestions
                // regardless of whether a provider is specified.
                reason_codes.push("provider_inference_disabled".into());
            }
            InferencePolicy::LocalOnly => {
                // When provider is absent or external, reject.
                let provider = suggestion.provider.as_deref().unwrap_or("");
                if provider != "local" {
                    reason_codes.push("external_provider_not_allowed".into());
                }
            }
            InferencePolicy::ExternalAllowed => {}
        }
    }

    // 6. Immutable metadata validation: provider suggestions MUST carry
    //    provenance and creation timestamp to be considered well-formed.
    let has_provenance = suggestion.provenance.is_some();
    if !has_provenance {
        reason_codes.push("missing_provenance".into());
    }
    if suggestion.created_at.is_none() {
        reason_codes.push("missing_created_at".into());
    }

    // 7. Provenance consistency: top-level provider/created_at must match
    //    their counterparts inside provenance (prevents field-level tampering).
    if let Some(prov) = &suggestion.provenance {
        // Top-level provider must match provenance.provider
        if suggestion.provider != prov.provider {
            reason_codes.push("provenance_provider_mismatch".into());
        }
        // Top-level created_at must match provenance.created_at
        if suggestion.created_at.as_deref() != Some(&prov.created_at) {
            reason_codes.push("provenance_timestamp_mismatch".into());
        }
    }

    // 8. Non-empty / canonical payload hashes
    //    payload_hash must be present and non-empty on both suggestion and provenance.
    let hash_ok = suggestion
        .payload_hash
        .as_ref()
        .map(|h| !h.trim().is_empty())
        .unwrap_or(false);
    if !hash_ok {
        reason_codes.push("missing_payload_hash".into());
    }
    if let Some(prov) = &suggestion.provenance {
        let prov_hash_ok = !prov.payload_hash.trim().is_empty();
        if !prov_hash_ok {
            reason_codes.push("provenance_payload_hash_empty".into());
        }
    }

    let message = if reason_codes.is_empty() {
        None
    } else {
        Some(format!(
            "Provider suggestion validation failed: {}",
            reason_codes.join(", ")
        ))
    };

    ValidationResult {
        valid: reason_codes.is_empty(),
        reason_codes,
        message,
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
    // Collect *failure* reason codes separately so that diagnostic
    // observations (e.g. category_already_matches) do not cause a
    // false `verified: false` result.
    let mut failure_codes: Vec<String> = Vec::new();

    // Transaction still exists and still has the expected current category
    let tx = match snapshot
        .transactions
        .iter()
        .find(|tx| tx.id == plan.transaction_id)
    {
        Some(tx) => tx,
        None => {
            failure_codes.push("transaction_not_found".into());
            return VerificationResult {
                verified: false,
                reason_codes: failure_codes,
                message: Some(format!(
                    "Transaction {} no longer exists",
                    plan.transaction_id
                )),
            };
        }
    };

    // Precondition: current category in snapshot matches plan expectation
    if tx.category_id != plan.current_category_id {
        failure_codes.push("category_changed".into());
    }

    // Proposed category already matches — diagnostic observation, not an error
    if tx.category_id == Some(plan.proposed_category_id.clone()) {
        reason_codes.push("category_already_matches".into());
    }

    // Proposed category still exists and is not deleted
    let cat_exists = snapshot
        .categories
        .iter()
        .any(|c| c.id == plan.proposed_category_id && !c.deleted);
    if !cat_exists {
        failure_codes.push("proposed_category_not_found".into());
    }

    // Evaluate declared postconditions independently of built-in checks.
    for pc in &plan.postconditions {
        match pc.condition_type {
            PostconditionType::CategoryExists => {
                let exists = snapshot
                    .categories
                    .iter()
                    .any(|c| c.id == pc.category_id && !c.deleted);
                if !exists {
                    failure_codes.push("postcondition_not_met".into());
                }
            }
        }
    }

    let verified = failure_codes.is_empty();
    // Append failure codes after observations (failure codes come second so
    // a consumer scanning for the first failure sees it after diagnostics).
    reason_codes.extend(failure_codes);
    if verified {
        reason_codes.push("postcondition_verified".into());
    }

    let reasons = reason_codes.clone();
    VerificationResult {
        verified,
        reason_codes,
        message: if verified {
            None
        } else {
            Some(format!("Verification failed: {:?}", reasons))
        },
    }
}



/// Plan the creation of a new rule based on payee conditions and a target category.
///
/// Normalizes the first payee condition's value and produces a trigger/actions
/// payload suitable for rule creation.
pub fn plan_create_rule(
    name: &str,
    payee_conditions: &[PayeeCondition],
    category_id: &str,
    _snapshot: &ProtocolSnapshot,
) -> CreateRulePlan {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    // Normalize the payee value from the first condition.  If there are no
    // conditions we still produce a plan, but the trigger will be empty.
    let normalized_payee = payee_conditions
        .first()
        .map(|c| c.value.trim().to_lowercase())
        .unwrap_or_default();

    let trigger = serde_json::json!({
        "type": "payee_is",
        "value": normalized_payee,
    });

    let actions = serde_json::json!([{
        "type": "set_category",
        "value": category_id,
    }]);

    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    for c in payee_conditions {
        c.field.hash(&mut hasher);
        c.operation.hash(&mut hasher);
        c.value.hash(&mut hasher);
    }
    category_id.hash(&mut hasher);
    let hash = format!("{:x}", hasher.finish());

    CreateRulePlan {
        plan_id: format!("rule_plan_{}", hash),
        rule_name: name.to_string(),
        trigger,
        actions,
        hash,
        conditions: payee_conditions.to_vec(),
    }
}

/// Verify that a rule creation plan does not conflict with existing rules.
///
/// Returns `verified: false` with reason code `rule_already_exists` when the
/// snapshot already contains a rule whose trigger and actions match the plan.
pub fn verify_rule_mutation(
    plan: &CreateRulePlan,
    snapshot: &ProtocolSnapshot,
) -> VerificationResult {
    use fc::normalize_merchant;

    // Normalize both sides for payee_is comparison — plan_create_rule
    // already normalizes the payee name to lowercase, but existing rules
    // may have original casing.
    let plan_trigger_value = plan.trigger.get("value").and_then(|v| v.as_str()).unwrap_or("");
    let plan_norm = normalize_merchant(plan_trigger_value);

    let exists = snapshot.rules.iter().any(|existing| {
        // Compare actions exactly
        if existing.actions != plan.actions {
            return false;
        }
        // Compare triggers with normalization for payee_is type
        if existing.trigger == plan.trigger {
            return true;
        }
        // Allow normalized match for payee_is triggers
        if existing.trigger.get("type").and_then(|v| v.as_str()) == Some("payee_is") {
            let existing_val = existing.trigger.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let existing_norm = normalize_merchant(existing_val);
            return existing_norm == plan_norm;
        }
        false
    });

    if exists {
        VerificationResult {
            verified: false,
            reason_codes: vec!["rule_already_exists".into()],
            message: Some(format!(
                "A rule with trigger {:?} and actions {:?} already exists",
                plan.trigger, plan.actions
            )),
        }
    } else {
        VerificationResult {
            verified: true,
            reason_codes: vec!["rule_creation_verified".into()],
            message: None,
        }
    }
}

/// Simulate what would happen if a rule were applied to a set of transactions.
///
/// Evaluates the rule's trigger conditions against each transaction:
/// - `payee_is` – normalized payee name comparison
/// - `transaction_added` – matches all transactions
/// - `amount_less_than` / `amount_greater_than` – compares `amount.minor_units` to the threshold
pub fn simulate_rule(
    rule: &Rule,
    transactions: &[Transaction],
) -> RuleSimulationResult {
    if rule.inactive {
        return RuleSimulationResult {
            rule_id: rule.id.clone(),
            name: rule.name.clone(),
            transactions_matched: 0,
            transactions_affected: vec![],
            category_distribution: HashMap::new(),
            conflicts: vec![],
            examples: vec![],
        };
    }

    let trigger_type = rule
        .trigger
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let trigger_value = rule.trigger.get("value");

    // Extract target category ID from the actions, if present.
    let target_category = extract_action_value(&rule.actions);

    let mut matched: u32 = 0;
    let mut affected: Vec<String> = Vec::new();
    let mut category_distribution: HashMap<String, u32> = HashMap::new();
    let conflicts: Vec<String> = Vec::new();
    let mut examples: Vec<SimulationExample> = Vec::new();

    for tx in transactions {
        let matches = match trigger_type {
            "payee_is" => {
                let raw = trigger_value.and_then(|v| v.as_str()).unwrap_or("");
                let norm_trigger = normalize_merchant(raw);
                let norm_tx =
                    normalize_merchant(tx.payee_name.as_deref().unwrap_or(""));
                !norm_trigger.is_empty() && norm_trigger == norm_tx
            }
            "transaction_added" => true,
            "amount_less_than" => {
                let threshold = trigger_value
                    .and_then(|v| v.as_i64())
                    .unwrap_or(i64::MAX);
                tx.amount.minor_units() < threshold
            }
            "amount_greater_than" => {
                let threshold = trigger_value
                    .and_then(|v| v.as_i64())
                    .unwrap_or(i64::MIN);
                tx.amount.minor_units() > threshold
            }
            _ => false,
        };

        if matches {
            matched += 1;
            affected.push(tx.id.clone());

            // Determine if the category would change:
            // if we know the target, compare; otherwise fall back to uncategorized check.
            let would_change = if let Some(target) = &target_category {
                tx.category_id.as_deref() != Some(target.as_str())
            } else {
                tx.category_id.is_none() || tx.category_id.as_deref() == Some("")
            };

            let dist_key = target_category
                .clone()
                .unwrap_or_default();
            *category_distribution.entry(dist_key).or_insert(0) += 1;

            examples.push(SimulationExample {
                tx_id: tx.id.clone(),
                payee: tx.payee_name.clone(),
                amount: tx.amount.clone(),
                current_category: tx.category_name.clone(),
                would_change,
            });
        }
    }

    RuleSimulationResult {
        rule_id: rule.id.clone(),
        name: rule.name.clone(),
        transactions_matched: matched,
        transactions_affected: affected,
        category_distribution,
        conflicts,
        examples,
    }
}

/// Extract the `value` field (category ID) from a set-category action.
/// Actions are a JSON array of `{"type":"set_category","value":"cat-id"}`.
fn extract_action_value(actions: &serde_json::Value) -> Option<String> {
    if let Some(arr) = actions.as_array() {
        for action in arr {
            if let Some(obj) = action.as_object() {
                if let Some(cat) = obj.get("value").and_then(|v| v.as_str()) {
                    if !cat.is_empty() {
                        return Some(cat.to_string());
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use fc::Money;

    fn sample_account(id: &str, name: &str) -> Account {
        Account {
            id: id.into(),
            name: name.into(),
            account_type: "checking".into(),
            off_budget: false,
            is_closed: false,
            cleared_balance: Money::new(1000, "USD"),
            imported_balance: Money::new(1000, "USD"),
            mtid: None,
        }
    }

    fn sample_tx(
        id: &str,
        account_id: &str,
        date: &str,
        cleared: bool,
        category_id: Option<&str>,
    ) -> Transaction {
        Transaction {
            id: id.into(),
            account_id: account_id.into(),
            date: date.into(),
            payee_id: None,
            payee_name: None,
            category_id: category_id.map(|s| s.into()),
            category_name: None,
            amount: Money::new(100, "USD"),
            cleared,
            reconciled: false,
            imported_id: None,
            imported_payee: None,
            notes: None,
            tags: vec![],
            transfer_account_id: None,
            subtransactions: vec![],
        }
    }

    fn sample_category(id: &str, name: &str, deleted: bool) -> Category {
        Category {
            id: id.into(),
            name: name.into(),
            group_name: None,
            is_income: false,
            mtid: None,
            deleted,
        }
    }

    fn make_snapshot() -> ProtocolSnapshot {
        ProtocolSnapshot {
            schema_version: "1.0".into(),
            actual_version: "25.1.0".into(),
            snapshot_date: "2026-07-18".into(),
            accounts: vec![sample_account("a1", "Checking")],
            transactions: vec![
                sample_tx("tx1", "a1", "2026-07-01", true, None),
            ],
            categories: vec![sample_category("c1", "Food", false)],
            payees: vec![],
            rules: vec![],
            schedules: vec![],
            budgets: vec![],
            tags: vec![],
            actual_downloaded_at: Some("2026-07-18T00:00:00Z".into()),
            encrypted: Some(false),
            bank_synced_at: Some("2026-07-17T00:00:00Z".into()),
        }
    }

    #[test]
    fn test_analyze_deterministic_max_results_limits_findings() {
        let snapshot = make_snapshot();
        let request = DeterministicAnalysisRequest {
            snapshot,
            options: AnalysisOptions {
                include_pending: true,
                include_cleared: true,
                max_results: Some(0),
            },
            request_id: Some("req-1".into()),
            actor_id: None,
        };
        let response = analyze_deterministic(request);
        // max_results=0 should limit non-essential collections to empty
        assert!(response.analysis.repeated_merchants.is_empty());
        assert!(response.analysis.deterministic_classifications.is_empty());
        assert_eq!(response.schema_version, "1", "deterministic response must emit schemaVersion '1'");
    }

    #[test]
    fn test_analyze_deterministic_error_info_on_blocker() {
        let mut snapshot = make_snapshot();
        // Remove download timestamp to trigger staleness blocker
        snapshot.actual_downloaded_at = None;
        snapshot.encrypted = Some(true);
        let request = DeterministicAnalysisRequest {
            snapshot,
            options: AnalysisOptions {
                include_pending: true,
                include_cleared: true,
                max_results: None,
            },
            request_id: Some("req-2".into()),
            actor_id: None,
        };
        let response = analyze_deterministic(request);
        // When there are blockers, status should be "error" and error should be populated
        assert_eq!(response.status, "error");
        assert!(
            response.error.is_some(),
            "ErrorInfo should be populated when status is error"
        );
        if let Some(err) = &response.error {
            assert_eq!(err.code, "analysis_error");
        }
        assert_eq!(response.schema_version, "1", "blocker error response must emit schemaVersion '1'");
    }

    #[test]
    fn test_analyze_deterministic_ok_no_error_info() {
        let snapshot = make_snapshot();
        let request = DeterministicAnalysisRequest {
            snapshot,
            options: AnalysisOptions {
                include_pending: true,
                include_cleared: true,
                max_results: None,
            },
            request_id: Some("req-3".into()),
            actor_id: None,
        };
        let response = analyze_deterministic(request);
        assert_eq!(response.status, "ok");
        assert!(response.error.is_none(), "No error when status is ok");
        assert_eq!(response.schema_version, "1", "ok response must emit schemaVersion '1'");
    }

    // -- maxResults applied to analyze_snapshot ------------------------------

    #[test]
    fn test_analyze_snapshot_max_results_truncates() {
        let snapshot = make_snapshot();
        let request = AnalysisRequest {
            snapshot,
            options: AnalysisOptions {
                include_pending: true,
                include_cleared: true,
                max_results: Some(0),
            },
        };
        let result = analyze_snapshot(request);
        // max_results=0 should truncate findings and suggestions, leading to "success"
        assert_eq!(result.result_code, "success", "max_results=0 truncates all findings -> no issues");
        assert!(result.findings.is_empty());
        assert!(result.suggestions.is_empty());
    }

    // -----------------------------------------------------------------------
    // Schema version contract: emit "1", accept "1.0"
    // -----------------------------------------------------------------------

    #[test]
    fn test_deterministic_response_schema_version_on_unsupported_version() {
        let mut snapshot = make_snapshot();
        snapshot.schema_version = "2.0".into(); // unsupported
        let request = DeterministicAnalysisRequest {
            snapshot,
            options: AnalysisOptions {
                include_pending: true,
                include_cleared: true,
                max_results: None,
            },
            request_id: Some("req-uv".into()),
            actor_id: None,
        };
        let response = analyze_deterministic(request);
        assert_eq!(
            response.schema_version, "1",
            "error response for unsupported version must still emit schemaVersion '1'"
        );
        assert_eq!(response.status, "error");
        assert!(response.error.is_some());
    }

    #[test]
    fn test_deterministic_accepts_legacy_schema_version_1_0() {
        // "1.0" must still be accepted as input
        let mut snapshot = make_snapshot();
        snapshot.schema_version = "1.0".into();
        let request = DeterministicAnalysisRequest {
            snapshot,
            options: AnalysisOptions {
                include_pending: true,
                include_cleared: true,
                max_results: None,
            },
            request_id: Some("req-legacy".into()),
            actor_id: None,
        };
        let response = analyze_deterministic(request);
        assert_eq!(
            response.schema_version, "1",
            "response for legacy '1.0' input must emit canonical schemaVersion '1'"
        );
        assert_eq!(response.status, "ok");
    }

    #[test]
    fn test_analysis_accepts_schema_version_1() {
        // Canonical "1" must work as input
        let mut snapshot = make_snapshot();
        snapshot.schema_version = "1".into();
        let request = AnalysisRequest {
            snapshot,
            options: AnalysisOptions {
                include_pending: true,
                include_cleared: true,
                max_results: None,
            },
        };
        let result = analyze_snapshot(request);
        assert_ne!(result.result_code, "error",
            "canonical schema_version '1' must be accepted; got error");
    }
}
