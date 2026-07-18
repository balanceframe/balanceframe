#![forbid(unsafe_code)]

use balanceframe_financial_core::{
    Account, BudgetMonth, CategorizationCandidate, Category, Payee, Rule, Schedule, Tag,
    Transaction,
};
use serde::{Deserialize, Serialize};

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

    let mut findings: Vec<Finding> = Vec::new();
    let mut suggestions: Vec<Suggestion> = Vec::new();
    let mut reason_codes: Vec<String> = Vec::new();

    // Transaction-level checks
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

    // Uncategorized transactions
    let uncategorized: Vec<&Transaction> = snapshot
        .transactions
        .iter()
        .filter(|tx| tx.category_id.is_none() || tx.category_id.as_deref() == Some(""))
        .collect();

    if !uncategorized.is_empty() {
        let total_minor: i64 = uncategorized
            .iter()
            .map(|tx| tx.amount.minor_units().abs())
            .sum();

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

    // Category integrity
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

    // Budget coverage
    let uncategorized_ids: std::collections::HashSet<&str> = uncategorized
        .iter()
        .filter_map(|tx| tx.category_id.as_deref())
        .collect();

    if !uncategorized_ids.is_empty() {
        reason_codes.push("uncategorized".into());
    }

    // Apply max_results limit
    if let Some(max) = options.max_results {
        let max = max as usize;
        findings.truncate(max);
        suggestions.truncate(max);
    }

    // Determine result code
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
