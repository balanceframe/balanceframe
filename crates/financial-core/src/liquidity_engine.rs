//! Internal checked accounting and deterministic residual allocation.
use super::*;
use chrono::{DateTime, Datelike, Duration, FixedOffset, Timelike};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

type Checked<T> = Result<T, String>;
fn add(a: i64, b: i64) -> Checked<i64> {
    a.checked_add(b)
        .ok_or_else(|| "money_arithmetic_overflow".into())
}
fn sub(a: i64, b: i64) -> Checked<i64> {
    a.checked_sub(b)
        .ok_or_else(|| "money_arithmetic_overflow".into())
}
fn instant(s: &str) -> Checked<DateTime<FixedOffset>> {
    let bytes = s.as_bytes();
    if !(bytes.len() == 20
        || ((22..=30).contains(&bytes.len())
            && bytes[19] == b'.'
            && bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit)))
        || bytes.last() != Some(&b'Z')
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return Err("invalid_canonical_timestamp".into());
    }
    let parsed = DateTime::parse_from_rfc3339(s).map_err(|_| "invalid_timestamp")?;
    if parsed.timestamp_subsec_nanos() >= 1_000_000_000 {
        return Err("invalid_canonical_timestamp".into());
    }
    Ok(parsed)
}
fn stamp(at: DateTime<FixedOffset>) -> String {
    at.with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)
}
fn units(m: &Money, currency: &str, nonnegative: bool) -> Checked<i64> {
    if m.currency() != currency
        || currency.len() != 3
        || !currency.bytes().all(|b| b.is_ascii_uppercase())
    {
        return Err("currency_mismatch".into());
    }
    if nonnegative && m.is_negative() {
        return Err("negative_amount".into());
    }
    Ok(m.minor_units())
}
fn evidence_expiry(e: &FactEvidence, max_age_minutes: u64) -> Checked<DateTime<FixedOffset>> {
    if let Some(expiry) = &e.expires_at {
        return instant(expiry);
    }
    if e.source != FactSource::ActualLedger {
        return Err("missing_evidence_expiry".into());
    }
    let at = instant(e.observed_at.as_deref().ok_or("missing_observation_time")?)?;
    let minutes = i64::try_from(max_age_minutes).map_err(|_| "timestamp_overflow")?;
    let duration = Duration::try_minutes(minutes).ok_or("timestamp_overflow")?;
    at.checked_add_signed(duration)
        .ok_or_else(|| "timestamp_overflow".into())
}
fn observation_window(
    e: &FactEvidence,
    now: DateTime<FixedOffset>,
    max_age_minutes: u64,
) -> Checked<()> {
    let at = instant(e.observed_at.as_deref().ok_or("missing_observation_time")?)?;
    let until = evidence_expiry(e, max_age_minutes)?;
    if at > now || until <= now || until <= at {
        return Err("stale_factual_evidence".into());
    }
    // Reasons disclose provenance and qualifications; the explicit state controls coverage.
    Ok(())
}
fn known(e: &FactEvidence, now: DateTime<FixedOffset>, max_age_minutes: u64) -> Checked<()> {
    if e.state != FactState::Known || e.source == FactSource::PolicyAssumption {
        return Err("unknown_factual_evidence".into());
    }
    observation_window(e, now, max_age_minutes)
}
fn unique<'a>(ids: impl IntoIterator<Item = &'a str>) -> Checked<()> {
    let mut set = BTreeSet::new();
    for id in ids {
        if id.trim().is_empty() || !set.insert(id) {
            return Err("duplicate_or_empty_identity".into());
        }
    }
    Ok(())
}
fn month_category<'a>(
    categories: &'a BTreeMap<String, CategoryLiquidityFact>,
    category_id: &str,
    month: &str,
) -> Option<&'a CategoryLiquidityFact> {
    categories
        .values()
        .find(|category| category.category_id == category_id && category.as_of_month == month)
}
fn current_category<'a>(
    categories: &'a BTreeMap<String, CategoryLiquidityFact>,
    category_id: &str,
    input: &LiquidityInput,
) -> Option<&'a CategoryLiquidityFact> {
    month_category(categories, category_id, &input.facts.as_ref()?.as_of_month)
}
fn m(n: i64, c: &str) -> Money {
    Money::new(n, c)
}
fn identity(input: &LiquidityInput) -> BackingAllocation {
    BackingAllocation {
        version: "1".into(),
        snapshot_id: input.snapshot_id.clone(),
        content_hash: input.content_hash.clone(),
        policy_version: input.liquidity_policy.version.clone(),
        policy_hash: input.liquidity_policy.policy_hash.clone(),
        claim_set_revision: input.claim_set.revision.clone(),
        feasible: false,
        lines: vec![],
        reasons: vec![],
    }
}
pub(super) fn unavailable(input: &LiquidityInput, reason: &str) -> AccountAwareSpendabilityResult {
    let mut backing = identity(input);
    backing.reasons.push(reason.into());
    AccountAwareSpendabilityResult {
        version: "1".into(),
        snapshot_id: input.snapshot_id.clone(),
        content_hash: input.content_hash.clone(),
        policy_version: input.liquidity_policy.version.clone(),
        policy_hash: input.liquidity_policy.policy_hash.clone(),
        claim_set_revision: input.claim_set.revision.clone(),
        budget_funding_status: BudgetFundingStatus::InsufficientData,
        payment_liquidity_status: PaymentLiquidityStatus::InsufficientData,
        accounts_before: vec![],
        accounts_after: vec![],
        categories: vec![],
        backing_before: backing.clone(),
        backing_after: backing,
        purchases: vec![],
        horizon: input.horizon.clone(),
        expires_at: input.valid_until.clone(),
        assumptions: vec![],
        reasons: vec![reason.into()],
    }
}
#[derive(Clone)]
struct Cash {
    fact: AccountLiquidityFact,
    policy: AccountLiquidityPolicy,
    output: AccountCapacity,
    head: i64,
    backing: i64,
    adjusted: i64,
    known: bool,
    authorization: Option<i64>,
}
fn eligible(p: &AccountLiquidityPolicy, f: &AccountLiquidityFact) -> bool {
    f.on_budget && !f.closed && f.owned && p.role != AccountRole::Excluded
}
fn payment(a: &Cash) -> bool {
    a.known
        && eligible(&a.policy, &a.fact)
        && a.policy.payment_eligible
        && a.policy.role != AccountRole::Restricted
}
fn edge(a: &Cash, c: &CategoryLiquidityFact) -> bool {
    if !a.known
        || !eligible(&a.policy, &a.fact)
        || !a.policy.backing_eligible
        || a.fact.kind != LiquidityAccountKind::Cash
        || a.fact.currency != c.availability.currency()
    {
        return false;
    }
    if !a.policy.eligible_category_ids.is_empty()
        && !a.policy.eligible_category_ids.contains(&c.category_id)
    {
        return false;
    }
    a.policy.role != AccountRole::Restricted
        || (a
            .policy
            .restricted_cash_bucket_ids
            .contains(&c.cash_bucket_id)
            && a.policy.eligible_category_ids.contains(&c.category_id))
}
fn refresh(a: &mut Cash) -> Checked<()> {
    let c = &a.fact.currency;
    if a.known {
        a.output.adjusted_cash = Some(m(a.adjusted, c));
        a.output.signed_headroom = Some(m(a.head, c));
        a.output.existing_shortfall = Some(m(if a.head < 0 { sub(0, a.head)? } else { 0 }, c));
        a.output.safe_spending_capacity = Some(m(if payment(a) { a.head.max(0) } else { 0 }, c));
        a.output.safe_transfer_capacity = Some(m(
            if eligible(&a.policy, &a.fact)
                && a.policy.source_eligible
                && a.fact.kind == LiquidityAccountKind::Cash
                && a.policy.role != AccountRole::Restricted
            {
                a.head.max(0)
            } else {
                0
            },
            c,
        ));
        a.output.backing_capacity = Some(m(
            if a.policy.backing_eligible
                && eligible(&a.policy, &a.fact)
                && a.fact.kind == LiquidityAccountKind::Cash
            {
                a.backing.max(0)
            } else {
                0
            },
            c,
        ));
    }
    Ok(())
}
fn active(b: &LiquidityClaimBundle, now: DateTime<FixedOffset>) -> Checked<bool> {
    let expiry = instant(&b.expires_at)?;
    Ok(b.state != LiquidityClaimState::Settled
        && (b.initiated
            || b.state == LiquidityClaimState::Initiated
            || (b.state == LiquidityClaimState::Active && expiry > now)))
}
fn deduct(a: &mut Cash, n: i64, reason: &str, id: &str, backing: bool) -> Checked<()> {
    a.head = sub(a.head, n)?;
    if backing {
        a.backing = sub(a.backing, n)?;
    }
    a.output.deductions.push(CapacityDeduction {
        reason: reason.into(),
        evidence_id: id.into(),
        amount: m(n, &a.fact.currency),
        affects_backing: backing,
    });
    Ok(())
}
fn obligation_due(due: &str, end: DateTime<FixedOffset>) -> Checked<bool> {
    if due.len() == 10 {
        let date = chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d")
            .map_err(|_| "invalid_obligation_date")?;
        // A source date has no instant. Reserve the boundary day conservatively.
        Ok(date <= end.date_naive())
    } else {
        Ok(instant(due)? < end)
    }
}
fn prepare_account(
    f: &AccountLiquidityFact,
    p: &AccountLiquidityPolicy,
    input: &LiquidityInput,
    categories: &BTreeMap<String, CategoryLiquidityFact>,
    now: DateTime<FixedOffset>,
    funded_totals: &mut BTreeMap<String, i64>,
) -> Cash {
    let mut a = Cash {
        fact: f.clone(),
        policy: p.clone(),
        output: AccountCapacity {
            account_id: f.account_id.clone(),
            recorded_balance: f.recorded_balance.clone(),
            adjusted_cash: None,
            signed_headroom: None,
            existing_shortfall: None,
            safe_spending_capacity: None,
            safe_transfer_capacity: None,
            backing_capacity: None,
            deductions: vec![],
            reasons: vec![],
        },
        head: 0,
        backing: 0,
        adjusted: 0,
        known: false,
        authorization: None,
    };
    let mut funded_used = funded_totals.clone();
    let result = (|| -> Checked<()> {
        if !input.source_coverage_complete {
            return Err("incomplete_source_coverage".into());
        }
        if !eligible(p, f) {
            a.output.reasons.push("account_ineligible".into());
            return Ok(());
        }
        known(
            &f.balance_evidence,
            now,
            input.max_budget_snapshot_age_minutes,
        )?;
        known(
            &f.activity_evidence,
            now,
            input.max_budget_snapshot_age_minutes,
        )?;
        known(
            &f.schedule_evidence,
            now,
            input.max_budget_snapshot_age_minutes,
        )?;
        known(
            &f.currency_evidence,
            now,
            input.max_budget_snapshot_age_minutes,
        )?;
        known(&f.kind_evidence, now, input.max_budget_snapshot_age_minutes)?;
        known(
            &f.holds_evidence,
            now,
            input.max_budget_snapshot_age_minutes,
        )?;
        known(
            &f.ownership_evidence,
            now,
            input.max_budget_snapshot_age_minutes,
        )?;
        known(
            &f.freshness_evidence,
            now,
            input.max_budget_snapshot_age_minutes,
        )?;
        if !matches!(
            f.freshness_evidence.source,
            FactSource::InstitutionProvider | FactSource::UserAttested
        ) {
            return Err("account_freshness_unconfirmed".into());
        }
        if f.kind == LiquidityAccountKind::Unknown {
            return Err("unknown_account_kind".into());
        }
        if !f.ambiguity_reasons.is_empty() {
            return Err("ambiguous_account_evidence".into());
        }
        let c = &f.currency;
        a.adjusted = units(&f.recorded_balance, c, false)?;
        let mut economic = BTreeMap::<String, (i64, bool, BTreeSet<String>)>::new();
        unique(f.unsettled_flows.iter().map(|x| x.id.as_str()))?;
        unique(f.obligations.iter().map(|x| x.id.as_str()))?;
        unique(
            f.unsettled_flows
                .iter()
                .map(|flow| flow.economic_obligation_id.as_str()),
        )?;
        for flow in &f.unsettled_flows {
            let n = units(&flow.amount, c, true)?;
            if flow.economic_obligation_id.is_empty()
                || economic.contains_key(&flow.economic_obligation_id)
            {
                return Err("ambiguous_economic_obligation".into());
            }
            let deducted = flow.direction == FlowDirection::Inflow && flow.included_in_balance
                || flow.direction == FlowDirection::Outflow && !flow.included_in_balance;
            if deducted {
                a.adjusted = sub(a.adjusted, n)?;
                a.output.deductions.push(CapacityDeduction {
                    reason: if flow.direction == FlowDirection::Inflow {
                        "unsettled_inflow_excluded"
                    } else {
                        "unincluded_outflow"
                    }
                    .into(),
                    evidence_id: flow.id.clone(),
                    amount: flow.amount.clone(),
                    affects_backing: true,
                });
            }
            if flow.direction == FlowDirection::Outflow {
                economic.insert(
                    flow.economic_obligation_id.clone(),
                    (
                        n,
                        true,
                        flow.matched_transaction_ids.iter().cloned().collect(),
                    ),
                );
            }
        }
        a.head = a.adjusted;
        a.backing = a.adjusted;
        let buffer = units(&p.protected_buffer, c, true)?;
        deduct(&mut a, buffer, "protected_buffer", &p.account_id, true)?;
        deduct(
            &mut a,
            units(&f.holds, c, true)?,
            "hold",
            &f.account_id,
            true,
        )?;
        let mut reserves = BTreeMap::<String, (i64, Option<String>, String)>::new();
        let end = instant(&input.horizon.ends_at)?;
        for o in &f.obligations {
            let n = units(&o.amount, c, true)?;
            if !obligation_due(&o.due_at, end)? || o.paid || o.included_in_balance {
                continue;
            }
            if o.due_at.len() == 10 {
                a.output
                    .reasons
                    .push("date_only_obligation_reserved_conservatively".into());
            }
            let mut linked_flows = f.unsettled_flows.iter().filter(|flow| {
                flow.direction == FlowDirection::Outflow
                    && o.matched_transaction_ids.iter().any(|id| {
                        id == &flow.id
                            || flow.imported_id.as_ref() == Some(id)
                            || flow.matched_transaction_ids.contains(id)
                    })
            });
            if let Some(flow) = linked_flows.next() {
                if linked_flows.next().is_some() || flow.amount != o.amount {
                    return Err("ambiguous_obligation_match".into());
                }
                continue;
            }
            if let Some((existing, _, ids)) = economic.get(&o.economic_obligation_id) {
                if *existing != n
                    || (!ids.is_empty()
                        && !o.matched_transaction_ids.is_empty()
                        && !o.matched_transaction_ids.iter().any(|id| ids.contains(id)))
                {
                    return Err("ambiguous_obligation_match".into());
                }
                continue;
            }
            if let Some((old, category, _)) = reserves.get(&o.economic_obligation_id) {
                if *old != n || category != &o.category_id {
                    return Err("ambiguous_obligation_match".into());
                }
            } else {
                reserves.insert(
                    o.economic_obligation_id.clone(),
                    (n, o.category_id.clone(), o.id.clone()),
                );
            }
        }
        if let Some(facts) = &input.facts {
            for schedule in &facts.schedules {
                if schedule
                    .account_id
                    .as_deref()
                    .is_some_and(|id| id != f.account_id)
                {
                    continue;
                }
                let Some(due) = &schedule.due_date else {
                    return Err("schedule_horizon_unavailable".into());
                };
                if !obligation_due(due, end)? {
                    continue;
                }
                if schedule.certainty != ScheduleAmountCertainty::Exact {
                    return Err("schedule_amount_uncertain".into());
                }
                let Some(amount) = &schedule.amount else {
                    return Err("schedule_amount_unknown".into());
                };
                if amount.currency() != c {
                    return Err("currency_mismatch".into());
                }
                if !amount.is_negative() {
                    continue;
                }
                if !f.obligations.iter().any(|o| {
                    o.id == schedule.id
                        || o.economic_obligation_id == format!("schedule:{}:{}", schedule.id, due)
                }) {
                    return Err("schedule_obligation_unaccounted".into());
                }
            }
        }
        // Existing card reserves and scheduled autopay share one economic identity.
        if let Some(facts) = &input.facts {
            for card in &facts.accounts {
                if let Some(credit) = &card.credit {
                    if credit.payment_account_id == f.account_id {
                        known(&credit.evidence, now, input.max_budget_snapshot_age_minutes)?;
                        let n = units(&credit.reserved_cash, c, true)?;
                        if economic.contains_key(&credit.economic_obligation_id) {
                            continue;
                        }
                        match reserves.get(&credit.economic_obligation_id) {
                            Some((old, cat, _))
                                if *old != n
                                    || cat.as_deref() != Some(&credit.payment_category_id) =>
                            {
                                return Err("ambiguous_card_payment_reserve".into())
                            }
                            Some(_) => {}
                            None => {
                                reserves.insert(
                                    credit.economic_obligation_id.clone(),
                                    (
                                        n,
                                        Some(credit.payment_category_id.clone()),
                                        card.account_id.clone(),
                                    ),
                                );
                            }
                        }
                    }
                }
            }
        }
        for b in &input.claim_set.bundles {
            if !active(b, now)? {
                continue;
            }
            for e in &b.effects {
                if e.resource_id != f.account_id || e.kind == ClaimEffectKind::Category {
                    continue;
                }
                let n = units(&e.amount, c, true)?;
                let matching_flow = f.unsettled_flows.iter().find(|flow| {
                    flow.economic_obligation_id == e.economic_obligation_id
                        || e.matched_transaction_ids.iter().any(|id| {
                            id == &flow.id
                                || flow.imported_id.as_ref() == Some(id)
                                || flow.matched_transaction_ids.contains(id)
                        })
                });
                if let Some(flow) = matching_flow {
                    if flow.amount != e.amount {
                        return Err("claim_flow_amount_mismatch".into());
                    }
                }
                if e.kind == ClaimEffectKind::DestinationHold {
                    let already_held = matching_flow.is_some_and(|flow| {
                        flow.direction == FlowDirection::Inflow && flow.included_in_balance
                    });
                    if e.included_in_balance && !already_held {
                        a.adjusted = sub(a.adjusted, n)?;
                        deduct(&mut a, n, "unsettled_destination_hold", &b.id, true)?;
                    }
                    continue;
                }
                if e.included_in_balance
                    || economic.contains_key(&e.economic_obligation_id)
                    || matching_flow.is_some_and(|flow| flow.direction == FlowDirection::Outflow)
                {
                    continue;
                }
                match reserves.get(&e.economic_obligation_id) {
                    Some((old, cat, _)) if *old != n || cat != &e.category_id => {
                        return Err("ambiguous_claim_match".into())
                    }
                    Some(_) => {}
                    None => {
                        reserves.insert(
                            e.economic_obligation_id.clone(),
                            (n, e.category_id.clone(), b.id.clone()),
                        );
                    }
                }
            }
        }
        for (_, (n, cat, id)) in reserves {
            let covered = if let Some(cat) = cat {
                let category = current_category(categories, &cat, input)
                    .ok_or("unknown_obligation_category")?;
                known(
                    &category.evidence,
                    now,
                    input.max_budget_snapshot_age_minutes,
                )?;
                let available = units(&category.availability, c, false)?.max(0);
                let used = funded_used
                    .entry(category.cash_bucket_id.clone())
                    .or_default();
                let covered = n.min(sub(available, *used)?.max(0));
                *used = add(*used, covered)?;
                covered
            } else {
                0
            };
            deduct(&mut a, covered, "funded_category_obligation", &id, false)?;
            deduct(
                &mut a,
                sub(n, covered)?,
                "unbacked_obligation_reserve",
                &id,
                true,
            )?;
        }
        if f.kind == LiquidityAccountKind::Credit {
            let credit = f.credit.as_ref().ok_or("credit_payment_unknown")?;
            known(&credit.evidence, now, input.max_budget_snapshot_age_minutes)?;
            let mut auth = units(&credit.authorization_available, c, true)?;
            if !credit.pending_included_in_authorization {
                for flow in &f.unsettled_flows {
                    if flow.direction == FlowDirection::Outflow {
                        auth = sub(auth, units(&flow.amount, c, true)?)?;
                    }
                }
            }
            a.authorization = Some(auth);
            a.head = auth;
            a.backing = 0;
        }
        a.known = true;
        refresh(&mut a)
    })();
    if let Err(reason) = result {
        a.known = false;
        a.output.reasons.push(reason);
    } else if a.known {
        *funded_totals = funded_used;
    }
    a
}

#[derive(Clone)]
struct Edge {
    to: usize,
    rev: usize,
    capacity: i64,
    cost: i64,
    original: i64,
}
fn connect(g: &mut [Vec<Edge>], from: usize, to: usize, capacity: i64, cost: i64) -> usize {
    let pos = g[from].len();
    let rev = g[to].len();
    g[from].push(Edge {
        to,
        rev,
        capacity,
        cost,
        original: capacity,
    });
    g[to].push(Edge {
        to: from,
        rev: pos,
        capacity: 0,
        cost: -cost,
        original: 0,
    });
    pos
}
// Successive shortest augmenting paths with residual reverse edges. Negative costs
// reward retained prior amounts; Bellman-Ford avoids fragile greedy edge locking.
fn flow(g: &mut [Vec<Edge>], source: usize, sink: usize, target: i64) -> Checked<i64> {
    let mut total = 0;
    while total < target {
        let mut distance = vec![i64::MAX; g.len()];
        let mut previous = vec![None; g.len()];
        distance[source] = 0;
        for _ in 1..g.len() {
            let mut changed = false;
            for u in 0..g.len() {
                if distance[u] == i64::MAX {
                    continue;
                }
                for (i, e) in g[u].iter().enumerate() {
                    if e.capacity > 0 {
                        let d = add(distance[u], e.cost)?;
                        if d < distance[e.to] {
                            distance[e.to] = d;
                            previous[e.to] = Some((u, i));
                            changed = true;
                        }
                    }
                }
            }
            if !changed {
                break;
            }
        }
        if previous[sink].is_none() {
            break;
        }
        let mut n = sub(target, total)?;
        let mut at = sink;
        let mut hops = 0;
        while at != source {
            let (u, i) = previous[at].ok_or("allocation_path_invalid")?;
            n = n.min(g[u][i].capacity);
            at = u;
            hops += 1;
            if hops > g.len() {
                return Err("allocation_cycle".into());
            }
        }
        at = sink;
        while at != source {
            let (u, i) = previous[at].ok_or("allocation_path_invalid")?;
            let rev = g[u][i].rev;
            g[u][i].capacity = sub(g[u][i].capacity, n)?;
            g[at][rev].capacity = add(g[at][rev].capacity, n)?;
            at = u;
        }
        total = add(total, n)?;
    }
    Ok(total)
}
fn allocation(
    input: &LiquidityInput,
    accounts: &BTreeMap<String, Cash>,
    categories: &BTreeMap<String, CategoryLiquidityFact>,
    demands: &BTreeMap<String, i64>,
    prior: Option<&BackingAllocation>,
) -> Checked<BackingAllocation> {
    let mut result = identity(input);
    let aa: Vec<_> = accounts.values().collect();
    let cc: Vec<_> = categories.values().collect();
    let sink = 1 + aa.len() + cc.len();
    let mut graph = vec![vec![]; sink + 1];
    let mut target = 0;
    let trusted = prior.filter(|p| {
        p.version == "1"
            && p.snapshot_id == input.snapshot_id
            && p.content_hash == input.content_hash
            && p.policy_version == input.liquidity_policy.version
            && p.policy_hash == input.liquidity_policy.policy_hash
            && p.claim_set_revision == input.claim_set.revision
    });
    let mut retained = BTreeMap::<(&str, &str), i64>::new();
    if let Some(p) = trusted {
        for line in &p.lines {
            if let (Some(a), Some(c)) = (
                accounts.get(&line.account_id),
                categories.get(&line.cash_bucket_id),
            ) {
                if line.category_id == c.category_id
                    && edge(a, c)
                    && line.amount.currency() == c.availability.currency()
                    && !line.amount.is_negative()
                {
                    let key = (line.account_id.as_str(), line.cash_bucket_id.as_str());
                    retained
                        .entry(key)
                        .and_modify(|amount| *amount = 0)
                        .or_insert_with(|| line.amount.minor_units());
                }
            }
        }
    }
    for (i, a) in aa.iter().enumerate() {
        connect(
            &mut graph,
            0,
            1 + i,
            a.output
                .backing_capacity
                .as_ref()
                .map_or(0, |m| m.minor_units())
                .max(0),
            0,
        );
    }
    let mut lines = vec![];
    for (j, c) in cc.iter().enumerate() {
        let demand = demands.get(&c.cash_bucket_id).copied().unwrap_or(0).max(0);
        target = add(target, demand)?;
        connect(&mut graph, 1 + aa.len() + j, sink, demand, 0);
        for (i, a) in aa.iter().enumerate() {
            if edge(a, c) {
                let keep = retained
                    .get(&(a.fact.account_id.as_str(), c.cash_bucket_id.as_str()))
                    .copied()
                    .unwrap_or(0)
                    .min(demand);
                if keep > 0 {
                    let pos = connect(&mut graph, 1 + i, 1 + aa.len() + j, keep, -1);
                    lines.push((i, j, pos));
                }
                let pos = connect(&mut graph, 1 + i, 1 + aa.len() + j, demand, 0);
                lines.push((i, j, pos));
            }
        }
    }
    let actual = flow(&mut graph, 0, sink, target)?;
    result.feasible = actual == target;
    if !result.feasible {
        result.reasons.push(
            if accounts
                .values()
                .any(|a| eligible(&a.policy, &a.fact) && !a.known)
            {
                "incomplete_backing_evidence"
            } else {
                "insufficient_cash_backing"
            }
            .into(),
        );
        return Ok(result);
    }
    let mut totals = BTreeMap::<(usize, usize), i64>::new();
    for (i, j, pos) in lines {
        let e = &graph[1 + i][pos];
        let n = sub(e.original, e.capacity)?;
        let old = totals.entry((i, j)).or_default();
        *old = add(*old, n)?;
    }
    for ((i, j), n) in totals {
        if n > 0 {
            result.lines.push(BackingLine {
                account_id: aa[i].fact.account_id.clone(),
                category_id: cc[j].category_id.clone(),
                cash_bucket_id: cc[j].cash_bucket_id.clone(),
                amount: m(n, cc[j].availability.currency()),
            });
        }
    }
    Ok(result)
}

include!("liquidity_routes.rs");
include!("liquidity_scenarios.rs");
include!("liquidity_settlement.rs");
