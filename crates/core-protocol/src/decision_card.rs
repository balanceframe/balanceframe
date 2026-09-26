//! Deterministic, immutable pre-commitment purchase decision cards.
//!
//! This module is deliberately a projection around the account-aware liquidity
//! evaluator.  It owns the category-policy and card semantics, while account
//! balances, transfer timing, backing, and joint purchase arithmetic remain in
//! the Phase 8.7 engine.

use crate::{
    evaluate_account_aware_spendability, AccountAwareSpendabilityRequest, DecisionContext,
    FinancialSnapshot,
};
use crate::{CoverageState, ObservationKind, ObservationState};
use balanceframe_financial_core::liquidity::{
    AccountAwareSpendabilityResult, BackingAllocation, BudgetFundingStatus, CategoryLiquidityFact,
    CategoryPeriodKind, ClaimEffectKind, FactEvidence, FactSource, FactState,
    LiquidityCategoryKind, LiquidityClaimBundle, LiquidityClaimSet, LiquidityClaimState,
    LiquidityFacts, LiquidityPolicy, LiquidityPurchaseItem, LiquidityScenario,
    PaymentLiquidityStatus, PurchaseLiquidityResult, RouteSelection, ScheduleAmountCertainty,
};
use balanceframe_financial_core::{EvidenceReference, Money};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// A proposed item evaluated as part of a decision card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionCardItem {
    /// Stable client-provided item identity.
    pub id: String,
    /// Stable category receiving the proposed spending.
    pub category_id: String,
    /// Unit amount when `quantity` is present, or the total amount otherwise.
    pub amount: Money,
    /// Intended purchase instant inside the supplied decision horizon.
    pub purchase_at: String,
    /// Latest acceptable payment or transfer-arrival instant.
    pub required_by: String,
    /// Explicit/session/approved/historical payment-account selection.
    pub route_selection: RouteSelection,
    /// User-supplied cart priority used for the card projection.
    pub priority: String,
    /// Optional positive quantity.  The amount sent to the Rust liquidity
    /// engine is checked `amount * quantity`.
    #[serde(default)]
    pub quantity: Option<u32>,
}

/// Policy controlling whether a category can fund a proposed purchase or act
/// as an exact reallocation donor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionCardCategoryPolicy {
    /// Stable category identity to which this policy applies.
    pub category_id: String,
    /// Policy kind such as `ordinary`, `protected`, `goal`, `joy`, or
    /// `discretionary`.
    pub kind: String,
    /// Whether safe surplus from this category may be redirected.
    pub donor_eligible: bool,
    /// Minimum amount that must remain after a hypothetical purchase.
    pub minimum_retained: Money,
    /// Evidence-backed future need that must remain after a hypothetical
    /// purchase or donor move.
    pub projected_remaining_need: Money,
}

/// Immutable input to the decision-card evaluator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionCardRequest {
    /// Canonical normalized financial snapshot.
    pub financial_snapshot: FinancialSnapshot,
    /// Fixed evaluation time, horizon, and snapshot/policy identities.
    pub context: DecisionContext,
    /// Governed account and transfer policy.
    pub liquidity_policy: LiquidityPolicy,
    /// Persisted claim set and its independent revision.
    pub claim_set: LiquidityClaimSet,
    /// Optional constrained backing allocation from the same identities.
    pub prior_allocation: Option<BackingAllocation>,
    /// One or more proposed purchases evaluated jointly.
    pub items: Vec<DecisionCardItem>,
    /// Category-level protected/goal/donor policy.
    pub category_policies: Vec<DecisionCardCategoryPolicy>,
    /// Trusted maximum lifetime of this card.
    pub valid_until: String,
    /// Stable request identity.
    pub request_id: String,
    /// Correlation identity for the caller's workflow.
    pub correlation_id: String,
    /// Stable immutable decision identity.
    pub decision_id: String,
}

/// Category state projected before or after the proposed cart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionCardCategoryState {
    /// Stable category identity.
    pub category_id: String,
    /// Authoritative category availability, before claims and policy effects.
    pub availability: Money,
    /// Active persisted category commitments.
    pub commitments: Money,
    /// Active persisted category reservations.
    pub reservations: Money,
    /// Availability left after commitments and reservations.
    pub uncommitted_availability: Money,
    /// Checked donor surplus after the policy floor and projected need.
    pub safe_to_redirect: Money,
    /// Applied category policy kind, when one was supplied.
    pub policy_kind: Option<String>,
}

/// Before/after financial state exposed by a decision card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionCardState {
    /// Category-level availability and policy effects.
    pub categories: Vec<DecisionCardCategoryState>,
    /// Account-aware engine account capacities.
    pub accounts: Vec<Value>,
    /// Account/category backing allocation from the shared engine.
    pub backing: Value,
    /// Goal/protected-category before/after policy effects and target states.
    pub goals: Vec<Value>,
    /// Recurring-obligation and persisted-claim effects, including their
    /// account/category scope when known.
    pub obligations: Vec<Value>,
    pub runway: Option<Value>,
}

/// Per-item deterministic outcome in a decision card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionCardItemOutcome {
    /// Stable proposed-item identity.
    pub id: String,
    /// Stable proposed-item category.
    pub category_id: String,
    /// Checked total item amount after quantity expansion.
    pub amount: Money,
    /// User-supplied cart priority.
    pub priority: String,
    /// Outcome for this item in the joint cart.
    pub outcome: String,
    /// Category funding status from the shared engine.
    pub budget_funding_status: String,
    /// Payment-account status from the shared engine.
    pub payment_liquidity_status: String,
    /// Selected account, when the route selection resolved one.
    pub selected_account_id: Option<String>,
    /// Route-selection precedence used by the shared engine.
    pub selection_source: String,
    /// Exact item-specific reasons.
    pub reasons: Vec<String>,
    /// Account state before this item's hypothetical effect.
    pub before: Option<Value>,
    /// Account state after this item's hypothetical effect.
    pub after: Option<Value>,
}

/// The immutable decision-card projection returned to callers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionCard {
    /// Decision-card contract version.
    pub version: String,
    /// Stable decision identity copied from the request.
    pub decision_id: String,
    /// Stable request identity copied from the request.
    pub request_id: String,
    /// Correlation identity copied from the request.
    pub correlation_id: String,
    /// Canonical snapshot identity.
    pub snapshot_id: String,
    /// Canonical snapshot content hash.
    pub content_hash: String,
    /// Governed liquidity-policy version.
    pub policy_version: String,
    /// Governed liquidity-policy content hash.
    pub policy_hash: String,
    /// Independent persisted claim-set revision.
    pub claim_set_revision: String,
    /// Domain-separated SHA-256 hash of the canonical request/cart plan.
    pub plan_hash: String,
    /// One of the seven deterministic decision outcomes.
    pub outcome: String,
    /// Aggregate category funding status.
    pub budget_funding_status: String,
    /// Aggregate account-payment status.
    pub payment_liquidity_status: String,
    /// Selected payment account for the first proposed item, when present.
    pub selected_account_id: Option<String>,
    /// Selection source for the first proposed item.
    pub selection_source: Option<String>,
    /// Joint before state.
    pub before: Option<DecisionCardState>,
    /// Joint after state; omitted as a value (`null`) when checked arithmetic
    /// or material evidence prevents a trustworthy projection.
    pub after: Option<DecisionCardState>,
    /// Exact account-transfer and category-reallocation paths.
    pub funding_paths: Vec<Value>,
    /// Explicit opportunity-cost projections, when supplied by policy facts.
    pub opportunity_costs: Vec<Value>,
    /// Competing-item or donor conflicts.
    pub conflicts: Vec<Value>,
    /// Required approvals for a later mutation; card evaluation itself never
    /// authorizes or performs a mutation.
    pub authorization_requirements: Vec<String>,
    /// Typed evidence references retained from the canonical snapshot.
    pub evidence: Vec<EvidenceReference>,
    /// Material blockers that forced `insufficient_data`.
    pub blockers: Vec<String>,
    /// Deterministic reason codes and affirmative explanations.
    pub reasons: Vec<String>,
    /// Explicit assumptions disclosed by the account-aware evaluator.
    pub assumptions: Vec<String>,
    /// Earliest known evidence/claim/policy expiry.
    pub earliest_expiry: String,
    /// Exclusive card expiry.
    pub expires_at: String,
    /// Readiness projection shared by UI/API consumers.
    pub readiness: Value,
    /// Per-item outcomes in request order.
    pub items: Vec<DecisionCardItemOutcome>,
}

#[derive(Debug, Clone)]
struct CategoryTotals {
    availability: i64,
    reservations: i64,
    commitments: i64,
}

#[derive(Debug, Clone)]
struct CandidatePath {
    source_category_id: String,
    source_as_of_month: String,
    destination_category_id: String,
    destination_as_of_month: String,
    amount: i64,
    currency: String,
}

#[derive(Debug, Clone)]
struct ObligationMeta {
    amount: i64,
    currency: String,
    category_id: Option<String>,
    account_id: Option<String>,
}

fn budget_status(status: BudgetFundingStatus) -> &'static str {
    match status {
        BudgetFundingStatus::Funded => "funded",
        BudgetFundingStatus::Unfunded => "unfunded",
        BudgetFundingStatus::InsufficientData => "insufficient_data",
    }
}

fn payment_status(status: PaymentLiquidityStatus) -> &'static str {
    match status {
        PaymentLiquidityStatus::Ready => "ready",
        PaymentLiquidityStatus::UseOtherAccount => "use_other_account",
        PaymentLiquidityStatus::TransferRequired => "transfer_required",
        PaymentLiquidityStatus::TransferTooLate => "transfer_too_late",
        PaymentLiquidityStatus::NotLiquid => "not_liquid",
        PaymentLiquidityStatus::InsufficientData => "insufficient_data",
    }
}

fn checked_add(a: i64, b: i64) -> Result<i64, &'static str> {
    a.checked_add(b).ok_or("money_arithmetic_overflow")
}

fn checked_sub(a: i64, b: i64) -> Result<i64, &'static str> {
    a.checked_sub(b).ok_or("money_arithmetic_overflow")
}

fn money(units: i64, currency: &str) -> Money {
    Money::new(units, currency.to_owned())
}

fn expanded_amount(item: &DecisionCardItem) -> Result<Money, &'static str> {
    let quantity = item.quantity.unwrap_or(1);
    if quantity == 0 {
        return Err("nonpositive_purchase");
    }
    item.amount
        .mul_by_usize(quantity as usize)
        .map_err(|error| match error {
            balanceframe_financial_core::MoneyError::Overflow => "money_arithmetic_overflow",
            balanceframe_financial_core::MoneyError::CurrencyMismatch(_, _) => "currency_mismatch",
            balanceframe_financial_core::MoneyError::NegativeAmount => "negative_amount",
            balanceframe_financial_core::MoneyError::DivisionByZero => "money_arithmetic_overflow",
        })
}

fn engine_items(request: &DecisionCardRequest) -> Result<Vec<LiquidityPurchaseItem>, &'static str> {
    request
        .items
        .iter()
        .map(|item| {
            Ok(LiquidityPurchaseItem {
                id: item.id.clone(),
                category_id: item.category_id.clone(),
                amount: expanded_amount(item)?,
                purchase_at: item.purchase_at.clone(),
                required_by: item.required_by.clone(),
                route_selection: item.route_selection.clone(),
            })
        })
        .collect()
}

fn engine_request(
    request: &DecisionCardRequest,
    items: Vec<LiquidityPurchaseItem>,
    facts: Option<LiquidityFacts>,
) -> AccountAwareSpendabilityRequest {
    let mut snapshot = request.financial_snapshot.clone();
    snapshot.liquidity = facts;
    AccountAwareSpendabilityRequest {
        financial_snapshot: snapshot,
        context: request.context.clone(),
        liquidity_policy: request.liquidity_policy.clone(),
        claim_set: request.claim_set.clone(),
        prior_allocation: request.prior_allocation.clone(),
        scenario: LiquidityScenario::Purchases { items },
        valid_until: request.valid_until.clone(),
    }
}

fn active_claim(bundle: &LiquidityClaimBundle, evaluated_at: &str) -> bool {
    match bundle.state {
        LiquidityClaimState::Settled
        | LiquidityClaimState::Cancelled
        | LiquidityClaimState::Expired => false,
        LiquidityClaimState::Initiated => true,
        LiquidityClaimState::Active => {
            bundle.initiated || bundle.expires_at.as_str() > evaluated_at
        }
    }
}

fn add_totals(
    map: &mut BTreeMap<String, CategoryTotals>,
    category_id: &str,
    amount: i64,
    kind: &str,
    currency: &str,
) -> Result<(), &'static str> {
    let entry = map.entry(category_id.to_owned()).or_insert(CategoryTotals {
        availability: 0,
        reservations: 0,
        commitments: 0,
    });
    match kind {
        "availability" => entry.availability = checked_add(entry.availability, amount)?,
        "reservations" => entry.reservations = checked_add(entry.reservations, amount)?,
        "commitments" => entry.commitments = checked_add(entry.commitments, amount)?,
        _ => return Err("invalid_category_total"),
    }
    let _ = currency;
    Ok(())
}

fn obligation_in_horizon(due_at: &str, horizon_end: &str) -> bool {
    if due_at.len() == 10 {
        horizon_end
            .get(..10)
            .is_some_and(|end_date| due_at <= end_date)
    } else {
        due_at < horizon_end
    }
}

fn category_totals(
    request: &DecisionCardRequest,
) -> Result<BTreeMap<String, CategoryTotals>, &'static str> {
    let facts = request
        .financial_snapshot
        .liquidity
        .as_ref()
        .ok_or("liquidity_unavailable")?;
    let mut totals = BTreeMap::new();
    let mut category_currencies = BTreeMap::<String, String>::new();
    for category in &facts.categories {
        if category.availability.is_negative() {
            return Err("negative_category_availability");
        }
        if let Some(previous) = category_currencies.insert(
            category.category_id.clone(),
            category.availability.currency().to_owned(),
        ) {
            if previous.as_str() != category.availability.currency() {}
        }
        add_totals(
            &mut totals,
            &category.category_id,
            category.availability.minor_units(),
            "availability",
            category.availability.currency(),
        )?;
    }

    // A schedule, account obligation, and claim can describe one economic
    // obligation.  Keep one commitment classification when an account
    // obligation is present; only an otherwise-unmatched category claim is a
    // reservation.  Conflicting identities fail closed rather than summing
    // the same money twice.
    let mut obligations = BTreeMap::<String, ObligationMeta>::new();
    let mut commitment_categories = BTreeSet::new();
    for account in &facts.accounts {
        for obligation in &account.obligations {
            if obligation.paid
                || obligation.included_in_balance
                || !obligation_in_horizon(&obligation.due_at, &request.context.horizon.ends_at)
            {
                continue;
            }
            if obligation.economic_obligation_id.is_empty() {
                return Err("missing_economic_obligation_id");
            }
            let amount = obligation.amount.minor_units();
            if amount < 0 {
                return Err("negative_obligation");
            }
            let category_id = obligation.category_id.clone();
            let candidate = ObligationMeta {
                amount,
                currency: obligation.amount.currency().to_owned(),
                category_id: category_id.clone(),
                account_id: Some(account.account_id.clone()),
            };
            if let Some(previous) = obligations.get(&obligation.economic_obligation_id) {
                if previous.amount != candidate.amount
                    || previous.currency != candidate.currency
                    || (previous.category_id.is_some()
                        && candidate.category_id.is_some()
                        && previous.category_id != candidate.category_id)
                    || (previous.account_id.is_some()
                        && candidate.account_id.is_some()
                        && previous.account_id != candidate.account_id)
                {
                    return Err("ambiguous_obligation_match");
                }
            } else {
                obligations.insert(obligation.economic_obligation_id.clone(), candidate);
            }
            let Some(category_id) = category_id else {
                continue;
            };
            let Some(category) = facts
                .categories
                .iter()
                .find(|category| category.category_id == category_id)
            else {
                return Err("category_missing");
            };
            if category.availability.currency() != obligation.amount.currency() {
                return Err("currency_mismatch");
            }
            if commitment_categories.insert((
                obligation.economic_obligation_id.clone(),
                category_id.clone(),
            )) {
                add_totals(
                    &mut totals,
                    &category_id,
                    amount,
                    "commitments",
                    obligation.amount.currency(),
                )?;
            }
        }
    }

    let mut category_claims = BTreeMap::<String, (String, i64, String)>::new();
    for bundle in &request.claim_set.bundles {
        if !active_claim(bundle, &request.context.evaluated_at) {
            continue;
        }
        for effect in &bundle.effects {
            if effect.kind != ClaimEffectKind::Category || effect.included_in_balance {
                continue;
            }
            if effect
                .category_id
                .as_deref()
                .is_some_and(|category_id| category_id != effect.resource_id)
            {
                return Err("ambiguous_claim_match");
            }
            if effect.economic_obligation_id.is_empty() {
                return Err("missing_economic_obligation_id");
            }
            let category_id = effect
                .category_id
                .as_deref()
                .unwrap_or(effect.resource_id.as_str())
                .to_owned();
            let Some(category) = facts
                .categories
                .iter()
                .find(|category| category.category_id == category_id)
            else {
                return Err("category_missing");
            };
            if category.availability.currency() != effect.amount.currency() {
                return Err("currency_mismatch");
            }
            let amount = effect.amount.minor_units();
            if amount < 0 {
                return Err("negative_claim");
            }
            let identity = effect.economic_obligation_id.clone();
            let first_claim = if let Some((old_category, old_amount, old_currency)) =
                category_claims.get(&identity)
            {
                if old_category != &category_id
                    || *old_amount != amount
                    || old_currency != effect.amount.currency()
                {
                    return Err("ambiguous_claim_match");
                }
                false
            } else {
                category_claims.insert(
                    identity.clone(),
                    (
                        category_id.clone(),
                        amount,
                        effect.amount.currency().to_owned(),
                    ),
                );
                true
            };
            if !first_claim {
                continue;
            }
            // An account obligation with the same economic identity is the
            // commitment classification.  Do not turn its claim mirror into
            // a second reservation.
            if obligations
                .get(&identity)
                .is_some_and(|obligation| obligation.category_id.is_some())
            {
                continue;
            }
            add_totals(
                &mut totals,
                &category_id,
                amount,
                "reservations",
                effect.amount.currency(),
            )?;
        }
    }
    Ok(totals)
}

fn policy_map(
    request: &DecisionCardRequest,
) -> Result<BTreeMap<String, &DecisionCardCategoryPolicy>, &'static str> {
    let mut policies = BTreeMap::new();
    for policy in &request.category_policies {
        if policy.category_id.is_empty()
            || policy.minimum_retained.is_negative()
            || policy.projected_remaining_need.is_negative()
            || policies
                .insert(policy.category_id.clone(), policy)
                .is_some()
        {
            return Err("duplicate_or_invalid_category_policy");
        }
    }
    Ok(policies)
}

fn purchases_by_category(
    request: &DecisionCardRequest,
    items: &[LiquidityPurchaseItem],
) -> Result<BTreeMap<String, i64>, &'static str> {
    let mut totals = BTreeMap::new();
    for item in items {
        let entry = totals.entry(item.category_id.clone()).or_insert(0);
        *entry = checked_add(*entry, item.amount.minor_units())?;
    }
    let _ = request;
    Ok(totals)
}

fn policy_floor(policy: &DecisionCardCategoryPolicy) -> Result<i64, &'static str> {
    checked_add(
        policy.minimum_retained.minor_units(),
        policy.projected_remaining_need.minor_units(),
    )
}

fn policy_surplus(
    total: &CategoryTotals,
    policy: Option<&DecisionCardCategoryPolicy>,
) -> Result<i64, &'static str> {
    let Some(policy) = policy else {
        return Ok(0);
    };
    if !policy.donor_eligible {
        return Ok(0);
    }
    let uncommitted = checked_sub(total.availability, total.reservations)?;
    let uncommitted = checked_sub(uncommitted, total.commitments)?.max(0);
    Ok(checked_sub(uncommitted, policy_floor(policy)?)?.max(0))
}

fn state_categories(
    request: &DecisionCardRequest,
    totals: &BTreeMap<String, CategoryTotals>,
    purchases: &BTreeMap<String, i64>,
    reallocations: &BTreeMap<String, i64>,
    after: bool,
) -> Result<Vec<DecisionCardCategoryState>, &'static str> {
    let policies = policy_map(request)?;
    let Some(facts) = request.financial_snapshot.liquidity.as_ref() else {
        return Ok(vec![]);
    };
    let mut categories: Vec<_> = facts.categories.iter().collect();
    categories.sort_by(|left, right| {
        left.category_id
            .cmp(&right.category_id)
            .then_with(|| left.as_of_month.cmp(&right.as_of_month))
    });
    categories
        .into_iter()
        .map(|category| {
            let total = totals
                .get(&category.category_id)
                .ok_or("category_total_missing")?;
            let purchase = if after {
                purchases.get(&category.category_id).copied().unwrap_or(0)
            } else {
                0
            };
            let redirected = if after {
                reallocations
                    .get(&category.category_id)
                    .copied()
                    .unwrap_or(0)
            } else {
                0
            };
            let availability = checked_add(checked_sub(total.availability, purchase)?, redirected)?;
            let uncommitted = checked_sub(
                checked_sub(availability, total.reservations)?,
                total.commitments,
            )?
            .max(0);
            let policy = policies.get(&category.category_id).copied();
            // Future-period assignments remain visible, but cannot be
            // presented as current-month donor surplus.
            let safe = if category.period_kind == CategoryPeriodKind::Future {
                0
            } else {
                policy_surplus(
                    &CategoryTotals {
                        availability,
                        reservations: total.reservations,
                        commitments: total.commitments,
                    },
                    policy,
                )?
            };
            Ok(DecisionCardCategoryState {
                category_id: category.category_id.clone(),
                availability: money(availability, category.availability.currency()),
                commitments: money(total.commitments, category.availability.currency()),
                reservations: money(total.reservations, category.availability.currency()),
                uncommitted_availability: money(uncommitted, category.availability.currency()),
                safe_to_redirect: money(safe, category.availability.currency()),
                policy_kind: policy.map(|value| value.kind.clone()),
            })
        })
        .collect()
}

fn current_category_fact<'a>(
    request: &'a DecisionCardRequest,
    category_id: &str,
) -> Option<&'a CategoryLiquidityFact> {
    let facts = request.financial_snapshot.liquidity.as_ref()?;
    facts.categories.iter().find(|category| {
        category.category_id == category_id
            && category.period_kind == CategoryPeriodKind::Current
            && category.as_of_month == facts.as_of_month
    })
}

fn donor_paths(
    request: &DecisionCardRequest,
    engine_items: &[LiquidityPurchaseItem],
    totals: &BTreeMap<String, CategoryTotals>,
    purchases: &BTreeMap<String, i64>,
) -> Result<Vec<CandidatePath>, &'static str> {
    let policies = policy_map(request)?;
    let mut needs = BTreeMap::new();
    for (category_id, amount) in purchases {
        let Some(destination_fact) = current_category_fact(request, category_id) else {
            // A future-period assignment is not current cash and cannot be
            // rescued by a current-month category move.
            continue;
        };
        let total = totals.get(category_id).ok_or("category_total_missing")?;
        let uncommitted = checked_sub(
            checked_sub(total.availability, total.reservations)?,
            total.commitments,
        )?
        .max(0);
        let need = checked_sub(*amount, uncommitted)?.max(0);
        if need > 0 && destination_fact.kind == LiquidityCategoryKind::Ordinary {
            needs.insert(category_id.clone(), need);
        }
    }
    if needs.is_empty() {
        return Ok(vec![]);
    }
    let mut donors = BTreeMap::new();
    for (category_id, total) in totals {
        let Some(source_fact) = current_category_fact(request, category_id) else {
            continue;
        };
        if source_fact.kind != LiquidityCategoryKind::Ordinary {
            continue;
        }
        let surplus = policy_surplus(total, policies.get(category_id).copied())?;
        let own_purchase = purchases.get(category_id).copied().unwrap_or(0);
        donors.insert(
            category_id.clone(),
            checked_sub(surplus, own_purchase)?.max(0),
        );
    }
    let mut paths = Vec::new();
    for (destination, mut need) in needs {
        for (source, available) in donors.iter_mut() {
            if source == &destination || need == 0 || *available <= 0 {
                continue;
            }
            let Some(source_fact) = current_category_fact(request, source) else {
                continue;
            };
            let Some(destination_fact) = current_category_fact(request, &destination) else {
                return Err("category_missing");
            };
            if source_fact.availability.currency() != destination_fact.availability.currency() {
                continue;
            }
            let amount = need.min(*available);
            *available = checked_sub(*available, amount)?;
            need = checked_sub(need, amount)?;
            paths.push(CandidatePath {
                source_category_id: source.clone(),
                source_as_of_month: source_fact.as_of_month.clone(),
                destination_category_id: destination.clone(),
                destination_as_of_month: destination_fact.as_of_month.clone(),
                amount,
                currency: destination_fact.availability.currency().to_owned(),
            });
        }
        if need > 0 {
            return Ok(vec![]);
        }
    }
    // Validate the exact category moves against the shared account-aware
    // engine.  The engine receives a hypothetical fact set; it still owns
    // all account/cash, currency, claim, and backing arithmetic.
    let Some(mut facts) = request.financial_snapshot.liquidity.clone() else {
        return Ok(vec![]);
    };
    for path in &paths {
        let source_index = facts
            .categories
            .iter()
            .position(|category| {
                category.category_id == path.source_category_id
                    && category.as_of_month == path.source_as_of_month
            })
            .ok_or("category_missing")?;
        let destination_index = facts
            .categories
            .iter()
            .position(|category| {
                category.category_id == path.destination_category_id
                    && category.as_of_month == path.destination_as_of_month
            })
            .ok_or("category_missing")?;
        let source_currency = facts.categories[source_index]
            .availability
            .currency()
            .to_owned();
        let destination_currency = facts.categories[destination_index]
            .availability
            .currency()
            .to_owned();
        let source_value = facts.categories[source_index]
            .availability
            .sub(&money(path.amount, &source_currency))
            .map_err(|_| "money_arithmetic_overflow")?;
        let destination_value = facts.categories[destination_index]
            .availability
            .add(&money(path.amount, &destination_currency))
            .map_err(|_| "money_arithmetic_overflow")?;
        facts.categories[source_index].availability = source_value;
        facts.categories[destination_index].availability = destination_value;
    }
    let candidate = evaluate_account_aware_spendability(engine_request(
        request,
        engine_items.to_vec(),
        Some(facts),
    ));
    if candidate.budget_funding_status != BudgetFundingStatus::Funded
        || candidate.payment_liquidity_status == PaymentLiquidityStatus::InsufficientData
        || candidate.payment_liquidity_status == PaymentLiquidityStatus::NotLiquid
        || candidate.payment_liquidity_status == PaymentLiquidityStatus::TransferTooLate
    {
        return Ok(vec![]);
    }
    Ok(paths)
}

fn canonical(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let ordered: BTreeMap<_, _> = object
                .into_iter()
                .map(|(key, value)| (key, canonical(value)))
                .collect();
            Value::Object(ordered.into_iter().collect())
        }
        Value::Array(values) => Value::Array(values.into_iter().map(canonical).collect()),
        value => value,
    }
}

fn plan_hash(request: &DecisionCardRequest) -> Result<String, &'static str> {
    let mut value =
        serde_json::to_value(request).map_err(|_| "decision_card_serialization_error")?;
    if let Value::Object(object) = &mut value {
        object.remove("requestId");
        object.remove("correlationId");
        object.remove("decisionId");
        if let Some(Value::Array(policies)) = object.get_mut("categoryPolicies") {
            // Category policies are a set keyed by category identity.  Their
            // source order must not change the immutable plan identity.
            policies.sort_by(|left, right| {
                let left_id = left
                    .get("categoryId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let right_id = right
                    .get("categoryId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                left_id.cmp(right_id).then_with(|| {
                    let left_json =
                        serde_json::to_string(&canonical(left.clone())).unwrap_or_default();
                    let right_json =
                        serde_json::to_string(&canonical(right.clone())).unwrap_or_default();
                    left_json.cmp(&right_json)
                })
            });
        }
    } else {
        return Err("decision_card_serialization_error");
    }
    let canonical = serde_json::to_string(&canonical(value))
        .map_err(|_| "decision_card_serialization_error")?;
    let mut hash = Sha256::new();
    hash.update(b"balanceframe.decision-card.v1\n");
    hash.update(canonical.as_bytes());
    Ok(format!("{:x}", hash.finalize()))
}

fn evidence(request: &DecisionCardRequest) -> Vec<EvidenceReference> {
    let mut references = Vec::new();
    for observation in &request.financial_snapshot.observations {
        for reference in &observation.evidence {
            if !references
                .iter()
                .any(|old: &EvidenceReference| old == reference)
            {
                references.push(reference.clone());
            }
        }
    }
    references
}

fn unique_reasons(reasons: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    reasons
        .into_iter()
        .filter(|reason| !reason.is_empty() && seen.insert(reason.clone()))
        .collect()
}

fn fact_evidence_blocker(
    blockers: &mut Vec<String>,
    scope: &str,
    evidence: &FactEvidence,
    evaluated_at: &str,
) {
    if evidence.state != FactState::Known || evidence.source == FactSource::PolicyAssumption {
        blockers.push(format!("{scope}_evidence_{:?}", evidence.state).to_ascii_lowercase());
    }
    if evidence
        .expires_at
        .as_deref()
        .is_some_and(|expires_at| expires_at <= evaluated_at)
    {
        blockers.push(format!("{scope}_evidence_stale"));
    }
    if evidence
        .observed_at
        .as_deref()
        .is_some_and(|observed_at| observed_at > evaluated_at)
    {
        blockers.push(format!("{scope}_evidence_future"));
    }
}

fn snapshot_scope_reasons(request: &DecisionCardRequest) -> Vec<String> {
    let snapshot = &request.financial_snapshot;
    let coverage = [
        ("accounts", snapshot.coverage.accounts),
        ("transactions", snapshot.coverage.transactions),
        ("categories", snapshot.coverage.categories),
        ("payees", snapshot.coverage.payees),
        ("rules", snapshot.coverage.rules),
        ("schedules", snapshot.coverage.schedules),
        ("budgets", snapshot.coverage.budgets),
        ("tags", snapshot.coverage.tags),
    ];
    let mut reasons = coverage
        .into_iter()
        .map(|(name, state)| {
            format!(
                "snapshot_coverage_{name}_{}",
                format!("{state:?}").to_ascii_lowercase()
            )
        })
        .collect::<Vec<_>>();
    reasons.push(format!(
        "pending_activity_{}",
        format!("{:?}", snapshot.inclusion_scope.pending_activity).to_ascii_lowercase()
    ));
    reasons.push(format!(
        "uncleared_activity_{}",
        format!("{:?}", snapshot.inclusion_scope.uncleared_activity).to_ascii_lowercase()
    ));
    reasons
}

fn material_snapshot_blockers(request: &DecisionCardRequest) -> Vec<String> {
    let snapshot = &request.financial_snapshot;
    let mut blockers = Vec::new();
    let coverage = [
        (
            "accounts",
            snapshot.coverage.accounts,
            snapshot.legacy_snapshot.accounts.is_empty()
                && snapshot
                    .liquidity
                    .as_ref()
                    .is_none_or(|facts| facts.accounts.is_empty()),
        ),
        (
            "transactions",
            snapshot.coverage.transactions,
            snapshot.legacy_snapshot.transactions.is_empty(),
        ),
        (
            "categories",
            snapshot.coverage.categories,
            snapshot.legacy_snapshot.categories.is_empty()
                && snapshot
                    .liquidity
                    .as_ref()
                    .is_none_or(|facts| facts.categories.is_empty()),
        ),
        (
            "schedules",
            snapshot.coverage.schedules,
            snapshot.legacy_snapshot.schedules.is_empty()
                && snapshot
                    .liquidity
                    .as_ref()
                    .is_none_or(|facts| facts.schedules.is_empty()),
        ),
        (
            "budgets",
            snapshot.coverage.budgets,
            snapshot.legacy_snapshot.budgets.is_empty(),
        ),
    ];
    for (name, state, explicitly_empty) in coverage {
        if state != CoverageState::Complete && !(state == CoverageState::Empty && explicitly_empty)
        {
            blockers.push(format!("incomplete_{name}_coverage"));
        }
    }
    for observation in &snapshot.observations {
        let ambiguous_material_observation = matches!(
            observation.kind,
            ObservationKind::DuplicateCandidate
                | ObservationKind::TransferAmbiguity
                | ObservationKind::Reconciliation
                | ObservationKind::CurrencyCompatibility
        ) && matches!(
            observation.state,
            ObservationState::Present
                | ObservationState::Unreconciled
                | ObservationState::Ambiguous
                | ObservationState::Incompatible
        );
        if ambiguous_material_observation
            || matches!(
                observation.state,
                ObservationState::Stale
                    | ObservationState::Unavailable
                    | ObservationState::Unknown
                    | ObservationState::Ambiguous
                    | ObservationState::Incompatible
                    | ObservationState::Unreconciled
            )
        {
            blockers
                .push(format!("material_observation_{:?}", observation.kind).to_ascii_lowercase());
        }
    }
    if let Some(facts) = &snapshot.liquidity {
        for category in &facts.categories {
            fact_evidence_blocker(
                &mut blockers,
                &format!("category_{}", category.category_id),
                &category.evidence,
                &request.context.evaluated_at,
            );
        }
        for account in &facts.accounts {
            let prefix = format!("account_{}", account.account_id);
            fact_evidence_blocker(
                &mut blockers,
                &format!("{prefix}_balance"),
                &account.balance_evidence,
                &request.context.evaluated_at,
            );
            fact_evidence_blocker(
                &mut blockers,
                &format!("{prefix}_activity"),
                &account.activity_evidence,
                &request.context.evaluated_at,
            );
            fact_evidence_blocker(
                &mut blockers,
                &format!("{prefix}_schedule"),
                &account.schedule_evidence,
                &request.context.evaluated_at,
            );
            fact_evidence_blocker(
                &mut blockers,
                &format!("{prefix}_freshness"),
                &account.freshness_evidence,
                &request.context.evaluated_at,
            );
            fact_evidence_blocker(
                &mut blockers,
                &format!("{prefix}_currency"),
                &account.currency_evidence,
                &request.context.evaluated_at,
            );
            fact_evidence_blocker(
                &mut blockers,
                &format!("{prefix}_kind"),
                &account.kind_evidence,
                &request.context.evaluated_at,
            );
            fact_evidence_blocker(
                &mut blockers,
                &format!("{prefix}_ownership"),
                &account.ownership_evidence,
                &request.context.evaluated_at,
            );
            fact_evidence_blocker(
                &mut blockers,
                &format!("{prefix}_holds"),
                &account.holds_evidence,
                &request.context.evaluated_at,
            );
            if let Some(credit) = &account.credit {
                fact_evidence_blocker(
                    &mut blockers,
                    &format!("{prefix}_credit"),
                    &credit.evidence,
                    &request.context.evaluated_at,
                );
            }
        }
    }
    if let Some(facts) = &snapshot.liquidity {
        let account_currencies: BTreeSet<&str> = facts
            .accounts
            .iter()
            .map(|account| account.currency.as_str())
            .collect();
        for category in &facts.categories {
            if !account_currencies.contains(category.availability.currency()) {
                blockers.push(format!("currency_mismatch:{}", category.category_id));
            }
        }
        for item in &request.items {
            let Some(category) = facts
                .categories
                .iter()
                .find(|category| category.category_id == item.category_id)
            else {
                blockers.push(format!("category_missing:{}", item.category_id));
                continue;
            };
            if item.amount.currency() != category.availability.currency() {
                blockers.push("currency_mismatch".into());
            }
        }
        for policy in &request.category_policies {
            if let Some(category) = facts
                .categories
                .iter()
                .find(|category| category.category_id == policy.category_id)
            {
                if policy.minimum_retained.currency() != category.availability.currency()
                    || policy.projected_remaining_need.currency()
                        != category.availability.currency()
                {
                    blockers.push("currency_mismatch".into());
                }
            }
        }
    }
    if !matches!(
        snapshot.inclusion_scope.pending_activity,
        crate::PendingActivityTreatment::Included
    ) {
        blockers.push(format!(
            "pending_activity_{}",
            format!("{:?}", snapshot.inclusion_scope.pending_activity).to_ascii_lowercase()
        ));
    }
    if !matches!(
        snapshot.inclusion_scope.uncleared_activity,
        crate::UnclearedActivityTreatment::Included
    ) {
        blockers.push(format!(
            "uncleared_activity_{}",
            format!("{:?}", snapshot.inclusion_scope.uncleared_activity).to_ascii_lowercase()
        ));
    }
    blockers
}

fn engine_item_map(
    result: &AccountAwareSpendabilityResult,
) -> BTreeMap<String, PurchaseLiquidityResult> {
    result
        .purchases
        .iter()
        .cloned()
        .map(|item| (item.item_id.clone(), item))
        .collect()
}

fn item_outcome(
    item: &PurchaseLiquidityResult,
    policy: Option<&DecisionCardCategoryPolicy>,
) -> String {
    if item.budget_funding_status == BudgetFundingStatus::InsufficientData
        || item.payment_liquidity_status == PaymentLiquidityStatus::InsufficientData
    {
        return "insufficient_data".into();
    }
    if matches!(
        item.payment_liquidity_status,
        PaymentLiquidityStatus::NotLiquid
            | PaymentLiquidityStatus::TransferTooLate
            | PaymentLiquidityStatus::UseOtherAccount
    ) {
        return "not_safe".into();
    }
    if item.budget_funding_status == BudgetFundingStatus::Unfunded {
        return "cash_available_but_unfunded".into();
    }
    if item.payment_liquidity_status == PaymentLiquidityStatus::TransferRequired {
        return "safe_after_date".into();
    }
    if let Some(policy) = policy {
        let kind = policy.kind.to_ascii_lowercase();
        if kind == "protected" || kind == "goal" {
            // The aggregate policy check is applied by the caller, where the
            // before/after category amounts are available.
        }
    }
    "funded_now".into()
}

fn transfer_paths(result: &AccountAwareSpendabilityResult) -> Result<Vec<Value>, &'static str> {
    let mut cumulative = BTreeMap::<
        String,
        (
            balanceframe_financial_core::liquidity::TransferPlan,
            Vec<String>,
        ),
    >::new();
    for purchase in &result.purchases {
        let Some(plan) = purchase.transfer_plan.as_ref() else {
            continue;
        };
        let currency = plan.minimum_amount.currency().to_owned();
        let entry = cumulative
            .entry(currency)
            .or_insert_with(|| (plan.clone(), Vec::new()));
        // The account-aware engine carries the cumulative same-currency
        // prefix on later plans.  Keep exactly the most complete prefix,
        // rather than disclosing each prerequisite leg repeatedly.
        if plan.legs.len() >= entry.0.legs.len() {
            entry.0 = plan.clone();
        }
        if !entry.1.iter().any(|id| id == &purchase.item_id) {
            entry.1.push(purchase.item_id.clone());
        }
    }
    cumulative
        .into_values()
        .map(|(plan, item_ids)| {
            let mut value =
                serde_json::to_value(&plan).map_err(|_| "decision_card_serialization_error")?;
            let Value::Object(object) = &mut value else {
                return Err("decision_card_serialization_error");
            };
            let legs = object
                .get_mut("legs")
                .ok_or("decision_card_serialization_error")?;
            let Value::Array(legs) = legs else {
                return Err("decision_card_serialization_error");
            };
            let mut seen = BTreeSet::new();
            legs.retain(|leg| {
                let id = leg.get("id").and_then(Value::as_str).unwrap_or_default();
                id.is_empty() || seen.insert(id.to_owned())
            });
            object.insert("kind".into(), Value::String("account_transfer".into()));
            if let Some(last) = item_ids.last() {
                object.insert("itemId".into(), Value::String(last.clone()));
            }
            object.insert(
                "itemIds".into(),
                Value::Array(item_ids.into_iter().map(Value::String).collect()),
            );
            Ok(value)
        })
        .collect()
}

fn has_evidenced_transfer_path(result: &AccountAwareSpendabilityResult) -> bool {
    result.purchases.iter().any(|purchase| {
        purchase.transfer_plan.as_ref().is_some_and(|plan| {
            !plan.legs.is_empty()
                && plan
                    .legs
                    .iter()
                    .all(|leg| leg.estimated_arrival.as_str() <= leg.required_by.as_str())
        })
    })
}

fn category_reallocation_paths(
    paths: &[CandidatePath],
    totals: &BTreeMap<String, CategoryTotals>,
    purchases: &BTreeMap<String, i64>,
) -> Result<Vec<Value>, &'static str> {
    paths
        .iter()
        .map(|path| {
            let source_before = totals
                .get(&path.source_category_id)
                .ok_or("category_total_missing")?
                .availability;
            let destination_before = totals
                .get(&path.destination_category_id)
                .ok_or("category_total_missing")?
                .availability;
            let source_redirected = paths
                .iter()
                .filter(|other| other.source_category_id == path.source_category_id)
                .try_fold(0_i64, |total, other| total.checked_add(other.amount))
                .ok_or("money_arithmetic_overflow")?;
            let destination_redirected = paths
                .iter()
                .filter(|other| other.destination_category_id == path.destination_category_id)
                .try_fold(0_i64, |total, other| total.checked_add(other.amount))
                .ok_or("money_arithmetic_overflow")?;
            let source_after = source_before
                .checked_sub(source_redirected)
                .ok_or("money_arithmetic_overflow")?
                .checked_sub(
                    purchases
                        .get(&path.source_category_id)
                        .copied()
                        .unwrap_or(0),
                )
                .ok_or("money_arithmetic_overflow")?;
            let destination_after = destination_before
                .checked_add(destination_redirected)
                .ok_or("money_arithmetic_overflow")?
                .checked_sub(
                    purchases
                        .get(&path.destination_category_id)
                        .copied()
                        .unwrap_or(0),
                )
                .ok_or("money_arithmetic_overflow")?;
            Ok(json!({
                "kind": "category_reallocation",
                "sourceCategoryId": path.source_category_id.clone(),
                "destinationCategoryId": path.destination_category_id.clone(),
                "amount": {
                    "minorUnits": path.amount.to_string(),
                    "currency": path.currency.clone()
                },
                "approvalRequired": true,
                "tradeoffs": ["donor_category_surplus_redirected"],
                "before": {
                    "sourceAvailability": {
                        "minorUnits": source_before.to_string(),
                        "currency": path.currency.clone()
                    },
                    "destinationAvailability": {
                        "minorUnits": destination_before.to_string(),
                        "currency": path.currency.clone()
                    }
                },
                "after": {
                    "sourceAvailability": {
                        "minorUnits": source_after.to_string(),
                        "currency": path.currency.clone()
                    },
                    "destinationAvailability": {
                        "minorUnits": destination_after.to_string(),
                        "currency": path.currency.clone()
                    }
                }
            }))
        })
        .collect()
}

fn goal_impacts(
    request: &DecisionCardRequest,
    totals: &BTreeMap<String, CategoryTotals>,
    purchases: &BTreeMap<String, i64>,
    reallocations: &BTreeMap<String, i64>,
    after: bool,
) -> Result<Vec<Value>, &'static str> {
    let policies = policy_map(request)?;
    let mut impacts = Vec::new();
    for (category_id, policy) in policies {
        let kind = policy.kind.to_ascii_lowercase();
        if kind != "goal" && kind != "protected" {
            continue;
        }
        let total = totals.get(&category_id).ok_or("category_total_missing")?;
        let purchase = if after {
            purchases.get(&category_id).copied().unwrap_or(0)
        } else {
            0
        };
        let redirected = if after {
            reallocations.get(&category_id).copied().unwrap_or(0)
        } else {
            0
        };
        let availability = checked_add(checked_sub(total.availability, purchase)?, redirected)?;
        let uncommitted = checked_sub(
            checked_sub(availability, total.reservations)?,
            total.commitments,
        )?
        .max(0);
        let required_retained = policy_floor(policy)?;
        let shortfall = checked_sub(required_retained, uncommitted)?.max(0);
        let currency = request
            .financial_snapshot
            .liquidity
            .as_ref()
            .and_then(|facts| {
                facts
                    .categories
                    .iter()
                    .find(|category| category.category_id == category_id)
            })
            .map(|category| category.availability.currency())
            .ok_or("category_missing")?;
        impacts.push(json!({
            "categoryId": category_id,
            "kind": kind,
            "state": if shortfall > 0 { "at_risk" } else { "on_track" },
            "shortfall": money(shortfall, currency),
            "minimumRetained": money(policy.minimum_retained.minor_units(), currency),
            "projectedRemainingNeed": money(policy.projected_remaining_need.minor_units(), currency),
            "requiredRetained": money(required_retained, currency),
            "targetState": "unknown",
            "availability": money(availability, currency),
            "uncommittedAvailability": money(uncommitted, currency),
        }));
    }
    Ok(impacts)
}

fn obligation_values(request: &DecisionCardRequest) -> Result<Vec<Value>, &'static str> {
    let Some(facts) = request.financial_snapshot.liquidity.as_ref() else {
        return Ok(vec![]);
    };
    let mut values = BTreeMap::<String, Value>::new();
    for account in &facts.accounts {
        for obligation in &account.obligations {
            if obligation.paid
                || obligation.included_in_balance
                || !obligation_in_horizon(&obligation.due_at, &request.context.horizon.ends_at)
            {
                continue;
            }
            if obligation.economic_obligation_id.is_empty() || obligation.amount.is_negative() {
                return Err("ambiguous_obligation_match");
            }
            let mut value = json!({
                "economicObligationId": obligation.economic_obligation_id,
                "classification": "commitment",
                "accountId": account.account_id,
                "categoryId": obligation.category_id,
                "amount": obligation.amount,
                "dueAt": obligation.due_at,
                "state": "active",
                "recurring": false,
            });
            if let Some(schedule) = facts.schedules.iter().find(|schedule| {
                schedule.id == obligation.id
                    || schedule.due_date.as_deref().is_some_and(|due| {
                        obligation.economic_obligation_id
                            == format!("schedule:{}:{}", schedule.id, due)
                    })
            }) {
                value["scheduleId"] = Value::String(schedule.id.clone());
                value["recurring"] = Value::Bool(schedule.recurrence.is_some());
                if let Some(recurrence) = &schedule.recurrence {
                    value["recurrence"] = serde_json::to_value(recurrence)
                        .map_err(|_| "decision_card_serialization_error")?;
                }
            }
            if let Some(previous) = values.get(&obligation.economic_obligation_id) {
                if previous["amount"] != value["amount"]
                    || previous["categoryId"] != value["categoryId"]
                    || previous["accountId"] != value["accountId"]
                {
                    return Err("ambiguous_obligation_match");
                }
                continue;
            }
            values.insert(obligation.economic_obligation_id.clone(), value);
        }
    }
    for bundle in &request.claim_set.bundles {
        if !active_claim(bundle, &request.context.evaluated_at) {
            continue;
        }
        for effect in &bundle.effects {
            if effect.included_in_balance {
                continue;
            }
            if effect.economic_obligation_id.is_empty() {
                return Err("missing_economic_obligation_id");
            }
            if effect.amount.is_negative() {
                return Err("negative_claim");
            }
            let category_id = if effect.kind == ClaimEffectKind::Category {
                Some(
                    effect
                        .category_id
                        .as_deref()
                        .unwrap_or(effect.resource_id.as_str())
                        .to_owned(),
                )
            } else {
                effect.category_id.clone()
            };
            let account_id = if effect.kind == ClaimEffectKind::Category {
                None
            } else {
                Some(effect.resource_id.clone())
            };
            let value = json!({
                "economicObligationId": effect.economic_obligation_id,
                "classification": "reservation",
                "accountId": account_id,
                "categoryId": category_id,
                "amount": effect.amount,
                "state": "active",
            });
            if let Some(previous) = values.get_mut(&effect.economic_obligation_id) {
                // A claim mirroring a known account obligation retains the
                // commitment classification while preserving any account or
                // category scope supplied by the claim.
                if previous["amount"] != value["amount"] {
                    return Err("ambiguous_claim_match");
                }
                for key in ["accountId", "categoryId"] {
                    if previous[key].is_null() && !value[key].is_null() {
                        previous[key] = value[key].clone();
                    } else if !previous[key].is_null()
                        && !value[key].is_null()
                        && previous[key] != value[key]
                    {
                        return Err("ambiguous_claim_match");
                    }
                }
                continue;
            }
            values.insert(effect.economic_obligation_id.clone(), value);
        }
    }
    // Schedules are retained even when their corresponding account
    // obligation is absent; the account-aware engine will block such
    // incomplete evidence, but the card must still show the recurring fact.
    for schedule in &facts.schedules {
        let Some(due_date) = schedule.due_date.as_deref() else {
            continue;
        };
        if !obligation_in_horizon(due_date, &request.context.horizon.ends_at) {
            continue;
        }
        let identity = format!("schedule:{}:{}", schedule.id, due_date);
        if values.contains_key(&identity) {
            continue;
        }
        let mut value = json!({
            "scheduleId": schedule.id,
            "classification": "commitment",
            "accountId": schedule.account_id,
            "categoryId": schedule.category_id,
            "dueAt": due_date,
            "state": "scheduled",
            "recurring": schedule.recurrence.is_some(),
            "amount": Value::Null,
            "amountState": "unknown",
        });
        if schedule.certainty == ScheduleAmountCertainty::Exact {
            if let Some(amount) = &schedule.amount {
                value["amount"] = amount
                    .abs()
                    .map_err(|_| "money_arithmetic_overflow")
                    .and_then(|amount| {
                        serde_json::to_value(amount)
                            .map_err(|_| "decision_card_serialization_error")
                    })?;
                value["amountState"] = Value::String("known".into());
            }
        }
        if let Some(recurrence) = &schedule.recurrence {
            value["recurrence"] = serde_json::to_value(recurrence)
                .map_err(|_| "decision_card_serialization_error")?;
        }
        values.insert(identity, value);
    }
    Ok(values.into_values().collect())
}

fn runway_value(
    account: Option<&balanceframe_financial_core::liquidity::AccountCapacity>,
    evidence_complete: bool,
) -> Value {
    let Some(account) = account else {
        return json!({
            "state": "unknown",
            "remainingSafeCash": Value::Null,
        });
    };
    let Some(safe) = account.safe_spending_capacity.as_ref() else {
        return json!({
            "state": "unknown",
            "accountId": account.account_id,
            "remainingSafeCash": Value::Null,
        });
    };
    if !evidence_complete {
        return json!({
            "state": "unknown",
            "accountId": account.account_id,
            "remainingSafeCash": Value::Null,
        });
    }
    json!({
        "state": "known",
        "accountId": account.account_id,
        "remainingSafeCash": safe,
        "basis": "selected_account_safe_spending_capacity",
    })
}

fn opportunity_costs(
    paths: &[CandidatePath],
    totals: &BTreeMap<String, CategoryTotals>,
    purchases: &BTreeMap<String, i64>,
    request: &DecisionCardRequest,
) -> Result<Vec<Value>, &'static str> {
    let policies = policy_map(request)?;
    let mut grouped = BTreeMap::<(String, String, String), i64>::new();
    for path in paths {
        let key = (
            path.source_category_id.clone(),
            path.destination_category_id.clone(),
            path.currency.clone(),
        );
        let amount = grouped.entry(key).or_insert(0);
        *amount = checked_add(*amount, path.amount)?;
    }
    grouped
        .into_iter()
        .map(|((source, destination, currency), amount)| {
            let total = totals.get(&source).ok_or("category_total_missing")?;
            let redirected = paths
                .iter()
                .filter(|path| path.source_category_id == source)
                .try_fold(0_i64, |sum, path| checked_add(sum, path.amount))?;
            let after_availability = checked_sub(
                checked_sub(total.availability, redirected)?,
                purchases.get(&source).copied().unwrap_or(0),
            )?;
            let after_total = CategoryTotals {
                availability: after_availability,
                reservations: total.reservations,
                commitments: total.commitments,
            };
            let before_safe = policy_surplus(total, policies.get(&source).copied())?;
            let after_safe = policy_surplus(&after_total, policies.get(&source).copied())?;
            Ok(json!({
                "kind": "category_opportunity_cost",
                "sourceCategoryId": source,
                "destinationCategoryId": destination,
                "amount": money(amount, &currency),
                "beforeSafeToRedirect": money(before_safe, &currency),
                "afterSafeToRedirect": money(after_safe, &currency),
                "tradeoff": "donor_category_surplus_redirected",
            }))
        })
        .collect()
}

fn readiness(outcome: &str, blockers: &[String], engine: &AccountAwareSpendabilityResult) -> Value {
    json!({
        "outcome": outcome,
        "status": if blockers.is_empty() { "evaluated" } else { "blocked" },
        "blockers": blockers,
        "budgetFundingStatus": budget_status(engine.budget_funding_status),
        "paymentLiquidityStatus": payment_status(engine.payment_liquidity_status)
    })
}

fn empty_card(request: &DecisionCardRequest, hash: String, reasons: Vec<String>) -> DecisionCard {
    let mut all_reasons = reasons;
    all_reasons.extend(snapshot_scope_reasons(request));
    all_reasons.extend(material_snapshot_blockers(request));
    let reasons = unique_reasons(all_reasons);
    DecisionCard {
        version: "1".into(),
        decision_id: request.decision_id.clone(),
        request_id: request.request_id.clone(),
        correlation_id: request.correlation_id.clone(),
        snapshot_id: request.financial_snapshot.snapshot_id.clone(),
        content_hash: request.financial_snapshot.content_hash.clone(),
        policy_version: request.liquidity_policy.version.clone(),
        policy_hash: request.liquidity_policy.policy_hash.clone(),
        claim_set_revision: request.claim_set.revision.clone(),
        plan_hash: hash,
        outcome: "insufficient_data".into(),
        budget_funding_status: "insufficient_data".into(),
        payment_liquidity_status: "insufficient_data".into(),
        selected_account_id: None,
        selection_source: None,
        before: None,
        after: None,
        funding_paths: vec![],
        opportunity_costs: vec![],
        conflicts: vec![],
        authorization_requirements: vec![],
        evidence: evidence(request),
        blockers: reasons.clone(),
        reasons,
        assumptions: vec![],
        earliest_expiry: request.valid_until.clone(),
        expires_at: request.valid_until.clone(),
        readiness: json!({
            "outcome": "insufficient_data",
            "status": "blocked"
        }),
        items: vec![],
    }
}

// Conflicts are derived from the engine's cumulative result; this helper
// never invents an additional capacity deduction.
fn account_capacity_conflicts(
    request: &DecisionCardRequest,
    engine_map: &BTreeMap<String, PurchaseLiquidityResult>,
) -> (Vec<Value>, Vec<String>) {
    let mut prior = BTreeMap::<String, Vec<String>>::new();
    let mut conflicts = Vec::new();
    let mut reasons = Vec::new();
    let mut ordered_items: Vec<_> = request.items.iter().collect();
    ordered_items.sort_by(|left, right| left.id.cmp(&right.id));
    for item in ordered_items {
        let Some(result) = engine_map.get(&item.id) else {
            continue;
        };
        let Some(account_id) = result.selected_account_id.as_ref() else {
            continue;
        };
        let competing = prior.get(account_id).cloned().unwrap_or_default();
        if !competing.is_empty()
            && matches!(
                result.payment_liquidity_status,
                PaymentLiquidityStatus::UseOtherAccount
                    | PaymentLiquidityStatus::TransferTooLate
                    | PaymentLiquidityStatus::NotLiquid
            )
        {
            conflicts.push(json!({
                "kind": "competing_account_capacity",
                "accountId": account_id,
                "itemId": item.id,
                "competingItemIds": competing,
                "reason": "engine_cumulative_account_capacity",
                "paymentLiquidityStatus": payment_status(result.payment_liquidity_status),
            }));
            reasons.push("competing_account_capacity".into());
        }
        prior
            .entry(account_id.clone())
            .or_default()
            .push(item.id.clone());
    }
    (conflicts, reasons)
}

/// Evaluate a proposed purchase or joint cart into one immutable Decision Card.
/// Account balances, transfer timing, claims, backing, and joint purchase
/// arithmetic are delegated to the existing account-aware liquidity evaluator.
/// Category policy and card outcome precedence are deterministic projections;
/// no ledger or claim mutation is performed.
pub fn evaluate_decision_card(request: DecisionCardRequest) -> DecisionCard {
    let hash = match plan_hash(&request) {
        Ok(hash) => hash,
        Err(reason) => {
            return empty_card(&request, String::new(), vec![reason.into()]);
        }
    };
    let items = match engine_items(&request) {
        Ok(items) if !items.is_empty() => items,
        Ok(_) => return empty_card(&request, hash, vec!["empty_purchase_scenario".into()]),
        Err(reason) => return empty_card(&request, hash, vec![reason.into()]),
    };
    let totals = match category_totals(&request) {
        Ok(totals) => totals,
        Err(reason) => return empty_card(&request, hash, vec![reason.into()]),
    };
    let policies = match policy_map(&request) {
        Ok(policies) => policies,
        Err(reason) => return empty_card(&request, hash, vec![reason.into()]),
    };
    let purchase_totals = match purchases_by_category(&request, &items) {
        Ok(totals) => totals,
        Err(reason) => return empty_card(&request, hash, vec![reason.into()]),
    };

    let mut category_shortfalls = BTreeSet::new();
    for (category_id, amount) in &purchase_totals {
        // Category reallocation is a current-period operation.  The shared
        // engine remains authoritative for a future-dated purchase's own
        // period, but future assignments never satisfy this current donor
        // calculation.
        if current_category_fact(&request, category_id).is_none() {
            continue;
        }
        let Some(total) = totals.get(category_id) else {
            continue;
        };
        let spendable = match checked_sub(total.availability, total.reservations)
            .and_then(|value| checked_sub(value, total.commitments))
        {
            Ok(value) => value.max(0),
            Err(reason) => return empty_card(&request, hash, vec![reason.into()]),
        };
        if *amount > spendable {
            category_shortfalls.insert(category_id.clone());
        }
    }
    let engine = evaluate_account_aware_spendability(engine_request(
        &request,
        items.clone(),
        request.financial_snapshot.liquidity.clone(),
    ));
    let engine_map = engine_item_map(&engine);
    let mut reasons = engine.reasons.clone();
    reasons.extend(snapshot_scope_reasons(&request));
    let mut blockers = material_snapshot_blockers(&request);
    for purchase in &engine.purchases {
        reasons.extend(purchase.reasons.clone());
    }
    reasons.extend(blockers.clone());
    if engine.budget_funding_status == BudgetFundingStatus::InsufficientData
        || engine.payment_liquidity_status == PaymentLiquidityStatus::InsufficientData
        || engine.purchases.iter().any(|purchase| {
            purchase.budget_funding_status == BudgetFundingStatus::InsufficientData
                || purchase.payment_liquidity_status == PaymentLiquidityStatus::InsufficientData
        })
    {
        blockers.extend(reasons.clone());
    }

    let mut base_item_outcomes = Vec::new();
    for item in &request.items {
        if let Some(result) = engine_map.get(&item.id) {
            base_item_outcomes.push(item_outcome(
                result,
                policies.get(&item.category_id).copied(),
            ));
        } else {
            base_item_outcomes.push("insufficient_data".into());
            blockers.push("missing_item_result".into());
        }
    }

    for (index, item) in request.items.iter().enumerate() {
        if category_shortfalls.contains(&item.category_id)
            && base_item_outcomes
                .get(index)
                .is_some_and(|outcome| outcome == "funded_now" || outcome == "safe_after_date")
        {
            if let Some(outcome) = base_item_outcomes.get_mut(index) {
                *outcome = "cash_available_but_unfunded".into();
            }
        }
    }

    let mut plan_breaking = false;
    for (category_id, amount) in &purchase_totals {
        let Some(policy) = policies.get(category_id).copied() else {
            blockers.push(format!("missing_category_policy:{category_id}"));
            continue;
        };
        let kind = policy.kind.to_ascii_lowercase();
        if kind != "protected" && kind != "goal" {
            continue;
        }
        let Some(total) = totals.get(category_id) else {
            blockers.push(format!("category_missing:{category_id}"));
            continue;
        };
        let after = match checked_sub(total.availability, *amount)
            .and_then(|value| checked_sub(value, total.reservations))
            .and_then(|value| checked_sub(value, total.commitments))
        {
            Ok(after) => after,
            Err(reason) => {
                blockers.push(reason.into());
                continue;
            }
        };
        let retained = match policy_floor(policy) {
            Ok(retained) => retained,
            Err(reason) => {
                blockers.push(reason.into());
                continue;
            }
        };
        if after < retained {
            plan_breaking = true;
            reasons.push(format!("{kind}_category_breach"));
        }
    }

    if plan_breaking {
        for (index, item) in request.items.iter().enumerate() {
            if policies.get(&item.category_id).is_some_and(|policy| {
                let kind = policy.kind.to_ascii_lowercase();
                kind == "protected" || kind == "goal"
            }) && base_item_outcomes
                .get(index)
                .is_some_and(|outcome| outcome != "insufficient_data")
            {
                if let Some(outcome) = base_item_outcomes.get_mut(index) {
                    *outcome = "plan_breaking".into();
                }
            }
        }
    }

    let paths = if blockers.is_empty() && !plan_breaking {
        match donor_paths(&request, &items, &totals, &purchase_totals) {
            Ok(paths) => paths,
            Err(reason) => {
                blockers.push(reason.into());
                vec![]
            }
        }
    } else {
        vec![]
    };
    let reallocation_totals = match paths.iter().try_fold(
        BTreeMap::new(),
        |mut map: BTreeMap<String, i64>, path| -> Result<_, &'static str> {
            let source = map.entry(path.source_category_id.clone()).or_insert(0);
            *source = checked_sub(*source, path.amount)?;
            let destination = map.entry(path.destination_category_id.clone()).or_insert(0);
            *destination = checked_add(*destination, path.amount)?;
            Ok(map)
        },
    ) {
        Ok(map) => map,
        Err(reason) => return empty_card(&request, hash, vec![reason.into()]),
    };
    let donor_engine = if paths.is_empty() {
        None
    } else {
        let mut facts = request.financial_snapshot.liquidity.clone();
        if let Some(facts) = &mut facts {
            let mut valid = true;
            for path in &paths {
                let Some(source_index) = facts.categories.iter().position(|category| {
                    category.category_id == path.source_category_id
                        && category.as_of_month == path.source_as_of_month
                }) else {
                    valid = false;
                    break;
                };
                let Some(destination_index) = facts.categories.iter().position(|category| {
                    category.category_id == path.destination_category_id
                        && category.as_of_month == path.destination_as_of_month
                }) else {
                    valid = false;
                    break;
                };
                let source_currency = facts.categories[source_index]
                    .availability
                    .currency()
                    .to_owned();
                let destination_currency = facts.categories[destination_index]
                    .availability
                    .currency()
                    .to_owned();
                let Ok(source_value) = facts.categories[source_index]
                    .availability
                    .sub(&money(path.amount, &source_currency))
                else {
                    valid = false;
                    break;
                };
                let Ok(destination_value) = facts.categories[destination_index]
                    .availability
                    .add(&money(path.amount, &destination_currency))
                else {
                    valid = false;
                    break;
                };
                facts.categories[source_index].availability = source_value;
                facts.categories[destination_index].availability = destination_value;
            }
            if valid {
                Some(evaluate_account_aware_spendability(engine_request(
                    &request,
                    items.clone(),
                    Some(facts.clone()),
                )))
            } else {
                None
            }
        } else {
            None
        }
    };

    if !paths.is_empty() {
        for (index, item) in request.items.iter().enumerate() {
            if category_shortfalls.contains(&item.category_id)
                && base_item_outcomes
                    .get(index)
                    .is_some_and(|outcome| outcome == "cash_available_but_unfunded")
            {
                if let Some(outcome) = base_item_outcomes.get_mut(index) {
                    *outcome = "safe_with_reallocation".into();
                }
            }
        }
    }
    let selected_account_id = engine
        .purchases
        .first()
        .and_then(|purchase| purchase.selected_account_id.clone());
    let selection_source = engine
        .purchases
        .first()
        .map(|purchase| purchase.selection_source.clone());

    // The shared engine evaluates the joint cart in deterministic item order
    // and carries account capacity forward.  Do not apply a second-item
    // heuristic here; report conflicts only when that cumulative result
    // actually rejects a competing selected-account item.
    let (conflicts, conflict_reasons) = account_capacity_conflicts(&request, &engine_map);
    reasons.extend(conflict_reasons);
    let mut item_outcomes = Vec::with_capacity(request.items.len());
    for (index, item) in request.items.iter().enumerate() {
        let outcome = base_item_outcomes
            .get(index)
            .cloned()
            .unwrap_or_else(|| "insufficient_data".into());
        let result = engine_map.get(&item.id);
        item_outcomes.push(DecisionCardItemOutcome {
            id: item.id.clone(),
            category_id: item.category_id.clone(),
            amount: items
                .iter()
                .find(|engine_item| engine_item.id == item.id)
                .map(|engine_item| engine_item.amount.clone())
                .unwrap_or_else(|| item.amount.clone()),
            priority: item.priority.clone(),
            outcome,
            budget_funding_status: result
                .map(|value| budget_status(value.budget_funding_status))
                .unwrap_or("insufficient_data")
                .into(),
            payment_liquidity_status: result
                .map(|value| payment_status(value.payment_liquidity_status))
                .unwrap_or("insufficient_data")
                .into(),
            selected_account_id: result.and_then(|value| value.selected_account_id.clone()),
            selection_source: result
                .map(|value| value.selection_source.clone())
                .unwrap_or_else(|| "none".into()),
            reasons: result
                .map(|value| value.reasons.clone())
                .unwrap_or_default(),
            before: result.and_then(|value| {
                value.selected_before.as_ref().map(|capacity| {
                    serde_json::to_value(capacity).unwrap_or_else(|_| {
                        json!({
                            "state": "unknown",
                            "reason": "decision_card_serialization_error",
                        })
                    })
                })
            }),
            after: result.and_then(|value| {
                value.selected_after.as_ref().map(|capacity| {
                    serde_json::to_value(capacity).unwrap_or_else(|_| {
                        json!({
                            "state": "unknown",
                            "reason": "decision_card_serialization_error",
                        })
                    })
                })
            }),
        });
    }

    let candidate_engine = donor_engine.as_ref().unwrap_or(&engine);
    let candidate_budget = candidate_engine.budget_funding_status;
    let candidate_payment = candidate_engine.payment_liquidity_status;
    let mut projection_blockers = Vec::new();
    if !paths.is_empty() && donor_engine.is_none() {
        projection_blockers.push("category_reallocation_engine_validation".into());
    }
    let transfer_funding_paths = match transfer_paths(candidate_engine) {
        Ok(paths) => paths,
        Err(reason) => {
            projection_blockers.push(reason.into());
            Vec::new()
        }
    };
    let category_funding_paths =
        match category_reallocation_paths(&paths, &totals, &purchase_totals) {
            Ok(paths) => paths,
            Err(reason) => {
                projection_blockers.push(reason.into());
                Vec::new()
            }
        };
    let opportunity_cost_values =
        match opportunity_costs(&paths, &totals, &purchase_totals, &request) {
            Ok(values) => values,
            Err(reason) => {
                projection_blockers.push(reason.into());
                Vec::new()
            }
        };
    let before_goals =
        match goal_impacts(&request, &totals, &BTreeMap::new(), &BTreeMap::new(), false) {
            Ok(goals) => goals,
            Err(reason) => {
                projection_blockers.push(reason.into());
                Vec::new()
            }
        };
    let after_goals = match goal_impacts(
        &request,
        &totals,
        &purchase_totals,
        &reallocation_totals,
        true,
    ) {
        Ok(goals) => goals,
        Err(reason) => {
            projection_blockers.push(reason.into());
            Vec::new()
        }
    };
    let obligation_projection = match obligation_values(&request) {
        Ok(obligations) => obligations,
        Err(reason) => {
            projection_blockers.push(reason.into());
            Vec::new()
        }
    };
    let before_categories =
        match state_categories(&request, &totals, &BTreeMap::new(), &BTreeMap::new(), false) {
            Ok(categories) => Some(categories),
            Err(reason) => {
                projection_blockers.push(reason.into());
                None
            }
        };
    let after_categories = match state_categories(
        &request,
        &totals,
        &purchase_totals,
        &reallocation_totals,
        true,
    ) {
        Ok(categories) => Some(categories),
        Err(reason) => {
            projection_blockers.push(reason.into());
            None
        }
    };
    blockers.extend(projection_blockers);
    if !blockers.is_empty() {
        reasons.extend(blockers.clone());
    }
    let evidence_complete = blockers.is_empty();
    let before_account = selected_account_id.as_ref().and_then(|id| {
        engine
            .accounts_before
            .iter()
            .find(|account| &account.account_id == id)
    });
    let after_account = selected_account_id.as_ref().and_then(|id| {
        candidate_engine
            .accounts_after
            .iter()
            .find(|account| &account.account_id == id)
    });
    let before_runway = runway_value(before_account, evidence_complete);
    let after_runway = runway_value(after_account, evidence_complete);
    let insufficient = !blockers.is_empty();
    let any_item_not_safe = item_outcomes.iter().any(|item| item.outcome == "not_safe");
    let all_funded = category_shortfalls.is_empty()
        && candidate_budget == BudgetFundingStatus::Funded
        && item_outcomes
            .iter()
            .all(|item| item.budget_funding_status == "funded");
    let donor_safe = !paths.is_empty()
        && candidate_budget == BudgetFundingStatus::Funded
        && !matches!(
            candidate_payment,
            PaymentLiquidityStatus::InsufficientData
                | PaymentLiquidityStatus::NotLiquid
                | PaymentLiquidityStatus::TransferTooLate
        );
    let has_transfer_path = has_evidenced_transfer_path(candidate_engine);
    let outcome = if insufficient {
        "insufficient_data"
    } else if plan_breaking {
        "plan_breaking"
    } else if any_item_not_safe
        || matches!(
            candidate_payment,
            PaymentLiquidityStatus::NotLiquid
                | PaymentLiquidityStatus::TransferTooLate
                | PaymentLiquidityStatus::UseOtherAccount
        )
    {
        reasons.push("payment_liquidity_not_ready".into());
        "not_safe"
    } else if donor_safe {
        if candidate_payment == PaymentLiquidityStatus::TransferRequired && has_transfer_path {
            "safe_after_date"
        } else {
            "safe_with_reallocation"
        }
    } else if (candidate_budget == BudgetFundingStatus::Unfunded || !category_shortfalls.is_empty())
        && candidate_payment == PaymentLiquidityStatus::Ready
    {
        reasons.push("cash_available_but_unfunded".into());
        "cash_available_but_unfunded"
    } else if all_funded
        && candidate_payment == PaymentLiquidityStatus::TransferRequired
        && has_transfer_path
    {
        "safe_after_date"
    } else if all_funded && candidate_payment == PaymentLiquidityStatus::Ready {
        "funded_now"
    } else if candidate_budget == BudgetFundingStatus::InsufficientData
        || candidate_payment == PaymentLiquidityStatus::InsufficientData
    {
        "insufficient_data"
    } else {
        "not_safe"
    };

    let card_budget_status = if outcome != "insufficient_data" && !paths.is_empty() {
        "funded"
    } else if !category_shortfalls.is_empty() && outcome != "insufficient_data" {
        "unfunded"
    } else {
        budget_status(candidate_budget)
    };

    if outcome == "funded_now" {
        for item in &request.items {
            if let Some(policy) = policies.get(&item.category_id) {
                if policy.kind.eq_ignore_ascii_case("joy") {
                    reasons.push("joy_category_funded".into());
                } else if policy.kind.eq_ignore_ascii_case("discretionary") {
                    reasons.push("discretionary_category_funded".into());
                }
            }
        }
    }
    if outcome == "cash_available_but_unfunded" && paths.is_empty() {
        reasons.push("no_safe_donor_surplus".into());
    }
    if paths.is_empty() {
        let mut shortfall = false;
        for (category_id, amount) in &purchase_totals {
            if current_category_fact(&request, category_id).is_none() {
                continue;
            }
            let Some(total) = totals.get(category_id) else {
                continue;
            };
            let available = match checked_sub(total.availability, total.reservations)
                .and_then(|value| checked_sub(value, total.commitments))
            {
                Ok(available) => available.max(0),
                Err(reason) => {
                    reasons.push(reason.into());
                    continue;
                }
            };
            if *amount > available {
                shortfall = true;
            }
        }
        if shortfall {
            reasons.push("donor_surplus_below_floor_or_projected_need".into());
        }
    }

    let before = before_categories.map(|categories| DecisionCardState {
        categories,
        accounts: engine
            .accounts_before
            .iter()
            .map(|account| {
                serde_json::to_value(account).unwrap_or_else(
                    |_| json!({"state": "unknown", "reason": "decision_card_serialization_error"}),
                )
            })
            .collect(),
        backing: serde_json::to_value(&engine.backing_before).unwrap_or_else(
            |_| json!({"state": "unknown", "reason": "decision_card_serialization_error"}),
        ),
        goals: before_goals,
        obligations: obligation_projection.clone(),
        runway: Some(before_runway),
    });
    let after = if insufficient {
        None
    } else {
        after_categories.map(|categories| DecisionCardState {
            categories,
            accounts: candidate_engine
                .accounts_after
                .iter()
                .map(|account| {
                    serde_json::to_value(account).unwrap_or_else(|_| {
                        json!({"state": "unknown", "reason": "decision_card_serialization_error"})
                    })
                })
                .collect(),
            backing: serde_json::to_value(&candidate_engine.backing_after).unwrap_or_else(
                |_| json!({"state": "unknown", "reason": "decision_card_serialization_error"}),
            ),
            goals: after_goals,
            obligations: obligation_projection,
            runway: Some(after_runway),
        })
    };

    let mut funding_paths = transfer_funding_paths;
    funding_paths.extend(category_funding_paths);
    let has_transfer_disclosure = funding_paths.iter().any(|path| {
        path.get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "account_transfer")
    });
    let mut assumptions = candidate_engine.assumptions.clone();
    if !paths.is_empty() {
        assumptions.push("category_reallocation_is_advice_only".into());
    }
    let mut authorization_requirements = Vec::new();
    if !paths.is_empty() {
        authorization_requirements.push("category_reallocation_approval".into());
    }
    if has_transfer_disclosure {
        authorization_requirements.push("account_transfer_approval".into());
    }
    let authorization_requirements = unique_reasons(authorization_requirements);
    let reasons = unique_reasons(reasons);
    let blockers = if outcome == "insufficient_data" {
        unique_reasons(blockers)
    } else {
        vec![]
    };
    let evidence = evidence(&request);
    let expires_at = candidate_engine.expires_at.clone();
    let readiness_value = readiness(
        outcome,
        if outcome == "insufficient_data" {
            &blockers
        } else {
            &[]
        },
        candidate_engine,
    );
    DecisionCard {
        version: "1".into(),
        decision_id: request.decision_id.clone(),
        request_id: request.request_id.clone(),
        correlation_id: request.correlation_id.clone(),
        snapshot_id: request.financial_snapshot.snapshot_id.clone(),
        content_hash: request.financial_snapshot.content_hash.clone(),
        policy_version: request.liquidity_policy.version.clone(),
        policy_hash: request.liquidity_policy.policy_hash.clone(),
        claim_set_revision: request.claim_set.revision.clone(),
        plan_hash: hash,
        outcome: outcome.into(),
        budget_funding_status: card_budget_status.into(),
        payment_liquidity_status: payment_status(candidate_payment).into(),
        selected_account_id,
        selection_source,
        before,
        after,
        funding_paths,
        opportunity_costs: opportunity_cost_values,
        conflicts,
        authorization_requirements,
        evidence,
        blockers,
        reasons,
        assumptions,
        earliest_expiry: expires_at.clone(),
        expires_at,
        readiness: readiness_value,
        items: item_outcomes,
    }
}
