//! Canonical snapshot/context boundary for the pure Rust liquidity domain.
use crate::{DecisionContext, FinancialSnapshot};
use balanceframe_financial_core::liquidity::*;
use serde::{Deserialize, Serialize};

/// Trusted immutable canonical request; HTTP handlers assemble facts, policies and claims.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountAwareSpendabilityRequest {
    /// Immutable normalized canonical snapshot, optionally containing liquidity facts.
    pub financial_snapshot: FinancialSnapshot,
    /// Fixed evaluation instant, horizon and snapshot/policy identity.
    pub context: DecisionContext,
    /// Effective authorized account and transfer-timing policy.
    pub liquidity_policy: LiquidityPolicy,
    /// Persisted independent claim-set revision and atomic claim bundles.
    pub claim_set: LiquidityClaimSet,
    /// Optional immutable prior constrained backing allocation.
    pub prior_allocation: Option<BackingAllocation>,
    /// Joint none, purchase-item, or cash-neutral category-reallocation scenario.
    pub scenario: LiquidityScenario,
    /// Trusted maximum expiry, further bounded by relevant evidence and policy.
    pub valid_until: String,
}

/// Additional governed liquidity context for the existing canonical purchase API.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurchaseLiquidityContext {
    /// Effective policy separate from institution observations.
    pub liquidity_policy: LiquidityPolicy,
    /// Trusted persisted prospective liquidity claim bundles.
    pub claim_set: LiquidityClaimSet,
    /// Immutable prior allocation, if available.
    pub prior_allocation: Option<BackingAllocation>,
    /// Explicit/session/approved/historical account selection with provenance.
    pub route_selection: RouteSelection,
    /// Fixed intended purchase instant inside the decision horizon.
    pub purchase_at: String,
    /// Latest required payment instant inside the decision horizon.
    pub required_by: String,
}

/// Native pre-initiation revalidation against a newly captured canonical snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifyTransferPreconditionsRequest {
    /// Original immutable plan, including its native SHA256 payload hash.
    pub plan: TransferPlan,
    /// Fresh trusted normalized current facts, claims, policy and fixed evaluation time.
    pub current_input: AccountAwareSpendabilityRequest,
    /// Own exact uninitiated reservation bundle to exclude from competing claims.
    pub own_claim_id: Option<String>,
}

pub(crate) fn source_coverage_complete(snapshot: &FinancialSnapshot) -> bool {
    use crate::{CoverageState, ObservationKind, ObservationState};
    let mut receipts = snapshot.observations.iter().filter(|observation| {
        observation.kind == ObservationKind::AccountCollectionCoverage
            && observation.scope == balanceframe_financial_core::DecisionScope::Global
    });
    let collection_complete = receipts
        .next()
        .is_some_and(|observation| observation.state == ObservationState::Complete)
        && receipts.next().is_none();
    let accounts = if snapshot.coverage.accounts == CoverageState::Partial && collection_complete {
        CoverageState::Complete
    } else {
        snapshot.coverage.accounts
    };
    [
        (
            accounts,
            snapshot.legacy_snapshot.accounts.is_empty()
                && snapshot
                    .liquidity
                    .as_ref()
                    .is_none_or(|facts| facts.accounts.is_empty()),
        ),
        (
            snapshot.coverage.categories,
            snapshot.legacy_snapshot.categories.is_empty()
                && snapshot
                    .liquidity
                    .as_ref()
                    .is_none_or(|facts| facts.categories.is_empty()),
        ),
        (
            snapshot.coverage.budgets,
            snapshot.legacy_snapshot.budgets.is_empty(),
        ),
    ]
    .into_iter()
    .all(|(coverage, empty)| {
        coverage == CoverageState::Complete || coverage == CoverageState::Empty && empty
    })
}

fn domain(request: AccountAwareSpendabilityRequest) -> (LiquidityInput, Option<String>) {
    let mismatch = if request.financial_snapshot.snapshot_id != request.context.snapshot_id
        || request.financial_snapshot.content_hash != request.context.content_hash
    {
        Some("snapshot_identity_mismatch".into())
    } else if request.liquidity_policy.version != request.context.policy_version
        || request.liquidity_policy.policy_hash != request.context.policy_hash
    {
        Some("policy_identity_mismatch".into())
    } else {
        None
    };
    (
        LiquidityInput {
            source_coverage_complete: source_coverage_complete(&request.financial_snapshot),
            max_budget_snapshot_age_minutes: request
                .context
                .policy
                .max_budget_snapshot_age_minutes
                .unwrap_or(15),
            snapshot_id: request.financial_snapshot.snapshot_id,
            content_hash: request.financial_snapshot.content_hash,
            evaluated_at: request.context.evaluated_at,
            horizon: LiquidityHorizon {
                starts_at: request.context.horizon.starts_at,
                ends_at: request.context.horizon.ends_at,
            },
            facts: request.financial_snapshot.liquidity,
            liquidity_policy: request.liquidity_policy,
            claim_set: request.claim_set,
            prior_allocation: request.prior_allocation,
            scenario: request.scenario,
            valid_until: request.valid_until,
        },
        mismatch,
    )
}

/// Evaluates funding and payment readiness without a clock, ledger mutation, or model.
pub fn evaluate_account_aware_spendability(
    request: AccountAwareSpendabilityRequest,
) -> AccountAwareSpendabilityResult {
    let default_snapshot_age = request
        .context
        .policy
        .max_budget_snapshot_age_minutes
        .is_none();
    let (mut input, mismatch) = domain(request);
    if mismatch.is_some() {
        input.facts = None;
    }
    let mut result =
        balanceframe_financial_core::liquidity::evaluate_account_aware_spendability(input);
    if let Some(reason) = mismatch {
        result.reasons = vec![reason];
    }
    if default_snapshot_age {
        result
            .assumptions
            .push("default_15_minute_snapshot_age_policy".into());
    }
    result
}

/// Revalidates original plan financial preconditions, not newly generated snapshot identity.
pub fn verify_transfer_preconditions(
    request: VerifyTransferPreconditionsRequest,
) -> TransferPreconditionResult {
    let (input, mismatch) = domain(request.current_input);
    if let Some(reason) = mismatch {
        return TransferPreconditionResult {
            valid: false,
            reasons: vec![reason],
        };
    }
    balanceframe_financial_core::liquidity::verify_transfer_preconditions(
        TransferPreconditionRequest {
            plan: request.plan,
            current_input: input,
            own_claim_id: request.own_claim_id,
        },
    )
}
