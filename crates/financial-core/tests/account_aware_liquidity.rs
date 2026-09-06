use balanceframe_financial_core::{liquidity::*, Money};
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/fixtures/account-aware-liquidity.json"
    ))
    .unwrap()
}
fn run(v: Value) -> AccountAwareSpendabilityResult {
    evaluate_account_aware_spendability(serde_json::from_value(v).unwrap())
}
fn m(n: i64) -> Value {
    json!({"minorUnits":n.to_string(),"currency":"USD"})
}
fn plan(v: Value) -> TransferPlan {
    run(v).purchases.remove(0).transfer_plan.unwrap()
}
fn amount(result: &AccountAwareSpendabilityResult, id: &str) -> i64 {
    result
        .accounts_before
        .iter()
        .find(|a| a.account_id == id)
        .unwrap()
        .signed_headroom
        .as_ref()
        .unwrap()
        .minor_units()
}
#[test]
fn exact_minimum_repairs_existing_deficit_and_hash_is_immutable() {
    let v = fixture();
    let r = run(v.clone());
    assert_eq!(r.budget_funding_status, BudgetFundingStatus::Funded);
    assert_eq!(
        r.payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    assert_eq!(amount(&r, "checking"), -1000);
    let p = r.purchases[0].transfer_plan.as_ref().unwrap();
    assert_eq!(p.minimum_amount.minor_units(), 3000);
    assert_eq!(p.payload_hash.len(), 64);
    assert!(p.backing_after.feasible);
    assert_eq!(r, run(v.clone()));
    let mut changed = v;
    changed["claimSet"]["revision"] = json!("claims-2");
    assert_ne!(p.payload_hash, plan(changed).payload_hash);
}
#[test]
fn backing_reroutes_prior_edges_instead_of_greedy_locking() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["accounts"][0]["recordedBalance"] = m(100);
    v["facts"]["accounts"][1]["recordedBalance"] = m(100);
    v["liquidityPolicy"]["accounts"][0]["protectedBuffer"] = m(0);
    let mut second = v["facts"]["categories"][0].clone();
    second["categoryId"] = json!("z-exclusive");
    second["cashBucketId"] = json!("z-exclusive");
    second["availability"] = m(100);
    v["facts"]["categories"][0]["availability"] = m(100);
    v["facts"]["categories"]
        .as_array_mut()
        .unwrap()
        .push(second);
    v["liquidityPolicy"]["accounts"][1]["eligibleCategoryIds"] = json!(["food"]);
    let mut prior = serde_json::to_value(run(v.clone()).backing_before).unwrap();
    prior["lines"] =
        json!([{"accountId":"checking","categoryId":"food","cashBucketId":"food","amount":m(100)}]);
    v["priorAllocation"] = prior;
    let r = run(v);
    assert!(r.backing_before.feasible);
    assert!(r
        .backing_before
        .lines
        .iter()
        .any(|l| l.category_id == "z-exclusive"
            && l.account_id == "checking"
            && l.amount.minor_units() == 100));
    assert!(r
        .backing_before
        .lines
        .iter()
        .any(|l| l.category_id == "food" && l.account_id == "savings"));
}
#[test]
fn unsettled_flows_and_linked_obligations_are_counted_once() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["accounts"][0]["unsettledFlows"] = json!([
 {"id":"pending-out","economicObligationId":"bill","direction":"outflow","amount":m(500),"includedInBalance":true,"matchedTransactionIds":["tx"],"scheduleId":null,"transferTransactionId":null,"importedId":null,"reconciled":false,"provenance":"manual_ledger"},
 {"id":"pending-in","economicObligationId":"income","direction":"inflow","amount":m(700),"includedInBalance":true,"matchedTransactionIds":[],"scheduleId":null,"transferTransactionId":null,"importedId":null,"reconciled":false,"provenance":"manual_ledger"},
 {"id":"expected","economicObligationId":"future-income","direction":"inflow","amount":m(9000),"includedInBalance":false,"matchedTransactionIds":[],"scheduleId":null,"transferTransactionId":null,"importedId":null,"reconciled":false,"provenance":"manual_ledger"}]);
    v["facts"]["accounts"][0]["obligations"] = json!([{"id":"schedule","economicObligationId":"bill","categoryId":"food","amount":m(500),"dueAt":"2026-09-06T12:00:00Z","paid":false,"includedInBalance":false,"matchedTransactionIds":["tx"]}]);
    assert_eq!(amount(&run(v), "checking"), -1700);
}
#[test]
fn active_claims_survive_snapshot_change_and_initiated_expiry() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["claimSet"]["bundles"] = json!([{"id":"claim","creationSnapshotId":"old","creationPolicyVersion":"old","state":"expired","expiresAt":"2026-09-01T00:00:00Z","initiated":true,"effects":[{"kind":"account_debit","resourceId":"savings","amount":m(5000),"economicObligationId":"transfer","categoryId":null,"includedInBalance":false,"matchedTransactionIds":[]}]}]);
    assert_eq!(amount(&run(v.clone()), "savings"), 15000);
    v["claimSet"]["bundles"][0]["effects"][0]["includedInBalance"] = json!(true);
    assert_eq!(amount(&run(v), "savings"), 20000);
}
#[test]
fn alternate_route_precedes_transfer_and_missing_selection_is_explicit() {
    let mut v = fixture();
    v["liquidityPolicy"]["accounts"][1]["paymentEligible"] = json!(true);
    let r = run(v.clone());
    assert_eq!(
        r.payment_liquidity_status,
        PaymentLiquidityStatus::UseOtherAccount
    );
    assert!(r.purchases[0].transfer_plan.is_none());
    v["scenario"]["items"][0]["routeSelection"]["explicitAccountId"] = Value::Null;
    let r = run(v);
    assert_eq!(
        r.payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
    assert!(r.purchases[0].selected_account_id.is_none());
    assert!(!r.purchases[0].alternatives.is_empty());
}
#[test]
fn joint_purchases_do_not_independently_reuse_category_or_account_capacity() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(13000);
    let mut item = v["scenario"]["items"][0].clone();
    item["id"] = json!("purchase-2");
    v["scenario"]["items"].as_array_mut().unwrap().push(item);
    let r = run(v);
    assert_eq!(r.budget_funding_status, BudgetFundingStatus::Unfunded);
    assert_eq!(
        r.purchases[0].payment_liquidity_status,
        PaymentLiquidityStatus::Ready
    );
    assert_ne!(
        r.purchases[1].payment_liquidity_status,
        PaymentLiquidityStatus::Ready
    );
}
#[test]
fn reallocation_changes_backing_but_never_cash() {
    let mut v = fixture();
    let mut second = v["facts"]["categories"][0].clone();
    second["categoryId"] = json!("rent");
    second["cashBucketId"] = json!("rent");
    second["availability"] = m(0);
    v["facts"]["categories"]
        .as_array_mut()
        .unwrap()
        .push(second);
    v["scenario"] = json!({"kind":"reallocation","moves":[{"id":"move","sourceCategoryId":"food","destinationCategoryId":"rent","amount":m(1000)}]});
    let r = run(v);
    assert_eq!(r.accounts_before, r.accounts_after);
    assert!(r.backing_after.feasible);
    assert!(r
        .backing_after
        .lines
        .iter()
        .any(|l| l.category_id == "rent" && l.amount.minor_units() == 1000));
}
#[test]
fn timing_unknown_calendar_never_invents_on_time_arrival() {
    let mut v = fixture();
    v["liquidityPolicy"]["transferRoutes"][0]["providerArrivalAt"] = Value::Null;
    v["liquidityPolicy"]["transferRoutes"][0]["calendarMode"] = json!("business_days");
    v["liquidityPolicy"]["transferRoutes"][0]["utcOffsetMinutes"] = json!(0);
    v["liquidityPolicy"]["transferRoutes"][0]["cutoffMinute"] = json!(1020);
    v["liquidityPolicy"]["transferRoutes"][0]["weekendsAvailable"] = json!(false);
    assert_eq!(
        run(v).payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
    let mut late = fixture();
    late["liquidityPolicy"]["transferRoutes"][0]["providerArrivalAt"] =
        json!("2026-09-06T13:00:00Z");
    assert_eq!(
        run(late).payment_liquidity_status,
        PaymentLiquidityStatus::TransferTooLate
    );
}
#[test]
fn stale_unknown_restricted_off_budget_currency_and_negative_sources_cannot_fund() {
    for mode in [
        "stale",
        "unknown",
        "restricted",
        "off_budget",
        "currency",
        "negative",
    ] {
        let mut v = fixture();
        match mode {
            "stale" => {
                v["facts"]["accounts"][1]["balanceEvidence"]["expiresAt"] =
                    json!("2026-09-01T00:00:00Z")
            }
            "unknown" => v["facts"]["accounts"][1]["activityEvidence"]["state"] = json!("unknown"),
            "restricted" => v["liquidityPolicy"]["accounts"][1]["role"] = json!("restricted"),
            "off_budget" => v["facts"]["accounts"][1]["onBudget"] = json!(false),
            "currency" => v["facts"]["accounts"][1]["currency"] = json!("EUR"),
            _ => v["facts"]["accounts"][1]["recordedBalance"] = m(-1),
        };
        let r = run(v);
        assert!(r.purchases[0].transfer_plan.is_none(), "{mode}");
        assert_ne!(
            r.payment_liquidity_status,
            PaymentLiquidityStatus::Ready,
            "{mode}"
        );
    }
}
#[test]
fn overflow_and_nonpositive_purchase_fail_closed() {
    for value in [0, -1, i64::MIN] {
        let mut v = fixture();
        v["scenario"]["items"][0]["amount"] = m(value);
        let r = run(v);
        assert_eq!(
            r.payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData
        );
        assert!(r.purchases.iter().all(|p| p.transfer_plan.is_none()));
    }
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(i64::MIN);
    assert_eq!(
        run(v).payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["accounts"][1]["recordedBalance"] = m(i64::MAX);
    assert_eq!(amount(&run(v), "savings"), i64::MAX);
}
fn settlement(p: TransferPlan) -> TransferSettlementRequest {
    let leg = &p.legs[0];
    let source = TransferSettlementRecord {
        id: "source-import".into(),
        account_id: leg.source_account_id.clone(),
        amount: Money::new(-leg.amount.minor_units(), "USD"),
        observed_at: "2026-09-06T13:00:00Z".into(),
        occurred_at: "2026-09-06T11:00:00Z".into(),
        imported_id: Some("bank-source".into()),
        provider_reference: None,
        pair_id: "pair".into(),
        reconciled: true,
        reversed: false,
        provenance: SettlementProvenance::InstitutionImport,
    };
    let mut dest = source.clone();
    dest.id = "destination-import".into();
    dest.account_id = leg.destination_account_id.clone();
    dest.amount = leg.amount.clone();
    dest.imported_id = Some("bank-destination".into());
    TransferSettlementRequest {
        plan: p,
        evaluated_at: "2026-09-06T13:00:00Z".into(),
        records: vec![source, dest],
        consumed_evidence_ids: vec![],
    }
}
#[test]
fn settlement_requires_unique_independent_reconciled_sides_and_exact_hash() {
    let good = settlement(plan(fixture()));
    assert!(verify_transfer_settlement(good.clone()).confirmed);
    for mode in [
        "one_side",
        "manual",
        "duplicate",
        "reversed",
        "amount",
        "consumed",
        "hash",
        "same_account_import",
        "preexisting",
    ] {
        let mut r = good.clone();
        match mode {
            "one_side" => {
                r.records.pop();
            }
            "manual" => r.records[0].provenance = SettlementProvenance::ManualLedger,
            "duplicate" => r.records.push(r.records[0].clone()),
            "reversed" => r.records[0].reversed = true,
            "amount" => r.records[1].amount = Money::new(1, "USD"),
            "consumed" => r.consumed_evidence_ids.push(r.records[0].id.clone()),
            "hash" => r.plan.minimum_amount = Money::new(1, "USD"),
            "same_account_import" => {
                let mut alias = r.records[0].clone();
                alias.id = "recreated-source-import".into();
                alias.amount = Money::new(-1, "USD");
                r.records.push(alias);
            }
            _ => r.plan.legs[0]
                .source_before
                .baseline_transaction_ids
                .push("source-import".into()),
        };
        assert!(!verify_transfer_settlement(r).confirmed, "{mode}");
    }
}
#[test]
fn card_purchase_transforms_category_backing_once_and_checks_due_cash() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(13000);
    let mut card = v["facts"]["accounts"][1].clone();
    card["accountId"] = json!("card");
    card["kind"] = json!("credit");
    card["recordedBalance"] = m(-1000);
    card["credit"] = json!({"authorizationAvailable":m(5000),"pendingIncludedInAuthorization":true,"paymentAccountId":"checking","paymentCategoryId":"card-payment","dueAt":"2026-09-20T12:00:00Z","reservedCash":m(1000),"economicObligationId":"autopay","evidence":v["facts"]["accounts"][0]["balanceEvidence"].clone()});
    v["facts"]["accounts"].as_array_mut().unwrap().push(card);
    let mut cp = v["liquidityPolicy"]["accounts"][1].clone();
    cp["accountId"] = json!("card");
    cp["role"] = json!("credit_payment");
    cp["paymentEligible"] = json!(true);
    v["liquidityPolicy"]["accounts"]
        .as_array_mut()
        .unwrap()
        .push(cp);
    let mut payment = v["facts"]["categories"][0].clone();
    payment["categoryId"] = json!("card-payment");
    payment["cashBucketId"] = json!("card-payment");
    payment["kind"] = json!("credit_payment");
    payment["availability"] = m(1000);
    v["facts"]["categories"]
        .as_array_mut()
        .unwrap()
        .push(payment);
    v["scenario"]["items"][0]["routeSelection"]["explicitAccountId"] = json!("card");
    v["facts"]["accounts"][0]["obligations"] = json!([{"id":"scheduled-autopay","economicObligationId":"autopay","categoryId":"card-payment","amount":m(1000),"dueAt":"2026-09-20T12:00:00Z","paid":false,"includedInBalance":false,"matchedTransactionIds":[]}]);
    let r = run(v.clone());
    assert_eq!(r.payment_liquidity_status, PaymentLiquidityStatus::Ready);
    assert_eq!(amount(&r, "checking"), 2000);
    assert_eq!(
        r.purchases[0]
            .credit
            .as_ref()
            .unwrap()
            .authorization_after
            .minor_units(),
        3000
    );
    assert_eq!(
        r.backing_after
            .lines
            .iter()
            .filter(|l| l.category_id == "card-payment")
            .map(|l| l.amount.minor_units())
            .sum::<i64>(),
        3000
    );
    assert_eq!(
        r.accounts_after
            .iter()
            .find(|a| a.account_id == "checking")
            .unwrap()
            .adjusted_cash,
        r.accounts_before
            .iter()
            .find(|a| a.account_id == "checking")
            .unwrap()
            .adjusted_cash
    );
    v["facts"]["accounts"][2]["credit"]["dueAt"] = json!("2026-10-20T12:00:00Z");
    v["liquidityPolicy"]["accounts"][0]["eligibleCategoryIds"] = json!(["card-payment"]);
    assert_eq!(
        run(v).payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
}

#[test]
fn multi_source_transfer_is_one_exact_group_and_retains_each_buffer() {
    let mut v = fixture();
    v["facts"]["accounts"][1]["recordedBalance"] = m(1800);
    let mut third = v["facts"]["accounts"][1].clone();
    third["accountId"] = json!("savings-two");
    third["recordedBalance"] = m(1800);
    v["facts"]["accounts"].as_array_mut().unwrap().push(third);
    let mut p = v["liquidityPolicy"]["accounts"][1].clone();
    p["accountId"] = json!("savings-two");
    p["protectedBuffer"] = m(300);
    v["liquidityPolicy"]["accounts"]
        .as_array_mut()
        .unwrap()
        .push(p);
    let mut route = v["liquidityPolicy"]["transferRoutes"][0].clone();
    route["id"] = json!("second-source");
    route["sourceAccountId"] = json!("savings-two");
    v["liquidityPolicy"]["transferRoutes"]
        .as_array_mut()
        .unwrap()
        .push(route);
    let p = plan(v);
    assert_eq!(p.minimum_amount.minor_units(), 3000);
    assert_eq!(p.legs.len(), 2);
    assert_eq!(
        p.legs.iter().map(|l| l.amount.minor_units()).sum::<i64>(),
        3000
    );
    assert!(p.legs.iter().all(|l| l.source_after.minor_units() >= 0));
}

#[test]
fn preconditions_tolerate_capture_identity_but_not_changed_financial_facts_or_other_claims() {
    let original = fixture();
    let p = plan(original.clone());
    let mut current: LiquidityInput = serde_json::from_value(original).unwrap();
    current.snapshot_id = "new-capture".into();
    current.content_hash = "new-capture-hash".into();
    current.facts.as_mut().unwrap().ledger_content_hash = "new-ledger-capture-hash".into();
    let request = TransferPreconditionRequest {
        plan: p.clone(),
        current_input: current.clone(),
        own_claim_id: None,
    };
    assert!(verify_transfer_preconditions(request.clone()).valid);
    current.claim_set.revision = "after-own-admission".into();
    current.claim_set.bundles.push(LiquidityClaimBundle {
        id: "own".into(),
        creation_snapshot_id: p.snapshot_id.clone(),
        creation_policy_version: p.policy_version.clone(),
        state: LiquidityClaimState::Active,
        expires_at: p.expires_at.clone(),
        initiated: false,
        effects: p.reservations.clone(),
    });
    assert!(
        verify_transfer_preconditions(TransferPreconditionRequest {
            plan: p.clone(),
            current_input: current.clone(),
            own_claim_id: Some("own".into())
        })
        .valid
    );
    current.facts.as_mut().unwrap().accounts[1].recorded_balance = Money::new(19000, "USD");
    assert!(
        !verify_transfer_preconditions(TransferPreconditionRequest {
            plan: p,
            current_input: current,
            own_claim_id: Some("own".into())
        })
        .valid
    );
}

#[test]
fn settlement_replacement_effects_hold_destination_until_both_sides_reconcile() {
    let mut request = settlement(plan(fixture()));
    request.records[1].reconciled = false;
    let result = verify_transfer_settlement(request);
    assert!(!result.confirmed);
    assert!(result.source_observed && result.destination_observed);
    assert!(result
        .claim_effects
        .as_ref()
        .unwrap()
        .iter()
        .any(|e| e.kind == ClaimEffectKind::AccountDebit && e.included_in_balance));
    assert!(result
        .claim_effects
        .as_ref()
        .unwrap()
        .iter()
        .any(|e| e.kind == ClaimEffectKind::DestinationHold && e.included_in_balance));
}

#[test]
fn date_only_scheduled_bill_reserves_cash_before_projected_income_without_inventing_time() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["accounts"][1]["obligations"] = json!([{"id":"bill","economicObligationId":"bill","categoryId":null,"amount":m(15000),"dueAt":"2026-09-10","paid":false,"includedInBalance":false,"matchedTransactionIds":[]}]);
    assert_eq!(amount(&run(v), "savings"), 5000);
}

#[test]
fn unknown_excluded_account_does_not_poison_known_selected_ready() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(13000);
    v["liquidityPolicy"]["accounts"][1]["role"] = json!("excluded");
    v["facts"]["accounts"][1]["balanceEvidence"]["state"] = json!("unknown");
    assert_eq!(
        run(v).payment_liquidity_status,
        PaymentLiquidityStatus::Ready
    );
}

#[test]
fn stable_prior_allocation_retains_feasible_edges_and_rejects_wrong_identity() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["accounts"][0]["recordedBalance"] = m(15000);
    let mut prior = serde_json::to_value(run(v.clone()).backing_before).unwrap();
    prior["lines"] =
        json!([{"accountId":"savings","categoryId":"food","cashBucketId":"food","amount":m(2000)}]);
    v["priorAllocation"] = prior;
    assert_eq!(run(v.clone()).backing_before.lines[0].account_id, "savings");
    v["priorAllocation"]["snapshotId"] = json!("untrusted");
    assert_eq!(run(v).backing_before.lines[0].account_id, "checking");
}

#[test]
fn explicit_route_wins_session_preference_and_history() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(13000);
    v["scenario"]["items"][0]["routeSelection"]["sessionAccountId"] = json!("savings");
    v["scenario"]["items"][0]["routeSelection"]["approvedPreference"] =
        json!({"accountId":"savings","referenceId":"approved"});
    v["scenario"]["items"][0]["routeSelection"]["historicalRoute"] =
        json!({"accountId":"savings","referenceId":"history"});
    let r = run(v);
    assert_eq!(
        r.purchases[0].selected_account_id.as_deref(),
        Some("checking")
    );
    assert_eq!(r.purchases[0].selection_source, "explicit");
    assert_eq!(r.payment_liquidity_status, PaymentLiquidityStatus::Ready);
}

#[test]
fn ledger_ttl_and_attestation_disclosures_do_not_erase_known_facts() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["balanceEvidence"] = json!({"state":"known","source":"actual_ledger","observedAt":"2026-09-06T09:59:00Z","expiresAt":null,"reasons":["ledger_balance_not_institution_freshness"]});
    v["facts"]["categories"][0]["evidence"] = json!({"state":"known","source":"actual_ledger","observedAt":"2026-09-06T09:59:00Z","expiresAt":null,"reasons":[]});
    v["facts"]["accounts"][0]["freshnessEvidence"]["reasons"] =
        json!(["explicit_user_attestation_not_bank_sync"]);
    let r = run(v.clone());
    assert_eq!(r.budget_funding_status, BudgetFundingStatus::Funded);
    assert_eq!(
        r.payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    assert_eq!(r.expires_at, "2026-09-06T10:14:00Z");
    v["facts"]["accounts"][0]["balanceEvidence"]["observedAt"] = json!("2026-09-06T09:00:00Z");
    assert_eq!(
        run(v).payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
}

#[test]
fn ledger_capture_alone_never_establishes_institution_freshness() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(13000);
    v["facts"]["accounts"][0]["freshnessEvidence"]["state"] = json!("unknown");
    assert_eq!(
        run(v).payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
}

#[test]
fn repeated_session_shortfalls_have_distinct_economic_reservations() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(10000);
    v["facts"]["categories"][0]["availability"] = m(5000);
    let mut second = v["scenario"]["items"][0].clone();
    second["id"] = json!("purchase-2");
    v["scenario"]["items"].as_array_mut().unwrap().push(second);
    let result = run(v);
    let first = result.purchases[0].transfer_plan.as_ref().unwrap();
    let second = result.purchases[1].transfer_plan.as_ref().unwrap();
    assert_ne!(
        first.reservations[0].economic_obligation_id,
        second.reservations[0].economic_obligation_id
    );
}

#[test]
fn ledger_observation_recapture_preserves_plan_but_not_freshness_deadline() {
    let mut v = fixture();
    v["facts"]["categories"][0]["evidence"] = json!({"state":"known","source":"actual_ledger","observedAt":"2026-09-06T09:59:00Z","expiresAt":null,"reasons":[]});
    let p = plan(v.clone());
    v["facts"]["categories"][0]["evidence"]["observedAt"] = json!("2026-09-06T10:01:00Z");
    v["evaluatedAt"] = json!("2026-09-06T10:02:00Z");
    v["snapshotId"] = json!("recapture");
    v["contentHash"] = json!("recapture");
    let current: LiquidityInput = serde_json::from_value(v).unwrap();
    assert!(
        verify_transfer_preconditions(TransferPreconditionRequest {
            plan: p.clone(),
            current_input: current.clone(),
            own_claim_id: None
        })
        .valid
    );
    let mut expired = current;
    expired.evaluated_at = "2026-09-06T10:15:00Z".into();
    assert!(
        !verify_transfer_preconditions(TransferPreconditionRequest {
            plan: p,
            current_input: expired,
            own_claim_id: None
        })
        .valid
    );
}
