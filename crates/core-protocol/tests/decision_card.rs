use balanceframe_core_protocol::{evaluate_decision_card, DecisionCardRequest};
use serde_json::{json, Value};

const LIQUIDITY_FIXTURE: &str =
    include_str!("../../../protocol/fixtures/account-aware-liquidity.json");
const FOUNDATION_FIXTURE: &str =
    include_str!("../../../protocol/fixtures/financial-decision-foundation.json");

const SNAPSHOT_ID: &str = "snapshot-1";
const CONTENT_HASH: &str = "composite-hash-1";
const POLICY_VERSION: &str = "policy-1";
const CLAIM_REVISION: &str = "claims-1";
const EVALUATED_AT: &str = "2026-09-06T10:00:00Z";
const VALID_UNTIL: &str = "2026-09-06T18:00:00Z";
const PURCHASE_AT: &str = "2026-09-06T12:00:00Z";

/*
Expected request wire shape (camelCase; optional cart quantity may be omitted):
{
  "financialSnapshot": <canonical FinancialSnapshot with liquidity facts>,
  "context": <DecisionContext bound to snapshotId/contentHash and policyVersion>,
  "liquidityPolicy": <existing governed policy>,
  "claimSet": <existing liquidity claim set and revision>,
  "priorAllocation": null,
  "items": [{
    "id", "categoryId", "amount", "purchaseAt", "requiredBy", "routeSelection",
    "priority"
  }],
  "categoryPolicies": [{
    "categoryId", "kind", "donorEligible", "minimumRetained", "projectedRemainingNeed"
  }],
  "validUntil", "requestId", "correlationId", "decisionId"
}

The card projection is expected to retain those immutable identities and expose
`before`/`after` category states, `fundingPaths`, evidence, expiry, and per-item
outcomes. Financial amounts below are JSON Money values, not floating-point values.
*/

fn fixture(path: &str) -> Value {
    serde_json::from_str(path).expect("canonical protocol fixture must be valid JSON")
}

fn money(minor_units: i64, currency: &str) -> Value {
    json!({
        "minorUnits": minor_units.to_string(),
        "currency": currency,
    })
}

fn base_request() -> Value {
    let liquidity = fixture(LIQUIDITY_FIXTURE);
    let foundation = fixture(FOUNDATION_FIXTURE);
    let mut snapshot = foundation["full"].clone();

    // Compose the canonical snapshot exactly as the existing account-aware
    // protocol test does: foundation identity/payload plus normalized liquidity.
    snapshot["snapshotId"] = liquidity["snapshotId"].clone();
    snapshot["contentHash"] = liquidity["contentHash"].clone();
    snapshot["capturedAt"] = json!(EVALUATED_AT);
    snapshot["liquidity"] = liquidity["facts"].clone();
    snapshot["observations"] = json!([
        {
            "kind": "account_freshness",
            "scope": { "kind": "account", "id": "checking" },
            "state": "fresh",
            "observedAt": EVALUATED_AT,
            "evidence": [{
                "evidenceId": "checking-freshness",
                "kind": "bank_sync",
                "authorized": true,
                "redaction": "visible"
            }]
        }
    ]);
    snapshot["coverage"]["accounts"] = json!("complete");
    snapshot["coverage"]["categories"] = json!("complete");
    snapshot["coverage"]["transactions"] = json!("complete");
    snapshot["coverage"]["schedules"] = json!("complete");
    snapshot["coverage"]["budgets"] = json!("complete");
    snapshot["legacySnapshot"]["accounts"] = json!([]);
    snapshot["legacySnapshot"]["transactions"] = json!([]);
    snapshot["legacySnapshot"]["categories"] = json!([]);
    snapshot["legacySnapshot"]["budgets"] = json!([]);
    snapshot["legacySnapshot"]["schedules"] = json!([]);

    let mut context = foundation["claims"]["context"].clone();
    context["evaluatedAt"] = liquidity["evaluatedAt"].clone();
    context["horizon"] = liquidity["horizon"].clone();
    context["snapshotId"] = liquidity["snapshotId"].clone();
    context["contentHash"] = liquidity["contentHash"].clone();
    context["policyVersion"] = liquidity["liquidityPolicy"]["version"].clone();
    context["policyHash"] = liquidity["liquidityPolicy"]["policyHash"].clone();
    context["policy"]["maxBudgetSnapshotAgeMinutes"] =
        liquidity["maxBudgetSnapshotAgeMinutes"].clone();
    context["policy"]["maxBankSyncAgeMinutes"] = Value::Null;

    let mut item = liquidity["scenario"]["items"][0].clone();
    item["priority"] = json!("planned");
    item["purchaseAt"] = json!(PURCHASE_AT);
    item["requiredBy"] = json!(PURCHASE_AT);
    json!({
        "financialSnapshot": snapshot,
        "context": context,
        "liquidityPolicy": liquidity["liquidityPolicy"].clone(),
        "claimSet": liquidity["claimSet"].clone(),
        "priorAllocation": Value::Null,
        "items": [item],
        "categoryPolicies": [{
            "categoryId": "food",
            "kind": "ordinary",
            "donorEligible": false,
            "minimumRetained": money(0, "USD"),
            "projectedRemainingNeed": money(0, "USD")
        }],
        "validUntil": liquidity["validUntil"].clone(),
        "requestId": "request-card-1",
        "correlationId": "correlation-card-1",
        "decisionId": "decision-card-1"
    })
}

fn request(value: Value) -> DecisionCardRequest {
    serde_json::from_value(value)
        .expect("decision-card fixture must satisfy the request wire contract")
}

fn evaluate(value: Value) -> Value {
    serde_json::to_value(evaluate_decision_card(request(value)))
        .expect("DecisionCard must have a stable JSON projection")
}

fn account_mut<'a>(value: &'a mut Value, account_id: &str) -> &'a mut Value {
    value["financialSnapshot"]["liquidity"]["accounts"]
        .as_array_mut()
        .expect("liquidity fixture accounts must be an array")
        .iter_mut()
        .find(|account| account["accountId"] == account_id)
        .unwrap_or_else(|| panic!("liquidity fixture must contain account {account_id}"))
}

fn category_mut<'a>(value: &'a mut Value, category_id: &str) -> &'a mut Value {
    value["financialSnapshot"]["liquidity"]["categories"]
        .as_array_mut()
        .expect("liquidity fixture categories must be an array")
        .iter_mut()
        .find(|category| category["categoryId"] == category_id)
        .unwrap_or_else(|| panic!("liquidity fixture must contain category {category_id}"))
}

fn category_policy_mut<'a>(value: &'a mut Value, category_id: &str) -> &'a mut Value {
    value["categoryPolicies"]
        .as_array_mut()
        .expect("category policies must be an array")
        .iter_mut()
        .find(|policy| policy["categoryId"] == category_id)
        .unwrap_or_else(|| panic!("category policy must contain category {category_id}"))
}

fn set_account_balance(value: &mut Value, account_id: &str, minor_units: i64) {
    let account = account_mut(value, account_id);
    account["recordedBalance"] = money(minor_units, "USD");
    account["holds"] = money(0, "USD");
}

fn set_category_availability(value: &mut Value, category_id: &str, minor_units: i64) {
    category_mut(value, category_id)["availability"] = money(minor_units, "USD");
}

fn set_item_amount(value: &mut Value, index: usize, minor_units: i64, currency: &str) {
    value["items"][index]["amount"] = money(minor_units, currency);
}

fn add_category(value: &mut Value, category_id: &str, minor_units: i64) {
    let category = value["financialSnapshot"]["liquidity"]["categories"][0].clone();
    let mut category = category;
    category["categoryId"] = json!(category_id);
    category["cashBucketId"] = json!(category_id);
    category["availability"] = money(minor_units, "USD");
    value["financialSnapshot"]["liquidity"]["categories"]
        .as_array_mut()
        .unwrap()
        .push(category);
}

fn add_category_policy(
    value: &mut Value,
    category_id: &str,
    kind: &str,
    donor_eligible: bool,
    minimum_retained: i64,
    projected_remaining_need: i64,
) {
    value["categoryPolicies"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "categoryId": category_id,
            "kind": kind,
            "donorEligible": donor_eligible,
            "minimumRetained": money(minimum_retained, "USD"),
            "projectedRemainingNeed": money(projected_remaining_need, "USD")
        }));
}

fn add_claim(
    value: &mut Value,
    claim_id: &str,
    category_id: &str,
    minor_units: i64,
    expires_at: &str,
) {
    value["claimSet"]["bundles"] = json!([{
        "id": claim_id,
        "creationSnapshotId": SNAPSHOT_ID,
        "creationPolicyVersion": POLICY_VERSION,
        "state": "active",
        "expiresAt": expires_at,
        "initiated": false,
        "effects": [{
            "kind": "category",
            "resourceId": category_id,
            "amount": money(minor_units, "USD"),
            "economicObligationId": format!("obligation-{claim_id}"),
            "categoryId": category_id,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }]
    }]);
}

fn category_state<'a>(card: &'a Value, side: &str, category_id: &str) -> &'a Value {
    card[side]["categories"]
        .as_array()
        .expect("DecisionCard before/after must expose category states")
        .iter()
        .find(|category| category["categoryId"] == category_id)
        .unwrap_or_else(|| panic!("{side} state must contain category {category_id}"))
}

fn minor_units(value: &Value) -> &str {
    value["minorUnits"]
        .as_str()
        .expect("Money minorUnits must remain an exact decimal string")
}

fn outcome(card: &Value) -> &str {
    card["outcome"]
        .as_str()
        .expect("DecisionCard must expose one snake_case outcome")
}

fn has_text(value: &Value, needle: &str) -> bool {
    match value {
        Value::String(text) => text == needle || text.contains(needle),
        Value::Array(values) => values.iter().any(|value| has_text(value, needle)),
        Value::Object(values) => values.values().any(|value| has_text(value, needle)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn passing_item_count(card: &Value) -> usize {
    card["items"]
        .as_array()
        .expect("joint DecisionCard must expose each item's evaluated outcome")
        .iter()
        .filter(|item| {
            matches!(
                item["outcome"].as_str(),
                Some("funded_now") | Some("safe_with_reallocation") | Some("safe_after_date")
            )
        })
        .count()
}

#[test]
fn decision_card_identity_and_plan_hash_are_deterministic_and_immutable() {
    let input = base_request();
    let first = evaluate(input.clone());
    let second = evaluate(input);

    assert_eq!(
        first, second,
        "fixed canonical inputs must produce one card"
    );
    assert_eq!(first["decisionId"], "decision-card-1");
    assert_eq!(first["requestId"], "request-card-1");
    assert_eq!(first["snapshotId"], SNAPSHOT_ID);
    assert_eq!(first["contentHash"], CONTENT_HASH);
    assert_eq!(first["policyVersion"], POLICY_VERSION);
    assert_eq!(first["claimSetRevision"], CLAIM_REVISION);
    assert_eq!(first["planHash"].as_str().unwrap().len(), 64);

    let mut changed_claim_revision = base_request();
    changed_claim_revision["claimSet"]["revision"] = json!("claims-2");
    let changed = evaluate(changed_claim_revision);
    assert_ne!(changed["planHash"], first["planHash"]);
    assert_eq!(changed["claimSetRevision"], "claims-2");
}

#[test]
fn funded_joy_category_is_affirmed_and_has_no_guilt_penalty() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 13_000);
    category_policy_mut(&mut input, "food")["kind"] = json!("joy");

    let card = evaluate(input);

    assert_eq!(outcome(&card), "funded_now");
    assert_eq!(card["budgetFundingStatus"], "funded");
    assert_eq!(card["paymentLiquidityStatus"], "ready");
    assert!(
        has_text(&card["reasons"], "joy"),
        "a fully funded joy category must carry an affirmative reason"
    );
    assert!(!has_text(&card["reasons"], "guilt"));
}

#[test]
fn category_claims_reduce_before_and_after_availability_exactly() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 13_000);
    set_item_amount(&mut input, 0, 1_000, "USD");
    add_claim(
        &mut input,
        "reservation-food",
        "food",
        500,
        "2026-09-06T17:00:00Z",
    );

    let card = evaluate(input);
    assert_eq!(outcome(&card), "funded_now");

    let before = category_state(&card, "before", "food");
    let after = category_state(&card, "after", "food");
    assert_eq!(minor_units(&before["availability"]), "2000");
    assert_eq!(minor_units(&after["availability"]), "1000");
    assert_eq!(minor_units(&before["reservations"]), "500");
    assert_eq!(minor_units(&after["reservations"]), "500");
    assert_eq!(minor_units(&before["uncommittedAvailability"]), "1500");
    assert_eq!(minor_units(&after["uncommittedAvailability"]), "500");
    assert_eq!(minor_units(&before["safeToRedirect"]), "0");
    assert_eq!(minor_units(&after["safeToRedirect"]), "0");

    assert_eq!(card["expiresAt"], "2026-09-06T17:00:00Z");
    assert!(card["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .any(|reference| { reference["evidenceId"] == "checking-freshness" }));
}

#[test]
fn evidenced_donor_reallocation_exposes_exact_before_after_path() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 13_000);
    set_category_availability(&mut input, "food", 0);
    add_category(&mut input, "reserve", 6_000);
    add_category_policy(&mut input, "reserve", "ordinary", true, 1_000, 2_000);

    let card = evaluate(input);

    assert_eq!(outcome(&card), "safe_with_reallocation");
    let path = card["fundingPaths"]
        .as_array()
        .expect("reallocation must expose funding paths")
        .iter()
        .find(|path| path["kind"] == "category_reallocation")
        .expect("safe reallocation must identify its donor path");
    assert_eq!(path["sourceCategoryId"], "reserve");
    assert_eq!(path["destinationCategoryId"], "food");
    assert_eq!(minor_units(&path["amount"]), "2000");

    let donor_before = category_state(&card, "before", "reserve");
    let donor_after = category_state(&card, "after", "reserve");
    let requested_before = category_state(&card, "before", "food");
    let requested_after = category_state(&card, "after", "food");
    assert_eq!(minor_units(&donor_before["availability"]), "6000");
    assert_eq!(minor_units(&donor_after["availability"]), "4000");
    assert_eq!(minor_units(&requested_before["availability"]), "0");
    assert_eq!(minor_units(&requested_after["availability"]), "0");
}

#[test]
fn donor_surplus_is_not_presumed_past_floor_and_projected_need() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 13_000);
    set_category_availability(&mut input, "food", 0);
    add_category(&mut input, "reserve", 6_000);
    add_category_policy(&mut input, "reserve", "ordinary", true, 1_000, 5_000);

    let card = evaluate(input);

    assert_ne!(outcome(&card), "safe_with_reallocation");
    assert!(card["fundingPaths"].as_array().unwrap().is_empty());
    assert_eq!(
        minor_units(&category_state(&card, "before", "reserve")["availability"]),
        "6000"
    );
    assert_eq!(
        minor_units(&category_state(&card, "after", "reserve")["availability"]),
        "6000"
    );
    assert!(has_text(&card["reasons"], "surplus") || has_text(&card, "projected"));
}

#[test]
fn safe_after_date_requires_an_evidenced_timing_path() {
    let card = evaluate(base_request());

    assert_eq!(outcome(&card), "safe_after_date");
    assert_eq!(card["budgetFundingStatus"], "funded");
    assert_eq!(card["paymentLiquidityStatus"], "transfer_required");
    assert!(has_text(&card["fundingPaths"], "2026-09-06T11:00:00Z"));
    assert_eq!(card["expiresAt"], VALID_UNTIL);
}

#[test]
fn cash_available_but_unfunded_is_distinct_from_payment_shortfall() {
    let mut cash_but_unfunded = base_request();
    set_account_balance(&mut cash_but_unfunded, "checking", 13_000);
    set_category_availability(&mut cash_but_unfunded, "food", 0);
    let cash_card = evaluate(cash_but_unfunded);

    assert_eq!(outcome(&cash_card), "cash_available_but_unfunded");
    assert_eq!(cash_card["budgetFundingStatus"], "unfunded");
    assert_eq!(cash_card["paymentLiquidityStatus"], "ready");

    let mut payment_shortfall = base_request();
    payment_shortfall["liquidityPolicy"]["transferRoutes"][0]["providerArrivalAt"] =
        json!("2026-09-06T13:00:00Z");
    let shortfall_card = evaluate(payment_shortfall);

    assert_eq!(outcome(&shortfall_card), "not_safe");
    assert_eq!(shortfall_card["budgetFundingStatus"], "funded");
    assert_ne!(shortfall_card["paymentLiquidityStatus"], "ready");
    assert!(has_text(&shortfall_card["reasons"], "payment"));
}

#[test]
fn protected_and_goal_breaches_are_plan_breaking_not_ordinary_shortfalls() {
    for kind in ["protected", "goal"] {
        let mut input = base_request();
        set_account_balance(&mut input, "checking", 13_000);
        set_item_amount(&mut input, 0, 1_500, "USD");
        let policy = category_policy_mut(&mut input, "food");
        policy["kind"] = json!(kind);
        policy["minimumRetained"] = money(1_000, "USD");
        policy["projectedRemainingNeed"] = money(1_500, "USD");

        let card = evaluate(input);

        assert_eq!(
            outcome(&card),
            "plan_breaking",
            "{kind} breach must be explicit"
        );
        assert!(has_text(&card["reasons"], kind));
    }
}

#[test]
fn material_stale_unknown_or_currency_evidence_has_insufficient_data_precedence() {
    let mut stale = base_request();
    account_mut(&mut stale, "checking")["balanceEvidence"]["expiresAt"] =
        json!("2026-09-06T09:59:00Z");
    assert_eq!(outcome(&evaluate(stale)), "insufficient_data");

    let mut unknown = base_request();
    category_mut(&mut unknown, "food")["evidence"]["state"] = json!("unknown");
    assert_eq!(outcome(&evaluate(unknown)), "insufficient_data");

    let mut currency = base_request();
    set_item_amount(&mut currency, 0, 2_000, "EUR");
    assert_eq!(outcome(&evaluate(currency)), "insufficient_data");

    // A blocker outranks a plan breach; the card must not turn unknown money
    // into a confident protected/goal conclusion.
    let mut precedence = base_request();
    account_mut(&mut precedence, "checking")["balanceEvidence"]["expiresAt"] =
        json!("2026-09-06T09:59:00Z");
    set_item_amount(&mut precedence, 0, 1_500, "USD");
    let policy = category_policy_mut(&mut precedence, "food");
    policy["kind"] = json!("protected");
    policy["minimumRetained"] = money(1_000, "USD");
    assert_eq!(outcome(&evaluate(precedence)), "insufficient_data");
}

#[test]
fn competing_items_exhaust_one_payment_account_without_an_arriving_transfer() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 12_000);
    set_category_availability(&mut input, "food", 4_000);
    input["liquidityPolicy"]["transferRoutes"] = json!([]);
    let mut second = input["items"][0].clone();
    second["id"] = json!("purchase-2");
    input["items"].as_array_mut().unwrap().push(second);

    let card = evaluate(input);

    assert_eq!(card["items"][0]["outcome"], "funded_now");
    assert_eq!(card["items"][1]["outcome"], "not_safe");
    assert_eq!(outcome(&card), "not_safe");
    assert!(card["fundingPaths"].as_array().unwrap().is_empty());
}

#[test]
fn checked_cart_overflow_fails_closed_without_fabricating_after_state() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", i64::MAX);
    input["liquidityPolicy"]["accounts"][0]["protectedBuffer"] = money(0, "USD");
    account_mut(&mut input, "checking")["holds"] = money(0, "USD");
    category_mut(&mut input, "food")["availability"] = money(i64::MAX, "USD");
    set_item_amount(&mut input, 0, i64::MAX, "USD");
    let mut second = input["items"][0].clone();
    second["id"] = json!("purchase-overflow");
    second["amount"] = money(1, "USD");
    input["items"].as_array_mut().unwrap().push(second);

    let card = evaluate(input);

    assert_eq!(outcome(&card), "insufficient_data");
    assert!(has_text(&card["reasons"], "overflow"));
    let after_is_empty = card["after"].is_null()
        || card["after"]["categories"]
            .as_array()
            .is_none_or(|categories| categories.is_empty());
    assert!(after_is_empty);
}
#[test]
fn future_period_assignments_cannot_fund_current_donor_reallocation() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 0);
    add_category(&mut input, "future-reserve", 6_000);
    category_mut(&mut input, "future-reserve")["asOfMonth"] = json!("2026-10");
    category_mut(&mut input, "future-reserve")["periodKind"] = json!("future");
    add_category_policy(&mut input, "future-reserve", "ordinary", true, 1_000, 0);

    let card = evaluate(input);

    assert_eq!(
        outcome(&card),
        "cash_available_but_unfunded",
        "future-period assignments cannot fund a current-month purchase"
    );
    assert_eq!(card["budgetFundingStatus"], "unfunded");
    assert_eq!(card["items"][0]["outcome"], "cash_available_but_unfunded");
    assert!(card["fundingPaths"]
        .as_array()
        .unwrap()
        .iter()
        .all(|path| path["kind"] != "category_reallocation"));
}

#[test]
fn schedule_and_claim_with_one_economic_obligation_are_deduplicated_as_a_commitment() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 4_000);
    set_item_amount(&mut input, 0, 500, "USD");
    input["financialSnapshot"]["legacySnapshot"]["schedules"] = json!([{
        "id": "shared-schedule",
        "frequency": "monthly",
        "amount": money(-1_000, "USD"),
        "payeeName": "Shared scheduled obligation",
        "accountId": "checking",
        "nextExpected": "2026-09-10"
    }]);
    account_mut(&mut input, "checking")["obligations"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "shared-schedule",
            "economicObligationId": "schedule:shared-schedule:2026-09-10",
            "categoryId": "food",
            "amount": money(1_000, "USD"),
            "dueAt": "2026-09-10T12:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }));
    add_claim(
        &mut input,
        "shared-claim",
        "food",
        1_000,
        "2026-09-06T17:00:00Z",
    );
    input["claimSet"]["bundles"][0]["effects"][0]["economicObligationId"] =
        json!("schedule:shared-schedule:2026-09-10");

    let card = evaluate(input);

    assert_eq!(outcome(&card), "funded_now");
    let before = category_state(&card, "before", "food");
    let after = category_state(&card, "after", "food");
    assert_eq!(
        minor_units(&before["commitments"]),
        "1000",
        "the schedule/claim identity remains a commitment"
    );
    assert_eq!(
        minor_units(&before["reservations"]),
        "0",
        "the matching claim must not become a second reserve"
    );
    assert_eq!(minor_units(&after["commitments"]), "1000");
    assert_eq!(minor_units(&after["reservations"]), "0");
}

#[test]
fn jointly_small_purchases_remain_funded_when_cumulative_account_cash_is_sufficient() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 4_000);
    set_item_amount(&mut input, 0, 1_000, "USD");
    let mut second = input["items"][0].clone();
    second["id"] = json!("purchase-2");
    input["items"].as_array_mut().unwrap().push(second);

    let card = evaluate(input);

    assert_eq!(outcome(&card), "funded_now");
    assert_eq!(
        passing_item_count(&card),
        2,
        "both items must pass against the shared account capacity"
    );
    assert!(card["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["outcome"] == "funded_now"));
    assert!(card["conflicts"].as_array().unwrap().is_empty());
}

#[test]
fn protected_and_goal_policies_enforce_retained_floor_and_remaining_need_together() {
    for kind in ["protected", "goal"] {
        let mut input = base_request();
        set_account_balance(&mut input, "checking", 30_000);
        set_category_availability(&mut input, "food", 5_000);
        set_item_amount(&mut input, 0, 2_000, "USD");
        let policy = category_policy_mut(&mut input, "food");
        policy["kind"] = json!(kind);
        policy["minimumRetained"] = money(2_000, "USD");
        policy["projectedRemainingNeed"] = money(2_000, "USD");

        let card = evaluate(input);

        assert_eq!(
            outcome(&card),
            "plan_breaking",
            "{kind} spending below floor plus future need must be plan-breaking"
        );
        assert_eq!(card["items"][0]["outcome"], "plan_breaking");
    }
}

#[test]
fn joint_transfer_paths_deduplicate_cumulative_legs_and_disclose_transfer_approval() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 9_000);
    set_category_availability(&mut input, "food", 4_000);
    set_item_amount(&mut input, 0, 2_000, "USD");
    let mut second = input["items"][0].clone();
    second["id"] = json!("purchase-2");
    input["items"].as_array_mut().unwrap().push(second);

    let card = evaluate(input);

    assert_eq!(outcome(&card), "safe_after_date");
    assert_eq!(card["paymentLiquidityStatus"], "transfer_required");
    assert!(card["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["outcome"] == "safe_after_date"));

    let transfer_paths: Vec<&Value> = card["fundingPaths"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|path| path["kind"] == "account_transfer")
        .collect();
    assert!(!transfer_paths.is_empty());
    let legs: Vec<&Value> = transfer_paths
        .iter()
        .flat_map(|path| path["legs"].as_array().unwrap().iter())
        .collect();
    assert!(!legs.is_empty());
    let leg_ids: Vec<&str> = legs
        .iter()
        .map(|leg| leg["id"].as_str().expect("transfer legs need stable IDs"))
        .collect();
    for (index, id) in leg_ids.iter().enumerate() {
        assert!(
            !leg_ids[..index].contains(id),
            "cumulative transfer legs must not be disclosed twice"
        );
    }
    let total: i64 = legs
        .iter()
        .map(|leg| {
            minor_units(&leg["amount"])
                .parse::<i64>()
                .expect("transfer amounts remain exact integers")
        })
        .sum();
    assert_eq!(total, 5_000);
    assert!(card["authorizationRequirements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|requirement| {
            requirement
                .as_str()
                .is_some_and(|value| value.contains("transfer") && value.contains("approval"))
        }));
}

#[test]
fn card_hash_and_evidence_scope_are_order_stable_and_financially_visible() {
    let mut ordered = base_request();
    add_category(&mut ordered, "reserve", 6_000);
    add_category_policy(&mut ordered, "reserve", "ordinary", true, 1_000, 0);
    let mut reordered = ordered.clone();
    reordered["categoryPolicies"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_eq!(
        evaluate(ordered)["planHash"],
        evaluate(reordered)["planHash"],
        "category-policy source order must not alter the immutable plan identity"
    );

    let mut evidenced = base_request();
    set_account_balance(&mut evidenced, "checking", 30_000);
    set_category_availability(&mut evidenced, "food", 0);
    add_category(&mut evidenced, "reserve", 6_000);
    add_category_policy(&mut evidenced, "reserve", "ordinary", true, 1_000, 0);
    set_item_amount(&mut evidenced, 0, 2_000, "USD");
    evidenced["financialSnapshot"]["legacySnapshot"]["schedules"] = json!([{
        "id": "schedule-reserve",
        "frequency": "monthly",
        "amount": money(-1_000, "USD"),
        "payeeName": "Reserve obligation",
        "accountId": "checking",
        "nextExpected": "2026-09-10"
    }]);
    account_mut(&mut evidenced, "checking")["obligations"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "schedule-reserve",
            "economicObligationId": "schedule:schedule-reserve:2026-09-10",
            "categoryId": "reserve",
            "amount": money(1_000, "USD"),
            "dueAt": "2026-09-10T12:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }));

    let card = evaluate(evidenced.clone());
    assert_eq!(outcome(&card), "safe_with_reallocation");
    let reserve_before = category_state(&card, "before", "reserve");
    let reserve_after = category_state(&card, "after", "reserve");
    assert_eq!(minor_units(&reserve_before["availability"]), "6000");
    assert_eq!(minor_units(&reserve_before["commitments"]), "1000");
    assert_eq!(
        minor_units(&reserve_before["safeToRedirect"]),
        "4000",
        "the recurring obligation and donor floor reduce redirectable reserve"
    );
    assert_eq!(minor_units(&reserve_after["availability"]), "4000");
    assert_eq!(minor_units(&reserve_after["commitments"]), "1000");
    assert_eq!(minor_units(&reserve_after["safeToRedirect"]), "2000");
    assert_eq!(
        minor_units(&category_state(&card, "after", "food")["availability"]),
        "0"
    );
    assert!(card["before"]["goals"]
        .as_array()
        .is_some_and(|goals| goals.is_empty()));

    let obligation = card["before"]["obligations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|obligation| {
            obligation["economicObligationId"] == "schedule:schedule-reserve:2026-09-10"
        })
        .expect("the card must retain the known account obligation");
    assert_eq!(obligation["accountId"], "checking");
    assert_eq!(minor_units(&obligation["amount"]), "1000");
    assert_eq!(obligation["dueAt"], "2026-09-10T12:00:00Z");
    let before_account = card["before"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["accountId"] == "checking")
        .unwrap();
    let after_account = card["after"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["accountId"] == "checking")
        .unwrap();
    assert_eq!(
        minor_units(&before_account["safeSpendingCapacity"]),
        "19000"
    );
    assert_eq!(minor_units(&after_account["safeSpendingCapacity"]), "17000");

    let runway_before = &card["before"]["runway"];
    assert_eq!(runway_before["state"], "known");
    assert_eq!(runway_before["accountId"], "checking");
    assert_eq!(minor_units(&runway_before["remainingSafeCash"]), "19000");
    let runway_after = &card["after"]["runway"];
    assert_eq!(runway_after["state"], "known");
    assert_eq!(minor_units(&runway_after["remainingSafeCash"]), "17000");
    let opportunity_cost = card["opportunityCosts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|cost| cost["sourceCategoryId"] == "reserve")
        .expect("the donor tradeoff must be explicit");
    assert_eq!(minor_units(&opportunity_cost["amount"]), "2000");

    let mut goal_input = base_request();
    set_account_balance(&mut goal_input, "checking", 30_000);
    set_category_availability(&mut goal_input, "food", 5_000);
    set_item_amount(&mut goal_input, 0, 2_000, "USD");
    let goal_policy = category_policy_mut(&mut goal_input, "food");
    goal_policy["kind"] = json!("goal");
    goal_policy["minimumRetained"] = money(2_000, "USD");
    goal_policy["projectedRemainingNeed"] = money(2_000, "USD");
    let goal_card = evaluate(goal_input);
    assert_eq!(outcome(&goal_card), "plan_breaking");
    assert_eq!(
        minor_units(&category_state(&goal_card, "before", "food")["availability"]),
        "5000"
    );
    assert_eq!(
        minor_units(&category_state(&goal_card, "after", "food")["availability"]),
        "3000"
    );
    let goal_before = goal_card["before"]["goals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|goal| goal["categoryId"] == "food")
        .expect("an affected goal needs a before projection");
    assert_eq!(goal_before["state"], "on_track");
    assert_eq!(minor_units(&goal_before["shortfall"]), "0");
    let goal_after = goal_card["after"]["goals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|goal| goal["categoryId"] == "food")
        .expect("an affected goal needs an after projection");
    assert_eq!(goal_after["state"], "at_risk");
    assert_eq!(minor_units(&goal_after["shortfall"]), "1000");
    assert_eq!(goal_after["targetState"], "unknown");

    let mut unknown_runway = evidenced;
    unknown_runway["financialSnapshot"]["coverage"]["schedules"] = json!("partial");
    let unknown_card = evaluate(unknown_runway);
    assert_eq!(unknown_card["before"]["runway"]["state"], "unknown");
    assert!(unknown_card["before"]["runway"]["remainingSafeCash"].is_null());

    let mut scoped = base_request();
    scoped["financialSnapshot"]["coverage"]["transactions"] = json!("partial");
    scoped["financialSnapshot"]["inclusionScope"]["pendingActivity"] = json!("excluded");
    let scoped_card = evaluate(scoped);
    assert_eq!(outcome(&scoped_card), "insufficient_data");
    assert!(
        has_text(&scoped_card, "partial"),
        "card must retain the source coverage state"
    );
    assert!(
        has_text(&scoped_card, "excluded"),
        "card must disclose pending-activity treatment"
    );
}
