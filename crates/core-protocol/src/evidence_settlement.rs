//! Receipt allocation planning reuses the resolver and emits no independent write authority.
use crate::{
    resolve_transaction_evidence, EconomicEventLedgerEffect, EvidenceProvenance,
    ManualTransactionSplit, TransactionEvidenceRequest,
};
use balanceframe_financial_core::Money;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// One explicit human line-category choice; imported category hints are ignored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceSettlementLineCategory {
    /// Current selected receipt identifier.
    pub receipt_id: String,
    /// Current selected line identifier.
    pub line_id: String,
    /// Explicit category chosen for this line.
    pub category_id: String,
}
/// Whole conserved receipts funding exactly one existing authoritative settlement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeriveEvidenceSettlementPlanRequest {
    /// Supported contract version.
    pub contract_version: String,
    /// Current authorized normalized source capture; this function cannot authenticate it.
    pub evidence: TransactionEvidenceRequest,
    /// Existing authoritative Actual observation, never a fabricated aggregate observation.
    pub target_observation_id: String,
    /// Complete receipt selections, not arbitrary financial amounts.
    pub receipt_ids: Vec<String>,
    /// Every selected line requires an explicit category choice.
    pub line_categories: Vec<EvidenceSettlementLineCategory>,
}
/// Exact contribution derived from one conserved receipt line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceSettlementContribution {
    /// Contributing receipt identity.
    pub receipt_id: String,
    /// Contributing line identity.
    pub line_id: String,
    /// Explicitly reviewed category.
    pub category_id: String,
    /// Positive or zero receipt net, never an inferred planned price.
    pub amount: Money,
}
/// Pure approval-required allocation plan for the existing evidence amendment path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeriveEvidenceSettlementPlanResult {
    /// Supported contract version.
    pub contract_version: String,
    /// Full normalized source and relationship hash from the existing resolver.
    pub resolution_hash: String,
    /// Exact allocation-set hash binding source state, selections, categories and output.
    pub allocation_hash: String,
    /// Existing deterministic economic event identity.
    pub event_id: String,
    /// Authoritative target observation identity.
    pub target_observation_id: String,
    /// Real existing parent transaction identity.
    pub ledger_transaction_id: String,
    /// Real contributing evidence document identities.
    pub evidence_ids: Vec<String>,
    /// Exact contributing source provenance, without inferred issuer authority.
    pub sources: Vec<EvidenceProvenance>,
    /// Inspectable conserved line contributions.
    pub contributions: Vec<EvidenceSettlementContribution>,
    /// Derived financial fields; nullable metadata must be preserved by the existing reviewed amendment workflow.
    pub ledger_effect: EconomicEventLedgerEffect,
}
/// Unsupported or incomplete allocation never produces a financial plan.
#[derive(Debug, thiserror::Error, PartialEq)]
#[error("invalid evidence settlement plan: {0}")]
pub struct EvidenceSettlementPlanError(pub &'static str);
fn require(ok: bool, code: &'static str) -> Result<(), EvidenceSettlementPlanError> {
    if ok {
        Ok(())
    } else {
        Err(EvidenceSettlementPlanError(code))
    }
}
fn id(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
/// Derive category allocations from whole current receipts and confirmed funding, without authorizing a mutation.
pub fn derive_evidence_settlement_plan(
    request: &DeriveEvidenceSettlementPlanRequest,
) -> Result<DeriveEvidenceSettlementPlanResult, EvidenceSettlementPlanError> {
    require(
        request.contract_version == "1"
            && id(&request.target_observation_id)
            && !request.receipt_ids.is_empty()
            && request.receipt_ids.len() <= 100
            && request.line_categories.len() <= 10000,
        "settlement_plan_shape",
    )?;
    let resolution = resolve_transaction_evidence(&request.evidence)
        .map_err(|e| EvidenceSettlementPlanError(e.0))?;
    let target = request
        .evidence
        .observations
        .iter()
        .find(|o| o.id == request.target_observation_id)
        .ok_or(EvidenceSettlementPlanError("settlement_target_missing"))?;
    require(
        target.kind == "ledger_transaction"
            && target.status == "completed"
            && target.direction == "outflow"
            && target.reliability >= 80
            && target.amount.minor_units() > 0
            && target.ledger_transaction_id.as_deref().is_some_and(id)
            && target.ledger_account_id.as_deref().is_some_and(id)
            && !matches!(
                target.event_type.as_str(),
                "transfer" | "self_transfer" | "refund"
            ),
        "settlement_target_unsupported",
    )?;
    require(
        request
            .evidence
            .observations
            .iter()
            .filter(|observation| {
                observation.kind == "ledger_transaction"
                    && observation.ledger_transaction_id == target.ledger_transaction_id
            })
            .count()
            == 1,
        "settlement_target_duplicate",
    )?;
    let event = resolution
        .events
        .iter()
        .find(|event| event.observation_ids.contains(&target.id))
        .ok_or(EvidenceSettlementPlanError("settlement_event_missing"))?;
    require(
        event.state == "resolved"
            && event.event_type == "purchase"
            && event.amount == target.amount,
        "settlement_event_unresolved",
    )?;
    let mut receipt_ids = BTreeSet::new();
    let mut observation_ids = BTreeSet::from([target.id.as_str()]);
    let mut selections = BTreeMap::new();
    for choice in &request.line_categories {
        require(
            id(&choice.receipt_id)
                && id(&choice.line_id)
                && id(&choice.category_id)
                && selections
                    .insert(
                        (choice.receipt_id.as_str(), choice.line_id.as_str()),
                        choice.category_id.as_str(),
                    )
                    .is_none(),
            "settlement_line_choice",
        )?;
    }
    let mut contributions = vec![];
    let mut category_totals = BTreeMap::<String, i64>::new();
    let mut receipt_total = 0_i64;
    for receipt_id in &request.receipt_ids {
        require(
            id(receipt_id) && receipt_ids.insert(receipt_id.as_str()),
            "settlement_receipt_duplicate",
        )?;
        let receipt = request
            .evidence
            .receipts
            .iter()
            .find(|receipt| &receipt.id == receipt_id)
            .ok_or(EvidenceSettlementPlanError("settlement_receipt_missing"))?;
        let observation = request
            .evidence
            .observations
            .iter()
            .find(|o| o.id == receipt.observation_id)
            .ok_or(EvidenceSettlementPlanError(
                "settlement_receipt_observation",
            ))?;
        require(
            observation_ids.insert(observation.id.as_str())
                && observation.kind != "ledger_transaction"
                && observation.status == "completed"
                && observation.direction == "outflow"
                && observation.event_type == "purchase"
                && observation.amount == receipt.total
                && observation.amount.currency() == target.amount.currency()
                && receipt.total.minor_units() > 0
                && !request
                    .evidence
                    .receipts
                    .iter()
                    .any(|newer| newer.supersedes_id.as_ref() == Some(&receipt.id))
                && resolution
                    .receipts
                    .iter()
                    .any(|r| r.receipt_id == receipt.id && r.valid)
                && receipt
                    .lines
                    .iter()
                    .all(|line| line.return_of_line_id.is_none()),
            "settlement_receipt_not_current_purchase",
        )?;
        let links: Vec<_> = resolution
            .relationships
            .iter()
            .filter(|rel| {
                rel.state == "confirmed"
                    && rel.from_id == observation.id
                    && rel.to_id == target.id
                    && matches!(
                        rel.kind.as_str(),
                        "funding" | "partial_funding" | "settlement"
                    )
            })
            .collect();
        require(
            links.len() == 1 && links[0].allocated_amount.as_ref() == Some(&receipt.total),
            "settlement_funding_incomplete",
        )?;
        // Whole receipts cannot silently assign gift/reward/cash or a different bank tender to this parent.
        require(
            receipt.tenders.iter().all(|t| {
                matches!(t.kind.as_str(), "card" | "bank")
                    && t.observation_id.as_ref().is_none_or(|id| id == &target.id)
            }),
            "settlement_tender_unsupported",
        )?;
        receipt_total = receipt_total
            .checked_add(receipt.total.minor_units())
            .ok_or(EvidenceSettlementPlanError("amount_overflow"))?;
        for line in &receipt.lines {
            let category = selections
                .remove(&(receipt.id.as_str(), line.id.as_str()))
                .ok_or(EvidenceSettlementPlanError(
                    "settlement_line_category_required",
                ))?;
            let total = category_totals.entry(category.to_owned()).or_default();
            *total = total
                .checked_add(line.net.minor_units())
                .ok_or(EvidenceSettlementPlanError("amount_overflow"))?;
            contributions.push(EvidenceSettlementContribution {
                receipt_id: receipt.id.clone(),
                line_id: line.id.clone(),
                category_id: category.to_owned(),
                amount: line.net.clone(),
            });
        }
    }
    require(
        selections.is_empty()
            && receipt_total == target.amount.minor_units()
            && observation_ids.len() == event.observation_ids.len()
            && event
                .observation_ids
                .iter()
                .all(|id| observation_ids.contains(id.as_str())),
        "settlement_allocation_incomplete",
    )?;
    contributions.sort_by(|a, b| (&a.receipt_id, &a.line_id).cmp(&(&b.receipt_id, &b.line_id)));
    let mut splits: Vec<_> = category_totals
        .into_iter()
        .filter(|(_, amount)| *amount > 0)
        .map(|(category_id, amount)| ManualTransactionSplit {
            category_id,
            amount: Money::new(-amount, target.amount.currency()),
        })
        .collect();
    let category_id = if splits.len() == 1 {
        Some(splits.remove(0).category_id)
    } else {
        None
    };
    let effect = EconomicEventLedgerEffect {
        account_id: target.ledger_account_id.clone().unwrap(),
        amount: Money::new(-target.amount.minor_units(), target.amount.currency()),
        date: target.date.clone(),
        category_id,
        payee_name: None,
        notes: None,
        splits,
    };
    let sources = event
        .observation_ids
        .iter()
        .map(|id| {
            request
                .evidence
                .observations
                .iter()
                .find(|o| &o.id == id)
                .unwrap()
                .provenance
                .clone()
        })
        .collect();
    let material = serde_json::json!({"contractVersion":"1","resolutionHash":resolution.resolution_hash,"eventId":event.id,"targetObservationId":target.id,"receiptIds":receipt_ids,"contributions":contributions,"ledgerEffect":effect});
    let allocation_hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&material)
                .map_err(|_| EvidenceSettlementPlanError("serialization"))?
        )
    );
    Ok(DeriveEvidenceSettlementPlanResult {
        contract_version: "1".into(),
        resolution_hash: resolution.resolution_hash,
        allocation_hash,
        event_id: event.id.clone(),
        target_observation_id: target.id.clone(),
        ledger_transaction_id: target.ledger_transaction_id.clone().unwrap(),
        evidence_ids: event.evidence_ids.clone(),
        sources,
        contributions,
        ledger_effect: effect,
    })
}
