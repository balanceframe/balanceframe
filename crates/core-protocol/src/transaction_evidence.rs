//! Service-neutral evidence resolution. Raw documents never enter this boundary.
use crate::{
    DecisionScope, EconomicEventLedgerEffect, EvidenceReference, ObservationKind, ObservationState,
    RedactionState, SourceObservation,
};
use balanceframe_financial_core::{allocate_evidence_amount, Money};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

macro_rules! record {
    ($name:ident { $($(#[$attribute:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        #[doc = concat!("Versioned normalized evidence record: `", stringify!($name), "`.")]
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct $name { $(#[doc = concat!("Normalized `", stringify!($field), "` value; no raw source payload.")] #[serde(deserialize_with="required")] $(#[$attribute])* pub $field: $ty),* }
    }
}
fn required<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<T, D::Error> {
    T::deserialize(deserializer)
}

record!(EvidenceProvenance {
    document_id: String,
    content_hash: String,
    parser_version: String,
    source_timestamp: String,
    received_at: String
});
fn unreviewed(value: &bool) -> bool {
    !value
}
record!(EvidenceObservation { #[serde(default, skip_serializing_if="Option::is_none")] ledger_account_id: Option<String>, #[serde(default, skip_serializing_if="unreviewed")] reviewed_ledger_effect: bool, id: String, kind: String, source_id: String, external_event_id: Option<String>, date: String, amount: Money, direction: String, status: String, event_type: String, counterparty: Option<String>, funding_instrument_id: Option<String>, wallet_id: Option<String>, ledger_transaction_id: Option<String>, ledger_effect: Option<EconomicEventLedgerEffect>, reliability: u8, provenance: EvidenceProvenance });
record!(EvidenceRelationship { id: String, from_id: String, to_id: String, kind: String, state: String, allocated_amount: Option<Money>, partial: bool, score: u8, reason_codes: Vec<String>, evidence_ids: Vec<String> });
record!(WalletEvidence { wallet_id: String, currency: String, opening_balance: Option<Money>, closing_balance: Option<Money>, complete_activity: bool, materialized_account_id: Option<String>, requires_stored_value: bool });
record!(ReceiptLine { id: String, raw_description: String, normalized_description: String, sku: Option<String>, department: Option<String>, product_family: Option<String>, quantity_micros: u32, unit_gross: Money, gross: Money, discount: Money, tax: Money, net: Money, category_id: Option<String>, member_id: Option<String>, evidence_strength: u8, reason_codes: Vec<String>, return_of_line_id: Option<String> });
record!(ReceiptTender { #[serde(default, skip_serializing_if="unreviewed")] partial: bool, id: String, kind: String, amount: Money, observation_id: Option<String> });
record!(ReceiptEvidence { id: String, observation_id: String, version: u32, supersedes_id: Option<String>, fulfillment_group_id: Option<String>, total: Money, discount: Money, tax: Money, lines: Vec<ReceiptLine>, tenders: Vec<ReceiptTender> });
record!(TransactionEvidenceRequest { #[serde(default, skip_serializing_if="Vec::is_empty")] statement_proofs: Vec<crate::WalletStatementProof>, #[serde(default, skip_serializing_if="Option::is_none")] allocation_review: Option<crate::EvidenceAllocationReview>, contract_version: String, policy_version: String, max_settlement_days: u32, observations: Vec<EvidenceObservation>, relationships: Vec<EvidenceRelationship>, wallets: Vec<WalletEvidence>, receipts: Vec<ReceiptEvidence> });
record!(EvidenceBlocker { code: String, subject_id: String, evidence_ids: Vec<String> });
record!(ResolvedEconomicEvent { #[serde(default, skip_serializing_if="Vec::is_empty")] projection_observations: Vec<SourceObservation>, #[serde(default, skip_serializing_if="Option::is_none")] allocation_set_hash: Option<String>, id: String, version: String, event_type: String, state: String, amount: Money, observation_ids: Vec<String>, evidence_ids: Vec<String>, reason_codes: Vec<String>, projection_observation: Option<SourceObservation> });
record!(WalletEvidenceResolution { #[serde(default, skip_serializing_if="Option::is_none")] coverage: Option<crate::WalletStatementCoverage>, #[serde(default, skip_serializing_if="Option::is_none")] balance_anchors: Option<Vec<crate::WalletStatementBalanceAnchor>>, #[serde(default, skip_serializing_if="Option::is_none")] anchor_observations: Option<Vec<SourceObservation>>, wallet_id: String, opening_balance: Option<Money>, closing_balance: Option<Money>, balance_state: String, projection: String, reason_codes: Vec<String> });
record!(ReceiptEvidenceResolution { receipt_id: String, valid: bool, allocated_discount: Vec<Money>, allocated_tax: Vec<Money>, reason_codes: Vec<String> });
record!(TransactionEvidenceResult { contract_version: String, policy_version: String, resolution_hash: String, events: Vec<ResolvedEconomicEvent>, relationships: Vec<EvidenceRelationship>, wallets: Vec<WalletEvidenceResolution>, receipts: Vec<ReceiptEvidenceResolution>, blockers: Vec<EvidenceBlocker> });

/// Invalid normalized input never produces a financial resolution.
#[derive(Debug, thiserror::Error, PartialEq)]
#[error("invalid transaction evidence: {0}")]
pub struct TransactionEvidenceError(pub &'static str);
type Result<T> = std::result::Result<T, TransactionEvidenceError>;
fn require(ok: bool, code: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(TransactionEvidenceError(code))
    }
}
fn id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn currency(s: &str) -> bool {
    s.len() == 3 && s.bytes().all(|c| c.is_ascii_uppercase())
}
fn money(m: &Money) -> bool {
    m.minor_units() >= 0 && currency(m.currency())
}
fn sum<'a>(mut values: impl Iterator<Item = &'a Money>, cur: &str) -> Result<i64> {
    values.try_fold(0i64, |a, b| {
        require(money(b) && b.currency() == cur, "currency_or_amount")?;
        a.checked_add(b.minor_units())
            .ok_or(TransactionEvidenceError("amount_overflow"))
    })
}
fn civil(s: &str) -> Result<i64> {
    balanceframe_financial_core::evidence::evidence_date_ordinal(s)
        .ok_or(TransactionEvidenceError("date"))
}
fn consuming(kind: &str) -> bool {
    matches!(
        kind,
        "funding" | "partial_funding" | "settlement" | "transfer"
    )
}
fn transfer_observation(o: &EvidenceObservation) -> bool {
    o.kind == "wallet_transfer" || matches!(o.event_type.as_str(), "transfer" | "self_transfer")
}
fn supports_local_candidate(a: &EvidenceObservation, b: &EvidenceObservation) -> bool {
    let wallet = |kind: &str| matches!(kind, "wallet_payment" | "wallet_fee" | "wallet_refund");
    let retail = |kind: &str| matches!(kind, "receipt" | "order");
    let annotation = |kind: &str| matches!(kind, "spend_session_item" | "user_correction");
    (wallet(&a.kind) && (retail(&b.kind) || annotation(&b.kind)))
        || (wallet(&b.kind) && (retail(&a.kind) || annotation(&a.kind)))
        || (retail(&a.kind) && (annotation(&b.kind) || (retail(&b.kind) && a.kind != b.kind)))
        || (retail(&b.kind) && annotation(&a.kind))
}

fn active(o: &EvidenceObservation) -> bool {
    o.status == "completed" && !matches!(o.kind.as_str(), "wallet_request" | "order")
}
fn blocker(out: &mut Vec<EvidenceBlocker>, code: &str, subject: &str, evidence: Vec<String>) {
    out.push(EvidenceBlocker {
        code: code.into(),
        subject_id: subject.into(),
        evidence_ids: evidence,
    });
}
fn compatible(a: &EvidenceObservation, b: &EvidenceObservation, days: u32, inverse: bool) -> bool {
    a.amount.currency() == b.amount.currency()
        && (a.direction != b.direction) == inverse
        && (civil(&a.date).unwrap() - civil(&b.date).unwrap()).unsigned_abs() <= u64::from(days)
        && (a.funding_instrument_id.is_none()
            || b.funding_instrument_id.is_none()
            || a.funding_instrument_id == b.funding_instrument_id)
}
fn validate(r: &TransactionEvidenceRequest) -> Result<()> {
    require(
        r.contract_version == "1" && id(&r.policy_version) && r.max_settlement_days <= 90,
        "version_or_policy",
    )?;
    require(
        r.observations.len() <= 10000
            && r.relationships.len() <= 20000
            && r.wallets.len() <= 1000
            && r.receipts.len() <= 1000,
        "input_limit",
    )?;
    let mut ids = BTreeSet::new();
    for o in &r.observations {
        require(
            id(&o.id)
                && ids.insert(&o.id)
                && id(&o.source_id)
                && money(&o.amount)
                && o.reliability <= 100,
            "observation",
        )?;
        require(
            [
                "ledger_transaction",
                "wallet_payment",
                "wallet_transfer",
                "wallet_fee",
                "wallet_refund",
                "wallet_request",
                "receipt",
                "order",
                "spend_session_item",
                "user_correction",
            ]
            .contains(&o.kind.as_str()),
            "observation_kind",
        )?;
        require(
            ["inflow", "outflow"].contains(&o.direction.as_str())
                && ["pending", "completed", "reversed", "superseded"].contains(&o.status.as_str())
                && [
                    "purchase",
                    "p2p_payment",
                    "transfer",
                    "reimbursement",
                    "refund",
                    "fee",
                    "mixed",
                    "unknown",
                    "repayment",
                    "rent_contribution",
                    "gift",
                    "business_income",
                    "income",
                    "self_transfer",
                ]
                .contains(&o.event_type.as_str()),
            "observation_state",
        )?;
        require(
            o.kind != "ledger_transaction" || o.ledger_transaction_id.is_some(),
            "ledger_transaction_identity",
        )?;
        require(
            o.ledger_account_id.is_none() || o.kind == "ledger_transaction",
            "ledger_account_identity",
        )?;
        civil(&o.date)?;
        for v in [
            &o.external_event_id,
            &o.counterparty,
            &o.funding_instrument_id,
            &o.wallet_id,
            &o.ledger_transaction_id,
            &o.ledger_account_id,
        ] {
            require(v.as_ref().is_none_or(|s| id(s)), "observation_identity")?;
        }
        let p = &o.provenance;
        require(
            id(&p.document_id)
                && hash(&p.content_hash)
                && id(&p.parser_version)
                && balanceframe_financial_core::evidence::evidence_timestamp_valid(
                    &p.source_timestamp,
                )
                && balanceframe_financial_core::evidence::evidence_timestamp_valid(&p.received_at),
            "provenance",
        )?;
        if let Some(e) = &o.ledger_effect {
            require(o.kind != "order", "order_not_settled")?;
            require(o.reviewed_ledger_effect, "unapproved_ledger_effect")?;
            let expected = if o.direction == "outflow" {
                o.amount.minor_units().checked_neg()
            } else {
                Some(o.amount.minor_units())
            };
            require(
                id(&e.account_id)
                    && expected == Some(e.amount.minor_units())
                    && e.amount.currency() == o.amount.currency()
                    && (e.date == o.date
                        || r.observations.iter().any(|source| {
                            source.kind == "ledger_transaction"
                                && source.ledger_transaction_id.is_some()
                                && source.ledger_account_id.as_ref() == Some(&e.account_id)
                                && source.date == e.date
                                && source.amount == o.amount
                                && source.direction == o.direction
                        })),
                "ledger_effect",
            )?;
            require(
                e.category_id.as_ref().is_none_or(|s| id(s))
                    && (e.splits.is_empty() || e.category_id.is_none()),
                "ledger_effect_category",
            )?;
            let mut split_sum = 0i64;
            for split in &e.splits {
                require(
                    id(&split.category_id)
                        && split.amount.currency() == e.amount.currency()
                        && split.amount.minor_units().signum() == e.amount.minor_units().signum(),
                    "ledger_split",
                )?;
                split_sum = split_sum
                    .checked_add(split.amount.minor_units())
                    .ok_or(TransactionEvidenceError("amount_overflow"))?;
            }
            require(
                e.splits.is_empty() || split_sum == e.amount.minor_units(),
                "ledger_split_total",
            )?;
        }
    }
    let mut rel_ids = BTreeSet::new();
    for rel in &r.relationships {
        require(
            id(&rel.id)
                && rel_ids.insert(&rel.id)
                && rel.from_id != rel.to_id
                && ids.contains(&rel.from_id)
                && ids.contains(&rel.to_id)
                && rel.score <= 100,
            "relationship",
        )?;
        require(
            [
                "same_event",
                "funding",
                "partial_funding",
                "settlement",
                "transfer",
                "reimbursement",
                "refund",
                "reversal",
                "supersession",
                "containment",
                "corroboration",
            ]
            .contains(&rel.kind.as_str())
                && ["candidate", "confirmed", "rejected", "superseded"]
                    .contains(&rel.state.as_str()),
            "relationship_state",
        )?;
        require(
            rel.allocated_amount.as_ref().is_none_or(money)
                && rel.reason_codes.iter().all(|s| id(s))
                && rel.evidence_ids.iter().all(|s| id(s)),
            "relationship_metadata",
        )?;
    }
    Ok(())
}

/// Resolve normalized observations with checked monetary identity before semantics.
///
/// Ambiguous and incomplete evidence remains explicit. This function never writes
/// Actual; eligible projections reuse its canonical economic-event observation.
pub fn resolve_transaction_evidence(
    request: &TransactionEvidenceRequest,
) -> Result<TransactionEvidenceResult> {
    validate(request)?;
    let mut r = request.clone();
    if let Some(review) = &mut r.allocation_review {
        crate::evidence_allocation::normalize_review(review);
    }
    r.statement_proofs
        .sort_by(|a, b| a.proof_id.cmp(&b.proof_id));
    for p in &mut r.statement_proofs {
        p.activity_manifest
            .sort_by(|a, b| a.observation_id.cmp(&b.observation_id));
    }
    r.observations.sort_by(|a, b| a.id.cmp(&b.id));
    r.relationships.sort_by(|a, b| a.id.cmp(&b.id));
    r.wallets.sort_by(|a, b| a.wallet_id.cmp(&b.wallet_id));
    r.receipts.sort_by(|a, b| a.id.cmp(&b.id));
    // A newer immutable invoice replaces one prior extraction in the same source.
    let mut replaced_receipts = BTreeSet::new();
    for receipt in &r.receipts {
        if let Some(prior_id) = &receipt.supersedes_id {
            let prior = r
                .receipts
                .iter()
                .find(|item| &item.id == prior_id && item.version < receipt.version)
                .ok_or(TransactionEvidenceError("receipt_version"))?;
            require(
                prior.observation_id != receipt.observation_id,
                "receipt_source_version",
            )?;
            require(replaced_receipts.insert(prior_id), "receipt_version_fork")?;
            let source = r
                .observations
                .iter()
                .find(|o| o.id == receipt.observation_id)
                .ok_or(TransactionEvidenceError("receipt"))?;
            let previous = r
                .observations
                .iter()
                .find(|o| o.id == prior.observation_id)
                .ok_or(TransactionEvidenceError("receipt"))?;
            require(
                source.source_id == previous.source_id
                    && source.direction == previous.direction
                    && source.amount.currency() == previous.amount.currency(),
                "receipt_source_lineage",
            )?;
            if let Some(observation) = r
                .observations
                .iter_mut()
                .find(|o| o.id == prior.observation_id)
            {
                observation.status = "superseded".into();
            }
        }
    }
    let index: BTreeMap<_, _> = r
        .observations
        .iter()
        .enumerate()
        .map(|(i, o)| (o.id.clone(), i))
        .collect();
    let mut result = TransactionEvidenceResult {
        contract_version: "1".into(),
        policy_version: r.policy_version.clone(),
        resolution_hash: String::new(),
        events: vec![],
        relationships: r.relationships.clone(),
        wallets: vec![],
        receipts: vec![],
        blockers: vec![],
    };
    let mut consumption = BTreeMap::<usize, i64>::new();
    let mut parent: Vec<usize> = (0..r.observations.len()).collect();
    fn root(parent: &[usize], mut i: usize) -> usize {
        while parent[i] != i {
            i = parent[i];
        }
        i
    }
    let mut connected = BTreeSet::new();
    let mut return_consumption = BTreeMap::<usize, i64>::new();
    let mut allocation_roles = BTreeMap::<usize, bool>::new();
    let mut superseded = BTreeSet::new();
    for rel in &result.relationships {
        if rel.state != "confirmed" {
            continue;
        }
        let a = index[&rel.from_id];
        let b = index[&rel.to_id];
        let oa = &r.observations[a];
        let ob = &r.observations[b];
        if consuming(&rel.kind) {
            require(
                active(oa)
                    && active(ob)
                    && compatible(oa, ob, r.max_settlement_days, rel.kind == "transfer"),
                "relationship_incompatible",
            )?;
            let amount = rel
                .allocated_amount
                .as_ref()
                .ok_or(TransactionEvidenceError("allocation_required"))?;
            require(
                amount.currency() == oa.amount.currency() && amount.minor_units() > 0,
                "allocation_currency",
            )?;
            if !rel.partial {
                require(
                    amount == &oa.amount && amount == &ob.amount,
                    "explicit_partial_required",
                )?;
            }
            for (i, role) in [(a, true), (b, false)] {
                require(
                    allocation_roles
                        .insert(i, role)
                        .is_none_or(|previous| previous == role),
                    "allocation_cycle",
                )?;
                let total = consumption.entry(i).or_default();
                *total = total
                    .checked_add(amount.minor_units())
                    .ok_or(TransactionEvidenceError("amount_overflow"))?;
                require(
                    *total <= r.observations[i].amount.minor_units(),
                    "double_consumption",
                )?;
            }
            connected.insert(a);
            connected.insert(b);
            let ra = root(&parent, a);
            let rb = root(&parent, b);
            parent[rb] = ra;
        } else if rel.kind == "same_event" {
            require(
                oa.amount == ob.amount && compatible(oa, ob, r.max_settlement_days, false),
                "same_event_mismatch",
            )?;
        } else if ["refund", "reversal", "reimbursement"].contains(&rel.kind.as_str()) {
            require(
                oa.direction != ob.direction && oa.amount.currency() == ob.amount.currency(),
                "return_direction",
            )?;
            let amount = rel
                .allocated_amount
                .as_ref()
                .ok_or(TransactionEvidenceError("allocation_required"))?;
            require(
                amount.currency() == oa.amount.currency()
                    && amount.minor_units() > 0
                    && amount.minor_units() <= oa.amount.minor_units()
                    && amount.minor_units() <= ob.amount.minor_units(),
                "return_amount",
            )?;
            for i in [a, b] {
                let total = return_consumption.entry(i).or_default();
                *total = total
                    .checked_add(amount.minor_units())
                    .ok_or(TransactionEvidenceError("amount_overflow"))?;
                require(
                    *total <= r.observations[i].amount.minor_units(),
                    "return_double_consumption",
                )?;
            }
        }
    }
    for (i, observation) in r.observations.iter().enumerate() {
        if observation.status == "superseded" {
            superseded.insert(i);
        }
        if observation.status != "pending" || observation.external_event_id.is_none() {
            continue;
        }
        let posted: Vec<_> = r
            .observations
            .iter()
            .enumerate()
            .filter(|(_, other)| {
                other.source_id == observation.source_id
                    && other.external_event_id == observation.external_event_id
                    && active(other)
                    && other.amount == observation.amount
                    && compatible(observation, other, r.max_settlement_days, false)
            })
            .collect();
        if posted.len() == 1 {
            superseded.insert(i);
            let other = posted[0].1;
            result.relationships.push(EvidenceRelationship {
                id: format!("supersession:{}:{}", observation.id, other.id),
                from_id: observation.id.clone(),
                to_id: other.id.clone(),
                kind: "supersession".into(),
                state: "confirmed".into(),
                allocated_amount: None,
                partial: false,
                score: 100,
                reason_codes: vec!["pending_to_posted".into()],
                evidence_ids: vec![
                    observation.provenance.document_id.clone(),
                    other.provenance.document_id.clone(),
                ],
            });
        }
    }
    // Stable external event identity permits aggregate funding without guessing a subset.
    let mut stable_groups = BTreeMap::<String, Vec<usize>>::new();
    for (i, o) in r.observations.iter().enumerate() {
        if active(o) && !connected.contains(&i) && o.reliability >= 80 {
            if let Some(external) = &o.external_event_id {
                stable_groups.entry(external.clone()).or_default().push(i);
            }
        }
    }
    for group in stable_groups.values() {
        let sources: Vec<_> = group
            .iter()
            .copied()
            .filter(|i| r.observations[*i].kind != "ledger_transaction")
            .collect();
        let targets: Vec<_> = group
            .iter()
            .copied()
            .filter(|i| r.observations[*i].kind == "ledger_transaction")
            .collect();
        if sources.is_empty() || targets.is_empty() || (sources.len() == 1 && targets.len() == 1) {
            continue;
        }
        let cur = r.observations[sources[0]].amount.currency();
        if !sources.iter().all(|a| {
            targets.iter().all(|b| {
                r.observations[*a].source_id != r.observations[*b].source_id
                    && compatible(
                        &r.observations[*a],
                        &r.observations[*b],
                        r.max_settlement_days,
                        transfer_observation(&r.observations[*a]),
                    )
            })
        }) {
            continue;
        }
        let source_total = sum(sources.iter().map(|i| &r.observations[*i].amount), cur)?;
        if source_total == 0
            || source_total != sum(targets.iter().map(|i| &r.observations[*i].amount), cur)?
        {
            continue;
        }
        // A stable ID must not turn duplicated Actual rows into invented settlement.
        let mut ledger_ids = BTreeSet::new();
        if targets.iter().any(|i| {
            r.observations[*i]
                .ledger_transaction_id
                .as_ref()
                .is_some_and(|id| !ledger_ids.insert(id))
        }) {
            continue;
        }
        let mut remaining: BTreeMap<_, _> = targets
            .iter()
            .map(|i| (*i, r.observations[*i].amount.minor_units()))
            .collect();
        for a in sources {
            let mut unallocated = r.observations[a].amount.minor_units();
            for b in &targets {
                let available = remaining.get_mut(b).unwrap();
                let units = unallocated.min(*available);
                if units == 0 {
                    continue;
                }
                unallocated -= units;
                *available -= units;
                connected.insert(a);
                connected.insert(*b);
                let ra = root(&parent, a);
                let rb = root(&parent, *b);
                parent[rb] = ra;
                *consumption.entry(a).or_default() += units;
                *consumption.entry(*b).or_default() += units;
                result.relationships.push(EvidenceRelationship {
                    id: format!("auto:{}:{}", r.observations[a].id, r.observations[*b].id),
                    from_id: r.observations[a].id.clone(),
                    to_id: r.observations[*b].id.clone(),
                    kind: "partial_funding".into(),
                    state: "confirmed".into(),
                    allocated_amount: Some(Money::new(units, cur)),
                    partial: true,
                    score: 100,
                    reason_codes: vec!["stable_aggregate_identity".into()],
                    evidence_ids: vec![
                        r.observations[a].provenance.document_id.clone(),
                        r.observations[*b].provenance.document_id.clone(),
                    ],
                });
            }
        }
    }
    // Match only distinct source roles with stable identity or corroborated funding.
    let mut candidates = BTreeMap::<usize, Vec<usize>>::new();
    let mut plausible = BTreeMap::<usize, Vec<usize>>::new();
    for (a, oa) in r.observations.iter().enumerate() {
        if connected.contains(&a) || !active(oa) || oa.kind == "ledger_transaction" {
            continue;
        }
        for (b, ob) in r.observations.iter().enumerate() {
            let ledger_target = ob.kind == "ledger_transaction";
            let local_pair = !ledger_target && a < b && supports_local_candidate(oa, ob);
            if connected.contains(&b)
                || !active(ob)
                || (!ledger_target && !local_pair)
                || oa.source_id == ob.source_id
                || !compatible(oa, ob, r.max_settlement_days, transfer_observation(oa))
            {
                continue;
            }
            if oa.amount != ob.amount
                || oa.amount.minor_units() == 0
                || r.relationships.iter().any(|relationship| {
                    ((relationship.from_id == oa.id && relationship.to_id == ob.id)
                        || (relationship.from_id == ob.id && relationship.to_id == oa.id))
                        && matches!(relationship.state.as_str(), "rejected" | "superseded")
                })
            {
                continue;
            }
            let stable =
                oa.external_event_id.is_some() && oa.external_event_id == ob.external_event_id;
            let context = oa.funding_instrument_id.is_some()
                && oa.funding_instrument_id == ob.funding_instrument_id
                && oa.counterparty.is_some()
                && oa.counterparty == ob.counterparty;
            plausible.entry(a).or_default().push(b);
            if !result.relationships.iter().any(|relationship| {
                relationship.from_id == oa.id
                    && relationship.to_id == ob.id
                    && relationship.state == "candidate"
            }) {
                let mut reasons = vec!["amount_direction_date_compatible".into()];
                if local_pair {
                    reasons.push("evidence_to_evidence_candidate".into());
                }
                if stable {
                    reasons.push("stable_external_identity".into());
                }
                if context {
                    reasons.push("funding_counterparty_corroboration".into());
                }
                if oa.reliability < 80 || ob.reliability < 80 {
                    reasons.push("low_source_reliability".into());
                }
                let score = if stable {
                    75
                } else if context {
                    65
                } else {
                    35
                };
                require(result.relationships.len() < 20_000, "candidate_limit")?;
                result.relationships.push(EvidenceRelationship {
                    id: format!(
                        "candidate:{:x}",
                        Sha256::digest(
                            serde_json::to_vec(&[&oa.id, &ob.id])
                                .map_err(|_| TransactionEvidenceError("serialization"))?
                        )
                    ),
                    from_id: oa.id.clone(),
                    to_id: ob.id.clone(),
                    kind: if transfer_observation(oa) {
                        "transfer"
                    } else {
                        "settlement"
                    }
                    .into(),
                    state: "candidate".into(),
                    allocated_amount: Some(oa.amount.clone()),
                    partial: false,
                    score,
                    reason_codes: reasons,
                    evidence_ids: vec![
                        oa.provenance.document_id.clone(),
                        ob.provenance.document_id.clone(),
                    ],
                });
            }
            if ledger_target
                && (stable || context)
                && oa.amount == ob.amount
                && oa.reliability >= 80
                && ob.reliability >= 80
            {
                candidates.entry(a).or_default().push(b);
            }
        }
    }
    let mut ambiguous = BTreeSet::new();
    for (&a, bs) in &candidates {
        let b = bs[0];
        let competing = candidates.values().filter(|list| list.contains(&b)).count();
        if bs.len() != 1 || competing != 1 {
            ambiguous.insert(a);
            ambiguous.extend(bs);
            continue;
        }
        connected.insert(a);
        connected.insert(b);
        parent[b] = a;
        consumption.insert(a, r.observations[a].amount.minor_units());
        consumption.insert(b, r.observations[b].amount.minor_units());
        result.relationships.push(EvidenceRelationship {
            id: format!("auto:{}:{}", r.observations[a].id, r.observations[b].id),
            from_id: r.observations[a].id.clone(),
            to_id: r.observations[b].id.clone(),
            kind: if transfer_observation(&r.observations[a]) {
                "transfer"
            } else {
                "settlement"
            }
            .into(),
            state: "confirmed".into(),
            allocated_amount: Some(r.observations[a].amount.clone()),
            partial: false,
            score: 100,
            reason_codes: vec!["deterministic_identity".into()],
            evidence_ids: vec![
                r.observations[a].provenance.document_id.clone(),
                r.observations[b].provenance.document_id.clone(),
            ],
        });
    }
    for (&source, targets) in &plausible {
        if connected.contains(&source) {
            continue;
        }
        if targets.len() > 1
            || targets.iter().any(|target| {
                plausible
                    .iter()
                    .filter(|(other, options)| {
                        !connected.contains(other) && options.contains(target)
                    })
                    .count()
                    > 1
            })
        {
            ambiguous.insert(source);
            ambiguous.extend(targets);
        }
    }
    // Confirmed identity replaces its candidate; unresolved alternatives remain inspectable.
    let confirmed_pairs: BTreeSet<_> = result
        .relationships
        .iter()
        .filter(|relationship| relationship.state == "confirmed" && consuming(&relationship.kind))
        .map(|relationship| (relationship.from_id.clone(), relationship.to_id.clone()))
        .collect();
    result.relationships.retain(|relationship| {
        relationship.state != "candidate"
            || !confirmed_pairs
                .contains(&(relationship.from_id.clone(), relationship.to_id.clone()))
    });
    let mut groups = BTreeMap::<usize, Vec<usize>>::new();
    for i in 0..r.observations.len() {
        if !superseded.contains(&i) {
            groups.entry(root(&parent, i)).or_default().push(i);
        }
    }
    for indices in groups.values() {
        let first = &r.observations[indices[0]];
        let ids: Vec<_> = indices
            .iter()
            .map(|i| r.observations[*i].id.clone())
            .collect();
        let evidence: Vec<_> = indices
            .iter()
            .map(|i| r.observations[*i].provenance.document_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let event_id = format!(
            "event:{:x}",
            Sha256::digest(
                serde_json::to_vec(&ids).map_err(|_| TransactionEvidenceError("serialization"))?
            )
        );
        let kinds: BTreeSet<_> = indices
            .iter()
            .map(|i| r.observations[*i].event_type.as_str())
            .filter(|k| *k != "unknown")
            .collect();
        let event_type = if kinds.len() == 1 {
            *kinds.first().unwrap()
        } else if kinds.is_empty() {
            "unknown"
        } else {
            "mixed"
        };
        let is_ambiguous = indices.iter().any(|i| ambiguous.contains(i));
        let fully = indices
            .iter()
            .all(|i| consumption.get(i) == Some(&r.observations[*i].amount.minor_units()));
        let state = if is_ambiguous {
            "ambiguous"
        } else if fully && connected.contains(&indices[0]) {
            "resolved"
        } else {
            "unmatched"
        };
        let code = if is_ambiguous {
            "economic_event_ambiguity"
        } else {
            "unmatched_funds"
        };
        if state != "resolved" {
            blocker(&mut result.blockers, code, &event_id, evidence.clone());
        }
        let source_ids: BTreeSet<_> = result
            .relationships
            .iter()
            .filter(|rel| rel.state == "confirmed" && consuming(&rel.kind))
            .map(|rel| rel.from_id.as_str())
            .collect();
        let source_amount = sum(
            indices
                .iter()
                .filter(|i| source_ids.contains(r.observations[**i].id.as_str()))
                .map(|i| &r.observations[*i].amount),
            first.amount.currency(),
        )?;
        let amount = Money::new(
            if source_amount == 0 {
                first.amount.minor_units()
            } else {
                source_amount
            },
            first.amount.currency(),
        );
        let existing = indices
            .iter()
            .any(|i| r.observations[*i].ledger_transaction_id.is_some());
        let mut reasons = vec![];
        let mut projection = None;
        if existing {
            reasons.push("existing_ledger_transaction".into());
        }
        if state == "resolved" && event_type != "unknown" {
            let effects: Vec<_> = indices
                .iter()
                .filter_map(|i| r.observations[*i].ledger_effect.as_ref())
                .collect();
            if effects.len() == 1
                && effects[0].amount.minor_units().checked_abs() == Some(amount.minor_units())
            {
                let existing_rows: Vec<_> = indices
                    .iter()
                    .map(|i| &r.observations[*i])
                    .filter(|source| source.ledger_transaction_id.is_some())
                    .collect();
                let amendment_target = if existing_rows.len() == 1 {
                    let source = existing_rows[0];
                    let signed = if source.direction == "outflow" {
                        -source.amount.minor_units()
                    } else {
                        source.amount.minor_units()
                    };
                    (source.kind == "ledger_transaction"
                        && source.ledger_account_id.as_ref() == Some(&effects[0].account_id)
                        && source.date == effects[0].date
                        && source.amount.currency() == effects[0].amount.currency()
                        && signed == effects[0].amount.minor_units())
                    .then(|| source.ledger_transaction_id.clone().unwrap())
                } else {
                    None
                };
                if !existing || amendment_target.is_some() {
                    projection = Some(SourceObservation {
                        wallet_balance_anchor: None,
                        allocation_review: None,
                        kind: ObservationKind::EconomicEventResolution,
                        scope: DecisionScope::Transaction(
                            amendment_target.unwrap_or_else(|| event_id.clone()),
                        ),
                        state: ObservationState::Resolved,
                        observed_at: indices
                            .iter()
                            .map(|i| r.observations[*i].provenance.received_at.clone())
                            .max(),
                        content_hash: None,
                        version: Some("1".into()),
                        ledger_effect: Some(effects[0].clone()),
                        evidence: evidence
                            .iter()
                            .map(|id| EvidenceReference {
                                evidence_id: id.clone(),
                                kind: "economic_event_resolution".into(),
                                authorized: true,
                                redaction: RedactionState::Visible,
                            })
                            .collect(),
                    });
                }
            }
        }
        if projection.is_some() && !existing {
            let overlap = r.observations.iter().any(|ledger| {
                ledger.kind == "ledger_transaction"
                    && active(ledger)
                    && ledger.amount.minor_units() > 0
                    && ledger.amount.minor_units() <= amount.minor_units()
                    && indices.iter().any(|i| {
                        compatible(
                            &r.observations[*i],
                            ledger,
                            r.max_settlement_days,
                            transfer_observation(&r.observations[*i]),
                        )
                    })
            });
            if overlap {
                projection = None;
                reasons.push("ledger_overlap_ambiguity".into());
                blocker(
                    &mut result.blockers,
                    "ledger_overlap_ambiguity",
                    &event_id,
                    evidence.clone(),
                );
            }
        }
        result.events.push(ResolvedEconomicEvent {
            id: event_id,
            version: "1".into(),
            event_type: event_type.into(),
            state: state.into(),
            amount,
            observation_ids: ids,
            evidence_ids: evidence,
            reason_codes: reasons,
            projection_observation: projection,
            projection_observations: vec![],
            allocation_set_hash: None,
        });
    }
    resolve_receipts(&r, &mut result)?;
    resolve_wallets(&r, &mut result)?;
    result.relationships.sort_by(|a, b| a.id.cmp(&b.id));
    // Hash normalized source data, not derived text or caller-supplied hashes alone.
    let bytes = serde_json::to_vec(&r).map_err(|_| TransactionEvidenceError("serialization"))?;
    result.resolution_hash = format!("{:x}", Sha256::digest(bytes));
    let blocked_subjects =
        blocked_projection_subjects(r.observations.iter(), &r.wallets, &result.blockers);
    for event in &mut result.events {
        if let Some(observation) = &mut event.projection_observation {
            observation.content_hash = Some(result.resolution_hash.clone());
        }
        if blocked_subjects.contains(event.id.as_str())
            || event
                .observation_ids
                .iter()
                .any(|id| blocked_subjects.contains(id.as_str()))
        {
            event.state = "blocked".into();
            event.projection_observation = None;
        }
    }
    crate::evidence_allocation::apply_allocation_review(&r, &mut result)
        .map_err(|e| TransactionEvidenceError(e.0))?;
    Ok(result)
}

// Index wallet-dependent observations once; ordinary event blockers need no history scan.
pub(crate) fn blocked_projection_subjects<'a>(
    observations: impl Iterator<Item = &'a EvidenceObservation>,
    wallets: &'a [WalletEvidence],
    blockers: &'a [EvidenceBlocker],
) -> BTreeSet<&'a str> {
    let mut subjects: BTreeSet<_> = blockers
        .iter()
        .map(|blocker| blocker.subject_id.as_str())
        .collect();
    let discontinuous: BTreeSet<_> = blockers
        .iter()
        .filter(|blocker| blocker.code == "wallet_balance_discontinuity")
        .map(|blocker| blocker.subject_id.as_str())
        .collect();
    let unknown: BTreeSet<_> = blockers
        .iter()
        .filter(|blocker| blocker.code == "wallet_balance_unknown")
        .map(|blocker| blocker.subject_id.as_str())
        .collect();
    if discontinuous.is_empty() && unknown.is_empty() {
        return subjects;
    }
    let accounts: BTreeMap<_, _> = wallets
        .iter()
        .filter_map(|wallet| {
            wallet
                .materialized_account_id
                .as_deref()
                .map(|account| (wallet.wallet_id.as_str(), account))
        })
        .collect();
    for observation in observations {
        let Some(wallet) = observation.wallet_id.as_deref() else {
            continue;
        };
        let requires_balance = observation.funding_instrument_id.as_deref() == Some(wallet)
            || observation.ledger_effect.as_ref().is_some_and(|effect| {
                accounts
                    .get(wallet)
                    .is_some_and(|account| *account == effect.account_id)
            });
        if discontinuous.contains(wallet) || (unknown.contains(wallet) && requires_balance) {
            subjects.insert(observation.id.as_str());
        }
    }
    subjects
}

fn resolve_wallets(
    r: &TransactionEvidenceRequest,
    out: &mut TransactionEvidenceResult,
) -> Result<()> {
    require(r.statement_proofs.len() <= 100, "statement_proof_size")?;
    require(
        r.statement_proofs
            .iter()
            .try_fold(0usize, |total, p| {
                total.checked_add(p.activity_manifest.len())
            })
            .is_some_and(|total| total <= 20000),
        "statement_manifest_work_limit",
    )?;
    let mut proof_ids = BTreeSet::new();
    require(
        r.statement_proofs
            .iter()
            .all(|p| proof_ids.insert(&p.proof_id)),
        "statement_duplicate_proof",
    )?;
    require(
        r.statement_proofs
            .iter()
            .all(|p| r.wallets.iter().any(|w| w.wallet_id == p.wallet_id)),
        "statement_wallet_missing",
    )?;
    let mut ids = BTreeSet::new();
    for wallet in &r.wallets {
        require(
            id(&wallet.wallet_id) && ids.insert(&wallet.wallet_id) && currency(&wallet.currency),
            "wallet",
        )?;
        require(
            wallet
                .materialized_account_id
                .as_ref()
                .is_none_or(|s| id(s)),
            "wallet_account",
        )?;
        for balance in [&wallet.opening_balance, &wallet.closing_balance]
            .into_iter()
            .flatten()
        {
            require(
                money(balance) && balance.currency() == wallet.currency,
                "wallet_balance",
            )?;
        }
        if r.statement_proofs
            .iter()
            .any(|p| p.wallet_id == wallet.wallet_id)
        {
            let resolution = crate::wallet_statement::resolve_statement_wallet(r, out, wallet)?;
            out.wallets.push(resolution);
            continue;
        }
        let mut net = 0i64;
        let mut daily = BTreeMap::<&str, (i64, i64)>::new();
        let activity: Vec<_> = r
            .observations
            .iter()
            .filter(|o| {
                o.wallet_id.as_ref() == Some(&wallet.wallet_id)
                    && o.kind.starts_with("wallet_")
                    && active(o)
            })
            .collect();
        let mut identities = BTreeSet::new();
        for o in &activity {
            require(o.amount.currency() == wallet.currency, "wallet_currency")?;
            if let Some(external) = &o.external_event_id {
                require(
                    identities.insert((&o.source_id, external)),
                    "duplicate_wallet_activity",
                )?;
            }
            let external_pass_through = o.kind == "wallet_payment"
                && o.funding_instrument_id
                    .as_ref()
                    .is_some_and(|id| id != &wallet.wallet_id)
                && out.events.iter().any(|event| {
                    event.state == "resolved"
                        && event.observation_ids.contains(&o.id)
                        && event.observation_ids.len() == 2
                        && event.observation_ids.iter().any(|id| {
                            r.observations.iter().any(|source| {
                                &source.id == id && source.kind == "ledger_transaction"
                            })
                        })
                });
            if external_pass_through {
                continue;
            }
            let totals = daily.entry(o.date.as_str()).or_default();
            let total = if o.direction == "inflow" {
                &mut totals.0
            } else {
                &mut totals.1
            };
            *total = total
                .checked_add(o.amount.minor_units())
                .ok_or(TransactionEvidenceError("amount_overflow"))?;
            let signed = if o.direction == "inflow" {
                o.amount.minor_units()
            } else {
                -o.amount.minor_units()
            };
            net = net
                .checked_add(signed)
                .ok_or(TransactionEvidenceError("amount_overflow"))?;
        }
        let mut opening = wallet.opening_balance.clone();
        let mut closing = wallet.closing_balance.clone();
        let mut state = "known";
        let mut reasons = vec![];
        if !wallet.complete_activity {
            state = "balance_unknown";
            reasons.push("wallet_activity_incomplete".into());
        }
        if opening.is_none() && wallet.complete_activity {
            if let Some(end) = &closing {
                let inferred = end
                    .minor_units()
                    .checked_sub(net)
                    .ok_or(TransactionEvidenceError("amount_overflow"))?;
                if inferred >= 0 {
                    opening = Some(Money::new(inferred, &wallet.currency));
                    reasons.push("algebraic_opening_balance".into());
                }
            }
        }
        if let Some(start) = &opening {
            if wallet.complete_activity {
                let end = start
                    .minor_units()
                    .checked_add(net)
                    .ok_or(TransactionEvidenceError("amount_overflow"))?;
                if end < 0 || closing.as_ref().is_some_and(|m| m.minor_units() != end) {
                    state = "discontinuous";
                    reasons.push("wallet_balance_discontinuity".into());
                } else if closing.is_none() {
                    closing = Some(Money::new(end, &wallet.currency));
                }
                // Civil dates establish daily order only. An inflow cannot silently
                // fund an earlier day or establish the order of same-day activity.
                let mut balance = start.minor_units();
                for (inflow, outflow) in daily.values() {
                    let next = balance
                        .checked_add(*inflow)
                        .and_then(|amount| amount.checked_sub(*outflow))
                        .ok_or(TransactionEvidenceError("amount_overflow"))?;
                    if next < 0 {
                        state = "discontinuous";
                        if !reasons
                            .iter()
                            .any(|code| code == "wallet_balance_discontinuity")
                        {
                            reasons.push("wallet_balance_discontinuity".into());
                        }
                        break;
                    }
                    if balance < *outflow && state != "discontinuous" {
                        state = "balance_unknown";
                        if !reasons
                            .iter()
                            .any(|code| code == "wallet_activity_order_unknown")
                        {
                            reasons.push("wallet_activity_order_unknown".into());
                        }
                    }
                    balance = next;
                }
            }
        } else {
            state = "balance_unknown";
        }
        let stored = wallet.requires_stored_value
            || opening.as_ref().is_some_and(|m| m.minor_units() > 0)
            || closing.as_ref().is_some_and(|m| m.minor_units() > 0)
            || activity.iter().any(|o| o.direction == "inflow");
        let pass_through = !activity.is_empty()
            && activity.iter().all(|o| {
                out.events.iter().any(|e| {
                    e.state == "resolved"
                        && e.observation_ids.contains(&o.id)
                        && e.observation_ids.len() == 2
                })
            });
        let projection = if wallet.materialized_account_id.is_some() {
            "materialized"
        } else if stored {
            "materialize"
        } else if state == "known"
            && pass_through
            && opening.as_ref().is_some_and(|m| m.minor_units() == 0)
            && closing.as_ref().is_some_and(|m| m.minor_units() == 0)
        {
            "collapsed"
        } else {
            "unresolved"
        };
        if state != "known" {
            blocker(
                &mut out.blockers,
                if state == "discontinuous" {
                    "wallet_balance_discontinuity"
                } else {
                    "wallet_balance_unknown"
                },
                &wallet.wallet_id,
                activity
                    .iter()
                    .map(|observation| observation.provenance.document_id.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect(),
            );
        }
        out.wallets.push(WalletEvidenceResolution {
            coverage: None,
            balance_anchors: None,
            anchor_observations: None,
            wallet_id: wallet.wallet_id.clone(),
            opening_balance: opening,
            closing_balance: closing,
            balance_state: state.into(),
            projection: projection.into(),
            reason_codes: reasons,
        });
    }
    Ok(())
}
fn resolve_receipts(
    r: &TransactionEvidenceRequest,
    out: &mut TransactionEvidenceResult,
) -> Result<()> {
    let mut ids = BTreeSet::new();
    let mut lines = BTreeMap::new();
    let mut line_owners = BTreeMap::new();
    let mut returned = BTreeMap::<String, u64>::new();
    let mut refunded = BTreeMap::<String, i64>::new();
    for receipt in &r.receipts {
        require(
            receipt.lines.len() <= 1000 && receipt.tenders.len() <= 100,
            "receipt_size",
        )?;
    }
    // Allocation totals span every active receipt, so renamed duplicates cannot
    // spend the same settlement twice. Superseded versions retain history only.
    let active_receipt = |receipt: &ReceiptEvidence| {
        !r.receipts
            .iter()
            .any(|newer| newer.supersedes_id.as_ref() == Some(&receipt.id))
    };
    let mut tender_consumption = BTreeMap::<String, i64>::new();
    let mut receipt_consumption = BTreeMap::<String, i64>::new();
    for receipt in r.receipts.iter().filter(|receipt| active_receipt(receipt)) {
        let total = receipt_consumption
            .entry(receipt.observation_id.clone())
            .or_default();
        *total = total
            .checked_add(receipt.total.minor_units())
            .ok_or(TransactionEvidenceError("amount_overflow"))?;
        // All competing active returns share one capacity, independent of ID order.
        for line in &receipt.lines {
            if let Some(prior) = &line.return_of_line_id {
                let quantity = returned.entry(prior.clone()).or_default();
                *quantity = quantity
                    .checked_add(u64::from(line.quantity_micros))
                    .ok_or(TransactionEvidenceError("amount_overflow"))?;
                let net = refunded.entry(prior.clone()).or_default();
                *net = net
                    .checked_add(line.net.minor_units())
                    .ok_or(TransactionEvidenceError("amount_overflow"))?;
            }
        }
        for tender in &receipt.tenders {
            if let Some(source) = &tender.observation_id {
                let total = tender_consumption.entry(source.clone()).or_default();
                *total = total
                    .checked_add(tender.amount.minor_units())
                    .ok_or(TransactionEvidenceError("amount_overflow"))?;
            }
        }
    }
    for receipt in &r.receipts {
        for line in &receipt.lines {
            require(
                id(&line.id) && lines.insert(line.id.clone(), line).is_none(),
                "duplicate_receipt_line",
            )?;
            line_owners.insert(line.id.as_str(), receipt);
        }
    }
    for receipt in &r.receipts {
        require(
            id(&receipt.id)
                && ids.insert(&receipt.id)
                && receipt.version > 0
                && r.observations
                    .iter()
                    .any(|o| o.id == receipt.observation_id),
            "receipt",
        )?;
        let cur = receipt.total.currency();
        require(
            money(&receipt.total)
                && money(&receipt.discount)
                && money(&receipt.tax)
                && receipt.discount.currency() == cur
                && receipt.tax.currency() == cur,
            "receipt_currency",
        )?;
        if let Some(prior) = &receipt.supersedes_id {
            require(
                r.receipts
                    .iter()
                    .any(|p| &p.id == prior && p.version < receipt.version),
                "receipt_version",
            )?;
        }
        let observation = r
            .observations
            .iter()
            .find(|o| o.id == receipt.observation_id)
            .unwrap();
        let active_version = active_receipt(receipt);
        let mut valid = !active_version
            || (active(observation)
                && observation.direction
                    == if observation.event_type == "refund" {
                        "inflow"
                    } else {
                        "outflow"
                    }
                && receipt_consumption
                    .get(&receipt.observation_id)
                    .is_none_or(|total| *total <= observation.amount.minor_units()));
        let mut weights = vec![];
        let mut discounts = 0i64;
        let mut taxes = 0i64;
        let mut nets = 0i64;
        for line in &receipt.lines {
            require(
                line.quantity_micros > 0
                    && line.evidence_strength <= 100
                    && line.raw_description.len() <= 4096
                    && line.normalized_description.len() <= 4096,
                "receipt_line",
            )?;
            for amount in [
                &line.unit_gross,
                &line.gross,
                &line.discount,
                &line.tax,
                &line.net,
            ] {
                require(
                    money(amount) && amount.currency() == cur,
                    "receipt_line_currency",
                )?;
            }
            let product =
                i128::from(line.unit_gross.minor_units()) * i128::from(line.quantity_micros);
            valid &= product % 1_000_000 == 0
                && product / 1_000_000 == i128::from(line.gross.minor_units());
            valid &= line
                .gross
                .minor_units()
                .checked_sub(line.discount.minor_units())
                .and_then(|n| n.checked_add(line.tax.minor_units()))
                == Some(line.net.minor_units())
                && line.discount.minor_units() <= line.gross.minor_units();
            weights.push(line.gross.minor_units() as u64);
            discounts = discounts
                .checked_add(line.discount.minor_units())
                .ok_or(TransactionEvidenceError("amount_overflow"))?;
            taxes = taxes
                .checked_add(line.tax.minor_units())
                .ok_or(TransactionEvidenceError("amount_overflow"))?;
            nets = nets
                .checked_add(line.net.minor_units())
                .ok_or(TransactionEvidenceError("amount_overflow"))?;
            if let Some(prior) = &line.return_of_line_id {
                let original = lines
                    .get(prior)
                    .ok_or(TransactionEvidenceError("return_line_missing"))?;
                require(
                    prior != &line.id
                        && original.return_of_line_id.is_none()
                        && original.unit_gross == line.unit_gross,
                    "return_line_identity",
                )?;
                if active_version {
                    let original_receipt = line_owners[prior.as_str()];
                    let original_source = r
                        .observations
                        .iter()
                        .find(|source| source.id == original_receipt.observation_id)
                        .ok_or(TransactionEvidenceError("return_purchase_source"))?;
                    require(
                        active_receipt(original_receipt)
                            && original_source.status == "completed"
                            && original_source.direction == "outflow"
                            && matches!(
                                original_source.event_type.as_str(),
                                "purchase" | "p2p_payment"
                            )
                            && !matches!(
                                original_source.kind.as_str(),
                                "order" | "spend_session_item" | "wallet_request"
                            ),
                        "return_purchase_source",
                    )?;
                    valid &= returned.get(prior).copied().unwrap_or_default()
                        <= u64::from(original.quantity_micros);
                    valid &= refunded.get(prior).copied().unwrap_or_default()
                        <= original.net.minor_units();
                }
                require(
                    r.observations.iter().any(|o| {
                        o.id == receipt.observation_id
                            && o.direction == "inflow"
                            && o.event_type == "refund"
                    }),
                    "return_observation",
                )?;
            }
        }
        valid &= discounts == receipt.discount.minor_units()
            && taxes == receipt.tax.minor_units()
            && nets == receipt.total.minor_units()
            && !receipt.lines.is_empty();
        let mut tender_ids = BTreeSet::new();
        for tender in &receipt.tenders {
            require(
                id(&tender.id)
                    && tender_ids.insert(&tender.id)
                    && ["card", "bank", "gift_card", "reward", "wallet", "cash"]
                        .contains(&tender.kind.as_str()),
                "tender",
            )?;
            if let Some(tender_observation) = &tender.observation_id {
                let source = r
                    .observations
                    .iter()
                    .find(|o| &o.id == tender_observation)
                    .ok_or(TransactionEvidenceError("tender_observation"))?;
                valid &= source.amount.currency() == tender.amount.currency()
                    && source.direction == observation.direction
                    && active(source)
                    && tender.amount.minor_units() > 0
                    && if tender.partial {
                        tender.amount.minor_units() <= source.amount.minor_units()
                    } else {
                        source.amount == tender.amount
                    };
                if active_version {
                    valid &= tender_consumption
                        .get(&source.id)
                        .is_none_or(|total| *total <= source.amount.minor_units());
                }
            }
        }
        valid &=
            sum(receipt.tenders.iter().map(|t| &t.amount), cur)? == receipt.total.minor_units();
        let observation = r
            .observations
            .iter()
            .find(|o| o.id == receipt.observation_id)
            .unwrap();
        valid &= observation.amount == receipt.total;
        let allocate = |amount: &Money| {
            allocate_evidence_amount(amount, &weights)
                .map_err(|_| TransactionEvidenceError("receipt_allocation"))
        };
        let allocated_discount = if discounts == receipt.discount.minor_units() {
            receipt
                .lines
                .iter()
                .map(|line| line.discount.clone())
                .collect()
        } else {
            allocate(&receipt.discount)?
        };
        let allocated_tax = if taxes == receipt.tax.minor_units() {
            receipt.lines.iter().map(|line| line.tax.clone()).collect()
        } else {
            allocate(&receipt.tax)?
        };
        if !valid {
            blocker(
                &mut out.blockers,
                "receipt_total_mismatch",
                &receipt.observation_id,
                vec![observation.provenance.document_id.clone()],
            );
        }
        out.receipts.push(ReceiptEvidenceResolution {
            receipt_id: receipt.id.clone(),
            valid,
            allocated_discount,
            allocated_tax,
            reason_codes: if valid {
                vec![]
            } else {
                vec!["receipt_total_mismatch".into()]
            },
        });
    }
    // An invalid purchase cannot authorize a refund merely because its line exists.
    let valid_purchases: BTreeSet<_> = out
        .receipts
        .iter()
        .filter(|receipt| receipt.valid)
        .map(|receipt| receipt.receipt_id.as_str())
        .collect();
    let invalid_returns: BTreeSet<_> = r
        .receipts
        .iter()
        .filter(|receipt| {
            active_receipt(receipt)
                && receipt.lines.iter().any(|line| {
                    line.return_of_line_id.as_ref().is_some_and(|prior| {
                        !valid_purchases.contains(line_owners[prior.as_str()].id.as_str())
                    })
                })
        })
        .map(|receipt| receipt.id.as_str())
        .collect();
    for receipt in &mut out.receipts {
        if receipt.valid && invalid_returns.contains(receipt.receipt_id.as_str()) {
            receipt.valid = false;
            receipt.reason_codes.push("return_purchase_invalid".into());
            let source = r
                .receipts
                .iter()
                .find(|source| source.id == receipt.receipt_id)
                .unwrap();
            let observation = r
                .observations
                .iter()
                .find(|observation| observation.id == source.observation_id)
                .unwrap();
            blocker(
                &mut out.blockers,
                "return_purchase_invalid",
                &source.observation_id,
                vec![observation.provenance.document_id.clone()],
            );
        }
    }
    Ok(())
}

record!(EvidenceRuleCriterion {
    kind: String,
    value: String
});
fn supplied_criterion<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<EvidenceRuleCriterion>, D::Error> {
    EvidenceRuleCriterion::deserialize(deserializer).map(Some)
}
/// An immutable scoped item rule; absent contextual criteria preserve the legacy exact-rule wire shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceRuleProposal {
    /// Optional reviewed contextual predicate; explicit null is not a criterion.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "supplied_criterion"
    )]
    pub criterion: Option<EvidenceRuleCriterion>,
    /// Immutable rule identity.
    pub id: String,
    /// Exact normalized source identity.
    pub source_id: String,
    /// Exact merchant or counterparty.
    pub counterparty: String,
    /// Exact funding instrument.
    pub funding_instrument_id: String,
    /// Exact source-provided SKU or UPC, required nullable for legacy rules.
    #[serde(deserialize_with = "required")]
    pub sku: Option<String>,
    /// Exact approved item text, required nullable for legacy rules.
    #[serde(deserialize_with = "required")]
    pub normalized_description: Option<String>,
    /// Approved target category identity.
    pub category_id: String,
}
record!(EvidenceRuleSimulationRequest { contract_version: String, rule: EvidenceRuleProposal, evidence: TransactionEvidenceRequest, actual_rule_categories: Vec<String> });
record!(EvidenceRuleMatch { receipt_id: String, line_id: String, current_category_id: Option<String>, proposed_category_id: String, conflict: bool });
record!(EvidenceRuleSimulationResult { rule_id: String, resolution_hash: String, matches: Vec<EvidenceRuleMatch>, conflicts: Vec<String>, false_positive_risk: String, requires_approval: bool });

record!(EvidenceItemCategoryOutcome { source_identity: String, document_id: String, content_hash: String, parser_version: String, receipt_id: String, line_id: String, account_id: String, category_id: Option<String>, policy_version: String });
record!(EvidenceItemRuleLearningRequest { #[serde(default, skip_serializing_if="unreviewed")] include_broader_criteria: bool, contract_version: String, policy_version: String, account_id: String, evidence: TransactionEvidenceRequest, outcomes: Vec<EvidenceItemCategoryOutcome> });
record!(EvidenceItemRuleExample {
    receipt_id: String,
    line_id: String,
    document_id: String,
    category_id: String
});
record!(EvidenceItemRuleCandidate { candidate_hash: String, rule: EvidenceRuleProposal, account_id: String, source_identities: Vec<String>, document_ids: Vec<String>, examples: Vec<EvidenceItemRuleExample>, review_count: usize, requires_approval: bool });
record!(EvidenceItemRuleLearningResult { contract_version: String, resolution_hash: String, candidates: Vec<EvidenceItemRuleCandidate>, conflicts: Vec<String> });

/// Learn reviewable exact criteria from explicit human outcomes, never imported category hints.
/// The caller supplies authorized current-source identities and attributable human decisions.
pub fn learn_transaction_evidence_item_rules(
    request: &EvidenceItemRuleLearningRequest,
) -> Result<EvidenceItemRuleLearningResult> {
    require(
        request.contract_version == "1"
            && id(&request.policy_version)
            && id(&request.account_id)
            && request.outcomes.len() <= 10000,
        "item_learning_scope",
    )?;
    let resolution = resolve_transaction_evidence(&request.evidence)?;
    type Criteria = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<(String, String)>,
    );
    let mut groups = BTreeMap::<Criteria, Vec<&EvidenceItemCategoryOutcome>>::new();
    let mut seen = BTreeSet::new();
    for outcome in &request.outcomes {
        require(
            hash(&outcome.source_identity)
                && hash(&outcome.content_hash)
                && [
                    &outcome.document_id,
                    &outcome.parser_version,
                    &outcome.receipt_id,
                    &outcome.line_id,
                    &outcome.account_id,
                    &outcome.policy_version,
                ]
                .into_iter()
                .all(|s| id(s))
                && outcome.category_id.as_ref().is_none_or(|s| id(s)),
            "item_outcome_shape",
        )?;
        require(
            seen.insert((
                &outcome.document_id,
                &outcome.receipt_id,
                &outcome.line_id,
                &outcome.account_id,
            )),
            "item_outcome_duplicate",
        )?;
        if outcome.policy_version != request.policy_version
            || outcome.account_id != request.account_id
            || outcome.category_id.is_none()
        {
            continue;
        }
        let receipt = request
            .evidence
            .receipts
            .iter()
            .find(|r| r.id == outcome.receipt_id)
            .ok_or(TransactionEvidenceError("item_outcome_receipt"))?;
        let observation = request
            .evidence
            .observations
            .iter()
            .find(|o| o.id == receipt.observation_id)
            .ok_or(TransactionEvidenceError("item_outcome_source"))?;
        require(
            observation.provenance.document_id == outcome.document_id
                && observation.provenance.content_hash == outcome.content_hash
                && observation.provenance.parser_version == outcome.parser_version,
            "item_outcome_source",
        )?;
        let line = receipt
            .lines
            .iter()
            .find(|l| l.id == outcome.line_id)
            .ok_or(TransactionEvidenceError("item_outcome_line"))?;
        if !resolution
            .receipts
            .iter()
            .any(|r| r.receipt_id == receipt.id && r.valid)
            || request
                .evidence
                .receipts
                .iter()
                .any(|r| r.supersedes_id.as_ref() == Some(&receipt.id))
            || line.return_of_line_id.is_some()
            || observation.direction != "outflow"
        {
            continue;
        }
        let (Some(counterparty), Some(funding)) = (
            &observation.counterparty,
            &observation.funding_instrument_id,
        ) else {
            continue;
        };
        if counterparty.trim().is_empty() || funding.trim().is_empty() {
            continue;
        }
        let sku = line.sku.as_ref().filter(|s| id(s)).cloned();
        let description = if sku.is_none()
            && id(&line.normalized_description)
            && !line.normalized_description.trim().is_empty()
        {
            Some(line.normalized_description.clone())
        } else {
            None
        };
        let mut criteria = Vec::new();
        if sku.is_some() || description.is_some() {
            criteria.push((sku, description, None));
        }
        if request.include_broader_criteria {
            for (kind, value) in [
                ("retailer_mapping", Some(&line.raw_description)),
                ("department", line.department.as_ref()),
                ("product_family", line.product_family.as_ref()),
                ("historical_similarity", Some(&line.normalized_description)),
            ] {
                if let Some(value) = value.filter(|value| {
                    id(value)
                        && !value.trim().is_empty()
                        && (kind != "historical_similarity" || item_tokens(value).len() >= 2)
                }) {
                    criteria.push((None, None, Some((kind.to_owned(), value.clone()))));
                }
            }
        }
        for (sku, description, criterion) in criteria {
            groups
                .entry((
                    observation.source_id.clone(),
                    counterparty.clone(),
                    funding.clone(),
                    sku,
                    description,
                    criterion,
                ))
                .or_default()
                .push(outcome);
        }
    }
    let mut candidates = vec![];
    let mut conflicts = BTreeSet::new();
    for (
        (source_id, counterparty, funding_instrument_id, sku, normalized_description, criterion),
        mut outcomes,
    ) in groups
    {
        outcomes.sort_by_key(|o| (&o.document_id, &o.receipt_id, &o.line_id));
        let categories: BTreeSet<_> = outcomes
            .iter()
            .filter_map(|o| o.category_id.as_ref())
            .collect();
        if categories.len() != 1 {
            conflicts.insert("reviewed_category_conflict".to_owned());
            continue;
        }
        let identities: BTreeSet<_> = outcomes.iter().map(|o| o.source_identity.clone()).collect();
        let content: BTreeSet<_> = outcomes.iter().map(|o| o.content_hash.clone()).collect();
        let documents: BTreeSet<_> = outcomes.iter().map(|o| o.document_id.clone()).collect();
        let events: BTreeSet<_> = outcomes
            .iter()
            .map(|outcome| {
                request
                    .evidence
                    .receipts
                    .iter()
                    .find(|receipt| receipt.id == outcome.receipt_id)
                    .and_then(|receipt| {
                        request
                            .evidence
                            .observations
                            .iter()
                            .find(|observation| observation.id == receipt.observation_id)
                    })
                    .and_then(|observation| observation.external_event_id.as_ref())
                    .map(|identity| (true, identity.clone()))
                    .unwrap_or_else(|| (false, outcome.content_hash.clone()))
            })
            .collect();
        if identities.len() < 2 || content.len() < 2 || documents.len() < 2 || events.len() < 2 {
            continue;
        }
        let category_id = (*categories.first().expect("one category")).clone();
        let examples = outcomes
            .iter()
            .map(|o| EvidenceItemRuleExample {
                receipt_id: o.receipt_id.clone(),
                line_id: o.line_id.clone(),
                document_id: o.document_id.clone(),
                category_id: category_id.clone(),
            })
            .collect::<Vec<_>>();
        let payload = serde_json::to_vec(&(
            &request.policy_version,
            &resolution.resolution_hash,
            &request.account_id,
            &source_id,
            &counterparty,
            &funding_instrument_id,
            &sku,
            &normalized_description,
            &category_id,
            &identities,
            &content,
            &examples,
        ))
        .map_err(|_| TransactionEvidenceError("serialization"))?;
        let payload = if criterion.is_some() {
            serde_json::to_vec(&(payload, &criterion))
                .map_err(|_| TransactionEvidenceError("serialization"))?
        } else {
            payload
        };
        let candidate_hash = format!("{:x}", Sha256::digest(payload));
        let rule = EvidenceRuleProposal {
            id: candidate_hash.clone(),
            criterion: criterion.map(|(kind, value)| EvidenceRuleCriterion { kind, value }),
            source_id,
            counterparty,
            funding_instrument_id,
            sku,
            normalized_description,
            category_id,
        };
        let review_count = identities.len().min(content.len()).min(events.len());
        candidates.push(EvidenceItemRuleCandidate {
            candidate_hash,
            rule,
            account_id: request.account_id.clone(),
            source_identities: identities.into_iter().collect(),
            document_ids: documents.into_iter().collect(),
            examples,
            review_count,
            requires_approval: true,
        });
    }
    if request.include_broader_criteria {
        candidates.sort_by(|left, right| {
            item_rule_priority(&left.rule)
                .cmp(&item_rule_priority(&right.rule))
                .then(left.candidate_hash.cmp(&right.candidate_hash))
        });
    }
    Ok(EvidenceItemRuleLearningResult {
        contract_version: "1".into(),
        resolution_hash: resolution.resolution_hash,
        candidates,
        conflicts: conflicts.into_iter().collect(),
    })
}

fn item_tokens(value: &str) -> BTreeSet<String> {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(str::to_lowercase)
        .collect()
}
fn item_rule_priority(rule: &EvidenceRuleProposal) -> u8 {
    match rule
        .criterion
        .as_ref()
        .map(|criterion| criterion.kind.as_str())
    {
        None if rule.sku.is_some() => 0,
        None => 1,
        Some("retailer_mapping") => 2,
        Some("department") => 3,
        Some("product_family") => 4,
        _ => 5,
    }
}
fn item_rule_matches(rule: &EvidenceRuleProposal, line: &ReceiptLine) -> bool {
    if let Some(criterion) = &rule.criterion {
        return match criterion.kind.as_str() {
            "retailer_mapping" => line.raw_description == criterion.value,
            "department" => line.department.as_ref() == Some(&criterion.value),
            "product_family" => line.product_family.as_ref() == Some(&criterion.value),
            "historical_similarity" => {
                let reference = item_tokens(&criterion.value);
                let actual = item_tokens(&line.normalized_description);
                let common = reference.intersection(&actual).count();
                reference.len() >= 2
                    && actual.len() >= 2
                    && common * 10000 >= reference.union(&actual).count() * 8000
            }
            _ => false,
        };
    }
    rule.sku
        .as_ref()
        .is_none_or(|sku| line.sku.as_ref() == Some(sku))
        && rule
            .normalized_description
            .as_ref()
            .is_none_or(|description| &line.normalized_description == description)
}

/// Simulate a narrowly scoped item rule against financially validated history.
///
/// Actual rule categories must be supplied by the authorized caller for this
/// exact source/account scope. Simulation never installs or approves a rule.
pub fn simulate_transaction_evidence_rule(
    request: &EvidenceRuleSimulationRequest,
) -> Result<EvidenceRuleSimulationResult> {
    let rule = &request.rule;
    require(
        request.contract_version == "1"
            && id(&rule.id)
            && id(&rule.source_id)
            && id(&rule.counterparty)
            && !rule.counterparty.trim().is_empty()
            && id(&rule.funding_instrument_id)
            && id(&rule.category_id),
        "rule_scope",
    )?;
    require(
        if let Some(criterion) = &rule.criterion {
            rule.sku.is_none()
                && rule.normalized_description.is_none()
                && id(&criterion.value)
                && !criterion.value.trim().is_empty()
                && matches!(
                    criterion.kind.as_str(),
                    "retailer_mapping" | "department" | "product_family" | "historical_similarity"
                )
                && (criterion.kind != "historical_similarity"
                    || item_tokens(&criterion.value).len() >= 2)
        } else {
            rule.sku.as_ref().is_some_and(|s| id(s))
                || rule.normalized_description.as_ref().is_some_and(|s| id(s))
        },
        "rule_specificity",
    )?;
    require(
        rule.sku.as_ref().is_none_or(|s| id(s))
            && rule.normalized_description.as_ref().is_none_or(|s| id(s))
            && request.actual_rule_categories.iter().all(|s| id(s)),
        "rule_condition",
    )?;
    let resolution = resolve_transaction_evidence(&request.evidence)?;
    let mut matches = vec![];
    let mut conflicts = BTreeSet::new();
    if request
        .actual_rule_categories
        .iter()
        .any(|c| c != &rule.category_id)
    {
        conflicts.insert("actual_rule_category_conflict".to_string());
    }
    for receipt in &request.evidence.receipts {
        if !resolution
            .receipts
            .iter()
            .any(|r| r.receipt_id == receipt.id && r.valid)
        {
            continue;
        }
        if request
            .evidence
            .receipts
            .iter()
            .any(|r| r.supersedes_id.as_ref() == Some(&receipt.id))
        {
            continue;
        }
        let observation = request
            .evidence
            .observations
            .iter()
            .find(|o| o.id == receipt.observation_id)
            .unwrap();
        if observation.source_id != rule.source_id
            || observation.counterparty.as_ref() != Some(&rule.counterparty)
            || observation.funding_instrument_id.as_ref() != Some(&rule.funding_instrument_id)
        {
            continue;
        }
        for line in &receipt.lines {
            if line.return_of_line_id.is_some() || !item_rule_matches(rule, line) {
                continue;
            }
            let conflict = line
                .category_id
                .as_ref()
                .is_some_and(|category| category != &rule.category_id);
            if conflict {
                conflicts.insert("historical_category_conflict".to_string());
            }
            matches.push(EvidenceRuleMatch {
                receipt_id: receipt.id.clone(),
                line_id: line.id.clone(),
                current_category_id: line.category_id.clone(),
                proposed_category_id: rule.category_id.clone(),
                conflict,
            });
        }
    }
    matches.sort_by(|a, b| {
        a.receipt_id
            .cmp(&b.receipt_id)
            .then(a.line_id.cmp(&b.line_id))
    });
    let risk = if !conflicts.is_empty() {
        "conflicting_history"
    } else if matches.is_empty() {
        "no_history"
    } else if rule.criterion.is_some() {
        "broader_scope_review_required"
    } else {
        "review_required"
    };
    Ok(EvidenceRuleSimulationResult {
        rule_id: rule.id.clone(),
        resolution_hash: resolution.resolution_hash,
        matches,
        conflicts: conflicts.into_iter().collect(),
        false_positive_risk: risk.into(),
        requires_approval: true,
    })
}

#[cfg(test)]
mod blocker_work_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn blocker_index_inspects_history_at_most_once_independent_of_blocker_count() {
        let request: TransactionEvidenceRequest = serde_json::from_str(include_str!(
            "../../../protocol/fixtures/transaction-evidence.json"
        ))
        .unwrap();
        let observations: Vec<_> = (0..10_000)
            .map(|index| {
                let mut observation = request.observations[0].clone();
                observation.id = format!("observation-{index}");
                observation.wallet_id = Some("wallet".into());
                observation.funding_instrument_id = Some("wallet".into());
                observation
            })
            .collect();
        let mut blockers: Vec<_> = (0..10_000)
            .map(|index| EvidenceBlocker {
                code: "unmatched_funds".into(),
                subject_id: format!("event-{index}"),
                evidence_ids: vec![],
            })
            .collect();
        let inspected = Cell::new(0);
        let subjects = blocked_projection_subjects(
            observations
                .iter()
                .inspect(|_| inspected.set(inspected.get() + 1)),
            &[],
            &blockers,
        );
        assert_eq!(subjects.len(), 10_000);
        assert_eq!(
            inspected.get(),
            0,
            "ordinary blockers do not inspect wallet history"
        );
        blockers.push(EvidenceBlocker {
            code: "wallet_balance_unknown".into(),
            subject_id: "wallet".into(),
            evidence_ids: vec![],
        });
        let subjects = blocked_projection_subjects(
            observations
                .iter()
                .inspect(|_| inspected.set(inspected.get() + 1)),
            &[],
            &blockers,
        );
        assert!(subjects.contains("observation-9999"));
        assert_eq!(
            inspected.get(),
            10_000,
            "wallet blockers inspect each observation exactly once"
        );
    }
}
