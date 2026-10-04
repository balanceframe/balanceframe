use serde::{Deserialize, Serialize};

use crate::merchant::normalize_merchant;
use crate::money::Money;
use crate::snapshots::{Category, Payee, Rule, Transaction};

// ---------------------------------------------------------------------------
// HistoryRecord
// ---------------------------------------------------------------------------

/// A historical record of a past categorization decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub transaction_id: String,
    pub payee_name: String,
    pub category_id: String,
    pub category_name: String,
    pub amount: Money,
    pub date: String,
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum EvidenceKind {
    ExactPayee,
    Historical,
    AutomationRule,
    AmountPattern,
    ImportMatch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub kind: EvidenceKind,
    pub details: String,
}

impl Evidence {
    pub fn new(kind: EvidenceKind, details: impl Into<String>) -> Self {
        Evidence {
            kind,
            details: details.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// CategorizationCandidate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategorizationCandidate {
    pub transaction_id: String,
    pub amount: Money,
    pub payee_name: Option<String>,
    pub date: String,
    pub reasons: Vec<Evidence>,
    /// Category selected by matching enabled Actual category-setting rules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_category_id: Option<String>,
    /// Display name of the proposed category.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_category_name: Option<String>,
    /// Sorted IDs of matching rules that agree on the proposed category.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_ids: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

/// Attempt to match a transaction to a known payee.  If the payee is found,
/// the returned candidate carries the payee id as context and marks the
/// evidence as `ExactPayee`.
pub fn classify_exact_match(tx: &Transaction, payees: &[Payee]) -> Option<CategorizationCandidate> {
    let tx_normalized = normalize_merchant(tx.payee_name.as_deref().unwrap_or(""));
    if tx_normalized.is_empty() {
        return None;
    }

    let matched = payees
        .iter()
        .find(|p| normalize_merchant(&p.name) == tx_normalized)?;

    // Build a candidate referencing the matched payee
    Some(CategorizationCandidate {
        transaction_id: tx.id.clone(),
        amount: tx.amount.clone(),
        payee_name: tx.payee_name.clone(),
        date: tx.date.clone(),
        reasons: vec![Evidence::new(
            EvidenceKind::ExactPayee,
            format!("Payee '{}' (id={})", matched.name, matched.id),
        )],
        proposed_category_id: None,
        proposed_category_name: None,
        rule_ids: None,
    })
}

/// Attempt to match a transaction against historical categorization records.
/// Uses normalized merchant name comparison.
pub fn classify_historical(
    tx: &Transaction,
    history: &[HistoryRecord],
) -> Option<CategorizationCandidate> {
    let tx_normalized = normalize_merchant(tx.payee_name.as_deref().unwrap_or(""));
    if tx_normalized.is_empty() {
        return None;
    }

    // Find the most recent history record with the same normalized payee
    let matched = history
        .iter()
        .filter(|hr| normalize_merchant(&hr.payee_name) == tx_normalized)
        .max_by(|a, b| a.date.cmp(&b.date))?;

    Some(CategorizationCandidate {
        transaction_id: tx.id.clone(),
        amount: tx.amount.clone(),
        payee_name: tx.payee_name.clone(),
        date: tx.date.clone(),
        reasons: vec![Evidence::new(
            EvidenceKind::Historical,
            format!(
                "Previously categorized as '{}' (id={}) on {}",
                matched.category_name, matched.category_id, matched.date
            ),
        )],
        proposed_category_id: None,
        proposed_category_name: None,
        rule_ids: None,
    })
}

#[derive(Debug, Clone, Copy)]
enum RuleConditionField {
    PayeeName,
    PayeeId,
    AccountId,
    CategoryId,
}

#[derive(Debug)]
enum RuleConditionValue {
    String(String),
    Strings(Vec<String>),
    Null,
}

#[derive(Debug)]
struct RuleCondition {
    field: RuleConditionField,
    value: RuleConditionValue,
}

impl RuleCondition {
    fn matches(&self, tx: &Transaction) -> bool {
        match (self.field, &self.value) {
            (RuleConditionField::PayeeName, RuleConditionValue::String(expected)) => tx
                .payee_name
                .as_deref()
                .is_some_and(|actual| equals_case_insensitively(actual, expected)),
            (RuleConditionField::PayeeId, RuleConditionValue::String(expected)) => {
                tx.payee_id.as_deref() == Some(expected.as_str())
            }
            (RuleConditionField::PayeeId, RuleConditionValue::Null) => tx.payee_id.is_none(),
            (RuleConditionField::AccountId, RuleConditionValue::String(expected)) => {
                tx.account_id.as_str() == expected.as_str()
            }
            (RuleConditionField::AccountId, RuleConditionValue::Strings(expected)) => expected
                .iter()
                .any(|id| tx.account_id.as_str() == id.as_str()),
            (RuleConditionField::CategoryId, RuleConditionValue::String(expected)) => {
                tx.category_id.as_deref() == Some(expected.as_str())
            }
            (RuleConditionField::CategoryId, RuleConditionValue::Strings(expected)) => tx
                .category_id
                .as_deref()
                .is_some_and(|id| expected.iter().any(|value| value == id)),
            (RuleConditionField::CategoryId, RuleConditionValue::Null) => tx.category_id.is_none(),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum RuleConditionsOperator {
    And,
    Or,
}

/// A validated bounded Actual trigger, compiled once for repeated transaction matching.
#[derive(Debug)]
pub struct ActualRuleConditions {
    operator: RuleConditionsOperator,
    conditions: Vec<RuleCondition>,
}

impl ActualRuleConditions {
    /// Compile a complete supported trigger; malformed or unsupported conditions return `None`.
    pub fn parse(trigger: &serde_json::Value) -> Option<Self> {
        let trigger = trigger.as_object()?;
        if !has_only_keys(trigger, &["stage", "conditionsOp", "conditions"]) {
            return None;
        }
        match trigger.get("stage")? {
            serde_json::Value::Null => {}
            serde_json::Value::String(stage) if stage == "pre" || stage == "post" => {}
            _ => return None,
        }
        let operator = match trigger.get("conditionsOp")?.as_str()? {
            "and" => RuleConditionsOperator::And,
            "or" => RuleConditionsOperator::Or,
            _ => return None,
        };
        let raw_conditions = trigger.get("conditions")?.as_array()?;
        if raw_conditions.is_empty() {
            return None;
        }
        let conditions = raw_conditions
            .iter()
            .map(parse_rule_condition)
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            operator,
            conditions,
        })
    }

    /// Evaluate validated conditions against transaction facts without allocating.
    pub fn matches(&self, tx: &Transaction) -> bool {
        match self.operator {
            RuleConditionsOperator::And => self
                .conditions
                .iter()
                .all(|condition| condition.matches(tx)),
            RuleConditionsOperator::Or => self
                .conditions
                .iter()
                .any(|condition| condition.matches(tx)),
        }
    }
}

fn has_only_keys(object: &serde_json::Map<String, serde_json::Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn has_no_effective_options(options: Option<&serde_json::Value>) -> bool {
    match options {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::Object(options)) => options.is_empty(),
        Some(_) => false,
    }
}

fn string_list(value: &serde_json::Value) -> Option<Vec<String>> {
    let values = value.as_array()?;
    if values.is_empty() {
        return None;
    }
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .collect()
}

fn parse_rule_condition(value: &serde_json::Value) -> Option<RuleCondition> {
    let condition = value.as_object()?;
    if !has_only_keys(condition, &["op", "field", "value", "type", "options"])
        || !has_no_effective_options(condition.get("options"))
    {
        return None;
    }
    let field_name = condition.get("field")?.as_str()?;
    let (field, expected_type) = match field_name {
        "payee_name" => (RuleConditionField::PayeeName, "string"),
        "payee" => (RuleConditionField::PayeeId, "id"),
        "account" => (RuleConditionField::AccountId, "id"),
        "category" => (RuleConditionField::CategoryId, "id"),
        _ => return None,
    };
    if condition
        .get("type")
        .is_some_and(|value| value.as_str() != Some(expected_type))
    {
        return None;
    }
    let operator = condition.get("op")?.as_str()?;
    let raw_value = condition.get("value")?;
    let value = match (field, operator, raw_value) {
        (RuleConditionField::PayeeName, "is", serde_json::Value::String(value))
            if !value.is_empty() =>
        {
            RuleConditionValue::String(value.clone())
        }
        (RuleConditionField::PayeeId, "is", serde_json::Value::String(value))
        | (RuleConditionField::AccountId, "is", serde_json::Value::String(value))
        | (RuleConditionField::CategoryId, "is", serde_json::Value::String(value))
            if !value.is_empty() =>
        {
            RuleConditionValue::String(value.clone())
        }
        (RuleConditionField::PayeeId, "is", serde_json::Value::Null)
        | (RuleConditionField::CategoryId, "is", serde_json::Value::Null) => {
            RuleConditionValue::Null
        }
        (RuleConditionField::AccountId | RuleConditionField::CategoryId, "oneOf", values) => {
            RuleConditionValue::Strings(string_list(values)?)
        }
        _ => return None,
    };
    Some(RuleCondition { field, value })
}

/// Return whether an Actual rule's normalized trigger matches transaction facts.
///
/// The supported subset is exact payee-name or payee-ID matching, plus scalar
/// or `oneOf` account/category IDs. Missing or unsupported trigger data returns
/// `None`; callers must not treat it as a match. This checks conditions only,
/// not rule activity or actions.
pub fn actual_rule_conditions_match(trigger: &serde_json::Value, tx: &Transaction) -> Option<bool> {
    ActualRuleConditions::parse(trigger).map(|conditions| conditions.matches(tx))
}

fn equals_case_insensitively(left: &str, right: &str) -> bool {
    left.chars()
        .flat_map(char::to_lowercase)
        .eq(right.chars().flat_map(char::to_lowercase))
}

fn parse_category_actions(actions: &serde_json::Value) -> Option<Vec<&str>> {
    let actions = actions.as_array()?;
    if actions.is_empty() {
        return None;
    }
    let mut target_ids = Vec::new();
    for action in actions {
        let action = action.as_object()?;
        if !has_only_keys(action, &["op", "field", "value", "type", "options"])
            || !has_no_effective_options(action.get("options"))
            || action
                .get("type")
                .is_some_and(|value| value.as_str() != Some("id"))
            || action.get("op")?.as_str()? != "set"
            || action.get("field")?.as_str()? != "category"
        {
            return None;
        }
        let value = action.get("value")?.as_str()?;
        if value.is_empty() {
            return None;
        }
        target_ids.push(value);
    }
    Some(target_ids)
}

fn unique_live_category<'a>(categories: &'a [Category], id: &str) -> Option<&'a Category> {
    let mut found = None;
    for category in categories.iter().filter(|category| category.id == id) {
        if category.deleted || found.is_some() {
            return None;
        }
        found = Some(category);
    }
    found
}

struct SupportedCategoryRule<'rule, 'category> {
    id: &'rule str,
    category: &'category Category,
    conditions: ActualRuleConditions,
}

fn compile_category_rule<'rule, 'category>(
    rule: &'rule Rule,
    categories: &'category [Category],
) -> Option<SupportedCategoryRule<'rule, 'category>> {
    if rule.inactive || rule.id.is_empty() {
        return None;
    }
    let conditions = ActualRuleConditions::parse(&rule.trigger)?;
    let mut category = None;
    for target_id in parse_category_actions(&rule.actions)? {
        category = Some(unique_live_category(categories, target_id)?);
    }
    let category = category?;
    Some(SupportedCategoryRule {
        id: &rule.id,
        category,
        conditions,
    })
}

fn classify_actual_category_rules(
    tx: &Transaction,
    rules: &[SupportedCategoryRule<'_, '_>],
) -> Option<CategorizationCandidate> {
    let mut category = None;
    let mut rule_ids = Vec::new();
    for rule in rules {
        if !rule.conditions.matches(tx) {
            continue;
        }
        if category.is_some_and(|selected: &Category| selected.id != rule.category.id) {
            return None;
        }
        category = Some(rule.category);
        rule_ids.push(rule.id.to_owned());
    }
    let category = category?;
    rule_ids.sort_unstable();
    rule_ids.dedup();
    Some(CategorizationCandidate {
        transaction_id: tx.id.clone(),
        amount: tx.amount.clone(),
        payee_name: tx.payee_name.clone(),
        date: tx.date.clone(),
        reasons: vec![Evidence::new(
            EvidenceKind::AutomationRule,
            "Matched enabled Actual category-setting rule(s)",
        )],
        proposed_category_id: Some(category.id.clone()),
        proposed_category_name: Some(category.name.clone()),
        rule_ids: Some(rule_ids),
    })
}

// ponytail: support payee_name/payee `is` plus account/category `is`/`oneOf`,
// with pure category-set actions only; unsupported Actual shapes safely fall
// back to existing payee/history classifiers, not a full Actual rule engine.
pub(crate) fn find_candidates_with_rules(
    transactions: &[Transaction],
    payees: &[Payee],
    history: &[HistoryRecord],
    categories: &[Category],
    rules: &[Rule],
) -> Vec<CategorizationCandidate> {
    let supported_rules: Vec<_> = rules
        .iter()
        .filter_map(|rule| compile_category_rule(rule, categories))
        .collect();
    let mut candidates = Vec::new();
    for tx in transactions {
        if tx.category_id.is_some() && tx.category_id.as_deref() != Some("") {
            continue;
        }
        if let Some(candidate) = classify_actual_category_rules(tx, &supported_rules) {
            candidates.push(candidate);
        } else if let Some(candidate) = classify_exact_match(tx, payees) {
            candidates.push(candidate);
        } else if let Some(candidate) = classify_historical(tx, history) {
            candidates.push(candidate);
        }
    }
    candidates
}

// ---------------------------------------------------------------------------
// Composite finder
// ---------------------------------------------------------------------------

/// Run all categorization classifiers in priority order and return the
/// strongest match per transaction.  Exact-payee matches take precedence
/// over historical matches.
pub fn find_candidates(
    transactions: &[Transaction],
    payees: &[Payee],
    history: &[HistoryRecord],
) -> Vec<CategorizationCandidate> {
    find_candidates_with_rules(transactions, payees, history, &[], &[])
}

// ---------------------------------------------------------------------------
// CandidateStatus
// ---------------------------------------------------------------------------

/// Whether a categorization candidate has been fully resolved by deterministic
/// layers (Rust classifiers) or remains unresolved and eligible for provider
/// inference (TypeScript).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CandidateStatus {
    /// Candidate has sufficient deterministic evidence — no inference needed.
    Resolved,
    /// Candidate lacks deterministic resolution — eligible for TS provider inference.
    Unresolved,
}

impl CategorizationCandidate {
    /// Returns whether this candidate's strongest evidence resolves it
    /// deterministically. Only [`Unresolved`](CandidateStatus::Unresolved)
    /// candidates qualify for TypeScript provider inference.
    ///
    /// Evidence is ranked by priority: AutomationRule > ExactPayee > Historical
    /// > AmountPattern > ImportMatch.
    pub fn eligibility(&self) -> CandidateStatus {
        let has_deterministic = self.reasons.iter().any(|e| {
            matches!(
                e.kind,
                EvidenceKind::AutomationRule | EvidenceKind::ExactPayee | EvidenceKind::Historical
            )
        });
        if has_deterministic {
            CandidateStatus::Resolved
        } else {
            CandidateStatus::Unresolved
        }
    }
}

// ---------------------------------------------------------------------------
// InferencePolicy
// ---------------------------------------------------------------------------

/// Privacy and locality policy for inference providers.
///
/// Controls which providers may be used for each capability
/// (classification, merchant research, conversation, telemetry).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum InferencePolicy {
    /// Capability is disabled entirely; no provider calls are allowed.
    #[serde(rename = "disabled")]
    Disabled,
    /// Only local (on-device / same-process) providers are allowed.
    #[serde(rename = "localOnly")]
    LocalOnly,
    /// External / remote providers are also allowed.
    #[serde(rename = "externalAllowed")]
    ExternalAllowed,
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/// Provenance metadata attached to a suggestion, recording origin,
/// integrity, and version chain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// Hash of the suggestion payload for integrity verification.
    pub payload_hash: String,
    /// Inference provider identifier (e.g. "openai", "local").
    pub provider: Option<String>,
    /// Model identifier used for inference.
    pub model: Option<String>,
    /// Version of the prompt template used.
    pub prompt_version: Option<String>,
    /// Version of the inference policy document at time of creation.
    pub inference_policy_version: Option<String>,
    /// ISO-8601 timestamp of suggestion creation.
    pub created_at: String,
    /// Identifier of the originating actor (user or system).
    pub actor_id: Option<String>,
}
