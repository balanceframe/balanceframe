//! N-API bindings for BalanceFrame.
//!
//! All public functions accept and return JSON strings. Every function wraps
//! its body in [`std::panic::catch_unwind`] so that a Rust panic cannot crash
//! the Node.js process — it is surfaced as an `napi::Error` instead.
//!
//! All functions route through `balanceframe_core_protocol` types so the N-API
//! boundary is the canonical protocol snapshot + request/response types.

#![forbid(unsafe_code)]

use napi_derive::napi;
use serde::Deserialize;

use balanceframe_core_protocol as cp;
pub use balanceframe_core_protocol::{
    AnalysisRequest, AnalysisResult, CreateRulePlan, DeterministicAnalysisRequest,
    DeterministicAnalysisResponse, MutationPlan, PayeeCondition, ProtocolSnapshot,
    RuleSimulationResult, Suggestion, ValidationResult, VerificationResult,
};
pub use balanceframe_financial_core::{
    Category, CategorizationCandidate, Rule, RuleCandidate, Transaction,
};

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

/// Analyze a financial snapshot (accounts, transactions, categories) and
/// produce a data-quality readiness report.
#[napi]
pub fn analyze_snapshot(input: String) -> napi::Result<String> {
    run::<AnalysisRequest, AnalysisResult>(input, |req| Ok(cp::analyze_snapshot(req)))
}

// ===========================================================================
// 1b. analyze_deterministic
// ===========================================================================

/// Run the deterministic (no‑model) analysis pipeline on a snapshot.
/// Returns structured findings for uncategorized backlog, repeated merchants,
/// duplicate evidence, rule candidates, recurring charges, and historical
/// corrections — all without invoking any model provider.
#[napi]
pub fn analyze_deterministic(input: String) -> napi::Result<String> {
    run::<DeterministicAnalysisRequest, DeterministicAnalysisResponse>(input, |req| {
        Ok(cp::analyze_deterministic(req))
    })
}

// ===========================================================================
// 2. find_categorization_candidates
// ===========================================================================

/// Run all categorization classifiers on the given transactions and return
/// the strongest match per transaction as a JSON array of candidates.
#[napi]
pub fn find_categorization_candidates(input: String) -> napi::Result<String> {
    run::<Vec<Transaction>, Vec<CategorizationCandidate>>(input, |txns| {
        Ok(cp::find_categorization_candidates(txns))
    })
}

// ===========================================================================
// 3. validate_suggestion
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateSuggestionInput {
    suggestion: Suggestion,
    snapshot: ProtocolSnapshot,
}

/// Validate a categorization suggestion. Returns `{ valid, errors }` where
/// `valid` is `true` only when all fields are well-formed and internally
/// consistent.
#[napi]
pub fn validate_suggestion(input: String) -> napi::Result<String> {
    run::<ValidateSuggestionInput, ValidationResult>(input, |vsi| {
        Ok(cp::validate_suggestion(&vsi.suggestion, &vsi.snapshot))
    })
}

// ===========================================================================
// 3b. validate_provider_suggestion
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateProviderSuggestionInput {
    suggestion: Suggestion,
    snapshot: ProtocolSnapshot,
    candidate: CategorizationCandidate,
    effective_policy: Option<cp::InferencePolicy>,
}

/// Validate a provider-issued suggestion against the current snapshot,
/// candidate eligibility, and inference policy (e.g. disabled, localOnly).
/// Returns `{ valid, reasonCodes, message }`.
///
/// This is the authoritative Rust gate before a provider suggestion is
/// persisted — it performs basic suggestion validation plus candidate
/// eligibility, staleness detection, policy enforcement, and metadata
/// integrity checks, all without mutating any data.
#[napi]
pub fn validate_provider_suggestion(input: String) -> napi::Result<String> {
    run::<ValidateProviderSuggestionInput, ValidationResult>(input, |vpsi| {
        Ok(cp::validate_provider_suggestion(
            &vpsi.suggestion,
            &vpsi.snapshot,
            &vpsi.candidate,
            Some(vpsi.effective_policy.unwrap_or(cp::InferencePolicy::Disabled)),
        ))
    })
}

// ===========================================================================
// 4. plan_set_category
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSetCategoryInput {
    transaction: Transaction,
    category: Category,
}

/// Plan a set-category operation. Validates that the input is well-formed
/// and returns a description of the planned operation.
#[napi]
pub fn plan_set_category(input: String) -> napi::Result<String> {
    run::<PlanSetCategoryInput, MutationPlan>(input, |psc| {
        Ok(cp::plan_set_category(&psc.transaction, &psc.category))
    })
}

// ===========================================================================
// 5. verify_mutation
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyMutationInput {
    plan: MutationPlan,
    snapshot: ProtocolSnapshot,
}

/// Verify that a mutation (action + payload) is safe to apply. Returns
/// `{ allowed, reason }`.
#[napi]
pub fn verify_mutation(input: String) -> napi::Result<String> {
    run::<VerifyMutationInput, VerificationResult>(input, |vmi| {
        Ok(cp::verify_mutation(&vmi.plan, &vmi.snapshot))
    })
}

// ===========================================================================
// 6. simulate_rule
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimulateRuleInput {
    rule: Rule,
    transactions: Vec<Transaction>,
}

/// Simulate applying a rule against a set of transactions. Returns the
/// IDs of transactions that match the rule.
#[napi]
pub fn simulate_rule(input: String) -> napi::Result<String> {
    run::<SimulateRuleInput, RuleSimulationResult>(input, |sri| {
        Ok(cp::simulate_rule(&sri.rule, &sri.transactions))
    })
}

// ===========================================================================
// 7. plan_create_rule
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanCreateRuleInput {
    rule_name: String,
    payee_name: String,
    category_id: String,
    snapshot: ProtocolSnapshot,
}

/// Plan the creation of a new rule based on a payee name.
/// Returns a CreateRulePlan describing the planned operation.
#[napi]
pub fn plan_create_rule(input: String) -> napi::Result<String> {
    run::<PlanCreateRuleInput, CreateRulePlan>(input, |pci| {
        let conditions = vec![PayeeCondition {
            field: "payee".into(),
            operation: "is".into(),
            value: pci.payee_name,
        }];
        Ok(cp::plan_create_rule(
            &pci.rule_name,
            &conditions,
            &pci.category_id,
            &pci.snapshot,
        ))
    })
}

// ===========================================================================
// 8. verify_rule_mutation
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyRuleMutationInput {
    plan: CreateRulePlan,
    snapshot: ProtocolSnapshot,
}

/// Verify that a rule creation plan is still valid against a snapshot.
/// Returns { verified, reasonCodes, message }.
#[napi]
pub fn verify_rule_mutation(input: String) -> napi::Result<String> {
    run::<VerifyRuleMutationInput, VerificationResult>(input, |vrmi| {
        Ok(cp::verify_rule_mutation(&vrmi.plan, &vrmi.snapshot))
    })
}

// ===========================================================================
// 9. analyze_rule_candidates
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnalyzeRuleCandidatesInput {
    snapshot: ProtocolSnapshot,
    min_consistent_count: u32,
}

/// Find merchants that are consistently categorized to the same category
/// above a minimum count threshold, and return them as rule candidates.
#[napi]
pub fn analyze_rule_candidates(input: String) -> napi::Result<String> {
    run::<AnalyzeRuleCandidatesInput, Vec<RuleCandidate>>(input, |arci| {
        Ok(cp::analyze_rule_candidates(&arci.snapshot, arci.min_consistent_count))
    })
}
