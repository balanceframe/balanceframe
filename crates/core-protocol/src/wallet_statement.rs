//! Bounded, human-attested statement coverage. This boundary validates arithmetic,
//! not issuer authenticity, actor membership, source grants or raw document custody.
use crate::{
    DecisionScope, EvidenceBlocker, EvidenceObservation, EvidenceReference, ObservationKind,
    ObservationState, RedactionState, SourceObservation, TransactionEvidenceError,
    TransactionEvidenceRequest, TransactionEvidenceResult, WalletEvidence,
    WalletEvidenceResolution,
};
use balanceframe_financial_core::Money;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
type Result<T> = std::result::Result<T, TransactionEvidenceError>;
macro_rules! record {
 ($name:ident { $($field:ident:$ty:ty),* $(,)? }) => {
 #[doc=concat!("Normalized human-attested statement contract: `",stringify!($name),"`.")]
 #[derive(Debug,Clone,PartialEq,Serialize,Deserialize)]
 #[serde(rename_all="camelCase",deny_unknown_fields)]
 pub struct $name { $(#[doc=concat!("Normalized `",stringify!($field),"`; does not grant source authority.")] #[serde(deserialize_with="required")] pub $field:$ty),* }
 };
}
fn required<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<T, D::Error> {
    T::deserialize(d)
}
record!(WalletStatementSource {
    document_id: String,
    content_hash: String,
    parser_version: String
});
record!(WalletStatementActivity {
    observation_id: String,
    document_id: String,
    content_hash: String,
    parser_version: String,
    normalized_fields_hash: String
});
record!(WalletStatementProof {proof_id:String,authority_kind:String,statement:WalletStatementSource,wallet_id:String,currency:String,calendar_basis:String,start_date:String,end_date:String,opening_balance:Option<Money>,closing_balance:Option<Money>,activity_manifest:Vec<WalletStatementActivity>,actor_id:String,membership_id:String,policy_version:String,reviewed_at:String});
record!(WalletStatementBalanceAnchor {wallet_id:String,amount:Money,as_of_date:String,boundary:String,proof_ids:Vec<String>,proof_set_hash:String,activity_manifest_hash:String,evidence_ids:Vec<String>});
record!(WalletStatementCoverageInterval {start_date:String,end_date:String,proof_ids:Vec<String>,evidence_ids:Vec<String>,opening_balance:Option<Money>,closing_balance:Option<Money>,state:String,reason_codes:Vec<String>});
record!(WalletStatementCoverage {intervals:Vec<WalletStatementCoverageInterval>,uncovered_observation_ids:Vec<String>,blocked_observation_ids:Vec<String>});
record!(DeriveWalletStatementPreviewRequest {
    contract_version: String,
    evidence: TransactionEvidenceRequest,
    wallet_id: String,
    start_date: String,
    end_date: String
});
record!(WalletStatementPreview {contract_version:String,wallet_id:String,currency:String,start_date:String,end_date:String,activity_manifest:Vec<WalletStatementActivity>,activity_manifest_hash:String,net_change:Money,inflows:Money,outflows:Money,excluded_observation_ids:Vec<String>,reason_codes:Vec<String>});
fn check(ok: bool, code: &'static str) -> Result<()> {
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
fn day(s: &str) -> Result<i64> {
    balanceframe_financial_core::evidence::evidence_date_ordinal(s)
        .ok_or(TransactionEvidenceError("statement_date"))
}
fn add(a: i64, b: i64) -> Result<i64> {
    a.checked_add(b)
        .ok_or(TransactionEvidenceError("amount_overflow"))
}
fn sub(a: i64, b: i64) -> Result<i64> {
    a.checked_sub(b)
        .ok_or(TransactionEvidenceError("amount_overflow"))
}
fn digest<T: Serialize>(value: &T) -> String {
    let value = serde_json::to_value(value).expect("statement contracts serialize");
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).expect("JSON value serializes"))
    )
}
fn manifest(observations: &[&EvidenceObservation]) -> Vec<WalletStatementActivity> {
    observations
        .iter()
        .map(|o| {
            let mut fields = serde_json::to_value(o).expect("observation serializes");
            for name in ["provenance", "ledgerEffect", "reviewedLedgerEffect"] {
                fields.as_object_mut().unwrap().remove(name);
            }
            WalletStatementActivity {
                observation_id: o.id.clone(),
                document_id: o.provenance.document_id.clone(),
                content_hash: o.provenance.content_hash.clone(),
                parser_version: o.provenance.parser_version.clone(),
                normalized_fields_hash: digest(&fields),
            }
        })
        .collect()
}
fn signed(o: &EvidenceObservation) -> i64 {
    if o.direction == "inflow" {
        o.amount.minor_units()
    } else {
        -o.amount.minor_units()
    }
}
fn in_range(o: &EvidenceObservation, start: &str, end: &str) -> bool {
    o.date.as_str() >= start && o.date.as_str() <= end
}
fn activity<'a>(
    r: &'a TransactionEvidenceRequest,
    out: &TransactionEvidenceResult,
    wallet: &WalletEvidence,
) -> Result<(Vec<&'a EvidenceObservation>, Vec<String>)> {
    let mut observations: BTreeMap<&str, &EvidenceObservation> = r
        .observations
        .iter()
        .filter(|o| {
            o.wallet_id.as_deref() == Some(&wallet.wallet_id)
                && o.kind.starts_with("wallet_")
                && o.kind != "wallet_request"
                && o.status == "completed"
        })
        .map(|o| (o.id.as_str(), o))
        .collect();
    let mut excluded = BTreeSet::new();
    // Only explicitly confirmed duplicate/supersession links can collapse repeated activity.
    let mut adjacency = BTreeMap::<&str, BTreeSet<&str>>::new();
    let mut supersession = BTreeMap::new();
    for link in &out.relationships {
        if link.state != "confirmed"
            || !["same_event", "supersession"].contains(&link.kind.as_str())
        {
            continue;
        }
        if let (Some(a), Some(b)) = (
            observations.get(link.from_id.as_str()),
            observations.get(link.to_id.as_str()),
        ) {
            check(
                a.amount == b.amount && a.direction == b.direction && a.date == b.date,
                "statement_duplicate_mismatch",
            )?;
            if link.kind == "supersession" {
                check(
                    supersession
                        .insert(link.from_id.as_str(), link.to_id.as_str())
                        .is_none(),
                    "statement_supersession_fork",
                )?;
            }
            adjacency
                .entry(link.from_id.as_str())
                .or_default()
                .insert(link.to_id.as_str());
            adjacency
                .entry(link.to_id.as_str())
                .or_default()
                .insert(link.from_id.as_str());
        }
    }
    for from in supersession.keys() {
        let mut at = *from;
        let mut seen = BTreeSet::new();
        while let Some(next) = supersession.get(at) {
            check(seen.insert(at), "statement_supersession_cycle")?;
            at = next;
        }
    }
    let mut visited = BTreeSet::new();
    let mut removals = BTreeSet::new();
    for start in adjacency.keys() {
        if visited.contains(start) {
            continue;
        }
        let mut stack = vec![*start];
        let mut component = BTreeSet::new();
        while let Some(at) = stack.pop() {
            if !visited.insert(at) {
                continue;
            }
            component.insert(at);
            stack.extend(adjacency[at].iter().copied());
        }
        let keep = component
            .iter()
            .find(|id| !supersession.contains_key(**id))
            .ok_or(TransactionEvidenceError("statement_supersession_cycle"))?;
        removals.extend(component.iter().filter(|id| *id != keep).copied());
    }
    for remove in removals {
        observations.remove(remove);
        excluded.insert(remove.to_string());
    }
    let ledger: BTreeSet<_> = r
        .observations
        .iter()
        .filter(|o| o.kind == "ledger_transaction")
        .map(|o| o.id.as_str())
        .collect();
    let external: BTreeSet<_> = out
        .events
        .iter()
        .filter(|e| {
            e.state == "resolved"
                && e.observation_ids.len() == 2
                && e.observation_ids
                    .iter()
                    .any(|id| ledger.contains(id.as_str()))
        })
        .flat_map(|e| e.observation_ids.iter().map(String::as_str))
        .collect();
    observations.retain(|_, o| {
        let pass = o.kind == "wallet_payment"
            && o.funding_instrument_id
                .as_ref()
                .is_some_and(|id| id != &wallet.wallet_id)
            && external.contains(o.id.as_str());
        if pass {
            excluded.insert(o.id.clone());
        }
        !pass
    });
    let mut identities = BTreeSet::new();
    for o in observations.values() {
        check(o.amount.currency() == wallet.currency, "wallet_currency")?;
        if let Some(external) = &o.external_event_id {
            check(
                identities.insert((&o.source_id, external)),
                "duplicate_wallet_activity",
            )?;
        }
    }
    Ok((
        observations.into_values().collect(),
        excluded.into_iter().collect(),
    ))
}
/// Derive exact current activity identities and checked totals; this does not attest them.
pub fn derive_wallet_statement_preview(
    request: &DeriveWalletStatementPreviewRequest,
) -> Result<WalletStatementPreview> {
    check(request.contract_version == "1", "statement_version")?;
    check(
        day(&request.start_date)? <= day(&request.end_date)?,
        "statement_period",
    )?;
    let mut wallet_ids = BTreeSet::new();
    check(request.evidence.wallets.len() <= 1000, "wallet_size")?;
    for wallet in &request.evidence.wallets {
        check(
            id(&wallet.wallet_id)
                && wallet_ids.insert(&wallet.wallet_id)
                && wallet.currency.len() == 3
                && wallet.currency.bytes().all(|c| c.is_ascii_uppercase()),
            "wallet",
        )?;
        check(
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
            check(
                balance.minor_units() >= 0 && balance.currency() == wallet.currency,
                "wallet_balance",
            )?;
        }
    }
    let mut evidence = request.evidence.clone();
    evidence.statement_proofs.clear();
    evidence.wallets.clear();
    let out = crate::resolve_transaction_evidence(&evidence)?;
    let wallet = request
        .evidence
        .wallets
        .iter()
        .find(|w| w.wallet_id == request.wallet_id)
        .ok_or(TransactionEvidenceError("statement_wallet_missing"))?;
    let (activity, excluded) = activity(&evidence, &out, wallet)?;
    let selected: Vec<_> = activity
        .into_iter()
        .filter(|o| in_range(o, &request.start_date, &request.end_date))
        .collect();
    let mut inflows = 0;
    let mut outflows = 0;
    for o in &selected {
        if o.direction == "inflow" {
            inflows = add(inflows, o.amount.minor_units())?;
        } else {
            outflows = add(outflows, o.amount.minor_units())?;
        }
    }
    let manifest = manifest(&selected);
    Ok(WalletStatementPreview {
        contract_version: "1".into(),
        wallet_id: wallet.wallet_id.clone(),
        currency: wallet.currency.clone(),
        start_date: request.start_date.clone(),
        end_date: request.end_date.clone(),
        activity_manifest_hash: digest(&manifest),
        activity_manifest: manifest,
        net_change: Money::new(sub(inflows, outflows)?, &wallet.currency),
        inflows: Money::new(inflows, &wallet.currency),
        outflows: Money::new(outflows, &wallet.currency),
        excluded_observation_ids: excluded,
        reason_codes: vec!["human_attestation_required".into()],
    })
}
struct Interval<'a> {
    proof: &'a WalletStatementProof,
    opening: i64,
    closing: i64,
    valid: bool,
    reasons: Vec<String>,
    order_unknown: BTreeSet<String>,
    boundary_changes: BTreeMap<i64, i64>,
}
fn review_time(value: &str) -> bool {
    let suffix = value.get(19..).unwrap_or("");
    let suffix_valid = suffix == "Z"
        || suffix
            .strip_prefix('.')
            .and_then(|s| s.strip_suffix('Z'))
            .is_some_and(|digits| {
                !digits.is_empty()
                    && digits.len() <= 9
                    && digits.bytes().all(|c| c.is_ascii_digit())
            });
    suffix_valid
        && value.get(10..11) == Some("T")
        && value
            .get(17..19)
            .and_then(|s| s.parse::<u8>().ok())
            .is_some_and(|second| second <= 59)
        && balanceframe_financial_core::evidence::evidence_timestamp_valid(value)
}
fn validate_proof(p: &WalletStatementProof, w: &WalletEvidence) -> Result<()> {
    check(
        id(&p.proof_id)
            && id(&p.actor_id)
            && id(&p.membership_id)
            && id(&p.policy_version)
            && id(&p.statement.document_id)
            && id(&p.statement.parser_version)
            && hash(&p.statement.content_hash),
        "statement_identity",
    )?;
    check(
        p.authority_kind == "human_attested_statement"
            && p.calendar_basis == "statement_printed_date",
        "statement_authority",
    )?;
    check(
        p.currency == w.currency && day(&p.start_date)? <= day(&p.end_date)?,
        "statement_period",
    )?;
    check(review_time(&p.reviewed_at), "statement_review_time")?;
    check(
        p.opening_balance.is_some() || p.closing_balance.is_some(),
        "statement_boundary_required",
    )?;
    for m in [&p.opening_balance, &p.closing_balance]
        .into_iter()
        .flatten()
    {
        check(
            m.currency() == w.currency && m.minor_units() >= 0,
            "statement_balance",
        )?;
    }
    check(
        p.activity_manifest.len() <= 10000,
        "statement_manifest_size",
    )?;
    for m in &p.activity_manifest {
        check(
            id(&m.observation_id)
                && id(&m.document_id)
                && id(&m.parser_version)
                && hash(&m.content_hash)
                && hash(&m.normalized_fields_hash),
            "statement_manifest_identity",
        )?;
    }
    Ok(())
}
fn balance_at(interval: &Interval<'_>, boundary: i64) -> i64 {
    interval
        .boundary_changes
        .range(..boundary)
        .next_back()
        .map(|(_, balance)| *balance)
        .unwrap_or(interval.opening)
}
/// Resolve one wallet's bounded attestations. Blocker subjects are observation IDs,
/// so independent bank activity never inherits a wallet-wide proof failure.
pub(crate) fn resolve_statement_wallet(
    r: &TransactionEvidenceRequest,
    out: &mut TransactionEvidenceResult,
    wallet: &WalletEvidence,
) -> Result<WalletEvidenceResolution> {
    let (activity, _) = activity(r, out, wallet)?;
    let mut intervals = vec![];
    let mut proof_ids = BTreeSet::new();
    for proof in r
        .statement_proofs
        .iter()
        .filter(|p| p.wallet_id == wallet.wallet_id)
    {
        validate_proof(proof, wallet)?;
        check(
            proof_ids.insert(&proof.proof_id),
            "statement_duplicate_proof",
        )?;
        let selected: Vec<_> = activity
            .iter()
            .copied()
            .filter(|o| in_range(o, &proof.start_date, &proof.end_date))
            .collect();
        let mut expected = manifest(&selected);
        let mut actual = proof.activity_manifest.clone();
        expected.sort_by(|a, b| a.observation_id.cmp(&b.observation_id));
        actual.sort_by(|a, b| a.observation_id.cmp(&b.observation_id));
        let mut reasons = vec![];
        if expected != actual {
            reasons.push("statement_manifest_changed".into());
        }
        if proof.policy_version != r.policy_version {
            reasons.push("statement_policy_changed".into());
        }
        let mut daily = BTreeMap::<&str, (i64, i64, Vec<String>)>::new();
        let mut net = 0;
        for o in &selected {
            net = add(net, signed(o))?;
            let pair = daily.entry(&o.date).or_default();
            let total = if o.direction == "inflow" {
                &mut pair.0
            } else {
                pair.2.push(o.id.clone());
                &mut pair.1
            };
            *total = add(*total, o.amount.minor_units())?;
        }
        let opening = match &proof.opening_balance {
            Some(m) => m.minor_units(),
            None => sub(proof.closing_balance.as_ref().unwrap().minor_units(), net)?,
        };
        let closing = add(opening, net)?;
        if opening < 0
            || closing < 0
            || proof
                .closing_balance
                .as_ref()
                .is_some_and(|m| m.minor_units() != closing)
        {
            reasons.push("statement_balance_discontinuity".into());
        }
        let mut balance = opening;
        let mut unknown = BTreeSet::new();
        let mut boundary_changes = BTreeMap::new();
        for (date, (inflow, outflow, outflow_ids)) in daily {
            let next = sub(add(balance, inflow)?, outflow)?;
            if next < 0 {
                if !reasons
                    .iter()
                    .any(|s| s == "statement_balance_discontinuity")
                {
                    reasons.push("statement_balance_discontinuity".into());
                }
            } else if balance < outflow {
                unknown.extend(outflow_ids);
            }
            balance = next;
            boundary_changes.insert(day(date)?, balance);
        }
        intervals.push(Interval {
            proof,
            opening,
            closing,
            valid: reasons.is_empty(),
            reasons,
            order_unknown: unknown,
            boundary_changes,
        });
    }
    // Inclusive civil-day coverage overlaps at shared boundaries; no inferred order or gap filling.
    for a in 0..intervals.len() {
        for b in a + 1..intervals.len() {
            if !intervals[a].valid || !intervals[b].valid {
                continue;
            }
            let x = &intervals[a];
            let y = &intervals[b];
            let start = std::cmp::max(day(&x.proof.start_date)?, day(&y.proof.start_date)?);
            let end = std::cmp::min(day(&x.proof.end_date)? + 1, day(&y.proof.end_date)? + 1);
            if start <= end && balance_at(x, start) != balance_at(y, start) {
                for i in [a, b] {
                    intervals[i]
                        .reasons
                        .push("statement_overlap_conflict".into());
                }
            }
        }
    }
    for interval in &mut intervals {
        interval.valid = interval.reasons.is_empty();
    }
    let mut parent: Vec<usize> = (0..intervals.len()).collect();
    fn root(parent: &[usize], mut i: usize) -> usize {
        while parent[i] != i {
            i = parent[i];
        }
        i
    }
    for a in 0..intervals.len() {
        for b in a + 1..intervals.len() {
            let x = &intervals[a];
            let y = &intervals[b];
            if x.valid
                && y.valid
                && std::cmp::max(day(&x.proof.start_date)?, day(&y.proof.start_date)?)
                    <= std::cmp::min(day(&x.proof.end_date)? + 1, day(&y.proof.end_date)? + 1)
            {
                let ra = root(&parent, a);
                let rb = root(&parent, b);
                parent[rb] = ra;
            }
        }
    }
    struct Component {
        proof_ids: Vec<String>,
        evidence_ids: Vec<String>,
        proof_set_hash: String,
        activity_manifest_hash: String,
        observed_at: String,
    }
    let mut groups = BTreeMap::<usize, Vec<&WalletStatementProof>>::new();
    for (index, interval) in intervals.iter().enumerate().filter(|(_, i)| i.valid) {
        groups
            .entry(root(&parent, index))
            .or_default()
            .push(interval.proof);
    }
    let mut components = BTreeMap::new();
    for (key, proofs) in groups {
        // A connected component of compatible closed day intervals has no internal gap.
        let start = proofs.iter().map(|p| p.start_date.as_str()).min().unwrap();
        let end = proofs.iter().map(|p| p.end_date.as_str()).max().unwrap();
        let selected: Vec<_> = activity
            .iter()
            .copied()
            .filter(|o| in_range(o, start, end))
            .collect();
        let activity_manifest_hash = digest(&manifest(&selected));
        let mut evidence_ids: BTreeSet<_> = selected
            .iter()
            .map(|o| o.provenance.document_id.clone())
            .collect();
        evidence_ids.extend(proofs.iter().map(|p| p.statement.document_id.clone()));
        components.insert(
            key,
            Component {
                proof_ids: proofs.iter().map(|p| p.proof_id.clone()).collect(),
                evidence_ids: evidence_ids.into_iter().collect(),
                proof_set_hash: digest(&("wallet-statement-v1", &proofs, &activity_manifest_hash)),
                activity_manifest_hash,
                observed_at: proofs.iter().map(|p| p.reviewed_at.clone()).max().unwrap(),
            },
        );
    }
    let mut covered = BTreeSet::new();
    let mut blocked = BTreeSet::new();
    let mut anchors = vec![];
    let mut observations = vec![];
    let mut coverage_intervals = vec![];
    for (interval_index, interval) in intervals.iter().enumerate() {
        let p = interval.proof;
        let selected: Vec<_> = activity
            .iter()
            .copied()
            .filter(|o| in_range(o, &p.start_date, &p.end_date))
            .collect();
        let component = components.get(&root(&parent, interval_index));
        let evidence = if let Some(component) = component {
            component.evidence_ids.clone()
        } else {
            selected
                .iter()
                .map(|o| o.provenance.document_id.clone())
                .chain(std::iter::once(p.statement.document_id.clone()))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()
        };
        if interval.valid {
            covered.extend(selected.iter().map(|o| o.id.clone()));
            blocked.extend(interval.order_unknown.iter().cloned());
            // Shared hashes are computed once per compatible bounded component.
            let component = component.unwrap();
            for (amount, date, boundary) in [
                (interval.opening, &p.start_date, "before_day_activity"),
                (interval.closing, &p.end_date, "after_day_activity"),
            ] {
                let anchor = WalletStatementBalanceAnchor {
                    wallet_id: wallet.wallet_id.clone(),
                    amount: Money::new(amount, &wallet.currency),
                    as_of_date: date.clone(),
                    boundary: boundary.into(),
                    proof_ids: component.proof_ids.clone(),
                    proof_set_hash: component.proof_set_hash.clone(),
                    activity_manifest_hash: component.activity_manifest_hash.clone(),
                    evidence_ids: evidence.clone(),
                };
                observations.push(SourceObservation {
                    wallet_balance_anchor: Some(anchor.clone()),
                    allocation_review: None,
                    kind: ObservationKind::WalletStatementAnchor,
                    scope: DecisionScope::Claim(wallet.wallet_id.clone()),
                    state: ObservationState::Resolved,
                    observed_at: Some(component.observed_at.clone()),
                    content_hash: Some(component.proof_set_hash.clone()),
                    version: Some("wallet-statement-v1".into()),
                    ledger_effect: None,
                    evidence: evidence
                        .iter()
                        .map(|id| EvidenceReference {
                            evidence_id: id.clone(),
                            kind: "human_attested_statement".into(),
                            authorized: true,
                            redaction: RedactionState::Visible,
                        })
                        .collect(),
                });
                anchors.push(anchor);
            }
        }
        coverage_intervals.push(WalletStatementCoverageInterval {
            start_date: p.start_date.clone(),
            end_date: p.end_date.clone(),
            proof_ids: vec![p.proof_id.clone()],
            evidence_ids: evidence,
            opening_balance: if interval.valid {
                Some(Money::new(interval.opening, &wallet.currency))
            } else {
                None
            },
            closing_balance: if interval.valid {
                Some(Money::new(interval.closing, &wallet.currency))
            } else {
                None
            },
            state: if interval.valid { "covered" } else { "invalid" }.into(),
            reason_codes: {
                let mut reasons = interval.reasons.clone();
                if !interval.order_unknown.is_empty() {
                    reasons.push("wallet_statement_order_unknown".into());
                }
                reasons
            },
        });
    }
    let uncovered: Vec<_> = activity
        .iter()
        .filter(|o| !covered.contains(&o.id))
        .map(|o| o.id.clone())
        .collect();
    blocked.extend(
        activity
            .iter()
            .filter(|o| !covered.contains(&o.id))
            .map(|o| o.id.clone()),
    );
    let observation_index: BTreeMap<_, _> = activity.iter().map(|o| (o.id.as_str(), *o)).collect();
    for subject in &blocked {
        let observation = observation_index[subject.as_str()];
        out.blockers.push(EvidenceBlocker {
            code: if covered.contains(subject) {
                "wallet_statement_order_unknown"
            } else {
                "wallet_statement_balance_unknown"
            }
            .into(),
            subject_id: subject.clone(),
            evidence_ids: vec![observation.provenance.document_id.clone()],
        });
    }
    let mut valid: Vec<_> = intervals.iter().filter(|i| i.valid).collect();
    valid.sort_by_key(|i| &i.proof.start_date);
    let mut continuous = !valid.is_empty();
    let mut through = valid
        .first()
        .map(|i| i.proof.end_date.as_str())
        .unwrap_or("");
    for interval in &valid {
        if day(&interval.proof.start_date)? > day(through)? + 1 {
            continuous = false;
        }
        if interval.proof.end_date.as_str() > through {
            through = &interval.proof.end_date;
        }
    }
    let known = continuous
        && uncovered.is_empty()
        && blocked.is_empty()
        && intervals.iter().all(|i| i.valid);
    let opening = if known {
        valid
            .first()
            .map(|i| Money::new(i.opening, &wallet.currency))
    } else {
        None
    };
    let closing = if known {
        valid
            .iter()
            .max_by_key(|i| &i.proof.end_date)
            .map(|i| Money::new(i.closing, &wallet.currency))
    } else {
        None
    };
    let stored = wallet.requires_stored_value
        || anchors.iter().any(|a| a.amount.minor_units() > 0)
        || activity.iter().any(|o| o.direction == "inflow");
    Ok(WalletEvidenceResolution {
        coverage: Some(WalletStatementCoverage {
            intervals: coverage_intervals,
            uncovered_observation_ids: uncovered,
            blocked_observation_ids: blocked.into_iter().collect(),
        }),
        balance_anchors: Some(anchors),
        anchor_observations: Some(observations),
        wallet_id: wallet.wallet_id.clone(),
        opening_balance: opening,
        closing_balance: closing,
        balance_state: if known { "known" } else { "balance_unknown" }.into(),
        projection: if wallet.materialized_account_id.is_some() {
            "materialized"
        } else if stored {
            "materialize"
        } else {
            "unresolved"
        }
        .into(),
        reason_codes: {
            let mut reasons = BTreeSet::from(["human_attested_statement".to_string()]);
            for interval in &intervals {
                reasons.extend(interval.reasons.iter().cloned());
                if !interval.order_unknown.is_empty() {
                    reasons.insert("wallet_statement_order_unknown".into());
                }
            }
            if !continuous {
                reasons.insert("wallet_statement_coverage_gap".into());
            }
            reasons.into_iter().collect()
        },
    })
}
