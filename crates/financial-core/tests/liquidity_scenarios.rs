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
fn head(r: &AccountAwareSpendabilityResult, id: &str) -> i64 {
    r.accounts_before
        .iter()
        .find(|a| a.account_id == id)
        .unwrap()
        .signed_headroom
        .as_ref()
        .unwrap()
        .minor_units()
}
fn flow(id: &str, economic: &str, direction: &str, n: i64, included: bool) -> Value {
    json!({"id":id,"economicObligationId":economic,"direction":direction,"amount":m(n),"includedInBalance":included,"matchedTransactionIds":[],"scheduleId":null,"transferTransactionId":null,"importedId":null,"reconciled":false,"provenance":"manual_ledger"})
}
fn obligation(id: &str, economic: &str, category: Option<&str>, n: i64) -> Value {
    json!({"id":id,"economicObligationId":economic,"categoryId":category,"amount":m(n),"dueAt":"2026-09-20","paid":false,"includedInBalance":false,"matchedTransactionIds":[]})
}
fn card_fixture(two: bool) -> Value {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(14000);
    v["facts"]["categories"][0]["availability"] = m(4000);
    v["liquidityPolicy"]["accounts"][0]["eligibleCategoryIds"] =
        json!(["payment-one", "payment-two"]);
    for (id, category, economic) in [
        ("card-one", "payment-one", "autopay-one"),
        ("card-two", "payment-two", "autopay-two"),
    ]
    .into_iter()
    .take(if two { 2 } else { 1 })
    {
        let mut card = v["facts"]["accounts"][1].clone();
        card["accountId"] = json!(id);
        card["kind"] = json!("credit");
        card["recordedBalance"] = m(-1000);
        card["credit"] = json!({"authorizationAvailable":m(5000),"pendingIncludedInAuthorization":true,"paymentAccountId":"checking","paymentCategoryId":category,"dueAt":"2026-09-20T12:00:00Z","reservedCash":m(1000),"economicObligationId":economic,"evidence":v["facts"]["accounts"][0]["balanceEvidence"]});
        v["facts"]["accounts"].as_array_mut().unwrap().push(card);
        let mut policy = v["liquidityPolicy"]["accounts"][1].clone();
        policy["accountId"] = json!(id);
        policy["role"] = json!("credit_payment");
        policy["paymentEligible"] = json!(true);
        v["liquidityPolicy"]["accounts"]
            .as_array_mut()
            .unwrap()
            .push(policy);
        let mut cat = v["facts"]["categories"][0].clone();
        cat["categoryId"] = json!(category);
        cat["cashBucketId"] = json!(category);
        cat["kind"] = json!("credit_payment");
        cat["availability"] = m(1000);
        v["facts"]["categories"].as_array_mut().unwrap().push(cat);
        v["facts"]["accounts"][0]["obligations"]
            .as_array_mut()
            .unwrap()
            .push(obligation(economic, economic, Some(category), 1000));
    }
    v["scenario"]["items"][0]["routeSelection"]["explicitAccountId"] = json!("card-one");
    v
}
fn plan(v: Value) -> TransferPlan {
    run(v).purchases.remove(0).transfer_plan.unwrap()
}
#[test]
fn multiple_cards_compete_for_the_same_due_date_cash_without_double_autopay() {
    let mut v = card_fixture(true);
    v["scenario"]["items"][0]["amount"] = m(1500);
    let mut second = v["scenario"]["items"][0].clone();
    second["id"] = json!("purchase-2");
    second["routeSelection"]["explicitAccountId"] = json!("card-two");
    v["scenario"]["items"].as_array_mut().unwrap().push(second);
    let r = run(v);
    assert_eq!(head(&r, "checking"), 2000);
    assert_eq!(
        r.purchases[0].payment_liquidity_status,
        PaymentLiquidityStatus::Ready
    );
    assert_eq!(
        r.purchases[1].payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    let p = r.purchases[1].transfer_plan.as_ref().unwrap();
    assert_eq!(p.minimum_amount.minor_units(), 1000);
    assert_eq!(p.legs[0].destination_account_id, "checking");
    assert_eq!(p.legs[0].required_by, "2026-09-20T12:00:00Z");
    assert!(r
        .backing_after
        .lines
        .iter()
        .all(|line| !line.account_id.starts_with("card-")));
}
#[test]
fn pending_card_authorization_is_deducted_only_when_not_already_included() {
    let mut v = card_fixture(false);
    v["facts"]["accounts"][2]["credit"]["authorizationAvailable"] = m(2500);
    v["facts"]["accounts"][2]["unsettledFlows"] =
        json!([flow("card-pending", "card-pending", "outflow", 1000, true)]);
    let included = run(v.clone());
    assert_eq!(
        included.purchases[0].payment_liquidity_status,
        PaymentLiquidityStatus::Ready
    );
    assert_eq!(
        included.purchases[0]
            .credit
            .as_ref()
            .unwrap()
            .authorization_after
            .minor_units(),
        500
    );
    v["facts"]["accounts"][2]["credit"]["pendingIncludedInAuthorization"] = json!(false);
    let excluded = run(v);
    assert_eq!(
        excluded.purchases[0]
            .credit
            .as_ref()
            .unwrap()
            .authorization_after
            .minor_units(),
        -500
    );
    assert_eq!(
        excluded.purchases[0].payment_liquidity_status,
        PaymentLiquidityStatus::NotLiquid
    );
}
#[test]
fn unmatched_refunds_do_not_release_card_payment_cash_but_observed_settled_reserve_updates_do() {
    let mut v = card_fixture(false);
    v["scenario"] = json!({"kind":"none"});
    let baseline = run(v.clone());
    assert_eq!(head(&baseline, "checking"), 3000);
    v["facts"]["accounts"][2]["recordedBalance"] = m(-500);
    let settled_unmatched = run(v.clone());
    assert_eq!(head(&settled_unmatched, "checking"), 3000);
    v["facts"]["accounts"][2]["unsettledFlows"] =
        json!([flow("pending-refund", "refund", "inflow", 500, true)]);
    let unsettled = run(v.clone());
    assert_eq!(head(&unsettled, "checking"), 3000);
    assert_eq!(
        unsettled
            .backing_before
            .lines
            .iter()
            .filter(|l| l.category_id == "payment-one")
            .map(|l| l.amount.minor_units())
            .sum::<i64>(),
        1000
    );
    v["facts"]["accounts"][2]["unsettledFlows"] = json!([]);
    v["facts"]["accounts"][2]["baselineTransactionIds"] = json!(["settled-refund-import"]);
    v["facts"]["accounts"][2]["credit"]["reservedCash"] = m(500);
    v["facts"]["accounts"][2]["credit"]["evidence"]["source"] = json!("institution_provider");
    v["facts"]["accounts"][0]["obligations"][0]["amount"] = m(500);
    v["facts"]["accounts"][0]["obligations"][0]["matchedTransactionIds"] =
        json!(["settled-refund-import"]);
    v["facts"]["categories"][1]["availability"] = m(500);
    assert_eq!(head(&run(v), "checking"), 3500);
}
#[test]
fn scheduled_income_remains_projection_only_while_bills_reserve_cash() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["accounts"][1]["obligations"] = json!([obligation("rent", "rent", None, 18000)]);
    v["facts"]["accounts"][1]["unsettledFlows"] =
        json!([flow("future-pay", "future-pay", "inflow", 100000, false)]);
    v["facts"]["schedules"] = json!([{"id":"payday","accountId":"savings","categoryId":null,"ruleId":null,"dueDate":"2026-09-19","certainty":"exact","amount":m(100000),"minimum":null,"maximum":null,"recurrence":null}]);
    assert_eq!(head(&run(v), "savings"), 2000);
}
#[test]
fn pending_outflow_and_schedule_linked_by_transaction_are_one_obligation() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    let mut pending = flow("tx-1", "transaction:tx-1", "outflow", 1000, true);
    pending["scheduleId"] = json!("bill");
    v["facts"]["accounts"][1]["unsettledFlows"] = json!([pending]);
    let mut bill = obligation("bill", "schedule:bill:2026-09-20", None, 1000);
    bill["matchedTransactionIds"] = json!(["tx-1"]);
    v["facts"]["accounts"][1]["obligations"] = json!([bill]);
    assert_eq!(head(&run(v), "savings"), 20000);
}
#[test]
fn repeated_unsettled_inflow_identity_is_ambiguous_not_fresh_capacity() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(14000);
    v["facts"]["accounts"][0]["unsettledFlows"] = json!([
        flow("one", "same-refund", "inflow", 100, true),
        flow("two", "same-refund", "inflow", 100, true)
    ]);
    assert_eq!(
        run(v).payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
}
fn timing_fixture(now: &str, required: &str) -> Value {
    let mut v = fixture();
    v["evaluatedAt"] = json!(now);
    v["horizon"]["startsAt"] = json!("2026-09-01T00:00:00Z");
    v["validUntil"] = json!("2026-09-29T00:00:00Z");
    v["liquidityPolicy"]["expiresAt"] = json!("2026-09-29T00:00:00Z");
    fn retime(value: &mut Value) {
        match value {
            Value::Object(o) => {
                if o.contains_key("state") && o.contains_key("source") {
                    o.insert("observedAt".into(), json!("2026-09-01T00:00:00Z"));
                    o.insert("expiresAt".into(), json!("2026-09-29T00:00:00Z"));
                }
                for value in o.values_mut() {
                    retime(value);
                }
            }
            Value::Array(a) => {
                for value in a {
                    retime(value);
                }
            }
            _ => {}
        }
    }
    retime(&mut v);
    v["scenario"]["items"][0]["purchaseAt"] = json!(required);
    v["scenario"]["items"][0]["requiredBy"] = json!(required);
    let route = &mut v["liquidityPolicy"]["transferRoutes"][0];
    route["providerArrivalAt"] = Value::Null;
    route["calendarMode"] = json!("business_days");
    route["delayDays"] = json!(1);
    route["utcOffsetMinutes"] = json!(0);
    route["cutoffMinute"] = json!(1020);
    route["weekendsAvailable"] = json!(false);
    route["holidaysComplete"] = json!(true);
    v
}
#[test]
fn explicit_same_day_and_external_business_day_timing_follow_cutoff_weekend_and_holidays() {
    let mut same = timing_fixture("2026-09-04T16:00:00Z", "2026-09-04T17:00:00Z");
    same["liquidityPolicy"]["transferRoutes"][0]["delayDays"] = json!(0);
    assert_eq!(plan(same).legs[0].estimated_arrival, "2026-09-04T16:00:00Z");
    let before = timing_fixture("2026-09-04T16:00:00Z", "2026-09-08T18:00:00Z");
    assert_eq!(
        plan(before).legs[0].estimated_arrival,
        "2026-09-07T16:00:00Z"
    );
    let after = timing_fixture("2026-09-04T18:00:00Z", "2026-09-09T18:00:00Z");
    assert_eq!(
        plan(after).legs[0].estimated_arrival,
        "2026-09-08T18:00:00Z"
    );
    let mut holiday = timing_fixture("2026-09-04T16:00:00Z", "2026-09-09T18:00:00Z");
    holiday["liquidityPolicy"]["transferRoutes"][0]["holidays"] = json!(["2026-09-07"]);
    assert_eq!(
        plan(holiday).legs[0].estimated_arrival,
        "2026-09-08T16:00:00Z"
    );
}
#[test]
fn explicit_policy_calendar_is_a_disclosed_assumption_not_missing_account_evidence() {
    let mut v = timing_fixture("2026-09-04T16:00:00Z", "2026-09-08T18:00:00Z");
    v["liquidityPolicy"]["transferRoutes"][0]["evidence"]["source"] = json!("policy_assumption");
    let r = run(v);
    assert_eq!(
        r.payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    assert!(r
        .assumptions
        .iter()
        .any(|reason| reason == "explicit_transfer_calendar_policy"));
}
#[test]
fn category_currency_cannot_be_subtracted_as_if_it_were_the_purchase_currency() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(13000);
    v["facts"]["categories"][0]["availability"]["currency"] = json!("EUR");
    v["facts"]["accounts"][1]["currency"] = json!("EUR");
    for key in ["recordedBalance", "holds"] {
        v["facts"]["accounts"][1][key]["currency"] = json!("EUR");
    }
    v["liquidityPolicy"]["accounts"][1]["protectedBuffer"]["currency"] = json!("EUR");
    let r = run(v);
    assert_eq!(
        r.budget_funding_status,
        BudgetFundingStatus::InsufficientData
    );
    assert_eq!(
        r.payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
}
#[test]
fn disconnected_account_and_unknown_hold_evidence_block_only_affected_routes() {
    for field in ["balanceEvidence", "holdsEvidence"] {
        let mut v = fixture();
        v["facts"]["accounts"][1][field]["state"] = json!("unavailable");
        assert_eq!(
            run(v).payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData
        );
    }
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(13000);
    v["facts"]["accounts"][1]["freshnessEvidence"]["state"] = json!("unavailable");
    assert_eq!(
        run(v).payment_liquidity_status,
        PaymentLiquidityStatus::Ready
    );
}
fn settlement(plan: TransferPlan) -> TransferSettlementRequest {
    let mut records = vec![];
    for leg in &plan.legs {
        for (source, id, account, n) in [
            (
                true,
                format!("{}-source", leg.id),
                leg.source_account_id.clone(),
                -leg.amount.minor_units(),
            ),
            (
                false,
                format!("{}-destination", leg.id),
                leg.destination_account_id.clone(),
                leg.amount.minor_units(),
            ),
        ] {
            records.push(TransferSettlementRecord {
                id,
                account_id: account,
                amount: Money::new(n, "USD"),
                observed_at: "2026-09-06T13:00:00Z".into(),
                occurred_at: "2026-09-06T11:00:00Z".into(),
                imported_id: Some(format!(
                    "{}-{}",
                    leg.id,
                    if source { "debit" } else { "credit" }
                )),
                provider_reference: None,
                pair_id: leg.id.clone(),
                reconciled: true,
                reversed: false,
                provenance: SettlementProvenance::ActualImport,
            });
        }
    }
    TransferSettlementRequest {
        plan,
        evaluated_at: "2026-09-06T13:00:00Z".into(),
        records,
        consumed_evidence_ids: vec![],
    }
}
fn multileg_plan() -> TransferPlan {
    let mut v = fixture();
    v["facts"]["accounts"][1]["recordedBalance"] = m(1800);
    let mut third = v["facts"]["accounts"][1].clone();
    third["accountId"] = json!("source-two");
    v["facts"]["accounts"].as_array_mut().unwrap().push(third);
    let mut p = v["liquidityPolicy"]["accounts"][1].clone();
    p["accountId"] = json!("source-two");
    v["liquidityPolicy"]["accounts"]
        .as_array_mut()
        .unwrap()
        .push(p);
    let mut route = v["liquidityPolicy"]["transferRoutes"][0].clone();
    route["id"] = json!("route-two");
    route["sourceAccountId"] = json!("source-two");
    v["liquidityPolicy"]["transferRoutes"]
        .as_array_mut()
        .unwrap()
        .push(route);
    plan(v)
}
#[test]
fn multileg_settlement_is_order_independent_and_one_sided_until_every_leg_arrives() {
    let good = settlement(multileg_plan());
    assert!(verify_transfer_settlement(good.clone()).confirmed);
    let mut reversed_order = good.clone();
    reversed_order.records.reverse();
    assert_eq!(
        verify_transfer_settlement(good.clone()),
        verify_transfer_settlement(reversed_order)
    );
    let mut mixed = good.clone();
    mixed.records.retain(|r| r.id != "leg-2-destination");
    let partial = verify_transfer_settlement(mixed);
    assert!(!partial.confirmed);
    assert!(partial.source_observed);
    assert!(!partial.destination_observed);
    assert!(partial
        .claim_effects
        .as_ref()
        .unwrap()
        .iter()
        .any(|e| e.kind == ClaimEffectKind::DestinationHold));
    let mut duplicate = good;
    let mut copy = duplicate.records[0].clone();
    copy.id = "second-independent-source".into();
    copy.imported_id = Some("second-independent-import".into());
    duplicate.records.push(copy);
    assert!(!verify_transfer_settlement(duplicate).confirmed);
}
#[test]
fn reversal_after_a_source_observation_never_confirms_or_releases_existing_holds() {
    let mut request = settlement(plan(fixture()));
    let mut reversal = request.records[0].clone();
    reversal.id = "source-reversal".into();
    reversal.imported_id = Some("source-reversal-import".into());
    reversal.reversed = true;
    request.records.push(reversal);
    let result = verify_transfer_settlement(request);
    assert!(!result.confirmed);
    assert!(result.claim_effects.is_none());
}
#[test]
fn newly_competing_source_claim_invalidates_approval_and_initiated_expiry_retains_hold() {
    let v = fixture();
    let p = plan(v.clone());
    let mut input: LiquidityInput = serde_json::from_value(v).unwrap();
    let mut effect = p.reservations[0].clone();
    effect.amount = Money::new(19000, "USD");
    effect.economic_obligation_id = "competing".into();
    input.claim_set.bundles.push(LiquidityClaimBundle {
        id: "competing".into(),
        creation_snapshot_id: "old".into(),
        creation_policy_version: "old".into(),
        state: LiquidityClaimState::Active,
        expires_at: p.expires_at.clone(),
        initiated: false,
        effects: vec![effect],
    });
    assert!(
        !verify_transfer_preconditions(TransferPreconditionRequest {
            plan: p,
            current_input: input.clone(),
            own_claim_id: None
        })
        .valid
    );
    input.scenario = LiquidityScenario::None;
    input.claim_set.bundles[0].state = LiquidityClaimState::Cancelled;
    input.claim_set.bundles[0].initiated = true;
    input.claim_set.bundles[0].expires_at = "2026-09-01T00:00:00Z".into();
    assert_eq!(
        head(&evaluate_account_aware_spendability(input), "savings"),
        1000
    );
}
#[test]
fn cash_neutral_reallocation_preserves_total_backing_and_fails_restricted_destination() {
    let mut v = fixture();
    let mut category = v["facts"]["categories"][0].clone();
    category["categoryId"] = json!("rent");
    category["cashBucketId"] = json!("rent");
    category["availability"] = m(0);
    v["facts"]["categories"]
        .as_array_mut()
        .unwrap()
        .push(category);
    v["scenario"] = json!({"kind":"reallocation","moves":[{"id":"move","sourceCategoryId":"food","destinationCategoryId":"rent","amount":m(2000)}]});
    let r = run(v.clone());
    assert_eq!(r.accounts_before, r.accounts_after);
    assert_eq!(
        r.backing_before
            .lines
            .iter()
            .map(|l| l.amount.minor_units())
            .sum::<i64>(),
        2000
    );
    assert_eq!(
        r.backing_after
            .lines
            .iter()
            .map(|l| l.amount.minor_units())
            .sum::<i64>(),
        2000
    );
    v["liquidityPolicy"]["accounts"][1]["eligibleCategoryIds"] = json!(["food"]);
    let blocked = run(v);
    assert!(!blocked.backing_after.feasible);
    assert!(blocked.backing_after.lines.is_empty());
    assert!(blocked
        .backing_after
        .reasons
        .iter()
        .any(|r| r == "insufficient_cash_backing"));
}
#[test]
fn native_boundary_rejects_noncanonical_instants_without_confident_routes() {
    for time in [
        "2026-09-06T10:00:00+00:00",
        "2026-09-06 10:00:00Z",
        "2026-09-06T09:59:60Z",
        "2026-09-06T10:00:00.1234567890Z",
        "2026-02-30T10:00:00Z",
    ] {
        let mut v = fixture();
        v["evaluatedAt"] = json!(time);
        assert_eq!(
            run(v).payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData,
            "{time}"
        );
    }
}
#[test]
fn native_money_deserialization_rejects_noncanonical_and_out_of_range_minor_units() {
    for units in [
        "+2000",
        "02000",
        "-0",
        "9223372036854775808",
        "-9223372036854775809",
    ] {
        let mut v = fixture();
        v["scenario"]["items"][0]["amount"]["minorUnits"] = json!(units);
        assert!(
            serde_json::from_value::<LiquidityInput>(v).is_err(),
            "{units}"
        );
    }
}
#[test]
fn leap_day_is_a_real_date_and_repeatability_is_byte_exact() {
    let mut v = timing_fixture("2026-09-04T16:00:00Z", "2026-09-08T18:00:00Z");
    v["liquidityPolicy"]["transferRoutes"][0]["holidays"] = json!(["2028-02-29"]);
    let first = run(v.clone());
    let second = run(v);
    assert_eq!(
        first.payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    assert_eq!(
        serde_json::to_vec(&first).unwrap(),
        serde_json::to_vec(&second).unwrap()
    );
}

#[test]
fn dated_actual_imports_match_after_intent_baseline_without_invented_intraday_time() {
    let mut request = settlement(plan(fixture()));
    for record in &mut request.records {
        record.occurred_at = "2026-09-06".into();
    }
    let verified = verify_transfer_settlement(request.clone());
    assert!(verified.confirmed);
    assert!(verified
        .reasons
        .iter()
        .any(|reason| reason == "date_only_import_matched_after_baseline"));
    for date in ["2026-09-05", "2026-09-07", "2026-02-30"] {
        let mut invalid = request.clone();
        invalid.records[0].occurred_at = date.into();
        assert!(!verify_transfer_settlement(invalid).confirmed);
    }
    let mut before_observation = request.clone();
    before_observation.records[0].observed_at = "2026-09-06T09:00:00Z".into();
    assert!(!verify_transfer_settlement(before_observation).confirmed);
    let mut unsupported_provider_precision = request;
    unsupported_provider_precision.records[0].provenance = SettlementProvenance::InstitutionImport;
    assert!(!verify_transfer_settlement(unsupported_provider_precision).confirmed);
}

#[test]
fn same_category_current_and_future_buckets_remain_distinct_and_future_cash_protected() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(13000);
    v["facts"]["accounts"][1]["recordedBalance"] = m(5000);
    v["facts"]["categories"][0]["cashBucketId"] = json!("actual:category:food:2026-09");
    let mut future = v["facts"]["categories"][0].clone();
    future["cashBucketId"] = json!("actual:category:food:2026-10");
    future["asOfMonth"] = json!("2026-10");
    future["periodKind"] = json!("future");
    future["availability"] = m(5000);
    v["facts"]["categories"]
        .as_array_mut()
        .unwrap()
        .push(future);
    v["liquidityPolicy"]["accounts"][1]["role"] = json!("restricted");
    v["liquidityPolicy"]["accounts"][1]["eligibleCategoryIds"] = json!(["food"]);
    v["liquidityPolicy"]["accounts"][1]["restrictedCashBucketIds"] =
        json!(["actual:category:food:2026-10"]);
    let result = run(v.clone());
    assert_eq!(result.budget_funding_status, BudgetFundingStatus::Funded);
    assert_eq!(
        result.payment_liquidity_status,
        PaymentLiquidityStatus::Ready
    );
    assert!(result.backing_before.feasible && result.backing_after.feasible);
    assert_eq!(
        result
            .backing_before
            .lines
            .iter()
            .map(|line| line.amount.minor_units())
            .sum::<i64>(),
        7000
    );
    assert_eq!(
        result
            .backing_before
            .lines
            .iter()
            .filter(|line| line.account_id == "checking"
                && line.cash_bucket_id == "actual:category:food:2026-09")
            .map(|line| line.amount.minor_units())
            .sum::<i64>(),
        2000
    );
    assert!(result
        .backing_before
        .lines
        .iter()
        .chain(&result.backing_after.lines)
        .filter(|line| line.account_id == "savings")
        .all(|line| line.cash_bucket_id == "actual:category:food:2026-10"));
    assert_eq!(
        result
            .backing_after
            .lines
            .iter()
            .map(|line| line.amount.minor_units())
            .sum::<i64>(),
        5000
    );

    assert_eq!(
        result
            .backing_after
            .lines
            .iter()
            .filter(|line| line.cash_bucket_id == "actual:category:food:2026-10")
            .map(|line| line.amount.minor_units())
            .sum::<i64>(),
        5000
    );
    assert_eq!(
        result
            .categories
            .iter()
            .find(|category| category.cash_bucket_id == "actual:category:food:2026-09")
            .unwrap()
            .remaining_availability
            .as_ref()
            .unwrap()
            .minor_units(),
        0
    );
    assert_eq!(
        result
            .categories
            .iter()
            .find(|category| category.cash_bucket_id == "actual:category:food:2026-10")
            .unwrap()
            .remaining_availability
            .as_ref()
            .unwrap()
            .minor_units(),
        5000
    );
    let mut over_current = v.clone();
    over_current["scenario"]["items"][0]["amount"] = m(2500);
    assert_eq!(
        run(over_current).budget_funding_status,
        BudgetFundingStatus::Unfunded
    );

    let mut restricted_current = v.clone();
    restricted_current["facts"]["accounts"][0]["recordedBalance"] = m(11000);
    let restricted = run(restricted_current);
    assert!(!restricted.backing_before.feasible);
    assert!(restricted
        .purchases
        .iter()
        .all(|purchase| purchase.transfer_plan.is_none()));

    v["facts"]["categories"].as_array_mut().unwrap().remove(0);
    let future_only = run(v);
    assert_eq!(
        future_only.budget_funding_status,
        BudgetFundingStatus::InsufficientData
    );
    assert_eq!(
        future_only.payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
}

#[test]
fn review_one_sided_evidence_prevents_recreated_import_reuse() {
    for source in [true, false] {
        let complete = settlement(plan(fixture()));
        let mut partial = complete.clone();
        partial
            .records
            .retain(|record| record.amount.is_negative() == source);
        let observed = verify_transfer_settlement(partial);
        assert_eq!(observed.source_observed, source);
        assert_eq!(observed.destination_observed, !source);
        let mut replay = complete;
        replay.consumed_evidence_ids = observed.evidence_ids;
        for record in &mut replay.records {
            record.id = format!("recreated-{}", record.id);
        }
        let rejected = verify_transfer_settlement(replay);
        assert!(!rejected.confirmed);
        assert!(!if source {
            rejected.source_observed
        } else {
            rejected.destination_observed
        });
    }
}

#[test]
fn review_provider_reference_cannot_release_a_second_import_pair() {
    let mut request = settlement(plan(fixture()));
    for record in &mut request.records {
        record.provenance = SettlementProvenance::ProviderConfirmed;
        record.provider_reference = Some("provider-transfer".into());
    }
    let confirmed = verify_transfer_settlement(request.clone());
    assert!(confirmed.confirmed);
    request.consumed_evidence_ids = confirmed.evidence_ids;
    for record in &mut request.records {
        record.id = format!("recreated-{}", record.id);
        record.imported_id = Some(format!("reimported-{}", record.id));
    }
    assert!(!verify_transfer_settlement(request).confirmed);
}

#[test]
fn review_import_identity_is_scoped_to_its_source_account() {
    let mut request = settlement(plan(fixture()));
    for record in &mut request.records {
        record.imported_id = Some("account-local-id".into());
    }
    assert!(verify_transfer_settlement(request).confirmed);
}

#[test]
fn review_provider_confirmation_in_baseline_is_not_new_settlement() {
    let mut v = fixture();
    for account in v["facts"]["accounts"].as_array_mut().unwrap() {
        account["baselineTransactionIds"] = json!(["old-provider-confirmation"]);
    }
    let mut request = settlement(plan(v));
    for record in &mut request.records {
        record.provenance = SettlementProvenance::ProviderConfirmed;
        record.provider_reference = Some("old-provider-confirmation".into());
    }
    assert!(!verify_transfer_settlement(request).confirmed);
}

fn constrained_transfer_fixture(destination_cash: i64) -> Value {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(destination_cash);
    v["facts"]["accounts"][1]["recordedBalance"] = m(100);
    v["liquidityPolicy"]["accounts"][0]["protectedBuffer"] = m(0);
    v["liquidityPolicy"]["accounts"][1]["eligibleCategoryIds"] = json!(["food"]);
    v["facts"]["categories"][0]["availability"] = m(100);
    let mut other = v["facts"]["categories"][0].clone();
    other["categoryId"] = json!("other");
    other["cashBucketId"] = json!("other");
    other["availability"] = m(destination_cash);
    v["facts"]["categories"].as_array_mut().unwrap().push(other);
    v["scenario"]["items"][0]["amount"] = m(30);
    v
}

#[test]
fn review_exact_transfer_satisfies_backing_not_only_destination_shortfall() {
    let result = run(constrained_transfer_fixture(20));
    assert_eq!(
        result.payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    let transfer = result.purchases[0].transfer_plan.as_ref().unwrap();
    assert_eq!(transfer.minimum_amount.minor_units(), 30);
    assert_eq!(transfer.legs[0].source_after.minor_units(), 70);
    assert_eq!(transfer.legs[0].destination_after.minor_units(), 20);
    assert!(transfer.backing_after.feasible);
    assert_eq!(
        transfer
            .backing_after
            .lines
            .iter()
            .filter(|line| line.cash_bucket_id == "other")
            .map(|line| line.amount.minor_units())
            .sum::<i64>(),
        20
    );
}

#[test]
fn review_positive_headroom_still_requires_backing_transfer() {
    let result = run(constrained_transfer_fixture(40));
    assert_eq!(
        result.payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    let transfer = result.purchases[0].transfer_plan.as_ref().unwrap();
    assert_eq!(transfer.minimum_amount.minor_units(), 30);
    assert_eq!(
        transfer.legs[0]
            .destination_before
            .signed_headroom
            .minor_units(),
        10
    );
    assert_eq!(transfer.legs[0].destination_after.minor_units(), 40);
    assert!(transfer.backing_after.feasible);
}

#[test]
fn review_unknown_possible_on_time_route_does_not_become_certainly_late() {
    let mut v = fixture();
    v["liquidityPolicy"]["transferRoutes"][0]["providerArrivalAt"] = json!("2026-09-06T14:00:00Z");
    let mut unknown = v["liquidityPolicy"]["transferRoutes"][0].clone();
    unknown["id"] = json!("unknown-on-time");
    unknown["evidence"]["state"] = json!("unknown");
    unknown["providerArrivalAt"] = Value::Null;
    v["liquidityPolicy"]["transferRoutes"]
        .as_array_mut()
        .unwrap()
        .push(unknown);
    let result = run(v);
    assert_eq!(
        result.payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
    let transfer = result.purchases[0].transfer_plan.as_ref().unwrap();
    assert_eq!(transfer.legs[0].estimated_arrival, "2026-09-06T14:00:00Z");
}

#[test]
fn review_future_purchase_consumes_only_its_purchase_month_bucket() {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(18000);
    v["horizon"]["endsAt"] = json!("2026-11-01T00:00:00Z");
    let mut future = v["facts"]["categories"][0].clone();
    future["cashBucketId"] = json!("food:2026-10");
    future["asOfMonth"] = json!("2026-10");
    future["periodKind"] = json!("future");
    future["availability"] = m(5000);
    v["facts"]["categories"]
        .as_array_mut()
        .unwrap()
        .push(future);
    v["scenario"]["items"][0]["amount"] = m(3000);
    for key in ["purchaseAt", "requiredBy"] {
        v["scenario"]["items"][0][key] = json!("2026-10-02T12:00:00Z");
    }
    let result = run(v);
    assert_eq!(result.budget_funding_status, BudgetFundingStatus::Funded);
    assert_eq!(
        result.payment_liquidity_status,
        PaymentLiquidityStatus::Ready
    );
    for bucket in ["food", "food:2026-10"] {
        assert_eq!(
            result
                .categories
                .iter()
                .find(|category| category.cash_bucket_id == bucket)
                .unwrap()
                .remaining_availability
                .as_ref()
                .unwrap()
                .minor_units(),
            2000
        );
    }
}

#[test]
fn review_current_card_purchase_reserves_current_cash_not_due_month_bucket() {
    let mut v = card_fixture(false);
    v["horizon"]["endsAt"] = json!("2026-11-01T00:00:00Z");
    v["facts"]["accounts"][2]["credit"]["dueAt"] = json!("2026-10-20T12:00:00Z");
    let mut future = v["facts"]["categories"][1].clone();
    future["cashBucketId"] = json!("payment-one:2026-10");
    future["asOfMonth"] = json!("2026-10");
    future["periodKind"] = json!("future");
    future["availability"] = m(5000);
    v["facts"]["categories"]
        .as_array_mut()
        .unwrap()
        .push(future);
    let result = run(v);
    assert_eq!(
        result.payment_liquidity_status,
        PaymentLiquidityStatus::Ready
    );
    assert_eq!(
        result
            .backing_after
            .lines
            .iter()
            .filter(|line| line.cash_bucket_id == "payment-one")
            .map(|line| line.amount.minor_units())
            .sum::<i64>(),
        3000
    );
    assert_eq!(
        result
            .backing_after
            .lines
            .iter()
            .filter(|line| line.cash_bucket_id == "payment-one:2026-10")
            .map(|line| line.amount.minor_units())
            .sum::<i64>(),
        5000
    );
}

fn joint_transfer_fixture(checking: i64) -> Value {
    let mut v = fixture();
    v["facts"]["accounts"][0]["recordedBalance"] = m(checking);
    v["facts"]["accounts"][1]["recordedBalance"] = m(200);
    v["liquidityPolicy"]["accounts"][0]["protectedBuffer"] = m(100);
    v["facts"]["categories"][0]["availability"] = m(40);
    v["scenario"]["items"][0]["amount"] = m(20);
    let mut second = v["scenario"]["items"][0].clone();
    second["id"] = json!("purchase-2");
    v["scenario"]["items"].as_array_mut().unwrap().push(second);
    v
}

#[test]
fn review_joint_plan_contains_all_prior_on_time_transfer_prerequisites() {
    let v = joint_transfer_fixture(90);
    let result = run(v.clone());
    let plan = result.purchases[1].transfer_plan.as_ref().unwrap();
    assert_eq!(plan.minimum_amount.minor_units(), 50);
    assert_eq!(
        plan.legs
            .iter()
            .map(|leg| leg.amount.minor_units())
            .sum::<i64>(),
        50
    );
    assert_eq!(
        plan.reservations
            .iter()
            .filter(|effect| effect.kind == ClaimEffectKind::AccountDebit)
            .map(|effect| effect.amount.minor_units())
            .sum::<i64>(),
        50
    );
    assert!(
        verify_transfer_preconditions(TransferPreconditionRequest {
            plan: plan.clone(),
            current_input: serde_json::from_value(v).unwrap(),
            own_claim_id: None
        })
        .valid
    );
    let mut incomplete = settlement(plan.clone());
    incomplete.records.truncate(2);
    for record in &mut incomplete.records {
        record.amount = Money::new(if record.amount.is_negative() { -20 } else { 20 }, "USD");
    }
    assert!(!verify_transfer_settlement(incomplete).confirmed);
    assert!(verify_transfer_settlement(settlement(plan.clone())).confirmed);
}

#[test]
fn review_joint_identical_transfer_steps_need_distinct_complete_evidence() {
    let v = joint_transfer_fixture(100);
    let result = run(v.clone());
    let plan = result.purchases[1].transfer_plan.as_ref().unwrap();
    assert_eq!(plan.minimum_amount.minor_units(), 40);
    let mut one_pair = settlement(plan.clone());
    one_pair.records.truncate(2);
    for record in &mut one_pair.records {
        record.amount = Money::new(if record.amount.is_negative() { -20 } else { 20 }, "USD");
    }
    assert!(!verify_transfer_settlement(one_pair).confirmed);
    let complete = settlement(plan.clone());
    let verified = verify_transfer_settlement(complete.clone());
    assert!(verified.confirmed);
    assert_eq!(verified.claim_effects, Some(vec![]));
    let mut reordered = complete.clone();
    reordered.records.reverse();
    assert_eq!(verify_transfer_settlement(reordered), verified);
    let mut replay = complete;
    replay.consumed_evidence_ids = verified.evidence_ids;
    assert!(!verify_transfer_settlement(replay).confirmed);
    assert!(
        verify_transfer_preconditions(TransferPreconditionRequest {
            plan: plan.clone(),
            current_input: serde_json::from_value(v).unwrap(),
            own_claim_id: None
        })
        .valid
    );
}

#[test]
fn review_joint_ready_item_keeps_uninitiated_transfer_prerequisite() {
    let mut v = constrained_transfer_fixture(20);
    let mut second = v["scenario"]["items"][0].clone();
    second["id"] = json!("purchase-2");
    second["categoryId"] = json!("other");
    second["amount"] = m(10);
    v["scenario"]["items"].as_array_mut().unwrap().push(second);
    let result = run(v.clone());
    assert_eq!(
        result.purchases[1].payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    let plan = result.purchases[1].transfer_plan.as_ref().unwrap();
    assert_eq!(plan.minimum_amount.minor_units(), 30);
    assert_eq!(
        result.purchases[1]
            .selected_after
            .as_ref()
            .unwrap()
            .signed_headroom
            .as_ref()
            .unwrap()
            .minor_units(),
        10
    );
    assert!(
        verify_transfer_preconditions(TransferPreconditionRequest {
            plan: plan.clone(),
            current_input: serde_json::from_value(v).unwrap(),
            own_claim_id: None
        })
        .valid
    );
}

#[test]
fn missing_identity_invalid_horizons_and_expired_authority_never_produce_plans() {
    for (path, value, reason) in [
        ("/snapshotId", json!(""), "missing_input_identity"),
        (
            "/horizon/startsAt",
            json!("2026-09-06T11:00:00Z"),
            "invalid_horizon",
        ),
        ("/facts/version", json!("2"), "unsupported_liquidity_facts"),
        ("/facts/asOfMonth", json!("2026-13"), "invalid_as_of_month"),
        (
            "/liquidityPolicy/expiresAt",
            json!("2026-09-06T09:00:00Z"),
            "evaluation_expired",
        ),
        ("/scenario/items", json!([]), "empty_purchase_scenario"),
    ] {
        let mut v = fixture();
        *v.pointer_mut(path).unwrap() = value;
        let result = run(v);
        assert_eq!(
            result.payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData,
            "{path}"
        );
        assert!(result.reasons.iter().any(|code| code == reason), "{path}");
        assert!(!result.backing_before.feasible);
        assert!(result.purchases.is_empty());
    }
}

#[test]
fn ambiguous_periods_or_special_category_balances_do_not_become_disjoint_cash_buckets() {
    for (path, value, reason) in [
        ("/asOfMonth", json!("2026-08"), "category_period_mismatch"),
        ("/periodKind", json!("future"), "category_period_mismatch"),
        (
            "/kind",
            json!("income"),
            "unsupported_special_category_balance",
        ),
        (
            "/kind",
            json!("transfer"),
            "unsupported_special_category_balance",
        ),
        (
            "/evidence/state",
            json!("unknown"),
            "unknown_factual_evidence",
        ),
    ] {
        let mut v = fixture();
        v["scenario"] = json!({"kind":"none"});
        *v["facts"]["categories"][0].pointer_mut(path).unwrap() = value;
        let result = run(v);
        assert_eq!(
            result.budget_funding_status,
            BudgetFundingStatus::InsufficientData
        );
        assert_eq!(
            result.payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData
        );
        assert!(result.backing_before.lines.is_empty());
        assert!(result.categories[0].remaining_availability.is_none());
        assert!(result.categories[0]
            .reasons
            .iter()
            .any(|code| code == reason));
    }
    let mut v = fixture();
    let mut duplicate = v["facts"]["categories"][0].clone();
    duplicate["cashBucketId"] = json!("another-key-same-period");
    v["facts"]["categories"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert!(run(v)
        .reasons
        .iter()
        .any(|code| code == "duplicate_or_empty_identity"));
}

#[test]
fn account_kind_ambiguity_and_unconfirmed_freshness_cannot_supply_capacity() {
    for (path, value, reason) in [
        ("/kind", json!("unknown"), "unknown_account_kind"),
        (
            "/ambiguityReasons",
            json!(["unresolved_source"]),
            "ambiguous_account_evidence",
        ),
        (
            "/freshnessEvidence/source",
            json!("actual_ledger"),
            "account_freshness_unconfirmed",
        ),
        (
            "/balanceEvidence/expiresAt",
            Value::Null,
            "missing_evidence_expiry",
        ),
    ] {
        let mut v = fixture();
        *v["facts"]["accounts"][1].pointer_mut(path).unwrap() = value;
        let result = run(v);
        let account = result
            .accounts_before
            .iter()
            .find(|a| a.account_id == "savings")
            .unwrap();
        assert!(account.safe_transfer_capacity.is_none());
        assert!(account.reasons.iter().any(|code| code == reason));
        assert_eq!(
            result.payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData
        );
        assert!(result.purchases[0].transfer_plan.is_none());
    }
}

#[test]
fn actual_ledger_age_caps_the_quote_and_expires_at_the_exact_policy_boundary() {
    let mut v = fixture();
    let evidence = &mut v["facts"]["accounts"][0]["balanceEvidence"];
    evidence["source"] = json!("actual_ledger");
    evidence["observedAt"] = json!("2026-09-06T09:46:00Z");
    evidence["expiresAt"] = Value::Null;
    let current = run(v.clone());
    assert_eq!(current.expires_at, "2026-09-06T10:01:00Z");
    assert_eq!(
        current.payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    v["facts"]["accounts"][0]["balanceEvidence"]["observedAt"] = json!("2026-09-06T09:45:00Z");
    let stale = run(v);
    assert_eq!(
        stale.payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
    assert!(stale
        .accounts_before
        .iter()
        .find(|a| a.account_id == "checking")
        .unwrap()
        .reasons
        .iter()
        .any(|code| code == "stale_factual_evidence"));
}

#[test]
fn due_schedules_require_exact_currency_amount_and_accounted_obligation_evidence() {
    let schedule = json!({"id":"bill","accountId":"savings","categoryId":null,"ruleId":null,"dueDate":"2026-09-20","certainty":"exact","amount":m(-1000),"minimum":null,"maximum":null,"recurrence":null});
    for (path, value, reason) in [
        ("/dueDate", Value::Null, "schedule_horizon_unavailable"),
        (
            "/certainty",
            json!("approximate"),
            "schedule_amount_uncertain",
        ),
        ("/amount", Value::Null, "schedule_amount_unknown"),
        ("/amount/currency", json!("EUR"), "currency_mismatch"),
        (
            "/certainty",
            json!("exact"),
            "schedule_obligation_unaccounted",
        ),
    ] {
        let mut v = fixture();
        let mut scheduled = schedule.clone();
        *scheduled.pointer_mut(path).unwrap() = value;
        v["facts"]["schedules"] = json!([scheduled]);
        let result = run(v);
        let account = result
            .accounts_before
            .iter()
            .find(|a| a.account_id == "savings")
            .unwrap();
        assert!(account.safe_transfer_capacity.is_none());
        assert!(account.reasons.iter().any(|code| code == reason));
        assert_eq!(
            result.payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData
        );
    }
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["schedules"] = json!([schedule]);
    v["facts"]["accounts"][1]["obligations"] =
        json!([obligation("bill", "schedule:bill:2026-09-20", None, 1000)]);
    assert_eq!(head(&run(v.clone()), "savings"), 19000);
    v["facts"]["accounts"][1]["obligations"][0]["paid"] = json!(true);
    assert_eq!(head(&run(v.clone()), "savings"), 20000);
    v["facts"]["accounts"][1]["obligations"] = json!([]);
    v["facts"]["schedules"][0]["dueDate"] = json!("2026-10-20");
    v["facts"]["schedules"][0]["certainty"] = json!("unknown");
    v["facts"]["schedules"][0]["amount"] = Value::Null;
    assert_eq!(head(&run(v), "savings"), 20000);
}

#[test]
fn destination_claim_quarantine_is_applied_once_and_rejects_conflicting_flow_amounts() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["accounts"][0]["recordedBalance"] = m(14000);
    v["claimSet"]["bundles"] = json!([{"id":"hold","creationSnapshotId":"old","creationPolicyVersion":"old","state":"active","expiresAt":"2026-09-06T17:00:00Z","initiated":false,"effects":[{"kind":"destination_hold","resourceId":"checking","amount":m(1000),"economicObligationId":"transfer","categoryId":null,"includedInBalance":true,"matchedTransactionIds":["arrival"]}]}]);
    assert_eq!(head(&run(v.clone()), "checking"), 3000);
    v["facts"]["accounts"][0]["unsettledFlows"] =
        json!([flow("arrival", "observed-arrival", "inflow", 1000, true)]);
    assert_eq!(head(&run(v.clone()), "checking"), 3000);
    v["facts"]["accounts"][0]["unsettledFlows"][0]["amount"] = m(999);
    let conflict = run(v);
    let checking = conflict
        .accounts_before
        .iter()
        .find(|a| a.account_id == "checking")
        .unwrap();
    assert!(checking.signed_headroom.is_none());
    assert!(checking
        .reasons
        .iter()
        .any(|code| code == "claim_flow_amount_mismatch"));
}

#[test]
fn category_claims_deduplicate_economic_identity_but_not_conflicting_amounts_or_duplicate_effects()
{
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    let first = json!({"id":"claim-one","creationSnapshotId":"old","creationPolicyVersion":"old","state":"active","expiresAt":"2026-09-06T17:00:00Z","initiated":false,"effects":[{"kind":"category","resourceId":"food","amount":m(500),"economicObligationId":"purchase","categoryId":"food","includedInBalance":false,"matchedTransactionIds":[]}]});
    let mut second = first.clone();
    second["id"] = json!("claim-two");
    v["claimSet"]["bundles"] = json!([first, second]);
    assert_eq!(
        run(v.clone()).categories[0].remaining_availability,
        Some(Money::new(1500, "USD"))
    );
    let mut conflict = v.clone();
    conflict["claimSet"]["bundles"][1]["effects"][0]["amount"] = m(501);
    assert!(run(conflict)
        .reasons
        .iter()
        .any(|code| code == "ambiguous_claim_match"));
    let mut duplicated = v.clone();
    let effect = duplicated["claimSet"]["bundles"][0]["effects"][0].clone();
    duplicated["claimSet"]["bundles"][0]["effects"]
        .as_array_mut()
        .unwrap()
        .push(effect);
    assert!(run(duplicated)
        .reasons
        .iter()
        .any(|code| code == "ambiguous_claim_effect"));
    let mut missing = v.clone();
    missing["claimSet"]["bundles"][0]["effects"][0]["resourceId"] = json!("missing");
    assert!(run(missing)
        .reasons
        .iter()
        .any(|code| code == "claim_category_missing"));
    for bundle in v["claimSet"]["bundles"].as_array_mut().unwrap() {
        bundle["state"] = json!("expired");
        bundle["expiresAt"] = json!("2026-09-06T09:00:00Z");
    }
    assert_eq!(
        run(v).categories[0].remaining_availability,
        Some(Money::new(2000, "USD"))
    );
}

#[test]
fn obligation_with_same_economic_id_as_pending_outflow_does_not_reserve_twice() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["accounts"][0]["unsettledFlows"] =
        json!([flow("pending-1", "charge-shared", "outflow", 1000, false)]);
    let pending_only = run(v.clone());
    v["facts"]["accounts"][0]["obligations"] =
        json!([obligation("bill", "charge-shared", Some("food"), 1000)]);
    assert_eq!(
        head(&run(v.clone()), "checking"),
        head(&pending_only, "checking")
    );
    v["facts"]["accounts"][0]["obligations"][0]["amount"] = m(999);
    let ambiguous = run(v);
    assert!(ambiguous.accounts_before[0]
        .reasons
        .iter()
        .any(|reason| reason == "ambiguous_obligation_match"));
}

#[test]
fn scoped_account_claim_matching_an_obligation_reserves_cash_once_and_rejects_mismatch() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["accounts"][0]["obligations"] = json!([obligation(
        "scheduled",
        "schedule:shared",
        Some("food"),
        1000
    )]);
    let baseline = run(v.clone());
    v["claimSet"]["bundles"] = json!([{
        "id":"scheduled-claim",
        "creationSnapshotId":"old",
        "creationPolicyVersion":"old",
        "state":"active",
        "expiresAt":"2026-09-06T17:00:00Z",
        "initiated":false,
        "effects":[{
            "kind":"account_debit",
            "resourceId":"checking",
            "amount":m(1000),
            "economicObligationId":"schedule:shared:account:checking",
            "sourceEconomicObligationId":"schedule:shared",
            "categoryId":"food",
            "includedInBalance":false,
            "matchedTransactionIds":[]
        }]
    }]);
    assert_eq!(
        head(&run(v.clone()), "checking"),
        head(&baseline, "checking")
    );
    v["claimSet"]["bundles"][0]["effects"][0]["categoryId"] = Value::Null;
    let wrong_category = run(v.clone());
    assert!(wrong_category.accounts_before[0]
        .reasons
        .iter()
        .any(|reason| reason == "ambiguous_claim_match"));
    v["claimSet"]["bundles"][0]["effects"][0]["categoryId"] = json!("food");
    v["claimSet"]["bundles"][0]["effects"][0]["amount"] = m(2000);
    let conflict = run(v.clone());
    assert!(conflict.accounts_before[0]
        .reasons
        .iter()
        .any(|reason| reason == "ambiguous_claim_match"));
    v["claimSet"]["bundles"][0]["effects"][0]["amount"] = m(1000);
    v["claimSet"]["bundles"][0]["effects"][0]["sourceEconomicObligationId"] =
        json!("different-obligation");
    let forged = run(v.clone());
    assert!(forged.accounts_before[0]
        .reasons
        .iter()
        .any(|reason| reason == "ambiguous_claim_match"));
    v["claimSet"]["bundles"][0]["effects"][0]["sourceEconomicObligationId"] =
        json!("schedule:shared");
    v["facts"]["accounts"][0]["obligations"] = json!([]);
    let without_claims = {
        let mut bare = v.clone();
        bare["claimSet"]["bundles"] = json!([]);
        run(bare)
    };
    let mut other = v["claimSet"]["bundles"][0].clone();
    other["id"] = json!("savings-claim");
    other["effects"][0]["resourceId"] = json!("savings");
    other["effects"][0]["economicObligationId"] = json!("schedule:shared:account:savings");
    v["claimSet"]["bundles"].as_array_mut().unwrap().push(other);
    let distinct = run(v.clone());
    for account in ["checking", "savings"] {
        assert_eq!(
            head(&distinct, account),
            head(&without_claims, account) - 1000
        );
    }
    v["claimSet"]["bundles"][1]["effects"][0]["resourceId"] = json!("checking");
    v["claimSet"]["bundles"][1]["effects"][0]["economicObligationId"] =
        json!("schedule:shared:account:checking");
    v["claimSet"]["bundles"][1]["effects"][0]["amount"] = m(2000);
    let conflicting_scopes = run(v);
    assert!(conflicting_scopes.accounts_before[0]
        .reasons
        .iter()
        .any(|reason| reason == "ambiguous_claim_match"));
}

#[test]
fn scoped_claim_mirrors_exact_unsettled_flow_without_doubling_or_forging_evidence() {
    let mut v = fixture();
    v["scenario"] = json!({"kind":"none"});
    v["facts"]["accounts"][0]["unsettledFlows"] =
        json!([flow("pending-1", "bank-charge", "outflow", 1000, false)]);
    let flow_only = run(v.clone());
    v["claimSet"]["bundles"] = json!([{
        "id":"pending-claim",
        "creationSnapshotId":"old",
        "creationPolicyVersion":"old",
        "state":"active",
        "expiresAt":"2026-09-06T17:00:00Z",
        "initiated":false,
        "effects":[{
            "kind":"account_debit",
            "resourceId":"checking",
            "amount":m(1000),
            "economicObligationId":"bank-charge:account:checking",
            "sourceEconomicObligationId":"bank-charge",
            "categoryId":null,
            "includedInBalance":false,
            "matchedTransactionIds":[]
        }]
    }]);
    assert_eq!(
        head(&run(v.clone()), "checking"),
        head(&flow_only, "checking")
    );
    v["claimSet"]["bundles"][0]["effects"][0]["amount"] = m(1200);
    assert!(run(v.clone()).accounts_before[0]
        .reasons
        .iter()
        .any(|reason| reason == "claim_flow_amount_mismatch"));

    v["claimSet"]["bundles"][0]["effects"][0]["amount"] = m(1000);
    v["claimSet"]["bundles"][0]["effects"][0]["sourceEconomicObligationId"] = json!("");
    assert!(run(v.clone()).accounts_before[0]
        .reasons
        .iter()
        .any(|reason| reason == "ambiguous_claim_match"));
    v["claimSet"]["bundles"][0]["effects"][0]["sourceEconomicObligationId"] = json!("bank-charge");
    v["claimSet"]["bundles"][0]["effects"][0]["kind"] = json!("destination_hold");
    assert!(run(v.clone()).accounts_before[0]
        .reasons
        .iter()
        .any(|reason| reason == "ambiguous_claim_match"));

    v["claimSet"]["bundles"][0]["effects"][0]["kind"] = json!("account_debit");
    v["claimSet"]["bundles"][0]["effects"][0]["economicObligationId"] =
        json!("linked-purchase:account:checking");
    v["claimSet"]["bundles"][0]["effects"][0]["sourceEconomicObligationId"] =
        json!("linked-purchase");
    v["claimSet"]["bundles"][0]["effects"][0]["matchedTransactionIds"] = json!(["pending-1"]);
    assert_eq!(
        head(&run(v.clone()), "checking"),
        head(&flow_only, "checking")
    );
    v["facts"]["accounts"][0]["unsettledFlows"][0]["importedId"] = json!("import-1");
    v["claimSet"]["bundles"][0]["effects"][0]["matchedTransactionIds"] = json!(["import-1"]);
    assert_eq!(head(&run(v), "checking"), head(&flow_only, "checking"));
}

#[test]
fn invalid_transfer_calendars_remain_unknown_instead_of_becoming_safe_or_certainly_late() {
    for (path, value) in [
        ("/providerArrivalAt", json!("2026-09-04T15:00:00Z")),
        ("/providerArrivalAt", json!("2026-10-01T00:00:00Z")),
        ("/cutoffMinute", json!(1440)),
        ("/utcOffsetMinutes", json!(1440)),
        ("/delayDays", json!(3661)),
        ("/calendarMode", json!("instant")),
    ] {
        let mut v = timing_fixture("2026-09-04T16:00:00Z", "2026-09-07T18:00:00Z");
        *v["liquidityPolicy"]["transferRoutes"][0]
            .pointer_mut(path)
            .unwrap() = value;
        let result = run(v);
        assert_eq!(
            result.payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData,
            "{path}"
        );
        assert!(result.purchases[0].transfer_plan.is_none());
    }
    let mut unknown = timing_fixture("2026-09-04T16:00:00Z", "2026-09-07T18:00:00Z");
    unknown["liquidityPolicy"]["transferRoutes"][0]["evidence"]["source"] =
        json!("policy_assumption");
    unknown["liquidityPolicy"]["transferRoutes"][0]["evidence"]["state"] = json!("unknown");
    assert_eq!(
        run(unknown).payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
}

#[test]
fn instant_routes_and_calendar_day_weekend_rollover_preserve_explicit_processing_time() {
    let mut instant = timing_fixture("2026-09-04T16:00:00Z", "2026-09-04T17:00:00Z");
    instant["liquidityPolicy"]["transferRoutes"][0]["calendarMode"] = json!("instant");
    instant["liquidityPolicy"]["transferRoutes"][0]["delayDays"] = json!(0);
    assert_eq!(
        plan(instant).legs[0].estimated_arrival,
        "2026-09-04T16:00:00Z"
    );
    let mut calendar = timing_fixture("2026-09-04T16:00:00Z", "2026-09-07T18:00:00Z");
    calendar["liquidityPolicy"]["transferRoutes"][0]["calendarMode"] = json!("calendar_days");
    assert_eq!(
        plan(calendar).legs[0].estimated_arrival,
        "2026-09-07T16:00:00Z"
    );
}
