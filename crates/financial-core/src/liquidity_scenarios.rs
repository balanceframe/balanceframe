// Joint hypothetical effects share the private engine namespace.
fn expiry(
    input: &LiquidityInput,
    accounts: &BTreeMap<String, Cash>,
    categories: &BTreeMap<String, CategoryLiquidityFact>,
    now: DateTime<FixedOffset>,
) -> Checked<String> {
    let mut until = instant(&input.valid_until)?.min(instant(&input.liquidity_policy.expires_at)?);
    let mut observe = |e: &FactEvidence| -> Checked<()> {
        if known(e, now, input.max_budget_snapshot_age_minutes).is_ok() {
            until = until.min(evidence_expiry(e, input.max_budget_snapshot_age_minutes)?);
        }
        Ok(())
    };
    for a in accounts.values().filter(|a| eligible(&a.policy, &a.fact)) {
        for e in [
            &a.fact.balance_evidence,
            &a.fact.freshness_evidence,
            &a.fact.activity_evidence,
            &a.fact.schedule_evidence,
            &a.fact.currency_evidence,
            &a.fact.kind_evidence,
            &a.fact.holds_evidence,
            &a.fact.ownership_evidence,
        ] {
            observe(e)?;
        }
        if let Some(c) = &a.fact.credit {
            observe(&c.evidence)?;
        }
    }
    for c in categories.values() {
        observe(&c.evidence)?;
    }
    for route in &input.liquidity_policy.transfer_routes {
        if timing_evidence(route, now, input.max_budget_snapshot_age_minutes).is_ok() {
            until = until.min(evidence_expiry(
                &route.evidence,
                input.max_budget_snapshot_age_minutes,
            )?);
        }
    }
    for bundle in &input.claim_set.bundles {
        if active(bundle, now)? {
            let at = instant(&bundle.expires_at)?;
            if at > now {
                until = until.min(at);
            }
        }
    }
    if until <= now {
        return Err("evaluation_expired".into());
    }
    Ok(stamp(until))
}
fn rank(status: PaymentLiquidityStatus) -> u8 {
    match status {
        PaymentLiquidityStatus::Ready => 0,
        PaymentLiquidityStatus::UseOtherAccount => 1,
        PaymentLiquidityStatus::TransferRequired => 2,
        PaymentLiquidityStatus::TransferTooLate => 3,
        PaymentLiquidityStatus::NotLiquid => 4,
        PaymentLiquidityStatus::InsufficientData => 5,
    }
}
fn budget_rank(status: BudgetFundingStatus) -> u8 {
    match status {
        BudgetFundingStatus::Funded => 0,
        BudgetFundingStatus::Unfunded => 1,
        BudgetFundingStatus::InsufficientData => 2,
    }
}
struct TransferPrefix {
    legs: Vec<TransferLeg>,
    unresolved: bool,
}

fn checked_evaluate(input: &LiquidityInput) -> Checked<AccountAwareSpendabilityResult> {
    let now = instant(&input.evaluated_at)?;
    let start = instant(&input.horizon.starts_at)?;
    let end = instant(&input.horizon.ends_at)?;
    if start > now || now >= end {
        return Err("invalid_horizon".into());
    }
    if input.snapshot_id.is_empty()
        || input.content_hash.is_empty()
        || input.liquidity_policy.version.is_empty()
        || input.liquidity_policy.policy_hash.is_empty()
        || input.claim_set.revision.is_empty()
    {
        return Err("missing_input_identity".into());
    }
    let facts = input.facts.as_ref().ok_or("liquidity_unavailable")?;
    if facts.version != "1" || facts.ledger_content_hash.is_empty() {
        return Err("unsupported_liquidity_facts".into());
    }
    chrono::NaiveDate::parse_from_str(&format!("{}-01", facts.as_of_month), "%Y-%m-%d")
        .map_err(|_| "invalid_as_of_month")?;
    unique(facts.accounts.iter().map(|a| a.account_id.as_str()))?;
    unique(facts.categories.iter().map(|a| a.cash_bucket_id.as_str()))?;
    unique(
        input
            .liquidity_policy
            .accounts
            .iter()
            .map(|a| a.account_id.as_str()),
    )?;
    unique(
        input
            .liquidity_policy
            .transfer_routes
            .iter()
            .map(|a| a.id.as_str()),
    )?;
    unique(input.claim_set.bundles.iter().map(|a| a.id.as_str()))?;
    let mut periods = BTreeSet::new();
    for category in &facts.categories {
        if category.category_id.trim().is_empty()
            || !periods.insert((&category.category_id, &category.as_of_month))
        {
            return Err("duplicate_or_empty_identity".into());
        }
    }
    let categories: BTreeMap<_, _> = facts
        .categories
        .iter()
        .map(|c| (c.cash_bucket_id.clone(), c.clone()))
        .collect();
    let mut accounts = BTreeMap::new();
    let mut funded_totals = BTreeMap::new();
    let mut ordered_accounts: Vec<_> = facts.accounts.iter().collect();
    ordered_accounts.sort_by(|a, b| a.account_id.cmp(&b.account_id));
    for f in ordered_accounts {
        if let Some(p) = input
            .liquidity_policy
            .accounts
            .iter()
            .find(|p| p.account_id == f.account_id)
        {
            accounts.insert(
                f.account_id.clone(),
                prepare_account(f, p, input, &categories, now, &mut funded_totals),
            );
        } else {
            let p = AccountLiquidityPolicy {
                account_id: f.account_id.clone(),
                role: AccountRole::Excluded,
                protected_buffer: Money::zero(&f.currency),
                payment_eligible: false,
                source_eligible: false,
                backing_eligible: false,
                eligible_category_ids: vec![],
                restricted_cash_bucket_ids: vec![],
                automation_allowed: false,
                resource_scope: String::new(),
            };
            accounts.insert(
                f.account_id.clone(),
                prepare_account(f, &p, input, &categories, now, &mut funded_totals),
            );
        }
    }
    let expires = expiry(input, &accounts, &categories, now)?;
    let mut demands = BTreeMap::new();
    let mut available = BTreeMap::new();
    let mut category_outputs = BTreeMap::new();
    let mut category_unknown = false;
    for c in categories.values() {
        let mut reasons = vec![];
        let valid = (|| -> Checked<i64> {
            known(&c.evidence, now, input.max_budget_snapshot_age_minutes)?;
            let n = units(&c.availability, c.availability.currency(), false)?;
            if c.period_kind == CategoryPeriodKind::Current && c.as_of_month != facts.as_of_month {
                return Err("category_period_mismatch".into());
            }
            if c.period_kind == CategoryPeriodKind::Future && c.as_of_month <= facts.as_of_month {
                return Err("category_period_mismatch".into());
            }
            // Transfer/income rows are not a second disjoint cash envelope. Positive balances
            // require an explicit normalized cash bucket rather than silently dropping demand.
            if matches!(
                c.kind,
                LiquidityCategoryKind::Income | LiquidityCategoryKind::Transfer
            ) && n != 0
            {
                return Err("unsupported_special_category_balance".into());
            }
            Ok(n)
        })();
        let remaining = match valid {
            Ok(n) => {
                demands.insert(c.cash_bucket_id.clone(), n.max(0));
                available.insert(c.cash_bucket_id.clone(), n);
                Some(c.availability.clone())
            }
            Err(reason) => {
                reasons.push(reason);
                category_unknown = true;
                None
            }
        };
        category_outputs.insert(
            c.cash_bucket_id.clone(),
            CategoryCapacity {
                category_id: c.category_id.clone(),
                cash_bucket_id: c.cash_bucket_id.clone(),
                authoritative_availability: c.availability.clone(),
                remaining_availability: remaining,
                reasons,
            },
        );
    }
    let mut claim_effects = BTreeMap::<(String, String), i64>::new();
    for b in &input.claim_set.bundles {
        if !active(b, now)? {
            continue;
        }
        let mut bundle_effects = BTreeSet::new();
        for e in &b.effects {
            if e.economic_obligation_id.is_empty()
                || e.resource_id.is_empty()
                || !bundle_effects.insert((
                    format!("{:?}", e.kind),
                    e.resource_id.clone(),
                    e.economic_obligation_id.clone(),
                ))
            {
                return Err("ambiguous_claim_effect".into());
            }
            if e.kind != ClaimEffectKind::Category || e.included_in_balance {
                continue;
            }
            let c = current_category(&categories, &e.resource_id, input)
                .ok_or("claim_category_missing")?;
            let n = units(&e.amount, c.availability.currency(), true)?;
            let key = (c.cash_bucket_id.clone(), e.economic_obligation_id.clone());
            if let Some(old) = claim_effects.insert(key, n) {
                if old != n {
                    return Err("ambiguous_claim_match".into());
                }
                continue;
            }
            if let Some(value) = available.get_mut(&c.cash_bucket_id) {
                *value = sub(*value, n)?;
            }
        }
    }
    let accounts_before: Vec<_> = accounts.values().map(|a| a.output.clone()).collect();
    let mut before = allocation(
        input,
        &accounts,
        &categories,
        &demands,
        input.prior_allocation.as_ref(),
    )?;
    if category_unknown {
        before.feasible = false;
        before.lines.clear();
        before.reasons.push("incomplete_category_evidence".into());
    }
    if !input.source_coverage_complete {
        before.feasible = false;
        before.lines.clear();
        before.reasons.push("incomplete_source_coverage".into());
    }
    let mut result = unavailable(input, "liquidity_unavailable");
    result.reasons.clear();
    result.expires_at = expires.clone();
    result.accounts_before = accounts_before;
    result.backing_before = before.clone();
    result.budget_funding_status = if category_unknown {
        BudgetFundingStatus::InsufficientData
    } else {
        BudgetFundingStatus::Funded
    };
    result.payment_liquidity_status = if before.feasible {
        PaymentLiquidityStatus::Ready
    } else if category_unknown
        || accounts
            .values()
            .any(|a| eligible(&a.policy, &a.fact) && !a.known)
    {
        PaymentLiquidityStatus::InsufficientData
    } else {
        PaymentLiquidityStatus::NotLiquid
    };
    if accounts.values().any(|a| {
        a.known
            && (a.fact.balance_evidence.source == FactSource::UserAttested
                || a.fact.freshness_evidence.source == FactSource::UserAttested)
    }) {
        result
            .assumptions
            .push("explicit_user_attestation_not_bank_sync".into());
    }
    result
        .assumptions
        .push("explicit_ledger_observation_age_policy_applied".into());
    let mut prior = before.clone();
    match &input.scenario {
        LiquidityScenario::None => {}
        LiquidityScenario::Reallocation { moves } => {
            unique(moves.iter().map(|x| x.id.as_str()))?;
            let mut ordered: Vec<_> = moves.iter().collect();
            ordered.sort_by(|a, b| a.id.cmp(&b.id));
            for movement in ordered {
                let source = current_category(&categories, &movement.source_category_id, input)
                    .ok_or("reallocation_category_missing")?;
                let destination =
                    current_category(&categories, &movement.destination_category_id, input)
                        .ok_or("reallocation_category_missing")?;
                let n = units(&movement.amount, source.availability.currency(), true)?;
                if n == 0 || source.category_id == destination.category_id {
                    return Err("invalid_reallocation".into());
                }
                units(&movement.amount, destination.availability.currency(), true)?;
                if source.kind != LiquidityCategoryKind::Ordinary
                    || destination.kind != LiquidityCategoryKind::Ordinary
                    || source.period_kind != CategoryPeriodKind::Current
                    || destination.period_kind != CategoryPeriodKind::Current
                {
                    return Err("reallocation_category_ineligible".into());
                }
                let amount = available
                    .get_mut(&source.cash_bucket_id)
                    .ok_or("incomplete_category_evidence")?;
                *amount = sub(*amount, n)?;
                if *amount < 0 {
                    result.budget_funding_status = BudgetFundingStatus::Unfunded;
                }
                let amount = available
                    .get_mut(&destination.cash_bucket_id)
                    .ok_or("incomplete_category_evidence")?;
                *amount = add(*amount, n)?;
                let amount = demands
                    .get_mut(&source.cash_bucket_id)
                    .ok_or("incomplete_category_evidence")?;
                *amount = sub(*amount, n)?;
                let amount = demands
                    .get_mut(&destination.cash_bucket_id)
                    .ok_or("incomplete_category_evidence")?;
                *amount = add(*amount, n)?;
            }
        }
        LiquidityScenario::Purchases { items } => {
            unique(items.iter().map(|x| x.id.as_str()))?;
            if items.is_empty() {
                return Err("empty_purchase_scenario".into());
            }
            let mut ordered: Vec<_> = items.iter().collect();
            ordered.sort_by(|a, b| a.id.cmp(&b.id));
            result.payment_liquidity_status = PaymentLiquidityStatus::Ready;
            let mut transfer_prefixes = BTreeMap::<String, TransferPrefix>::new();
            for item in ordered {
                let n = units(&item.amount, item.amount.currency(), true)?;
                if n == 0 {
                    return Err("nonpositive_purchase".into());
                }
                let purchase_at = instant(&item.purchase_at)?;
                let required = instant(&item.required_by)?;
                if purchase_at < now
                    || purchase_at < start
                    || purchase_at >= end
                    || required < now
                    || required > purchase_at
                    || required >= end
                {
                    return Err("purchase_outside_horizon".into());
                }
                let (selected_id, selection_source) = selected(&item.route_selection);
                let funding = if let Some(c) =
                    month_category(&categories, &item.category_id, &item.purchase_at[..7])
                {
                    if units(&item.amount, c.availability.currency(), true).is_err() {
                        BudgetFundingStatus::InsufficientData
                    } else if let Some(amount) = available.get_mut(&c.cash_bucket_id) {
                        *amount = sub(*amount, n)?;
                        if *amount >= 0 {
                            BudgetFundingStatus::Funded
                        } else {
                            BudgetFundingStatus::Unfunded
                        }
                    } else {
                        BudgetFundingStatus::InsufficientData
                    }
                } else {
                    BudgetFundingStatus::InsufficientData
                };
                let mut item_result = PurchaseLiquidityResult {
                    item_id: item.id.clone(),
                    category_id: item.category_id.clone(),
                    budget_funding_status: funding,
                    payment_liquidity_status: PaymentLiquidityStatus::InsufficientData,
                    selected_account_id: selected_id.clone(),
                    selection_source,
                    selected_before: selected_id
                        .as_ref()
                        .and_then(|id| accounts.get(id).map(|a| a.output.clone())),
                    selected_after: None,
                    alternatives: vec![],
                    transfer_plan: None,
                    credit: None,
                    reasons: vec![],
                };
                let mut trials = BTreeMap::new();
                let mut unresolved = category_unknown
                    || before
                        .reasons
                        .iter()
                        .any(|reason| reason == "incomplete_backing_evidence");
                for (id, a) in &accounts {
                    if !eligible(&a.policy, &a.fact)
                        || !a.policy.payment_eligible
                        || a.policy.role == AccountRole::Restricted
                    {
                        continue;
                    }
                    if !a.known {
                        unresolved = true;
                        continue;
                    }
                    let mut trial = accounts.clone();
                    let mut trial_demands = demands.clone();
                    match spend(
                        &mut trial,
                        &categories,
                        &mut trial_demands,
                        item,
                        id,
                        input,
                        now,
                    ) {
                        Ok(credit) => {
                            let backing = allocation(
                                input,
                                &trial,
                                &categories,
                                &trial_demands,
                                Some(&prior),
                            )?;
                            let ready = before.feasible
                                && backing.feasible
                                && trial[id].head >= 0
                                && credit.as_ref().is_none_or(|c| c.payment_cash_ready);
                            if ready && selected_id.as_deref() != Some(id) {
                                item_result.alternatives.push(PaymentAlternative {
                                    account_id: id.clone(),
                                    status: PaymentLiquidityStatus::Ready,
                                    capacity: a
                                        .output
                                        .safe_spending_capacity
                                        .clone()
                                        .unwrap_or_else(|| m(0, &a.fact.currency)),
                                });
                            }
                            trials
                                .insert(id.clone(), (trial, trial_demands, credit, backing, ready));
                        }
                        Err(reason) => {
                            if selected_id.as_deref() == Some(id) {
                                item_result.reasons.push(reason);
                                unresolved = true;
                            }
                        }
                    }
                }
                if selected_id.is_none() {
                    item_result
                        .reasons
                        .push("no_payment_account_selected".into());
                } else if let Some((mut trial, trial_demands, credit, mut backing, ready)) =
                    selected_id.as_ref().and_then(|id| trials.remove(id))
                {
                    let id = selected_id.as_ref().ok_or("selected_account_missing")?;
                    item_result.credit = credit.clone();
                    let destination = credit
                        .as_ref()
                        .map_or(id.as_str(), |c| c.payment_account_id.as_str());
                    let due = credit
                        .as_ref()
                        .map(|c| instant(&c.due_at))
                        .transpose()?
                        .unwrap_or(required);
                    let prefix = transfer_prefixes.get(item.amount.currency());
                    let inherited = prefix.is_some_and(|prefix| !prefix.legs.is_empty());
                    unresolved |= prefix.is_some_and(|prefix| prefix.unresolved);
                    if inherited {
                        let reason = "cumulative_same_currency_transfer_prefix";
                        item_result.reasons.push(reason.into());
                        if !result
                            .assumptions
                            .iter()
                            .any(|assumption| assumption == reason)
                        {
                            result.assumptions.push(reason.into());
                        }
                    }
                    if ready {
                        if let Some(prefix) = prefix.filter(|prefix| !prefix.legs.is_empty()) {
                            let plan = transfer_plan(
                                input,
                                &expires,
                                item.amount.currency(),
                                due,
                                prefix.legs.clone(),
                                backing.clone(),
                            )?;
                            let on_time = plan.legs.iter().all(|leg| {
                                instant(&leg.estimated_arrival).is_ok_and(|at| {
                                    instant(&leg.required_by).is_ok_and(|due| at <= due)
                                })
                            });
                            item_result.payment_liquidity_status = if on_time {
                                PaymentLiquidityStatus::TransferRequired
                            } else if unresolved {
                                PaymentLiquidityStatus::InsufficientData
                            } else {
                                PaymentLiquidityStatus::TransferTooLate
                            };
                            if on_time {
                                transfer_prefixes.insert(
                                    item.amount.currency().into(),
                                    TransferPrefix {
                                        legs: plan.legs.clone(),
                                        unresolved,
                                    },
                                );
                            }
                            item_result.transfer_plan = Some(plan);
                        } else {
                            item_result.payment_liquidity_status = PaymentLiquidityStatus::Ready;
                        }
                    } else if !item_result.alternatives.is_empty() {
                        item_result.payment_liquidity_status =
                            PaymentLiquidityStatus::UseOtherAccount;
                    } else {
                        let head = trial
                            .get(destination)
                            .ok_or("payment_account_missing")?
                            .head;
                        let authorization_ok = credit
                            .as_ref()
                            .is_none_or(|c| !c.authorization_after.is_negative());
                        if (head < 0 || !backing.feasible)
                            && authorization_ok
                            && before.feasible
                            && !category_unknown
                        {
                            let needed = sub(0, head)?.max(0);
                            let (solution, unknown) = transfer(
                                input,
                                &trial,
                                &categories,
                                &trial_demands,
                                TransferNeed {
                                    destination,
                                    shortfall: needed,
                                    required_by: due,
                                },
                                now,
                                &prior,
                            )?;
                            unresolved |= unknown;
                            if let Some(solution) = solution {
                                let inherited_count = prefix.map_or(0, |prefix| prefix.legs.len());
                                let mut legs =
                                    prefix.map(|prefix| prefix.legs.clone()).unwrap_or_default();
                                legs.extend(solution.legs);
                                let plan = transfer_plan(
                                    input,
                                    &expires,
                                    item.amount.currency(),
                                    due,
                                    legs,
                                    solution.backing_after,
                                )?;
                                if plan.legs.iter().any(|leg| {
                                    input.liquidity_policy.transfer_routes.iter().any(|route| {
                                        route.id == leg.timing_route_id
                                            && route.provider_arrival_at.is_none()
                                    })
                                }) {
                                    result
                                        .assumptions
                                        .push("explicit_transfer_calendar_policy".into());
                                }
                                let on_time = plan.legs.iter().all(|leg| {
                                    instant(&leg.estimated_arrival).is_ok_and(|at| {
                                        instant(&leg.required_by).is_ok_and(|due| at <= due)
                                    })
                                });
                                item_result.payment_liquidity_status = if on_time {
                                    PaymentLiquidityStatus::TransferRequired
                                } else if unresolved {
                                    PaymentLiquidityStatus::InsufficientData
                                } else {
                                    PaymentLiquidityStatus::TransferTooLate
                                };
                                if on_time {
                                    // Earlier bank steps are prerequisites, not new cash to apply a second time.
                                    for leg in &plan.legs[inherited_count..] {
                                        move_cash(
                                            &mut trial,
                                            &leg.source_account_id,
                                            &leg.destination_account_id,
                                            leg.amount.minor_units(),
                                        )?;
                                    }
                                    backing = plan.backing_after.clone();
                                    transfer_prefixes.insert(
                                        item.amount.currency().into(),
                                        TransferPrefix {
                                            legs: plan.legs.clone(),
                                            unresolved,
                                        },
                                    );
                                }
                                item_result.transfer_plan = Some(plan);
                            } else {
                                item_result.payment_liquidity_status = if unresolved {
                                    PaymentLiquidityStatus::InsufficientData
                                } else {
                                    PaymentLiquidityStatus::NotLiquid
                                };
                            }
                        } else {
                            item_result.payment_liquidity_status = if unresolved {
                                PaymentLiquidityStatus::InsufficientData
                            } else {
                                PaymentLiquidityStatus::NotLiquid
                            };
                        }
                    }
                    item_result.selected_after = trial.get(id).map(|a| a.output.clone());
                    // Joint scenario retains each explicit item's effects, including unsafe items;
                    // alternate recommendations do not silently select a different account.
                    accounts = trial;
                    demands = trial_demands;
                    prior = backing;
                } else {
                    item_result
                        .reasons
                        .push("selected_account_unavailable".into());
                    if !item_result.alternatives.is_empty() && selected_id.is_some() {
                        item_result.payment_liquidity_status =
                            PaymentLiquidityStatus::UseOtherAccount;
                    }
                }
                if rank(item_result.payment_liquidity_status)
                    > rank(result.payment_liquidity_status)
                {
                    result.payment_liquidity_status = item_result.payment_liquidity_status;
                }
                if budget_rank(funding) > budget_rank(result.budget_funding_status) {
                    result.budget_funding_status = funding;
                }
                result.purchases.push(item_result);
            }
        }
    }
    for (id, output) in &mut category_outputs {
        output.remaining_availability = available
            .get(id)
            .map(|n| m(*n, output.authoritative_availability.currency()));
    }
    result.categories = category_outputs.into_values().collect();
    result.accounts_after = accounts.values().map(|a| a.output.clone()).collect();
    result.backing_after = allocation(input, &accounts, &categories, &demands, Some(&prior))?;
    if category_unknown {
        result.backing_after.feasible = false;
        result.backing_after.lines.clear();
        result
            .backing_after
            .reasons
            .push("incomplete_category_evidence".into());
    }
    if !input.source_coverage_complete {
        result.backing_after.feasible = false;
        result.backing_after.lines.clear();
        result
            .backing_after
            .reasons
            .push("incomplete_source_coverage".into());
        result.payment_liquidity_status = PaymentLiquidityStatus::InsufficientData;
    }
    if !result.backing_after.feasible
        && matches!(
            input.scenario,
            LiquidityScenario::None | LiquidityScenario::Reallocation { .. }
        )
    {
        result.payment_liquidity_status = if !input.source_coverage_complete
            || category_unknown
            || accounts
                .values()
                .any(|a| eligible(&a.policy, &a.fact) && !a.known)
        {
            PaymentLiquidityStatus::InsufficientData
        } else {
            PaymentLiquidityStatus::NotLiquid
        };
    }
    Ok(result)
}
pub(super) fn evaluate(input: &LiquidityInput) -> AccountAwareSpendabilityResult {
    match checked_evaluate(input) {
        Ok(result) => result,
        Err(reason) => unavailable(input, &reason),
    }
}
