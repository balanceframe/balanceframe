//! Versioned local merchant evidence over an already-authorized immutable capture.
//!
//! Civil dates stay civil. Suggestions are evidence, never permission to write a ledger.
#![forbid(unsafe_code)]

use crate::categorization::{
    CategoryRuleIndex as RuleIndex, NativeRuleSetRegistry, RuleMatchCache, RuleMatches,
};
use crate::liquidity::{ScheduleLiquidityFact, ScheduleRecurrence};
use crate::{Category, Money, Payee, Rule};
use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde::{de, Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io;
use std::rc::Rc;
use std::sync::Arc;
use thiserror::Error;

const MAX_TRANSACTIONS: usize = 250_000;
const MAX_TEXT: usize = 4096;
const THRESHOLD_VERSION: &str = "merchant-thresholds/1";

/// A bounded input or computation failure; no source text is placed in errors.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum MerchantAnalysisError {
    /// Malformed, unsupported, or inconsistent admitted input.
    #[error("invalid merchant input: {0}")]
    InvalidInput(&'static str),
    /// Two records claim the same source identity with different facts.
    #[error("conflicting merchant source identity")]
    ConflictingSourceId,
}

fn require(valid: bool, code: &'static str) -> Result<(), MerchantAnalysisError> {
    if valid {
        Ok(())
    } else {
        Err(MerchantAnalysisError::InvalidInput(code))
    }
}
fn id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
}
fn optional_id(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(id)
}
fn text(value: &str) -> bool {
    value.len() <= MAX_TEXT
}
fn date(value: &str) -> Result<NaiveDate, MerchantAnalysisError> {
    let bytes = value.as_bytes();
    require(
        bytes.len() == 10
            && bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit()),
        "civil_date",
    )?;
    let parsed = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| MerchantAnalysisError::InvalidInput("civil_date"))?;
    require((1..=9999).contains(&parsed.year()), "civil_date")?;
    Ok(parsed)
}
fn timestamp(value: &str) -> bool {
    if !value.is_ascii() || !(20..=35).contains(&value.len()) {
        return false;
    }
    let bytes = value.as_bytes();
    if date(&value[..10]).is_err()
        || !matches!(bytes[10], b'T' | b't')
        || bytes[13] != b':'
        || bytes[16] != b':'
        || [11, 12, 14, 15, 17, 18]
            .iter()
            .any(|index| !bytes[*index].is_ascii_digit())
        || &value[11..13] > "23"
        || &value[14..16] > "59"
        || &value[17..19] > "59"
    {
        return false;
    }
    let mut suffix = &value[19..];
    if let Some(fraction) = suffix.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if !(1..=9).contains(&digits) {
            return false;
        }
        suffix = &fraction[digits..];
    }
    let zone = matches!(suffix, "Z" | "z")
        || (suffix.len() == 6
            && matches!(suffix.as_bytes()[0], b'+' | b'-')
            && suffix.as_bytes()[3] == b':'
            && [1, 2, 4, 5]
                .iter()
                .all(|index| suffix.as_bytes()[*index].is_ascii_digit())
            && &suffix[1..3] <= "23"
            && &suffix[4..6] <= "59");
    zone && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}
fn decimal(value: &str, positive: bool) -> bool {
    !value.is_empty()
        && value.bytes().all(|c| c.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
        && value
            .parse::<i128>()
            .is_ok_and(|n| n >= i128::from(positive))
}
fn currency(value: &str) -> bool {
    value.len() == 3 && value.bytes().all(|c| c.is_ascii_uppercase())
}
fn money_valid(value: &Money) -> bool {
    currency(value.currency())
}

// Each record has one strict wire shape and one validator, reused at serde and runtime
// boundaries. The local Wire contains typed fields, never a cloned serde_json::Value tree.
macro_rules! record {
    ($(#[$doc:meta])* $name:ident { $($(#[$attr:meta])* $field:ident : $ty:ty),* $(,)? } |$this:ident| $validate:block $(normalize |$normalized:ident| $normalize:block)?) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Serialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $($(#[$attr])* #[doc = stringify!($field)] pub $field: $ty),* }
        impl $name {
            fn validate(&$this) -> Result<(), MerchantAnalysisError> { let _ = $this; $validate }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Wire { $($(#[$attr])* $field: $ty),* }
                let wire = Wire::deserialize(deserializer)?;
                let value = Self { $($field: wire.$field),* };
                value.validate().map_err(de::Error::custom)?;
                $(let mut value = value; { let $normalized = &mut value; $normalize })?
                Ok(value)
            }
        }
    };
}
macro_rules! vocabulary {
    ($(#[$doc:meta])* $name:ident { $($variant:ident),+ $(,)? }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $(#[doc = stringify!($variant)] $variant),+ }
    };
}
vocabulary!(/// Source-field capability, not confidence.
    MerchantTextState { Unsupported, Unavailable, Absent, Empty, Present });
vocabulary!(/// Evidence authority; none represents verified financial execution.
    MerchantEvidenceTier { Confirmed, DeterministicMatch, Inferred, InsufficientData, Conflicting });
vocabulary!(/// Provenance class, kept distinct from proposals and execution.
    MerchantEvidenceKind { SourceObservation, NormalizedEvidence, ConfirmedDecision, NativeRule, SemanticSuggestion });
vocabulary!(/// An attributed alias decision.
    MerchantAliasState { Accepted, Rejected });
vocabulary!(/// An independently admitted correction's current state.
    MerchantCorrectionState { Confirmed, Revoked });
vocabulary!(/// The user's current pattern decision.
    MerchantPatternState { Accepted, Rejected, Revoked });
vocabulary!(/// Presentation state; rejection does not erase measured observations.
    MerchantDecisionState { Unreviewed, Accepted, Rejected });
vocabulary!(/// Explicit authoritative collection coverage.
    MerchantCollectionState { Complete, Partial, Unavailable });
vocabulary!(/// Whether source currency can be established.
    MerchantCurrencyState { Known, Unknown });
vocabulary!(/// Source admission's pending-activity capability.
    MerchantPendingState { Unsupported, Included, Excluded });
vocabulary!(/// Signed minor-unit direction; refunds never mix with outflows.
    MerchantDirection { Inflow, Outflow, Zero });
vocabulary!(/// Observed cadence, distinct from a declared source schedule.
    MerchantFrequency { Weekly, Biweekly, Monthly, Quarterly, Annual, Multiple, Irregular });
vocabulary!(/// Measured recurrence only; schedules have their own lossless output.
    MerchantRecurrenceKind { Observed });

record!(/// Scope supplied by the trusted source admission, never guessed from text.
MerchantScope { space_id: String, budget_id: String, connection_id: String } |self| {
    require(id(&self.space_id) && id(&self.budget_id) && id(&self.connection_id), "scope")
});
record!(/// Raw evidence with explicit capability/availability.
MerchantTextField { state: MerchantTextState, #[serde(deserialize_with = "read_nullable")] value: Option<String> } |self| {
    require(match self.state {
        MerchantTextState::Present => self.value.as_deref().is_some_and(|v| !v.is_empty() && text(v)),
        MerchantTextState::Empty => self.value.as_deref() == Some(""),
        MerchantTextState::Absent | MerchantTextState::Unsupported | MerchantTextState::Unavailable => self.value.is_none(),
    }, "source_field")
});

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoneyWire {
    minor_units: String,
    currency: String,
}
impl MoneyWire {
    fn into_money(self) -> Result<Money, MerchantAnalysisError> {
        let digits = self
            .minor_units
            .strip_prefix('-')
            .unwrap_or(&self.minor_units);
        require(
            !digits.is_empty()
                && digits.bytes().all(|c| c.is_ascii_digit())
                && (digits == "0" || !digits.starts_with('0'))
                && self.minor_units != "-0"
                && currency(&self.currency),
            "money",
        )?;
        let amount = self
            .minor_units
            .parse::<i64>()
            .map_err(|_| MerchantAnalysisError::InvalidInput("money_range"))?;
        Ok(Money::new(amount, self.currency))
    }
}
fn read_money<'de, D: Deserializer<'de>>(d: D) -> Result<Money, D::Error> {
    MoneyWire::deserialize(d)?
        .into_money()
        .map_err(de::Error::custom)
}
fn read_optional_money<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Money>, D::Error> {
    Option::<MoneyWire>::deserialize(d)?
        .map(MoneyWire::into_money)
        .transpose()
        .map_err(de::Error::custom)
}

record!(/// One flattened Actual source row; complete parent occurrences govern recurrence.
MerchantTransaction {
    id: String, account_id: String, date: String,
    #[serde(deserialize_with = "read_nullable")] payee_id: Option<String>,
    #[serde(deserialize_with = "read_nullable")] payee_name: Option<String>,
    #[serde(deserialize_with = "read_nullable")] category_id: Option<String>,
    #[serde(deserialize_with = "read_money")] amount: Money,
    cleared: bool, reconciled: bool, #[serde(deserialize_with = "read_nullable")] imported_id: Option<String>,
    imported_payee: MerchantTextField, description: MerchantTextField,
    verbose_title: MerchantTextField, notes: MerchantTextField,
    is_split_parent: bool, is_split_child: bool, #[serde(deserialize_with = "read_nullable")] parent_id: Option<String>,
    occurrence_id: String, occurrence_complete: bool, starting_balance: bool,
    #[serde(deserialize_with = "read_nullable")] transfer_account_id: Option<String>, deleted: bool, pending: bool
} |self| {
    require(id(&self.id) && id(&self.account_id) && id(&self.occurrence_id)
        && optional_id(&self.payee_id) && optional_id(&self.category_id)
        && optional_id(&self.imported_id) && optional_id(&self.parent_id)
        && optional_id(&self.transfer_account_id)
        && self.payee_name.as_deref().is_none_or(text) && money_valid(&self.amount), "transaction")?;
    date(&self.date)?;
    self.imported_payee.validate()?; self.description.validate()?;
    self.verbose_title.validate()?; self.notes.validate()?;
    let split_identity = if self.is_split_child {
        !self.is_split_parent && self.parent_id.as_deref() == Some(self.occurrence_id.as_str())
    } else {
        self.parent_id.is_none() && self.occurrence_id == self.id
    };
    require(split_identity, "split_identity")
});
record!(/// Scoped, attributed source-field mapping; it cannot replace a native payee ID.
MerchantAlias {
    id: String, source_text: String, source_field: String, target_payee_id: String,
    #[serde(deserialize_with = "read_nullable")] account_id: Option<String>, state: MerchantAliasState, actor_id: String,
    version: u32, updated_at: String, source_transaction_ids: Vec<String>
} |self| {
    require(id(&self.id) && !self.source_text.is_empty() && text(&self.source_text)
        && matches!(self.source_field.as_str(), "payeeName" | "importedPayee" | "description" | "verboseTitle" | "notes")
        && id(&self.target_payee_id) && optional_id(&self.account_id) && id(&self.actor_id)
        && self.version > 0 && timestamp(&self.updated_at)
        && self.source_transaction_ids.len() <= 1000 && self.source_transaction_ids.iter().all(|v| id(v)), "alias")
});
record!(/// Verified user evidence, not an approval assumed to have executed.
MerchantCorrection {
    transaction_id: String, #[serde(deserialize_with = "read_nullable")] payee_id: Option<String>, account_id: String,
    category_id: String, state: MerchantCorrectionState, verified: bool,
    actor_id: String, version: u32
} |self| {
    require(id(&self.transaction_id) && optional_id(&self.payee_id) && id(&self.account_id)
        && id(&self.category_id) && id(&self.actor_id) && self.version > 0, "correction")
});
record!(/// A selected public holiday, not evidence a particular bank was closed.
MerchantHoliday { date: String, name: String } |self| {
    date(&self.date)?; require(!self.name.is_empty() && text(&self.name), "holiday")
});
record!(/// Offline calendar selected explicitly for an account or budget.
MerchantCalendar {
    #[serde(deserialize_with = "read_nullable")] account_id: Option<String>, jurisdiction: String,
    #[serde(deserialize_with = "read_nullable")] subdivision: Option<String>,
    time_zone: String, version: String, coverage_start: String, coverage_end: String,
    holidays: Vec<MerchantHoliday>
} |self| {
    require(optional_id(&self.account_id) && id(&self.jurisdiction) && optional_id(&self.subdivision)
        && id(&self.time_zone) && id(&self.version) && self.holidays.len() <= 36600, "calendar")?;
    require(date(&self.coverage_start)? <= date(&self.coverage_end)?, "calendar_coverage")?;
    for holiday in &self.holidays { holiday.validate()?; }
    Ok(())
});
record!(/// An account's authorized source coverage, independent of inferred features.
MerchantAccountCoverage {
    account_id: String, state: MerchantCollectionState, start_date: String,
    end_date: String, currency_state: MerchantCurrencyState
} |self| {
    require(id(&self.account_id) && date(&self.start_date)? <= date(&self.end_date)?, "account_coverage")
});
record!(/// Completeness of each authoritative source collection.
    MerchantCollections {
        transactions: MerchantCollectionState, payees: MerchantCollectionState,
        categories: MerchantCollectionState, rules: MerchantCollectionState, schedules: MerchantCollectionState
    } |self| { Ok(()) });
record!(/// Full source dependency manifest retained for application reauthorization.
MerchantSourceAdmission {
    captured_at: String, facts_hash: String, expires_at: String, collections: MerchantCollections,
    account_coverage: Vec<MerchantAccountCoverage>, pending_state: MerchantPendingState,
    original_transaction_count: u32, truncated_count: u32, visibility_hash: String,
    source_account_ids: Vec<String>, source_category_ids: Vec<String>
} |self| {
    require(timestamp(&self.captured_at) && timestamp(&self.expires_at)
        && chrono::DateTime::parse_from_rfc3339(&self.expires_at).ok()
            > chrono::DateTime::parse_from_rfc3339(&self.captured_at).ok()
        && id(&self.facts_hash) && id(&self.visibility_hash)
        && self.truncated_count <= self.original_transaction_count
        && self.source_account_ids.len() <= 100000 && self.source_category_ids.len() <= 100000
        && self.source_account_ids.iter().chain(&self.source_category_ids).all(|v| id(v)), "source_admission")?;
    let mut accounts = BTreeSet::new();
    for coverage in &self.account_coverage {
        coverage.validate()?;
        require(accounts.insert(&coverage.account_id), "duplicate_account_coverage")?;
    }
    Ok(())
});
record!(/// Durable pattern user intent, separate from measurement revision.
MerchantPatternDecision {
    id: String, pattern_id: String, state: MerchantPatternState,
    actor_id: String, version: u32, updated_at: String
} |self| {
    require(id(&self.id) && id(&self.pattern_id) && id(&self.actor_id)
        && self.version > 0 && timestamp(&self.updated_at), "pattern_decision")
});

fn read_schedule<'de, D: Deserializer<'de>>(d: D) -> Result<ScheduleLiquidityFact, D::Error> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Wire {
        id: String,
        #[serde(deserialize_with = "read_nullable")]
        account_id: Option<String>,
        #[serde(deserialize_with = "read_nullable")]
        category_id: Option<String>,
        #[serde(deserialize_with = "read_nullable")]
        rule_id: Option<String>,
        #[serde(deserialize_with = "read_nullable")]
        due_date: Option<String>,
        certainty: crate::liquidity::ScheduleAmountCertainty,
        #[serde(deserialize_with = "read_optional_money")]
        amount: Option<Money>,
        #[serde(deserialize_with = "read_optional_money")]
        minimum: Option<Money>,
        #[serde(deserialize_with = "read_optional_money")]
        maximum: Option<Money>,
        #[serde(deserialize_with = "read_recurrence")]
        recurrence: Option<ScheduleRecurrence>,
    }
    let wire = Wire::deserialize(d)?;
    let source = ScheduleLiquidityFact {
        id: wire.id,
        account_id: wire.account_id,
        category_id: wire.category_id,
        rule_id: wire.rule_id,
        due_date: wire.due_date,
        certainty: wire.certainty,
        amount: wire.amount,
        minimum: wire.minimum,
        maximum: wire.maximum,
        recurrence: wire.recurrence,
    };
    validate_schedule(&source).map_err(de::Error::custom)?;
    Ok(source)
}
fn validate_schedule(source: &ScheduleLiquidityFact) -> Result<(), MerchantAnalysisError> {
    require(
        id(&source.id)
            && optional_id(&source.account_id)
            && optional_id(&source.category_id)
            && optional_id(&source.rule_id),
        "schedule",
    )?;
    if let Some(due) = &source.due_date {
        date(due)?;
    }
    for amount in [&source.amount, &source.minimum, &source.maximum]
        .into_iter()
        .flatten()
    {
        require(money_valid(amount), "schedule_money")?;
    }
    if let Some(recurrence) = &source.recurrence {
        date(&recurrence.start)?;
        if let Some(end) = &recurrence.end_date {
            date(end)?;
        }
        require(
            recurrence.patterns.as_ref().is_none_or(|v| v.len() <= 100),
            "schedule_patterns",
        )?;
    }
    Ok(())
}
record!(/// Lossless declared source expectation; never synthesized from occurrence count.
MerchantSchedule { #[serde(deserialize_with = "read_nullable")] payee_id: Option<String>,
    #[serde(deserialize_with = "read_schedule")] source: ScheduleLiquidityFact } |self| {
    require(optional_id(&self.payee_id), "schedule_payee")?; validate_schedule(&self.source)
});
record!(/// Explicit admitted candidate selection and exclusive actual-ID cursor.
MerchantSuggestionSelection { transaction_ids: Vec<String>,
    #[serde(deserialize_with = "read_nullable")] cursor: Option<String>, limit: u32 } |self| {
    require(self.transaction_ids.len() <= MAX_TRANSACTIONS && self.transaction_ids.iter().all(|v| id(v))
        && optional_id(&self.cursor) && (1..=1000).contains(&self.limit), "suggestion_selection")
});
record!(/// Authorized, immutable request; absent selection preserves the canonical small-fixture API.
MerchantAnalysisRequest {
    schema_version: String, scope: MerchantScope, snapshot_id: String,
    as_of_date: String, normalization_version: String, source_admission: MerchantSourceAdmission,
    transactions: Vec<MerchantTransaction>,
    #[serde(deserialize_with = "read_payees")] payees: Vec<Payee>,
    #[serde(deserialize_with = "read_categories")] categories: Vec<Category>,
    #[serde(deserialize_with = "read_rules")] rules: Vec<Rule>,
    aliases: Vec<MerchantAlias>, corrections: Vec<MerchantCorrection>, calendars: Vec<MerchantCalendar>,
    schedules: Vec<MerchantSchedule>, pattern_decisions: Vec<MerchantPatternDecision>,
    horizon_years: u32, max_evidence: u32,
    #[serde(default, deserialize_with = "read_present_option", skip_serializing_if = "Option::is_none")] suggestion_selection: Option<MerchantSuggestionSelection>
} |self| {
    require(self.schema_version == "1" && self.normalization_version == "merchant/2"
        && id(&self.snapshot_id) && (1..=10).contains(&self.horizon_years)
        && (1..=100).contains(&self.max_evidence), "request_version_or_bounds")?;
    self.scope.validate()?; self.source_admission.validate()?; date(&self.as_of_date)?;
    require(self.transactions.len() <= MAX_TRANSACTIONS && self.payees.len() <= 100000
        && self.categories.len() <= 100000 && self.rules.len() <= 100000
        && self.aliases.len() <= 100000 && self.corrections.len() <= MAX_TRANSACTIONS
        && self.schedules.len() <= 100000 && self.calendars.len() <= 1000
        && self.pattern_decisions.len() <= 100000, "input_bounds")?;
    for tx in &self.transactions { tx.validate()?; }
    validate_duplicate_sources(&self.transactions)?;
    require(u64::from(self.source_admission.original_transaction_count)
        == self.transactions.len() as u64 + u64::from(self.source_admission.truncated_count), "source_counts")?;
    for alias in &self.aliases { alias.validate()?; }
    for correction in &self.corrections { correction.validate()?; }
    for calendar in &self.calendars { calendar.validate()?; }
    for schedule in &self.schedules { schedule.validate()?; }
    for decision in &self.pattern_decisions { decision.validate()?; }
    if let Some(selection) = &self.suggestion_selection { selection.validate()?; }
    require(self.payees.iter().all(|p| id(&p.id) && text(&p.name) && optional_id(&p.transfer_account_id))
        && self.categories.iter().all(|c| id(&c.id) && text(&c.name))
        && self.rules.iter().all(|r| id(&r.id) && text(&r.name)), "ledger_records")?;
    for rule in &self.rules { validate_rule_json(&rule.trigger)?; validate_rule_json(&rule.actions)?; }
    Ok(())
});
record!(/// Bounded, typed provenance; semantic evidence cannot assert economic links.
MerchantEvidence {
    kind: MerchantEvidenceKind, source_id: String,
    #[serde(deserialize_with = "read_nullable")] field: Option<String>,
    #[serde(deserialize_with = "read_nullable")] raw_text: Option<String>,
    #[serde(deserialize_with = "read_nullable")] normalized_text: Option<String>,
    #[serde(deserialize_with = "read_nullable")] source_time: Option<String>,
    version: String, reason_code: String
} |self| {
    require(id(&self.source_id) && self.field.as_deref().is_none_or(text)
        && self.raw_text.as_deref().is_none_or(text) && self.normalized_text.as_deref().is_none_or(text)
        && id(&self.version) && id(&self.reason_code), "evidence")?;
    if let Some(time) = &self.source_time { require(date(time).is_ok() || timestamp(time), "evidence_time")?; }
    Ok(())
});
record!(/// Full category outcomes in one exact scoped native identity group.
MerchantCategoryHistoryEntry {
    category_id: String, count: u32, first_date: String, last_date: String,
    ledger_count: u32, correction_count: u32
} |self| {
    require(id(&self.category_id) && self.count > 0 && self.count <= MAX_TRANSACTIONS as u32
        && u64::from(self.ledger_count) + u64::from(self.correction_count) == u64::from(self.count)
        && date(&self.first_date)? <= date(&self.last_date)?, "category_history_entry")
});
record!(/// Full native totals with bounded category entries; samples never determine counts.
MerchantCategoryHistory {
    total_count: u32, category_count: u32, entries: Vec<MerchantCategoryHistoryEntry>, truncated: bool
} |self| {
    require(self.total_count <= MAX_TRANSACTIONS as u32 && self.category_count <= self.total_count
        && self.entries.len() <= 100 && self.entries.len() <= self.category_count as usize
        && self.truncated == (self.entries.len() < self.category_count as usize), "category_history")?;
    let mut ids = HashSet::new();
    let mut sum = 0u64;
    for entry in &self.entries {
        entry.validate()?;
        require(ids.insert(entry.category_id.as_str()), "category_history_duplicate")?;
        sum += u64::from(entry.count);
    }
    require(if self.truncated { sum < u64::from(self.total_count) }
        else { sum == u64::from(self.total_count) }, "category_history_total")
});
record!(/// Competing current category evidence, not a calibrated probability.
MerchantAlternative { category_id: String, support_count: u32, tier: MerchantEvidenceTier, reason_codes: Vec<String> } |self| {
    require(id(&self.category_id) && self.support_count > 0
        && self.reason_codes.len() <= 100 && self.reason_codes.iter().all(|v| id(v)), "alternative")
});
record!(/// Advisory stable-native-ID history winner; no rule payload or action permission.
MerchantRuleCandidate {
    payee_id: String, category_id: String, support_count: u32,
    consistency_numerator: u32, consistency_denominator: u32
} |self| {
    require(id(&self.payee_id) && id(&self.category_id) && self.support_count == self.consistency_numerator
        && self.support_count >= 3 && self.consistency_denominator <= MAX_TRANSACTIONS as u32
        && self.consistency_numerator <= self.consistency_denominator
        && u64::from(self.consistency_numerator) * 100 >= u64::from(self.consistency_denominator) * 90, "rule_candidate")
});
record!(/// Complete IDs for one compiled predicate/category block; result blocks have disjoint IDs.
MerchantNativeRuleBlock {
    #[serde(serialize_with = "write_rule_ids", deserialize_with = "read_shared_rule_ids")] rule_ids: Arc<[String]>
} |self| {
    require(!self.rule_ids.is_empty() && self.rule_ids.iter().all(|v| !v.is_empty())
        && self.rule_ids.windows(2).all(|pair| pair[0] < pair[1]), "native_rule_block")
});
record!(/// Frozen literal source posting; different parts may intentionally overlap.
MerchantNativeRulePart {
    #[serde(serialize_with = "write_block_indexes", deserialize_with = "read_shared_block_indexes")] block_indexes: Arc<[u32]>
} |self| {
    require(!self.block_indexes.is_empty()
        && self.block_indexes.windows(2).all(|pair| pair[0] < pair[1]), "native_rule_part")
});
record!(/// Category-filtered OR union plus the fixed four-field AND intersection.
MerchantNativeRuleSet {
    or_part_indexes: Vec<u32>,
    #[serde(serialize_with = "write_and_part_indexes")] and_part_indexes: Vec<Vec<u32>>,
    category_part_index: u32
} |self| {
    require(self.or_part_indexes.len() <= 4 && self.or_part_indexes.windows(2).all(|pair| pair[0] < pair[1])
        && (self.and_part_indexes.is_empty() || self.and_part_indexes.len() == 4)
        && self.and_part_indexes.iter().all(|operand| operand.len() <= 2
            && operand.windows(2).all(|pair| pair[0] < pair[1])), "native_rule_set")
});
fn write_and_part_indexes<S: serde::Serializer>(
    operands: &[Vec<u32>],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    if operands.iter().any(Vec::is_empty) {
        serializer.collect_seq(std::iter::empty::<&Vec<u32>>())
    } else {
        operands.serialize(serializer)
    }
}
record!(/// Every surviving uncategorized native rule outcome, independent of explanation pages.
MerchantNativeRuleClassification {
    transaction_id: String, account_id: String, category_id: String, rule_set_index: u32
} |self| {
    require(id(&self.transaction_id) && id(&self.account_id) && id(&self.category_id), "native_rule_classification")
});
record!(/// Complete actionable non-native category targets, independent of explanation pages.
MerchantCategoryClassification {
    transaction_id: String, account_id: String,
    #[serde(deserialize_with = "read_nullable")] payee_id: Option<String>,
    category_id: String, tier: MerchantEvidenceTier, evidence_revision: String
} |self| {
    require(id(&self.transaction_id) && id(&self.account_id) && optional_id(&self.payee_id)
        && id(&self.category_id) && id(&self.evidence_revision)
        && matches!(self.tier, MerchantEvidenceTier::Confirmed | MerchantEvidenceTier::Inferred),
        "category_classification")
});
fn write_rule_ids<S: serde::Serializer>(ids: &[String], serializer: S) -> Result<S::Ok, S::Error> {
    ids.serialize(serializer)
}
fn read_shared_rule_ids<'de, D: Deserializer<'de>>(d: D) -> Result<Arc<[String]>, D::Error> {
    struct RuleIds;
    impl<'de> de::Visitor<'de> for RuleIds {
        type Value = Arc<[String]>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a complete array of native source rule IDs")
        }
        fn visit_seq<A: de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let mut ids = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(1024));
            while let Some(value) = sequence.next_element::<String>()? {
                if value.is_empty() {
                    return Err(de::Error::custom("native_rule_ids"));
                }
                ids.push(value);
            }
            Ok(Arc::from(ids))
        }
    }
    d.deserialize_seq(RuleIds)
}

fn write_block_indexes<S: serde::Serializer>(
    indexes: &[u32],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    indexes.serialize(serializer)
}
fn read_shared_block_indexes<'de, D: Deserializer<'de>>(d: D) -> Result<Arc<[u32]>, D::Error> {
    struct BlockIndexes;
    impl<'de> de::Visitor<'de> for BlockIndexes {
        type Value = Arc<[u32]>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a complete array of native block indexes")
        }
        fn visit_seq<A: de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let mut indexes = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(1024));
            while let Some(value) = sequence.next_element::<u32>()? {
                indexes.push(value);
            }
            Ok(Arc::from(indexes))
        }
    }
    d.deserialize_seq(BlockIndexes)
}

#[cfg(test)]
std::thread_local! {
    pub(crate) static NATIVE_WITNESS_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[derive(Clone, Copy)]
struct LiteralWitnessDomain<'parts> {
    sources: [&'parts [u32]; 2],
    positions: [usize; 2],
    other: &'parts [u32],
    kind: usize,
    cost: usize,
}
impl LiteralWitnessDomain<'_> {
    fn next(&mut self) -> Option<u32> {
        let first = self.sources[0].get(self.positions[0]).copied();
        let second = self.sources[1].get(self.positions[1]).copied();
        let index = match (first, second) {
            (Some(first), Some(second)) => first.min(second),
            (Some(index), None) | (None, Some(index)) => index,
            (None, None) => return None,
        };
        // Two overlapping literal AND parts contribute one candidate.
        if first == Some(index) {
            self.positions[0] += 1;
        }
        if second == Some(index) {
            self.positions[1] += 1;
        }
        Some(index)
    }
}

pub(crate) fn native_set_has_witness(
    set: &MerchantNativeRuleSet,
    parts: &[MerchantNativeRulePart],
) -> bool {
    let category = &parts[set.category_part_index as usize].block_indexes;
    let empty = LiteralWitnessDomain {
        sources: [&[]; 2],
        positions: [0; 2],
        other: &[],
        kind: usize::MAX,
        cost: usize::MAX,
    };
    let mut domains = [empty; 5];
    for (position, reference) in set.or_part_indexes.iter().enumerate() {
        let operand = &parts[*reference as usize].block_indexes;
        let (shortest, other) = if operand.len() < category.len() {
            (operand, category)
        } else {
            (category, operand)
        };
        domains[position] = LiteralWitnessDomain {
            sources: [shortest, &[]],
            other,
            kind: position,
            cost: shortest.len(),
            ..empty
        };
    }
    if !set.and_part_indexes.is_empty()
        && set
            .and_part_indexes
            .iter()
            .all(|operand| !operand.is_empty())
    {
        let (field, size) = set
            .and_part_indexes
            .iter()
            .enumerate()
            .map(|(field, operand)| {
                (
                    field,
                    operand
                        .iter()
                        .map(|reference| parts[*reference as usize].block_indexes.len())
                        .sum::<usize>(),
                )
            })
            .min_by_key(|(_, size)| *size)
            .unwrap();
        let sources = if category.len() <= size {
            [category.as_ref(), &[]]
        } else {
            let operand = &set.and_part_indexes[field];
            [
                parts[operand[0] as usize].block_indexes.as_ref(),
                operand.get(1).map_or(&[][..], |reference| {
                    parts[*reference as usize].block_indexes.as_ref()
                }),
            ]
        };
        domains[4] = LiteralWitnessDomain {
            sources,
            kind: 4,
            cost: category.len().min(size),
            ..empty
        };
    }
    domains.sort_unstable_by_key(|domain| (domain.cost, domain.kind));
    // Cardinality orders each round, but never exhausts a wide empty branch
    // before giving another domain its next candidate.
    loop {
        let mut advanced = false;
        for domain in &mut domains {
            let Some(index) = domain.next() else {
                continue;
            };
            advanced = true;
            #[cfg(test)]
            NATIVE_WITNESS_VISITS.with(|visits| visits.set(visits.get() + 1));
            let matches = if domain.kind < 4 {
                domain.other.binary_search(&index).is_ok()
            } else {
                category.binary_search(&index).is_ok()
                    && set.and_part_indexes.iter().all(|operand| {
                        operand.iter().any(|reference| {
                            parts[*reference as usize]
                                .block_indexes
                                .binary_search(&index)
                                .is_ok()
                        })
                    })
            };
            if matches {
                return true;
            }
        }
        if !advanced {
            return false;
        }
    }
}

fn validate_native_tables(
    blocks: &[MerchantNativeRuleBlock],
    parts: &[MerchantNativeRulePart],
    sets: &[MerchantNativeRuleSet],
    used: impl Iterator<Item = u32>,
) -> Result<(), MerchantAnalysisError> {
    require(
        parts.len()
            <= sets
                .len()
                .checked_mul(13)
                .ok_or(MerchantAnalysisError::InvalidInput("native_part_bound"))?,
        "native_part_bound",
    )?;
    let mut ids = HashSet::new();
    for block in blocks {
        block.validate()?;
        for id in block.rule_ids.iter() {
            require(ids.insert(id.as_str()), "native_block_duplicate_id")?;
        }
    }
    for part in parts {
        part.validate()?;
        require(
            part.block_indexes.len() <= blocks.len()
                && part
                    .block_indexes
                    .iter()
                    .all(|index| (*index as usize) < blocks.len()),
            "native_part_block_index",
        )?;
    }
    let mut referenced = vec![false; sets.len()];
    for index in used {
        let present = referenced
            .get_mut(index as usize)
            .ok_or(MerchantAnalysisError::InvalidInput("native_rule_set_index"))?;
        *present = true;
    }
    require(
        referenced.iter().all(|present| *present),
        "native_unused_set",
    )?;
    for set in sets {
        set.validate()?;
        require(
            (set.category_part_index as usize) < parts.len()
                && set
                    .or_part_indexes
                    .iter()
                    .chain(set.and_part_indexes.iter().flatten())
                    .all(|index| (*index as usize) < parts.len()),
            "native_set_part_index",
        )?;
        require(
            native_set_has_witness(set, parts),
            "native_empty_classified_expression",
        )?;
    }
    Ok(())
}

record!(/// Explainable, nonmutating outcome for one admitted source row.
MerchantSuggestion {
    transaction_id: String, account_id: String,
    #[serde(deserialize_with = "read_nullable")] payee_id: Option<String>,
    #[serde(deserialize_with = "read_nullable")] category_id: Option<String>,
    tier: MerchantEvidenceTier, reason_codes: Vec<String>, evidence: Vec<MerchantEvidence>,
    contradictions: Vec<MerchantEvidence>, support_count: u32, evidence_revision: String,
    category_history: MerchantCategoryHistory, alternatives: Vec<MerchantAlternative>, rule_candidates: Vec<MerchantRuleCandidate>
} |self| {
    require(id(&self.transaction_id) && id(&self.account_id) && optional_id(&self.payee_id)
        && optional_id(&self.category_id) && id(&self.evidence_revision)
        && self.evidence.len() <= 100 && self.contradictions.len() <= 100
        && self.reason_codes.len() <= 100 && self.reason_codes.iter().all(|v| id(v)), "suggestion")?;
    for evidence in self.evidence.iter().chain(&self.contradictions) { evidence.validate()?; }
    self.category_history.validate()?;
    require(self.alternatives.len() <= 100 && self.rule_candidates.len() <= 100, "suggestion_aggregates")?;
    let mut alternative_ids = HashSet::new();
    for alternative in &self.alternatives {
        alternative.validate()?;
        require(self.category_id.as_deref() != Some(alternative.category_id.as_str())
            && alternative_ids.insert(alternative.category_id.as_str()), "alternative_duplicate")?;
    }
    for candidate in &self.rule_candidates { candidate.validate()?; }
    Ok(())
});
record!(/// Full occurrence counts per contiguous period, plus exact reduced average.
MerchantOccurrenceDistribution {
    period_counts: BTreeMap<String, u32>, count_distribution: BTreeMap<String, u32>,
    average_numerator: String, average_denominator: String
} |self| {
    require(decimal(&self.average_numerator, false) && decimal(&self.average_denominator, true)
        && self.period_counts.len() <= 10000 && !self.period_counts.is_empty()
        && self.count_distribution.iter().all(|(key, value)| decimal(key, false) && *value > 0), "distribution")
});
fn count_keys(map: &BTreeMap<String, u32>, min: u32, max: u32) -> bool {
    map.iter().all(|(key, count)| {
        *count > 0
            && key
                .parse::<u32>()
                .is_ok_and(|n| (min..=max).contains(&n) && n.to_string() == *key)
    })
}
fn period_keys(map: &BTreeMap<String, u32>, kind: u8) -> bool {
    map.keys().all(|key| {
        key.is_ascii()
            && match kind {
                0 => {
                    key.len() == 8
                        && key.as_bytes().get(4..6) == Some(b"-W")
                        && key[..4].parse::<i32>().is_ok_and(|year| {
                            key[6..].parse::<u32>().is_ok_and(|week| {
                                NaiveDate::from_isoywd_opt(year, week, Weekday::Mon).is_some()
                            })
                        })
                }
                1 => key.len() == 7 && date(&format!("{key}-01")).is_ok(),
                _ => {
                    key.len() == 4
                        && key
                            .parse::<i32>()
                            .is_ok_and(|year| NaiveDate::from_ymd_opt(year, 1, 1).is_some())
                }
            }
    })
}
record!(/// Measured scoped recurrence features, not scheduled expectations or bank-closure claims.
MerchantRecurrence {
    id: String, account_id: String, #[serde(deserialize_with = "read_nullable")] payee_id: Option<String>, normalized_merchant: String,
    currency: String, direction: MerchantDirection, tier: MerchantEvidenceTier,
    kind: MerchantRecurrenceKind, frequency: MerchantFrequency, decision_state: MerchantDecisionState,
    occurrences: u32, first_date: String, last_date: String,
    transaction_ids: Vec<String>, dates: Vec<String>, interval_days: Vec<u32>,
    interval_distribution: BTreeMap<String, u32>, day_of_month: BTreeMap<String, u32>,
    day_of_week: BTreeMap<String, u32>, month_of_year: BTreeMap<String, u32>, year_distribution: BTreeMap<String, u32>,
    occurrences_per_week: Arc<MerchantOccurrenceDistribution>, occurrences_per_month: Arc<MerchantOccurrenceDistribution>,
    occurrences_per_year: Arc<MerchantOccurrenceDistribution>,
    #[serde(deserialize_with = "read_money")] minimum_amount: Money,
    #[serde(deserialize_with = "read_money")] maximum_amount: Money,
    #[serde(deserialize_with = "read_nullable")] variance_numerator: Option<String>,
    #[serde(deserialize_with = "read_nullable")] variance_denominator: Option<String>,
    reason_codes: Vec<String>, #[serde(deserialize_with = "read_nullable")] calendar_version: Option<String>, evidence_revision: String
} |self| {
    require(id(&self.id) && id(&self.account_id) && optional_id(&self.payee_id)
        && text(&self.normalized_merchant) && currency(&self.currency)
        && self.transaction_ids.len() <= 100 && self.dates.len() <= 100 && self.interval_days.len() <= 100
        && self.transaction_ids.iter().all(|v| id(v))
        && count_keys(&self.day_of_month, 1, 31) && count_keys(&self.day_of_week, 1, 7)
        && count_keys(&self.month_of_year, 1, 12)
        && self.year_distribution.iter().all(|(key, value)| *value > 0 && key.len() == 4
            && key.bytes().all(|b| b.is_ascii_digit())
            && key.parse::<u32>().is_ok_and(|year| (1..=9999).contains(&year)))
        && count_keys(&self.interval_distribution, 0, 36600)
        && optional_id(&self.calendar_version) && id(&self.evidence_revision), "recurrence")?;
    let first = date(&self.first_date)?;
    let last = date(&self.last_date)?;
    require(first <= last, "recurrence_endpoints")?;
    for value in &self.dates {
        let observed = date(value)?;
        require(first <= observed && observed <= last, "recurrence_sample_date")?;
    }
    require(money_valid(&self.minimum_amount) && money_valid(&self.maximum_amount)
        && self.minimum_amount.currency() == self.currency && self.maximum_amount.currency() == self.currency
        && self.minimum_amount.minor_units() <= self.maximum_amount.minor_units(), "recurrence_money")?;
    require(match (&self.variance_numerator, &self.variance_denominator) {
        (Some(n), Some(d)) => decimal(n, false) && decimal(d, true),
        (None, None) => self.reason_codes.iter().any(|v| v == "amount_statistics_overflow"),
        _ => false,
    }, "variance")?;
    self.occurrences_per_week.validate()?; self.occurrences_per_month.validate()?; self.occurrences_per_year.validate()?;
    require(period_keys(&self.occurrences_per_week.period_counts, 0)
        && period_keys(&self.occurrences_per_month.period_counts, 1)
        && period_keys(&self.occurrences_per_year.period_counts, 2), "period_keys")
});
record!(/// Lossless source schedule retained alongside, not instead of, measured recurrence.
MerchantScheduledExpectation {
    id: String, #[serde(deserialize_with = "read_nullable")] payee_id: Option<String>,
    #[serde(deserialize_with = "read_schedule")] source: ScheduleLiquidityFact,
    reason_codes: Vec<String>, decision_state: MerchantDecisionState
} |self| {
    require(id(&self.id) && optional_id(&self.payee_id), "scheduled_expectation")?; validate_schedule(&self.source)
});
record!(/// Effective authorized history coverage and exclusions; not a claim of complete source reads.
MerchantCoverage {
    #[serde(deserialize_with = "read_nullable")] start_date: Option<String>,
    #[serde(deserialize_with = "read_nullable")] end_date: Option<String>, input_count: u32, eligible_count: u32,
    excluded_count: u32, limited: bool, reason_codes: Vec<String>
} |self| {
    if let Some(value) = &self.start_date { date(value)?; }
    if let Some(value) = &self.end_date { date(value)?; }
    require(self.start_date.is_some() == self.end_date.is_some(), "coverage")
});
record!(/// Explicit selected-candidate page, independent of full history features.
MerchantSuggestionPage { eligible_candidates: u32, returned: u32,
    #[serde(deserialize_with = "read_nullable")] next_cursor: Option<String> } |self| {
    require(self.returned <= 1000 && self.returned <= self.eligible_candidates
        && optional_id(&self.next_cursor), "suggestion_page")
});
record!(/// Canonical local analysis; application must reauthorize full source dependencies before delivery.
MerchantAnalysisResult {
    schema_version: String, scope: MerchantScope, snapshot_id: String, normalization_version: String,
    source_admission: MerchantSourceAdmission, coverage: MerchantCoverage,
    suggestions: Vec<MerchantSuggestion>, recurrences: Vec<MerchantRecurrence>,
    scheduled_expectations: Vec<MerchantScheduledExpectation>,
    native_rule_blocks: Vec<MerchantNativeRuleBlock>,
    native_rule_parts: Vec<MerchantNativeRulePart>,
    native_rule_sets: Vec<MerchantNativeRuleSet>,
    native_rule_classifications: Vec<MerchantNativeRuleClassification>,
    category_classifications: Vec<MerchantCategoryClassification>,
    #[serde(default, deserialize_with = "read_present_option", skip_serializing_if = "Option::is_none")] suggestion_page: Option<MerchantSuggestionPage>
} |self| {
    require(self.schema_version == "1" && self.normalization_version == "merchant/2" && id(&self.snapshot_id), "result")?;
    self.scope.validate()?; self.source_admission.validate()?; self.coverage.validate()?;
    for suggestion in &self.suggestions { suggestion.validate()?; }
    for recurrence in &self.recurrences { recurrence.validate()?; }
    for expectation in &self.scheduled_expectations { expectation.validate()?; }
    if let Some(page) = &self.suggestion_page { page.validate()?; }
    require(self.native_rule_classifications.len() <= MAX_TRANSACTIONS, "native_classifications")?;
    require(self.native_rule_blocks.len() <= 100_000 && self.native_rule_sets.len() <= MAX_TRANSACTIONS, "native_rule_tables")?;
    validate_native_tables(&self.native_rule_blocks, &self.native_rule_parts, &self.native_rule_sets,
        self.native_rule_classifications.iter().map(|row| row.rule_set_index))?;
    let mut rule_count = 0usize;
    for block in &self.native_rule_blocks {
        rule_count = rule_count.checked_add(block.rule_ids.len())
            .ok_or(MerchantAnalysisError::InvalidInput("native_rule_count"))?;
        require(rule_count <= 100_000 && block.rule_ids.iter().all(|value| id(value)), "native_merchant_rule_bounds")?;
    }
    let mut native_ids = HashSet::new();
    for classification in &self.native_rule_classifications {
        classification.validate()?;
        require((classification.rule_set_index as usize) < self.native_rule_sets.len(), "native_rule_set_index")?;
        require(native_ids.insert(classification.transaction_id.as_str()), "native_classification_duplicate")?;
    }
    require(self.category_classifications.len() <= MAX_TRANSACTIONS, "category_classifications")?;
    let account_ids: HashSet<_> = self.source_admission.source_account_ids.iter().map(String::as_str).collect();
    let category_ids: HashSet<_> = self.source_admission.source_category_ids.iter().map(String::as_str).collect();
    for classification in &self.category_classifications {
        classification.validate()?;
        require(native_ids.insert(classification.transaction_id.as_str()), "category_classification_duplicate")?;
        require(account_ids.contains(classification.account_id.as_str())
            && category_ids.contains(classification.category_id.as_str()), "category_classification_dependency")?;
    }
    Ok(())
} normalize |value| {
    for set in &mut value.native_rule_sets {
        if set.and_part_indexes.iter().any(Vec::is_empty) { set.and_part_indexes.clear(); }
    }
});

/// Conservative merchant/2 matching; legacy reconciliation normalization is unchanged.
///
/// Folds full-width ASCII, Unicode case and punctuation/whitespace separators. It
/// deliberately does not transliterate accents or discard arbitrary identifiers.
pub fn normalize_merchant_intelligence(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut separator = false;
    for original in value.chars() {
        let folded = if ('\u{ff01}'..='\u{ff5e}').contains(&original) {
            char::from_u32(original as u32 - 0xfee0).unwrap_or(original)
        } else {
            original
        };
        for character in folded.to_lowercase() {
            if character.is_alphanumeric() || ('\u{0300}'..='\u{036f}').contains(&character) {
                if separator && !output.is_empty() {
                    output.push(' ');
                }
                output.push(character);
                separator = false;
            } else {
                separator = true;
            }
        }
    }
    output
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct GroupKey<'a> {
    account: &'a str,
    identity: &'a str,
    stable: bool,
    currency: &'a str,
    direction: u8,
}
struct Prepared<'a> {
    tx: &'a MerchantTransaction,
    date: NaiveDate,
    fields: [Option<Rc<str>>; 5],
    display: Rc<str>,
    rule_name: Option<Rc<str>>,
    payee: Option<&'a str>,
    identity_conflict: bool,
    aliases: Rc<Vec<&'a MerchantAlias>>,
}
struct HistoryEntry {
    count: u32,
    ledger_count: u32,
    correction_count: u32,
    first: NaiveDate,
    last: NaiveDate,
    samples: Vec<usize>,
}
struct History<'a> {
    entries: BTreeMap<&'a str, HistoryEntry>,
    ranked: Vec<&'a str>,
    total: u32,
    winner: Option<(&'a str, u32)>,
}
struct Occurrence<'a> {
    date: NaiveDate,
    source_id: &'a str,
    amount: i64,
}

fn source_fields(tx: &MerchantTransaction) -> [(&str, &MerchantTextField); 4] {
    [
        ("importedPayee", &tx.imported_payee),
        ("description", &tx.description),
        ("verboseTitle", &tx.verbose_title),
        ("notes", &tx.notes),
    ]
}
fn direction(amount: i64) -> u8 {
    if amount < 0 {
        0
    } else if amount > 0 {
        1
    } else {
        2
    }
}
fn group<'a>(prepared: &'a Prepared<'a>) -> GroupKey<'a> {
    GroupKey {
        account: &prepared.tx.account_id,
        identity: prepared.payee.unwrap_or_else(|| {
            prepared
                .fields
                .iter()
                .flatten()
                .find(|v| !v.is_empty())
                .map(|v| v.as_ref())
                .unwrap_or(prepared.display.as_ref())
        }),
        stable: prepared.payee.is_some(),
        currency: prepared.tx.amount.currency(),
        direction: direction(prepared.tx.amount.minor_units()),
    }
}
fn eligible(
    tx: &MerchantTransaction,
    observed: NaiveDate,
    start: NaiveDate,
    end: NaiveDate,
) -> bool {
    !tx.deleted
        && !tx.pending
        && tx.cleared
        && !tx.is_split_parent
        && tx.transfer_account_id.is_none()
        && !tx.starting_balance
        && observed >= start
        && observed <= end
}
fn same_source(left: &MerchantTransaction, right: &MerchantTransaction) -> bool {
    left.account_id == right.account_id
        && left.date == right.date
        && left.payee_id == right.payee_id
        && left.payee_name == right.payee_name
        && left.category_id == right.category_id
        && left.amount == right.amount
        && left.cleared == right.cleared
        && left.reconciled == right.reconciled
        && left.imported_payee == right.imported_payee
        && left.description == right.description
        && left.verbose_title == right.verbose_title
        && left.notes == right.notes
        && left.is_split_parent == right.is_split_parent
        && left.is_split_child == right.is_split_child
        && left.parent_id == right.parent_id
        && left.occurrence_complete == right.occurrence_complete
        && left.starting_balance == right.starting_balance
        && left.transfer_account_id == right.transfer_account_id
        && left.deleted == right.deleted
        && left.pending == right.pending
}
fn unique_records(
    request: &MerchantAnalysisRequest,
) -> Result<Vec<&MerchantTransaction>, MerchantAnalysisError> {
    let mut sorted: Vec<_> = request.transactions.iter().collect();
    sorted.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    let mut by_id = HashMap::with_capacity(sorted.len());
    let mut imports = HashMap::new();
    let mut result = Vec::with_capacity(sorted.len());
    for tx in sorted {
        if let Some(previous) = by_id.insert(tx.id.as_str(), tx) {
            if previous != tx {
                return Err(MerchantAnalysisError::ConflictingSourceId);
            }
            continue;
        }
        if let Some(imported) = &tx.imported_id {
            if let Some(previous) = imports.insert((tx.account_id.as_str(), imported.as_str()), tx)
            {
                if !same_source(previous, tx) {
                    return Err(MerchantAnalysisError::ConflictingSourceId);
                }
                continue;
            }
        }
        result.push(tx);
    }
    Ok(result)
}

type AliasIndex<'a> = BTreeMap<(usize, Option<&'a str>), HashMap<String, Vec<&'a MerchantAlias>>>;
fn aliases(request: &MerchantAnalysisRequest) -> Result<AliasIndex<'_>, MerchantAnalysisError> {
    let mut latest: BTreeMap<&str, &MerchantAlias> = BTreeMap::new();
    for alias in &request.aliases {
        match latest.get(alias.id.as_str()) {
            Some(old) if old.version == alias.version && **old != *alias => {
                return Err(MerchantAnalysisError::ConflictingSourceId)
            }
            Some(old) if old.version >= alias.version => {}
            _ => {
                latest.insert(&alias.id, alias);
            }
        }
    }
    let mut indexed: AliasIndex<'_> = BTreeMap::new();
    for alias in latest.into_values() {
        let field = match alias.source_field.as_str() {
            "importedPayee" => 0,
            "description" => 1,
            "verboseTitle" => 2,
            "notes" => 3,
            _ => 4,
        };
        indexed
            .entry((field, alias.account_id.as_deref()))
            .or_default()
            .entry(normalize_merchant_intelligence(&alias.source_text))
            .or_default()
            .push(alias);
    }
    Ok(indexed)
}
fn resolve<'a>(
    tx: &'a MerchantTransaction,
    fields: &[Option<Rc<str>>; 5],
    index: &AliasIndex<'a>,
    names: &HashMap<Rc<str>, Vec<&'a str>>,
    payees: &HashMap<&'a str, &'a Payee>,
    cap: usize,
) -> (Option<&'a str>, bool, Rc<Vec<&'a MerchantAlias>>) {
    let mut matched = Vec::new();
    for (field, normalized) in fields.iter().enumerate() {
        if let Some(normalized) = normalized.as_deref().filter(|v| !v.is_empty()) {
            for account in [Some(tx.account_id.as_str()), None] {
                if let Some(found) = index
                    .get(&(field, account))
                    .and_then(|scope| scope.get(normalized))
                {
                    matched.extend(found.iter().copied());
                }
            }
        }
    }
    matched.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    matched.dedup_by(|a, b| a.id == b.id);
    let rejected: BTreeSet<_> = matched
        .iter()
        .filter(|a| a.state == MerchantAliasState::Rejected)
        .map(|a| a.target_payee_id.as_str())
        .collect();
    let accepted: BTreeSet<_> = matched
        .iter()
        .filter(|a| a.state == MerchantAliasState::Accepted)
        .map(|a| a.target_payee_id.as_str())
        .filter(|p| {
            payees
                .get(p)
                .is_some_and(|payee| payee.transfer_account_id.is_none())
                && !rejected.contains(p)
        })
        .collect();
    let (payee, conflict) = if let Some(native) = tx.payee_id.as_deref() {
        (
            Some(native),
            accepted.iter().any(|target| *target != native),
        )
    } else if accepted.len() > 1 {
        (None, true)
    } else if let Some(target) = accepted.first() {
        (Some(*target), false)
    } else {
        let mut target = None;
        let mut conflict = false;
        // Bank identity fields are peers; exact known names must agree. Free-form
        // notes can corroborate/veto that identity, but never establish it alone.
        for name in fields[..3].iter().flatten() {
            if let Some(targets) = names.get(name) {
                for candidate in targets.iter().copied().filter(|id| !rejected.contains(id)) {
                    conflict |= target.is_some_and(|target| target != candidate);
                    target = Some(candidate);
                }
            }
        }
        if let Some(target) = target {
            conflict |= fields[3]
                .as_ref()
                .and_then(|name| names.get(name))
                .is_some_and(|targets| {
                    targets
                        .iter()
                        .any(|id| !rejected.contains(id) && *id != target)
                });
        }
        (if conflict { None } else { target }, conflict)
    };
    matched.truncate(cap);
    (payee, conflict, Rc::new(matched))
}

fn current_corrections(
    request: &MerchantAnalysisRequest,
) -> Result<HashMap<&str, Vec<&MerchantCorrection>>, MerchantAnalysisError> {
    let mut current: BTreeMap<(&str, &str), &MerchantCorrection> = BTreeMap::new();
    for correction in &request.corrections {
        let key = (
            correction.transaction_id.as_str(),
            correction.actor_id.as_str(),
        );
        match current.get(&key) {
            Some(old) if old.version == correction.version && **old != *correction => {
                return Err(MerchantAnalysisError::ConflictingSourceId)
            }
            Some(old) if old.version >= correction.version => {}
            _ => {
                current.insert(key, correction);
            }
        }
    }
    let mut by_transaction: HashMap<&str, Vec<&MerchantCorrection>> = HashMap::new();
    for correction in current
        .into_values()
        .filter(|c| c.verified && c.state == MerchantCorrectionState::Confirmed)
    {
        by_transaction
            .entry(&correction.transaction_id)
            .or_default()
            .push(correction);
    }
    Ok(by_transaction)
}
fn correction_categories<'a>(
    prepared: &Prepared<'a>,
    corrections: &HashMap<&str, Vec<&'a MerchantCorrection>>,
    categories: &HashMap<&str, &Category>,
) -> Vec<&'a MerchantCorrection> {
    corrections
        .get(prepared.tx.id.as_str())
        .into_iter()
        .flatten()
        .copied()
        .filter(|c| {
            c.account_id == prepared.tx.account_id
                && c.payee_id.as_deref() == prepared.payee
                && categories.contains_key(c.category_id.as_str())
        })
        .collect()
}

fn rule_index<'a>(
    request: &'a MerchantAnalysisRequest,
    categories: &HashMap<&str, &'a Category>,
) -> RuleIndex<'a> {
    RuleIndex::new(&request.rules, categories, str::to_lowercase)
}

struct HashWriter(Sha256);
impl io::Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn hash_value<T: Serialize>(hash: &mut HashWriter, value: &T) {
    // All callers serialize known typed fields; writer cannot fail.
    serde_json::to_writer(&mut *hash, value).expect("typed merchant hash serialization");
    hash.0.update([0]);
}
fn hex(hash: Sha256) -> String {
    format!("sha256:{:x}", hash.finalize())
}
fn revision_seed(
    request: &MerchantAnalysisRequest,
    transactions: &[&MerchantTransaction],
) -> String {
    let mut hash = HashWriter(Sha256::new());
    hash_value(
        &mut hash,
        &(
            THRESHOLD_VERSION,
            &request.scope,
            &request.normalization_version,
            &request.as_of_date,
            request.horizon_years,
        ),
    );
    let admission = &request.source_admission;
    hash_value(
        &mut hash,
        &(
            &admission.facts_hash,
            &admission.visibility_hash,
            &admission.collections,
            admission.pending_state,
            admission.original_transaction_count,
            admission.truncated_count,
        ),
    );
    let mut accounts: Vec<_> = admission.account_coverage.iter().collect();
    accounts.sort_unstable_by(|a, b| a.account_id.cmp(&b.account_id));
    hash_value(&mut hash, &accounts);
    for ids in [
        &admission.source_account_ids,
        &admission.source_category_ids,
    ] {
        let mut ids: Vec<_> = ids.iter().collect();
        ids.sort_unstable();
        hash_value(&mut hash, &ids);
    }
    hash_value(&mut hash, &transactions);
    macro_rules! sorted_hash {
        ($values:expr, $key:expr) => {{
            let mut values: Vec<_> = $values.iter().collect();
            values.sort_unstable_by_key($key);
            hash_value(&mut hash, &values);
        }};
    }
    sorted_hash!(request.payees, |p| p.id.as_str());
    sorted_hash!(request.categories, |c| c.id.as_str());
    sorted_hash!(request.rules, |r| r.id.as_str());
    sorted_hash!(request.corrections, |c| (
        c.transaction_id.as_str(),
        c.actor_id.as_str(),
        c.version,
        c.category_id.as_str()
    ));
    sorted_hash!(request.pattern_decisions, |d| (d.id.as_str(), d.version));
    sorted_hash!(request.schedules, |s| s.source.id.as_str());
    let mut aliases: Vec<_> = request.aliases.iter().collect();
    aliases.sort_unstable_by_key(|a| (a.id.as_str(), a.version));
    for alias in aliases {
        hash_value(
            &mut hash,
            &(
                &alias.id,
                &alias.source_text,
                &alias.source_field,
                &alias.target_payee_id,
                &alias.account_id,
                alias.state,
                &alias.actor_id,
                alias.version,
                &alias.updated_at,
            ),
        );
        let mut sources: Vec<_> = alias.source_transaction_ids.iter().collect();
        sources.sort_unstable();
        hash_value(&mut hash, &sources);
    }
    let mut calendars: Vec<_> = request.calendars.iter().collect();
    calendars.sort_unstable_by_key(|c| (c.account_id.as_deref(), c.version.as_str()));
    for calendar in calendars {
        hash_value(
            &mut hash,
            &(
                &calendar.account_id,
                &calendar.jurisdiction,
                &calendar.subdivision,
                &calendar.time_zone,
                &calendar.version,
                &calendar.coverage_start,
                &calendar.coverage_end,
            ),
        );
        let mut holidays: Vec<_> = calendar.holidays.iter().collect();
        holidays.sort_unstable_by_key(|h| (h.date.as_str(), h.name.as_str()));
        hash_value(&mut hash, &holidays);
    }
    hex(hash.0)
}
fn derived_hash<T: Serialize>(seed: &str, value: &T) -> String {
    let mut hash = HashWriter(Sha256::new());
    hash_value(&mut hash, &(seed, value));
    hex(hash.0)
}
#[allow(clippy::too_many_arguments)]
fn evidence(
    kind: MerchantEvidenceKind,
    source: &str,
    field: Option<&str>,
    raw: Option<&str>,
    normalized: Option<&str>,
    time: Option<&str>,
    version: &str,
    reason: &str,
) -> MerchantEvidence {
    MerchantEvidence {
        kind,
        source_id: source.into(),
        field: field.map(str::to_owned),
        raw_text: raw.map(str::to_owned),
        normalized_text: normalized.map(str::to_owned),
        source_time: time.map(str::to_owned),
        version: version.into(),
        reason_code: reason.into(),
    }
}

// A fixed four-limb accumulator prevents avoidable intermediate overflow before
// reduction. Inputs are bounded i64 within one direction and N <= 250000:
// n*sum(delta²)-sum(delta)² needs at most 163 bits. Final public stats still obey
// checked signed-i128 bounds; no bigint dependency or per-observation allocation.
#[derive(Clone, Copy)]
struct Wide([u64; 4]);
impl Wide {
    fn from_u128(value: u128) -> Self {
        Self([value as u64, (value >> 64) as u64, 0, 0])
    }
    fn add(self, other: Self) -> Option<Self> {
        let mut result = [0; 4];
        let mut carry = false;
        for (index, output) in result.iter_mut().enumerate() {
            let (sum, a) = self.0[index].overflowing_add(other.0[index]);
            let (sum, b) = sum.overflowing_add(u64::from(carry));
            *output = sum;
            carry = a || b;
        }
        (!carry).then_some(Self(result))
    }
    fn multiply(self, other: Self) -> Option<Self> {
        let mut result = [0u64; 4];
        for i in 0..4 {
            let mut carry = 0u128;
            for j in 0..4 {
                if i + j >= 4 {
                    if carry != 0 || (self.0[i] != 0 && other.0[j] != 0) {
                        return None;
                    }
                    continue;
                }
                let product = u128::from(self.0[i]) * u128::from(other.0[j])
                    + u128::from(result[i + j])
                    + carry;
                result[i + j] = product as u64;
                carry = product >> 64;
            }
            if carry != 0 {
                return None;
            }
        }
        Some(Self(result))
    }
    fn subtract(self, other: Self) -> Option<Self> {
        let mut result = [0; 4];
        let mut borrow = false;
        for (index, output) in result.iter_mut().enumerate() {
            let (difference, a) = self.0[index].overflowing_sub(other.0[index]);
            let (difference, b) = difference.overflowing_sub(u64::from(borrow));
            *output = difference;
            borrow = a || b;
        }
        (!borrow).then_some(Self(result))
    }
    fn divide(self, denominator: u64) -> (Self, u64) {
        let mut quotient = [0; 4];
        let mut remainder = 0u128;
        for index in (0..4).rev() {
            let value = (remainder << 64) | u128::from(self.0[index]);
            quotient[index] = (value / u128::from(denominator)) as u64;
            remainder = value % u128::from(denominator);
        }
        (Self(quotient), remainder as u64)
    }
    fn signed(self) -> Option<i128> {
        if self.0[2] != 0 || self.0[3] != 0 || self.0[1] >> 63 != 0 {
            None
        } else {
            Some((u128::from(self.0[1]) << 64 | u128::from(self.0[0])) as i128)
        }
    }
}
fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let remainder = a % b;
        a = b;
        b = remainder;
    }
    a
}
fn variance(occurrences: &[Occurrence<'_>], minimum: i64) -> Option<(String, String)> {
    let mut sum = 0u128;
    let mut squares = Wide::from_u128(0);
    for occurrence in occurrences {
        let delta = u128::try_from(i128::from(occurrence.amount) - i128::from(minimum)).ok()?;
        sum = sum.checked_add(delta)?;
        squares = squares.add(Wide::from_u128(delta.checked_mul(delta)?))?;
    }
    let n = occurrences.len() as u64;
    let numerator = squares
        .multiply(Wide::from_u128(u128::from(n)))?
        .subtract(Wide::from_u128(sum).multiply(Wide::from_u128(sum))?)?;
    let denominator = n.checked_mul(n)?;
    let divisor = gcd(numerator.divide(denominator).1, denominator);
    Some((
        numerator.divide(divisor).0.signed()?.to_string(),
        (denominator / divisor).to_string(),
    ))
}

fn month_start(observed: NaiveDate) -> NaiveDate {
    observed.with_day(1).expect("valid month start")
}
fn month_index(observed: NaiveDate) -> i32 {
    observed.year() * 12 + observed.month0() as i32
}
fn add_months(observed: NaiveDate, months: u32) -> Option<NaiveDate> {
    observed.checked_add_months(chrono::Months::new(months))
}
fn month_end(observed: NaiveDate) -> NaiveDate {
    add_months(month_start(observed), 1).expect("bounded month range") - Duration::days(1)
}
fn occurrence_distribution(dates: &[NaiveDate], period: u8) -> MerchantOccurrenceDistribution {
    let first = dates[0];
    let last = dates[dates.len() - 1];
    let start_of_period = |observed: NaiveDate| match period {
        0 => observed - Duration::days(i64::from(observed.weekday().num_days_from_monday())),
        1 => month_start(observed),
        _ => NaiveDate::from_ymd_opt(observed.year(), 1, 1).expect("valid year start"),
    };
    let mut counts = BTreeMap::new();
    let mut current = start_of_period(first);
    loop {
        counts.insert(current, 0u32);
        let next = match period {
            0 => current.checked_add_signed(Duration::days(7)),
            1 => add_months(current, 1),
            _ => add_months(current, 12),
        };
        match next {
            Some(next) if next <= last => current = next,
            _ => break,
        }
    }
    for observed in dates {
        *counts
            .get_mut(&start_of_period(*observed))
            .expect("included occurrence period") += 1;
    }
    let mut histogram = BTreeMap::new();
    for count in counts.values() {
        *histogram.entry(*count).or_insert(0u32) += 1;
    }
    let divisor = gcd(dates.len() as u64, counts.len() as u64);
    let period_count = counts.len() as u64;
    let period_counts = counts
        .into_iter()
        .map(|(observed, count)| {
            let format = match period {
                0 => "%G-W%V",
                1 => "%Y-%m",
                _ => "%Y",
            };
            (observed.format(format).to_string(), count)
        })
        .collect();
    MerchantOccurrenceDistribution {
        average_numerator: (dates.len() as u64 / divisor).to_string(),
        average_denominator: (period_count / divisor).to_string(),
        period_counts,
        count_distribution: histogram
            .into_iter()
            .map(|(count, periods)| (count.to_string(), periods))
            .collect(),
    }
}

struct Calendar<'a> {
    source: &'a MerchantCalendar,
    start: NaiveDate,
    end: NaiveDate,
    holidays: BTreeSet<NaiveDate>,
}
fn calendar_index(
    request: &MerchantAnalysisRequest,
) -> Result<BTreeMap<Option<&str>, Calendar<'_>>, MerchantAnalysisError> {
    let mut index: BTreeMap<Option<&str>, Calendar<'_>> = BTreeMap::new();
    for source in &request.calendars {
        if let Some(previous) = index.get(&source.account_id.as_deref()) {
            if previous.source != source {
                return Err(MerchantAnalysisError::ConflictingSourceId);
            }
            continue;
        }
        index.insert(
            source.account_id.as_deref(),
            Calendar {
                source,
                start: date(&source.coverage_start)?,
                end: date(&source.coverage_end)?,
                holidays: source
                    .holidays
                    .iter()
                    .map(|h| date(&h.date))
                    .collect::<Result<_, _>>()?,
            },
        );
    }
    Ok(index)
}
fn business_day(calendar: &Calendar<'_>, day: NaiveDate) -> bool {
    !matches!(day.weekday(), Weekday::Sat | Weekday::Sun) && !calendar.holidays.contains(&day)
}
fn first_business_day(calendar: &Calendar<'_>, observed: NaiveDate) -> Option<(NaiveDate, bool)> {
    let mut day = month_start(observed);
    let mut holiday = false;
    for _ in 0..=7 {
        if business_day(calendar, day) {
            return Some((day, holiday));
        }
        holiday |= calendar.holidays.contains(&day);
        day = day.checked_add_signed(Duration::days(1))?;
    }
    None
}
fn monthly_cadence(dates: &[NaiveDate], stride: i32, calendar: Option<&Calendar<'_>>) -> bool {
    let first = dates[0];
    let anchor_end = first == month_end(first)
        || calendar.is_some_and(|c| explained_business_shift(c, month_end(first), first).is_some());
    dates
        .windows(2)
        .all(|pair| month_index(pair[1]) - month_index(pair[0]) == stride)
        && dates.iter().all(|observed| {
            let months = month_index(*observed) - month_index(first);
            if months < 0 {
                return false;
            }
            let expected = if anchor_end {
                month_end(*observed)
            } else if let Some(expected) = add_months(first, months as u32) {
                expected
            } else {
                return false;
            };
            observed.signed_duration_since(expected).num_days().abs() <= 3
                || calendar
                    .is_some_and(|c| explained_business_shift(c, expected, *observed).is_some())
        })
}
fn multiple_phases(dates: &[NaiveDate], period: u8) -> bool {
    let mut periods: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for observed in dates {
        let (key, phase) = if period == 0 {
            let start =
                *observed - Duration::days(i64::from(observed.weekday().num_days_from_monday()));
            (
                start.num_days_from_ce() / 7,
                observed.weekday().num_days_from_monday() as i32,
            )
        } else {
            (month_index(*observed), observed.day() as i32)
        };
        periods.entry(key).or_default().push(phase);
    }
    if periods.len() < 3 {
        return false;
    }
    let mut iter = periods.iter();
    let (&mut_previous, first) = iter.next().expect("three periods");
    let mut previous = mut_previous;
    if first.len() < 2 {
        return false;
    }
    let tolerance = if period == 0 { 2 } else { 3 };
    for (&key, phases) in iter {
        if key != previous + 1
            || phases.len() != first.len()
            || phases
                .iter()
                .zip(first)
                .any(|(phase, expected)| (phase - expected).abs() > tolerance)
        {
            return false;
        }
        previous = key;
    }
    true
}
fn cadence_features(
    dates: &[NaiveDate],
    calendar: Option<&Calendar<'_>>,
) -> (MerchantFrequency, Vec<String>) {
    let mut reasons = Vec::new();
    if dates.len() < 2 {
        return (MerchantFrequency::Irregular, reasons);
    }
    let mut unique = dates.to_vec();
    unique.dedup();
    if unique.len() < 2 {
        return (MerchantFrequency::Irregular, reasons);
    }
    if multiple_phases(dates, 0) || multiple_phases(dates, 1) {
        reasons.push("multiple_period_phases".into());
        return (MerchantFrequency::Multiple, reasons);
    }
    if unique.len() != dates.len() {
        reasons.push("same_day_occurrences".into());
        return (MerchantFrequency::Irregular, reasons);
    }
    if let Some(calendar) = calendar {
        if unique
            .windows(2)
            .all(|p| month_index(p[1]) - month_index(p[0]) == 1)
        {
            let shifts: Vec<_> = unique
                .iter()
                .map(|observed| first_business_day(calendar, *observed))
                .collect();
            if shifts
                .iter()
                .zip(&unique)
                .all(|(shift, observed)| shift.is_some_and(|s| s.0 == *observed))
            {
                reasons.push("first_business_day".into());
                if shifts.iter().flatten().any(|shift| shift.1) {
                    reasons.push("possible_holiday_shift".into());
                }
                return (MerchantFrequency::Monthly, reasons);
            }
        }
    }
    for (stride, frequency) in [
        (1, MerchantFrequency::Monthly),
        (3, MerchantFrequency::Quarterly),
        (12, MerchantFrequency::Annual),
    ] {
        if monthly_cadence(&unique, stride, calendar) {
            let anchor_end = unique[0] == month_end(unique[0])
                || calendar.is_some_and(|c| {
                    explained_business_shift(c, month_end(unique[0]), unique[0]).is_some()
                });
            if anchor_end {
                reasons.push("month_end".into());
            }
            if let Some(calendar) = calendar {
                for observed in &unique {
                    let expected = if anchor_end {
                        month_end(*observed)
                    } else if let Some(expected) = add_months(
                        unique[0],
                        (month_index(*observed) - month_index(unique[0])) as u32,
                    ) {
                        expected
                    } else {
                        continue;
                    };
                    if let Some(holiday) = explained_business_shift(calendar, expected, *observed) {
                        reasons.push("business_day_shift".into());
                        if holiday {
                            reasons.push("possible_holiday_shift".into());
                        }
                    }
                }
            }
            return (frequency, reasons);
        }
    }
    for (interval, frequency) in [
        (7, MerchantFrequency::Weekly),
        (14, MerchantFrequency::Biweekly),
    ] {
        if unique
            .windows(2)
            .all(|p| (p[1] - p[0]).num_days().abs_diff(interval) <= 2)
        {
            return (frequency, reasons);
        }
    }
    // A missing ordinary cycle is disclosed, not promoted by an average interval.
    if unique
        .windows(2)
        .any(|p| (month_index(p[1]) - month_index(p[0])) > 1)
        && unique
            .iter()
            .all(|d| d.day().abs_diff(unique[0].day()) <= 3)
    {
        reasons.push("missed_cycles".into());
    }
    (MerchantFrequency::Irregular, reasons)
}

fn pattern_decisions(
    request: &MerchantAnalysisRequest,
) -> Result<HashMap<&str, Vec<&MerchantPatternDecision>>, MerchantAnalysisError> {
    let mut current: BTreeMap<&str, &MerchantPatternDecision> = BTreeMap::new();
    for decision in &request.pattern_decisions {
        match current.get(decision.id.as_str()) {
            Some(old) if old.version == decision.version && **old != *decision => {
                return Err(MerchantAnalysisError::ConflictingSourceId)
            }
            Some(old) if old.version >= decision.version => {}
            _ => {
                current.insert(&decision.id, decision);
            }
        }
    }
    let mut patterns: HashMap<&str, Vec<&MerchantPatternDecision>> = HashMap::new();
    for decision in current.into_values() {
        patterns
            .entry(&decision.pattern_id)
            .or_default()
            .push(decision);
    }
    Ok(patterns)
}
fn decision_state(
    id: &str,
    decisions: &HashMap<&str, Vec<&MerchantPatternDecision>>,
) -> (MerchantDecisionState, bool) {
    let mut accepted = false;
    let mut rejected = false;
    for decision in decisions.get(id).into_iter().flatten() {
        accepted |= decision.state == MerchantPatternState::Accepted;
        rejected |= decision.state == MerchantPatternState::Rejected;
    }
    (
        if accepted && !rejected {
            MerchantDecisionState::Accepted
        } else if rejected && !accepted {
            MerchantDecisionState::Rejected
        } else {
            MerchantDecisionState::Unreviewed
        },
        accepted && rejected,
    )
}
#[allow(clippy::too_many_arguments)]
fn build_recurrence(
    key: GroupKey<'_>,
    occurrences: &mut [Occurrence<'_>],
    request: &MerchantAnalysisRequest,
    calendars: &BTreeMap<Option<&str>, Calendar<'_>>,
    currency_known: bool,
    decisions: &HashMap<&str, Vec<&MerchantPatternDecision>>,
    normalized: &str,
    seed: &str,
    occurrence_distributions: &mut HashMap<
        Vec<NaiveDate>,
        [Arc<MerchantOccurrenceDistribution>; 3],
    >,
) -> MerchantRecurrence {
    occurrences.sort_unstable_by(|a, b| (a.date, a.source_id).cmp(&(b.date, b.source_id)));
    let all_dates: Vec<_> = occurrences.iter().map(|o| o.date).collect();
    let calendar = calendars
        .get(&Some(key.account))
        .or_else(|| calendars.get(&None))
        .filter(|c| {
            matches!(c.source.jurisdiction.as_str(), "US" | "CA" | "GB")
                && c.start <= all_dates[0]
                && c.end >= all_dates[all_dates.len() - 1]
        });
    let (frequency, mut reason_codes) = cadence_features(&all_dates, calendar);
    if calendar.is_none() {
        reason_codes.push("calendar_unknown".into());
    }
    let unique_days = all_dates.windows(2).filter(|p| p[0] != p[1]).count() + 1;
    let established = occurrences.len() >= 3
        && unique_days >= 3
        && key.direction != 2
        && key.stable
        && currency_known
        && request.source_admission.pending_state != MerchantPendingState::Unsupported
        && !reason_codes.iter().any(|r| r == "missed_cycles");
    let mut tier = if established {
        MerchantEvidenceTier::Inferred
    } else {
        MerchantEvidenceTier::InsufficientData
    };
    if occurrences.len() < 3 || unique_days < 3 {
        reason_codes.push("minimum_observations".into());
    }
    if key.direction == 2 {
        reason_codes.push("zero_amount".into());
    }
    if !key.stable {
        reason_codes.push("unresolved_merchant".into());
    }
    if !currency_known {
        reason_codes.push("currency_unknown".into());
    }
    if request.source_admission.pending_state == MerchantPendingState::Unsupported {
        reason_codes.push("pending_coverage_unknown".into());
    }
    let id = derived_hash(
        "merchant-pattern/2",
        &(
            &request.scope,
            key.account,
            key.identity,
            key.stable,
            key.currency,
            key.direction,
            frequency,
            "observed",
        ),
    );
    let (decision_state, conflict) = decision_state(&id, decisions);
    if decision_state == MerchantDecisionState::Rejected {
        reason_codes.push("pattern_rejected".into());
    }
    if decision_state == MerchantDecisionState::Accepted {
        tier = MerchantEvidenceTier::Confirmed;
    }
    if conflict {
        tier = MerchantEvidenceTier::Conflicting;
        reason_codes.push("pattern_decision_conflict".into());
    }
    let minimum = occurrences
        .iter()
        .map(|o| o.amount)
        .min()
        .expect("nonempty group");
    let maximum = occurrences
        .iter()
        .map(|o| o.amount)
        .max()
        .expect("nonempty group");
    let (variance_numerator, variance_denominator) = match variance(occurrences, minimum) {
        Some((numerator, denominator)) => (Some(numerator), Some(denominator)),
        None => {
            reason_codes.push("amount_statistics_overflow".into());
            (None, None)
        }
    };
    let mut interval_distribution = BTreeMap::new();
    let mut interval_days = Vec::new();
    let cap = request.max_evidence as usize;
    for pair in all_dates.windows(2) {
        let interval = (pair[1] - pair[0]).num_days() as u32;
        *interval_distribution.entry(interval).or_insert(0u32) += 1;
        if interval_days.len() < cap {
            interval_days.push(interval);
        }
    }
    let mut month_days = [0u32; 32];
    let mut week_days = [0u32; 8];
    let mut months = [0u32; 13];
    let mut years = BTreeMap::new();
    for observed in &all_dates {
        month_days[observed.day() as usize] += 1;
        week_days[observed.weekday().number_from_monday() as usize] += 1;
        months[observed.month() as usize] += 1;
        *years.entry(observed.year()).or_insert(0u32) += 1;
    }
    let day_of_month = nonzero_counts(&month_days);
    let day_of_week = nonzero_counts(&week_days);
    let month_of_year = nonzero_counts(&months);
    let year_distribution = years
        .into_iter()
        .map(|(year, count)| (format!("{year:04}"), count))
        .collect();
    let interval_distribution = interval_distribution
        .into_iter()
        .map(|(interval, count)| (interval.to_string(), count))
        .collect();
    reason_codes.sort_unstable();
    reason_codes.dedup();
    // Period distributions depend only on the complete sorted date multiset.
    let [occurrences_per_week, occurrences_per_month, occurrences_per_year] =
        if let Some(distributions) = occurrence_distributions.get(all_dates.as_slice()) {
            distributions.clone()
        } else {
            let distributions = [
                Arc::new(occurrence_distribution(&all_dates, 0)),
                Arc::new(occurrence_distribution(&all_dates, 1)),
                Arc::new(occurrence_distribution(&all_dates, 2)),
            ];
            occurrence_distributions.insert(all_dates.clone(), distributions.clone());
            distributions
        };
    MerchantRecurrence {
        evidence_revision: derived_hash(seed, &id),
        id,
        account_id: key.account.into(),
        payee_id: key.stable.then(|| key.identity.to_owned()),
        normalized_merchant: normalized.into(),
        currency: key.currency.into(),
        direction: match key.direction {
            0 => MerchantDirection::Outflow,
            1 => MerchantDirection::Inflow,
            _ => MerchantDirection::Zero,
        },
        tier,
        kind: MerchantRecurrenceKind::Observed,
        frequency,
        decision_state,
        occurrences: occurrences.len() as u32,
        first_date: all_dates[0].format("%Y-%m-%d").to_string(),
        last_date: all_dates[all_dates.len() - 1]
            .format("%Y-%m-%d")
            .to_string(),
        transaction_ids: occurrences
            .iter()
            .take(cap)
            .map(|o| o.source_id.to_owned())
            .collect(),
        dates: all_dates
            .iter()
            .take(cap)
            .map(|d| d.format("%Y-%m-%d").to_string())
            .collect(),
        interval_days,
        interval_distribution,
        day_of_month,
        day_of_week,
        month_of_year,
        year_distribution,
        occurrences_per_week,
        occurrences_per_month,
        occurrences_per_year,
        minimum_amount: Money::new(minimum, key.currency),
        maximum_amount: Money::new(maximum, key.currency),
        variance_numerator,
        variance_denominator,
        reason_codes,
        calendar_version: calendar.map(|c| c.source.version.clone()),
    }
}

struct CategoryResolution<'a> {
    category: Option<&'a str>,
    tier: MerchantEvidenceTier,
    support_count: u32,
    reason: &'static str,
}
fn resolve_category<'a>(
    row: &Prepared<'a>,
    confirmed: &[&'a MerchantCorrection],
    categories: &HashMap<&str, &Category>,
    matching: &RuleMatches<'a>,
    winner: Option<(&'a str, u32)>,
    history_admitted: bool,
) -> CategoryResolution<'a> {
    let corrected = confirmed.first().map(|record| record.category_id.as_str());
    let (category, tier, support_count, reason) = if confirmed
        .iter()
        .any(|record| Some(record.category_id.as_str()) != corrected)
    {
        (
            None,
            MerchantEvidenceTier::Conflicting,
            u32::from(row.payee.is_some()),
            "correction_conflict",
        )
    } else if let Some(target) = corrected {
        (
            Some(target),
            MerchantEvidenceTier::Confirmed,
            confirmed.len() as u32,
            "confirmed_correction",
        )
    } else if row.identity_conflict {
        (
            None,
            MerchantEvidenceTier::Conflicting,
            u32::from(row.payee.is_some()),
            "identity_conflict",
        )
    } else if let Some(existing) = row
        .tx
        .category_id
        .as_deref()
        .filter(|id| categories.contains_key(id))
    {
        (
            Some(existing),
            MerchantEvidenceTier::DeterministicMatch,
            1,
            "ledger_category",
        )
    } else if matching.conflict {
        (
            None,
            MerchantEvidenceTier::Conflicting,
            u32::from(row.payee.is_some()),
            "native_rule_conflict",
        )
    } else if let Some(target) = matching.category {
        (
            Some(target),
            MerchantEvidenceTier::DeterministicMatch,
            matching.rule_count,
            "native_rule_match",
        )
    } else if let Some((target, count)) = winner.filter(|_| history_admitted && row.payee.is_some())
    {
        (
            Some(target),
            MerchantEvidenceTier::Inferred,
            count,
            "consistent_scoped_history",
        )
    } else {
        (
            None,
            if row.payee.is_some() {
                MerchantEvidenceTier::DeterministicMatch
            } else {
                MerchantEvidenceTier::InsufficientData
            },
            u32::from(row.payee.is_some()),
            "category_insufficient_data",
        )
    };
    CategoryResolution {
        category,
        tier,
        support_count,
        reason,
    }
}
fn public_history(
    history: Option<&History<'_>>,
    selected: Option<&str>,
    cap: usize,
) -> MerchantCategoryHistory {
    let Some(history) = history else {
        return MerchantCategoryHistory {
            total_count: 0,
            category_count: 0,
            entries: Vec::new(),
            truncated: false,
        };
    };
    let preferred = selected.filter(|id| history.entries.contains_key(id));
    let entries: Vec<_> = preferred
        .into_iter()
        .chain(
            history
                .ranked
                .iter()
                .copied()
                .filter(|id| Some(*id) != preferred),
        )
        .take(cap)
        .map(|id| {
            let entry = &history.entries[id];
            MerchantCategoryHistoryEntry {
                category_id: id.into(),
                count: entry.count,
                ledger_count: entry.ledger_count,
                correction_count: entry.correction_count,
                first_date: entry.first.format("%Y-%m-%d").to_string(),
                last_date: entry.last.format("%Y-%m-%d").to_string(),
            }
        })
        .collect();
    MerchantCategoryHistory {
        total_count: history.total,
        category_count: history.entries.len() as u32,
        truncated: entries.len() < history.entries.len(),
        entries,
    }
}
#[allow(clippy::too_many_arguments)]
fn category_advice<'a>(
    row: &Prepared<'a>,
    request: &MerchantAnalysisRequest,
    history: Option<&History<'a>>,
    confirmed: &[&'a MerchantCorrection],
    rules: &RuleIndex<'a>,
    matching: &RuleMatches<'a>,
    selected: &CategoryResolution<'a>,
    history_admitted: bool,
    account_complete: bool,
    cap: usize,
) -> (Vec<MerchantAlternative>, Vec<MerchantRuleCandidate>) {
    let mut corrected: BTreeMap<&str, u32> = BTreeMap::new();
    for record in confirmed {
        let count = corrected.entry(&record.category_id).or_default();
        *count = count.checked_add(1).expect("bounded source authority");
    }
    let conflict = row.identity_conflict
        || matching.conflict
        || corrected.len() > 1
        || corrected
            .keys()
            .any(|id| matching.category.is_some_and(|native| *id != native))
        || selected.category.is_some_and(|selected| {
            matching.category.is_some_and(|native| native != selected)
                || corrected.keys().any(|id| *id != selected)
        });
    let mut alternatives = Vec::new();
    let mut emitted = BTreeSet::new();
    // Current corrections precede native rules; both precede ranked history.
    // Bound iteration before allocation, including large conflicted rule sets.
    for id in corrected
        .keys()
        .copied()
        .chain(std::iter::once_with(|| rules.matching_categories(matching, cap + 1)).flatten())
    {
        if alternatives.len() >= cap {
            break;
        }
        if Some(id) == selected.category || !emitted.insert(id) {
            continue;
        }
        let correction = corrected.get(id).copied().unwrap_or(0);
        let support_count = history
            .and_then(|history| history.entries.get(id))
            .map_or_else(
                || {
                    correction
                        .checked_add(rules.category_count(matching, id))
                        .expect("bounded source authority")
                },
                |entry| entry.count,
            );
        alternatives.push(MerchantAlternative {
            category_id: id.into(),
            support_count,
            tier: if conflict {
                MerchantEvidenceTier::Conflicting
            } else if correction > 0 {
                MerchantEvidenceTier::Confirmed
            } else {
                MerchantEvidenceTier::DeterministicMatch
            },
            reason_codes: vec![if conflict {
                "authoritative_category_conflict"
            } else if correction > 0 {
                "confirmed_correction"
            } else {
                "native_rule_match"
            }
            .into()],
        });
    }
    if let Some(history) = history {
        for id in history.ranked.iter().copied().filter(|id| {
            Some(*id) != selected.category
                && !corrected.contains_key(id)
                && !rules.has_category(matching, id)
        }) {
            if alternatives.len() >= cap {
                break;
            }
            alternatives.push(MerchantAlternative {
                category_id: id.into(),
                support_count: history.entries[id].count,
                tier: if history_admitted && history.winner.is_some_and(|(winner, _)| winner == id)
                {
                    MerchantEvidenceTier::Inferred
                } else {
                    MerchantEvidenceTier::InsufficientData
                },
                reason_codes: vec!["scoped_history".into()],
            });
        }
    }
    let complete = history_admitted
        && account_complete
        && request.source_admission.collections.transactions == MerchantCollectionState::Complete
        && request.source_admission.truncated_count == 0;
    let rule_candidates = history
        .and_then(|history| history.winner.map(|winner| (history, winner)))
        .filter(|(_, (target, _))| {
            complete
                && !row.identity_conflict
                && row.tx.payee_id.as_deref() == row.payee
                && row.tx.payee_id.is_some()
                && !matching.conflict
                && matching.category.is_none_or(|native| native == *target)
                && corrected.keys().all(|id| *id == *target)
        })
        .map(|(history, (target, count))| MerchantRuleCandidate {
            payee_id: row.payee.expect("admitted stable native identity").into(),
            category_id: target.into(),
            support_count: count,
            consistency_numerator: count,
            consistency_denominator: history.total,
        })
        .into_iter()
        .collect();
    (alternatives, rule_candidates)
}

#[allow(clippy::too_many_arguments)]
fn build_suggestion<'source, 'rows>(
    prepared: &'rows Prepared<'source>,
    prepared_rows: &'rows [Prepared<'source>],
    request: &MerchantAnalysisRequest,
    histories: &HashMap<GroupKey<'rows>, History<'source>>,
    corrections: &HashMap<&str, Vec<&'source MerchantCorrection>>,
    categories: &HashMap<&str, &Category>,
    rules: &RuleIndex<'source>,
    matching: &RuleMatches<'source>,
    currency_known: bool,
    account_complete: bool,
    names: &HashMap<Rc<str>, Vec<&str>>,
    payees: &HashMap<&str, &Payee>,
    normalizations: &mut HashMap<&'source str, Rc<str>>,
    seed: &str,
) -> MerchantSuggestion {
    let tx = prepared.tx;
    let mut evidence_rows = Vec::new();
    let mut contradictions = Vec::new();
    let mut reasons = Vec::new();
    let cap = request.max_evidence as usize;
    for (field, source) in source_fields(tx) {
        if source.state == MerchantTextState::Present {
            evidence_rows.push(evidence(
                MerchantEvidenceKind::SourceObservation,
                &tx.id,
                Some(field),
                source.value.as_deref(),
                None,
                Some(&tx.date),
                "merchant/2",
                "source_text",
            ));
            let normalized = source.value.as_deref().map(|raw| {
                normalizations
                    .entry(raw)
                    .or_insert_with(|| Rc::from(normalize_merchant_intelligence(raw)))
            });
            if let Some(normalized) = normalized.filter(|v| v.len() <= MAX_TEXT) {
                evidence_rows.push(evidence(
                    MerchantEvidenceKind::NormalizedEvidence,
                    &tx.id,
                    Some(field),
                    None,
                    Some(normalized.as_ref()),
                    Some(&tx.date),
                    "merchant/2",
                    "normalized_source_text",
                ));
            }
        }
    }
    if tx.payee_id.is_some() {
        evidence_rows.push(evidence(
            MerchantEvidenceKind::SourceObservation,
            &tx.id,
            Some("payeeId"),
            None,
            None,
            Some(&tx.date),
            "merchant/2",
            "stable_payee_identity",
        ));
        reasons.push("stable_payee_identity".into());
    }
    if let Some(raw) = tx.payee_name.as_deref() {
        evidence_rows.push(evidence(
            MerchantEvidenceKind::SourceObservation,
            &tx.id,
            Some("payeeName"),
            Some(raw),
            None,
            Some(&tx.date),
            "merchant/2",
            "native_payee_name",
        ));
    }
    if source_fields(tx)
        .iter()
        .any(|(_, field)| field.state == MerchantTextState::Unavailable)
    {
        reasons.push("source_unavailable".into());
    }
    for alias in prepared.aliases.iter() {
        let row = evidence(
            MerchantEvidenceKind::ConfirmedDecision,
            &alias.id,
            Some(&alias.source_field),
            Some(&alias.source_text),
            None,
            Some(&alias.updated_at),
            &alias.version.to_string(),
            if alias.state == MerchantAliasState::Accepted {
                "accepted_alias"
            } else {
                "rejected_alias"
            },
        );
        if alias.state == MerchantAliasState::Rejected || prepared.identity_conflict {
            contradictions.push(row);
        } else {
            evidence_rows.push(row);
        }
    }
    if prepared.identity_conflict {
        reasons.push("identity_conflict".into());
        if tx.payee_id.is_none() {
            for (index, (field, source)) in source_fields(tx).into_iter().enumerate() {
                if contradictions.len() >= cap {
                    break;
                }
                if let Some(targets) = prepared.fields[index]
                    .as_ref()
                    .and_then(|name| names.get(name))
                {
                    contradictions.push(evidence(
                        MerchantEvidenceKind::SourceObservation,
                        &tx.id,
                        Some(field),
                        source.value.as_deref(),
                        None,
                        Some(&tx.date),
                        "merchant/2",
                        "identity_conflict",
                    ));
                    if targets.len() > 1 {
                        for target in targets.iter().take(cap - contradictions.len()) {
                            if let Some(candidate) = payees.get(target) {
                                contradictions.push(evidence(
                                    MerchantEvidenceKind::SourceObservation,
                                    &candidate.id,
                                    Some("payeeName"),
                                    Some(&candidate.name),
                                    None,
                                    None,
                                    "merchant/2",
                                    "ambiguous_payee_name",
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    let confirmed = correction_categories(prepared, corrections, categories);
    let history = histories.get(&group(prepared));
    let authoritative_complete = request.source_admission.collections.payees
        == MerchantCollectionState::Complete
        && request.source_admission.collections.categories == MerchantCollectionState::Complete
        && request.source_admission.collections.rules == MerchantCollectionState::Complete
        && request.source_admission.pending_state != MerchantPendingState::Unsupported;
    if !authoritative_complete {
        reasons.push("authoritative_source_unavailable".into());
    }
    if !currency_known {
        reasons.push("currency_unknown".into());
    }
    if request.source_admission.collections.transactions != MerchantCollectionState::Complete {
        reasons.push("history_incomplete".into());
    }
    if rules.unsupported {
        reasons.push("unsupported_rule".into());
    }
    let selected = resolve_category(
        prepared,
        &confirmed,
        categories,
        matching,
        history.and_then(|history| history.winner),
        currency_known && authoritative_complete,
    );
    let category = selected.category;
    let tier = selected.tier;
    let support_count = selected.support_count;
    reasons.push(selected.reason.into());
    if selected.reason == "consistent_scoped_history" {
        reasons.push(THRESHOLD_VERSION.into());
    }
    if selected.reason == "ledger_category" {
        evidence_rows.push(evidence(
            MerchantEvidenceKind::SourceObservation,
            &tx.id,
            Some("categoryId"),
            None,
            category,
            Some(&tx.date),
            "merchant/2",
            "ledger_category",
        ));
    }
    for correction in confirmed.iter().take(cap) {
        let row = evidence(
            MerchantEvidenceKind::ConfirmedDecision,
            &correction.transaction_id,
            Some("categoryId"),
            None,
            Some(&correction.category_id),
            Some(&tx.date),
            &correction.version.to_string(),
            "confirmed_correction",
        );
        if category == Some(correction.category_id.as_str()) {
            evidence_rows.push(row);
        } else {
            contradictions.push(row);
        }
    }
    for (index, offset) in rules.bounded_evidence(matching, cap) {
        let block = &rules.blocks[index];
        let row = evidence(
            MerchantEvidenceKind::NativeRule,
            &block.rule_ids[offset],
            Some("categoryId"),
            None,
            Some(block.category),
            None,
            "actual-rule/1",
            "native_rule_match",
        );
        if category == Some(block.category) {
            evidence_rows.push(row);
        } else {
            contradictions.push(row);
        }
    }
    if let Some(history) = history {
        if let Some(sources) =
            category.and_then(|target| history.entries.get(target).map(|entry| &entry.samples))
        {
            for index in sources.iter().take(cap) {
                let source = prepared_rows[*index].tx;
                evidence_rows.push(evidence(
                    MerchantEvidenceKind::SourceObservation,
                    &source.id,
                    Some("categoryId"),
                    None,
                    category,
                    Some(&source.date),
                    THRESHOLD_VERSION,
                    "scoped_history",
                ));
            }
        }
        for (target, entry) in &history.entries {
            if contradictions.len() >= cap {
                break;
            }
            if category == Some(*target) {
                continue;
            }
            for index in entry.samples.iter().take(cap - contradictions.len()) {
                let source = prepared_rows[*index].tx;
                contradictions.push(evidence(
                    MerchantEvidenceKind::SourceObservation,
                    &source.id,
                    Some("categoryId"),
                    None,
                    Some(target),
                    Some(&source.date),
                    THRESHOLD_VERSION,
                    "scoped_history",
                ));
            }
        }
    }
    // Authoritative decision/rule samples precede source display, while deterministic
    // ordering prevents fixture/input permutation from selecting different samples.
    let priority = |row: &MerchantEvidence| match row.kind {
        MerchantEvidenceKind::ConfirmedDecision => 0,
        MerchantEvidenceKind::NativeRule => 1,
        MerchantEvidenceKind::SourceObservation => 2,
        _ => 3,
    };
    evidence_rows.sort_unstable_by(|a, b| {
        (priority(a), &a.source_id, &a.field, &a.reason_code).cmp(&(
            priority(b),
            &b.source_id,
            &b.field,
            &b.reason_code,
        ))
    });
    contradictions.sort_unstable_by(|a, b| {
        (&a.source_id, &a.field, &a.reason_code).cmp(&(&b.source_id, &b.field, &b.reason_code))
    });
    evidence_rows.truncate(cap);
    contradictions.truncate(cap);
    reasons.sort_unstable();
    reasons.dedup();
    let category_history = public_history(history, category, cap);
    let (alternatives, rule_candidates) = category_advice(
        prepared,
        request,
        history,
        &confirmed,
        rules,
        matching,
        &selected,
        currency_known && authoritative_complete,
        account_complete,
        cap,
    );
    MerchantSuggestion {
        transaction_id: tx.id.clone(),
        account_id: tx.account_id.clone(),
        payee_id: prepared.payee.map(str::to_owned),
        category_id: category.map(str::to_owned),
        tier,
        reason_codes: reasons,
        evidence: evidence_rows,
        contradictions,
        support_count,
        category_history,
        alternatives,
        rule_candidates,
        evidence_revision: derived_hash(seed, &tx.id),
    }
}

/// Projects observable legacy rows through the same civil-date cadence kernel.
/// Missing source/parent/deletion provenance cannot establish merchant confidence.
/// RFC3339 snapshot captures use their UTC civil date; transaction dates stay civil.
pub(crate) fn legacy_recurrence_projection(
    transactions: &[crate::Transaction],
    reference_date: &str,
) -> Vec<crate::analysis::RecurringCharge> {
    let end = date(reference_date).ok().or_else(|| {
        chrono::DateTime::parse_from_rfc3339(reference_date)
            .ok()
            .map(|captured| captured.naive_utc().date())
    });
    let Some(end) = end.filter(|end| (1..=9999).contains(&end.year())) else {
        return Vec::new();
    };
    let mut groups = BTreeMap::<_, Vec<_>>::new();
    let mut seen = HashMap::with_capacity(transactions.len());
    let mut conflicting = HashSet::new();
    for tx in transactions {
        if seen.insert(tx.id.as_str(), tx).is_some_and(|old| old != tx) {
            conflicting.insert(tx.id.as_str());
        }
    }
    for tx in transactions {
        if conflicting.contains(tx.id.as_str()) || seen.remove(tx.id.as_str()).is_none() {
            continue;
        }
        let Some(payee) = tx.payee_id.as_deref().filter(|payee| id(payee)) else {
            continue;
        };
        let Ok(observed) = date(&tx.date) else {
            continue;
        };
        if observed > end
            || !tx.cleared
            || tx.transfer_account_id.is_some()
            || !tx.subtransactions.is_empty()
            || !money_valid(&tx.amount)
        {
            continue;
        }
        groups
            .entry((
                &tx.account_id,
                payee,
                tx.amount.currency(),
                direction(tx.amount.minor_units()),
            ))
            .or_default()
            .push((tx, observed));
    }
    let mut projected = Vec::with_capacity(groups.len());
    let mut dates = Vec::new();
    let mut amounts = Vec::new();
    for ((account, payee, currency, _), mut rows) in groups {
        if rows.len() < 2 {
            continue;
        }
        rows.sort_unstable_by(|a, b| (a.1, &a.0.id).cmp(&(b.1, &b.0.id)));
        dates.clear();
        dates.extend(rows.iter().map(|(_, observed)| *observed));
        let (frequency, mut reasons) = cadence_features(&dates, None);
        reasons.extend([
            "calendar_unknown".into(),
            "legacy_source_unavailable".into(),
        ]);
        if dates.windows(2).filter(|pair| pair[0] != pair[1]).count() < 2 {
            reasons.push("minimum_observations".into());
        }
        reasons.sort_unstable();
        reasons.dedup();
        amounts.clear();
        amounts.extend(rows.iter().map(|(tx, _)| tx.amount.minor_units()));
        let middle = amounts.len() / 2;
        let (_, median, _) = amounts.select_nth_unstable(middle);
        let representative = rows.last().expect("nonempty observed group").0;
        let original = representative.payee_name.as_deref().unwrap_or("");
        let frequency_label = match frequency {
            MerchantFrequency::Weekly => "weekly",
            MerchantFrequency::Biweekly => "biweekly",
            MerchantFrequency::Monthly => "monthly",
            MerchantFrequency::Quarterly => "quarterly",
            MerchantFrequency::Annual => "annual",
            MerchantFrequency::Multiple => "multiple",
            MerchantFrequency::Irregular => "irregular",
        };
        projected.push(crate::analysis::RecurringCharge {
            account_id: account.into(),
            payee_id: payee.into(),
            occurrences: rows.len() as u32,
            first_date: dates[0].format("%Y-%m-%d").to_string(),
            last_date: dates[dates.len() - 1].format("%Y-%m-%d").to_string(),
            tier: MerchantEvidenceTier::InsufficientData,
            reason_codes: reasons,
            normalized_merchant: normalize_merchant_intelligence(original),
            original_name: original.into(),
            frequency_label: frequency_label.into(),
            typical_amount: Money::new(*median, currency),
            transaction_ids: rows.iter().take(100).map(|(tx, _)| tx.id.clone()).collect(),
            dates: dates
                .iter()
                .take(100)
                .map(|observed| observed.format("%Y-%m-%d").to_string())
                .collect(),
        });
    }
    projected.sort_unstable_by(|a, b| {
        (
            &a.normalized_merchant,
            &a.account_id,
            &a.payee_id,
            a.typical_amount.currency(),
            direction(a.typical_amount.minor_units()),
        )
            .cmp(&(
                &b.normalized_merchant,
                &b.account_id,
                &b.payee_id,
                b.typical_amount.currency(),
                direction(b.typical_amount.minor_units()),
            ))
    });
    projected
}

/// Analyze local admitted facts without providers, ledger writes, or system-clock reads.
///
/// Inputs are validated even when constructed directly by Rust callers. History and
/// occurrences are indexed once; explicit pages materialize only the selected rows.
pub fn analyze_merchant_intelligence(
    request: &MerchantAnalysisRequest,
) -> Result<MerchantAnalysisResult, MerchantAnalysisError> {
    request.validate()?;
    let end = date(&request.as_of_date)?;
    let start = end
        .checked_sub_months(chrono::Months::new(request.horizon_years * 12))
        .ok_or(MerchantAnalysisError::InvalidInput("history_horizon"))?;
    let transactions = unique_records(request)?;
    let seed = revision_seed(request, &transactions);
    let mut payees: HashMap<&str, &Payee> = HashMap::with_capacity(request.payees.len());
    let mut categories: HashMap<&str, &Category> = HashMap::with_capacity(request.categories.len());
    let mut all_categories = HashMap::with_capacity(request.categories.len());
    let mut normalizations: HashMap<&str, Rc<str>> = HashMap::new();
    let mut lower_names: HashMap<&str, Rc<str>> = HashMap::new();
    let mut names: HashMap<Rc<str>, Vec<&str>> = HashMap::new();
    let mut normalized_payees = HashMap::new();
    for payee in &request.payees {
        if payees
            .insert(payee.id.as_str(), payee)
            .is_some_and(|old| old != payee)
        {
            return Err(MerchantAnalysisError::ConflictingSourceId);
        }
        let normalized = Rc::clone(
            normalizations
                .entry(&payee.name)
                .or_insert_with(|| Rc::from(normalize_merchant_intelligence(&payee.name))),
        );
        if payee.transfer_account_id.is_none() && !normalized.is_empty() {
            names
                .entry(normalized.clone())
                .or_default()
                .push(payee.id.as_str());
        }
        normalized_payees.insert(payee.id.as_str(), normalized);
    }
    for targets in names.values_mut() {
        targets.sort_unstable();
        targets.dedup();
    }
    for category in &request.categories {
        if all_categories
            .insert(category.id.as_str(), category)
            .is_some_and(|old| old != category)
        {
            return Err(MerchantAnalysisError::ConflictingSourceId);
        }
        if !category.deleted {
            categories.insert(category.id.as_str(), category);
        }
    }
    let mut rule_ids = HashMap::new();
    for rule in &request.rules {
        if rule_ids
            .insert(rule.id.as_str(), rule)
            .is_some_and(|old| old != rule)
        {
            return Err(MerchantAnalysisError::ConflictingSourceId);
        }
    }
    let alias_index = aliases(request)?;
    let corrections = current_corrections(request)?;
    let calendars = calendar_index(request)?;
    let decisions = pattern_decisions(request)?;
    let rules = rule_index(request, &categories);
    let account_ids: BTreeSet<_> = request
        .source_admission
        .source_account_ids
        .iter()
        .map(String::as_str)
        .collect();
    let category_ids: BTreeSet<_> = request
        .source_admission
        .source_category_ids
        .iter()
        .map(String::as_str)
        .collect();
    let currency_known: HashMap<_, _> = request
        .source_admission
        .account_coverage
        .iter()
        .map(|a| {
            (
                a.account_id.as_str(),
                (
                    a.currency_state == MerchantCurrencyState::Known,
                    a.state == MerchantCollectionState::Complete,
                ),
            )
        })
        .collect();
    let mut occurrence_complete: HashMap<(&str, &str), bool> = HashMap::new();
    let mut prepared = Vec::with_capacity(transactions.len());
    // Ordinary uncategorized financial leaves still match native rules when their
    // pending/cleared/date state excludes them from history and recurrence.
    let mut native_only = Vec::new();
    let empty_display: Rc<str> = Rc::from("");
    let mut coverage_reasons = BTreeSet::new();
    type Resolution<'a> = (Option<&'a str>, bool, Rc<Vec<&'a MerchantAlias>>);
    type ResolutionKey<'a> = (&'a str, Option<&'a str>, [Option<Rc<str>>; 5]);
    let mut resolutions: HashMap<ResolutionKey<'_>, Resolution<'_>> = HashMap::new();
    for tx in &transactions {
        require(
            account_ids.contains(tx.account_id.as_str())
                && tx
                    .category_id
                    .as_deref()
                    .is_none_or(|id| category_ids.contains(id)),
            "source_dependency",
        )?;
        let observed = date(&tx.date)?;
        let is_eligible = eligible(tx, observed, start, end)
            && tx
                .payee_id
                .as_deref()
                .and_then(|id| payees.get(id))
                .is_none_or(|p| p.transfer_account_id.is_none());
        if !tx.is_split_parent {
            *occurrence_complete
                .entry((&tx.account_id, &tx.occurrence_id))
                .or_insert(true) &= is_eligible && tx.occurrence_complete;
        }
        if !is_eligible {
            let reason = if tx.deleted {
                "deleted"
            } else if tx.pending {
                "pending"
            } else if !tx.cleared {
                "uncleared"
            } else if tx.is_split_parent {
                "split_parent"
            } else if tx.starting_balance {
                "starting_balance"
            } else if observed < start {
                "outside_horizon"
            } else if observed > end {
                "future_transaction"
            } else {
                "transfer"
            };
            coverage_reasons.insert(reason.to_owned());
            if tx.category_id.is_some()
                || tx.deleted
                || tx.is_split_parent
                || tx.transfer_account_id.is_some()
                || tx.starting_balance
            {
                continue;
            }
        }
        let fields: [Option<Rc<str>>; 5] = std::array::from_fn(|index| {
            // Stable IDs bypass unconfirmed text. Otherwise inspect all available
            // source fields, retaining only known names/aliases (plus imported text
            // needed for unresolved recurrence grouping), not unknown private notes.
            let needs_source = (index < 4 && tx.payee_id.is_none())
                || [Some(tx.account_id.as_str()), None]
                    .iter()
                    .any(|account| alias_index.contains_key(&(index, *account)));
            if !needs_source {
                return None;
            }
            let raw = if index == 4 {
                tx.payee_name.as_deref()
            } else {
                let source = source_fields(tx)[index].1;
                (source.state == MerchantTextState::Present)
                    .then_some(source.value.as_deref())
                    .flatten()
            };
            raw.and_then(|raw| {
                let normalized = normalizations
                    .get(raw)
                    .map(|value| Cow::Borrowed(value.as_ref()))
                    .unwrap_or_else(|| Cow::Owned(normalize_merchant_intelligence(raw)));
                if index < 4 && tx.payee_id.is_none() {
                    if let Some((known, _)) = names.get_key_value(normalized.as_ref()) {
                        return Some(Rc::clone(
                            normalizations
                                .entry(raw)
                                .or_insert_with(|| Rc::clone(known)),
                        ));
                    }
                }
                let matched_alias = [Some(tx.account_id.as_str()), None].iter().any(|account| {
                    alias_index
                        .get(&(index, *account))
                        .is_some_and(|scope| scope.contains_key(normalized.as_ref()))
                });
                if matched_alias || (index == 0 && tx.payee_id.is_none()) {
                    let value = normalizations
                        .get(raw)
                        .cloned()
                        .unwrap_or_else(|| Rc::from(normalized.into_owned()));
                    normalizations
                        .entry(raw)
                        .or_insert_with(|| Rc::clone(&value));
                    Some(value)
                } else {
                    None
                }
            })
        });
        let relevant: [Option<Rc<str>>; 5] = std::array::from_fn(|field| {
            fields[field]
                .as_ref()
                .filter(|normalized| {
                    (field < 4 && tx.payee_id.is_none() && names.contains_key(normalized.as_ref()))
                        || [Some(tx.account_id.as_str()), None].iter().any(|account| {
                            alias_index
                                .get(&(field, *account))
                                .is_some_and(|scope| scope.contains_key(normalized.as_ref()))
                        })
                })
                .cloned()
        });
        let resolution_key = (tx.account_id.as_str(), tx.payee_id.as_deref(), relevant);
        let (payee, identity_conflict, aliases) =
            resolutions.entry(resolution_key).or_insert_with(|| {
                resolve(
                    tx,
                    &fields,
                    &alias_index,
                    &names,
                    &payees,
                    request.max_evidence as usize,
                )
            });
        let display = tx
            .payee_name
            .as_deref()
            .map(|raw| {
                Rc::clone(
                    normalizations
                        .entry(raw)
                        .or_insert_with(|| Rc::from(normalize_merchant_intelligence(raw))),
                )
            })
            .unwrap_or_else(|| Rc::clone(&empty_display));
        let rule_name = tx
            .payee_name
            .as_deref()
            .filter(|_| rules.uses_payee_name())
            .map(|raw| {
                Rc::clone(
                    lower_names
                        .entry(raw)
                        .or_insert_with(|| Rc::from(raw.to_lowercase())),
                )
            });
        let row = Prepared {
            tx,
            date: observed,
            fields,
            display,
            rule_name,
            payee: *payee,
            identity_conflict: *identity_conflict,
            aliases: Rc::clone(aliases),
        };
        if is_eligible {
            prepared.push(row);
        } else {
            native_only.push(row);
        }
    }
    let cap = request.max_evidence as usize;
    let mut histories: HashMap<GroupKey<'_>, History<'_>> = HashMap::new();
    for (index, row) in prepared.iter().enumerate() {
        if row.payee.is_none() || row.identity_conflict {
            continue;
        }
        let confirmed = correction_categories(row, &corrections, &categories);
        let targets: BTreeSet<_> = confirmed.iter().map(|c| c.category_id.as_str()).collect();
        let category = if targets.len() > 1 {
            None
        } else if let Some(target) = targets.first() {
            Some(*target)
        } else {
            row.tx
                .category_id
                .as_deref()
                .filter(|id| categories.contains_key(id))
        };
        if let Some(category) = category {
            let history = histories.entry(group(row)).or_insert_with(|| History {
                entries: BTreeMap::new(),
                ranked: Vec::new(),
                total: 0,
                winner: None,
            });
            let entry = history
                .entries
                .entry(category)
                .or_insert_with(|| HistoryEntry {
                    count: 0,
                    ledger_count: 0,
                    correction_count: 0,
                    first: row.date,
                    last: row.date,
                    samples: Vec::new(),
                });
            entry.count = entry
                .count
                .checked_add(1)
                .expect("bounded admitted outcomes");
            let role = if targets.is_empty() {
                &mut entry.ledger_count
            } else {
                &mut entry.correction_count
            };
            *role = role.checked_add(1).expect("bounded admitted outcomes");
            entry.first = entry.first.min(row.date);
            entry.last = entry.last.max(row.date);
            history.total = history
                .total
                .checked_add(1)
                .expect("bounded admitted outcomes");
            if entry.samples.len() < cap {
                entry.samples.push(index);
            }
        }
    }
    for history in histories.values_mut() {
        history.ranked.extend(history.entries.keys().copied());
        history.ranked.sort_unstable_by(|a, b| {
            history.entries[b]
                .count
                .cmp(&history.entries[a].count)
                .then(a.cmp(b))
        });
        if let Some(&category) = history.ranked.first() {
            let count = history.entries[category].count;
            if count >= 3
                && u64::from(count) * 100 >= u64::from(history.total) * 90
                && history
                    .ranked
                    .get(1)
                    .is_none_or(|next| history.entries[next].count < count)
            {
                history.winner = Some((category, count));
            }
        }
    }
    let mut occurrence_rows: BTreeMap<(&str, &str), Vec<usize>> = BTreeMap::new();
    for (index, row) in prepared.iter().enumerate() {
        occurrence_rows
            .entry((&row.tx.account_id, &row.tx.occurrence_id))
            .or_default()
            .push(index);
    }
    let mut recurring: BTreeMap<GroupKey<'_>, Vec<Occurrence<'_>>> = BTreeMap::new();
    for (identity, indices) in occurrence_rows {
        let first = &prepared[indices[0]];
        let key = group(first);
        if !occurrence_complete.get(&identity).copied().unwrap_or(false)
            || first.identity_conflict
            || indices.iter().any(|index| {
                let row = &prepared[*index];
                row.identity_conflict
                    || group(row) != key
                    || row.date != first.date
                    || (indices.len() > 1 && !row.tx.is_split_child)
            })
        {
            coverage_reasons.insert(
                if indices
                    .iter()
                    .any(|index| prepared[*index].identity_conflict)
                {
                    "identity_conflict"
                } else if indices
                    .iter()
                    .any(|index| prepared[*index].tx.is_split_child)
                {
                    "split_ambiguous"
                } else {
                    "occurrence_incomplete"
                }
                .into(),
            );
            continue;
        }
        let sum = indices.iter().try_fold(0i128, |sum, index| {
            sum.checked_add(i128::from(prepared[*index].tx.amount.minor_units()))
        });
        let Some(amount) = sum.and_then(|sum| i64::try_from(sum).ok()) else {
            coverage_reasons.insert("split_amount_overflow".into());
            continue;
        };
        if key.identity.is_empty() {
            continue;
        }
        recurring.entry(key).or_default().push(Occurrence {
            date: first.date,
            source_id: &first.tx.id,
            amount,
        });
    }
    let mut recurrences = Vec::with_capacity(recurring.len());
    let mut occurrence_distributions = HashMap::new();
    for (key, mut occurrences) in recurring {
        if occurrences.len() < 2 {
            continue;
        }
        let normalized = normalized_payees
            .get(key.identity)
            .map(|value: &Rc<str>| value.as_ref())
            .unwrap_or(if key.stable { "" } else { key.identity });
        let known = currency_known
            .get(key.account)
            .map(|state| state.0)
            .unwrap_or(false);
        let mut recurrence = build_recurrence(
            key,
            &mut occurrences,
            request,
            &calendars,
            known,
            &decisions,
            if normalized.len() <= MAX_TEXT {
                normalized
            } else {
                ""
            },
            &seed,
            &mut occurrence_distributions,
        );
        if normalized.len() > MAX_TEXT {
            recurrence.reason_codes.push("normalized_text_limit".into());
        }
        recurrences.push(recurrence);
    }
    recurrences.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    let mut suggestions = Vec::new();
    let mut match_cache = RuleMatchCache::default();
    let mut native_sets = NativeRuleSetRegistry::default();
    let mut native_rule_classifications = Vec::new();
    let mut category_classifications = Vec::new();
    let authoritative_complete = request.source_admission.collections.payees
        == MerchantCollectionState::Complete
        && request.source_admission.collections.categories == MerchantCollectionState::Complete
        && request.source_admission.collections.rules == MerchantCollectionState::Complete
        && request.source_admission.pending_state != MerchantPendingState::Unsupported;
    for (row, history_eligible) in prepared
        .iter()
        .map(|row| (row, true))
        .chain(native_only.iter().map(|row| (row, false)))
        .filter(|(row, _)| {
            row.tx.category_id.is_none()
                && !row.tx.deleted
                && !row.tx.is_split_parent
                && row.tx.transfer_account_id.is_none()
                && !row.tx.starting_balance
        })
    {
        let matching = cached_rule_matches(row, &rules, &mut match_cache);
        let confirmed = correction_categories(row, &corrections, &categories);
        let known = currency_known
            .get(row.tx.account_id.as_str())
            .is_some_and(|state| state.0);
        let history_admitted = history_eligible && known && authoritative_complete;
        let winner = histories
            .get(&group(row))
            .and_then(|history| history.winner);
        let selected = resolve_category(
            row,
            &confirmed,
            &categories,
            matching,
            winner,
            history_admitted,
        );
        let Some(category) = selected.category else {
            continue;
        };
        if let Some(index) = native_sets.register(&rules, matching, category) {
            native_rule_classifications.push(MerchantNativeRuleClassification {
                transaction_id: row.tx.id.clone(),
                account_id: row.tx.account_id.clone(),
                category_id: category.into(),
                rule_set_index: index,
            });
        } else if matches!(
            selected.tier,
            MerchantEvidenceTier::Confirmed | MerchantEvidenceTier::Inferred
        ) {
            category_classifications.push(MerchantCategoryClassification {
                transaction_id: row.tx.id.clone(),
                account_id: row.tx.account_id.clone(),
                payee_id: row.payee.map(str::to_owned),
                category_id: category.into(),
                tier: selected.tier,
                evidence_revision: derived_hash(&seed, &row.tx.id),
            });
        }
    }
    native_rule_classifications.sort_unstable_by(|a, b| a.transaction_id.cmp(&b.transaction_id));
    category_classifications.sort_unstable_by(|a, b| a.transaction_id.cmp(&b.transaction_id));
    let suggestion_page = if let Some(selection) = &request.suggestion_selection {
        let selected: BTreeSet<_> = selection
            .transaction_ids
            .iter()
            .map(String::as_str)
            .collect();
        let eligible_candidates = prepared
            .iter()
            .filter(|p| selected.contains(p.tx.id.as_str()))
            .count() as u32;
        let mut candidates = prepared.iter().filter(|p| {
            selected.contains(p.tx.id.as_str())
                && selection
                    .cursor
                    .as_deref()
                    .is_none_or(|cursor| p.tx.id.as_str() > cursor)
        });
        suggestions.reserve(selection.limit as usize);
        for row in candidates.by_ref().take(selection.limit as usize) {
            let matching = cached_rule_matches(row, &rules, &mut match_cache);
            let (known, complete) = currency_known
                .get(row.tx.account_id.as_str())
                .copied()
                .unwrap_or((false, false));
            suggestions.push(build_suggestion(
                row,
                &prepared,
                request,
                &histories,
                &corrections,
                &categories,
                &rules,
                matching,
                known,
                complete,
                &names,
                &payees,
                &mut normalizations,
                &seed,
            ));
        }
        let next_cursor = candidates
            .next()
            .and_then(|_| suggestions.last().map(|s| s.transaction_id.clone()));
        Some(MerchantSuggestionPage {
            eligible_candidates,
            returned: suggestions.len() as u32,
            next_cursor,
        })
    } else {
        suggestions.reserve(prepared.len());
        for row in &prepared {
            let matching = cached_rule_matches(row, &rules, &mut match_cache);
            let (known, complete) = currency_known
                .get(row.tx.account_id.as_str())
                .copied()
                .unwrap_or((false, false));
            suggestions.push(build_suggestion(
                row,
                &prepared,
                request,
                &histories,
                &corrections,
                &categories,
                &rules,
                matching,
                known,
                complete,
                &names,
                &payees,
                &mut normalizations,
                &seed,
            ));
        }
        None
    };
    let mut scheduled_expectations = Vec::with_capacity(request.schedules.len());
    let mut schedule_ids = HashMap::new();
    for schedule in &request.schedules {
        if let Some(previous) = schedule_ids.insert(schedule.source.id.as_str(), schedule) {
            if previous != schedule {
                return Err(MerchantAnalysisError::ConflictingSourceId);
            }
            continue;
        }
        let (state, conflict) = decision_state(&schedule.source.id, &decisions);
        let mut reasons = Vec::new();
        if schedule.source.amount.is_none() {
            reasons.push("schedule_amount_uncertain".into());
        }
        if schedule.source.account_id.is_none() || schedule.payee_id.is_none() {
            reasons.push("schedule_identity_uncertain".into());
        }
        if conflict {
            reasons.push("pattern_decision_conflict".into());
        }
        if state == MerchantDecisionState::Rejected {
            reasons.push("pattern_rejected".into());
        }
        scheduled_expectations.push(MerchantScheduledExpectation {
            id: schedule.source.id.clone(),
            payee_id: schedule.payee_id.clone(),
            source: schedule.source.clone(),
            reason_codes: reasons,
            decision_state: state,
        });
    }
    scheduled_expectations.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    let admission = &request.source_admission;
    let limited = admission.truncated_count > 0
        || admission.collections.transactions != MerchantCollectionState::Complete;
    if admission.truncated_count > 0 {
        coverage_reasons.insert("input_truncated".into());
    }
    if admission.collections.transactions != MerchantCollectionState::Complete {
        coverage_reasons.insert("history_incomplete".into());
    }
    if admission.collections.schedules != MerchantCollectionState::Complete {
        coverage_reasons.insert("schedules_unavailable".into());
    }
    let input_count = admission.original_transaction_count;
    Ok(MerchantAnalysisResult {
        schema_version: "1".into(),
        scope: request.scope.clone(),
        snapshot_id: request.snapshot_id.clone(),
        normalization_version: "merchant/2".into(),
        source_admission: admission.clone(),
        coverage: MerchantCoverage {
            start_date: prepared
                .iter()
                .map(|p| p.date)
                .min()
                .map(|d| d.format("%Y-%m-%d").to_string()),
            end_date: prepared
                .iter()
                .map(|p| p.date)
                .max()
                .map(|d| d.format("%Y-%m-%d").to_string()),
            input_count,
            eligible_count: prepared.len() as u32,
            excluded_count: input_count - prepared.len() as u32,
            limited,
            reason_codes: coverage_reasons.into_iter().collect(),
        },
        suggestions,
        recurrences,
        scheduled_expectations,
        suggestion_page,
        category_classifications,
        native_rule_blocks: rules.native_blocks(),
        native_rule_parts: native_sets.parts,
        native_rule_sets: native_sets.sets,
        native_rule_classifications,
    })
}

fn read_present_option<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(remote = "Payee", rename_all = "camelCase", deny_unknown_fields)]
struct PayeeWire {
    id: String,
    name: String,
    #[serde(deserialize_with = "read_nullable")]
    transfer_account_id: Option<String>,
    #[serde(deserialize_with = "read_nullable")]
    mtid: Option<String>,
}
#[derive(Deserialize)]
#[serde(transparent)]
struct StrictPayee(#[serde(with = "PayeeWire")] Payee);
fn read_payees<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Payee>, D::Error> {
    Vec::<StrictPayee>::deserialize(d)
        .map(|values| values.into_iter().map(|value| value.0).collect())
}
#[derive(Deserialize)]
#[serde(remote = "Category", rename_all = "camelCase", deny_unknown_fields)]
struct CategoryWire {
    id: String,
    name: String,
    #[serde(deserialize_with = "read_nullable")]
    group_name: Option<String>,
    is_income: bool,
    #[serde(deserialize_with = "read_nullable")]
    mtid: Option<String>,
    deleted: bool,
}
#[derive(Deserialize)]
#[serde(transparent)]
struct StrictCategory(#[serde(with = "CategoryWire")] Category);
fn read_categories<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Category>, D::Error> {
    Vec::<StrictCategory>::deserialize(d)
        .map(|values| values.into_iter().map(|value| value.0).collect())
}
#[derive(Deserialize)]
#[serde(remote = "Rule", rename_all = "camelCase", deny_unknown_fields)]
struct RuleWire {
    id: String,
    name: String,
    order: u32,
    trigger: serde_json::Value,
    actions: serde_json::Value,
    inactive: bool,
}
#[derive(Deserialize)]
#[serde(transparent)]
struct StrictRule(#[serde(with = "RuleWire")] Rule);
fn read_rules<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Rule>, D::Error> {
    Vec::<StrictRule>::deserialize(d)
        .map(|values| values.into_iter().map(|value| value.0).collect())
}
fn validate_rule_json(value: &serde_json::Value) -> Result<(), MerchantAnalysisError> {
    let mut stack = vec![(value, 0)];
    let mut nodes = 0;
    while let Some((value, depth)) = stack.pop() {
        nodes += 1;
        require(nodes <= 10000 && depth <= 32, "rule_payload_bounds")?;
        match value {
            serde_json::Value::String(value) => require(text(value), "rule_text")?,
            serde_json::Value::Array(values) => stack.extend(values.iter().map(|v| (v, depth + 1))),
            serde_json::Value::Object(values) => {
                require(values.keys().all(|v| text(v)), "rule_key")?;
                stack.extend(values.values().map(|v| (v, depth + 1)));
            }
            _ => {}
        }
    }
    Ok(())
}
fn validate_duplicate_sources(
    transactions: &[MerchantTransaction],
) -> Result<(), MerchantAnalysisError> {
    let mut ids = HashMap::with_capacity(transactions.len());
    let mut imports = HashMap::new();
    for tx in transactions {
        if ids.insert(tx.id.as_str(), tx).is_some_and(|old| old != tx) {
            return Err(MerchantAnalysisError::ConflictingSourceId);
        }
        if let Some(imported) = &tx.imported_id {
            if imports
                .insert((tx.account_id.as_str(), imported.as_str()), tx)
                .is_some_and(|old| !same_source(old, tx))
            {
                return Err(MerchantAnalysisError::ConflictingSourceId);
            }
        }
    }
    Ok(())
}

fn cached_rule_matches<'a, 'cache>(
    row: &Prepared<'a>,
    rules: &RuleIndex<'a>,
    cache: &'cache mut RuleMatchCache<'a>,
) -> &'cache RuleMatches<'a> {
    rules.cached_matches(
        [
            row.tx.payee_id.as_deref(),
            row.rule_name.as_deref(),
            Some(row.tx.account_id.as_str()),
            row.tx.category_id.as_deref(),
        ],
        cache,
    )
}

fn read_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
#[derive(Deserialize)]
#[serde(
    remote = "ScheduleRecurrence",
    rename_all = "camelCase",
    deny_unknown_fields
)]
struct RecurrenceWire {
    frequency: crate::liquidity::ScheduleFrequency,
    #[serde(deserialize_with = "read_nullable")]
    interval: Option<u32>,
    #[serde(deserialize_with = "read_nullable")]
    patterns: Option<Vec<crate::liquidity::ScheduleRecurrencePattern>>,
    start: String,
    #[serde(deserialize_with = "read_nullable")]
    end_mode: Option<crate::liquidity::ScheduleEndMode>,
    #[serde(deserialize_with = "read_nullable")]
    end_occurrences: Option<u32>,
    #[serde(deserialize_with = "read_nullable")]
    end_date: Option<String>,
    #[serde(deserialize_with = "read_nullable")]
    skip_weekend: Option<bool>,
    #[serde(deserialize_with = "read_nullable")]
    weekend_solve_mode: Option<crate::liquidity::ScheduleWeekendSolveMode>,
}
#[derive(Deserialize)]
#[serde(transparent)]
struct StrictRecurrence(#[serde(with = "RecurrenceWire")] ScheduleRecurrence);
fn read_recurrence<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<Option<ScheduleRecurrence>, D::Error> {
    Option::<StrictRecurrence>::deserialize(d).map(|value| value.map(|value| value.0))
}

fn explained_business_shift(
    calendar: &Calendar<'_>,
    nominal: NaiveDate,
    observed: NaiveDate,
) -> Option<bool> {
    if nominal == observed || business_day(calendar, nominal) {
        return None;
    }
    for direction in [-1, 1] {
        let mut holiday = calendar.holidays.contains(&nominal);
        let mut day = nominal;
        for _ in 0..7 {
            day = day.checked_add_signed(Duration::days(direction))?;
            if day < calendar.start || day > calendar.end {
                break;
            }
            if business_day(calendar, day) {
                if day == observed {
                    return Some(holiday);
                }
                break;
            }
            holiday |= calendar.holidays.contains(&day);
        }
    }
    None
}

fn nonzero_counts(values: &[u32]) -> BTreeMap<String, u32> {
    values
        .iter()
        .enumerate()
        .filter(|(_, count)| **count > 0)
        .map(|(value, count)| (value.to_string(), *count))
        .collect()
}
