//! Stable Actual-ID rule planning, complete leaf simulation, and postconditions.

use crate::{
    CreateRulePlan, MerchantScope, PayeeCondition, ProtocolSnapshot, RuleSimulationResult,
    SimulationExample, VerificationResult,
};
use balanceframe_financial_core::{ActualRuleConditions, Rule, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::io::{self, Write};

/// Server-admitted evidence and visibility reviewed with an exact rule proposal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleReviewContext {
    /// Server-selected source namespace, never client authority.
    pub scope: MerchantScope,
    /// Stable admitted source revision, excluding capture timestamps.
    pub source_facts_hash: String,
    /// Scoped merchant evidence record, or null for direct rules settings.
    pub evidence_key: Option<String>,
    /// Current admitted evidence revision.
    pub evidence_revision: String,
    /// Effective merchant policy revision.
    pub merchant_policy_version: String,
    /// Complete source visibility revision.
    pub visibility_hash: String,
    /// Exclusive freshness deadline; enforced with the trusted application clock.
    pub expires_at: String,
}

/// The sole supported standalone Actual category rule request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRuleRequest {
    /// Editable display label, not merchant identity.
    pub rule_name: String,
    /// Opaque case-sensitive Actual payee identity.
    pub payee_id: String,
    /// Opaque case-sensitive active Actual category identity.
    pub category_id: String,
    /// Independently admitted current evidence and policy.
    pub review_context: RuleReviewContext,
}

/// Invalid or unavailable source cannot be represented as a no-impact success.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum RulePlanningError {
    /// Invalid request, evidence metadata, source identity, or native payload.
    #[error("Invalid native rule request or source")]
    InvalidSource,
    /// The exact payee has been deleted, merged, or was never admitted.
    #[error("Native rule payee is unavailable")]
    PayeeUnavailable,
    /// The exact category is absent or deleted.
    #[error("Native rule category is unavailable")]
    CategoryUnavailable,
    /// Two different source observations claim the same stable identity.
    #[error("Conflicting native rule source identity")]
    ConflictingSourceId,
}

fn nonempty(value: &str) -> bool {
    !value.trim().is_empty()
}

fn validate_targets(
    snapshot: &ProtocolSnapshot,
    payee: &str,
    category: &str,
) -> Result<(), RulePlanningError> {
    if !nonempty(payee)
        || !nonempty(category)
        || !matches!(snapshot.schema_version.as_str(), "1" | "1.0")
        || !nonempty(&snapshot.actual_version)
    {
        return Err(RulePlanningError::InvalidSource);
    }
    let mut payees = snapshot.payees.iter().filter(|item| item.id == payee);
    if payees.next().is_none() {
        return Err(RulePlanningError::PayeeUnavailable);
    }
    if payees.next().is_some() {
        return Err(RulePlanningError::ConflictingSourceId);
    }
    let mut categories = snapshot
        .categories
        .iter()
        .filter(|item| item.id == category);
    if categories.next().is_none_or(|item| item.deleted) {
        return Err(RulePlanningError::CategoryUnavailable);
    }
    if categories.next().is_some() {
        return Err(RulePlanningError::ConflictingSourceId);
    }
    Ok(())
}

fn payload(payee: &str, category: &str) -> (Value, Value) {
    (
        json!({"stage":"post","conditionsOp":"and","conditions":[{"field":"payee","op":"is","value":payee}]}),
        json!([{"op":"set","field":"category","value":category}]),
    )
}

fn native_term(
    term: &Value,
    field: &str,
    operation: &str,
    value: &str,
    allow_sdk_type: bool,
) -> bool {
    let Some(object) = term.as_object() else {
        return false;
    };
    let metadata = object.get("type");
    object.len() == 3 + usize::from(metadata.is_some())
        && (metadata.is_none() || allow_sdk_type && metadata.and_then(Value::as_str) == Some("id"))
        && term.get("field").and_then(Value::as_str) == Some(field)
        && term.get("op").and_then(Value::as_str) == Some(operation)
        && term.get("value").and_then(Value::as_str) == Some(value)
}

fn native_payload(
    trigger: &Value,
    actions: &Value,
    payee: &str,
    category: &str,
    allow_sdk_type: bool,
) -> bool {
    trigger.as_object().is_some_and(|object| object.len() == 3)
        && trigger.get("stage").and_then(Value::as_str) == Some("post")
        && trigger.get("conditionsOp").and_then(Value::as_str) == Some("and")
        && trigger
            .get("conditions")
            .and_then(Value::as_array)
            .is_some_and(|terms| {
                terms.len() == 1 && native_term(&terms[0], "payee", "is", payee, allow_sdk_type)
            })
        && actions.as_array().is_some_and(|terms| {
            terms.len() == 1 && native_term(&terms[0], "category", "set", category, allow_sdk_type)
        })
}

fn plan_targets(plan: &CreateRulePlan) -> Result<(&str, &str), RulePlanningError> {
    let payee = plan
        .conditions
        .first()
        .filter(|condition| {
            plan.conditions.len() == 1 && condition.field == "payee" && condition.operation == "is"
        })
        .map(|condition| condition.value.as_str())
        .ok_or(RulePlanningError::InvalidSource)?;
    let category = plan
        .actions
        .as_array()
        .filter(|actions| actions.len() == 1)
        .and_then(|actions| actions[0].get("value"))
        .and_then(Value::as_str)
        .ok_or(RulePlanningError::InvalidSource)?;
    if !native_payload(&plan.trigger, &plan.actions, payee, category, false)
        || !nonempty(&plan.rule_name)
    {
        return Err(RulePlanningError::InvalidSource);
    }
    Ok((payee, category))
}

fn leaves(snapshot: &ProtocolSnapshot) -> Result<BTreeMap<&str, &Transaction>, RulePlanningError> {
    let mut stack: Vec<_> = snapshot.transactions.iter().collect();
    let mut seen = BTreeMap::<&str, &Transaction>::new();
    let mut leaves = BTreeMap::new();
    while let Some(transaction) = stack.pop() {
        if !nonempty(&transaction.id) || !nonempty(&transaction.account_id) {
            return Err(RulePlanningError::InvalidSource);
        }
        if let Some(previous) = seen.insert(&transaction.id, transaction) {
            if previous != transaction {
                return Err(RulePlanningError::ConflictingSourceId);
            }
            continue;
        }
        if transaction.subtransactions.is_empty() {
            leaves.insert(transaction.id.as_str(), transaction);
        } else {
            stack.extend(transaction.subtransactions.iter());
        }
    }
    Ok(leaves)
}

fn ordered_rules(snapshot: &ProtocolSnapshot) -> Result<Vec<&Rule>, RulePlanningError> {
    let mut rules: Vec<_> = snapshot.rules.iter().collect();
    rules.sort_by(|a, b| (a.order, &a.id).cmp(&(b.order, &b.id)));
    let mut ids = std::collections::BTreeSet::new();
    for rule in &rules {
        if !nonempty(&rule.id) {
            return Err(RulePlanningError::InvalidSource);
        }
        if !ids.insert(&rule.id) {
            return Err(RulePlanningError::ConflictingSourceId);
        }
    }
    Ok(rules)
}

/// Match exact IDs over every recursively nested leaf once, preserving checked Money.
pub fn simulate_create_rule_plan(
    plan: &CreateRulePlan,
    snapshot: &ProtocolSnapshot,
) -> Result<RuleSimulationResult, RulePlanningError> {
    let (payee, category) = plan_targets(plan)?;
    validate_targets(snapshot, payee, category)?;
    let population = leaves(snapshot)?;
    let rules = ordered_rules(snapshot)?;
    simulate_population(plan, &rules, &population, payee, category)
}

fn simulate_population(
    plan: &CreateRulePlan,
    rules: &[&Rule],
    population: &BTreeMap<&str, &Transaction>,
    payee: &str,
    category: &str,
) -> Result<RuleSimulationResult, RulePlanningError> {
    let mut result = RuleSimulationResult {
        rule_id: String::new(),
        name: plan.rule_name.clone(),
        transactions_matched: 0,
        transactions_affected: Vec::new(),
        category_distribution: HashMap::new(),
        conflicts: Vec::new(),
        examples: Vec::new(),
    };
    let reviewed_population = population
        .values()
        .filter(|transaction| transaction.payee_id.as_deref() == Some(payee));
    for transaction in reviewed_population.clone() {
        result.transactions_matched = result
            .transactions_matched
            .checked_add(1)
            .ok_or(RulePlanningError::InvalidSource)?;
        result.transactions_affected.push(transaction.id.clone());
        result.examples.push(SimulationExample {
            tx_id: transaction.id.clone(),
            payee: transaction.payee_name.clone(),
            amount: transaction.amount.clone(),
            current_category: transaction.category_id.clone(),
            would_change: transaction.category_id.as_deref() != Some(category),
        });
    }
    if result.transactions_matched > 0 {
        result
            .category_distribution
            .insert(category.into(), result.transactions_matched);
        result.conflicts = rules
            .iter()
            .filter(|rule| {
                !rule.inactive
                    && ActualRuleConditions::parse(&rule.trigger).is_none_or(|conditions| {
                        reviewed_population
                            .clone()
                            .any(|transaction| conditions.matches(transaction))
                    })
            })
            .map(|rule| rule.id.clone())
            .collect();
        // Unsupported active predicates are disclosed as potential conflicts, not simulated matches.
    }
    Ok(result)
}

struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Plan an exact native rule and bind complete source facts, ordering, impact and evidence.
pub fn plan_create_rule(
    request: &CreateRuleRequest,
    snapshot: &ProtocolSnapshot,
) -> Result<CreateRulePlan, RulePlanningError> {
    let context = &request.review_context;
    if !nonempty(&request.rule_name)
        || [
            &context.scope.space_id,
            &context.scope.budget_id,
            &context.scope.connection_id,
            &context.source_facts_hash,
            &context.evidence_revision,
            &context.merchant_policy_version,
            &context.visibility_hash,
            &context.expires_at,
        ]
        .iter()
        .any(|value| !nonempty(value))
        || context
            .evidence_key
            .as_deref()
            .is_some_and(|key| !nonempty(key))
    {
        return Err(RulePlanningError::InvalidSource);
    }
    validate_targets(snapshot, &request.payee_id, &request.category_id)?;
    let (trigger, actions) = payload(&request.payee_id, &request.category_id);
    let mut plan = CreateRulePlan {
        plan_id: String::new(),
        rule_name: request.rule_name.clone(),
        trigger,
        actions,
        hash: String::new(),
        conditions: vec![PayeeCondition {
            field: "payee".into(),
            operation: "is".into(),
            value: request.payee_id.clone(),
        }],
    };
    let population = leaves(snapshot)?;
    let rules = ordered_rules(snapshot)?;
    let simulation = simulate_population(
        &plan,
        &rules,
        &population,
        &request.payee_id,
        &request.category_id,
    )?;
    // Sorting source collections removes capture ordering, not native rule precedence.
    let mut payees: Vec<_> = snapshot.payees.iter().collect();
    payees.sort_by(|a, b| a.id.cmp(&b.id));
    let mut categories: Vec<_> = snapshot.categories.iter().collect();
    categories.sort_by(|a, b| a.id.cmp(&b.id));
    let mut accounts: Vec<_> = snapshot.accounts.iter().collect();
    accounts.sort_by(|a, b| a.id.cmp(&b.id));
    if payees.windows(2).any(|pair| pair[0].id == pair[1].id)
        || categories.windows(2).any(|pair| pair[0].id == pair[1].id)
        || accounts.windows(2).any(|pair| pair[0].id == pair[1].id)
    {
        return Err(RulePlanningError::ConflictingSourceId);
    }
    let mut hash = HashWriter(Sha256::new());
    // Fresh capture/expiry clocks are admission checks, not financial identity.
    serde_json::to_writer(
        &mut hash,
        &(
            "native-rule/2",
            &snapshot.actual_version,
            &plan.rule_name,
            &plan.trigger,
            &plan.actions,
            (
                &context.scope,
                &context.source_facts_hash,
                &context.evidence_key,
                &context.evidence_revision,
                &context.merchant_policy_version,
                &context.visibility_hash,
            ),
            &accounts,
            &payees,
            &categories,
            &rules,
            &population,
            &simulation,
        ),
    )
    .map_err(|_| RulePlanningError::InvalidSource)?;
    plan.hash = format!("sha256:{:x}", hash.0.finalize());
    plan.plan_id = format!("rule_plan_{}", plan.hash);
    Ok(plan)
}

/// Verify exact active native terms against known targets, never display-name equivalence.
pub fn verify_rule_mutation(
    plan: &CreateRulePlan,
    snapshot: &ProtocolSnapshot,
) -> VerificationResult {
    let verified = plan_targets(plan).is_ok_and(|(payee, category)| {
        validate_targets(snapshot, payee, category).is_ok()
            && snapshot.rules.iter().any(|rule| {
                !rule.inactive
                    && native_payload(&rule.trigger, &rule.actions, payee, category, true)
            })
    });
    VerificationResult {
        verified,
        reason_codes: vec![if verified {
            "rule_creation_verified"
        } else {
            "rule_creation_not_verified"
        }
        .into()],
        message: (!verified)
            .then(|| "Created rule is absent or differs from the approved plan.".into()),
    }
}
