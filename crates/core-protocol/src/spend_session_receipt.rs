//! Pure saved-intent/receipt comparison. Inputs never authenticate their issuer or authorize writes.
pub use crate::decision_card::{
    DecisionCardAdjustment, DecisionCardCategoryAllocation, DecisionCardPriceProvenance,
    DecisionCardWarningThreshold,
};
use crate::{resolve_transaction_evidence, ReceiptLine, TransactionEvidenceRequest};
use balanceframe_financial_core::{evidence::evidence_timestamp_valid, Money};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

macro_rules! record {
    ($name:ident { $($(#[$attribute:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        #[doc = concat!("Versioned comparison-only `", stringify!($name), "` record; no source or mutation authority.")]
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all="camelCase",deny_unknown_fields)]
        pub struct $name { $(#[doc = concat!("Exact normalized `", stringify!($field), "` value.")] #[serde(deserialize_with="required")] $(#[$attribute])* pub $field: $ty),* }
    }
}
fn required<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<T, D::Error> {
    T::deserialize(deserializer)
}
record!(SavedSessionReceiptItem {
    id: String, category_id: String, account_id: Option<String>, amount: Money, purchase_at: String, required_by: String,
    #[serde(default,skip_serializing_if="Option::is_none")] priority: Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")] quantity: Option<u32>,
    #[serde(default,skip_serializing_if="Option::is_none")] category_allocations: Option<Vec<DecisionCardCategoryAllocation>>,
    #[serde(default,skip_serializing_if="Option::is_none")] barcode: Option<String>,
    price_provenance: Option<DecisionCardPriceProvenance>
});
record!(SavedSessionReceiptIntent { kind: String, id: String, version: u64, account_id: Option<String>, items: Vec<SavedSessionReceiptItem>, adjustments: Vec<DecisionCardAdjustment>, warning_thresholds: Vec<DecisionCardWarningThreshold> });
/// Exact archived intent bytes represented as canonical JSON, retaining nullable metadata.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionReceiptSnapshot {
    /// Immutable source document identifier, requiring external authorization.
    pub document_id: String,
    /// SHA-256 of the canonical archived intent.
    pub content_hash: String,
    /// Version of the archive parser.
    pub parser_version: String,
    /// SHA-256 of the exact canonical saved intent.
    pub intent_hash: String,
    /// Strictly typed saved intent; source authority is never inferred here.
    pub intent: SavedSessionReceiptIntent,
    raw_intent: Value,
}
impl<'de> Deserialize<'de> for SessionReceiptSnapshot {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            document_id: String,
            content_hash: String,
            parser_version: String,
            intent_hash: String,
            intent: Value,
        }
        let wire = Wire::deserialize(deserializer)?;
        let intent =
            serde_json::from_value(wire.intent.clone()).map_err(serde::de::Error::custom)?;
        Ok(Self {
            document_id: wire.document_id,
            content_hash: wire.content_hash,
            parser_version: wire.parser_version,
            intent_hash: wire.intent_hash,
            intent,
            raw_intent: wire.intent,
        })
    }
}
impl Serialize for SessionReceiptSnapshot {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        json!({"documentId":self.document_id,"contentHash":self.content_hash,"parserVersion":self.parser_version,"intentHash":self.intent_hash,"intent":self.raw_intent}).serialize(serializer)
    }
}
record!(SessionReceiptSelection {
    document_id: String,
    receipt_id: String
});
record!(SessionReceiptPair {
    session_item_id: String,
    receipt_line_id: String,
    kind: String
});
record!(SessionReceiptReview { coverage: String, pairs: Vec<SessionReceiptPair>, omitted_item_ids: Vec<String>, new_line_ids: Vec<String> });
record!(CompareSpendSessionReceiptRequest {
    contract_version: String,
    session_snapshot: SessionReceiptSnapshot,
    evidence: TransactionEvidenceRequest,
    receipt: SessionReceiptSelection,
    review: SessionReceiptReview
});
record!(SessionReceiptRow { session_item_id: Option<String>, receipt_line_id: Option<String>, status: String, changes: Vec<String>, quantity_comparison: String, price_comparison: String, price_basis: Option<String>, planned_quantity_micros: Option<u64>, observed_quantity_micros: Option<u32>, planned_reference: Option<Money>, observed_reference: Option<Money>, reason_codes: Vec<String> });
record!(SessionReceiptCandidate { session_item_id: String, receipt_line_id: String, reason_codes: Vec<String> });
record!(CompareSpendSessionReceiptResult { contract_version: String, authority: String, comparison_hash: String, session_document_id: String, session_id: String, session_version: u64, intent_hash: String, receipt_document_id: String, receipt_id: String, resolution_hash: String, state: String, receipt_total: Money, rows: Vec<SessionReceiptRow>, candidates: Vec<SessionReceiptCandidate>, reason_codes: Vec<String> });

/// Invalid normalized comparison input; no financial consequence is returned.
#[derive(Debug, thiserror::Error, PartialEq)]
#[error("invalid spend session receipt comparison: {0}")]
pub struct SpendSessionReceiptError(pub &'static str);
type Result<T, E = SpendSessionReceiptError> = std::result::Result<T, E>;
fn require(ok: bool, code: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(SpendSessionReceiptError(code))
    }
}
fn id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn money(value: &Money) -> bool {
    value.minor_units() > 0
        && value.currency().len() == 3
        && value.currency().bytes().all(|b| b.is_ascii_uppercase())
}
fn optional_id(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(id)
}
fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(value).map_err(|_| SpendSessionReceiptError("serialization"))?
        )
    ))
}
fn validate_snapshot(snapshot: &SessionReceiptSnapshot) -> Result<()> {
    let intent = &snapshot.intent;
    require(
        id(&snapshot.document_id)
            && id(&snapshot.parser_version)
            && hash(&snapshot.content_hash)
            && hash(&snapshot.intent_hash),
        "snapshot_identity",
    )?;
    require(
        intent.kind == "session_completion_intent_v1"
            && id(&intent.id)
            && intent.version > 0
            && intent.version <= 9007199254740991
            && optional_id(&intent.account_id),
        "session_identity",
    )?;
    require(
        intent.items.len() <= 100
            && intent.adjustments.len() <= 100
            && intent.warning_thresholds.len() <= 100,
        "session_size",
    )?;
    require(
        snapshot.raw_intent["items"]
            .as_array()
            .is_some_and(|items| {
                items.iter().all(|item| {
                    ["quantity", "priority", "barcode", "categoryAllocations"]
                        .iter()
                        .all(|field| item.get(field).is_none_or(|value| !value.is_null()))
                })
            }),
        "session_item_metadata",
    )?;
    let mut ids = BTreeSet::new();
    for item in &intent.items {
        require(
            id(&item.id)
                && ids.insert(&item.id)
                && id(&item.category_id)
                && optional_id(&item.account_id)
                && money(&item.amount)
                && evidence_timestamp_valid(&item.purchase_at)
                && evidence_timestamp_valid(&item.required_by),
            "session_item",
        )?;
        require(
            item.quantity != Some(0)
                && item
                    .priority
                    .as_deref()
                    .is_none_or(|v| ["required", "planned", "optional"].contains(&v))
                && optional_id(&item.barcode),
            "session_item_metadata",
        )?;
        if let Some(allocations) = &item.category_allocations {
            require(
                !allocations.is_empty()
                    && allocations.len() <= 100
                    && allocations.iter().all(|a| {
                        id(&a.category_id)
                            && money(&a.amount)
                            && a.amount.currency() == item.amount.currency()
                    }),
                "session_category_allocations",
            )?;
        }
        if let Some(price) = &item.price_provenance {
            require(
                ["current_session_manual", "outside_price"].contains(&price.kind.as_str())
                    && evidence_timestamp_valid(&price.observed_at)
                    && optional_id(&price.source)
                    && optional_id(&price.store)
                    && (price.kind != "outside_price" || price.source.is_some()),
                "session_price_provenance",
            )?;
        }
    }
    for adjustment in &intent.adjustments {
        require(
            ["tax", "fee", "discount"].contains(&adjustment.kind.as_str())
                && id(&adjustment.category_id)
                && money(&adjustment.amount),
            "session_adjustment",
        )?;
    }
    let mut warnings = BTreeSet::new();
    for warning in &intent.warning_thresholds {
        require(
            id(&warning.id)
                && warnings.insert(&warning.id)
                && ["cart_total", "category_charge"].contains(&warning.basis.as_str())
                && optional_id(&warning.category_id)
                && money(&warning.maximum)
                && (warning.basis != "category_charge" || warning.category_id.is_some()),
            "session_warning",
        )?;
    }
    // Retain exact nullable/optional fields used by the existing Phase 8.6 canonical hash.
    require(
        serde_json::from_value::<SavedSessionReceiptIntent>(snapshot.raw_intent.clone())
            .ok()
            .as_ref()
            == Some(intent),
        "session_snapshot_intent_changed",
    )?;
    let expected = digest(&snapshot.raw_intent)?;
    require(
        snapshot.intent_hash == expected && snapshot.content_hash == expected,
        "session_snapshot_hash",
    )
}
fn row(
    item: Option<&SavedSessionReceiptItem>,
    line: Option<&ReceiptLine>,
    status: &str,
) -> Result<SessionReceiptRow> {
    let planned_quantity_micros = item
        .and_then(|i| i.quantity)
        .map(|quantity| {
            u64::from(quantity)
                .checked_mul(1000000)
                .ok_or(SpendSessionReceiptError("quantity_overflow"))
        })
        .transpose()?;
    let mut result = SessionReceiptRow {
        session_item_id: item.map(|i| i.id.clone()),
        receipt_line_id: line.map(|l| l.id.clone()),
        status: status.into(),
        changes: vec![],
        quantity_comparison: "unknown".into(),
        price_comparison: "unknown".into(),
        price_basis: None,
        planned_quantity_micros,
        observed_quantity_micros: line.map(|l| l.quantity_micros),
        planned_reference: item.map(|i| i.amount.clone()),
        observed_reference: None,
        reason_codes: vec![],
    };
    if let (Some(item), Some(line)) = (item, line) {
        if let Some(quantity) = planned_quantity_micros {
            result.quantity_comparison = if quantity == u64::from(line.quantity_micros) {
                "same"
            } else {
                result.changes.push("quantity_changed".into());
                "changed"
            }
            .into();
        }
        let unit = item.quantity.is_some();
        let observed = if unit { &line.unit_gross } else { &line.gross };
        result.price_basis = Some(
            if unit {
                "unit_amount_vs_unit_gross"
            } else {
                "line_amount_vs_line_gross"
            }
            .into(),
        );
        result.observed_reference = Some(observed.clone());
        if item.amount.currency() != observed.currency() {
            result.price_comparison = "currency_mismatch".into();
            result.reason_codes.push("currency_mismatch".into());
        } else if &item.amount == observed {
            result.price_comparison = "same".into();
        } else {
            result.price_comparison = "changed".into();
            result.changes.push(
                if unit {
                    "reference_price_changed"
                } else {
                    "line_amount_changed"
                }
                .into(),
            );
        }
        if item.price_provenance.as_ref().is_some_and(|p| p.estimate) {
            result.reason_codes.push("estimated_reference_price".into());
        }
    }
    Ok(result)
}

/// Compare one archived saved intent with conserved purchase-receipt facts; never authenticate sources, settle plans, or emit ledger effects.
pub fn compare_spend_session_receipt(
    request: &CompareSpendSessionReceiptRequest,
) -> Result<CompareSpendSessionReceiptResult> {
    require(request.contract_version == "1", "contract_version")?;
    validate_snapshot(&request.session_snapshot)?;
    require(
        id(&request.receipt.document_id) && id(&request.receipt.receipt_id),
        "receipt_selection",
    )?;
    let review = &request.review;
    require(
        ["complete_purchase", "partial_purchase", "unknown"].contains(&review.coverage.as_str())
            && review.pairs.len() <= 100
            && review.omitted_item_ids.len() <= 100
            && review.new_line_ids.len() <= 1000,
        "review_shape",
    )?;
    require(
        review.omitted_item_ids.is_empty() || review.coverage == "complete_purchase",
        "omission_requires_complete_purchase",
    )?;
    let evidence = resolve_transaction_evidence(&request.evidence)
        .map_err(|error| SpendSessionReceiptError(error.0))?;
    let receipt = request
        .evidence
        .receipts
        .iter()
        .find(|r| r.id == request.receipt.receipt_id)
        .ok_or(SpendSessionReceiptError("receipt_missing"))?;
    let observation = request
        .evidence
        .observations
        .iter()
        .find(|o| o.id == receipt.observation_id)
        .ok_or(SpendSessionReceiptError("receipt_observation_missing"))?;
    require(
        observation.provenance.document_id == request.receipt.document_id,
        "receipt_document_mismatch",
    )?;
    let items: BTreeMap<_, _> = request
        .session_snapshot
        .intent
        .items
        .iter()
        .map(|i| (i.id.as_str(), i))
        .collect();
    let lines: BTreeMap<_, _> = receipt.lines.iter().map(|l| (l.id.as_str(), l)).collect();
    let mut used_items = BTreeSet::new();
    let mut used_lines = BTreeSet::new();
    for pair in &review.pairs {
        require(
            ["same_item", "substitution"].contains(&pair.kind.as_str())
                && items.contains_key(pair.session_item_id.as_str())
                && lines.contains_key(pair.receipt_line_id.as_str())
                && used_items.insert(pair.session_item_id.as_str())
                && used_lines.insert(pair.receipt_line_id.as_str()),
            "invalid_or_duplicate_pair",
        )?;
    }
    for id in &review.omitted_item_ids {
        require(
            items.contains_key(id.as_str()) && used_items.insert(id.as_str()),
            "invalid_or_duplicate_omission",
        )?;
    }
    for id in &review.new_line_ids {
        require(
            lines.contains_key(id.as_str()) && used_lines.insert(id.as_str()),
            "invalid_or_duplicate_new_line",
        )?;
    }
    let mut canonical_pairs = review.pairs.clone();
    canonical_pairs.sort_by(|a, b| {
        (&a.session_item_id, &a.receipt_line_id, &a.kind).cmp(&(
            &b.session_item_id,
            &b.receipt_line_id,
            &b.kind,
        ))
    });
    let mut omitted = review.omitted_item_ids.clone();
    omitted.sort();
    let mut new = review.new_line_ids.clone();
    new.sort();
    let comparison_hash = digest(
        &json!({"contractVersion":request.contract_version,"sessionDocumentId":request.session_snapshot.document_id,"sessionParserVersion":request.session_snapshot.parser_version,"intentHash":request.session_snapshot.intent_hash,"receipt":request.receipt,"resolutionHash":evidence.resolution_hash,"review":{"coverage":review.coverage,"pairs":canonical_pairs,"omittedItemIds":omitted,"newLineIds":new}}),
    )?;
    let mut result = CompareSpendSessionReceiptResult {
        contract_version: "1".into(),
        authority: "comparison_only".into(),
        comparison_hash,
        session_document_id: request.session_snapshot.document_id.clone(),
        session_id: request.session_snapshot.intent.id.clone(),
        session_version: request.session_snapshot.intent.version,
        intent_hash: request.session_snapshot.intent_hash.clone(),
        receipt_document_id: request.receipt.document_id.clone(),
        receipt_id: receipt.id.clone(),
        resolution_hash: evidence.resolution_hash.clone(),
        state: "complete".into(),
        receipt_total: receipt.total.clone(),
        rows: vec![],
        candidates: vec![],
        reason_codes: vec![],
    };
    let current = !request
        .evidence
        .receipts
        .iter()
        .any(|r| r.supersedes_id.as_deref() == Some(receipt.id.as_str()));
    if !current
        || !evidence
            .receipts
            .iter()
            .any(|r| r.receipt_id == receipt.id && r.valid)
        || observation.status != "completed"
        || observation.direction != "outflow"
        || observation.event_type != "purchase"
        || receipt.lines.iter().any(|l| l.return_of_line_id.is_some())
    {
        result.state = "blocked".into();
        result
            .reason_codes
            .push("receipt_not_valid_current_purchase".into());
        return Ok(result);
    }
    for item in items.values() {
        if let Some(pair) = review.pairs.iter().find(|p| p.session_item_id == item.id) {
            result.rows.push(row(
                Some(item),
                Some(lines[pair.receipt_line_id.as_str()]),
                if pair.kind == "substitution" {
                    "substituted"
                } else {
                    "matched"
                },
            )?);
        } else {
            result.rows.push(row(
                Some(item),
                None,
                if used_items.contains(item.id.as_str()) {
                    "omitted"
                } else {
                    "unresolved"
                },
            )?);
        }
    }
    for line in lines.values().filter(|line| {
        !review
            .pairs
            .iter()
            .any(|pair| pair.receipt_line_id == line.id)
    }) {
        result.rows.push(row(
            None,
            Some(line),
            if used_lines.contains(line.id.as_str()) {
                "new"
            } else {
                "unresolved"
            },
        )?);
    }
    let mut barcode_counts = BTreeMap::new();
    let mut sku_counts = BTreeMap::new();
    for item in items
        .values()
        .filter(|i| !used_items.contains(i.id.as_str()))
    {
        if let Some(barcode) = &item.barcode {
            *barcode_counts.entry(barcode).or_insert(0_usize) += 1;
        }
    }
    for line in lines
        .values()
        .filter(|l| !used_lines.contains(l.id.as_str()))
    {
        if let Some(sku) = &line.sku {
            *sku_counts.entry(sku).or_insert(0_usize) += 1;
        }
    }
    for item in items
        .values()
        .filter(|i| !used_items.contains(i.id.as_str()))
    {
        for line in lines
            .values()
            .filter(|l| !used_lines.contains(l.id.as_str()))
        {
            if let Some(barcode) = item
                .barcode
                .as_ref()
                .filter(|barcode| line.sku.as_ref() == Some(barcode))
            {
                let mut reasons = vec!["identifier_text_match".into()];
                if barcode_counts[barcode] > 1 || sku_counts[barcode] > 1 {
                    reasons.push("ambiguous_identifier".into());
                }
                result.candidates.push(SessionReceiptCandidate {
                    session_item_id: item.id.clone(),
                    receipt_line_id: line.id.clone(),
                    reason_codes: reasons,
                });
            }
        }
    }
    if result
        .rows
        .iter()
        .any(|row| row.status == "unresolved" || row.price_comparison == "currency_mismatch")
    {
        result.state = "review_required".into();
    }
    if review.coverage != "complete_purchase" {
        result.state = "review_required".into();
        result
            .reason_codes
            .push("purchase_coverage_incomplete".into());
    }
    Ok(result)
}
