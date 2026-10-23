//! Explicit receipt-line allocation matrices; no inferred splits or independent ledger writes.
use crate::{
    DecisionScope, EconomicEventLedgerEffect, EvidenceProvenance, EvidenceReference,
    EvidenceSettlementLineCategory, ManualTransactionSplit, ObservationKind, ObservationState,
    RedactionState, SourceObservation, TransactionEvidenceRequest, TransactionEvidenceResult,
};
use balanceframe_financial_core::Money;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
macro_rules! record{($name:ident{$( $(#[$meta:meta])* $field:ident:$ty:ty),*$(,)?})=>{#[doc=concat!("Versioned explicit allocation `",stringify!($name),"`; no issuer or write authority.")]#[derive(Debug,Clone,PartialEq,Serialize,Deserialize)]#[serde(rename_all="camelCase",deny_unknown_fields)]pub struct $name{$(#[doc=concat!("Exact normalized `",stringify!($field),"` value.")]$(#[$meta])* pub $field:$ty),*}}}
record!(EvidenceAllocationCell {
    receipt_id: String,
    line_id: String,
    target_observation_id: String,
    amount: Money
});
record!(EvidenceAllocationReview{contract_version:String,source_hash:String,allocation_set_hash:String,receipt_ids:Vec<String>,target_observation_ids:Vec<String>,line_categories:Vec<EvidenceSettlementLineCategory>,cells:Vec<EvidenceAllocationCell>});
record!(DeriveEvidenceAllocationPlanRequest{contract_version:String,evidence:TransactionEvidenceRequest,receipt_ids:Vec<String>,target_observation_ids:Vec<String>,line_categories:Vec<EvidenceSettlementLineCategory>,cells:Vec<EvidenceAllocationCell>,#[serde(default,skip_serializing_if="Option::is_none")]derive_funding_relationships:Option<bool>});
record!(EvidenceAllocationProjection{event_id:String,target_observation_id:String,ledger_transaction_id:String,evidence_ids:Vec<String>,sources:Vec<EvidenceProvenance>,ledger_effect:EconomicEventLedgerEffect});
record!(EvidenceAllocationRemainder {
    receipt_id: String,
    line_id: String,
    amount: Money
});
record!(EvidenceAllocationTargetRemainder {
    target_observation_id: String,
    amount: Money
});
record!(EvidenceAllocationPlan{contract_version:String,source_hash:String,allocation_set_hash:String,review:EvidenceAllocationReview,projections:Vec<EvidenceAllocationProjection>,remainders:Vec<EvidenceAllocationRemainder>,target_remainders:Vec<EvidenceAllocationTargetRemainder>,#[serde(default,skip_serializing_if="Option::is_none")]funding_relationships:Option<Vec<crate::EvidenceRelationship>>});
/// Invalid or unsupported allocations never grant financial consequence authority.
#[derive(Debug, thiserror::Error, PartialEq)]
#[error("invalid evidence allocation: {0}")]
pub struct EvidenceAllocationError(pub &'static str);
type Result<T> = std::result::Result<T, EvidenceAllocationError>;
fn require(ok: bool, code: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(EvidenceAllocationError(code))
    }
}
fn id(s: &str) -> bool {
    !s.trim().is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
}
fn add<K: Ord>(map: &mut BTreeMap<K, i64>, key: K, amount: i64) -> Result<()> {
    let total = map.entry(key).or_default();
    *total = total
        .checked_add(amount)
        .ok_or(EvidenceAllocationError("amount_overflow"))?;
    Ok(())
}
fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(value).map_err(|_| EvidenceAllocationError("serialization"))?
        )
    ))
}
pub(crate) fn normalize_review(review: &mut EvidenceAllocationReview) {
    review.receipt_ids.sort();
    review.target_observation_ids.sort();
    review.line_categories.sort_by(|a, b| {
        (&a.receipt_id, &a.line_id, &a.category_id).cmp(&(
            &b.receipt_id,
            &b.line_id,
            &b.category_id,
        ))
    });
    review.cells.sort_by(|a, b| {
        (&a.receipt_id, &a.line_id, &a.target_observation_id).cmp(&(
            &b.receipt_id,
            &b.line_id,
            &b.target_observation_id,
        ))
    });
}
fn baseline(
    request: &TransactionEvidenceRequest,
    targets: &[String],
) -> TransactionEvidenceRequest {
    let mut base = request.clone();
    base.allocation_review = None;
    for target in &mut base.observations {
        if targets.contains(&target.id) {
            target.ledger_effect = None;
            target.reviewed_ledger_effect = false;
        }
    }
    base
}
/// Derive one inspectable allocation set; caller must separately authenticate sources and approve effects.
pub fn derive_evidence_allocation_plan(
    request: &DeriveEvidenceAllocationPlanRequest,
) -> Result<EvidenceAllocationPlan> {
    let mut base = baseline(&request.evidence, &request.target_observation_ids);
    if request.derive_funding_relationships == Some(true) {
        derive_funding_relationships(request, &mut base)?;
    }
    let resolved =
        crate::resolve_transaction_evidence(&base).map_err(|e| EvidenceAllocationError(e.0))?;
    let review = EvidenceAllocationReview {
        contract_version: request.contract_version.clone(),
        source_hash: resolved.resolution_hash.clone(),
        allocation_set_hash: String::new(),
        receipt_ids: request.receipt_ids.clone(),
        target_observation_ids: request.target_observation_ids.clone(),
        line_categories: request.line_categories.clone(),
        cells: request.cells.clone(),
    };
    let mut plan = compute(&base, &resolved, review)?;
    if request.derive_funding_relationships == Some(true) {
        plan.funding_relationships = Some(base.relationships);
    }
    Ok(plan)
}
fn derive_funding_relationships(
    request: &DeriveEvidenceAllocationPlanRequest,
    base: &mut TransactionEvidenceRequest,
) -> Result<()> {
    require(request.cells.len() <= 10000, "allocation_shape")?;
    let mut pairs = BTreeMap::new();
    for cell in &request.cells {
        require(
            cell.amount.minor_units() > 0,
            "allocation_cell_amount_or_duplicate",
        )?;
        let key = (cell.receipt_id.clone(), cell.target_observation_id.clone());
        let amount = pairs
            .entry(key)
            .or_insert_with(|| Money::new(0, cell.amount.currency()));
        require(
            amount.currency() == cell.amount.currency(),
            "allocation_currency",
        )?;
        *amount = Money::new(
            amount
                .minor_units()
                .checked_add(cell.amount.minor_units())
                .ok_or(EvidenceAllocationError("amount_overflow"))?,
            amount.currency(),
        );
    }
    for ((receipt_id, target_id), amount) in pairs {
        let receipt = base
            .receipts
            .iter()
            .find(|r| r.id == receipt_id)
            .ok_or(EvidenceAllocationError("allocation_receipt_missing"))?;
        let source = base
            .observations
            .iter()
            .find(|o| o.id == receipt.observation_id)
            .ok_or(EvidenceAllocationError("allocation_receipt_source"))?;
        let target = base
            .observations
            .iter()
            .find(|o| o.id == target_id)
            .ok_or(EvidenceAllocationError("allocation_target_missing"))?;
        let from_id = source.id.clone();
        let evidence_ids = vec![
            source.provenance.document_id.clone(),
            target.provenance.document_id.clone(),
        ];
        base.relationships.retain(|edge| {
            !(edge.from_id == from_id
                && edge.to_id == target_id
                && matches!(
                    edge.kind.as_str(),
                    "funding" | "partial_funding" | "settlement"
                ))
        });
        base.relationships.push(crate::EvidenceRelationship {
            id: format!("allocation:{}", digest(&(receipt_id, &target_id))?),
            from_id,
            to_id: target_id,
            kind: "partial_funding".into(),
            state: "confirmed".into(),
            allocated_amount: Some(amount),
            partial: true,
            score: 100,
            reason_codes: vec!["human_receipt_allocation".into()],
            evidence_ids,
        });
    }
    Ok(())
}

fn compute(
    base: &TransactionEvidenceRequest,
    resolved: &TransactionEvidenceResult,
    mut review: EvidenceAllocationReview,
) -> Result<EvidenceAllocationPlan> {
    require(
        review.contract_version == "1"
            && !review.receipt_ids.is_empty()
            && review.receipt_ids.len() <= 100
            && !review.target_observation_ids.is_empty()
            && review.target_observation_ids.len() <= 100
            && review.cells.len() <= 10000
            && review.line_categories.len() <= 10000,
        "allocation_shape",
    )?;
    normalize_review(&mut review);
    let receipt_ids: BTreeSet<_> = review.receipt_ids.iter().map(String::as_str).collect();
    let target_ids: BTreeSet<_> = review
        .target_observation_ids
        .iter()
        .map(String::as_str)
        .collect();
    require(
        receipt_ids.len() == review.receipt_ids.len()
            && target_ids.len() == review.target_observation_ids.len()
            && receipt_ids.iter().chain(target_ids.iter()).all(|v| id(v)),
        "allocation_duplicate_selection",
    )?;
    let observations: BTreeMap<_, _> = base
        .observations
        .iter()
        .map(|o| (o.id.as_str(), o))
        .collect();
    let targets: BTreeMap<_, _> = target_ids
        .iter()
        .map(|id| {
            observations
                .get(id)
                .map(|o| (*id, *o))
                .ok_or(EvidenceAllocationError("allocation_target_missing"))
        })
        .collect::<Result<_>>()?;
    let mut parents = BTreeSet::new();
    for target in targets.values() {
        require(
            target.kind == "ledger_transaction"
                && target.status == "completed"
                && target.direction == "outflow"
                && target.reliability >= 80
                && target.amount.minor_units() > 0
                && target.ledger_account_id.as_deref().is_some_and(id)
                && target.ledger_transaction_id.as_deref().is_some_and(id)
                && matches!(target.event_type.as_str(), "purchase" | "unknown"),
            "allocation_target_unsupported",
        )?;
        require(
            parents.insert(target.ledger_transaction_id.as_deref().unwrap())
                && base
                    .observations
                    .iter()
                    .filter(|o| {
                        o.kind == "ledger_transaction"
                            && o.ledger_transaction_id == target.ledger_transaction_id
                    })
                    .count()
                    == 1,
            "allocation_parent_reuse",
        )?;
    }
    let receipts: BTreeMap<_, _> = receipt_ids
        .iter()
        .map(|id| {
            base.receipts
                .iter()
                .find(|r| r.id == *id)
                .map(|r| (*id, r))
                .ok_or(EvidenceAllocationError("allocation_receipt_missing"))
        })
        .collect::<Result<_>>()?;
    let mut selected_observations: BTreeSet<_> = target_ids.clone();
    let mut lines = BTreeMap::new();
    for receipt in receipts.values() {
        let source = observations
            .get(receipt.observation_id.as_str())
            .ok_or(EvidenceAllocationError("allocation_receipt_source"))?;
        require(
            selected_observations.insert(source.id.as_str())
                && source.kind != "ledger_transaction"
                && source.status == "completed"
                && source.direction == "outflow"
                && source.event_type == "purchase"
                && source.ledger_effect.is_none()
                && source.amount == receipt.total
                && receipt.total.minor_units() > 0
                && resolved
                    .receipts
                    .iter()
                    .any(|r| r.receipt_id == receipt.id && r.valid)
                && !base
                    .receipts
                    .iter()
                    .any(|r| r.supersedes_id.as_ref() == Some(&receipt.id))
                && receipt.lines.iter().all(|l| l.return_of_line_id.is_none()),
            "allocation_receipt_not_current_purchase",
        )?;
        for line in &receipt.lines {
            lines.insert((receipt.id.as_str(), line.id.as_str()), line);
        }
    }
    let relevant_events: Vec<_> = resolved
        .events
        .iter()
        .filter(|event| {
            event
                .observation_ids
                .iter()
                .any(|o| selected_observations.contains(o.as_str()))
        })
        .collect();
    require(
        relevant_events.iter().all(|event| {
            event
                .observation_ids
                .iter()
                .all(|o| selected_observations.contains(o.as_str()))
        }),
        "allocation_unselected_group_source",
    )?;
    let hard: Vec<_> = resolved
        .blockers
        .iter()
        .filter(|b| b.code != "unmatched_funds")
        .cloned()
        .collect();
    let blocked = crate::transaction_evidence::blocked_projection_subjects(
        base.observations.iter(),
        &base.wallets,
        &hard,
    );
    require(
        relevant_events.iter().all(|event| {
            !blocked.contains(event.id.as_str())
                && !event
                    .observation_ids
                    .iter()
                    .any(|o| blocked.contains(o.as_str()))
        }),
        "allocation_source_blocked",
    )?;
    let mut categories = BTreeMap::new();
    for choice in &review.line_categories {
        require(
            id(&choice.category_id)
                && categories
                    .insert(
                        (choice.receipt_id.as_str(), choice.line_id.as_str()),
                        choice.category_id.as_str(),
                    )
                    .is_none(),
            "allocation_line_choice",
        )?;
    }
    require(
        categories.len() == lines.len() && lines.keys().all(|key| categories.contains_key(key)),
        "allocation_line_categories_required",
    )?;
    let mut row_totals = BTreeMap::new();
    let mut column_totals = BTreeMap::new();
    let mut pair_totals = BTreeMap::new();
    let mut split_totals = BTreeMap::new();
    let mut cell_keys = BTreeSet::new();
    for cell in &review.cells {
        let key = (cell.receipt_id.as_str(), cell.line_id.as_str());
        let line = lines
            .get(&key)
            .ok_or(EvidenceAllocationError("allocation_line_missing"))?;
        let target = targets
            .get(cell.target_observation_id.as_str())
            .ok_or(EvidenceAllocationError("allocation_cell_target"))?;
        require(
            cell_keys.insert((key, cell.target_observation_id.as_str()))
                && cell.amount.minor_units() > 0
                && cell.amount.currency() == line.net.currency()
                && cell.amount.currency() == target.amount.currency(),
            "allocation_cell_amount_or_duplicate",
        )?;
        add(&mut row_totals, key, cell.amount.minor_units())?;
        add(
            &mut column_totals,
            cell.target_observation_id.as_str(),
            cell.amount.minor_units(),
        )?;
        add(
            &mut pair_totals,
            (
                cell.receipt_id.as_str(),
                cell.target_observation_id.as_str(),
            ),
            cell.amount.minor_units(),
        )?;
        add(
            &mut split_totals,
            (cell.target_observation_id.as_str(), categories[&key]),
            cell.amount.minor_units(),
        )?;
    }
    let mut graph_totals = BTreeMap::new();
    let receipt_observations: BTreeMap<_, _> = receipts
        .values()
        .map(|r| (r.observation_id.as_str(), r.id.as_str()))
        .collect();
    for rel in resolved.relationships.iter().filter(|rel| {
        rel.state == "confirmed"
            && matches!(
                rel.kind.as_str(),
                "funding" | "partial_funding" | "settlement" | "transfer"
            )
    }) {
        if let Some(receipt) = receipt_observations.get(rel.from_id.as_str()) {
            require(
                targets.contains_key(rel.to_id.as_str()) && rel.kind != "transfer",
                "allocation_graph_target",
            )?;
            add(
                &mut graph_totals,
                (*receipt, rel.to_id.as_str()),
                rel.allocated_amount
                    .as_ref()
                    .ok_or(EvidenceAllocationError("allocation_graph_amount"))?
                    .minor_units(),
            )?;
        }
    }
    require(
        graph_totals == pair_totals,
        "allocation_graph_matrix_mismatch",
    )?;
    for receipt in receipts.values() {
        let mut known = BTreeMap::new();
        let mut unknown = 0_i64;
        for tender in &receipt.tenders {
            if !matches!(tender.kind.as_str(), "card" | "bank") {
                continue;
            }
            if let Some(target) = &tender.observation_id {
                add(&mut known, target.as_str(), tender.amount.minor_units())?;
            } else {
                unknown = unknown
                    .checked_add(tender.amount.minor_units())
                    .ok_or(EvidenceAllocationError("amount_overflow"))?;
            }
        }
        let mut needed = 0_i64;
        for target in targets.keys() {
            let amount = *pair_totals
                .get(&(receipt.id.as_str(), *target))
                .unwrap_or(&0);
            let known = *known.get(target).unwrap_or(&0);
            needed = needed
                .checked_add(
                    amount
                        .checked_sub(known)
                        .ok_or(EvidenceAllocationError("amount_overflow"))?
                        .max(0),
                )
                .ok_or(EvidenceAllocationError("amount_overflow"))?;
        }
        require(needed <= unknown, "allocation_bank_tender_capacity")?;
    }
    let mut remainders = vec![];
    for (key, line) in &lines {
        let consumed = *row_totals.get(key).unwrap_or(&0);
        require(
            consumed <= line.net.minor_units(),
            "allocation_line_capacity",
        )?;
        let remaining = line.net.minor_units() - consumed;
        if remaining > 0 {
            remainders.push(EvidenceAllocationRemainder {
                receipt_id: key.0.into(),
                line_id: key.1.into(),
                amount: Money::new(remaining, line.net.currency()),
            });
        }
    }
    let dependency_ids: BTreeSet<_> = selected_observations
        .iter()
        .copied()
        .chain(
            receipts
                .values()
                .flat_map(|r| r.tenders.iter().filter_map(|t| t.observation_id.as_deref())),
        )
        .collect();
    let sources: Vec<_> = dependency_ids
        .iter()
        .map(|id| observations[id].provenance.clone())
        .collect();
    let evidence_ids: Vec<_> = sources
        .iter()
        .map(|s| s.document_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let funded_target_count = targets
        .iter()
        .filter(|(id, target)| {
            column_totals.get(*id).copied().unwrap_or(0) == target.amount.minor_units()
        })
        .count();
    // Each published parent carries the complete inspectable manifest and source closure.
    // Bound their product before cloning, not merely each independently bounded input.
    let manifest_items = review.cells.len()
        + review.line_categories.len()
        + review.receipt_ids.len()
        + review.target_observation_ids.len()
        + evidence_ids.len()
        + sources.len();
    require(
        funded_target_count
            .checked_mul(manifest_items)
            .is_some_and(|work| work <= 50_000),
        "allocation_publication_limit",
    )?;
    let manifest_bytes = serde_json::to_vec(&(&review, &sources, &evidence_ids))
        .map_err(|_| EvidenceAllocationError("serialization"))?
        .len();
    require(
        funded_target_count
            .max(1)
            .checked_mul(manifest_bytes)
            .is_some_and(|bytes| bytes <= 2 * 1024 * 1024),
        "allocation_publication_limit",
    )?;
    let mut projections = vec![];
    let mut target_remainders = vec![];
    for (target_id, target) in &targets {
        let total = *column_totals.get(target_id).unwrap_or(&0);
        require(
            total <= target.amount.minor_units(),
            "allocation_target_capacity",
        )?;
        if total < target.amount.minor_units() {
            target_remainders.push(EvidenceAllocationTargetRemainder {
                target_observation_id: (*target_id).into(),
                amount: Money::new(
                    target.amount.minor_units() - total,
                    target.amount.currency(),
                ),
            });
            continue;
        }
        let mut splits: Vec<_> = split_totals
            .iter()
            .filter(|((t, _), _)| t == target_id)
            .map(|((_, category), amount)| ManualTransactionSplit {
                category_id: (*category).into(),
                amount: Money::new(-*amount, target.amount.currency()),
            })
            .collect();
        let category_id = if splits.len() == 1 {
            Some(splits.remove(0).category_id)
        } else {
            None
        };
        let event = relevant_events
            .iter()
            .find(|e| e.observation_ids.contains(&target.id))
            .ok_or(EvidenceAllocationError("allocation_event_missing"))?;
        projections.push(EvidenceAllocationProjection {
            event_id: event.id.clone(),
            target_observation_id: (*target_id).into(),
            ledger_transaction_id: target.ledger_transaction_id.clone().unwrap(),
            evidence_ids: evidence_ids.clone(),
            sources: sources.clone(),
            ledger_effect: EconomicEventLedgerEffect {
                account_id: target.ledger_account_id.clone().unwrap(),
                amount: Money::new(-total, target.amount.currency()),
                date: target.date.clone(),
                category_id,
                payee_name: None,
                notes: None,
                splits,
            },
        });
    }
    review.allocation_set_hash = String::new();
    let allocation_set_hash = digest(
        &serde_json::json!({"review":review,"projections":projections,"remainders":remainders,"targetRemainders":target_remainders}),
    )?;
    review.allocation_set_hash = allocation_set_hash.clone();
    let plan = EvidenceAllocationPlan {
        contract_version: "1".into(),
        source_hash: review.source_hash.clone(),
        allocation_set_hash,
        review,
        projections,
        remainders,
        target_remainders,
        funding_relationships: None,
    };
    require(
        serde_json::to_vec(&plan)
            .map_err(|_| EvidenceAllocationError("serialization"))?
            .len()
            <= 2 * 1024 * 1024,
        "allocation_publication_limit",
    )?;
    Ok(plan)
}
pub(crate) fn apply_allocation_review(
    request: &TransactionEvidenceRequest,
    result: &mut TransactionEvidenceResult,
) -> Result<()> {
    let Some(review) = &request.allocation_review else {
        return Ok(());
    };
    let base = baseline(request, &review.target_observation_ids);
    let source_hash = digest(&base)?;
    require(
        review.source_hash == source_hash,
        "allocation_source_changed",
    )?;
    let plan = compute(&base, result, review.clone())?;
    require(plan.review == *review, "allocation_manifest_changed")?;
    let targets: BTreeMap<_, _> = request
        .observations
        .iter()
        .filter(|o| review.target_observation_ids.contains(&o.id))
        .map(|o| (o.id.as_str(), o))
        .collect();
    for target in targets.values() {
        let projection = plan
            .projections
            .iter()
            .find(|p| p.target_observation_id == target.id);
        if let Some(projection) = projection {
            let actual = target
                .ledger_effect
                .as_ref()
                .ok_or(EvidenceAllocationError(
                    "allocation_reviewed_effect_required",
                ))?;
            let mut expected = projection.ledger_effect.clone();
            expected.payee_name = actual.payee_name.clone();
            expected.notes = actual.notes.clone();
            require(
                target.reviewed_ledger_effect && actual == &expected,
                "allocation_reviewed_effect_mismatch",
            )?;
        } else {
            require(target.ledger_effect.is_none(), "allocation_unfunded_effect")?;
        }
    }
    let involved: BTreeSet<_> = review
        .target_observation_ids
        .iter()
        .chain(review.receipt_ids.iter().filter_map(|id| {
            request
                .receipts
                .iter()
                .find(|r| &r.id == id)
                .map(|r| &r.observation_id)
        }))
        .collect();
    for event in &mut result.events {
        if event.observation_ids.iter().any(|o| involved.contains(o)) {
            event.projection_observation = None;
            event.projection_observations.clear();
            event.allocation_set_hash = Some(plan.allocation_set_hash.clone());
        }
    }
    for projection in &plan.projections {
        let proof = SourceObservation {
            wallet_balance_anchor: None,
            allocation_review: Some(plan.review.clone()),
            kind: ObservationKind::EconomicEventResolution,
            scope: DecisionScope::Transaction(projection.ledger_transaction_id.clone()),
            state: ObservationState::Resolved,
            observed_at: projection
                .sources
                .iter()
                .map(|s| s.received_at.clone())
                .max(),
            content_hash: Some(result.resolution_hash.clone()),
            version: Some("1".into()),
            ledger_effect: targets[projection.target_observation_id.as_str()]
                .ledger_effect
                .clone(),
            evidence: projection
                .evidence_ids
                .iter()
                .map(|id| EvidenceReference {
                    evidence_id: id.clone(),
                    kind: "economic_event_resolution".into(),
                    authorized: true,
                    redaction: RedactionState::Visible,
                })
                .collect(),
        };
        let event = result
            .events
            .iter_mut()
            .find(|e| e.id == projection.event_id)
            .ok_or(EvidenceAllocationError("allocation_event_missing"))?;
        event.projection_observations.push(proof);
    }
    for event in &mut result.events {
        if event.projection_observations.len() == 1 {
            event.projection_observation = event.projection_observations.pop();
        }
    }
    Ok(())
}
