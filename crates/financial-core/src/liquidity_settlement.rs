// Immutable-plan and independent-bank-evidence verification.
fn discard_ledger_capture_metadata(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(object) => {
            if object.get("source").and_then(serde_json::Value::as_str) == Some("actual_ledger")
                && object.contains_key("state")
            {
                object.remove("observedAt");
                object.remove("expiresAt");
            }
            for child in object.values_mut() {
                discard_ledger_capture_metadata(child);
            }
        }
        serde_json::Value::Array(array) => {
            for child in array {
                discard_ledger_capture_metadata(child);
            }
        }
        _ => {}
    }
}
fn input_preconditions_hash(input: &LiquidityInput) -> Checked<String> {
    let mut facts = serde_json::to_value(&input.facts).map_err(|_| "facts_serialization_error")?;
    if let Some(object) = facts.as_object_mut() {
        object.remove("ledgerContentHash");
    }
    discard_ledger_capture_metadata(&mut facts);
    let payload = serde_json::json!({"facts":facts,"sourceCoverageComplete":input.source_coverage_complete,"policy":input.liquidity_policy,"maxBudgetSnapshotAgeMinutes":input.max_budget_snapshot_age_minutes,"claims":input.claim_set.bundles,"scenario":input.scenario,"horizon":input.horizon});
    let bytes = serde_json::to_vec(&payload).map_err(|_| "preconditions_serialization_error")?;
    let mut hash = Sha256::new();
    hash.update(b"balanceframe.transfer-preconditions.v1\n");
    hash.update(bytes);
    Ok(format!("{:x}", hash.finalize()))
}
fn validate_plan(plan: &TransferPlan) -> Checked<()> {
    if plan.version != "1"
        || plan.payload_hash != plan_hash(plan)?
        || plan.legs.is_empty()
        || plan.snapshot_id.is_empty()
        || plan.content_hash.is_empty()
        || plan.policy_version.is_empty()
        || plan.policy_hash.is_empty()
        || plan.claim_set_revision.is_empty()
    {
        return Err("invalid_plan_hash_or_identity".into());
    }
    unique(plan.legs.iter().map(|l| l.id.as_str()))?;
    let currency = plan.minimum_amount.currency();
    let expected = units(&plan.minimum_amount, currency, true)?;
    if expected == 0 {
        return Err("nonpositive_transfer".into());
    }
    let mut sum = 0;
    let created = instant(&plan.evaluated_at)?;
    if instant(&plan.expires_at)? <= created {
        return Err("invalid_plan_expiry".into());
    }
    for leg in &plan.legs {
        let n = units(&leg.amount, currency, true)?;
        if n == 0
            || leg.source_account_id == leg.destination_account_id
            || leg.source_before.account_id != leg.source_account_id
            || leg.destination_before.account_id != leg.destination_account_id
        {
            return Err("invalid_transfer_leg".into());
        }
        sum = add(sum, n)?;
        if instant(&leg.required_by)? < created || instant(&leg.estimated_arrival)? < created {
            return Err("invalid_transfer_dates".into());
        }
    }
    if sum != expected {
        return Err("transfer_total_mismatch".into());
    }
    Ok(())
}
fn settlement_chronology(
    record: &TransferSettlementRecord,
    created: DateTime<FixedOffset>,
    now: DateTime<FixedOffset>,
) -> bool {
    let Ok(observed) = instant(&record.observed_at) else {
        return false;
    };
    if observed < created || observed > now {
        return false;
    }
    if record.occurred_at.len() == 10 && record.provenance == SettlementProvenance::ActualImport {
        let bytes = record.occurred_at.as_bytes();
        if bytes[4] != b'-'
            || bytes[7] != b'-'
            || !bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
        {
            return false;
        }
        let Ok(date) = chrono::NaiveDate::parse_from_str(&record.occurred_at, "%Y-%m-%d") else {
            return false;
        };
        // Date-only Actual imports establish no intraday timestamp. New independent IDs,
        // baseline exclusion and observation-after-intent are required by the caller.
        date >= created.date_naive() && date <= now.date_naive() && date <= observed.date_naive()
    } else {
        instant(&record.occurred_at)
            .is_ok_and(|occurred| occurred >= created && occurred <= observed)
    }
}
fn settlement_evidence_ids(record: &TransferSettlementRecord) -> Checked<Vec<String>> {
    let mut ids = vec![record.id.clone()];
    for (kind, value) in [
        ("import", record.imported_id.as_ref()),
        ("provider", record.provider_reference.as_ref()),
    ] {
        if let Some(value) = value {
            let identity = serde_json::to_string(&(&record.provenance, &record.account_id, value))
                .map_err(|_| "evidence_identity_serialization")?;
            ids.push(format!("liquidity.{kind}.v1:{identity}"));
        }
    }
    Ok(ids)
}

pub(super) fn settlement(request: &TransferSettlementRequest) -> TransferSettlementResult {
    let mut result = TransferSettlementResult {
        confirmed: false,
        source_observed: false,
        destination_observed: false,
        reconciled: false,
        evidence_ids: vec![],
        reasons: vec![],
        claim_effects: None,
    };
    let check = (|| -> Checked<()> {
        validate_plan(&request.plan)?;
        let now = instant(&request.evaluated_at)?;
        let created = instant(&request.plan.evaluated_at)?;
        if now < created {
            return Err("settlement_precedes_plan".into());
        }
        unique(request.records.iter().map(|r| r.id.as_str()))?;
        let identities: BTreeMap<_, _> = request
            .records
            .iter()
            .map(|record| Ok((record.id.as_str(), settlement_evidence_ids(record)?)))
            .collect::<Checked<_>>()?;
        let mut imported = BTreeSet::new();
        for record in &request.records {
            if let Some(id) = &record.imported_id {
                if id.is_empty() || !imported.insert(&identities[record.id.as_str()][1]) {
                    return Err("duplicate_import_candidate".into());
                }
            }
        }
        if request.records.iter().any(|record| {
            record.reversed
                && request.plan.legs.iter().any(|leg| {
                    (record.account_id == leg.source_account_id
                        || record.account_id == leg.destination_account_id)
                        && record.amount.currency() == leg.amount.currency()
                        && record.amount.minor_units().checked_abs()
                            == Some(leg.amount.minor_units())
                })
        }) {
            return Err("transfer_reversed".into());
        }
        let valid_record = |record: &TransferSettlementRecord, leg: &TransferLeg| -> bool {
            let baseline = if record.amount.is_negative() {
                &leg.source_before
            } else {
                &leg.destination_before
            };
            record.account_id == baseline.account_id
                && record.amount.currency() == leg.amount.currency()
                && record.amount.minor_units().checked_abs() == Some(leg.amount.minor_units())
                && !record.reversed
                && record.provenance != SettlementProvenance::ManualLedger
                && record.imported_id.as_ref().is_some_and(|id| !id.is_empty())
                && (record.provenance != SettlementProvenance::ProviderConfirmed
                    || record
                        .provider_reference
                        .as_ref()
                        .is_some_and(|id| !id.is_empty()))
                && !record.pair_id.is_empty()
                && !identities[record.id.as_str()].iter().any(|id| {
                    request.consumed_evidence_ids.contains(id)
                        || baseline.baseline_transaction_ids.contains(id)
                })
                && !record
                    .imported_id
                    .as_ref()
                    .is_some_and(|id| baseline.baseline_transaction_ids.contains(id))
                && !record
                    .provider_reference
                    .as_ref()
                    .is_some_and(|id| baseline.baseline_transaction_ids.contains(id))
                && settlement_chronology(record, created, now)
        };
        let mut pairs = BTreeMap::<
            &str,
            (
                Option<&TransferSettlementRecord>,
                Option<&TransferSettlementRecord>,
            ),
        >::new();
        let mut candidate_ids = BTreeSet::new();
        for record in &request.records {
            if !request
                .plan
                .legs
                .iter()
                .any(|leg| valid_record(record, leg))
            {
                continue;
            }
            candidate_ids.insert(record.id.as_str());
            let pair = pairs.entry(record.pair_id.as_str()).or_default();
            let side = if record.amount.is_negative() {
                &mut pair.0
            } else {
                &mut pair.1
            };
            if side.replace(record).is_some() {
                return Err("duplicate_candidate".into());
            }
        }
        let events: Vec<_> = pairs.into_values().collect();
        let first_leg = 1 + events.len();
        let sink = first_leg + request.plan.legs.len();
        let mut graph = vec![vec![]; sink + 1];
        let mut edges = vec![];
        for (index, (source, destination)) in events.iter().enumerate() {
            if let (Some(source), Some(destination)) = (source, destination) {
                if (source.provenance == SettlementProvenance::ProviderConfirmed
                    || destination.provenance == SettlementProvenance::ProviderConfirmed)
                    && source.provider_reference != destination.provider_reference
                {
                    return Err("provider_actual_disagreement".into());
                }
            }
            connect(&mut graph, 0, 1 + index, 1, 0);
            for (leg_index, leg) in request.plan.legs.iter().enumerate() {
                if source.is_none_or(|record| valid_record(record, leg))
                    && destination.is_none_or(|record| valid_record(record, leg))
                {
                    let position = connect(&mut graph, 1 + index, first_leg + leg_index, 1, 0);
                    edges.push((index, leg_index, position));
                }
            }
        }
        for index in 0..request.plan.legs.len() {
            connect(&mut graph, first_leg + index, sink, 1, 0);
        }
        // Every observed candidate event must fit a distinct instruction. Identical
        // monetary steps are allowed; extra candidates and same-record reuse are not.
        let target = i64::try_from(events.len()).map_err(|_| "settlement_candidate_overflow")?;
        if flow(&mut graph, 0, sink, target)? != target {
            return Err("ambiguous_transfer_pair".into());
        }
        let mut assigned = vec![(None, None); request.plan.legs.len()];
        for (event, leg, position) in edges {
            if graph[1 + event][position].capacity == 0 {
                assigned[leg] = events[event];
            }
        }
        let mut used = BTreeSet::new();
        let mut all_sources = true;
        let mut all_destinations = true;
        let mut all_reconciled = true;
        let mut effects = Vec::new();
        for (leg_index, leg) in request.plan.legs.iter().enumerate() {
            let (source, destination) = assigned[leg_index];
            // A unique observed side is already exclusively attributable, even before its pair arrives.
            for record in [source, destination].into_iter().flatten() {
                for id in &identities[record.id.as_str()] {
                    if !used.insert(id.as_str()) {
                        return Err("ambiguous_transfer_pair".into());
                    }
                    result.evidence_ids.push(id.clone());
                }
            }
            if source.is_some_and(|record| record.occurred_at.len() == 10)
                || destination.is_some_and(|record| record.occurred_at.len() == 10)
            {
                result
                    .reasons
                    .push("date_only_import_matched_after_baseline".into());
            }
            let mut debit = request
                .plan
                .reservations
                .get(leg_index)
                .filter(|effect| {
                    effect.kind == ClaimEffectKind::AccountDebit
                        && effect.resource_id == leg.source_account_id
                        && effect.amount == leg.amount
                })
                .cloned()
                .ok_or("missing_source_reservation")?;
            if let Some(source) = source {
                debit.included_in_balance = true;
                debit.matched_transaction_ids = vec![
                    source.id.clone(),
                    source
                        .imported_id
                        .clone()
                        .ok_or("missing_import_identity")?,
                ];
            }
            effects.push(debit.clone());
            if let Some(destination) = destination {
                effects.push(LiquidityClaimEffect {
                    kind: ClaimEffectKind::DestinationHold,
                    resource_id: leg.destination_account_id.clone(),
                    amount: leg.amount.clone(),
                    economic_obligation_id: debit.economic_obligation_id,
                    source_economic_obligation_id: None,
                    category_id: None,
                    included_in_balance: true,
                    matched_transaction_ids: vec![
                        destination.id.clone(),
                        destination
                            .imported_id
                            .clone()
                            .ok_or("missing_import_identity")?,
                    ],
                });
            }
            all_sources &= source.is_some();
            all_destinations &= destination.is_some();
            if let (Some(source), Some(destination)) = (source, destination) {
                all_reconciled &= source.reconciled && destination.reconciled;
            } else {
                all_reconciled = false;
                let invalid = request.records.iter().any(|record| {
                    !candidate_ids.contains(record.id.as_str())
                        && ((record.account_id == leg.source_account_id
                            && record.amount.is_negative())
                            || (record.account_id == leg.destination_account_id
                                && record.amount.minor_units() > 0))
                });
                result.reasons.push(
                    if invalid {
                        "amount_provenance_or_baseline_mismatch"
                    } else {
                        "one_sided_import"
                    }
                    .into(),
                );
            }
        }
        result.source_observed = all_sources;
        result.destination_observed = all_destinations;
        result.reconciled = all_reconciled;
        if !all_reconciled {
            result.reasons.push("reconciliation_required".into());
        }
        result.confirmed = all_sources && all_destinations && all_reconciled;
        if result.reasons.iter().all(|r| {
            r == "one_sided_import"
                || r == "reconciliation_required"
                || r == "date_only_import_matched_after_baseline"
        }) {
            result.claim_effects = Some(if result.confirmed {
                Vec::new()
            } else {
                effects
            });
        }
        Ok(())
    })();
    if let Err(reason) = check {
        result.confirmed = false;
        result.reasons.push(reason);
    }
    result.reasons.sort();
    result.reasons.dedup();
    result.evidence_ids.sort();
    result
}
pub(super) fn preconditions(request: &TransferPreconditionRequest) -> TransferPreconditionResult {
    let result = (|| -> Checked<()> {
        validate_plan(&request.plan)?;
        let now = instant(&request.current_input.evaluated_at)?;
        if now >= instant(&request.plan.expires_at)? {
            return Err("plan_expired".into());
        }
        let mut input = request.current_input.clone();
        if let Some(id) = &request.own_claim_id {
            let own = input
                .claim_set
                .bundles
                .iter()
                .find(|b| &b.id == id)
                .ok_or("own_claim_missing")?;
            if own.initiated || own.state == LiquidityClaimState::Initiated {
                return Err("initiated_plan_requires_settlement".into());
            }
            if own.effects != request.plan.reservations {
                return Err("own_claim_plan_mismatch".into());
            }
            input.claim_set.bundles.retain(|b| &b.id != id);
        }
        if input.scenario != request.plan.scenario
            || input_preconditions_hash(&input)? != request.plan.preconditions_hash
        {
            return Err("financial_preconditions_changed".into());
        }
        let evaluated = checked_evaluate(&input)?;
        let matching = evaluated
            .purchases
            .iter()
            .filter_map(|p| p.transfer_plan.as_ref())
            .find(|plan| {
                plan.minimum_amount == request.plan.minimum_amount
                    && plan.legs.len() == request.plan.legs.len()
                    && plan.legs.iter().zip(&request.plan.legs).all(|(a, b)| {
                        a.source_account_id == b.source_account_id
                            && a.destination_account_id == b.destination_account_id
                            && a.amount == b.amount
                            && a.source_before == b.source_before
                            && a.destination_before == b.destination_before
                            && instant(&a.estimated_arrival).is_ok_and(|at| {
                                instant(&b.required_by).is_ok_and(|required| at <= required)
                            })
                    })
            });
        if matching.is_none()
            || !evaluated.backing_before.feasible
            || !evaluated.backing_after.feasible
        {
            return Err("transfer_no_longer_feasible".into());
        }
        Ok(())
    })();
    match result {
        Ok(()) => TransferPreconditionResult {
            valid: true,
            reasons: vec![],
        },
        Err(reason) => TransferPreconditionResult {
            valid: false,
            reasons: vec![reason],
        },
    }
}
