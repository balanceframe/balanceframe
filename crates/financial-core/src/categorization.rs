use crate::merchant_intelligence::{
    MerchantNativeRuleBlock, MerchantNativeRulePart, MerchantNativeRuleSet,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet};
use std::sync::Arc;

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
    /// Index into the owning analysis result's complete native rule sets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_set_index: Option<u32>,
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
        rule_set_index: None,
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
        rule_set_index: None,
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

// Legacy rules fold scalar characters; merchant rules retain contextual str folding.
fn legacy_rule_name(value: &str) -> String {
    value.chars().flat_map(char::to_lowercase).collect()
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

pub(crate) struct CompiledCategoryBlock<'a> {
    pub(crate) category: &'a str,
    category_name: &'a str,
    conditions: Vec<(usize, Vec<usize>)>,
    and: bool,
    pub(crate) rule_ids: Arc<[String]>,
}

const NO_PART: usize = usize::MAX;
const EVIDENCE_LIMIT: usize = 100;

fn retain_smallest<'ids>(
    queue: &mut BinaryHeap<(&'ids str, usize, usize)>,
    entry: (&'ids str, usize, usize),
    cap: usize,
) {
    if queue.len() < cap {
        queue.push(entry);
    } else if queue.peek().is_some_and(|largest| entry.0 < largest.0) {
        queue.pop();
        queue.push(entry);
    }
}

#[derive(Clone, Copy, Default)]
struct MatchSummary<'a> {
    category: Option<&'a str>,
    conflict: bool,
    count: u32,
}
impl<'a> MatchSummary<'a> {
    fn add(&mut self, category: &'a str, count: u32) {
        if self.category.is_some_and(|old| old != category) {
            self.conflict = true;
        }
        self.category.get_or_insert(category);
        self.count = self
            .count
            .checked_add(count)
            .expect("source support fits the existing u32 count contract");
    }
    fn merge(&mut self, other: Self) {
        if let Some(category) = other.category {
            self.add(category, other.count);
        }
        self.conflict |= other.conflict;
    }
}
struct SourcePart<'a> {
    indexes: Arc<[u32]>,
    summary: MatchSummary<'a>,
    categories: Option<BTreeMap<&'a str, u32>>,
    bits: Option<Vec<u64>>,
    sample: Vec<(usize, usize)>,
}
impl SourcePart<'_> {
    fn contains(&self, block: usize) -> bool {
        self.bits.as_ref().map_or_else(
            || self.indexes.binary_search(&(block as u32)).is_ok(),
            |bits| bits[block / 64] & (1u64 << (block % 64)) != 0,
        )
    }
    fn category_count(&self, category: &str) -> u32 {
        self.categories.as_ref().map_or_else(
            || {
                if self.summary.category == Some(category) {
                    self.summary.count
                } else {
                    0
                }
            },
            |counts| counts.get(category).copied().unwrap_or(0),
        )
    }
}
#[derive(Clone, Copy, Hash, PartialEq, Eq)]
struct SourceExpression {
    or: [usize; 4],
    and: [[usize; 2]; 4],
}
#[cfg(test)]
impl SourceExpression {
    fn references(&self) -> impl Iterator<Item = usize> + '_ {
        self.or
            .iter()
            .chain(self.and.iter().flatten())
            .copied()
            .filter(|index| *index != NO_PART)
    }
}
struct AndRoutes {
    mask: u8,
    buckets: HashMap<(usize, usize), Vec<usize>>,
    unary_parts: HashMap<(usize, usize), usize>,
}
// Four fields across fifteen nonempty field masks bound this merge at sixty
// source cursors. No candidate or matching-block vector is retained.
struct AndCandidates<'index> {
    routes: [Option<std::slice::Iter<'index, usize>>; 60],
}
impl Iterator for AndCandidates<'_> {
    type Item = usize;
    fn next(&mut self) -> Option<Self::Item> {
        let position = self
            .routes
            .iter()
            .enumerate()
            .filter_map(|(position, route)| {
                route
                    .as_ref()
                    .and_then(|route| route.as_slice().first())
                    .map(|block| (*block, position))
            })
            .min()?
            .1;
        self.routes[position].as_mut().unwrap().next().copied()
    }
}
/// Frozen source postings and necessary AND routes shared by both producers.
pub(crate) struct CategoryRuleIndex<'a> {
    pub(crate) blocks: Vec<CompiledCategoryBlock<'a>>,
    predicates: [HashMap<String, usize>; 4],
    or_parts: [Vec<usize>; 4],
    and_parts: [Vec<usize>; 4],
    wildcards: [usize; 4],
    parts: Vec<SourcePart<'a>>,
    part_contents: HashMap<Arc<[u32]>, usize>,
    category_parts: BTreeMap<&'a str, usize>,
    category_names: BTreeMap<&'a str, &'a str>,
    and_routes: Vec<AndRoutes>,
    pub(crate) unsupported: bool,
    #[cfg(test)]
    pub(crate) lookup_inspections: std::cell::Cell<usize>,
}
#[derive(Default)]
pub(crate) struct RuleMatchCache<'a> {
    matches: HashMap<[usize; 4], RuleMatches<'a>>,
    large: HashMap<[usize; 4], MatchSummary<'a>>,
    and: HashMap<(u8, [usize; 4]), MatchSummary<'a>>,
    marks: Vec<u32>,
    generation: u32,
    bitmap: Vec<u64>,
}
#[cfg(test)]
impl RuleMatchCache<'_> {
    pub(crate) fn retained_membership_entries(&self) -> usize {
        self.matches
            .values()
            .map(|matching| matching.expression.references().count())
            .sum::<usize>()
            + self
                .large
                .keys()
                .map(|key| key.iter().filter(|index| **index != NO_PART).count())
                .sum::<usize>()
            + self.marks.len()
            + self.bitmap.len()
    }
}
pub(crate) struct RuleMatches<'a> {
    expression: SourceExpression,
    key: [usize; 4],
    pub(crate) category: Option<&'a str>,
    pub(crate) conflict: bool,
    pub(crate) rule_count: u32,
    large_summary: MatchSummary<'a>,
    and_summary: MatchSummary<'a>,
}
#[derive(Default)]
pub(crate) struct NativeRuleSetRegistry {
    pub(crate) parts: Vec<MerchantNativeRulePart>,
    pub(crate) sets: Vec<MerchantNativeRuleSet>,
    part_indexes: HashMap<usize, u32>,
    indexes: HashMap<(SourceExpression, usize), u32>,
}
impl NativeRuleSetRegistry {
    fn part(&mut self, index: &CategoryRuleIndex<'_>, source: usize) -> u32 {
        *self.part_indexes.entry(source).or_insert_with(|| {
            let position = u32::try_from(self.parts.len()).expect("source part indexes fit u32");
            self.parts.push(MerchantNativeRulePart {
                block_indexes: Arc::clone(&index.parts[source].indexes),
            });
            position
        })
    }
    pub(crate) fn register(
        &mut self,
        index: &CategoryRuleIndex<'_>,
        matching: &RuleMatches<'_>,
        category: &str,
    ) -> Option<u32> {
        let category_part = *index.category_parts.get(category)?;
        let key = (matching.expression, category_part);
        if let Some(position) = self.indexes.get(&key) {
            return Some(*position);
        }
        if !index.has_category(matching, category) {
            return None;
        }
        let category_part_index = self.part(index, category_part);
        let mut or_part_indexes: Vec<_> = matching
            .expression
            .or
            .iter()
            .filter(|source| **source != NO_PART)
            .map(|source| self.part(index, *source))
            .collect();
        or_part_indexes.sort_unstable();
        let mut and_part_indexes = Vec::new();
        if matching.expression.and[0][0] != NO_PART {
            for operand in &matching.expression.and {
                let mut references: Vec<_> = operand
                    .iter()
                    .filter(|source| **source != NO_PART)
                    .map(|source| self.part(index, *source))
                    .collect();
                references.sort_unstable();
                and_part_indexes.push(references);
            }
        }
        let position = u32::try_from(self.sets.len()).expect("source set indexes fit u32");
        self.sets.push(MerchantNativeRuleSet {
            or_part_indexes,
            and_part_indexes,
            category_part_index,
        });
        self.indexes.insert(key, position);
        Some(position)
    }
}

impl<'a> CategoryRuleIndex<'a> {
    pub(crate) fn new(
        rules: &'a [Rule],
        categories: &HashMap<&str, &'a Category>,
        fold_name: fn(&str) -> String,
    ) -> Self {
        struct BuildingBlock<'a> {
            category: &'a Category,
            conditions: Vec<(usize, Vec<usize>)>,
            and: bool,
            ids: Vec<String>,
        }
        let mut result = Self {
            blocks: Vec::new(),
            predicates: std::array::from_fn(|_| HashMap::new()),
            or_parts: std::array::from_fn(|_| Vec::new()),
            and_parts: std::array::from_fn(|_| Vec::new()),
            wildcards: [NO_PART; 4],
            parts: Vec::new(),
            part_contents: HashMap::new(),
            category_parts: BTreeMap::new(),
            category_names: BTreeMap::new(),
            and_routes: Vec::new(),
            unsupported: false,
            #[cfg(test)]
            lookup_inspections: std::cell::Cell::new(0),
        };
        let mut building: Vec<BuildingBlock<'a>> = Vec::new();
        let mut groups = HashMap::new();
        let mut sources: Vec<_> = rules.iter().filter(|rule| !rule.inactive).collect();
        sources.sort_unstable_by(|a, b| a.id.cmp(&b.id));
        sources.dedup_by(|a, b| *a == *b);
        let conflicting: HashSet<_> = sources
            .windows(2)
            .filter(|pair| pair[0].id == pair[1].id)
            .map(|pair| pair[0].id.as_str())
            .collect();
        for source in sources {
            let compiled = (|| {
                if source.id.is_empty() || conflicting.contains(source.id.as_str()) {
                    return None;
                }
                let parsed = ActualRuleConditions::parse(&source.trigger)?;
                let mut category = None;
                for id in parse_category_actions(&source.actions)? {
                    category = Some(*categories.get(id)?);
                }
                Some((parsed, category?))
            })();
            let Some((parsed, category)) = compiled else {
                result.unsupported = true;
                continue;
            };
            let and = matches!(parsed.operator, RuleConditionsOperator::And);
            let mut fields: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
            for condition in parsed.conditions {
                let field = match condition.field {
                    RuleConditionField::PayeeId => 0,
                    RuleConditionField::PayeeName => 1,
                    RuleConditionField::AccountId => 2,
                    RuleConditionField::CategoryId => 3,
                };
                let values = match condition.value {
                    RuleConditionValue::String(value) => {
                        vec![if field == 1 { fold_name(&value) } else { value }]
                    }
                    RuleConditionValue::Strings(values) => values,
                    RuleConditionValue::Null => vec![String::new()],
                };
                let mut ids: Vec<_> = values
                    .into_iter()
                    .map(|value| {
                        let next = result.predicates[field].len() + 1;
                        *result.predicates[field].entry(value).or_insert(next)
                    })
                    .collect();
                ids.sort_unstable();
                ids.dedup();
                match fields.entry(field) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert(ids);
                    }
                    std::collections::btree_map::Entry::Occupied(mut entry) => {
                        if and {
                            entry.get_mut().retain(|id| ids.binary_search(id).is_ok());
                        } else {
                            entry.get_mut().extend(ids);
                            entry.get_mut().sort_unstable();
                            entry.get_mut().dedup();
                        }
                    }
                }
            }
            let conditions: Vec<_> = fields.into_iter().collect();
            let and = and || conditions.len() == 1;
            let key = (and, conditions, category.id.as_str());
            let block = *groups.entry(key).or_insert_with_key(|key| {
                let index = building.len();
                building.push(BuildingBlock {
                    category,
                    conditions: key.1.clone(),
                    and,
                    ids: Vec::new(),
                });
                index
            });
            building[block].ids.push(source.id.clone());
        }
        result.blocks = building
            .into_iter()
            .map(|block| CompiledCategoryBlock {
                category: &block.category.id,
                category_name: &block.category.name,
                conditions: block.conditions,
                and: block.and,
                rule_ids: Arc::from(block.ids),
            })
            .collect();
        let mut or: [Vec<Vec<u32>>; 4] =
            std::array::from_fn(|field| vec![Vec::new(); result.predicates[field].len()]);
        let mut and: [Vec<Vec<u32>>; 4] =
            std::array::from_fn(|field| vec![Vec::new(); result.predicates[field].len()]);
        let mut wildcards: [Vec<u32>; 4] = std::array::from_fn(|_| Vec::new());
        let mut categories: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
        for (position, block) in result.blocks.iter().enumerate() {
            let index = u32::try_from(position).expect("source block indexes fit u32");
            result
                .category_names
                .insert(block.category, block.category_name);
            categories.entry(block.category).or_default().push(index);
            if block.and
                && block
                    .conditions
                    .iter()
                    .any(|(_, alternatives)| alternatives.is_empty())
            {
                continue;
            }
            for field in 0..4 {
                if let Some((_, alternatives)) = block
                    .conditions
                    .iter()
                    .find(|(dimension, _)| *dimension == field)
                {
                    for bucket in alternatives {
                        if block.and {
                            and[field][*bucket - 1].push(index);
                        } else {
                            or[field][*bucket - 1].push(index);
                        }
                    }
                } else if block.and {
                    wildcards[field].push(index);
                }
            }
        }
        let mut routes: BTreeMap<u8, AndRoutes> = BTreeMap::new();
        for (position, block) in result
            .blocks
            .iter()
            .enumerate()
            .filter(|(_, block)| block.and)
        {
            if block
                .conditions
                .iter()
                .any(|(_, alternatives)| alternatives.is_empty())
            {
                continue;
            }
            let mask = block
                .conditions
                .iter()
                .fold(0u8, |mask, (field, _)| mask | (1 << field));
            let (field, alternatives) = block
                .conditions
                .iter()
                .min_by_key(|(field, alternatives)| {
                    alternatives
                        .iter()
                        .map(|bucket| and[*field][*bucket - 1].len())
                        .sum::<usize>()
                })
                .unwrap();
            let group = routes.entry(mask).or_insert_with(|| AndRoutes {
                mask,
                buckets: HashMap::new(),
                unary_parts: HashMap::new(),
            });
            for bucket in alternatives {
                group
                    .buckets
                    .entry((*field, *bucket))
                    .or_default()
                    .push(position);
            }
        }
        for mut group in routes.into_values() {
            if group.mask.is_power_of_two() {
                let field = group.mask.trailing_zeros() as usize;
                // Freeze in predicate order, not randomized HashMap iteration order.
                for bucket in 1..=result.predicates[field].len() {
                    if let Some(indexes) = group.buckets.get(&(field, bucket)) {
                        let part = result.intern_part(
                            indexes.iter().map(|index| *index as u32).collect(),
                            false,
                        );
                        group.unary_parts.insert((field, bucket), part);
                    }
                }
            }
            result.and_routes.push(group);
        }
        for field in 0..4 {
            result.or_parts[field] = std::mem::take(&mut or[field])
                .into_iter()
                .map(|indexes| result.intern_part(indexes, true))
                .collect();
            result.and_parts[field] = std::mem::take(&mut and[field])
                .into_iter()
                .map(|indexes| result.intern_part(indexes, false))
                .collect();
            result.wildcards[field] =
                result.intern_part(std::mem::take(&mut wildcards[field]), false);
        }
        for (category, indexes) in categories {
            let part = result.intern_part(indexes, false);
            result.category_parts.insert(category, part);
        }
        result
    }

    pub(crate) fn uses_payee_name(&self) -> bool {
        !self.predicates[1].is_empty()
    }

    fn intern_part(&mut self, indexes: Vec<u32>, is_or: bool) -> usize {
        if indexes.is_empty() {
            return NO_PART;
        }
        let position = if let Some(position) = self.part_contents.get(indexes.as_slice()) {
            *position
        } else {
            let indexes: Arc<[u32]> = Arc::from(indexes);
            let mut summary = MatchSummary::default();
            for index in indexes.iter() {
                let block = &self.blocks[*index as usize];
                summary.add(
                    block.category,
                    u32::try_from(block.rule_ids.len()).expect("source rule count fits u32"),
                );
            }
            let categories = summary.conflict.then(|| {
                let mut counts = BTreeMap::new();
                for index in indexes.iter() {
                    let block = &self.blocks[*index as usize];
                    *counts.entry(block.category).or_insert(0u32) += block.rule_ids.len() as u32;
                }
                counts
            });
            let position = self.parts.len();
            self.part_contents.insert(Arc::clone(&indexes), position);
            self.parts.push(SourcePart {
                indexes,
                summary,
                categories,
                bits: None,
                sample: Vec::new(),
            });
            position
        };
        if is_or && self.parts[position].sample.is_empty() {
            let mut queue = BinaryHeap::new();
            for index in self.parts[position].indexes.iter().copied() {
                for (offset, id) in self.blocks[index as usize]
                    .rule_ids
                    .iter()
                    .take(EVIDENCE_LIMIT)
                    .enumerate()
                {
                    retain_smallest(
                        &mut queue,
                        (id.as_str(), index as usize, offset),
                        EVIDENCE_LIMIT,
                    );
                }
            }
            self.parts[position].sample = queue
                .into_sorted_vec()
                .into_iter()
                .map(|(_, block, offset)| (block, offset))
                .collect();
            let words = self.blocks.len().div_ceil(64);
            // Merchant B<=100k makes every >1024-member OR part economical.
            // Wider generic legacy sources use sparse probes if dense storage would exceed 4x its source memberships.
            if self.parts[position].indexes.len() > 1024
                && words.saturating_mul(8) <= self.parts[position].indexes.len().saturating_mul(16)
            {
                let mut bits = vec![0u64; words];
                for index in self.parts[position].indexes.iter() {
                    bits[*index as usize / 64] |= 1 << (*index as usize % 64);
                }
                self.parts[position].bits = Some(bits);
            }
        }
        position
    }

    fn expression(&self, key: [usize; 4]) -> SourceExpression {
        let mut expression = SourceExpression {
            or: [NO_PART; 4],
            and: [[NO_PART; 2]; 4],
        };
        for (field, bucket_key) in key.iter().enumerate() {
            expression.or[field] = bucket_key
                .checked_sub(1)
                .map_or(NO_PART, |bucket| self.or_parts[field][bucket]);
            expression.and[field] = [
                self.wildcards[field],
                bucket_key
                    .checked_sub(1)
                    .map_or(NO_PART, |bucket| self.and_parts[field][bucket]),
            ];
            expression.and[field].sort_unstable();
            if expression.and[field][0] == expression.and[field][1] {
                expression.and[field][1] = NO_PART;
            }
        }
        expression.or.sort_unstable();
        for position in 1..4 {
            if expression.or[position] == expression.or[position - 1] {
                // Deduplicate against every earlier field before canonical tail sorting.
                expression.or[position - 1] = NO_PART;
            }
        }
        expression.or.sort_unstable();
        if expression.and.iter().any(|operand| operand[0] == NO_PART) {
            expression.and = [[NO_PART; 2]; 4];
        }
        expression
    }

    pub(crate) fn cached_matches<'cache>(
        &self,
        values: [Option<&str>; 4],
        cache: &'cache mut RuleMatchCache<'a>,
    ) -> &'cache RuleMatches<'a> {
        let key: [usize; 4] = std::array::from_fn(|field| match values[field] {
            Some("") => 0,
            value => self.predicates[field]
                .get(value.unwrap_or(""))
                .copied()
                .unwrap_or(0),
        });
        let RuleMatchCache {
            matches,
            large,
            and,
            marks,
            generation,
            bitmap,
        } = cache;
        matches.entry(key).or_insert_with(|| {
            let expression = self.expression(key);
            let mut signature = expression.or;
            for part in &mut signature {
                if *part != NO_PART && self.parts[*part].indexes.len() <= 1024 {
                    *part = NO_PART;
                }
            }
            signature.sort_unstable();
            let large_summary = if signature[0] == NO_PART {
                MatchSummary::default()
            } else {
                *large.entry(signature).or_insert_with(|| {
                    if signature[1] == NO_PART {
                        return self.parts[signature[0]].summary;
                    }
                    bitmap.resize(self.blocks.len().div_ceil(64), 0);
                    bitmap.fill(0);
                    for part in signature.iter().filter(|part| **part != NO_PART) {
                        let part = &self.parts[*part];
                        if let Some(bits) = &part.bits {
                            for (target, source) in bitmap.iter_mut().zip(bits) {
                                *target |= source;
                            }
                        } else {
                            for index in part.indexes.iter() {
                                bitmap[*index as usize / 64] |= 1 << (*index as usize % 64);
                            }
                        }
                    }
                    let mut summary = MatchSummary::default();
                    for (word, mut bits) in bitmap.iter().copied().enumerate() {
                        while bits != 0 {
                            let block = &self.blocks[word * 64 + bits.trailing_zeros() as usize];
                            summary.add(block.category, block.rule_ids.len() as u32);
                            bits &= bits - 1;
                        }
                    }
                    summary
                })
            };
            let mut summary = large_summary;
            marks.resize(self.blocks.len(), 0);
            *generation = generation.wrapping_add(1);
            if *generation == 0 {
                marks.fill(0);
                *generation = 1;
            }
            for part in expression
                .or
                .iter()
                .filter(|part| **part != NO_PART && self.parts[**part].indexes.len() <= 1024)
            {
                for index in self.parts[*part].indexes.iter().copied() {
                    let index = index as usize;
                    if marks[index] == *generation
                        || signature
                            .iter()
                            .any(|part| *part != NO_PART && self.parts[*part].contains(index))
                    {
                        continue;
                    }
                    marks[index] = *generation;
                    let block = &self.blocks[index];
                    summary.add(block.category, block.rule_ids.len() as u32);
                }
            }
            // Blocks belong to exactly one AND field-mask group and one necessary route.
            // Ignore irrelevant dimensions in these scalar caches, never retaining matches.
            let mut and_summary = MatchSummary::default();
            for group in &self.and_routes {
                let relevant = std::array::from_fn(|field| {
                    if group.mask & (1 << field) != 0 {
                        key[field]
                    } else {
                        0
                    }
                });
                let selected = *and.entry((group.mask, relevant)).or_insert_with(|| {
                    if group.mask.is_power_of_two() {
                        let field = group.mask.trailing_zeros() as usize;
                        return group
                            .unary_parts
                            .get(&(field, relevant[field]))
                            .map_or_else(MatchSummary::default, |part| self.parts[*part].summary);
                    }
                    let mut summary = MatchSummary::default();
                    for (field, bucket) in relevant
                        .iter()
                        .enumerate()
                        .filter(|(_, bucket)| **bucket != 0)
                    {
                        if let Some(candidates) = group.buckets.get(&(field, *bucket)) {
                            for index in candidates {
                                #[cfg(test)]
                                self.lookup_inspections
                                    .set(self.lookup_inspections.get() + 1);
                                let block = &self.blocks[*index];
                                if block.conditions.iter().all(|(field, alternatives)| {
                                    alternatives.binary_search(&key[*field]).is_ok()
                                }) {
                                    summary.add(block.category, block.rule_ids.len() as u32);
                                }
                            }
                        }
                    }
                    summary
                });
                summary.merge(selected);
                and_summary.merge(selected);
            }
            RuleMatches {
                expression,
                key,
                category: summary.category,
                conflict: summary.conflict,
                rule_count: summary.count,
                large_summary,
                and_summary,
            }
        })
    }

    fn and_candidates<'index>(
        &'index self,
        matching: &RuleMatches<'a>,
        complex_only: bool,
    ) -> AndCandidates<'index> {
        let mut routes = std::array::from_fn(|_| None);
        let mut position = 0;
        for group in &self.and_routes {
            if complex_only && group.mask.is_power_of_two() {
                continue;
            }
            for (field, bucket) in matching
                .key
                .iter()
                .enumerate()
                .filter(|(_, bucket)| **bucket != 0)
            {
                if let Some(candidates) = group.buckets.get(&(field, *bucket)) {
                    routes[position] = Some(candidates.iter());
                    position += 1;
                }
            }
        }
        AndCandidates { routes }
    }

    fn matching_and_blocks<'index>(
        &'index self,
        matching: &'index RuleMatches<'a>,
        complex_only: bool,
    ) -> impl Iterator<Item = usize> + 'index {
        self.and_candidates(matching, complex_only)
            .filter(move |index| {
                #[cfg(test)]
                self.lookup_inspections
                    .set(self.lookup_inspections.get() + 1);
                self.blocks[*index]
                    .conditions
                    .iter()
                    .all(|(field, alternatives)| {
                        alternatives.binary_search(&matching.key[*field]).is_ok()
                    })
            })
    }

    fn unary_and_parts<'index>(
        &'index self,
        matching: &RuleMatches<'a>,
    ) -> impl Iterator<Item = &'index SourcePart<'a>> + 'index {
        let key = matching.key;
        self.and_routes
            .iter()
            .filter(|group| group.mask.is_power_of_two())
            .filter_map(move |group| {
                let field = group.mask.trailing_zeros() as usize;
                group
                    .unary_parts
                    .get(&(field, key[field]))
                    .map(|part| &self.parts[*part])
            })
    }

    pub(crate) fn has_category(&self, matching: &RuleMatches<'a>, category: &str) -> bool {
        if matching.rule_count == 0 {
            return false;
        }
        if !matching.conflict {
            return matching.category == Some(category);
        }
        if matching.expression.or.iter().any(|part| {
            *part != NO_PART && {
                let part = &self.parts[*part];
                part.categories
                    .as_ref()
                    .map_or(part.summary.category == Some(category), |counts| {
                        counts.contains_key(category)
                    })
            }
        }) {
            return true;
        }
        if !matching.and_summary.conflict {
            return matching.and_summary.category == Some(category);
        }
        self.unary_and_parts(matching)
            .any(|part| part.category_count(category) > 0)
            || self
                .matching_and_blocks(matching, true)
                .any(|block| self.blocks[block].category == category)
    }

    pub(crate) fn category_count(&self, matching: &RuleMatches<'a>, category: &str) -> u32 {
        if !matching.conflict {
            return if matching.category == Some(category) {
                matching.rule_count
            } else {
                0
            };
        }
        let mut large = matching.expression.or;
        for part in &mut large {
            if *part != NO_PART && self.parts[*part].indexes.len() <= 1024 {
                *part = NO_PART;
            }
        }
        large.sort_unstable();
        let mut count = if large[0] != NO_PART && large[1] == NO_PART {
            let part = &self.parts[large[0]];
            part.categories.as_ref().map_or_else(
                || {
                    if part.summary.category == Some(category) {
                        part.summary.count
                    } else {
                        0
                    }
                },
                |counts| counts.get(category).copied().unwrap_or(0),
            )
        } else if !matching.large_summary.conflict {
            if matching.large_summary.category == Some(category) {
                matching.large_summary.count
            } else {
                0
            }
        } else {
            self.category_parts.get(category).map_or(0, |part| {
                self.parts[*part]
                    .indexes
                    .iter()
                    .filter(|block| {
                        large.iter().any(|part| {
                            *part != NO_PART && self.parts[*part].contains(**block as usize)
                        })
                    })
                    .map(|block| self.blocks[*block as usize].rule_ids.len() as u32)
                    .sum()
            })
        };
        for (position, part) in matching
            .expression
            .or
            .iter()
            .copied()
            .enumerate()
            .filter(|(_, part)| *part != NO_PART && self.parts[*part].indexes.len() <= 1024)
        {
            for block in self.parts[part].indexes.iter().copied() {
                let block = block as usize;
                if self.blocks[block].category != category
                    || large
                        .iter()
                        .any(|part| *part != NO_PART && self.parts[*part].contains(block))
                    || matching.expression.or[..position].iter().any(|previous| {
                        *previous != NO_PART
                            && self.parts[*previous].indexes.len() <= 1024
                            && self.parts[*previous].contains(block)
                    })
                {
                    continue;
                }
                count += self.blocks[block].rule_ids.len() as u32;
            }
        }
        count
            + if !matching.and_summary.conflict {
                if matching.and_summary.category == Some(category) {
                    matching.and_summary.count
                } else {
                    0
                }
            } else {
                self.unary_and_parts(matching)
                    .map(|part| part.category_count(category))
                    .sum::<u32>()
                    + self
                        .matching_and_blocks(matching, true)
                        .filter(|block| self.blocks[*block].category == category)
                        .map(|block| self.blocks[block].rule_ids.len() as u32)
                        .sum::<u32>()
            }
    }

    pub(crate) fn matching_categories(
        &self,
        matching: &RuleMatches<'a>,
        cap: usize,
    ) -> Vec<&'a str> {
        let mut categories = BTreeSet::new();
        let mut insert = |category| {
            if cap == 0 {
                return;
            }
            if categories.len() < cap || categories.last().is_some_and(|last| category < *last) {
                categories.insert(category);
                if categories.len() > cap {
                    categories.pop_last();
                }
            }
        };
        for part in matching
            .expression
            .or
            .iter()
            .filter(|part| **part != NO_PART)
        {
            let part = &self.parts[*part];
            if let Some(counts) = &part.categories {
                for category in counts.keys().copied().take(cap) {
                    insert(category);
                }
            } else if let Some(category) = part.summary.category {
                insert(category);
            }
        }
        if !matching.and_summary.conflict {
            if let Some(category) = matching.and_summary.category {
                insert(category);
            }
        } else {
            for part in self.unary_and_parts(matching) {
                if let Some(counts) = &part.categories {
                    for category in counts.keys().copied().take(cap) {
                        insert(category);
                    }
                } else if let Some(category) = part.summary.category {
                    insert(category);
                }
            }
            for block in self.matching_and_blocks(matching, true) {
                insert(self.blocks[block].category);
            }
        }
        categories.into_iter().collect()
    }

    pub(crate) fn category_name(&self, category: &str) -> &str {
        self.category_names[category]
    }

    pub(crate) fn native_blocks(&self) -> Vec<MerchantNativeRuleBlock> {
        self.blocks
            .iter()
            .map(|block| MerchantNativeRuleBlock {
                rule_ids: Arc::clone(&block.rule_ids),
            })
            .collect()
    }

    pub(crate) fn bounded_evidence(
        &self,
        matching: &RuleMatches<'a>,
        cap: usize,
    ) -> Vec<(usize, usize)> {
        if cap == 0 || matching.rule_count == 0 {
            return Vec::new();
        }
        let mut queue = BinaryHeap::new();
        // Source blocks and each necessary route are ordered by minimum scalar ID.
        // Merge routes before stopping; a multi-ID block's tail may interleave later blocks.
        for (position, part) in matching
            .expression
            .or
            .iter()
            .enumerate()
            .filter(|(_, part)| **part != NO_PART)
        {
            for &(index, offset) in self.parts[*part].sample.iter().take(cap) {
                if matching.expression.or[..position]
                    .iter()
                    .any(|previous| *previous != NO_PART && self.parts[*previous].contains(index))
                {
                    continue;
                }
                retain_smallest(
                    &mut queue,
                    (self.blocks[index].rule_ids[offset].as_str(), index, offset),
                    cap,
                );
            }
        }
        for index in self.and_candidates(matching, false) {
            #[cfg(test)]
            self.lookup_inspections
                .set(self.lookup_inspections.get() + 1);
            let block = &self.blocks[index];
            if queue.len() == cap && block.rule_ids[0].as_str() >= queue.peek().unwrap().0 {
                break;
            }
            if !block.conditions.iter().all(|(field, alternatives)| {
                alternatives.binary_search(&matching.key[*field]).is_ok()
            }) {
                continue;
            }
            for (offset, id) in block.rule_ids.iter().take(cap).enumerate() {
                if queue.len() == cap && id.as_str() >= queue.peek().unwrap().0 {
                    break;
                }
                retain_smallest(&mut queue, (id.as_str(), index, offset), cap);
            }
        }
        queue
            .into_sorted_vec()
            .into_iter()
            .map(|(_, index, offset)| (index, offset))
            .collect()
    }
}

// Unsupported Actual shapes retain exact-payee/history fallback, never approximate matching.
pub(crate) fn find_candidates_with_rules(
    transactions: &[Transaction],
    payees: &[Payee],
    history: &[HistoryRecord],
    categories: &[Category],
    rules: &[Rule],
) -> (
    Vec<CategorizationCandidate>,
    Vec<MerchantNativeRuleBlock>,
    Vec<MerchantNativeRulePart>,
    Vec<MerchantNativeRuleSet>,
) {
    if rules.is_empty() {
        return (
            find_candidates(transactions, payees, history),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        );
    }
    let mut unique = HashMap::new();
    let mut duplicate = HashSet::new();
    for category in categories {
        if unique.insert(category.id.as_str(), category).is_some() {
            duplicate.insert(category.id.as_str());
        }
    }
    unique.retain(|id, category| !category.deleted && !duplicate.contains(id));
    let index = CategoryRuleIndex::new(rules, &unique, legacy_rule_name);
    let mut cache = RuleMatchCache::default();
    let mut lower_names = HashMap::new();
    let mut sets = NativeRuleSetRegistry::default();
    let mut ordered: Vec<_> = transactions.iter().collect();
    ordered.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    let mut candidates = Vec::new();
    for tx in ordered {
        if tx.category_id.is_some() && tx.category_id.as_deref() != Some("") {
            continue;
        }
        let name = tx
            .payee_name
            .as_deref()
            .filter(|_| index.uses_payee_name())
            .map(|raw| {
                lower_names
                    .entry(raw)
                    .or_insert_with(|| legacy_rule_name(raw))
                    .as_str()
            });
        let matching = index.cached_matches(
            [
                tx.payee_id.as_deref(),
                name,
                Some(tx.account_id.as_str()),
                tx.category_id.as_deref(),
            ],
            &mut cache,
        );
        if let Some(category) = matching.category.filter(|_| !matching.conflict) {
            candidates.push(CategorizationCandidate {
                transaction_id: tx.id.clone(),
                amount: tx.amount.clone(),
                payee_name: tx.payee_name.clone(),
                date: tx.date.clone(),
                reasons: vec![Evidence::new(
                    EvidenceKind::AutomationRule,
                    "Matched enabled Actual category-setting rule(s)",
                )],
                proposed_category_id: Some(category.into()),
                proposed_category_name: Some(index.category_name(category).into()),
                rule_set_index: sets.register(&index, matching, category),
            });
        } else if let Some(candidate) = classify_exact_match(tx, payees) {
            candidates.push(candidate);
        } else if let Some(candidate) = classify_historical(tx, history) {
            candidates.push(candidate);
        }
    }
    (candidates, index.native_blocks(), sets.parts, sets.sets)
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
    transactions
        .iter()
        .filter(|tx| tx.category_id.is_none() || tx.category_id.as_deref() == Some(""))
        .filter_map(|tx| {
            classify_exact_match(tx, payees).or_else(|| classify_historical(tx, history))
        })
        .collect()
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
