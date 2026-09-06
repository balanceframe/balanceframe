// Routing helpers share the private engine namespace.
fn timing_evidence(
    route: &TransferTimingRoute,
    now: DateTime<FixedOffset>,
    max_age_minutes: u64,
) -> Checked<()> {
    if route.provider_arrival_at.is_none()
        && route.calendar_mode.is_some()
        && route.evidence.source == FactSource::PolicyAssumption
    {
        if route.evidence.state != FactState::Known {
            return Err("unknown_transfer_policy".into());
        }
        observation_window(&route.evidence, now, max_age_minutes)
    } else {
        known(&route.evidence, now, max_age_minutes)
    }
}
fn arrival(
    route: &TransferTimingRoute,
    now: DateTime<FixedOffset>,
    max_age_minutes: u64,
) -> Checked<DateTime<FixedOffset>> {
    timing_evidence(route, now, max_age_minutes)?;
    if let Some(at) = &route.provider_arrival_at {
        let at = instant(at)?;
        if at < now {
            return Err("arrival_precedes_evaluation".into());
        }
        return Ok(at);
    }
    let mode = route.calendar_mode.ok_or("unknown_transfer_timing")?;
    let offset = route
        .utc_offset_minutes
        .ok_or("unknown_transfer_timezone")?;
    let seconds = offset.checked_mul(60).ok_or("invalid_transfer_timezone")?;
    let timezone = FixedOffset::east_opt(seconds).ok_or("invalid_transfer_timezone")?;
    let cutoff = route.cutoff_minute.ok_or("unknown_transfer_cutoff")?;
    if cutoff >= 1440 {
        return Err("invalid_transfer_cutoff".into());
    }
    let weekends = route.weekends_available.ok_or("unknown_weekend_coverage")?;
    if mode == CalendarMode::BusinessDays && !route.holidays_complete {
        return Err("unknown_holiday_coverage".into());
    }
    for day in &route.holidays {
        chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").map_err(|_| "invalid_holiday_date")?;
    }
    let mut at = now.with_timezone(&timezone);
    if mode == CalendarMode::Instant {
        if route.delay_days != 0 {
            return Err("invalid_instant_route".into());
        }
        return Ok(at);
    }
    let after_cutoff = at.hour() * 60 + at.minute() >= cutoff;
    if after_cutoff {
        at = at
            .checked_add_signed(Duration::days(1))
            .ok_or("timestamp_overflow")?;
    }
    let mut remaining = route.delay_days;
    // Explicit policy calendar only; no host timezone, inferred holidays, or wall clock.
    let acceptable = |date: DateTime<FixedOffset>| {
        (weekends || date.weekday().number_from_monday() <= 5)
            && (mode != CalendarMode::BusinessDays
                || !route
                    .holidays
                    .contains(&date.format("%Y-%m-%d").to_string()))
    };
    if remaining > 3660 {
        return Err("transfer_horizon_exceeded".into());
    }
    // Cutoff rollover chooses the next processing day before counting transit days.
    let mut processing_days = 0;
    while !acceptable(at) {
        at = at
            .checked_add_signed(Duration::days(1))
            .ok_or("timestamp_overflow")?;
        processing_days += 1;
        if processing_days > 3660 {
            return Err("transfer_calendar_unavailable".into());
        }
    }
    while remaining > 0 {
        at = at
            .checked_add_signed(Duration::days(1))
            .ok_or("timestamp_overflow")?;
        if mode == CalendarMode::CalendarDays || acceptable(at) {
            remaining -= 1;
        }
    }
    let mut days = 0;
    while !acceptable(at) {
        at = at
            .checked_add_signed(Duration::days(1))
            .ok_or("timestamp_overflow")?;
        days += 1;
        if days > 3660 {
            return Err("transfer_calendar_unavailable".into());
        }
    }
    Ok(at)
}
fn precondition(a: &Cash) -> AccountPlanPrecondition {
    let mut ids: BTreeSet<String> = a.fact.baseline_transaction_ids.iter().cloned().collect();
    for flow in &a.fact.unsettled_flows {
        ids.insert(flow.id.clone());
        if let Some(imported) = &flow.imported_id {
            ids.insert(imported.clone());
        }
        ids.extend(flow.matched_transaction_ids.iter().cloned());
    }
    for obligation in &a.fact.obligations {
        ids.extend(obligation.matched_transaction_ids.iter().cloned());
    }
    AccountPlanPrecondition {
        account_id: a.fact.account_id.clone(),
        recorded_balance: a.fact.recorded_balance.clone(),
        signed_headroom: m(a.head, &a.fact.currency),
        backing_capacity: m(a.backing.max(0), &a.fact.currency),
        baseline_transaction_ids: ids.into_iter().collect(),
    }
}
fn move_cash(
    accounts: &mut BTreeMap<String, Cash>,
    source: &str,
    destination: &str,
    n: i64,
) -> Checked<()> {
    let a = accounts.get_mut(source).ok_or("source_not_found")?;
    a.head = sub(a.head, n)?;
    a.adjusted = sub(a.adjusted, n)?;
    a.backing = sub(a.backing, n)?;
    refresh(a)?;
    let a = accounts
        .get_mut(destination)
        .ok_or("destination_not_found")?;
    a.head = add(a.head, n)?;
    a.adjusted = add(a.adjusted, n)?;
    a.backing = add(a.backing, n)?;
    refresh(a)?;
    Ok(())
}
/// Sorted-key canonical JSON and domain-separated SHA256, with only payloadHash excluded.
pub(super) fn canonical(plan: &TransferPlan) -> Checked<String> {
    let mut value = serde_json::to_value(plan).map_err(|_| "plan_serialization_error")?;
    value
        .as_object_mut()
        .ok_or("invalid_plan")?
        .remove("payloadHash");
    fn sorted(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(object) => {
                let ordered: BTreeMap<_, _> =
                    object.into_iter().map(|(k, v)| (k, sorted(v))).collect();
                serde_json::Value::Object(ordered.into_iter().collect())
            }
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(sorted).collect())
            }
            v => v,
        }
    }
    serde_json::to_string(&sorted(value)).map_err(|_| "plan_serialization_error".into())
}
fn plan_hash(plan: &TransferPlan) -> Checked<String> {
    let mut hash = Sha256::new();
    hash.update(b"balanceframe.transfer-plan.v1\n");
    hash.update(canonical(plan)?.as_bytes());
    Ok(format!("{:x}", hash.finalize()))
}
/// Minimum-cost bounded circulation: exact bucket demands, source headroom caps,
/// destination backing debt, and a lower bound on total destination replenishment.
/// Transfer edges cost one; augmentations move whole residual bottlenecks, never cents.
fn minimum_transfers(
    accounts: &BTreeMap<String, Cash>,
    categories: &BTreeMap<String, CategoryLiquidityFact>,
    demands: &BTreeMap<String, i64>,
    routes: &[(DateTime<FixedOffset>, &TransferTimingRoute)],
    destination: &str,
    needed: i64,
) -> Checked<Option<Vec<i64>>> {
    let aa: Vec<_> = accounts.values().collect();
    let cc: Vec<_> = categories.values().collect();
    let account_nodes: BTreeMap<_, _> = aa
        .iter()
        .enumerate()
        .map(|(i, a)| (a.fact.account_id.as_str(), 1 + i))
        .collect();
    let gate = 1 + aa.len();
    let sink = gate + 1 + cc.len();
    let super_source = sink + 1;
    let super_sink = sink + 2;
    let mut graph = vec![vec![]; super_sink + 1];
    let mut balance = vec![0_i64; super_sink + 1];
    let mut capacity = 0;
    let mut maximum = 0;
    let mut transfer_edges = Vec::with_capacity(routes.len());
    for (i, account) in aa.iter().enumerate() {
        let cash = account
            .output
            .backing_capacity
            .as_ref()
            .map_or(0, |amount| amount.minor_units())
            .max(0);
        capacity = add(capacity, cash)?;
        connect(&mut graph, 0, 1 + i, cash, 0);
    }
    for (_, route) in routes {
        let node = account_nodes[route.source_account_id.as_str()];
        let limit = accounts[&route.source_account_id].head.max(0);
        maximum = add(maximum, limit)?;
        let position = connect(&mut graph, node, gate, limit, 1);
        transfer_edges.push((node, position));
    }
    if maximum < needed {
        return Ok(None);
    }
    let destination_node = account_nodes[destination];
    // Lower-bound flow creates node imbalances; the residual graph must discharge all.
    connect(&mut graph, gate, destination_node, sub(maximum, needed)?, 0);
    balance[gate] = sub(balance[gate], needed)?;
    balance[destination_node] = add(balance[destination_node], needed)?;
    let debt = if accounts[destination].backing < 0 {
        sub(0, accounts[destination].backing)?
    } else {
        0
    };
    balance[destination_node] = sub(balance[destination_node], debt)?;
    balance[sink] = add(balance[sink], debt)?;
    for (j, category) in cc.iter().enumerate() {
        let node = gate + 1 + j;
        let demand = demands
            .get(&category.cash_bucket_id)
            .copied()
            .unwrap_or(0)
            .max(0);
        balance[node] = sub(balance[node], demand)?;
        balance[sink] = add(balance[sink], demand)?;
        for (i, account) in aa.iter().enumerate() {
            if edge(account, category) {
                connect(&mut graph, 1 + i, node, demand, 0);
            }
        }
    }
    // Replenishment may exceed immediately allocated cash because funded obligations
    // also constrain signed headroom. Such cash remains at the destination, not spent.
    connect(&mut graph, destination_node, sink, capacity, 0);
    connect(&mut graph, sink, 0, capacity, 0);
    let mut target = 0;
    for (node, amount) in balance.into_iter().enumerate() {
        if amount > 0 {
            connect(&mut graph, super_source, node, amount, 0);
            target = add(target, amount)?;
        } else if amount < 0 {
            connect(&mut graph, node, super_sink, sub(0, amount)?, 0);
        }
    }
    if flow(&mut graph, super_source, super_sink, target)? != target {
        return Ok(None);
    }
    transfer_edges
        .into_iter()
        .map(|(node, position)| {
            let edge = &graph[node][position];
            sub(edge.original, edge.capacity)
        })
        .collect::<Checked<Vec<_>>>()
        .map(Some)
}

struct TransferSolution {
    legs: Vec<TransferLeg>,
    backing_after: BackingAllocation,
}

/// Payment requirement; preserving backing may require more than its cash shortfall.
struct TransferNeed<'a> {
    destination: &'a str,
    shortfall: i64,
    required_by: DateTime<FixedOffset>,
}

fn transfer_plan(
    input: &LiquidityInput,
    expires: &str,
    currency: &str,
    required: DateTime<FixedOffset>,
    mut legs: Vec<TransferLeg>,
    backing_after: BackingAllocation,
) -> Checked<TransferPlan> {
    use std::fmt::Write as _;
    let mut minimum = 0;
    for (index, leg) in legs.iter_mut().enumerate() {
        minimum = add(minimum, units(&leg.amount, currency, true)?)?;
        leg.id.clear();
        write!(&mut leg.id, "leg-{}", index + 1).map_err(|_| "plan_identity_formatting")?;
        if instant(&leg.required_by)? > required {
            leg.required_by = stamp(required);
        }
    }
    if minimum == 0 {
        return Err("empty_transfer_plan".into());
    }
    let mut plan = TransferPlan {
        version: "1".into(),
        snapshot_id: input.snapshot_id.clone(),
        content_hash: input.content_hash.clone(),
        policy_version: input.liquidity_policy.version.clone(),
        policy_hash: input.liquidity_policy.policy_hash.clone(),
        claim_set_revision: input.claim_set.revision.clone(),
        evaluated_at: input.evaluated_at.clone(),
        expires_at: expires.into(),
        minimum_amount: m(minimum, currency),
        legs,
        reservations: vec![],
        backing_after,
        scenario: input.scenario.clone(),
        preconditions_hash: input_preconditions_hash(input)?,
        payload_hash: String::new(),
    };
    let mut reservation_hash = Sha256::new();
    reservation_hash.update(b"balanceframe.transfer-reservation.v1\n");
    reservation_hash.update(canonical(&plan)?.as_bytes());
    let reservation_identity = format!("{:x}", reservation_hash.finalize());
    for leg in &plan.legs {
        plan.reservations.push(LiquidityClaimEffect {
            kind: ClaimEffectKind::AccountDebit,
            resource_id: leg.source_account_id.clone(),
            amount: leg.amount.clone(),
            economic_obligation_id: format!("transfer:{}:{}", reservation_identity, leg.id),
            category_id: None,
            included_in_balance: false,
            matched_transaction_ids: vec![],
        });
    }
    plan.payload_hash = plan_hash(&plan)?;
    Ok(plan)
}

fn transfer(
    input: &LiquidityInput,
    accounts: &BTreeMap<String, Cash>,
    categories: &BTreeMap<String, CategoryLiquidityFact>,
    demands: &BTreeMap<String, i64>,
    need: TransferNeed<'_>,
    now: DateTime<FixedOffset>,
    prior: &BackingAllocation,
) -> Checked<(Option<TransferSolution>, bool)> {
    let TransferNeed {
        destination,
        shortfall: needed,
        required_by: required,
    } = need;
    let dest = accounts.get(destination).ok_or("destination_not_found")?;
    if !dest.known || dest.fact.kind != LiquidityAccountKind::Cash || !payment(dest) {
        return Ok((None, true));
    }
    let currency = &dest.fact.currency;
    let mut routes = vec![];
    let mut unknown = false;
    for route in &input.liquidity_policy.transfer_routes {
        if route.destination_account_id != destination || route.source_account_id == destination {
            continue;
        }
        let Some(source) = accounts.get(&route.source_account_id) else {
            unknown = true;
            continue;
        };
        if !eligible(&source.policy, &source.fact)
            || !source.policy.source_eligible
            || source.policy.role == AccountRole::Restricted
            || source.fact.kind != LiquidityAccountKind::Cash
        {
            continue;
        }
        if !source.known {
            unknown = true;
            continue;
        }
        if source.fact.currency != *currency {
            continue;
        }
        if source.head <= 0 {
            continue;
        }
        match arrival(route, now, input.max_budget_snapshot_age_minutes) {
            Ok(at) if at < instant(&input.horizon.ends_at)? => routes.push((at, route)),
            Ok(_) => unknown = true,
            Err(_) => unknown = true,
        }
    }
    routes.sort_by(|(a, ra), (b, rb)| {
        a.cmp(b)
            .then(ra.source_account_id.cmp(&rb.source_account_id))
            .then(ra.id.cmp(&rb.id))
    });
    let mut seen = BTreeSet::new();
    routes.retain(|(_, route)| seen.insert(route.source_account_id.as_str()));
    let on_time: Vec<_> = routes
        .iter()
        .copied()
        .take_while(|(at, _)| *at <= required)
        .collect();
    let (routes, amounts) = if let Some(amounts) =
        minimum_transfers(accounts, categories, demands, &on_time, destination, needed)?
    {
        (on_time, amounts)
    } else if on_time.len() != routes.len() {
        if let Some(amounts) =
            minimum_transfers(accounts, categories, demands, &routes, destination, needed)?
        {
            (routes, amounts)
        } else {
            return Ok((None, unknown));
        }
    } else {
        return Ok((None, unknown));
    };
    let mut work = accounts.clone();
    let mut legs = vec![];
    for ((at, route), n) in routes.into_iter().zip(amounts) {
        if n == 0 {
            continue;
        }
        let source_before = precondition(
            work.get(&route.source_account_id)
                .ok_or("source_not_found")?,
        );
        let destination_before =
            precondition(work.get(destination).ok_or("destination_not_found")?);
        move_cash(&mut work, &route.source_account_id, destination, n)?;
        legs.push(TransferLeg {
            id: format!("leg-{}", legs.len() + 1),
            source_account_id: route.source_account_id.clone(),
            destination_account_id: destination.into(),
            amount: m(n, currency),
            required_by: stamp(required),
            estimated_arrival: stamp(at),
            timing_route_id: route.id.clone(),
            source_before,
            destination_before,
            source_after: m(work[&route.source_account_id].head, currency),
            destination_after: m(work[destination].head, currency),
        });
    }
    if legs.is_empty() {
        return Ok((None, unknown));
    }
    let backing_after = allocation(input, &work, categories, demands, Some(prior))?;
    if !backing_after.feasible {
        return Ok((None, unknown));
    }
    Ok((
        Some(TransferSolution {
            legs,
            backing_after,
        }),
        unknown,
    ))
}
fn selected(route: &RouteSelection) -> (Option<String>, String) {
    if let Some(id) = &route.explicit_account_id {
        return (Some(id.clone()), "explicit".into());
    }
    if let Some(id) = &route.session_account_id {
        return (Some(id.clone()), "session".into());
    }
    if let Some(route) = &route.approved_preference {
        if !route.reference_id.is_empty() {
            return (Some(route.account_id.clone()), "approved_preference".into());
        }
    }
    if let Some(route) = &route.historical_route {
        if !route.reference_id.is_empty() {
            return (Some(route.account_id.clone()), "historical_route".into());
        }
    }
    (None, "none".into())
}
fn spend(
    accounts: &mut BTreeMap<String, Cash>,
    categories: &BTreeMap<String, CategoryLiquidityFact>,
    demands: &mut BTreeMap<String, i64>,
    item: &LiquidityPurchaseItem,
    account_id: &str,
    input: &LiquidityInput,
    now: DateTime<FixedOffset>,
) -> Checked<Option<CreditPaymentResult>> {
    let a = accounts
        .get(account_id)
        .ok_or("selected_account_not_found")?;
    if !payment(a) {
        return Err("selected_account_unavailable".into());
    }
    let n = units(&item.amount, &a.fact.currency, true)?;
    let credit = a.fact.credit.clone();
    let category = month_category(categories, &item.category_id, &item.purchase_at[..7])
        .ok_or("category_not_found")?;
    units(&item.amount, category.availability.currency(), true)?;
    if category.kind != LiquidityCategoryKind::Ordinary {
        return Err("category_not_ordinary_spending".into());
    }
    if !a.policy.eligible_category_ids.is_empty()
        && !a.policy.eligible_category_ids.contains(&item.category_id)
    {
        return Err("payment_category_ineligible".into());
    }
    let demand = demands
        .get_mut(&category.cash_bucket_id)
        .ok_or("category_not_found")?;
    *demand = sub(*demand, n)?;
    if a.fact.kind == LiquidityAccountKind::Credit {
        let credit = credit.ok_or("credit_payment_unknown")?;
        known(&credit.evidence, now, input.max_budget_snapshot_age_minutes)?;
        let due = instant(&credit.due_at)?;
        if due < instant(&item.purchase_at)? || due >= instant(&input.horizon.ends_at)? {
            return Err("credit_due_outside_horizon".into());
        }
        let payment_category = month_category(
            categories,
            &credit.payment_category_id,
            &item.purchase_at[..7],
        )
        .ok_or("credit_payment_category_missing")?;
        if payment_category.kind != LiquidityCategoryKind::CreditPayment
            || payment_category.availability.currency() != item.amount.currency()
        {
            return Err("credit_payment_category_invalid".into());
        }
        let a = accounts
            .get_mut(account_id)
            .ok_or("selected_account_not_found")?;
        let auth = a.authorization.ok_or("credit_authorization_unknown")?;
        let after = sub(auth, n)?;
        a.authorization = Some(after);
        a.head = after;
        refresh(a)?;
        let payment_account = accounts
            .get_mut(&credit.payment_account_id)
            .ok_or("credit_payment_account_missing")?;
        if !payment(payment_account)
            || payment_account.fact.kind != LiquidityAccountKind::Cash
            || payment_account.fact.currency != item.amount.currency()
        {
            return Err("credit_payment_account_unavailable".into());
        }
        payment_account.head = sub(payment_account.head, n)?;
        refresh(payment_account)?;
        let reserve = demands
            .get_mut(&payment_category.cash_bucket_id)
            .ok_or("credit_payment_category_missing")?;
        *reserve = add(*reserve, n)?;
        Ok(Some(CreditPaymentResult {
            account_id: account_id.into(),
            authorization_available: m(auth, item.amount.currency()),
            authorization_after: m(after, item.amount.currency()),
            payment_account_id: credit.payment_account_id,
            payment_category_id: credit.payment_category_id,
            due_at: credit.due_at,
            additional_payment_cash: item.amount.clone(),
            payment_cash_ready: payment_account.head >= 0,
        }))
    } else {
        let a = accounts
            .get_mut(account_id)
            .ok_or("selected_account_not_found")?;
        a.head = sub(a.head, n)?;
        a.adjusted = sub(a.adjusted, n)?;
        a.backing = sub(a.backing, n)?;
        refresh(a)?;
        Ok(None)
    }
}
