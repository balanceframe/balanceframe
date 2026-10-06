//! N-API bindings for BalanceFrame.
//!
//! All public functions accept and return JSON strings. Every function wraps
//! its body in [`std::panic::catch_unwind`] so that a Rust panic cannot crash
//! the Node.js process — it is surfaced as an `napi::Error` instead.
//!
//! All functions route through `balanceframe_core_protocol` types so the N-API
//! boundary is the canonical protocol snapshot + request/response types.

#![forbid(unsafe_code)]

use napi::{Env, JsFunction, JsString};
use napi_derive::napi;
use serde::Deserialize;
use serde_json::Value;

use balanceframe_core_protocol as cp;
pub use balanceframe_core_protocol::{
    AnalysisRequest, AnalysisResult, BillCalendar, BudgetVarianceReport, CashFlowProjectionRequest,
    CashFlowProjectionResponse, CreateRulePlan, CreateRuleRequest, DataQualityCenter,
    DeterministicAnalysisRequest, DeterministicAnalysisResponse, FinancialStateLabel,
    FinancialStateRequest, ForecastCalibration, IncomeReliabilityReport,
    IrregularObligationsReport, LiquidityCoverage, MerchantAnalysisRequest, MerchantAnalysisResult,
    MultidimensionalHealth, MutationPlan, ProtocolSnapshot, PurchaseEvaluation,
    PurchaseEvaluationRequest, RuleReviewContext, RuleSimulationResult, Suggestion,
    TargetHealthRequest, TargetHealthResult, ValidationResult, VerificationResult,
};
pub use balanceframe_financial_core::{
    CategorizationCandidate, Category, Rule, RuleCandidate, Transaction,
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
    run_serialized(input, f, |output| {
        serde_json::to_string(output).map_err(|error| format!("serialize: {error}"))
    })
}

fn run_serialized<I, O, R>(
    input: String,
    f: impl FnOnce(I) -> Result<O, String>,
    serialize: impl FnOnce(&O) -> Result<R, String>,
) -> napi::Result<R>
where
    I: serde::de::DeserializeOwned,
{
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let deserialized: I =
            serde_json::from_str(&input).map_err(|e| format!("deserialize: {e}"))?;
        // DeserializeOwned cannot retain input; release it before analysis/output allocations.
        drop(input);
        let output: O = f(deserialized)?;
        serialize(&output)
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

const JSON_CHUNK_BYTES: usize = 64 * 1024;

// Bound Rust staging while JavaScript owns the complete emitted string.
struct MerchantJsonWriter<'env> {
    env: &'env Env,
    concatenate: JsFunction,
    output: Option<JsString>,
    bytes: Vec<u8>,
}

impl MerchantJsonWriter<'_> {
    fn flush_chunk(&mut self) -> std::io::Result<()> {
        if self.bytes.is_empty() {
            return Ok(());
        }
        let text = match std::str::from_utf8(&self.bytes) {
            Ok(text) => text,
            Err(error) if error.error_len().is_none() => {
                std::str::from_utf8(&self.bytes[..error.valid_up_to()])
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?
            }
            Err(error) => {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, error));
            }
        };
        if text.is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "Incomplete JSON UTF-8",
            ));
        }
        let length = text.len();
        let chunk = self
            .env
            .create_string(text)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        let previous = self
            .output
            .take()
            .expect("JSON string accumulator is initialized");
        self.output = Some(
            self.concatenate
                .call(None, &[previous, chunk])
                .and_then(|value| value.coerce_to_string())
                .map_err(|error| std::io::Error::other(error.to_string()))?,
        );
        drop(self.bytes.drain(..length));
        Ok(())
    }
}

impl std::io::Write for MerchantJsonWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let mut remaining = bytes;
        while !remaining.is_empty() {
            let length = remaining.len().min(JSON_CHUNK_BYTES - self.bytes.len());
            self.bytes.extend_from_slice(&remaining[..length]);
            remaining = &remaining[length..];
            if self.bytes.len() == JSON_CHUNK_BYTES {
                self.flush_chunk()?;
            }
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        while !self.bytes.is_empty() {
            self.flush_chunk()?;
        }
        Ok(())
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

/// Analyze an already-authorized merchant capture with bounded explanations and
/// lossless schedule provenance; no provider or ledger mutation is invoked.
#[napi]
pub fn analyze_merchant_intelligence(env: Env, input: String) -> napi::Result<JsString> {
    run_serialized::<MerchantAnalysisRequest, MerchantAnalysisResult, _>(
        input,
        |request| cp::analyze_merchant_intelligence(&request).map_err(|error| error.to_string()),
        |output| {
            let mut writer = MerchantJsonWriter {
                env: &env,
                concatenate: env
                    .run_script("((left, right) => left + right)")
                    .map_err(|error| error.to_string())?,
                output: Some(env.create_string("").map_err(|error| error.to_string())?),
                bytes: Vec::with_capacity(JSON_CHUNK_BYTES),
            };
            serde_json::to_writer(&mut writer, output)
                .map_err(|error| format!("serialize: {error}"))?;
            std::io::Write::flush(&mut writer).map_err(|error| format!("serialize: {error}"))?;
            Ok(writer
                .output
                .take()
                .expect("Complete JSON string is available"))
        },
    )
    .map_err(|_| napi::Error::from_reason("merchant_analysis_failed"))
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
            Some(
                vpsi.effective_policy
                    .unwrap_or(cp::InferencePolicy::Disabled),
            ),
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanCreateRuleInput {
    rule_name: String,
    payee_id: String,
    category_id: String,
    review_context: RuleReviewContext,
    snapshot: ProtocolSnapshot,
}

/// Plan a native category rule for an exact Actual payee ID and current review context.
/// Returns a CreateRulePlan describing the planned operation.
#[napi]
pub fn plan_create_rule(input: String) -> napi::Result<String> {
    run::<PlanCreateRuleInput, CreateRulePlan>(input, |pci| {
        cp::plan_create_rule(
            &CreateRuleRequest {
                rule_name: pci.rule_name,
                payee_id: pci.payee_id,
                category_id: pci.category_id,
                review_context: pci.review_context,
            },
            &pci.snapshot,
        )
        .map_err(|error| error.to_string())
    })
}

// ===========================================================================
// 8. verify_rule_mutation
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RulePlanSnapshotInput {
    plan: CreateRulePlan,
    snapshot: ProtocolSnapshot,
}

/// Preview a complete creation plan against current transactions and active rule conflicts.
/// Deserialization and native failures become JavaScript errors; this performs no writes.
#[napi]
pub fn simulate_create_rule_plan(input: String) -> napi::Result<String> {
    run::<RulePlanSnapshotInput, RuleSimulationResult>(input, |request| {
        cp::simulate_create_rule_plan(&request.plan, &request.snapshot)
            .map_err(|error| error.to_string())
    })
}

/// Verify the created rule's complete postcondition in a fresh Actual snapshot.
/// Absence or mismatched content returns an unverified result; this performs no writes.
#[napi]
pub fn verify_rule_mutation(input: String) -> napi::Result<String> {
    run::<RulePlanSnapshotInput, VerificationResult>(input, |vrmi| {
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
        Ok(cp::analyze_rule_candidates(
            &arci.snapshot,
            arci.min_consistent_count,
        ))
    })
}

// ===========================================================================
// 10. evaluate_purchase
// ===========================================================================

/// Evaluate whether a proposed purchase is allowable given budget constraints.
/// Input: PurchaseEvaluationRequest. Returns PurchaseEvaluation JSON.
#[napi]
pub fn evaluate_purchase(input: String) -> napi::Result<String> {
    run::<PurchaseEvaluationRequest, PurchaseEvaluation>(input, |req| {
        Ok(cp::evaluate_purchase(req))
    })
}

/// Evaluate a prospective purchase against the canonical financial snapshot.
/// Input: ProspectivePurchaseEvaluationRequest. Returns
/// ProspectiveDecisionEnvelope<PurchaseEvaluation> JSON.
#[napi]
pub fn evaluate_prospective_purchase(input: String) -> napi::Result<String> {
    run::<
        cp::ProspectivePurchaseEvaluationRequest,
        cp::ProspectiveDecisionEnvelope<PurchaseEvaluation>,
    >(input, |req| Ok(cp::evaluate_prospective_purchase(req)))
}

/// Evaluate a canonical joint account-aware spendability scenario as JSON.
#[napi]
pub fn evaluate_account_aware_spendability(input: String) -> napi::Result<String> {
    run::<cp::AccountAwareSpendabilityRequest, cp::AccountAwareSpendabilityResult>(
        input,
        |request| Ok(cp::evaluate_account_aware_spendability(request)),
    )
}

/// Evaluate an immutable canonical decision card as JSON.
///
/// The request and response use the core protocol's DecisionCard contract;
/// evaluation remains pure and does not authorize or perform mutations.
#[napi]
pub fn evaluate_decision_card(input: String) -> napi::Result<String> {
    run::<cp::DecisionCardRequest, cp::DecisionCard>(input, |request| {
        Ok(cp::evaluate_decision_card(request))
    })
}

/// Verify independent imported and reconciled transfer evidence against its immutable plan.
#[napi]
pub fn verify_transfer_settlement(input: String) -> napi::Result<String> {
    run::<cp::TransferSettlementRequest, cp::TransferSettlementResult>(input, |request| {
        Ok(cp::verify_transfer_settlement(request))
    })
}

/// Revalidate a transfer's exact financial preconditions before user initiation.
#[napi]
pub fn verify_transfer_preconditions(input: String) -> napi::Result<String> {
    run::<cp::VerifyTransferPreconditionsRequest, cp::TransferPreconditionResult>(
        input,
        |request| Ok(cp::verify_transfer_preconditions(request)),
    )
}

// ===========================================================================
// 11. project_cash_flow
// ===========================================================================

/// Project future cash flow for a given number of months.
/// Input: CashFlowProjectionRequest. Returns CashFlowProjectionResponse JSON.
#[napi]
pub fn project_cash_flow(input: String) -> napi::Result<String> {
    run::<CashFlowProjectionRequest, CashFlowProjectionResponse>(input, |req| {
        Ok(cp::project_cash_flow(req))
    })
}

// ===========================================================================
// 12. evaluate_target_health
// ===========================================================================

/// Evaluate the health of budget category targets.
/// Input: TargetHealthRequest. Returns TargetHealthResult JSON.
#[napi]
pub fn evaluate_target_health(input: String) -> napi::Result<String> {
    run::<TargetHealthRequest, TargetHealthResult>(input, |req| Ok(cp::evaluate_target_health(req)))
}

// ===========================================================================
// 13. evaluate_financial_state
// ===========================================================================

/// Evaluate the overall financial state and return a summary label.
/// Input: FinancialStateRequest. Returns FinancialStateLabel JSON.
#[napi]
pub fn evaluate_financial_state(input: String) -> napi::Result<String> {
    run::<FinancialStateRequest, FinancialStateLabel>(input, |req| {
        Ok(cp::evaluate_financial_state(req))
    })
}

// ===========================================================================
// 14. Phase 8.5 budget intelligence
// ===========================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotMonthInput {
    snapshot: ProtocolSnapshot,
    current_month: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotReferenceInput {
    snapshot: ProtocolSnapshot,
    reference_date: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotInput {
    snapshot: ProtocolSnapshot,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioComparisonInput {
    #[allow(dead_code)]
    snapshot: ProtocolSnapshot,
    baseline: Value,
    comparison: Value,
}

#[napi]
pub fn compute_data_quality(input: String) -> napi::Result<String> {
    run::<SnapshotInput, DataQualityCenter>(input, |req| {
        Ok(cp::compute_data_quality(&req.snapshot))
    })
}

#[napi]
pub fn compute_liquidity_coverage(input: String) -> napi::Result<String> {
    run::<SnapshotMonthInput, LiquidityCoverage>(input, |req| {
        Ok(cp::compute_liquidity_coverage_from_snapshot(
            &req.snapshot,
            &req.current_month,
        ))
    })
}

#[napi]
pub fn compute_bill_calendar(input: String) -> napi::Result<String> {
    run::<SnapshotReferenceInput, BillCalendar>(input, |req| {
        Ok(cp::compute_bill_calendar_from_snapshot(
            &req.snapshot,
            &req.reference_date,
        ))
    })
}

#[napi]
pub fn compute_budget_variance(input: String) -> napi::Result<String> {
    run::<SnapshotReferenceInput, BudgetVarianceReport>(input, |req| {
        Ok(cp::compute_budget_variance_from_snapshot(
            &req.snapshot,
            &req.reference_date,
        ))
    })
}

#[napi]
pub fn detect_irregular_obligations(input: String) -> napi::Result<String> {
    run::<SnapshotInput, IrregularObligationsReport>(input, |req| {
        Ok(cp::compute_irregular_obligations_from_snapshot(
            &req.snapshot,
        ))
    })
}

#[napi]
pub fn assess_income_reliability(input: String) -> napi::Result<String> {
    run::<SnapshotInput, IncomeReliabilityReport>(input, |req| {
        Ok(cp::compute_income_reliability_from_snapshot(&req.snapshot))
    })
}

#[napi]
pub fn evaluate_forecast_calibration(input: String) -> napi::Result<String> {
    run::<SnapshotInput, ForecastCalibration>(input, |req| {
        Ok(cp::compute_forecast_calibration_from_snapshot(
            &req.snapshot,
        ))
    })
}

#[napi]
pub fn compare_scenarios(input: String) -> napi::Result<String> {
    run::<ScenarioComparisonInput, cp::ScenarioComparisonResult>(input, |req| {
        Ok(cp::compare_scenarios_from_json(
            &req.baseline,
            &req.comparison,
        ))
    })
}

#[napi]
pub fn evaluate_multidimensional_health(input: String) -> napi::Result<String> {
    run::<SnapshotMonthInput, MultidimensionalHealth>(input, |req| {
        Ok(cp::compute_multidimensional_health_from_snapshot(
            &req.snapshot,
            &req.current_month,
        ))
    })
}

#[cfg(test)]
mod phase_85_tests;
