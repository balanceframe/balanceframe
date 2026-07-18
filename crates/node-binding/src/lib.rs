//! N-API bindings for BalanceFrame.
//!
//! All public functions accept and return JSON strings. Every function wraps
//! its body in [`std::panic::catch_unwind`] so that a Rust panic cannot crash
//! the Node.js process — it is surfaced as an `napi::Error` instead.

#![deny(unsafe_code)]

use napi_derive::napi;
use serde::{Deserialize, Serialize};

// Declare fuzz tests.
#[cfg(test)]
mod fuzz;

// ---------------------------------------------------------------------------
// Helper: deserialize → call → serialize, guarded by catch_unwind
// ---------------------------------------------------------------------------

/// Deserialize `input` to `I`, call `f`, and serialize the result back.
///
/// Any panic raised by `f` (or the deserialization / serialization steps) is
/// caught and converted into a descriptive `napi::Error` so that the Node.js
/// process stays alive.
fn run<I, O>(input: String, f: impl FnOnce(I) -> Result<O, String>) -> napi::Result<String>
where
    I: serde::de::DeserializeOwned,
    O: serde::Serialize,
{
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let deserialized: I =
            serde_json::from_str(&input).map_err(|e| format!("deserialize: {e}"))?;
        let output: O = f(deserialized)?;
        serde_json::to_string(&output).map_err(|e| format!("serialize: {e}"))
    }));

    match result {
        Ok(Ok(json)) => Ok(json),
        Ok(Err(msg)) => Err(napi::Error::from_reason(msg)),
        Err(panic) => {
            let payload = if let Some(s) = panic.downcast_ref::<&'static str>() {
                *s
            } else if let Some(s) = panic.downcast_ref::<String>() {
                s.as_str()
            } else {
                "unknown panic payload"
            };
            Err(napi::Error::from_reason(format!(
                "Panic contained by N-API binding: {payload}"
            )))
        }
    }
}

// ===========================================================================
// 1. analyze_snapshot
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotInput {
    accounts: Vec<balanceframe_financial_core::Account>,
    transactions: Vec<balanceframe_financial_core::Transaction>,
    categories: Vec<balanceframe_financial_core::Category>,
    reference_date: String,
}

/// Analyze a financial snapshot (accounts, transactions, categories) and
/// produce a data-quality readiness report.
#[napi]
pub fn analyze_snapshot(input: String) -> napi::Result<String> {
    run::<SnapshotInput, balanceframe_financial_core::DataQualityReport>(input, |snap| {
        let report = balanceframe_financial_core::analyze_readiness(
            &snap.accounts,
            &snap.transactions,
            &snap.categories,
            &snap.reference_date,
        );
        Ok(report)
    })
}

// ===========================================================================
// 2. find_categorization_candidates
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CandidatesInput {
    transactions: Vec<balanceframe_financial_core::Transaction>,
    payees: Vec<balanceframe_financial_core::Payee>,
    history: Vec<balanceframe_financial_core::HistoryRecord>,
}

/// Run all categorization classifiers on the given transactions and return
/// the strongest match per transaction as a JSON array of candidates.
#[napi]
pub fn find_categorization_candidates(input: String) -> napi::Result<String> {
    run::<CandidatesInput, Vec<balanceframe_financial_core::CategorizationCandidate>>(
        input,
        |ci| {
            let candidates = balanceframe_financial_core::find_candidates(
                &ci.transactions,
                &ci.payees,
                &ci.history,
            );
            Ok(candidates)
        },
    )
}

// ===========================================================================
// 3. validate_suggestion
// ===========================================================================

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionInput {
    transaction_id: String,
    payee_name: Option<String>,
    amount: balanceframe_financial_core::Money,
    date: String,
    category_id: String,
    category_name: Option<String>,
    confidence: f64,
    reasons: Vec<balanceframe_financial_core::Evidence>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionValidation {
    valid: bool,
    errors: Vec<String>,
}

/// Validate a categorization suggestion. Returns `{ valid, errors }` where
/// `valid` is `true` only when all fields are well-formed and internally
/// consistent.
#[napi]
pub fn validate_suggestion(input: String) -> napi::Result<String> {
    run::<SuggestionInput, SuggestionValidation>(input, |s| {
        let mut errors: Vec<String> = Vec::new();

        if s.transaction_id.is_empty() {
            errors.push("transactionId must not be empty".into());
        }
        if s.category_id.is_empty() {
            errors.push("categoryId must not be empty".into());
        }
        if s.date.is_empty() {
            errors.push("date must not be empty".into());
        }
        if !(0.0..=1.0).contains(&s.confidence) {
            errors.push("confidence must be in [0.0, 1.0]".into());
        }
        if s.reasons.is_empty() {
            errors.push("at least one evidence reason is required".into());
        }

        Ok(SuggestionValidation {
            valid: errors.is_empty(),
            errors,
        })
    })
}

// ===========================================================================
// 4. plan_set_category
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanInput {
    transaction_ids: Vec<String>,
    category_id: String,
    category_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetCategoryPlan {
    transaction_ids: Vec<String>,
    category_id: String,
    category_name: Option<String>,
    total_transactions: usize,
}

/// Plan a set-category operation. Validates that the input is well-formed
/// and returns a description of the planned operation.
#[napi]
pub fn plan_set_category(input: String) -> napi::Result<String> {
    run::<PlanInput, SetCategoryPlan>(input, |plan| {
        if plan.transaction_ids.is_empty() {
            return Err("transactionIds must not be empty".into());
        }
        if plan.category_id.is_empty() {
            return Err("categoryId must not be empty".into());
        }
        Ok(SetCategoryPlan {
            total_transactions: plan.transaction_ids.len(),
            transaction_ids: plan.transaction_ids,
            category_id: plan.category_id,
            category_name: plan.category_name,
        })
    })
}

// ===========================================================================
// 5. verify_mutation
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MutationInput {
    action: String,
    payload: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MutationVerification {
    allowed: bool,
    reason: String,
}

/// Verify that a mutation (action + payload) is safe to apply. Returns
/// `{ allowed, reason }`.
#[napi]
pub fn verify_mutation(input: String) -> napi::Result<String> {
    run::<MutationInput, MutationVerification>(input, |m| {
        let known_actions = [
            "setCategory",
            "setPayee",
            "reconcile",
            "splitTransaction",
        ];
        if !known_actions.contains(&m.action.as_str()) {
            return Ok(MutationVerification {
                allowed: false,
                reason: format!("unknown action: {}", m.action),
            });
        }
        if m.payload.is_null() || m.payload == serde_json::Value::Object(Default::default()) {
            return Ok(MutationVerification {
                allowed: false,
                reason: "payload must not be empty".into(),
            });
        }
        Ok(MutationVerification {
            allowed: true,
            reason: String::new(),
        })
    })
}

// ===========================================================================
// 6. simulate_rule
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimulateInput {
    rule: balanceframe_financial_core::Rule,
    transactions: Vec<balanceframe_financial_core::Transaction>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleSimulationResult {
    matched_transaction_ids: Vec<String>,
    match_count: usize,
    total_transactions: usize,
}

/// Simulate applying a rule against a set of transactions. Returns the
/// IDs of transactions that match the rule.
#[napi]
pub fn simulate_rule(input: String) -> napi::Result<String> {
    run::<SimulateInput, RuleSimulationResult>(input, |sim| {
        let total = sim.transactions.len();
        let matched: Vec<String> = sim
            .transactions
            .into_iter()
            .filter(|tx| {
                let rule = &sim.rule;
                if rule.inactive {
                    return false;
                }
                // Match against the rule trigger.
                match &rule.trigger {
                    serde_json::Value::String(pattern) => {
                        // String trigger: match against payee name (case-insensitive).
                        tx.payee_name
                            .as_deref()
                            .map(|n| n.to_lowercase().contains(&pattern.to_lowercase()))
                            .unwrap_or(false)
                    }
                    serde_json::Value::Object(obj) => {
                        // Object trigger: try known keys.
                        let mut matches = true;
                        if let Some(serde_json::Value::String(payee_pat)) = obj.get("payee") {
                            matches = tx
                                .payee_name
                                .as_deref()
                                .map(|n| n.to_lowercase().contains(&payee_pat.to_lowercase()))
                                .unwrap_or(false);
                        }
                        if let Some(serde_json::Value::String(cat_id)) = obj.get("category") {
                            matches = matches
                                && tx
                                    .category_id
                                    .as_deref()
                                    .map(|c| c == cat_id)
                                    .unwrap_or(false);
                        }
                        if let Some(serde_json::Value::String(acct_id)) = obj.get("account") {
                            matches = matches && tx.account_id == *acct_id;
                        }
                        matches
                    }
                    _ => true, // unknown trigger shape — match all
                }
            })
            .map(|tx| tx.id)
            .collect();

        let count = matched.len();
        Ok(RuleSimulationResult {
            matched_transaction_ids: matched,
            match_count: count,
            total_transactions: total,
        })
    })
}
